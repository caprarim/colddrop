# ColdDrop

A shared file gallery for Android and Windows, built for large videos. Add originals from either device, see them in the other gallery, preview images and videos, and download files. PowerPoint files, PDFs, archives, and other formats can be stored and downloaded; documents open in their normal applications after saving.

**This version works over the same private Wi-Fi network. Your Windows PC hosts the library and must be awake with ColdDrop running. It is not a cloud storage service.**

## Install

The binaries are committed in [`artifacts`](artifacts/) and attached to the private GitHub release:

- [`ColdDrop-1.2.0.apk`](artifacts/ColdDrop-1.2.0.apk): Android 10 or newer. Download on the phone and allow installation from the browser or file manager when Android asks.
- [`ColdDrop-1.1.0-setup.exe`](artifacts/ColdDrop-1.1.0-setup.exe): Windows installer, x64. WebView2 is installed by the installer if needed.
- [`ColdDrop-1.1.0-portable.exe`](artifacts/ColdDrop-1.1.0-portable.exe): standalone Windows app; requires the WebView2 runtime already installed.

The Windows executables are not code-signed. The APK is signed with a locally generated private release key; that key and its passwords are excluded from Git.

## Connect and use

1. Install and open ColdDrop on the PC. Allow access through Windows Firewall on **private networks** if prompted.
2. Connect the phone and PC to the same Wi-Fi. Open **Devices** in both apps.
3. Tap **Scan QR code** on Android and scan the code displayed on the PC. Alternatively, copy the PC's pairing link into the phone app. If the PC has multiple adapters, choose its Wi-Fi address in the address selector.
4. Tap **Add files** on either device. Desktop also accepts dropped files. The new gallery entry appears when the upload starts; previews and downloads become available when the original finishes transferring.
5. Tap a thumbnail to preview. Images support tap-to-zoom, swipe between files, and previous/next controls. Videos support playback and seeking. Use **Download** to choose where to save a copy.
6. To rename a file, open it and tap the pencil next to its name, type the new name, and press Enter. On the PC, F2 also starts renaming. The new name shows on both devices and is used for downloads.
7. Group files with categories. In any tab, tap **New category** and name it (for example, hooks). Open a category and use **Add here** to put new files straight in, or open any file and tap the folder button to move it into a category. Deleting a category keeps its files in your library.

Closing the Windows window hides it in the system tray and leaves sharing active. **Quit ColdDrop** in the tray menu stops the server. The app does not start automatically with Windows.

Android uploads continue in a foreground service with a notification. If Android stops the process, reopen ColdDrop and use **Transfers → Retry** to resume the upload from the last chunk stored on the PC. Retrying a failed download restarts that download into the same selected destination. A partial downloaded document may remain there until the retry succeeds.

## Storage and speed

- The originals and metadata live under the current Windows user's Tauri app-data directory: `%APPDATA%\com.caprarim.colddrop\library`. **Devices → Open storage folder** opens the actual location.
- Originals use internal UUID filenames; the gallery retains their original names. Use Download to export a normally named copy. Back up the entire library folder to retain names and pairing.
- Upload chunks are 4 MiB. The server accepts files up to 16 TiB, subject to filesystem limits and available disk space. It never buffers an entire video in memory.
- Completed gallery changes are pushed over server-sent events. A 15-second refresh also provides fallback updates. Transfer time still depends on the original size, Wi-Fi, disk speed, and device performance; it is not instantaneous.
- Video requests support HTTP byte ranges for streaming and seeking. Images and videos receive smaller cached thumbnails where decoding is supported. A device's supported codecs determine which originals it can preview. Unsupported formats remain downloadable.
- Uploading from Windows copies a file into the shared library. Uploading from Android stores it on the PC. Downloading explicitly makes a separate copy on the destination device.

## Connection troubleshooting

- Keep the PC awake, keep ColdDrop running, and reconnect to the same Wi-Fi. Guest Wi-Fi and access-point isolation can block device-to-device traffic.
- TCP port **48321** is used for the local server. Windows Firewall must allow the app on private networks. Do not expose this port to the internet.
- If the PC's local address changes, scan its current QR code again.
- Keep the source file in place until an upload finishes. If a file provider does not expose its size, save that file to the phone's local storage before selecting it.
- The pairing link is a bearer credential granting access to this library. Share it only with your own devices. Local transfers use HTTP and are not encrypted in transit; use a trusted private Wi-Fi network. No analytics or cloud upload service is included.

## Build

Desktop uses React, TypeScript, Vite, Tauri v2, and a Rust/Axum server. Android uses Kotlin, a locally bundled version of the same gallery UI, Android file pickers, and a native foreground transfer service. All implementation source is under `public/src` directories.

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts/build-desktop.ps1
npm run mobile:build
```

Desktop requires Rust, Microsoft C++ build tools, Node.js, and WebView2. Android requires Android SDK 36 and Java 17 or newer. The mobile build script defaults to Android Studio's bundled JDK and `D:\Android\Sdk`; set `ANDROID_HOME` if your SDK is elsewhere. Gradle is pinned by the included wrapper.

The initial mobile build creates signing material in `%LOCALAPPDATA%\ColdDrop\signing`, with local configuration in `mobile/signing.properties`. Preserve both securely for future APK updates. Neither belongs in Git. If the local configuration is missing but the key exists, the script stops instead of replacing the key.

## Delivery status

Build commands produce the release APK and Windows binaries. **No automated tests, runtime checks, UI inspection, device testing, or transfer verification were run. Build success does not establish runtime correctness.** Gradle automatically included its release-lint tasks in the first Android packaging run. Release lint is now disabled in the build configuration to honor the request to skip verification.

Design uses the installed Claude Code **Impeccable** product guidance and its indigo seed. Desktop implementation follows the more detailed **tauri-v2** skill. No subagents were used. The app icon was generated with the built-in image tool; see [`docs/icon-prompt.md`](docs/icon-prompt.md).

Implementation references: [Tauri Windows installers](https://v2.tauri.app/distribute/windows-installer/), [Axum request limits](https://docs.rs/axum/latest/axum/extract/struct.DefaultBodyLimit.html), and [Android foreground service time limits](https://developer.android.com/develop/background-work/services/fgs/timeout).
