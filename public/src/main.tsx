import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import QRCode from 'qrcode';
import { ArrowDownToLine, ArrowUpFromLine, ArrowLeft, ArrowRight, Check, CheckCheck, ChevronRight, CircleAlert, Copy, FileText, Film, FolderOpen, Grid2X2, Image as ImageIcon, Laptop, List, LoaderCircle, Plus, Search, Settings2, Smartphone, Upload, Wifi, WifiOff, X, ScanLine, Link, Play, RefreshCw, Music } from 'lucide-react';
import { boot, browserUpload, bytes, desktop, GalleryFile, Connection, kind, mediaUrl, pairingLink, parsePairing, request, Transfer, url } from './api';
import icon from './icon.png';
import './styles.css';

const filters = ['All files', 'Videos', 'Images', 'Documents'];
const icons = [Grid2X2, Film, ImageIcon, FileText];
function App() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [files, setFiles] = useState<GalleryFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(false);
  const [view, setView] = useState('library');
  const [filter, setFilter] = useState('All files');
  const [query, setQuery] = useState('');
  const [list, setList] = useState(false);
  const [preview, setPreview] = useState<GalleryFile | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const browsingQueue = useRef<Promise<unknown>>(Promise.resolve());
  const report = useCallback((t: Transfer) => { setTransfers(items => [t, ...items.filter(x => x.id !== t.id)].slice(0, 100)); }, []);
  const refresh = useCallback(async () => {
    if (!connection) return;
    try { const result = await request<{ files: GalleryFile[] }>(connection, '/api/files'); setFiles(result.files); setOnline(true); setError(''); setLoaded(true); }
    catch { setOnline(false); setLoaded(true); }
  }, [connection]);
  useEffect(() => {
    boot().then(c => { setConnection(c); if (!c) { setLoaded(true); setView('devices'); } }).catch(e => { setError(String(e)); setLoaded(true); });
    window.onColdDropTransfer = report;
    window.onColdDropError = setError;
    if (window.ColdDrop) { try { setTransfers(JSON.parse(window.ColdDrop.transfers())); } catch {} }
    let cleanup: (() => void) | undefined;
    if (desktop) listen<Transfer>('transfer', e => report(e.payload)).then(fn => cleanup = fn);
    return () => { cleanup?.(); delete window.onColdDropTransfer; delete window.onColdDropError; };
  }, [report]);
  useEffect(() => {
    if (!connection) return;
    setLoaded(false); refresh();
    const stream = new EventSource(url(connection, '/api/events'));
    stream.onmessage = () => { setOnline(true); refresh(); };
    stream.onerror = () => setOnline(false);
    const timer = setInterval(refresh, 15000);
    const resume = () => { if (!document.hidden) refresh(); };
    window.onColdDropResume = resume;
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', refresh);
    return () => { stream.close(); clearInterval(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', refresh); delete window.onColdDropResume; };
  }, [connection, refresh]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  const add = async () => {
    if (!connection || !online) { setView('devices'); return; }
    try { if (desktop) await invoke('choose_files'); else if (window.ColdDrop) window.ColdDrop.pickFiles(); else picker.current?.click(); } catch (e) { setError(String(e)); }
  };
  const uploadFiles = (selected: FileList | File[]) => {
    if (!connection) return;
    const c = connection;
    for (const file of Array.from(selected)) {
      browsingQueue.current = browsingQueue.current.then(() => browserUpload(c, file, report)).catch(e => setError(`${file.name}: ${String(e)}`));
    }
  };
  const download = async (file: GalleryFile) => {
    if (!connection || busy) return;
    setBusy(true);
    try {
      if (desktop) { const path = await invoke<string | null>('save_file', { id: file.id }); if (path) setNotice(`Saved ${file.name}`); }
      else if (window.ColdDrop) { window.ColdDrop.download(file.id, file.name, file.mime); }
      else { const a = document.createElement('a'); a.href = `${mediaUrl(connection, file)}&download=true`; a.download = file.name; a.click(); }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const visible = files.filter(f => (filter === 'All files' || kind(f) === filter) && f.name.toLowerCase().includes(query.toLowerCase()));
  const active = transfers.filter(t => ['uploading', 'queued', 'downloading'].includes(t.status));
  const groups = new Map<string, GalleryFile[]>();
  for (const file of visible) {
    const date = new Date(file.created); const today = new Date();
    const title = date.toDateString() === today.toDateString() ? 'Today' : date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
    groups.set(title, [...(groups.get(title) || []), file]);
  }
  return <div className="app" onDragOver={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setDrag(true); }} onDrop={e => { e.preventDefault(); setDrag(false); if (online && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); }}>
    <input ref={picker} type="file" multiple hidden onChange={e => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ''; }} />
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setView('library'); }}><img src={icon} alt=""/><span>ColdDrop<span className="brand-sub">Your shared space</span></span></a>
      <button className="primary sidebar-add" onClick={add}><Plus size={19}/> Add files</button>
      <div className="nav-label">Library</div>
      <nav aria-label="Library">{filters.map((f, i) => { const Icon = icons[i]; return <button key={f} className={`nav-item ${view === 'library' && filter === f ? 'selected' : ''}`} onClick={() => { setFilter(f); setView('library'); }}><Icon size={19}/><span>{f}</span><span className="count">{files.filter(x => f === 'All files' || kind(x) === f).length}</span></button>; })}</nav>
      <div className="nav-separator"/>
      <button className={`nav-item ${view === 'transfers' ? 'selected' : ''}`} onClick={() => setView('transfers')}><ArrowUpFromLine size={19}/><span>Transfers</span>{active.length > 0 && <span className="count">{active.length}</span>}</button>
      <button className={`nav-item ${view === 'devices' ? 'selected' : ''}`} onClick={() => setView('devices')}><Laptop size={19}/><span>Devices</span></button>
      <div className="sidebar-foot"><div className={`connection-status ${online ? 'connected' : ''}`}>{online ? <Wifi size={16}/> : <WifiOff size={16}/>}<span>{online ? 'Connected locally' : connection ? 'PC is offline' : 'Ready to connect'}</span></div><p>{bytes(files.filter(f => f.ready).reduce((sum, f) => sum + f.size, 0))} in your library</p><small>Original quality. Your storage.</small></div>
    </aside>
    <main>
      <header className="topbar"><span className="mobile-brand"><img src={icon} alt=""/>ColdDrop</span><span className="breadcrumb">Your space <ChevronRight size={14}/> {view === 'library' ? filter : view === 'devices' ? 'Devices' : 'Transfers'}</span><button className="device-indicator" onClick={() => setView('devices')}><span className={`status-dot ${online ? 'online' : ''}`}/>{desktop ? 'This PC' : online ? 'PC connected' : 'Connect PC'}<Settings2 size={15}/></button></header>
      <div className="page">
        {error && <div className="alert" role="alert"><CircleAlert size={20}/><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={17}/></button></div>}
        {connection && !online && loaded && <div className="offline-banner"><WifiOff size={19}/><span>Open ColdDrop on your PC and connect both devices to the same Wi-Fi.</span><button onClick={refresh}>Reconnect</button></div>}
        {view === 'library' && <>
          <div className="page-heading"><div><h1>{filter === 'All files' ? 'Your library' : filter}</h1><p>From your phone to your desk. Everything in one place.</p></div><button className="primary" onClick={add}><Plus size={19}/><span>Add files</span></button></div>
          <div className="toolbar"><label className="search"><Search size={18}/><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search your files" aria-label="Search files"/></label><span className="file-total">{visible.length} {visible.length === 1 ? 'file' : 'files'}</span><div className="view-toggle"><button aria-label="Grid view" aria-pressed={!list} className={!list ? 'active' : ''} onClick={() => setList(false)}><Grid2X2 size={18}/></button><button aria-label="List view" aria-pressed={list} className={list ? 'active' : ''} onClick={() => setList(true)}><List size={19}/></button></div></div>
          <div className="mobile-filters">{filters.map(f => <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{f}</button>)}</div>
          {active.length > 0 && <button className="transfer-banner" onClick={() => setView('transfers')}><Upload size={20}/><span><strong>{active.length} {active.length === 1 ? 'transfer' : 'transfers'} in progress</strong><small>{active[0].name}</small></span><ChevronRight size={18}/></button>}
          {!loaded ? <div className="gallery skeletons" aria-label="Loading gallery">{Array.from({ length: 8 }, (_, i) => <div className="skeleton" key={i}/>)}</div> : visible.length === 0 ? <div className="empty"><div className="empty-art"><FolderOpen size={46} strokeWidth={1.2}/><span><Plus size={16}/></span></div><h2>{query ? 'No matching files' : filter === 'All files' ? 'Big files. Small effort.' : `No ${filter.toLowerCase()} yet`}</h2><p>{query ? 'Try a different file name.' : 'Add videos, photos, presentations, or anything else. They’ll appear here on both devices.'}</p>{!query && <button className="primary" onClick={add}><Plus size={18}/>{online ? 'Add your first files' : 'Connect your devices'}</button>}<div className="empty-formats">MP4 <span>·</span> MOV <span>·</span> JPG <span>·</span> PPTX <span>·</span> and more</div></div> : Array.from(groups).map(([date, items]) => <section className="date-group" key={date}><div className="group-heading"><h2>{date}</h2><span>{items.length} {items.length === 1 ? 'file' : 'files'}</span></div><div className={list ? 'file-list' : 'gallery'}>{items.map(f => <FileTile key={f.id} file={f} connection={connection!} list={list} onOpen={() => setPreview(f)} onDownload={() => download(f)}/>)}</div></section>)}
          {files.length > 0 && <div className="library-footer"><CheckCheck size={15}/> {online ? 'Live updates are on' : 'Waiting for your PC'}<span>Files stay in their original quality</span></div>}
        </>}
        {view === 'devices' && <Devices connection={connection} online={online} onConnect={c => { setConnection(c); setFiles([]); setView('library'); }} onDisconnect={() => { window.ColdDrop?.disconnect(); localStorage.removeItem('colddrop-connection'); setConnection(null); setFiles([]); setOnline(false); }} notify={setNotice} error={setError}/>}
        {view === 'transfers' && <><div className="page-heading"><div><h1>Transfers</h1><p>Keep moving. Your files travel in the background.</p></div><button className="primary" onClick={add}><Plus size={19}/>Add files</button></div>{transfers.length === 0 ? <div className="empty"><div className="empty-art"><ArrowUpFromLine size={42} strokeWidth={1.3}/></div><h2>No transfers yet</h2><p>Files you add or download will appear here with their progress.</p></div> : <div className="transfers">{transfers.map(t => <TransferRow key={t.id} transfer={t}/>)}</div>}</>}
      </div>
    </main>
    <nav className="bottom-nav" aria-label="Main navigation"><button className={view === 'library' ? 'selected' : ''} onClick={() => setView('library')}><Grid2X2 size={21}/>Library</button><button className={view === 'transfers' ? 'selected' : ''} onClick={() => setView('transfers')}><ArrowUpFromLine size={21}/>Transfers{active.length > 0 && <span className="nav-badge">{active.length}</span>}</button><button className={view === 'devices' ? 'selected' : ''} onClick={() => setView('devices')}><Laptop size={21}/>Devices</button></nav>
    {preview && connection && <Preview file={preview} files={visible.filter(f => f.ready)} connection={connection} busy={busy} onClose={() => setPreview(null)} onSelect={setPreview} onDownload={() => download(preview)}/>}
    {notice && <div className="toast" role="status"><Check size={18}/>{notice}</div>}
    {drag && <div className="drop-overlay" onDragLeave={() => setDrag(false)} onDragOver={e => e.preventDefault()}><Upload size={52}/><h2>Drop into your library</h2><p>Original files. Ready on both devices.</p></div>}
  </div>;
}

