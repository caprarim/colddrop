import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import QRCode from 'qrcode';
import { ArrowDownToLine, ArrowUpFromLine, ArrowLeft, ArrowRight, Check, CheckCheck, ChevronRight, CircleAlert, Copy, FileText, Film, FolderOpen, Grid2X2, Image as ImageIcon, Laptop, List, LoaderCircle, Plus, Search, Settings2, Smartphone, Upload, Wifi, WifiOff, X, ScanLine, Link, Play, RefreshCw, Music, Pencil, Folder, FolderPlus, FolderInput, FolderMinus, Trash2 } from 'lucide-react';
import { boot, browserUpload, bytes, Category, desktop, GalleryFile, Connection, kind, mediaUrl, pairingLink, parsePairing, request, Transfer, url } from './api';
import icon from './icon.png';
import './styles.css';

const filters = ['All files', 'Videos', 'Images', 'Documents'];
const icons = [Grid2X2, Film, ImageIcon, FileText];
const same = (a: GalleryFile, b: GalleryFile) => a.name === b.name && a.size === b.size && a.mime === b.mime && a.created === b.created && a.source === b.source && a.ready === b.ready && a.thumbnail === b.thumbnail && (a.category ?? null) === (b.category ?? null);
const jsonHeaders = { 'Content-Type': 'application/json' };
const message = (e: unknown) => String(e).replace(/^Error: /, '');
type SheetState = { kind: 'rename'; file: GalleryFile } | { kind: 'new'; file?: GalleryFile } | { kind: 'rename-category'; category: Category } | { kind: 'delete-category'; category: Category } | { kind: 'move'; file: GalleryFile };
function merge(prev: GalleryFile[], next: GalleryFile[]) {
  const old = new Map(prev.map(f => [f.id, f]));
  let unchanged = prev.length === next.length;
  const result = next.map((f, i) => { const o = old.get(f.id); const keep = o && same(o, f) ? o : f; if (keep !== prev[i]) unchanged = false; return keep; });
  return unchanged ? prev : result;
}
function App() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [files, setFiles] = useState<GalleryFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(false);
  const [view, setView] = useState('library');
  const [filter, setFilter] = useState('All files');
  const [query, setQuery] = useState('');
  const [list, setList] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const browsingQueue = useRef<Promise<unknown>>(Promise.resolve());
  const live = useRef<Connection | null>(null);
  const loading = useRef(false);
  const again = useRef(false);
  const saving = useRef(false);
  const report = useCallback((t: Transfer) => { setTransfers(items => [t, ...items.filter(x => x.id !== t.id)].slice(0, 100)); }, []);
  const refresh = useCallback(async () => {
    if (!live.current) return;
    if (loading.current) { again.current = true; return; }
    loading.current = true;
    try {
      do {
        again.current = false;
        const c: Connection | null = live.current; if (!c) break;
        try { const result = await request<{ files: GalleryFile[]; categories?: Category[] }>(c, '/api/files'); if (live.current !== c) continue; const next = result.categories ?? []; setFiles(prev => merge(prev, result.files)); setCategories(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next); setOnline(true); setError(''); }
        catch { if (live.current === c) setOnline(false); }
        setLoaded(true);
      } while (again.current);
    } finally { loading.current = false; }
  }, []);
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
    live.current = connection;
    if (!connection) return;
    setLoaded(false); again.current = true; refresh();
    const stream = new EventSource(url(connection, '/api/events'));
    stream.onmessage = () => { setOnline(true); refresh(); };
    stream.onerror = () => setOnline(false);
    const timer = setInterval(() => { if (stream.readyState !== EventSource.OPEN) refresh(); }, 15000);
    const resume = () => { if (!document.hidden) refresh(); };
    window.onColdDropResume = resume;
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', refresh);
    return () => { stream.close(); clearInterval(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', refresh); delete window.onColdDropResume; };
  }, [connection, refresh]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  const add = async () => {
    if (!connection || !online) { setView('devices'); return; }
    const into = view === 'library' ? folder?.id ?? null : null;
    try { if (desktop) await invoke('choose_files', { category: into }); else if (window.ColdDrop) { if (into && window.ColdDrop.pickFilesInto) window.ColdDrop.pickFilesInto(into); else window.ColdDrop.pickFiles(); } else picker.current?.click(); } catch (e) { setError(String(e)); }
  };
  const uploadFiles = (selected: FileList | File[]) => {
    if (!connection) return;
    const c = connection; const into = view === 'library' ? folder?.id ?? null : null;
    for (const file of Array.from(selected)) {
      browsingQueue.current = browsingQueue.current.then(() => browserUpload(c, file, report, into)).catch(e => setError(`${file.name}: ${String(e)}`));
    }
  };
  const download = useCallback(async (file: GalleryFile) => {
    const c = live.current;
    if (!c || saving.current) return;
    saving.current = true; setBusy(true);
    try {
      if (desktop) { const path = await invoke<string | null>('save_file', { id: file.id }); if (path) setNotice(`Saved ${file.name}`); }
      else if (window.ColdDrop) { window.ColdDrop.download(file.id, file.name, file.mime); }
      else { const a = document.createElement('a'); a.href = `${mediaUrl(c, file)}&download=true`; a.download = file.name; a.click(); }
    } catch (e) { setError(String(e)); } finally { saving.current = false; setBusy(false); }
  }, []);
  const connected = () => { const c = live.current; if (!c) throw new Error('Connect to your PC first'); return c; };
  const updateFile = useCallback(async (file: GalleryFile, change: { name?: string; category?: string }) => {
    const updated = await request<GalleryFile>(connected(), `/api/files/${file.id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(change) });
    setFiles(items => items.map(f => f.id === updated.id ? updated : f));
    return updated;
  }, []);
  const rename = useCallback(async (file: GalleryFile, name: string) => { const updated = await updateFile(file, { name }); setNotice(`Renamed to ${updated.name}`); }, [updateFile]);
  const move = useCallback(async (file: GalleryFile, target: Category | null) => { await updateFile(file, { category: target?.id ?? '' }); setNotice(target ? `Moved to ${target.name}` : 'Removed from its category'); }, [updateFile]);
  const createCategory = useCallback(async (name: string) => {
    const created = await request<Category>(connected(), '/api/categories', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name }) });
    setCategories(list => list.some(x => x.id === created.id) ? list : [...list, created]);
    return created;
  }, []);
  const renameCategory = useCallback(async (target: Category, name: string) => {
    const updated = await request<Category>(connected(), `/api/categories/${target.id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ name }) });
    setCategories(list => list.map(x => x.id === updated.id ? updated : x)); setNotice(`Renamed to ${updated.name}`);
  }, []);
  const deleteCategory = useCallback(async (target: Category) => {
    await request(connected(), `/api/categories/${target.id}`, { method: 'DELETE' });
    setCategories(list => list.filter(x => x.id !== target.id));
    setFiles(items => items.map(f => f.category === target.id ? { ...f, category: null } : f));
    setCategory(current => current === target.id ? null : current); setNotice(`Deleted ${target.name}`);
  }, []);
  const openRename = useCallback((file: GalleryFile) => setSheet({ kind: 'rename', file }), []);
  const closeSheet = useCallback(() => setSheet(null), []);
  const sorted = useMemo(() => [...categories].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })), [categories]);
  const folder = category ? categories.find(c => c.id === category) : undefined;
  const visible = useMemo(() => { const q = query.trim().toLowerCase(); return files.filter(f => (filter === 'All files' || kind(f) === filter) && (!folder || f.category === folder.id) && (!q || f.name.toLowerCase().includes(q))); }, [files, filter, query, folder]);
  const folderCounts = useMemo(() => { const m = new Map<string, number>(); for (const f of files) if (f.category && (filter === 'All files' || kind(f) === filter)) m.set(f.category, (m.get(f.category) || 0) + 1); return m; }, [files, filter]);
  const counts = useMemo(() => { const c: Record<string, number> = { 'All files': files.length, Videos: 0, Images: 0, Documents: 0 }; for (const f of files) c[kind(f)]++; return c; }, [files]);
  const stored = useMemo(() => files.reduce((sum, f) => f.ready ? sum + f.size : sum, 0), [files]);
  const viewable = useMemo(() => visible.filter(f => f.ready), [visible]);
  const groups = useMemo(() => {
    const result = new Map<string, GalleryFile[]>(); const today = new Date(); const todayText = today.toDateString();
    for (const file of visible) {
      const date = new Date(file.created);
      const title = date.toDateString() === todayText ? 'Today' : date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
      const items = result.get(title); if (items) items.push(file); else result.set(title, [file]);
    }
    return result;
  }, [visible]);
  const active = transfers.filter(t => ['uploading', 'queued', 'downloading'].includes(t.status));
  const preview = previewId ? files.find(f => f.id === previewId) : undefined;
  return <div className="app" onDragOver={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setDrag(true); }} onDrop={e => { e.preventDefault(); setDrag(false); if (online && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); }}>
    <input ref={picker} type="file" multiple hidden onChange={e => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ''; }} />
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setView('library'); setCategory(null); }}><img src={icon} alt=""/><span>ColdDrop<span className="brand-sub">Your shared space</span></span></a>
      <button className="primary sidebar-add" onClick={add}><Plus size={19}/> Add files</button>
      <div className="nav-label">Library</div>
      <nav aria-label="Library">{filters.map((f, i) => { const Icon = icons[i]; return <button key={f} className={`nav-item ${view === 'library' && filter === f ? 'selected' : ''}`} onClick={() => { setFilter(f); setView('library'); setCategory(null); }}><Icon size={19}/><span>{f}</span><span className="count">{counts[f]}</span></button>; })}</nav>
      <div className="nav-separator"/>
      <button className={`nav-item ${view === 'transfers' ? 'selected' : ''}`} onClick={() => setView('transfers')}><ArrowUpFromLine size={19}/><span>Transfers</span>{active.length > 0 && <span className="count">{active.length}</span>}</button>
      <button className={`nav-item ${view === 'devices' ? 'selected' : ''}`} onClick={() => setView('devices')}><Laptop size={19}/><span>Devices</span></button>
      <div className="sidebar-foot"><div className={`connection-status ${online ? 'connected' : ''}`}>{online ? <Wifi size={16}/> : <WifiOff size={16}/>}<span>{online ? 'Connected locally' : connection ? 'PC is offline' : 'Ready to connect'}</span></div><p>{bytes(stored)} in your library</p><small>Original quality. Your storage.</small></div>
    </aside>
    <main>
      <header className="topbar"><span className="mobile-brand"><img src={icon} alt=""/>ColdDrop</span><span className="breadcrumb">Your space <ChevronRight size={14}/> {view === 'library' ? filter : view === 'devices' ? 'Devices' : 'Transfers'}{view === 'library' && folder && <><ChevronRight size={14}/> {folder.name}</>}</span><button className="device-indicator" onClick={() => setView('devices')}><span className={`status-dot ${online ? 'online' : ''}`}/>{desktop ? 'This PC' : online ? 'PC connected' : 'Connect PC'}<Settings2 size={15}/></button></header>
      <div className="page">
        {error && <div className="alert" role="alert"><CircleAlert size={20}/><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={17}/></button></div>}
        {connection && !online && loaded && <div className="offline-banner"><WifiOff size={19}/><span>Open ColdDrop on your PC and connect both devices to the same Wi-Fi.</span><button onClick={refresh}>Reconnect</button></div>}
        {view === 'library' && <>
          <div className="page-heading"><div>{folder ? <><button className="back-link" onClick={() => setCategory(null)}><ArrowLeft size={15}/>{filter === 'All files' ? 'Your library' : filter}</button><h1 className="folder-title"><Folder size={26}/><span>{folder.name}</span></h1><p>Files you add here go straight into this category.</p></> : <><h1>{filter === 'All files' ? 'Your library' : filter}</h1><p>From your phone to your desk. Everything in one place.</p></>}</div><div className="heading-actions">{folder && <><button className="icon-button" onClick={() => setSheet({ kind: 'rename-category', category: folder })} aria-label={`Rename ${folder.name}`} title="Rename category"><Pencil size={18}/></button><button className="icon-button" onClick={() => setSheet({ kind: 'delete-category', category: folder })} aria-label={`Delete ${folder.name}`} title="Delete category"><Trash2 size={18}/></button></>}<button className="primary" onClick={add}><Plus size={19}/><span>{folder ? 'Add here' : 'Add files'}</span></button></div></div>
          <div className="toolbar"><label className="search"><Search size={18}/><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search your files" aria-label="Search files"/></label><span className="file-total">{visible.length} {visible.length === 1 ? 'file' : 'files'}</span><div className="view-toggle"><button aria-label="Grid view" aria-pressed={!list} className={!list ? 'active' : ''} onClick={() => setList(false)}><Grid2X2 size={18}/></button><button aria-label="List view" aria-pressed={list} className={list ? 'active' : ''} onClick={() => setList(true)}><List size={19}/></button></div></div>
          <div className="mobile-filters">{filters.map(f => <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{f}</button>)}</div>
          {connection && !folder && <section className="categories" aria-label="Categories"><div className="categories-head"><h2>Categories</h2><button className="text-button" onClick={() => setSheet({ kind: 'new' })}><FolderPlus size={17}/>New category</button></div>{sorted.length > 0 ? <div className="category-row">{sorted.map(c => { const n = folderCounts.get(c.id) || 0; return <button key={c.id} className="category-card" onClick={() => setCategory(c.id)}><Folder size={20}/><span><strong>{c.name}</strong><small>{n} {n === 1 ? 'file' : 'files'}</small></span></button>; })}</div> : <p className="categories-empty">Make a category like hooks, then put videos, images, or any other file inside it.</p>}</section>}
          {active.length > 0 && <button className="transfer-banner" onClick={() => setView('transfers')}><Upload size={20}/><span><strong>{active.length} {active.length === 1 ? 'transfer' : 'transfers'} in progress</strong><small>{active[0].name}</small></span><ChevronRight size={18}/></button>}
          {!loaded ? <div className="gallery skeletons" aria-label="Loading gallery">{Array.from({ length: 8 }, (_, i) => <div className="skeleton" key={i}/>)}</div> : visible.length === 0 ? <div className="empty"><div className="empty-art"><FolderOpen size={46} strokeWidth={1.2}/><span><Plus size={16}/></span></div><h2>{query ? 'No matching files' : folder ? `Nothing in ${folder.name} yet` : filter === 'All files' ? 'Big files. Small effort.' : `No ${filter.toLowerCase()} yet`}</h2><p>{query ? 'Try a different file name.' : folder ? 'Add files here, or open any file and tap the folder button to move it in.' : 'Add videos, photos, presentations, or anything else. They’ll appear here on both devices.'}</p>{!query && <button className="primary" onClick={add}><Plus size={18}/>{online ? (folder ? 'Add files here' : 'Add your first files') : 'Connect your devices'}</button>}<div className="empty-formats">MP4 <span>·</span> MOV <span>·</span> JPG <span>·</span> PPTX <span>·</span> and more</div></div> : Array.from(groups).map(([date, items]) => <section className="date-group" key={date}><div className="group-heading"><h2>{date}</h2><span>{items.length} {items.length === 1 ? 'file' : 'files'}</span></div><div className={list ? 'file-list' : 'gallery'}>{items.map(f => <FileTile key={f.id} file={f} connection={connection!} list={list} onOpen={setPreviewId} onDownload={download} onRename={openRename}/>)}</div></section>)}
          {files.length > 0 && <div className="library-footer"><CheckCheck size={15}/> {online ? 'Live updates are on' : 'Waiting for your PC'}<span>Files stay in their original quality</span></div>}
        </>}
        {view === 'devices' && <Devices connection={connection} online={online} onConnect={c => { setConnection(c); setFiles([]); setView('library'); }} onDisconnect={() => { window.ColdDrop?.disconnect(); localStorage.removeItem('colddrop-connection'); setConnection(null); setFiles([]); setOnline(false); }} notify={setNotice} error={setError}/>}
        {view === 'transfers' && <><div className="page-heading"><div><h1>Transfers</h1><p>Keep moving. Your files travel in the background.</p></div><button className="primary" onClick={add}><Plus size={19}/>Add files</button></div>{transfers.length === 0 ? <div className="empty"><div className="empty-art"><ArrowUpFromLine size={42} strokeWidth={1.3}/></div><h2>No transfers yet</h2><p>Files you add or download will appear here with their progress.</p></div> : <div className="transfers">{transfers.map(t => <TransferRow key={t.id} transfer={t}/>)}</div>}</>}
      </div>
    </main>
    <nav className="bottom-nav" aria-label="Main navigation"><button className={view === 'library' ? 'selected' : ''} onClick={() => setView('library')}><Grid2X2 size={21}/>Library</button><button className={view === 'transfers' ? 'selected' : ''} onClick={() => setView('transfers')}><ArrowUpFromLine size={21}/>Transfers{active.length > 0 && <span className="nav-badge">{active.length}</span>}</button><button className={view === 'devices' ? 'selected' : ''} onClick={() => setView('devices')}><Laptop size={21}/>Devices</button></nav>
    {preview && connection && <Preview file={preview} files={viewable} connection={connection} busy={busy} onClose={() => setPreviewId(null)} onSelect={f => setPreviewId(f.id)} onDownload={() => download(preview)} onRename={name => rename(preview, name)} folder={preview.category ? categories.find(c => c.id === preview.category)?.name : undefined} onMove={() => setSheet({ kind: 'move', file: preview })}/>}
    {sheet?.kind === 'rename' && <NameSheet title="Rename file" label="File name" initial={sheet.file.name} action="Save" stem onClose={closeSheet} onSubmit={name => rename(sheet.file, name)}/>}
    {sheet?.kind === 'new' && <NameSheet title="New category" label="Category name" initial="" placeholder="hooks" action="Create" onClose={closeSheet} onSubmit={async name => { const created = await createCategory(name); if (sheet.file) await move(sheet.file, created); else setNotice(`Created ${created.name}`); }}/>}
    {sheet?.kind === 'rename-category' && <NameSheet title="Rename category" label="Category name" initial={sheet.category.name} action="Save" onClose={closeSheet} onSubmit={name => renameCategory(sheet.category, name)}/>}
    {sheet?.kind === 'delete-category' && <ConfirmSheet title={`Delete ${sheet.category.name}?`} text="Only the category goes away. Every file inside stays in your library." action="Delete category" onClose={closeSheet} onConfirm={() => deleteCategory(sheet.category)}/>}
    {sheet?.kind === 'move' && <MoveSheet file={sheet.file} categories={sorted} onClose={closeSheet} onMove={target => move(sheet.file, target)} onNew={() => setSheet({ kind: 'new', file: sheet.file })}/>}
    {notice && <div className="toast" role="status"><Check size={18}/>{notice}</div>}
    {drag && <div className="drop-overlay" onDragLeave={() => setDrag(false)} onDragOver={e => e.preventDefault()}><Upload size={52}/><h2>Drop into your library</h2><p>Original files. Ready on both devices.</p></div>}
  </div>;
}

