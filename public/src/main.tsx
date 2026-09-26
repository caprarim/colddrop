import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import QRCode from 'qrcode';
import { ArrowDownToLine, ArrowUpFromLine, ArrowLeft, ArrowRight, Check, CheckCheck, ChevronRight, CircleAlert, CircleCheck, Copy, EllipsisVertical, Eye, FileText, Film, FolderOpen, Grid2X2, Image as ImageIcon, Laptop, List, ListChecks, LoaderCircle, Plus, Search, Settings2, Smartphone, Upload, Wifi, WifiOff, X, ScanLine, Link, Play, RefreshCw, Music, Pencil, Folder, FolderPen, FolderPlus, FolderInput, FolderMinus, Trash2, Undo2 } from 'lucide-react';
import { boot, browserUpload, bytes, Category, deleteCategory, deleteFiles, desktop, GalleryFile, Connection, kind, pairingLink, parsePairing, phone, request, sources, Transfer } from './api';
import icon from './icon.png';
import './styles.css';

document.documentElement.classList.add(phone ? 'is-phone' : 'is-desk');

type View = 'library' | 'transfers' | 'devices';
type SheetState = { kind: 'rename'; file: GalleryFile } | { kind: 'new'; files?: GalleryFile[] } | { kind: 'rename-category'; category: Category } | { kind: 'delete-category'; category: Category } | { kind: 'move'; files: GalleryFile[] } | { kind: 'file'; file: GalleryFile } | { kind: 'category'; category: Category };
type Toast = { id: number; text: string; undo?: () => void };
type Actions = { open(id: string): void; toggle(id: string, range: boolean): void; hold(id: string): void; download(file: GalleryFile): void; rename(file: GalleryFile): void; remove(file: GalleryFile): void; more(file: GalleryFile): void };

const views: View[] = ['library', 'transfers', 'devices'];
const filters = ['All files', 'Videos', 'Images', 'Documents'];
const chips: Record<string, string> = { 'All files': 'All', Videos: 'Videos', Images: 'Images', Documents: 'Documents' };
const icons = [Grid2X2, Film, ImageIcon, FileText];
const none: ReadonlySet<string> = new Set();
const same = (a: GalleryFile, b: GalleryFile) => a.name === b.name && a.size === b.size && a.mime === b.mime && a.created === b.created && a.source === b.source && a.ready === b.ready && a.thumbnail === b.thumbnail && (a.category ?? null) === (b.category ?? null);
const jsonHeaders = { 'Content-Type': 'application/json' };
const message = (e: unknown) => String(e).replace(/^Error: /, '');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const haptic = () => { try { window.ColdDrop?.haptic?.(); } catch { return; } };
const typing = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
function merge(prev: GalleryFile[], next: GalleryFile[]) {
  const old = new Map(prev.map(f => [f.id, f]));
  let unchanged = prev.length === next.length;
  const result = next.map((f, i) => { const o = old.get(f.id); const keep = o && same(o, f) ? o : f; if (keep !== prev[i]) unchanged = false; return keep; });
  return unchanged ? prev : result;
}
function without(set: ReadonlySet<string>, ids: Iterable<string>) { const next = new Set(set); for (const id of ids) next.delete(id); return next; }

function usePress(onTap: (e: React.MouseEvent) => void, onHold: () => void) {
  const state = useRef<{ timer: number; x: number; y: number; held: boolean } | null>(null);
  const tap = useRef(onTap); const hold = useRef(onHold); tap.current = onTap; hold.current = onHold;
  return useMemo(() => {
    const cancel = () => { const s = state.current; if (s && !s.held) { clearTimeout(s.timer); state.current = null; } };
    return {
      onPointerDown(e: React.PointerEvent) {
        if (state.current) clearTimeout(state.current.timer);
        if (e.pointerType === 'mouse') { state.current = null; return; }
        const s = { timer: 0, x: e.clientX, y: e.clientY, held: false };
        s.timer = window.setTimeout(() => { s.held = true; hold.current(); }, 420);
        state.current = s;
      },
      onPointerMove(e: React.PointerEvent) { const s = state.current; if (s && !s.held && Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) > 12) cancel(); },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onContextMenu(e: React.MouseEvent) { e.preventDefault(); const s = state.current; if (s?.held) return; if (s) { clearTimeout(s.timer); s.held = true; } hold.current(); },
      onClick(e: React.MouseEvent) { const s = state.current; state.current = null; if (s?.held) return; tap.current(e); },
    };
  }, []);
}

const observers = new Map<Element | null, IntersectionObserver>();
const watchers = new WeakMap<Element, () => void>();
function watch(el: Element, root: Element | null, seen: () => void) {
  let observer = observers.get(root);
  if (!observer) {
    const created = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { const fn = watchers.get(entry.target); watchers.delete(entry.target); created.unobserve(entry.target); fn?.(); } }, { root, rootMargin: '600px 0px' });
    observers.set(root, created); observer = created;
  }
  watchers.set(el, seen); observer.observe(el);
  return () => { watchers.delete(el); observer.unobserve(el); };
}