function FileTile({ file, connection, list, onOpen, onDownload }: { file: GalleryFile; connection: Connection; list: boolean; onOpen(): void; onDownload(): void }) {
  const ref = useRef<HTMLElement>(null); const [seen, setSeen] = useState(false); const [failed, setFailed] = useState(false); const generating = useRef(false);
  const type = kind(file); const Icon = type === 'Videos' ? Film : type === 'Images' ? ImageIcon : file.mime.startsWith('audio/') ? Music : FileText;
  useEffect(() => { const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setSeen(true); observer.disconnect(); } }, { rootMargin: '160px' }); if (ref.current) observer.observe(ref.current); return () => observer.disconnect(); }, []);
  async function thumbnail(el: HTMLImageElement | HTMLVideoElement) {
    if (generating.current || file.thumbnail) return; generating.current = true;
    try {
      const width = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
      const height = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
      if (!width || !height) return;
      const canvas = document.createElement('canvas'); const scale = Math.min(480 / width, 480 / height, 1); canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
      canvas.getContext('2d')?.drawImage(el, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      if (blob) await request(connection, `/api/files/${file.id}/thumbnail`, { method: 'PUT', body: blob });
    } catch { /* The original file remains available if its preview cannot be generated. */ }
  }
  return <article ref={ref} className={`file-tile ${list ? 'is-list' : ''}`}>
    <button className={`file-open ${!file.ready ? 'pending' : ''}`} onClick={onOpen} aria-label={`Preview ${file.name}`}>
      <div className={`thumbnail type-${type.toLowerCase()}`}>
        {file.ready && seen && !failed && (file.thumbnail ? <img loading="lazy" src={url(connection, `/api/files/${file.id}/thumbnail`)} alt="" onError={() => setFailed(true)}/> : type === 'Images' ? <img loading="lazy" crossOrigin="anonymous" src={mediaUrl(connection, file)} alt="" onLoad={e => thumbnail(e.currentTarget)} onError={() => setFailed(true)}/> : type === 'Videos' ? <video muted playsInline preload="metadata" crossOrigin="anonymous" src={`${mediaUrl(connection, file)}#t=0.1`} onLoadedData={e => thumbnail(e.currentTarget)} onError={() => setFailed(true)}/> : null)}
        {(!file.ready || failed || (!file.thumbnail && type === 'Documents')) && <div className="file-placeholder"><Icon size={list ? 25 : 40} strokeWidth={1.35}/>{!list && <span>{file.name.split('.').pop()?.slice(0, 8).toUpperCase()}</span>}</div>}
        {!list && type === 'Videos' && file.ready && <span className="play-badge"><Play size={12} fill="currentColor"/>Video</span>}
        {!file.ready && <span className="pending-label">Transferring</span>}
      </div>
      <div className="file-info"><h3 title={file.name}>{file.name}</h3><div><span>{bytes(file.size)}</span><span className="file-dot">·</span><span>{file.source === 'PC' ? <Laptop size={12}/> : <Smartphone size={12}/>} {file.source}</span></div></div>
    </button>
    <button className="file-download icon-button" onClick={onDownload} disabled={!file.ready} aria-label={`Download ${file.name}`}><ArrowDownToLine size={17}/></button>
  </article>;
}