const FileTile = memo(function FileTile({ file, connection, list, onOpen, onDownload, onRename }: { file: GalleryFile; connection: Connection; list: boolean; onOpen(id: string): void; onDownload(file: GalleryFile): void; onRename(file: GalleryFile): void }) {
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
    <button className={`file-open ${!file.ready ? 'pending' : ''}`} onClick={() => onOpen(file.id)} aria-label={`Preview ${file.name}`}>
      <div className={`thumbnail type-${type.toLowerCase()}`}>
        {file.ready && seen && !failed && (file.thumbnail ? <img loading="lazy" src={url(connection, `/api/files/${file.id}/thumbnail`)} alt="" onError={() => setFailed(true)}/> : type === 'Images' ? <img loading="lazy" crossOrigin="anonymous" src={mediaUrl(connection, file)} alt="" onLoad={e => thumbnail(e.currentTarget)} onError={() => setFailed(true)}/> : type === 'Videos' ? <video muted playsInline preload="metadata" crossOrigin="anonymous" src={`${mediaUrl(connection, file)}#t=0.1`} onLoadedData={e => thumbnail(e.currentTarget)} onError={() => setFailed(true)}/> : null)}
        {(!file.ready || failed || (!file.thumbnail && type === 'Documents')) && <div className="file-placeholder"><Icon size={list ? 25 : 40} strokeWidth={1.35}/>{!list && <span>{file.name.split('.').pop()?.slice(0, 8).toUpperCase()}</span>}</div>}
        {!list && type === 'Videos' && file.ready && <span className="play-badge"><Play size={12} fill="currentColor"/>Video</span>}
        {!file.ready && <span className="pending-label">Transferring</span>}
      </div>
      <div className="file-info"><h3 title={file.name}>{file.name}</h3><div><span>{bytes(file.size)}</span><span className="file-dot">·</span><span>{file.source === 'PC' ? <Laptop size={12}/> : <Smartphone size={12}/>} {file.source}</span></div></div>
    </button>
    <div className="file-actions"><button className="icon-button" onClick={() => onRename(file)} aria-label={`Rename ${file.name}`} title="Rename"><Pencil size={15}/></button><button className="icon-button" onClick={() => onDownload(file)} disabled={!file.ready} aria-label={`Download ${file.name}`} title="Download"><ArrowDownToLine size={17}/></button></div>
  </article>;
});