function App() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [files, setFiles] = useState<GalleryFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(false);
  const [view, setView] = useState<View>('library');
  const [filter, setFilter] = useState('All files');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [list, setList] = useState(() => { try { return localStorage.getItem('colddrop-list') === '1'; } catch { return false; } });
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(none);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(none);
  const picker = useRef<HTMLInputElement>(null);
  const browsingQueue = useRef<Promise<unknown>>(Promise.resolve());
  const live = useRef<Connection | null>(null);
  const loading = useRef(false);
  const again = useRef(false);
  const saving = useRef(false);
  const pending = useRef<{ ids: Set<string>; timer: number } | null>(null);
  const tombstones = useRef(new Map<string, number>());
  const scrollers = useRef<Partial<Record<View, HTMLElement | null>>>({});
  const offsets = useRef<Partial<Record<View, number>>>({});
  const bar = useRef<HTMLElement>(null);
  const order = useRef<string[]>([]);
  const anchor = useRef<string | null>(null);
  const toastId = useRef(0);
  const viewRef = useRef(view); viewRef.current = view;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const viewableRef = useRef<GalleryFile[]>([]);
  const notify = useCallback((text: string, undo?: () => void) => setToast({ id: ++toastId.current, text, undo }), []);
  const report = useCallback((t: Transfer) => { setTransfers(items => [t, ...items.filter(x => x.id !== t.id)].slice(0, 100)); }, []);
  const refresh = useCallback(async () => {
    if (!live.current) return;
    if (loading.current) { again.current = true; return; }
    loading.current = true;
    try {
      do {
        again.current = false;
        const c: Connection | null = live.current; if (!c) break;
        try {
          const result = await request<{ files: GalleryFile[]; categories?: Category[] }>(c, '/api/files'); if (live.current !== c) continue;
          const now = Date.now(); const gone = tombstones.current; for (const [id, until] of gone) if (until < now) gone.delete(id);
          const incoming = gone.size ? result.files.filter(f => !gone.has(f.id)) : result.files;
          const next = result.categories ?? [];
          setFiles(prev => merge(prev, incoming)); setCategories(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next); setOnline(true); setError('');
        } catch { if (live.current === c) setOnline(false); }
        setLoaded(true);
      } while (again.current);
    } finally { loading.current = false; }
  }, []);
  useEffect(() => {
    boot().then(c => { setConnection(c); if (!c) { setLoaded(true); setView('devices'); } }).catch(e => { setError(String(e)); setLoaded(true); });
    window.onColdDropTransfer = report;
    window.onColdDropError = setError;
    if (window.ColdDrop) { try { setTransfers(JSON.parse(window.ColdDrop.transfers())); } catch { setTransfers([]); } }
    let cleanup: (() => void) | undefined;
    if (desktop) listen<Transfer>('transfer', e => report(e.payload)).then(fn => cleanup = fn);
    return () => { cleanup?.(); delete window.onColdDropTransfer; delete window.onColdDropError; };
  }, [report]);
  useEffect(() => {
    live.current = connection;
    if (!connection) return;
    setLoaded(false); again.current = true; refresh();
    const stream = new EventSource(`${connection.base}/api/events?key=${encodeURIComponent(connection.key)}`);
    stream.onmessage = () => { setOnline(true); refresh(); };
    stream.onerror = () => setOnline(false);
    const timer = setInterval(() => { if (stream.readyState !== EventSource.OPEN) refresh(); }, 15000);
    const resume = () => { if (!document.hidden) refresh(); };
    window.onColdDropResume = resume;
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', refresh);
    return () => { stream.close(); clearInterval(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', refresh); delete window.onColdDropResume; };
  }, [connection, refresh]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(current => current?.id === toast.id ? null : current), toast.undo ? 5000 : 3200); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { try { localStorage.setItem('colddrop-list', list ? '1' : '0'); } catch { return; } }, [list]);

  const connected = () => { const c = live.current; if (!c) throw new Error('Connect to your PC first'); return c; };
  const commit = useCallback(async () => {
    const batch = pending.current; if (!batch) return;
    pending.current = null; clearTimeout(batch.timer);
    setToast(current => current?.undo ? null : current);
    const ids = [...batch.ids];
    try {
      const c = live.current; if (!c) throw new Error('Connect to your PC first');
      await deleteFiles(c, ids);
      const until = Date.now() + 15000; for (const id of ids) tombstones.current.set(id, until);
      setFiles(items => items.filter(f => !batch.ids.has(f.id)));
    } catch (e) { setError(`Could not delete ${ids.length === 1 ? 'that file' : plural(ids.length, 'file')}. ${message(e)}`); }
    finally { setRemoving(current => without(current, ids)); }
  }, []);
  const undo = useCallback(() => {
    const batch = pending.current; if (!batch) return;
    pending.current = null; clearTimeout(batch.timer);
    setRemoving(current => without(current, batch.ids));
    notify(`Restored ${plural(batch.ids.size, 'file')}`);
  }, [notify]);
  const removeFiles = useCallback((targets: GalleryFile[]) => {
    if (!targets.length) return;
    const ids = new Set(targets.map(f => f.id));
    setPreviewId(current => {
      if (!current || !ids.has(current)) return current;
      const items = viewableRef.current; const i = items.findIndex(f => f.id === current);
      return items.slice(i + 1).find(f => !ids.has(f.id))?.id ?? items.slice(0, Math.max(i, 0)).reverse().find(f => !ids.has(f.id))?.id ?? null;
    });
    const batch = pending.current ?? { ids: new Set<string>(), timer: 0 };
    clearTimeout(batch.timer);
    for (const id of ids) batch.ids.add(id);
    batch.timer = window.setTimeout(commit, 5000);
    pending.current = batch;
    setRemoving(current => { const next = new Set(current); for (const id of ids) next.add(id); return next; });
    setSelected(none);
    notify(batch.ids.size === 1 && targets.length === 1 ? `Deleted ${targets[0].name}` : `Deleted ${plural(batch.ids.size, 'file')}`, undo);
  }, [commit, notify, undo]);
  useEffect(() => {
    const flush = () => { if (document.hidden) commit(); };
    document.addEventListener('visibilitychange', flush); window.addEventListener('pagehide', commit);
    return () => { document.removeEventListener('visibilitychange', flush); window.removeEventListener('pagehide', commit); };
  }, [commit]);

  const add = async () => {
    if (!connection || !online) { go('devices'); return; }
    const into = view === 'library' ? folder?.id ?? null : null;
    try { if (desktop) await invoke('choose_files', { category: into }); else if (window.ColdDrop) { if (into && window.ColdDrop.pickFilesInto) window.ColdDrop.pickFilesInto(into); else window.ColdDrop.pickFiles(); } else picker.current?.click(); } catch (e) { setError(String(e)); }
  };
  const uploadFiles = (chosen: FileList | File[]) => {
    if (!connection) return;
    const c = connection; const into = view === 'library' ? folder?.id ?? null : null;
    for (const file of Array.from(chosen)) {
      browsingQueue.current = browsingQueue.current.then(() => browserUpload(c, file, report, into)).catch(e => setError(`${file.name}: ${String(e)}`));
    }
  };
  const download = useCallback(async (file: GalleryFile) => {
    const c = live.current;
    if (!c || saving.current) return;
    saving.current = true; setBusy(true);
    try {
      if (desktop) { const path = await invoke<string | null>('save_file', { id: file.id }); if (path) notify(`Saved ${file.name}`); }
      else if (window.ColdDrop) { window.ColdDrop.download(file.id, file.name, file.mime); }
      else { const a = document.createElement('a'); a.href = `${sources(c, file, 'content').at(-1)}&download=true`; a.download = file.name; a.click(); }
    } catch (e) { setError(String(e)); } finally { saving.current = false; setBusy(false); }
  }, [notify]);
  const updateFile = useCallback(async (file: GalleryFile, change: { name?: string; category?: string }) => {
    const updated = await request<GalleryFile>(connected(), `/api/files/${file.id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(change) });
    setFiles(items => items.map(f => f.id === updated.id ? updated : f));
    return updated;
  }, []);
  const rename = useCallback(async (file: GalleryFile, name: string) => { const updated = await updateFile(file, { name }); notify(`Renamed to ${updated.name}`); }, [updateFile, notify]);
  const moveFiles = useCallback(async (targets: GalleryFile[], to: Category | null) => {
    const c = connected(); const body = JSON.stringify({ category: to?.id ?? '' });
    const results = await Promise.allSettled(targets.map(f => request<GalleryFile>(c, `/api/files/${f.id}`, { method: 'PATCH', headers: jsonHeaders, body })));
    const updated = new Map<string, GalleryFile>(); for (const r of results) if (r.status === 'fulfilled') updated.set(r.value.id, r.value);
    if (!updated.size) { const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined; throw failure?.reason ?? new Error('Could not move these files'); }
    setFiles(items => items.map(f => updated.get(f.id) ?? f)); setSelected(none);
    const moved = targets.length === 1 ? targets[0].name : plural(updated.size, 'file');
    notify(to ? `Moved ${moved} to ${to.name}` : `Removed ${moved} from its category`);
  }, [notify]);
  const createCategory = useCallback(async (name: string) => {
    const created = await request<Category>(connected(), '/api/categories', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name }) });
    setCategories(items => items.some(x => x.id === created.id) ? items : [...items, created]);
    return created;
  }, []);
  const renameCategory = useCallback(async (target: Category, name: string) => {
    const updated = await request<Category>(connected(), `/api/categories/${target.id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ name }) });
    setCategories(items => items.map(x => x.id === updated.id ? updated : x)); notify(`Renamed to ${updated.name}`);
  }, [notify]);
  const removeCategory = useCallback(async (target: Category, withFiles: boolean) => {
    await deleteCategory(connected(), target.id, withFiles);
    setCategories(items => items.filter(x => x.id !== target.id));
    setFiles(items => withFiles ? items.filter(f => f.category !== target.id) : items.map(f => f.category === target.id ? { ...f, category: null } : f));
    setCategory(current => current === target.id ? null : current);
    notify(withFiles ? `Deleted ${target.name} and its files` : `Deleted ${target.name}`);
  }, [notify]);
  const clearFinished = () => {
    if (window.ColdDrop?.clearTransfers) { try { setTransfers(JSON.parse(window.ColdDrop.clearTransfers())); } catch { setTransfers(items => items.filter(t => !['complete', 'failed'].includes(t.status))); } }
    else setTransfers(items => items.filter(t => !['complete', 'failed'].includes(t.status)));
  };
  const toggle = useCallback((id: string, range: boolean) => {
    const from = range ? anchor.current : null; anchor.current = id;
    setSelected(current => {
      const next = new Set(current); const ids = order.current; const a = from ? ids.indexOf(from) : -1; const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]); }
      else if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const handlers = useRef<Actions | null>(null);
  handlers.current = {
    open: id => setPreviewId(id),
    toggle,
    hold: id => { if (!selectedRef.current.size) haptic(); toggle(id, false); },
    download,
    rename: file => setSheet({ kind: 'rename', file }),
    remove: file => removeFiles([file]),
    more: file => setSheet({ kind: 'file', file }),
  };
  const actions = useMemo<Actions>(() => ({
    open: id => handlers.current?.open(id), toggle: (id, range) => handlers.current?.toggle(id, range), hold: id => handlers.current?.hold(id),
    download: f => handlers.current?.download(f), rename: f => handlers.current?.rename(f), remove: f => handlers.current?.remove(f), more: f => handlers.current?.more(f),
  }), []);
  const go = useCallback((next: View) => {
    const current = viewRef.current;
    if (current === next) { scrollers.current[next]?.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    offsets.current[current] = scrollers.current[current]?.scrollTop ?? 0;
    setView(next); setSelected(none); setSearching(false);
  }, []);
  const refs = useMemo(() => Object.fromEntries(views.map(v => [v, (el: HTMLElement | null) => { scrollers.current[v] = el; }])) as Record<View, (el: HTMLElement | null) => void>, []);
  const raise = (el?: HTMLElement | null) => { bar.current?.classList.toggle('raised', !!el && el.scrollTop > 2); };
  useLayoutEffect(() => { const el = scrollers.current[view]; if (el) el.scrollTop = offsets.current[view] ?? 0; raise(el); }, [view]);
  useLayoutEffect(() => { const el = scrollers.current.library; if (el && viewRef.current === 'library') { el.scrollTop = 0; raise(el); } }, [filter, category]);
  useEffect(() => { setSelected(none); }, [filter, category]);
  const openFolder = (id: string | null) => { setCategory(id); setSearching(false); setQuery(''); };

  const library = useMemo(() => removing.size ? files.filter(f => !removing.has(f.id)) : files, [files, removing]);
  const sorted = useMemo(() => [...categories].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })), [categories]);
  const folder = category ? categories.find(c => c.id === category) : undefined;
  useEffect(() => { if (category && loaded && online && !categories.some(c => c.id === category)) setCategory(null); }, [category, categories, loaded, online]);
  const visible = useMemo(() => { const q = query.trim().toLowerCase(); return library.filter(f => (filter === 'All files' || kind(f) === filter) && (!folder || f.category === folder.id) && (!q || f.name.toLowerCase().includes(q))); }, [library, filter, query, folder]);
  order.current = useMemo(() => visible.map(f => f.id), [visible]);
  useEffect(() => { if (!selected.size) return; const ids = new Set(library.map(f => f.id)); if ([...selected].some(id => !ids.has(id))) setSelected(current => new Set([...current].filter(id => ids.has(id)))); }, [library, selected]);
  const folderCounts = useMemo(() => { const m = new Map<string, number>(); for (const f of library) if (f.category && (filter === 'All files' || kind(f) === filter)) m.set(f.category, (m.get(f.category) || 0) + 1); return m; }, [library, filter]);
  const allCounts = useMemo(() => { const m = new Map<string, number>(); for (const f of library) if (f.category) m.set(f.category, (m.get(f.category) || 0) + 1); return m; }, [library]);
  const counts = useMemo(() => { const c: Record<string, number> = { 'All files': library.length, Videos: 0, Images: 0, Documents: 0 }; for (const f of library) c[kind(f)]++; return c; }, [library]);
  const stored = useMemo(() => library.reduce((sum, f) => f.ready ? sum + f.size : sum, 0), [library]);
  const viewable = useMemo(() => visible.filter(f => f.ready), [visible]);
  viewableRef.current = viewable;
  const groups = useMemo(() => {
    const result = new Map<string, GalleryFile[]>(); const today = new Date(); const todayText = today.toDateString();
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1); const yesterdayText = yesterday.toDateString();
    for (const file of visible) {
      const date = new Date(file.created); const text = date.toDateString();
      const title = text === todayText ? 'Today' : text === yesterdayText ? 'Yesterday' : date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
      const items = result.get(title); if (items) items.push(file); else result.set(title, [file]);
    }
    return Array.from(result);
  }, [visible]);
  const active = transfers.filter(t => ['uploading', 'queued', 'downloading'].includes(t.status));
  const finished = transfers.length - active.length;
  const preview = previewId ? library.find(f => f.id === previewId) : undefined;
  const selecting = selected.size > 0;
  const chosen = () => library.filter(f => selected.has(f.id));
  const selectAll = () => setSelected(current => current.size === order.current.length ? none : new Set(order.current));
  const closeSheet = useCallback(() => setSheet(null), []);
  const closePreview = useCallback(() => setPreviewId(null), []);

  const back = useRef<() => boolean>(() => false);
  back.current = () => {
    if (sheet) { setSheet(null); return true; }
    if (previewId) { setPreviewId(null); return true; }
    if (selecting) { setSelected(none); return true; }
    if (searching) { setSearching(false); setQuery(''); return true; }
    if (view === 'library' && category) { setCategory(null); return true; }
    if (view !== 'library') { go('library'); return true; }
    return false;
  };
  useEffect(() => { window.onColdDropBack = () => back.current(); return () => { delete window.onColdDropBack; }; }, []);
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = e => {
    if (phone || typing(e.target) || document.querySelector('dialog[open]') || viewRef.current !== 'library') return;
    if (e.key === 'Escape' && selecting) { setSelected(none); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selecting) { e.preventDefault(); removeFiles(chosen()); return; }
    if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setSelected(new Set(order.current)); }
  };
  useEffect(() => { const fn = (e: KeyboardEvent) => keys.current(e); window.addEventListener('keydown', fn); return () => window.removeEventListener('keydown', fn); }, []);

  const alerts = <>
    {error && <div className="alert" role="alert"><CircleAlert size={18}/><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={17}/></button></div>}
    {connection && !online && loaded && <div className="offline-banner"><WifiOff size={18}/><span>Open ColdDrop on your PC and connect both devices to the same Wi-Fi.</span><button onClick={refresh}>Reconnect</button></div>}
  </>;
  const categoriesSection = connection && !folder && (phone
    ? <section className="categories" aria-label="Categories"><div className="section-head"><h2>Categories</h2>{sorted.length > 0 && <span>{sorted.length}</span>}</div><div className="category-row"><button className="category-card new-card" onClick={() => setSheet({ kind: 'new' })}><FolderPlus size={19}/><span><strong>New</strong><small>Category</small></span></button>{sorted.map(c => <CategoryCard key={c.id} category={c} count={folderCounts.get(c.id) || 0} onOpen={openFolder} onMore={target => { haptic(); setSheet({ kind: 'category', category: target }); }}/>)}</div></section>
    : <section className="categories" aria-label="Categories"><div className="categories-head"><h2>Categories</h2><button className="text-button" onClick={() => setSheet({ kind: 'new' })}><FolderPlus size={17}/>New category</button></div>{sorted.length > 0 ? <div className="category-row">{sorted.map(c => <CategoryCard key={c.id} category={c} count={folderCounts.get(c.id) || 0} onOpen={openFolder} onMore={target => setSheet({ kind: 'category', category: target })}/>)}</div> : <p className="categories-empty">Make a category like hooks, then put videos, images, or any other file inside it.</p>}</section>);
  const transferBanner = active.length > 0 && <button className="transfer-banner" onClick={() => go('transfers')}><Upload size={19}/><span><strong>{plural(active.length, 'transfer')} in progress</strong><small>{active[0].name}</small></span><ChevronRight size={18}/></button>;
  const emptyTitle = query ? 'No matching files' : folder ? `Nothing in ${folder.name} yet` : filter === 'All files' ? 'Big files. Small effort.' : `No ${filter.toLowerCase()} yet`;
  const emptyText = query ? 'Try a different file name.' : folder ? `Add files here, or open any file and move it into ${folder.name}.` : 'Add videos, photos, presentations, or anything else. They show up here on both devices.';
  const galleryBody = !loaded ? <div className={`gallery skeletons${list ? ' as-list' : ''}`} aria-label="Loading gallery">{Array.from({ length: phone ? 12 : 8 }, (_, i) => <div className="skeleton" key={i}/>)}</div>
    : visible.length === 0 ? <div className="empty"><div className="empty-art"><FolderOpen size={phone ? 38 : 46} strokeWidth={1.2}/><span><Plus size={15}/></span></div><h2>{emptyTitle}</h2><p>{emptyText}</p>{!query && <button className="primary" onClick={add}><Plus size={18}/>{online ? (folder ? 'Add files here' : 'Add your first files') : 'Connect your devices'}</button>}</div>
    : <Gallery groups={groups} list={list} connection={connection!} selected={selected} selecting={selecting} actions={actions} root={scrollers.current.library ?? null}/>;
  const viewToggle = <div className="view-toggle"><button aria-label="Grid view" aria-pressed={!list} className={!list ? 'active' : ''} onClick={() => setList(false)}><Grid2X2 size={17}/></button><button aria-label="List view" aria-pressed={list} className={list ? 'active' : ''} onClick={() => setList(true)}><List size={18}/></button></div>;
  const devicesBody = <Devices connection={connection} online={online} onConnect={c => { setConnection(c); setFiles([]); setCategory(null); go('library'); }} onDisconnect={() => { window.ColdDrop?.disconnect(); localStorage.removeItem('colddrop-connection'); setConnection(null); setFiles([]); setCategories([]); setOnline(false); }} notify={notify} error={setError}/>;
  const transferList = transfers.length === 0 ? <div className="empty"><div className="empty-art"><ArrowUpFromLine size={phone ? 36 : 42} strokeWidth={1.3}/></div><h2>No transfers yet</h2><p>Files you add or download show up here with their progress.</p>{phone && <button className="primary" onClick={add}><Plus size={18}/>Add files</button>}</div> : <div className="transfers">{transfers.map(t => <TransferRow key={t.id} transfer={t}/>)}</div>;
  const overlays = <>
    {preview && connection && <Preview file={preview} files={viewable} connection={connection} busy={busy} folder={preview.category ? categories.find(c => c.id === preview.category)?.name : undefined} onClose={closePreview} onSelect={f => setPreviewId(f.id)} onDownload={() => download(preview)} onRename={() => setSheet({ kind: 'rename', file: preview })} onMove={() => setSheet({ kind: 'move', files: [preview] })} onDelete={() => removeFiles([preview])} onMore={() => setSheet({ kind: 'file', file: preview })}/>}
    {sheet?.kind === 'file' && connection && <FileSheet file={sheet.file} connection={connection} inPreview={!!preview} folder={sheet.file.category ? categories.find(c => c.id === sheet.file.category)?.name : undefined} onClose={closeSheet} onOpen={() => { setSheet(null); setPreviewId(sheet.file.id); }} onDownload={() => { setSheet(null); download(sheet.file); }} onRename={() => setSheet({ kind: 'rename', file: sheet.file })} onMove={() => setSheet({ kind: 'move', files: [sheet.file] })} onSelect={() => { setSheet(null); haptic(); toggle(sheet.file.id, false); }} onDelete={() => { setSheet(null); removeFiles([sheet.file]); }}/>}
    {sheet?.kind === 'category' && <CategorySheet category={sheet.category} count={allCounts.get(sheet.category.id) || 0} inside={category === sheet.category.id} onClose={closeSheet} onOpen={() => { setSheet(null); if (view !== 'library') go('library'); openFolder(sheet.category.id); }} onRename={() => setSheet({ kind: 'rename-category', category: sheet.category })} onDelete={() => setSheet({ kind: 'delete-category', category: sheet.category })}/>}
    {sheet?.kind === 'rename' && <NameSheet title="Rename file" label="File name" initial={sheet.file.name} action="Save" stem onClose={closeSheet} onSubmit={name => rename(sheet.file, name)}/>}
    {sheet?.kind === 'new' && <NameSheet title="New category" label="Category name" initial="" placeholder="hooks" action="Create" onClose={closeSheet} onSubmit={async name => { const created = await createCategory(name); if (sheet.files?.length) await moveFiles(sheet.files, created); else notify(`Created ${created.name}`); }}/>}
    {sheet?.kind === 'rename-category' && <NameSheet title="Rename category" label="Category name" initial={sheet.category.name} action="Save" onClose={closeSheet} onSubmit={name => renameCategory(sheet.category, name)}/>}
    {sheet?.kind === 'delete-category' && <DeleteCategorySheet category={sheet.category} count={allCounts.get(sheet.category.id) || 0} onClose={closeSheet} onConfirm={withFiles => removeCategory(sheet.category, withFiles)}/>}
    {sheet?.kind === 'move' && <MoveSheet files={sheet.files} categories={sorted} onClose={closeSheet} onMove={target => moveFiles(sheet.files, target)} onNew={() => setSheet({ kind: 'new', files: sheet.files })}/>}
    {toast && <ToastView key={toast.id} toast={toast} onClose={() => setToast(null)}/>}
  </>;
  const libraryView = (content: React.ReactNode) => <section className="view" hidden={view !== 'library'} ref={refs.library} onScroll={e => raise(e.currentTarget)} aria-label="Library">{content}</section>;
  const transfersView = (content: React.ReactNode) => <section className="view" hidden={view !== 'transfers'} ref={refs.transfers} onScroll={e => raise(e.currentTarget)} aria-label="Transfers">{content}</section>;
  const devicesView = (content: React.ReactNode) => <section className="view" hidden={view !== 'devices'} ref={refs.devices} onScroll={e => raise(e.currentTarget)} aria-label="Devices">{content}</section>;

  if (phone) {
    const title = view === 'library' ? folder?.name ?? 'ColdDrop' : view === 'transfers' ? 'Transfers' : 'Devices';
    return <div className={`app shell${selecting ? ' selecting' : ''}${toast ? ' has-toast' : ''}`}>
      <input ref={picker} type="file" multiple hidden onChange={e => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ''; }}/>
      <header className={`appbar${selecting ? ' is-selecting' : ''}`} ref={bar}>
        {selecting ? <div className="appbar-row" key="select">
          <button className="icon-button" onClick={() => setSelected(none)} aria-label="Cancel selection"><X size={22}/></button>
          <h1 className="appbar-title">{selected.size} selected</h1>
          <button className="icon-button" onClick={selectAll} aria-label={selected.size === order.current.length ? 'Clear selection' : 'Select all'}><ListChecks size={21}/></button>
          <button className="icon-button" onClick={() => setSheet({ kind: 'move', files: chosen() })} aria-label="Move to category"><FolderInput size={21}/></button>
          <button className="icon-button danger" onClick={() => removeFiles(chosen())} aria-label={`Delete ${plural(selected.size, 'file')}`}><Trash2 size={21}/></button>
        </div> : searching && view === 'library' ? <div className="appbar-row" key="search">
          <button className="icon-button" onClick={() => { setSearching(false); setQuery(''); }} aria-label="Close search"><ArrowLeft size={22}/></button>
          <input className="appbar-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={folder ? `Search ${folder.name}` : 'Search your files'} aria-label="Search files" autoFocus enterKeyHint="search" autoCapitalize="none" autoCorrect="off" spellCheck={false}/>
          {query && <button className="icon-button" onClick={() => setQuery('')} aria-label="Clear search"><X size={20}/></button>}
        </div> : <div className="appbar-row" key={`title-${view}-${folder?.id ?? ''}`}>
          {view === 'library' && folder ? <button className="icon-button" onClick={() => setCategory(null)} aria-label="Back to library"><ArrowLeft size={22}/></button> : <img className="appbar-logo" src={icon} alt=""/>}
          <h1 className="appbar-title">{title}</h1>
          {view === 'library' && <button className="icon-button" onClick={() => setSearching(true)} aria-label="Search files"><Search size={21}/></button>}
          {view === 'library' && folder && <button className="icon-button" onClick={() => setSheet({ kind: 'category', category: folder })} aria-label={`${folder.name} options`}><EllipsisVertical size={21}/></button>}
          {view !== 'devices' && <button className={`status-button${online ? ' online' : ''}`} onClick={() => go('devices')} aria-label={online ? 'Connected to your PC' : 'Not connected. Open devices'}>{online ? <Wifi size={18}/> : <WifiOff size={18}/>}</button>}
        </div>}
      </header>
      <div className="views">
        {libraryView(<>
          <div className="chips-bar"><div className="chips" role="tablist" aria-label="File types">{filters.map(f => <button key={f} role="tab" aria-selected={filter === f} className={`chip${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>{chips[f]}<span>{counts[f]}</span></button>)}</div>{viewToggle}</div>
          <div className="page">
            {alerts}
            {!query && categoriesSection}
            {transferBanner}
            <div className="gallery-wrap" key={`${filter}|${category ?? ''}`}>{galleryBody}</div>
          </div>
        </>)}
        {transfersView(<div className="page">
          {alerts}
          {transfers.length > 0 && <div className="section-head transfers-head"><h2>{active.length ? `${active.length} active` : 'All done'}{finished > 0 && <span> · {finished} finished</span>}</h2>{finished > 0 && <button className="text-button" onClick={clearFinished}><Trash2 size={16}/>Clear finished</button>}</div>}
          {transferList}
        </div>)}
        {devicesView(<div className="page">{alerts}{devicesBody}</div>)}
        {view === 'library' && !selecting && <button className="fab" onClick={add} aria-label={folder ? `Add files to ${folder.name}` : 'Add files'}><Plus size={26}/></button>}
      </div>
      <nav className="tabbar" aria-label="Main navigation">
        {views.map(v => { const Icon = v === 'library' ? Grid2X2 : v === 'transfers' ? ArrowUpFromLine : Laptop; return <button key={v} className={`tab${view === v ? ' selected' : ''}`} onClick={() => go(v)} aria-current={view === v ? 'page' : undefined}><span className="tab-pill"><Icon size={21}/>{v === 'transfers' && active.length > 0 && <span className="nav-badge">{active.length}</span>}</span><span className="tab-label">{v === 'library' ? 'Library' : v === 'transfers' ? 'Transfers' : 'Devices'}</span></button>; })}
      </nav>
      {overlays}
    </div>;
  }

  return <div className={`app desk${selecting ? ' selecting' : ''}`} onDragOver={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setDrag(true); }} onDrop={e => { e.preventDefault(); setDrag(false); if (online && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); }}>
    <input ref={picker} type="file" multiple hidden onChange={e => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ''; }}/>
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); go('library'); openFolder(null); }}><img src={icon} alt=""/><span>ColdDrop<span className="brand-sub">Your shared space</span></span></a>
      <button className="primary sidebar-add" onClick={add}><Plus size={19}/> Add files</button>
      <div className="nav-label">Library</div>
      <nav aria-label="Library">{filters.map((f, i) => { const Icon = icons[i]; return <button key={f} className={`nav-item ${view === 'library' && filter === f ? 'selected' : ''}`} onClick={() => { setFilter(f); go('library'); openFolder(null); }}><Icon size={19}/><span>{f}</span><span className="count">{counts[f]}</span></button>; })}</nav>
      <div className="nav-separator"/>
      <button className={`nav-item ${view === 'transfers' ? 'selected' : ''}`} onClick={() => go('transfers')}><ArrowUpFromLine size={19}/><span>Transfers</span>{active.length > 0 && <span className="count">{active.length}</span>}</button>
      <button className={`nav-item ${view === 'devices' ? 'selected' : ''}`} onClick={() => go('devices')}><Laptop size={19}/><span>Devices</span></button>
      <div className="sidebar-foot"><div className={`connection-status ${online ? 'connected' : ''}`}>{online ? <Wifi size={16}/> : <WifiOff size={16}/>}<span>{online ? 'Connected locally' : connection ? 'PC is offline' : 'Ready to connect'}</span></div><p>{bytes(stored)} in your library</p><small>Original quality. Your storage.</small></div>
    </aside>
    <main className="main">
      <header className="topbar" ref={bar}><span className="breadcrumb">Your space <ChevronRight size={14}/> {view === 'library' ? filter : view === 'devices' ? 'Devices' : 'Transfers'}{view === 'library' && folder && <><ChevronRight size={14}/> {folder.name}</>}</span><button className="device-indicator" onClick={() => go('devices')}><span className={`status-dot ${online ? 'online' : ''}`}/>This PC<Settings2 size={15}/></button></header>
      <div className="views">
        {libraryView(<div className="page">
          {alerts}
          <div className="page-heading"><div>{folder ? <><button className="back-link" onClick={() => setCategory(null)}><ArrowLeft size={15}/>{filter === 'All files' ? 'Your library' : filter}</button><h1 className="folder-title"><Folder size={26}/><span>{folder.name}</span></h1><p>Files you add here go straight into this category.</p></> : <><h1>{filter === 'All files' ? 'Your library' : filter}</h1><p>From your phone to your desk. Everything in one place.</p></>}</div><div className="heading-actions">{folder && <><button className="icon-button" onClick={() => setSheet({ kind: 'rename-category', category: folder })} aria-label={`Rename ${folder.name}`} title="Rename category"><Pencil size={18}/></button><button className="icon-button" onClick={() => setSheet({ kind: 'delete-category', category: folder })} aria-label={`Delete ${folder.name}`} title="Delete category"><Trash2 size={18}/></button></>}<button className="primary" onClick={add}><Plus size={19}/><span>{folder ? 'Add here' : 'Add files'}</span></button></div></div>
          <div className="toolbar"><label className="search"><Search size={18}/><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search your files" aria-label="Search files"/></label><span className="file-total">{plural(visible.length, 'file')}</span>{visible.length > 0 && <button className="secondary compact" onClick={() => setSelected(current => current.size ? none : new Set(order.current))}><CircleCheck size={16}/>{selecting ? 'Clear selection' : 'Select all'}</button>}{viewToggle}</div>
          {categoriesSection}
          {transferBanner}
          <div className="gallery-wrap" key={`${filter}|${category ?? ''}`}>{galleryBody}</div>
          {library.length > 0 && <div className="library-footer"><CheckCheck size={15}/> {online ? 'Live updates are on' : 'Waiting for your PC'}<span>Files stay in their original quality</span></div>}
        </div>)}
        {transfersView(<div className="page">
          {alerts}
          <div className="page-heading"><div><h1>Transfers</h1><p>Keep moving. Your files travel in the background.</p></div><div className="heading-actions">{finished > 0 && <button className="secondary" onClick={clearFinished}><Trash2 size={17}/>Clear finished</button>}<button className="primary" onClick={add}><Plus size={19}/>Add files</button></div></div>
          {transferList}
        </div>)}
        {devicesView(<div className="page">{alerts}{devicesBody}</div>)}
      </div>
    </main>
    {selecting && <div className="select-bar" role="toolbar" aria-label="Selected files"><button className="icon-button" onClick={() => setSelected(none)} aria-label="Cancel selection"><X size={19}/></button><strong>{selected.size} selected</strong><button className="secondary compact" onClick={selectAll}><ListChecks size={16}/>{selected.size === order.current.length ? 'Clear all' : 'Select all'}</button><button className="secondary compact" onClick={() => setSheet({ kind: 'move', files: chosen() })}><FolderInput size={16}/>Move</button><button className="primary compact danger-fill" onClick={() => removeFiles(chosen())}><Trash2 size={16}/>Delete</button></div>}
    {overlays}
    {drag && <div className="drop-overlay" onDragLeave={() => setDrag(false)} onDragOver={e => e.preventDefault()}><Upload size={52}/><h2>Drop into your library</h2><p>Original files. Ready on both devices.</p></div>}
  </div>;
}

const CategoryCard = memo(function CategoryCard({ category, count, onOpen, onMore }: { category: Category; count: number; onOpen(id: string): void; onMore(category: Category): void }) {
  const press = usePress(() => onOpen(category.id), () => onMore(category));
  return <button className="category-card" {...press}><Folder size={19}/><span><strong>{category.name}</strong><small>{plural(count, 'file')}</small></span></button>;
});

const Gallery = memo(function Gallery({ groups, list, connection, selected, selecting, actions, root }: { groups: [string, GalleryFile[]][]; list: boolean; connection: Connection; selected: ReadonlySet<string>; selecting: boolean; actions: Actions; root: HTMLElement | null }) {
  return <>{groups.map(([date, items]) => <section className="date-group" key={date}><div className="group-heading"><h2>{date}</h2><span>{plural(items.length, 'file')}</span></div><div className={list ? 'file-list' : 'gallery'}>{items.map(f => <FileTile key={f.id} file={f} connection={connection} list={list} selected={selected.has(f.id)} selecting={selecting} actions={actions} root={root}/>)}</div></section>)}</>;
});

const FileTile = memo(function FileTile({ file, connection, list, selected, selecting, actions, root }: { file: GalleryFile; connection: Connection; list: boolean; selected: boolean; selecting: boolean; actions: Actions; root: HTMLElement | null }) {
  const ref = useRef<HTMLElement>(null); const [seen, setSeen] = useState(false); const [attempt, setAttempt] = useState(0); const [shown, setShown] = useState(false); const generating = useRef(false);
  const type = kind(file); const Icon = type === 'Videos' ? Film : type === 'Images' ? ImageIcon : file.mime.startsWith('audio/') ? Music : FileText;
  const media = file.thumbnail ? 'thumbnail' : type === 'Images' || type === 'Videos' ? 'content' : null;
  const urls = useMemo(() => media ? sources(connection, file, media) : [], [connection, file.id, media]);
  const failed = attempt >= urls.length;
  useEffect(() => { setAttempt(0); setShown(false); }, [file.id, file.thumbnail]);
  useEffect(() => { const el = ref.current; if (!el || seen) return; return watch(el, root, () => setSeen(true)); }, [root, seen]);
  const press = usePress(e => selecting ? actions.toggle(file.id, e.shiftKey) : actions.open(file.id), () => actions.hold(file.id));
  async function thumbnail(el: HTMLImageElement | HTMLVideoElement) {
    setShown(true);
    if (generating.current || file.thumbnail) return; generating.current = true;
    try {
      const width = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
      const height = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
      if (!width || !height) return;
      const canvas = document.createElement('canvas'); const scale = Math.min(480 / width, 480 / height, 1); canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
      canvas.getContext('2d')?.drawImage(el, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      if (blob) await request(connection, `/api/files/${file.id}/thumbnail`, { method: 'PUT', body: blob });
    } catch { return; }
  }
  const next = () => { setShown(false); setAttempt(a => a + 1); };
  const src = urls[attempt];
  return <article ref={ref} className={`tile${list ? ' is-list' : ''}${selected ? ' is-selected' : ''}`}>
    <button className={`tile-open${!file.ready ? ' pending' : ''}`} {...press} aria-label={selecting ? `${selected ? 'Deselect' : 'Select'} ${file.name}` : `Preview ${file.name}`} aria-pressed={selecting ? selected : undefined}>
      <div className={`thumb type-${type.toLowerCase()}`}>
        {file.ready && seen && src && (media === 'thumbnail' || type === 'Images' ? <img key={src} className={shown ? 'is-shown' : ''} loading="lazy" decoding="async" draggable={false} crossOrigin={media === 'thumbnail' ? undefined : 'anonymous'} src={src} alt="" onLoad={e => thumbnail(e.currentTarget)} onError={next}/> : <video key={src} className={shown ? 'is-shown' : ''} muted playsInline preload="metadata" crossOrigin="anonymous" src={`${src}#t=0.1`} onLoadedData={e => thumbnail(e.currentTarget)} onError={next}/>)}
        {(!file.ready || failed || !media || !shown) && <div className={`file-placeholder${media && !failed && file.ready ? ' quiet' : ''}`}><Icon size={list ? 22 : 34} strokeWidth={1.35}/>{!list && !(media && !failed && file.ready) && <span>{file.name.split('.').pop()?.slice(0, 8).toUpperCase()}</span>}</div>}
        {!list && type === 'Videos' && file.ready && <span className="play-badge"><Play size={11} fill="currentColor"/>{!phone && 'Video'}</span>}
        {!file.ready && <span className="pending-label">Transferring</span>}
        <span className="tile-check" aria-hidden="true"><Check size={14} strokeWidth={3}/></span>
      </div>
      <div className="tile-info"><h3 title={file.name}>{file.name}</h3><p><span>{bytes(file.size)}</span>{!phone && <><span className="file-dot">·</span><span className="file-source">{file.source === 'PC' ? <Laptop size={12}/> : <Smartphone size={12}/>} {file.source}</span></>}</p></div>
    </button>
    {!phone && !list && <><button className="tile-select" onClick={() => actions.toggle(file.id, false)} aria-label={`${selected ? 'Deselect' : 'Select'} ${file.name}`} title={selected ? 'Deselect' : 'Select'}><Check size={14} strokeWidth={3}/></button><button className="tile-delete" onClick={() => actions.remove(file)} aria-label={`Delete ${file.name}`} title="Delete"><Trash2 size={15}/></button></>}
    {!selecting && <div className="tile-actions">{phone ? <button className="icon-button" onClick={() => actions.more(file)} aria-label={`Options for ${file.name}`}><EllipsisVertical size={18}/></button> : <><button className="icon-button" onClick={() => actions.rename(file)} aria-label={`Rename ${file.name}`} title="Rename"><Pencil size={15}/></button><button className="icon-button" onClick={() => actions.download(file)} disabled={!file.ready} aria-label={`Download ${file.name}`} title="Download"><ArrowDownToLine size={17}/></button>{list && <button className="icon-button danger" onClick={() => actions.remove(file)} aria-label={`Delete ${file.name}`} title="Delete"><Trash2 size={16}/></button>}</>}</div>}
  </article>;
});

function Preview({ file, files, connection, busy, folder, onClose, onSelect, onDownload, onRename, onMove, onDelete, onMore }: { file: GalleryFile; files: GalleryFile[]; connection: Connection; busy: boolean; folder?: string; onClose(): void; onSelect(file: GalleryFile): void; onDownload(): void; onRename(): void; onMove(): void; onDelete(): void; onMore(): void }) {
  const dialog = useRef<HTMLDialogElement>(null); const [zoom, setZoom] = useState(false); const [attempt, setAttempt] = useState(0); const [ready, setReady] = useState(false); const touch = useRef<{ x: number; y: number } | null>(null);
  const index = files.findIndex(f => f.id === file.id); const type = kind(file);
  const urls = useMemo(() => sources(connection, file, 'content'), [connection, file.id]);
  const poster = file.thumbnail ? sources(connection, file, 'thumbnail')[0] : undefined;
  const failed = attempt >= urls.length; const src = urls[attempt];
  const step = (direction: number) => { const next = files[index + direction]; if (next) onSelect(next); };
  useEffect(() => { const el = dialog.current; el?.showModal(); window.ColdDrop?.setChrome?.(true); return () => { el?.close(); window.ColdDrop?.setChrome?.(false); }; }, []);
  useEffect(() => { setAttempt(0); setZoom(false); setReady(false); }, [file.id]);
  const fail = () => { setReady(false); setAttempt(a => a + 1); };
  const meta = `${bytes(file.size)} · From ${file.source}${folder ? ` · In ${folder}` : ''} · ${new Date(file.created).toLocaleDateString()}`;
  return <dialog className="preview" ref={dialog} onCancel={e => { e.preventDefault(); onClose(); }} onKeyDown={e => { if (e.target instanceof HTMLVideoElement || e.target instanceof HTMLAudioElement || typing(e.target)) return; if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); if (e.key === 'F2') { e.preventDefault(); onRename(); } if (e.key === 'Delete') { e.preventDefault(); onDelete(); } }}>
    <header className="preview-header">
      <button className="icon-button" onClick={onClose} aria-label="Close preview"><X size={22}/></button>
      <div className="preview-title"><h2>{file.name}</h2><p>{meta}</p></div>
      {!phone && <><button className="icon-button" onClick={onRename} aria-label={`Rename ${file.name}`} title="Rename (F2)"><Pencil size={18}/></button><button className="icon-button" onClick={onMove} aria-label="Move to category" title="Move to category"><FolderInput size={19}/></button></>}
      <button className="icon-button" onClick={onDelete} aria-label={`Delete ${file.name}`} title="Delete"><Trash2 size={19}/></button>
      {phone ? <button className="icon-button" disabled={!file.ready || busy} onClick={onDownload} aria-label="Download">{busy ? <LoaderCircle className="spin" size={19}/> : <ArrowDownToLine size={20}/>}</button> : <button className="primary" disabled={!file.ready || busy} onClick={onDownload}>{busy ? <LoaderCircle className="spin" size={18}/> : <ArrowDownToLine size={18}/>}<span>{busy ? 'Saving…' : 'Download'}</span></button>}
      {phone && <button className="icon-button" onClick={onMore} aria-label="More options"><EllipsisVertical size={20}/></button>}
    </header>
    <div className={`preview-stage${zoom ? ' zoomed' : ''}`} onTouchStart={e => { touch.current = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }} onTouchEnd={e => { const t = touch.current; touch.current = null; if (!t || zoom || type !== 'Images') return; const dx = e.changedTouches[0].clientX - t.x; const dy = e.changedTouches[0].clientY - t.y; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) step(dx < 0 ? 1 : -1); else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.6) onClose(); }}>
      {!file.ready ? <div className="preview-message"><Upload size={46}/><h2>This file is still transferring</h2><p>Close this preview and open it when the transfer finishes.</p></div>
        : failed ? <div className="preview-message"><CircleAlert size={42}/><h2>Preview unavailable</h2><p>This device can’t display this format, or your PC is offline. Download the original to open it in another app.</p><button className="primary" onClick={onDownload}>Download original</button></div>
        : type === 'Images' ? <div className="stage-media" key={file.id}>{!ready && !poster && <LoaderCircle className="spin stage-spinner" size={30}/>}{poster && !ready && !zoom && <img className="stage-poster" src={poster} alt="" draggable={false}/>}<img key={src} className={`stage-full${ready ? ' is-shown' : ''}`} src={src} alt={file.name} draggable={false} decoding="async" onLoad={() => setReady(true)} onError={fail} onClick={() => setZoom(!zoom)}/></div>
        : type === 'Videos' ? <video key={src} className="stage-video" controls autoPlay playsInline preload="metadata" poster={poster} src={src} onError={fail}/>
        : file.mime.startsWith('audio/') ? <div className="preview-message"><Music size={48}/><audio key={src} controls src={src} onError={fail}/></div>
        : <div className="preview-message"><FileText size={54} strokeWidth={1.2}/><h2>{file.name.split('.').pop()?.toUpperCase()} document</h2><p>Save this file to open it in PowerPoint, a PDF reader, or another app.</p><button className="primary" onClick={onDownload}><ArrowDownToLine size={18}/>Download file</button></div>}
    </div>
    {file.ready && files.length > 0 && <footer className="preview-footer"><button className="icon-button" aria-label="Previous file" disabled={index <= 0} onClick={() => step(-1)}><ArrowLeft size={21}/></button><span>{index + 1} / {files.length}{type === 'Images' && <small>Tap image to {zoom ? 'fit' : 'zoom'}</small>}</span><button className="icon-button" aria-label="Next file" disabled={index < 0 || index >= files.length - 1} onClick={() => step(1)}><ArrowRight size={21}/></button></footer>}
  </dialog>;
}