function Preview({ file, files, connection, busy, onClose, onSelect, onDownload }: { file: GalleryFile; files: GalleryFile[]; connection: Connection; busy: boolean; onClose(): void; onSelect(file: GalleryFile): void; onDownload(): void }) {
  const dialog = useRef<HTMLDialogElement>(null); const [failed, setFailed] = useState(false); const [zoom, setZoom] = useState(false); const touch = useRef<number | null>(null);
  const index = files.findIndex(f => f.id === file.id); const type = kind(file);
  const step = (direction: number) => { const next = files[index + direction]; if (next) onSelect(next); };
  useEffect(() => { const el = dialog.current; el?.showModal(); return () => el?.close(); }, []);
  useEffect(() => { setFailed(false); setZoom(false); }, [file.id]);
  return <dialog className="preview" ref={dialog} onCancel={e => { e.preventDefault(); onClose(); }} onKeyDown={e => { if (e.target instanceof HTMLVideoElement || e.target instanceof HTMLAudioElement) return; if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); }}>
    <header className="preview-header"><button className="icon-button" onClick={onClose} aria-label="Close preview"><X size={22}/></button><div><h2>{file.name}</h2><p>{bytes(file.size)} · From {file.source} · {new Date(file.created).toLocaleDateString()}</p></div><button className="primary" disabled={!file.ready || busy} onClick={onDownload}>{busy ? <LoaderCircle className="spin" size={18}/> : <ArrowDownToLine size={18}/>}<span>{busy ? 'Saving…' : 'Download'}</span></button></header>
    <div className={`preview-stage ${zoom ? 'zoomed' : ''}`} onTouchStart={e => touch.current = e.touches.length === 1 ? e.touches[0].clientX : null} onTouchEnd={e => { if (type === 'Images' && !zoom && touch.current !== null && Math.abs(e.changedTouches[0].clientX - touch.current) > 70) step(e.changedTouches[0].clientX < touch.current ? 1 : -1); touch.current = null; }}>
      {!file.ready ? <div className="preview-message"><Upload size={48}/><h2>This file is still transferring</h2><p>Close this preview and open it when the transfer finishes.</p></div> : failed ? <div className="preview-message"><CircleAlert size={44}/><h2>Preview unavailable</h2><p>This device can’t display this format, or your PC is offline. Download the original to open it in another app.</p><button className="primary" onClick={onDownload}>Download original</button></div> : type === 'Images' ? <img key={file.id} src={mediaUrl(connection, file)} alt={file.name} onError={() => setFailed(true)} onClick={() => setZoom(!zoom)}/> : type === 'Videos' ? <video key={file.id} controls autoPlay playsInline preload="metadata" src={mediaUrl(connection, file)} onError={() => setFailed(true)}/> : file.mime.startsWith('audio/') ? <div className="preview-message"><Music size={50}/><audio key={file.id} controls src={mediaUrl(connection, file)} onError={() => setFailed(true)}/></div> : <div className="preview-message"><FileText size={56} strokeWidth={1.2}/><h2>{file.name.split('.').pop()?.toUpperCase()} document</h2><p>Save this file to open it in PowerPoint, a PDF reader, or another app.</p><button className="primary" onClick={onDownload}><ArrowDownToLine size={18}/>Download file</button></div>}
    </div>
    {file.ready && <footer className="preview-footer"><button className="icon-button" aria-label="Previous file" disabled={index <= 0} onClick={() => step(-1)}><ArrowLeft size={21}/></button><span>{index + 1} / {files.length}{type === 'Images' && <small>Tap image to {zoom ? 'fit' : 'zoom'}</small>}</span><button className="icon-button" aria-label="Next file" disabled={index >= files.length - 1} onClick={() => step(1)}><ArrowRight size={21}/></button></footer>}
  </dialog>;
}