function Preview({ file, files, connection, busy, folder, onClose, onSelect, onDownload, onRename, onMove }: { file: GalleryFile; files: GalleryFile[]; connection: Connection; busy: boolean; folder?: string; onClose(): void; onSelect(file: GalleryFile): void; onDownload(): void; onRename(name: string): Promise<void>; onMove(): void }) {
  const dialog = useRef<HTMLDialogElement>(null); const [failed, setFailed] = useState(false); const [zoom, setZoom] = useState(false); const touch = useRef<number | null>(null);
  const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(''); const [renaming, setRenaming] = useState(false); const [problem, setProblem] = useState('');
  const index = files.findIndex(f => f.id === file.id); const type = kind(file);
  const step = (direction: number) => { const next = files[index + direction]; if (next) onSelect(next); };
  const startRename = () => { setDraft(file.name); setProblem(''); setEditing(true); };
  const saveRename = async () => {
    const name = draft.trim();
    if (!name) { setProblem('Type a name first'); return; }
    if (name === file.name) { setEditing(false); return; }
    setRenaming(true); setProblem('');
    try { await onRename(name); setEditing(false); } catch (e) { setProblem(message(e)); } finally { setRenaming(false); }
  };
  useEffect(() => { const el = dialog.current; el?.showModal(); return () => el?.close(); }, []);
  useEffect(() => { setFailed(false); setZoom(false); setEditing(false); }, [file.id]);
  return <dialog className="preview" ref={dialog} onCancel={e => { e.preventDefault(); if (editing) setEditing(false); else onClose(); }} onKeyDown={e => { if (e.target instanceof HTMLVideoElement || e.target instanceof HTMLAudioElement || e.target instanceof HTMLInputElement) return; if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); if (e.key === 'F2' && !editing) { e.preventDefault(); startRename(); } }}>
    <header className="preview-header"><button className="icon-button" onClick={onClose} aria-label="Close preview"><X size={22}/></button>{editing ? <form className="rename-form" onSubmit={e => { e.preventDefault(); saveRename(); }}><input value={draft} onChange={e => setDraft(e.target.value)} aria-label="File name" maxLength={240} disabled={renaming} autoFocus spellCheck={false} autoCapitalize="none" autoCorrect="off" enterKeyHint="done" onFocus={e => { const dot = e.target.value.lastIndexOf('.'); e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length); }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); } }}/><p className={problem ? 'rename-problem' : ''}>{problem || 'Press Enter to save'}</p></form> : <div><h2>{file.name}</h2><p>{bytes(file.size)} · From {file.source}{folder ? ` · In ${folder}` : ''} · {new Date(file.created).toLocaleDateString()}</p></div>}{editing ? <><button className="icon-button" onClick={saveRename} disabled={renaming} aria-label="Save name">{renaming ? <LoaderCircle className="spin" size={19}/> : <Check size={20}/>}</button><button className="icon-button" onClick={() => setEditing(false)} disabled={renaming} aria-label="Cancel rename"><X size={19}/></button></> : <><button className="icon-button" onClick={startRename} aria-label={`Rename ${file.name}`} title="Rename"><Pencil size={18}/></button><button className="icon-button" onClick={onMove} aria-label="Move to category" title="Move to category"><FolderInput size={19}/></button></>}<button className="primary" disabled={!file.ready || busy} onClick={onDownload}>{busy ? <LoaderCircle className="spin" size={18}/> : <ArrowDownToLine size={18}/>}<span>{busy ? 'Saving…' : 'Download'}</span></button></header>
    <div className={`preview-stage ${zoom ? 'zoomed' : ''}`} onTouchStart={e => touch.current = e.touches.length === 1 ? e.touches[0].clientX : null} onTouchEnd={e => { if (type === 'Images' && !zoom && touch.current !== null && Math.abs(e.changedTouches[0].clientX - touch.current) > 70) step(e.changedTouches[0].clientX < touch.current ? 1 : -1); touch.current = null; }}>
      {!file.ready ? <div className="preview-message"><Upload size={48}/><h2>This file is still transferring</h2><p>Close this preview and open it when the transfer finishes.</p></div> : failed ? <div className="preview-message"><CircleAlert size={44}/><h2>Preview unavailable</h2><p>This device can’t display this format, or your PC is offline. Download the original to open it in another app.</p><button className="primary" onClick={onDownload}>Download original</button></div> : type === 'Images' ? <img key={file.id} src={mediaUrl(connection, file)} alt={file.name} onError={() => setFailed(true)} onClick={() => setZoom(!zoom)}/> : type === 'Videos' ? <video key={file.id} controls autoPlay playsInline preload="metadata" src={mediaUrl(connection, file)} onError={() => setFailed(true)}/> : file.mime.startsWith('audio/') ? <div className="preview-message"><Music size={50}/><audio key={file.id} controls src={mediaUrl(connection, file)} onError={() => setFailed(true)}/></div> : <div className="preview-message"><FileText size={56} strokeWidth={1.2}/><h2>{file.name.split('.').pop()?.toUpperCase()} document</h2><p>Save this file to open it in PowerPoint, a PDF reader, or another app.</p><button className="primary" onClick={onDownload}><ArrowDownToLine size={18}/>Download file</button></div>}
    </div>
    {file.ready && <footer className="preview-footer"><button className="icon-button" aria-label="Previous file" disabled={index <= 0} onClick={() => step(-1)}><ArrowLeft size={21}/></button><span>{index + 1} / {files.length}{type === 'Images' && <small>Tap image to {zoom ? 'fit' : 'zoom'}</small>}</span><button className="icon-button" aria-label="Next file" disabled={index >= files.length - 1} onClick={() => step(1)}><ArrowRight size={21}/></button></footer>}
  </dialog>;
}

