ColdDrop 1.3.0

- Delete anything: single files, many files at once, and categories with or without their files. Every file delete can be undone for five seconds.
- Phone gallery now shows image and video thumbnails and previews.
- New phone layout: app bar, bottom tab bar, compact photo grid, filter chips, bottom sheets, press and hold to select, and a floating add button. Large screens get a side rail.
- Faster tab switching: every tab stays loaded, keeps its scroll position, and fades in.
- PC: hover a file for select and delete, select all with Ctrl+A, delete with the Delete key, and clear finished transfers.

ColdDrop 1.2.0

- Categories: create, rename, and delete your own folders from any tab, add files straight into one, or move any file in from its preview.
- Rename button on every file tile.

ColdDrop 1.1.0

- Rename any file from its preview. The new name appears on both devices and is used when saving a copy.
- Faster phone uploads: larger chunks, reused connections, and file data streamed straight to the PC.
- Smoother gallery with large libraries: tiles only redraw when their file changes, and bursts of updates are merged into one refresh.

ColdDrop 1.0.0 packages an Android app and a Tauri Windows app for one shared gallery over private Wi-Fi.

- Add large files from either device; originals are stored on the Windows PC.
- Image and video gallery, search, media previews, and downloads.
- QR pairing, live gallery notifications, chunked resumable phone uploads, and background Android transfer notifications.
- Windows installer and portable executable; release-signed Android APK.

Install the Windows app, open Devices, then scan its QR code from the Android app. Both devices must use the same private Wi-Fi, and the PC must remain awake with ColdDrop running. Allow private-network access through Windows Firewall when prompted.

The APK and EXE files are also committed under artifacts/ in this private repository. Windows builds are unsigned. Documents are downloadable and open in an external application. Video preview depends on the device's codecs.

No tests, runtime checks, UI inspection, device testing, or transfer verification were performed. Gradle automatically ran release lint during the initial APK build; subsequent builds disable it. These are build-produced binaries with unverified runtime behavior.