function Sheet({ title, subtitle, leading, onClose, children, className = '' }: { title: string; subtitle?: string; leading?: React.ReactNode; onClose(): void; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; el?.showModal(); el?.querySelector<HTMLElement>('[data-autofocus]')?.focus(); return () => el?.close(); }, []);
  return <dialog className={`sheet ${className}`} ref={ref} onCancel={e => { e.preventDefault(); onClose(); }} onPointerDown={e => { if (e.target === ref.current) onClose(); }}><div className="sheet-body"><span className="sheet-grip" aria-hidden="true"/><header className="sheet-header">{leading}<div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19}/></button></header>{children}</div></dialog>;
}

function ActionRow({ icon: Icon, label, onClick, danger, disabled }: { icon: typeof Eye; label: string; onClick(): void; danger?: boolean; disabled?: boolean }) {
  return <button className={`action-row${danger ? ' danger' : ''}`} onClick={onClick} disabled={disabled}><Icon size={20}/><span>{label}</span></button>;
}

function FileSheet({ file, connection, inPreview, folder, onClose, onOpen, onDownload, onRename, onMove, onSelect, onDelete }: { file: GalleryFile; connection: Connection; inPreview: boolean; folder?: string; onClose(): void; onOpen(): void; onDownload(): void; onRename(): void; onMove(): void; onSelect(): void; onDelete(): void }) {
  const thumb = file.thumbnail ? sources(connection, file, 'thumbnail')[0] : undefined;
  const Icon = kind(file) === 'Videos' ? Film : kind(file) === 'Images' ? ImageIcon : FileText;
  return <Sheet title={file.name} subtitle={`${bytes(file.size)} · From ${file.source}${folder ? ` · In ${folder}` : ''}`} leading={<span className="sheet-thumb">{thumb ? <img src={thumb} alt="" draggable={false}/> : <Icon size={20}/>}</span>} onClose={onClose} className="action-sheet">
    <div className="action-list">
      {!inPreview && <ActionRow icon={Eye} label="Open" onClick={onOpen}/>}
      <ActionRow icon={ArrowDownToLine} label="Download" onClick={onDownload} disabled={!file.ready}/>
      <ActionRow icon={Pencil} label="Rename" onClick={onRename}/>
      <ActionRow icon={FolderInput} label={file.category ? 'Move to another category' : 'Move to category'} onClick={onMove}/>
      {!inPreview && <ActionRow icon={CircleCheck} label="Select" onClick={onSelect}/>}
      <ActionRow icon={Trash2} label="Delete" onClick={onDelete} danger/>
    </div>
  </Sheet>;
}