function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; el?.showModal(); el?.querySelector<HTMLElement>('[data-autofocus]')?.focus(); return () => el?.close(); }, []);
  return <dialog className="sheet" ref={ref} onCancel={e => { e.preventDefault(); onClose(); }} onMouseDown={e => { if (e.target === ref.current) onClose(); }}><div className="sheet-body"><header className="sheet-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19}/></button></header>{children}</div></dialog>;
}

function NameSheet({ title, label, initial, placeholder, action, stem, onClose, onSubmit }: { title: string; label: string; initial: string; placeholder?: string; action: string; stem?: boolean; onClose(): void; onSubmit(name: string): Promise<unknown> }) {
  const [value, setValue] = useState(initial); const [working, setWorking] = useState(false); const [problem, setProblem] = useState('');
  const submit = async () => {
    const name = value.trim();
    if (!name) { setProblem('Type a name first'); return; }
    if (name === initial) { onClose(); return; }
    setWorking(true); setProblem('');
    try { await onSubmit(name); onClose(); } catch (e) { setProblem(message(e)); setWorking(false); }
  };
  return <Sheet title={title} onClose={onClose}><form onSubmit={e => { e.preventDefault(); submit(); }}><label className="field-label">{label}<input className="sheet-input" data-autofocus value={value} onChange={e => setValue(e.target.value)} placeholder={placeholder} maxLength={240} disabled={working} spellCheck={false} autoCapitalize="none" autoCorrect="off" enterKeyHint="done" onFocus={e => { if (!stem) return; const dot = e.target.value.lastIndexOf('.'); e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length); }}/></label><p className="sheet-problem" role="alert">{problem}</p><div className="sheet-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={working}>{working && <LoaderCircle className="spin" size={17}/>}{action}</button></div></form></Sheet>;
}

