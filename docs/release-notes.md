ColdDrop 1.0.0 packages an Android app and a Tauri Windows app for one shared gallery over private Wi-Fi.

- Add large files from either device; originals are stored on the Windows PC.
- Image and video gallery, search, media previews, and downloads.
- QR pairing, live gallery notifications, chunked resumable phone uploads, and background Android transfer notifications.
- Windows installer and portable executable; release-signed Android APK.

Install the Windows app, open Devices, then scan its QR code from the Android app. Both devices must use the same private Wi-Fi, and the PC must remain awake with ColdDrop running. Allow private-network access through Windows Firewall when prompted.

The APK and EXE files are also committed under artifacts/ in this private repository. Windows builds are unsigned. Documents are downloadable and open in an external application. Video preview depends on the device's codecs.

No tests, runtime checks, UI inspection, device testing, or transfer verification were performed. Gradle automatically ran release lint during the initial APK build; subsequent builds disable it. These are build-produced binaries with unverified runtime behavior.