function Devices({ connection, online, onConnect, onDisconnect, notify, error }: { connection: Connection | null; online: boolean; onConnect(c: Connection): void; onDisconnect(): void; notify(s: string): void; error(s: string): void }) {
  const [input, setInput] = useState(''); const [working, setWorking] = useState(false); const [address, setAddress] = useState(''); const [qr, setQr] = useState('');
  const chosen = address || connection?.addresses?.find(a => a.includes('192.168.')) || connection?.addresses?.[0] || '';
  const pair = useCallback(async (value: string) => {
    setWorking(true);
    try { const c = parsePairing(value); await request(c, '/api/files'); window.ColdDrop?.saveConnection(JSON.stringify(c)); if (!window.ColdDrop) localStorage.setItem('colddrop-connection', JSON.stringify(c)); onConnect(c); notify('Connected to your PC'); }
    catch (e) { error(String(e).includes('fetch') || String(e).includes('Timeout') ? 'Could not reach your PC. Open ColdDrop there, use the same Wi-Fi, and allow ColdDrop through Windows Firewall on private networks.' : String(e)); }
    finally { setWorking(false); }
  }, [onConnect, notify, error]);
  useEffect(() => { window.onColdDropScan = pair; return () => { delete window.onColdDropScan; }; }, [pair]);
  useEffect(() => { if (desktop && connection && chosen) QRCode.toDataURL(pairingLink(connection, chosen), { width: 256, margin: 2, errorCorrectionLevel: 'M' }).then(setQr).catch(e => error(String(e))); }, [connection, chosen]);
  async function copy() { if (!connection) return; try { await navigator.clipboard.writeText(pairingLink(connection, chosen)); notify('Pairing link copied'); } catch { error('Copy is unavailable. Select and copy the pairing link below.'); } }
  return <><div className="page-heading"><div><h1>Your devices</h1><p>Two screens. One library. Connect once and start sharing.</p></div></div><div className="device-layout"><section className="pair-panel"><div className="device-illustration"><Smartphone size={40} strokeWidth={1.4}/><span/><Laptop size={58} strokeWidth={1.3}/></div>
    {desktop ? <><h2>Bring your phone along</h2><p>Open ColdDrop on Android, tap <strong>Scan QR code</strong>, and point your camera here.</p>{qr ? <img className="qr" src={qr} alt="Scan this QR code in ColdDrop on your phone to pair with this PC"/> : <p className="alert">Connect this PC to Wi-Fi to show a pairing code.</p>}{connection && chosen && <><label className="field-label">PC network address<select value={chosen} onChange={e => setAddress(e.target.value)}>{connection.addresses?.map(a => <option key={a} value={a}>{a}</option>)}</select></label><button className="secondary" onClick={copy}><Copy size={17}/>Copy pairing link</button><details><summary>Or copy the link manually</summary><textarea className="pair-link" readOnly value={pairingLink(connection, chosen)} aria-label="Pairing link" onFocus={e => e.target.select()}/></details></>}</> : <><h2>{connection ? 'Connected to your library' : 'Meet your PC'}</h2><p>Open ColdDrop on your Windows PC. Scan its QR code or paste the pairing link below.</p>{window.ColdDrop && <button className="primary wide" disabled={working} onClick={() => window.ColdDrop?.scan()}><ScanLine size={20}/>Scan QR code</button>}<div className="or-divider"><span>or use a link</span></div><form onSubmit={e => { e.preventDefault(); pair(input); }}><label className="field-label">Pairing link<textarea value={input} onChange={e => setInput(e.target.value)} placeholder="Paste the link from ColdDrop on your PC" autoCapitalize="none" autoCorrect="off" spellCheck={false} required/></label><button className="secondary wide" type="submit" disabled={working || !input.trim()}>{working ? <LoaderCircle size={18} className="spin"/> : <Link size={18}/>} {working ? 'Connecting…' : 'Connect to PC'}</button></form></>}
    </section><div className="device-details"><section><h2>Made for the same Wi-Fi</h2><p>Your PC stores the originals. Your phone streams previews and can save its own copies. Transfers use your local network.</p><div className="device-line"><Laptop size={22}/><div><strong>{desktop ? 'This Windows PC' : 'Your Windows PC'}</strong><small>{connection ? (desktop ? chosen : connection.base) : 'Not paired yet'}</small></div><span className={`status-dot ${online ? 'online' : ''}`}/></div><div className="device-line"><Smartphone size={22}/><div><strong>{desktop ? 'Android phone' : 'This phone'}</strong><small>{desktop ? 'Pair with the QR code' : connection ? 'Pairing saved on this device' : 'Ready to pair'}</small></div></div></section><section><h3>Keep the library available</h3><p>Keep your PC awake and ColdDrop running. Closing its window keeps it in the system tray. Use the tray menu to quit.</p><p>Allow ColdDrop through Windows Firewall on <strong>private networks</strong> when Windows asks. Guest Wi-Fi may block connections between devices.</p></section><section><h3>Your files stay yours</h3><p>No recompression, cloud account, or upload quota. Available PC storage and your Wi-Fi speed determine transfer capacity and time.</p><p className="security-note">Pair only devices you trust. Local transfers use HTTP on your private Wi-Fi; the pairing link grants access to the library.</p>{desktop && connection && <button className="text-button" onClick={() => invoke('open_library').catch(e => error(String(e)))}><FolderOpen size={17}/>Open storage folder</button>}{!desktop && connection && <button className="text-button danger" onClick={onDisconnect}>Disconnect this phone</button>}</section></div></div></>;
}

