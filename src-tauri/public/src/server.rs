use axum::{body::Body, extract::{DefaultBodyLimit, Path, Query, State, Request}, http::{header, HeaderMap, StatusCode}, middleware::{self, Next}, response::{IntoResponse, Response, Sse, sse::{Event, KeepAlive}}, routing::{get, post, put}, Json, Router};
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, convert::Infallible, path::PathBuf, sync::Arc, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::{fs, io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt}, sync::{broadcast, Mutex, RwLock}};
use tokio_util::io::ReaderStream;
use tower_http::cors::CorsLayer;
use tauri::Emitter;

pub const PORT: u16 = 48321;
type ApiError = (StatusCode, String);
type ApiResult<T> = Result<T, ApiError>;
fn ioerr(e: impl std::fmt::Display) -> ApiError { (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()) }
fn bad(e: &str) -> ApiError { (StatusCode::BAD_REQUEST, e.into()) }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() * 1000 }

#[derive(Clone, Serialize, Deserialize)]
pub struct FileRecord {
    pub id: String, pub name: String, pub size: u64, pub mime: String, pub created: u64,
    pub source: String, pub ready: bool, #[serde(default)] pub thumbnail: bool,
}
#[derive(Serialize)]
struct Listing { files: Vec<FileRecord> }
#[derive(Deserialize)]
struct CreateFile { name: String, size: u64, #[serde(default)] source: String }
#[derive(Deserialize)]
struct Access { #[serde(default)] offset: u64, #[serde(default)] download: bool }
#[derive(Serialize)]
struct Upload { id: String, offset: u64, ready: bool }

pub struct Library {
    pub root: PathBuf, pub key: String,
    files: RwLock<HashMap<String, FileRecord>>,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    events: broadcast::Sender<String>,
}
impl Library {
    pub async fn load(root: PathBuf) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        fs::create_dir_all(root.join("metadata")).await?;
        fs::create_dir_all(root.join("files")).await?;
        fs::create_dir_all(root.join("thumbnails")).await?;
        let key_file = root.join("device-key");
        let key = if key_file.exists() { fs::read_to_string(&key_file).await?.trim().to_owned() } else {
            let key = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
            fs::write(&key_file, &key).await?; key
        };
        if key.len() != 64 { return Err("Invalid device key. Restore the library's device-key file.".into()); }
        let mut files = HashMap::new();
        let mut entries = fs::read_dir(root.join("metadata")).await?;
        while let Some(entry) = entries.next_entry().await? {
            if entry.path().extension().and_then(|v| v.to_str()) != Some("json") { continue; }
            let mut item: FileRecord = serde_json::from_slice(&fs::read(entry.path()).await?)?;
            if uuid::Uuid::parse_str(&item.id).is_err() { continue; }
            let binary = root.join("files").join(format!("{}.bin", item.id));
            if let Ok(meta) = fs::metadata(binary).await { item.ready = meta.len() == item.size; }
            item.thumbnail = root.join("thumbnails").join(format!("{}.jpg", item.id)).exists();
            files.insert(item.id.clone(), item);
        }
        let (events, _) = broadcast::channel(256);
        Ok(Arc::new(Self { root, key, files: RwLock::new(files), locks: Mutex::new(HashMap::new()), events }))
    }
    pub fn binary(&self, id: &str) -> PathBuf { self.root.join("files").join(format!("{id}.bin")) }
    fn partial(&self, id: &str) -> PathBuf { self.root.join("files").join(format!("{id}.part")) }
    async fn lock(&self, id: &str) -> Arc<Mutex<()>> { self.locks.lock().await.entry(id.into()).or_insert_with(|| Arc::new(Mutex::new(()))).clone() }
    async fn persist(&self, file: FileRecord) -> ApiResult<()> {
        let path = self.root.join("metadata").join(format!("{}.json", file.id));
        let temp = path.with_extension("tmp");
        fs::write(&temp, serde_json::to_vec(&file).map_err(ioerr)?).await.map_err(ioerr)?;
        fs::rename(temp, path).await.map_err(ioerr)?;
        self.files.write().await.insert(file.id.clone(), file);
        self.changed(); Ok(())
    }
    fn changed(&self) { let _ = self.events.send("gallery".into()); }
    async fn record(&self, id: &str) -> ApiResult<FileRecord> {
        self.files.read().await.get(id).cloned().ok_or((StatusCode::NOT_FOUND, "File not found".into()))
    }
    pub async fn ready_file(&self, id: &str) -> ApiResult<FileRecord> {
        let file = self.record(id).await?;
        if !file.ready { return Err((StatusCode::CONFLICT, "This file is still transferring".into())); } Ok(file)
    }
    async fn create(&self, args: CreateFile) -> ApiResult<FileRecord> {
        let name: String = args.name.chars().filter(|c| !c.is_control() && *c != '/' && *c != '\\').take(240).collect();
        if name.trim().is_empty() { return Err(bad("A file name is required")); }
        if args.size > 16 * 1024 * 1024 * 1024 * 1024u64 { return Err(bad("Maximum file size is 16 TiB")); }
        let mime = mime_guess::from_path(&name).first_or_octet_stream().to_string();
        let record = FileRecord { id: uuid::Uuid::new_v4().to_string(), name, size: args.size, mime, created: now(), source: if args.source == "PC" { "PC" } else { "Phone" }.into(), ready: false, thumbnail: false };
        fs::File::create(self.partial(&record.id)).await.map_err(ioerr)?;
        self.persist(record.clone()).await?; Ok(record)
    }
    async fn finish(&self, id: &str) -> ApiResult<FileRecord> {
        let mut file = self.record(id).await?;
        if file.ready { return Ok(file); }
        if fs::metadata(self.partial(id)).await.map_err(ioerr)?.len() != file.size { return Err(bad("The upload is incomplete. Resume it before finishing.")); }
        fs::rename(self.partial(id), self.binary(id)).await.map_err(ioerr)?;
        file.ready = true; self.persist(file.clone()).await?; Ok(file)
    }
}

async fn auth(State(s): State<Arc<Library>>, request: Request, next: Next) -> Response {
    let bearer = request.headers().get(header::AUTHORIZATION).and_then(|h| h.to_str().ok()).and_then(|h| h.strip_prefix("Bearer "));
    let query_key = request.uri().query().and_then(|q| q.split('&').find_map(|p| p.strip_prefix("key=")));
    let provided = bearer.or(query_key).unwrap_or("");
    let good = provided.len() == s.key.len() && provided.bytes().zip(s.key.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0;
    if !good { return (StatusCode::UNAUTHORIZED, "Pair with this PC to access the library").into_response(); }
    next.run(request).await
}

pub async fn serve(state: Arc<Library>, listener: tokio::net::TcpListener) -> std::io::Result<()> {
    let origins = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "https://appassets.androidplatform.net", "http://localhost:5173", "http://127.0.0.1:5173"].map(|s| s.parse().unwrap());
    let app = Router::new()
        .route("/api/files", get(list))
        .route("/api/uploads", post(create))
        .route("/api/uploads/{id}", get(status).put(chunk))
        .route("/api/uploads/{id}/complete", post(complete))
        .route("/api/files/{id}/thumbnail", put(thumbnail).get(get_thumbnail))
        .route("/api/files/{id}/content", get(content))
        .route("/api/events", get(events))
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .layer(CorsLayer::new().allow_origin(origins).allow_private_network(true).allow_methods([axum::http::Method::GET, axum::http::Method::POST, axum::http::Method::PUT, axum::http::Method::OPTIONS]).allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::RANGE]).expose_headers([header::CONTENT_LENGTH, header::CONTENT_RANGE, header::ACCEPT_RANGES]).max_age(Duration::from_secs(3600)))
        .with_state(state);
    axum::serve(listener, app).await
}
async fn list(State(s): State<Arc<Library>>) -> Json<Listing> {
    let mut files: Vec<_> = s.files.read().await.values().cloned().collect(); files.sort_by_key(|f| std::cmp::Reverse(f.created)); Json(Listing { files })
}
async fn create(State(s): State<Arc<Library>>, Json(args): Json<CreateFile>) -> ApiResult<Json<Upload>> {
    let file = s.create(args).await?; Ok(Json(Upload { id: file.id, offset: 0, ready: false }))
}
async fn status(State(s): State<Arc<Library>>, Path(id): Path<String>) -> ApiResult<Json<Upload>> {
    let record = s.record(&id).await?;
    let offset = if record.ready { record.size } else { fs::metadata(s.partial(&id)).await.map_err(ioerr)?.len() };
    Ok(Json(Upload { id, offset, ready: record.ready }))
}
async fn chunk(State(s): State<Arc<Library>>, Path(id): Path<String>, Query(access): Query<Access>, body: axum::body::Bytes) -> ApiResult<Json<Upload>> {
    let record = s.record(&id).await?;
    if record.ready { return Err((StatusCode::CONFLICT, "File already complete".into())); }
    let lock = s.lock(&id).await; let _guard = lock.lock().await;
    let mut file = fs::OpenOptions::new().append(true).open(s.partial(&id)).await.map_err(ioerr)?;
    let current = file.metadata().await.map_err(ioerr)?.len();
    if current != access.offset { return Err((StatusCode::CONFLICT, "Upload offset changed. Resume from the current offset.".into())); }
    if current.saturating_add(body.len() as u64) > record.size { return Err(bad("Chunk exceeds the declared file size")); }
    file.write_all(&body).await.map_err(ioerr)?; file.flush().await.map_err(ioerr)?;
    Ok(Json(Upload { id, offset: current + body.len() as u64, ready: false }))
}
async fn complete(State(s): State<Arc<Library>>, Path(id): Path<String>) -> ApiResult<Json<FileRecord>> {
    let lock = s.lock(&id).await; let _guard = lock.lock().await; Ok(Json(s.finish(&id).await?))
}
async fn thumbnail(State(s): State<Arc<Library>>, Path(id): Path<String>, body: axum::body::Bytes) -> ApiResult<StatusCode> {
    s.record(&id).await?;
    if body.len() > 2 * 1024 * 1024 || !body.starts_with(&[0xff, 0xd8, 0xff]) { return Err(bad("Thumbnail must be a JPEG under 2 MB")); }
    let lock = s.lock(&id).await; let _guard = lock.lock().await;
    fs::write(s.root.join("thumbnails").join(format!("{id}.jpg")), body).await.map_err(ioerr)?;
    let mut record = s.record(&id).await?; record.thumbnail = true; s.persist(record).await?; Ok(StatusCode::NO_CONTENT)
}
async fn get_thumbnail(State(s): State<Arc<Library>>, Path(id): Path<String>) -> ApiResult<Response> {
    s.record(&id).await?;
    let file = fs::File::open(s.root.join("thumbnails").join(format!("{id}.jpg"))).await.map_err(|_| (StatusCode::NOT_FOUND, "No thumbnail yet".into()))?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=86400"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")], Body::from_stream(ReaderStream::new(file))).into_response())
}
async fn content(State(s): State<Arc<Library>>, Path(id): Path<String>, Query(access): Query<Access>, headers: HeaderMap) -> ApiResult<Response> {
    let item = s.ready_file(&id).await?;
    let mut file = fs::File::open(s.binary(&id)).await.map_err(ioerr)?;
    let mut start = 0; let mut length = item.size; let mut partial = false;
    if let Some(range) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let invalid = || (StatusCode::RANGE_NOT_SATISFIABLE, "Requested range is outside this file".into());
        let spec = range.strip_prefix("bytes=").ok_or_else(invalid)?;
        if spec.contains(',') || item.size == 0 { return Err(invalid()); }
        let (a, b) = spec.split_once('-').ok_or_else(invalid)?;
        let end;
        if a.is_empty() {
            let suffix: u64 = b.parse().map_err(|_| invalid())?;
            if suffix == 0 { return Err(invalid()); }
            start = item.size.saturating_sub(suffix); end = item.size - 1;
        } else {
            start = a.parse().map_err(|_| invalid())?;
            end = if b.is_empty() { item.size - 1 } else { b.parse::<u64>().map_err(|_| invalid())?.min(item.size - 1) };
        }
        if start >= item.size || end < start { return Err(invalid()); }
        length = end - start + 1; partial = true; file.seek(std::io::SeekFrom::Start(start)).await.map_err(ioerr)?;
    }
    let preview_mime = if (item.mime.starts_with("image/") && item.mime != "image/svg+xml") || item.mime.starts_with("video/") || item.mime.starts_with("audio/") { item.mime.as_str() } else { "application/octet-stream" };
    let disposition = if access.download || preview_mime == "application/octet-stream" { "attachment" } else { "inline" };
    let filename = percent_encoding::utf8_percent_encode(&item.name, percent_encoding::NON_ALPHANUMERIC);
    let mut response = Response::builder().status(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_TYPE, preview_mime).header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes").header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .header(header::CONTENT_DISPOSITION, format!("{disposition}; filename*=UTF-8''{filename}"));
    if partial { response = response.header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, start + length - 1, item.size)); }
    response.body(Body::from_stream(ReaderStream::with_capacity(file.take(length), 256 * 1024))).map_err(ioerr)
}
async fn events(State(s): State<Arc<Library>>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let mut rx = s.events.subscribe();
    let stream = async_stream::stream! {
        yield Ok(Event::default().data("connected"));
        loop {
            match rx.recv().await {
                Ok(data) => yield Ok(Event::default().data(data)),
                Err(broadcast::error::RecvError::Lagged(_)) => yield Ok(Event::default().data("gallery")),
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(10)).text("keepalive"))
}

pub async fn import(s: &Arc<Library>, path: PathBuf, app: &tauri::AppHandle) -> Result<(), String> {
    let mut source = fs::File::open(&path).await.map_err(|e| e.to_string())?;
    let size = source.metadata().await.map_err(|e| e.to_string())?.len();
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let item = s.create(CreateFile { name, size, source: "PC".into() }).await.map_err(|e| e.1)?;
    let result: Result<(), String> = async {
        let mut dest = fs::OpenOptions::new().write(true).open(s.partial(&item.id)).await.map_err(|e| e.to_string())?;
        let mut buffer = vec![0; 4 * 1024 * 1024]; let mut sent = 0u64; let mut last = std::time::Instant::now();
        loop {
            let n = source.read(&mut buffer).await.map_err(|e| e.to_string())?; if n == 0 { break; }
            dest.write_all(&buffer[..n]).await.map_err(|e| e.to_string())?; sent += n as u64;
            if last.elapsed() > Duration::from_millis(180) || sent == size {
                let _ = app.emit("transfer", serde_json::json!({"id":item.id,"name":item.name,"size":size,"sent":sent,"status":"uploading"})); last = std::time::Instant::now();
            }
        }
        dest.sync_all().await.map_err(|e| e.to_string())?; drop(dest);
        let lock = s.lock(&item.id).await; let _guard = lock.lock().await;
        s.finish(&item.id).await.map_err(|e| e.1)?;
        let _ = app.emit("transfer", serde_json::json!({"id":item.id,"name":item.name,"size":size,"sent":size,"status":"complete"}));
        Ok(())
    }.await;
    if let Err(ref error) = result { let _ = app.emit("transfer", serde_json::json!({"id":item.id,"name":item.name,"size":size,"status":"failed","error":error})); }
    result
}
