import { invoke, isTauri } from '@tauri-apps/api/core';

export type Connection = { base: string; key: string; addresses?: string[]; folder?: string };
export type GalleryFile = { id: string; name: string; size: number; mime: string; created: number; source: string; ready: boolean; thumbnail: boolean };
export type Transfer = { id: string; name: string; size: number; sent: number; status: 'queued' | 'uploading' | 'downloading' | 'complete' | 'failed'; error?: string };
declare global {
  interface Window {
    ColdDrop?: { connection(): string; saveConnection(value: string): void; pickFiles(): void; scan(): void; download(id: string, name: string, mime: string): void; transfers(): string; retry(id: string): void; disconnect(): void };
    onColdDropTransfer?: (value: Transfer) => void;
    onColdDropScan?: (value: string) => void;
    onColdDropError?: (value: string) => void;
    onColdDropResume?: () => void;
  }
}
export const desktop = isTauri();
export async function boot(): Promise<Connection | null> {
  if (desktop) return invoke<Connection>('connection');
  const raw = window.ColdDrop?.connection() || localStorage.getItem('colddrop-connection');
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export const url = (c: Connection, path: string) => `${c.base}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(c.key)}`;
export const mediaUrl = (c: Connection, f: GalleryFile) => url(c, `/api/files/${f.id}/content`);
export async function request<T>(c: Connection, path: string, options: RequestInit = {}): Promise<T> {
  const result = await fetch(`${c.base}${path}`, { ...options, headers: { Authorization: `Bearer ${c.key}`, ...options.headers }, signal: options.signal ?? AbortSignal.timeout(10000) });
  if (!result.ok) throw new Error((await result.text()).slice(0, 240) || `Request failed (${result.status})`);
  return result.status === 204 ? undefined as T : result.json();
}
export function parsePairing(input: string): Connection {
  const link = new URL(input.trim());
  let base: string, key: string;
  if (link.protocol === 'colddrop:') { base = link.searchParams.get('server') || ''; key = link.searchParams.get('key') || ''; }
  else { base = link.origin; key = new URLSearchParams(link.hash.slice(1)).get('key') || link.searchParams.get('key') || ''; }
  const server = new URL(base);
  const parts = server.hostname.split('.').map(Number);
  const privateIP = parts.length === 4 && parts.every(v => Number.isInteger(v) && v >= 0 && v <= 255) && (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  if (server.protocol !== 'http:' || !privateIP || server.port !== '48321' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Use the pairing link shown in ColdDrop on your PC. Both devices need the same Wi-Fi.');
  return { base: server.origin, key };
}
export const pairingLink = (c: Connection, address: string) => `colddrop://pair?server=${encodeURIComponent(address)}&key=${c.key}`;
export function kind(file: GalleryFile): string { return file.mime.startsWith('video/') ? 'Videos' : file.mime.startsWith('image/') ? 'Images' : 'Documents'; }
export function bytes(n: number): string { if (!n) return '0 B'; const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024))); return `${(n / 1024 ** i).toFixed(i > 0 ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`; }

export async function browserUpload(c: Connection, file: File, report: (t: Transfer) => void) {
  const fingerprint = `upload:${c.base}:${file.name}:${file.size}:${file.lastModified}`;
  let id = localStorage.getItem(fingerprint) || '', offset = 0;
  if (id) {
    try { const state = await request<{ offset: number; ready: boolean }>(c, `/api/uploads/${id}`); offset = state.offset; if (state.ready) { localStorage.removeItem(fingerprint); return; } }
    catch (error) { if (String(error).includes('File not found')) { id = ''; } else throw error; }
  }
  if (!id) {
    const created = await request<{ id: string }>(c, '/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, size: file.size, source: desktop ? 'PC' : 'Phone' }) });
    id = created.id; localStorage.setItem(fingerprint, id);
  }
  const progress = (status: Transfer['status'], error?: string) => report({ id, name: file.name, size: file.size, sent: offset, status, error });
  progress('uploading');
  try {
    while (offset < file.size) {
      let uploaded = false;
      for (let attempt = 0; attempt < 4 && !uploaded; attempt++) {
        try {
          const response = await request<{ offset: number }>(c, `/api/uploads/${id}?offset=${offset}`, { method: 'PUT', body: file.slice(offset, offset + 4 * 1024 * 1024), signal: AbortSignal.timeout(120000) });
          offset = response.offset; uploaded = true; progress('uploading');
        } catch (error) {
          if (attempt === 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          offset = (await request<{ offset: number }>(c, `/api/uploads/${id}`)).offset;
          if (offset === file.size) uploaded = true;
        }
      }
    }
    await request(c, `/api/uploads/${id}/complete`, { method: 'POST' }); localStorage.removeItem(fingerprint); progress('complete');
  } catch (error) { progress('failed', String(error)); throw error; }
}