function TransferRow({ transfer: t }: { transfer: Transfer }) {
  const progress = Math.min(100, t.size > 0 ? t.sent / t.size * 100 : t.status === 'complete' ? 100 : 0);
  return <article className={`transfer-row ${t.status}`}><div className="transfer-icon">{t.status === 'complete' ? <Check size={22}/> : t.status === 'failed' ? <CircleAlert size={22}/> : t.status === 'downloading' ? <ArrowDownToLine size={22}/> : <ArrowUpFromLine size={22}/>}</div><div className="transfer-info"><h3>{t.name}</h3><div className="transfer-meta"><span>{t.status === 'complete' ? 'Complete' : t.status === 'failed' ? t.error || 'Transfer interrupted' : t.status === 'queued' ? 'Waiting to transfer' : `${t.status === 'downloading' ? 'Downloading' : 'Adding'} · ${bytes(t.sent)} of ${bytes(t.size)}`}</span>{!['failed', 'complete'].includes(t.status) && <strong>{Math.round(progress)}%</strong>}</div>{!['failed', 'complete'].includes(t.status) && <progress max="100" value={progress} aria-label={`Progress for ${t.name}`}/>} {t.status === 'failed' && <p className="retry-note">{window.ColdDrop ? 'Reconnect to your PC, then retry.' : 'Add this file again to retry the transfer.'}</p>}</div>{t.status === 'failed' && window.ColdDrop && <button className="secondary retry" onClick={() => window.ColdDrop?.retry(t.id)}><RefreshCw size={16}/>Retry</button>}</article>;
}

createRoot(document.getElementById('root')!).render(<App/>);
