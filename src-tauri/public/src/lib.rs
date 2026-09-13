mod server;

use serde::Serialize;
use std::{path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
struct Connection { base: String, key: String, addresses: Vec<String>, folder: String }

#[tauri::command]
fn connection(state: tauri::State<'_, Arc<server::Library>>) -> Connection {
    let mut addresses: Vec<String> = local_ip_address::list_afinet_netifas().unwrap_or_default().into_iter()
        .filter_map(|(_, ip)| match ip { std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() => Some(format!("http://{}:{}", ip, server::PORT)), _ => None }).collect();
    addresses.sort(); addresses.dedup();
    Connection { base: format!("http://127.0.0.1:{}", server::PORT), key: state.key.clone(), addresses, folder: state.root.to_string_lossy().into_owned() }
}

#[tauri::command]
async fn choose_files(app: tauri::AppHandle, state: tauri::State<'_, Arc<server::Library>>) -> Result<(), String> {
    if let Some(files) = rfd::AsyncFileDialog::new().set_title("Add files to ColdDrop").pick_files().await {
        let library = state.inner().clone();
        tauri::async_runtime::spawn(async move {
            for file in files {
                let path = file.path().to_path_buf();
                let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
                if let Err(error) = server::import(&library, path, &app).await {
                    let _ = app.emit("transfer", serde_json::json!({"id":name,"name":name,"error":error,"status":"failed"}));
                }
            }
        });
    }
    Ok(())
}

#[tauri::command]
async fn save_file(id: String, state: tauri::State<'_, Arc<server::Library>>) -> Result<Option<String>, String> {
    let item = state.ready_file(&id).await.map_err(|e| e.1)?;
    let Some(dest) = rfd::AsyncFileDialog::new().set_file_name(&item.name).save_file().await else { return Ok(None); };
    let path: PathBuf = dest.path().to_path_buf();
    tokio::fs::copy(state.binary(&id), &path).await.map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn open_library(state: tauri::State<'_, Arc<server::Library>>) -> Result<(), String> {
    std::process::Command::new("explorer.exe").arg(&state.root).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
        }))
        .setup(|app| {
            let root = app.path().app_data_dir()?.join("library");
            let library = tauri::async_runtime::block_on(server::Library::load(root))?;
            let listener = std::net::TcpListener::bind(("0.0.0.0", server::PORT))?;
            listener.set_nonblocking(true)?;
            app.manage(library.clone());
            tauri::async_runtime::spawn(async move {
                if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
                    if let Err(e) = server::serve(library, listener).await { eprintln!("ColdDrop server: {e}"); }
                }
            });
            use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder};
            let show = MenuItem::with_id(app, "show", "Open ColdDrop", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit ColdDrop", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new().tooltip("ColdDrop • Your shared gallery").menu(&menu).on_menu_event(|app, event| {
                match event.id.as_ref() {
                    "show" => { if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); } },
                    "quit" => app.exit(0), _ => ()
                }
            });
            if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); let _ = window.hide(); }
        })
        .invoke_handler(tauri::generate_handler![connection, choose_files, save_file, open_library])
        .run(tauri::generate_context!())
        .expect("ColdDrop could not start. Port 48321 must be available.");
}