function ConfirmSheet({ title, text, action, onClose, onConfirm }: { title: string; text: string; action: string; onClose(): void; onConfirm(): Promise<unknown> }) {
  const [working, setWorking] = useState(false); const [problem, setProblem] = useState('');
  const confirm = async () => { setWorking(true); setProblem(''); try { await onConfirm(); onClose(); } catch (e) { setProblem(message(e)); setWorking(false); } };
  return <Sheet title={title} onClose={onClose}><p className="sheet-text">{text}</p><p className="sheet-problem" role="alert">{problem}</p><div className="sheet-actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary danger-fill" data-autofocus disabled={working} onClick={confirm}>{working && <LoaderCircle className="spin" size={17}/>}{action}</button></div></Sheet>;
}

function MoveSheet({ file, categories, onClose, onMove, onNew }: { file: GalleryFile; categories: Category[]; onClose(): void; onMove(target: Category | null): Promise<unknown>; onNew(): void }) {
  const [working, setWorking] = useState<string | null>(null); const [problem, setProblem] = useState('');
  const current = file.category ?? null;
  const choose = async (target: Category | null) => {
    if ((target?.id ?? null) === current) { onClose(); return; }
    setWorking(target?.id ?? ''); setProblem('');
    try { await onMove(target); onClose(); } catch (e) { setProblem(message(e)); setWorking(null); }
  };
  return <Sheet title="Move to category" onClose={onClose}><p className="sheet-text">Choose where <strong>{file.name}</strong> belongs.</p>{categories.length > 0 ? <div className="move-list">{categories.map(c => <button key={c.id} className={`move-option ${current === c.id ? 'current' : ''}`} disabled={working !== null} onClick={() => choose(c)}>{working === c.id ? <LoaderCircle className="spin" size={19}/> : <Folder size={19}/>}<span>{c.name}</span>{current === c.id && <Check size={17}/>}</button>)}{current && <button className="move-option" disabled={working !== null} onClick={() => choose(null)}>{working === '' ? <LoaderCircle className="spin" size={19}/> : <FolderMinus size={19}/>}<span>Remove from category</span></button>}</div> : <p className="categories-empty sheet-empty">No categories yet. Make one and this file goes straight in.</p>}<p className="sheet-problem" role="alert">{problem}</p><div className="sheet-actions"><button className="secondary" data-autofocus onClick={onNew} disabled={working !== null}><FolderPlus size={17}/>New category</button></div></Sheet>;
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
