import { cp, mkdir } from 'node:fs/promises';
await mkdir('mobile/app/assets', { recursive: true });
await cp('dist', 'mobile/app/assets', { recursive: true });
await mkdir('mobile/app/res', { recursive: true });
await cp('src-tauri/icons/android', 'mobile/app/res', { recursive: true });
console.log('Shared gallery and icons packaged for Android.');