function CategorySheet({ category, count, inside, onClose, onOpen, onRename, onDelete }: { category: Category; count: number; inside: boolean; onClose(): void; onOpen(): void; onRename(): void; onDelete(): void }) {
  return <Sheet title={category.name} subtitle={plural(count, 'file')} onClose={onClose} className="action-sheet">
    <div className="action-list">
      {!inside && <ActionRow icon={FolderOpen} label="Open" onClick={onOpen}/>}
      <ActionRow icon={FolderPen} label="Rename" onClick={onRename}/>
      <ActionRow icon={Trash2} label="Delete category" onClick={onDelete} danger/>
    </div>
  </Sheet>;
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

function DeleteCategorySheet({ category, count, onClose, onConfirm }: { category: Category; count: number; onClose(): void; onConfirm(withFiles: boolean): Promise<unknown> }) {
  const [working, setWorking] = useState<'keep' | 'all' | null>(null); const [problem, setProblem] = useState('');
  const confirm = async (withFiles: boolean) => { setWorking(withFiles ? 'all' : 'keep'); setProblem(''); try { await onConfirm(withFiles); onClose(); } catch (e) { setProblem(message(e)); setWorking(null); } };
  return <Sheet title={`Delete ${category.name}?`} onClose={onClose}>
    <p className="sheet-text">{count > 0 ? <>It holds <strong>{plural(count, 'file')}</strong>. Keep them in your library, or delete them from your PC and phone for good.</> : 'This category is empty. Deleting it cannot be undone.'}</p>
    <p className="sheet-problem" role="alert">{problem}</p>
    <div className="sheet-actions stacked">
      <button className="secondary" onClick={onClose} disabled={working !== null}>Cancel</button>
      {count > 0 && <button className="secondary" data-autofocus onClick={() => confirm(false)} disabled={working !== null}>{working === 'keep' ? <LoaderCircle className="spin" size={17}/> : <FolderMinus size={17}/>}Keep files</button>}
      <button className="primary danger-fill" onClick={() => confirm(count > 0)} disabled={working !== null}>{working === 'all' || (count === 0 && working) ? <LoaderCircle className="spin" size={17}/> : <Trash2 size={17}/>}{count > 0 ? `Delete ${plural(count, 'file')} too` : 'Delete category'}</button>
    </div>
  </Sheet>;
}

function MoveSheet({ files, categories, onClose, onMove, onNew }: { files: GalleryFile[]; categories: Category[]; onClose(): void; onMove(target: Category | null): Promise<unknown>; onNew(): void }) {
  const [working, setWorking] = useState<string | null>(null); const [problem, setProblem] = useState('');
  const shared = files.every(f => (f.category ?? null) === (files[0]?.category ?? null)) ? files[0]?.category ?? null : undefined;
  const any = files.some(f => f.category);
  const choose = async (target: Category | null) => {
    if (shared !== undefined && (target?.id ?? null) === shared) { onClose(); return; }
    setWorking(target?.id ?? ''); setProblem('');
    try { await onMove(target); onClose(); } catch (e) { setProblem(message(e)); setWorking(null); }
  };
  return <Sheet title={files.length === 1 ? 'Move to category' : `Move ${plural(files.length, 'file')}`} onClose={onClose}>{files.length === 1 && <p className="sheet-text">Choose where <strong>{files[0].name}</strong> belongs.</p>}{categories.length > 0 ? <div className="move-list">{categories.map(c => <button key={c.id} className={`move-option ${shared === c.id ? 'current' : ''}`} disabled={working !== null} onClick={() => choose(c)}>{working === c.id ? <LoaderCircle className="spin" size={19}/> : <Folder size={19}/>}<span>{c.name}</span>{shared === c.id && <Check size={17}/>}</button>)}{any && <button className="move-option" disabled={working !== null} onClick={() => choose(null)}>{working === '' ? <LoaderCircle className="spin" size={19}/> : <FolderMinus size={19}/>}<span>Remove from category</span></button>}</div> : <p className="categories-empty sheet-empty">No categories yet. Make one and {files.length === 1 ? 'this file goes' : 'these files go'} straight in.</p>}<p className="sheet-problem" role="alert">{problem}</p><div className="sheet-actions"><button className="secondary" data-autofocus onClick={onNew} disabled={working !== null}><FolderPlus size={17}/>New category</button></div></Sheet>;
}

function ToastView({ toast, onClose }: { toast: Toast; onClose(): void }) {
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => { const open = document.querySelectorAll('dialog[open]'); setHost(open[open.length - 1] ?? document.body); }, []);
  if (!host) return null;
  return createPortal(<div className="toast" role="status">{toast.undo ? <Trash2 size={17}/> : <Check size={17}/>}<span>{toast.text}</span>{toast.undo && <button className="toast-action" onClick={() => { toast.undo?.(); }}><Undo2 size={16}/>Undo</button>}<button className="toast-close" onClick={onClose} aria-label="Dismiss"><X size={16}/></button></div>, host);
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
  return <>{!phone && <div className="page-heading"><div><h1>Your devices</h1><p>Two screens. One library. Connect once and start sharing.</p></div></div>}<div className="device-layout"><section className="pair-panel"><div className="device-illustration"><Smartphone size={phone ? 34 : 40} strokeWidth={1.4}/><span/><Laptop size={phone ? 48 : 58} strokeWidth={1.3}/></div>
    {desktop ? <><h2>Bring your phone along</h2><p>Open ColdDrop on Android, tap <strong>Scan QR code</strong>, and point your camera here.</p>{qr ? <img className="qr" src={qr} alt="Scan this QR code in ColdDrop on your phone to pair with this PC"/> : <p className="alert">Connect this PC to Wi-Fi to show a pairing code.</p>}{connection && chosen && <><label className="field-label">PC network address<select value={chosen} onChange={e => setAddress(e.target.value)}>{connection.addresses?.map(a => <option key={a} value={a}>{a}</option>)}</select></label><button className="secondary" onClick={copy}><Copy size={17}/>Copy pairing link</button><details><summary>Or copy the link manually</summary><textarea className="pair-link" readOnly value={pairingLink(connection, chosen)} aria-label="Pairing link" onFocus={e => e.target.select()}/></details></>}</> : <><h2>{connection ? (online ? 'Connected to your PC' : 'Your PC is offline') : 'Meet your PC'}</h2><p>{connection ? 'Scan again if your PC changed networks, or paste a new pairing link below.' : 'Open ColdDrop on your Windows PC. Scan its QR code or paste the pairing link below.'}</p>{window.ColdDrop && <button className="primary wide" disabled={working} onClick={() => window.ColdDrop?.scan()}><ScanLine size={20}/>Scan QR code</button>}<div className="or-divider"><span>or use a link</span></div><form onSubmit={e => { e.preventDefault(); pair(input); }}><label className="field-label">Pairing link<textarea value={input} onChange={e => setInput(e.target.value)} placeholder="Paste the link from ColdDrop on your PC" autoCapitalize="none" autoCorrect="off" spellCheck={false} required/></label><button className="secondary wide" type="submit" disabled={working || !input.trim()}>{working ? <LoaderCircle size={18} className="spin"/> : <Link size={18}/>} {working ? 'Connecting…' : 'Connect to PC'}</button></form></>}
    </section><div className="device-details"><section><h2>Made for the same Wi-Fi</h2><p>Your PC stores the originals. Your phone streams previews and can save its own copies. Transfers use your local network.</p><div className="device-line"><Laptop size={22}/><div><strong>{desktop ? 'This Windows PC' : 'Your Windows PC'}</strong><small>{connection ? (desktop ? chosen : connection.base) : 'Not paired yet'}</small></div><span className={`status-dot ${online ? 'online' : ''}`}/></div><div className="device-line"><Smartphone size={22}/><div><strong>{desktop ? 'Android phone' : 'This phone'}</strong><small>{desktop ? 'Pair with the QR code' : connection ? 'Pairing saved on this device' : 'Ready to pair'}</small></div></div></section><section><h3>Keep the library available</h3><p>Keep your PC awake and ColdDrop running. Closing its window keeps it in the system tray. Use the tray menu to quit.</p><p>Allow ColdDrop through Windows Firewall on <strong>private networks</strong> when Windows asks. Guest Wi-Fi may block connections between devices.</p></section><section><h3>Your files stay yours</h3><p>No recompression, cloud account, or upload quota. Available PC storage and your Wi-Fi speed determine transfer capacity and time.</p><p className="security-note">Pair only devices you trust. Local transfers use HTTP on your private Wi-Fi; the pairing link grants access to the library.</p>{desktop && connection && <button className="text-button" onClick={() => invoke('open_library').catch(e => error(String(e)))}><FolderOpen size={17}/>Open storage folder</button>}{!desktop && connection && <button className="text-button danger" onClick={onDisconnect}>Disconnect this phone</button>}</section></div></div></>;
}

function TransferRow({ transfer: t }: { transfer: Transfer }) {
  const progress = Math.min(100, t.size > 0 ? t.sent / t.size * 100 : t.status === 'complete' ? 100 : 0);
  return <article className={`transfer-row ${t.status}`}><div className="transfer-icon">{t.status === 'complete' ? <Check size={20}/> : t.status === 'failed' ? <CircleAlert size={20}/> : t.status === 'downloading' ? <ArrowDownToLine size={20}/> : <ArrowUpFromLine size={20}/>}</div><div className="transfer-info"><h3>{t.name}</h3><div className="transfer-meta"><span>{t.status === 'complete' ? 'Complete' : t.status === 'failed' ? t.error || 'Transfer interrupted' : t.status === 'queued' ? 'Waiting to transfer' : `${t.status === 'downloading' ? 'Downloading' : 'Adding'} · ${bytes(t.sent)} of ${bytes(t.size)}`}</span>{!['failed', 'complete'].includes(t.status) && <strong>{Math.round(progress)}%</strong>}</div>{!['failed', 'complete'].includes(t.status) && <progress max="100" value={progress} aria-label={`Progress for ${t.name}`}/>}{t.status === 'failed' && <p className="retry-note">{window.ColdDrop ? 'Reconnect to your PC, then retry.' : 'Add this file again to retry the transfer.'}</p>}</div>{t.status === 'failed' && window.ColdDrop && <button className="secondary retry" onClick={() => window.ColdDrop?.retry(t.id)}><RefreshCw size={16}/>Retry</button>}</article>;
}

createRoot(document.getElementById('root')!).render(<App/>);
