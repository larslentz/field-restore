import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Activity, ArrowDown, ArrowUp, AudioLines, Check, ChevronDown, CircleHelp, Download, FileAudio, FolderOpen, Gauge, HelpCircle, Info, Keyboard, Layers3, Menu, Pause, Play, Plus, Redo2, RotateCcw, Save, Settings, Square, Trash2, Undo2, Waves, X, ZoomIn, ZoomOut } from 'lucide-react';
import { createDemoAudio, downloadBlob, encodeWav, parseWav, type AudioSource } from '@/lib/audio';
import { decodeChannels, loadProject, projectFromSource, saveProject } from '@/lib/persistence';
import { makeModule, MODULE_LABELS, renderChain, type EditModule, type ModuleType } from '@/lib/edit-chain';
import { analyzeLoudness, type LoudnessStats } from '@/lib/loudness';
import './index.css';

type ViewTab = 'edit' | 'analyze' | 'project';
type MonitorMode = 'current' | 'original';
type Marker = { id: string; time: number; label: string; color: string };
type Region = { id: string; start: number; end: number; label: string };

const MODULE_TYPES: ModuleType[] = ['gain', 'fade', 'eq', 'dc', 'hum', 'wind', 'region', 'ambient'];
const colorForMarker = '#d8ed55';

function formatTime(seconds: number, precise = false) {
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  const remaining = safe - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remaining.toFixed(precise ? 3 : 1).padStart(precise ? 6 : 4, '0')}`;
}

function formatLevel(value: number, unit: 'dBTP' | 'LUFS' | 'LU') {
  if (!Number.isFinite(value)) return `-∞ ${unit}`;
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} ${unit}`;
}

function App() {
  const [source, setSource] = useState<AudioSource>(() => createDemoAudio());
  const [modules, setModules] = useState<EditModule[]>(() => [makeModule('hum'), makeModule('wind'), makeModule('gain')]);
  const [undoStack, setUndoStack] = useState<EditModule[][]>([]);
  const [redoStack, setRedoStack] = useState<EditModule[][]>([]);
  const [selection, setSelection] = useState<[number, number]>([4.1, 7.8]);
  const [markers, setMarkers] = useState<Marker[]>([{ id: 'm-1', time: 7.8, label: 'transient', color: colorForMarker }]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [activeTab, setActiveTab] = useState<ViewTab>('edit');
  const [zoom, setZoom] = useState(1);
  const [playHead, setPlayHead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [rate, setRate] = useState(1);
  const [monitor, setMonitor] = useState<MonitorMode>('current');
  const [moduleMenu, setModuleMenu] = useState(false);
  const [modal, setModal] = useState<'export' | 'help' | 'settings' | null>(null);
  const [title, setTitle] = useState('Coastal dawn / north bluff');
  const [notes, setNotes] = useState('Low-tide ambience. Keep the distant tern call at 07:48 intact.');
  const [savedStatus, setSavedStatus] = useState('Local session');
  const [error, setError] = useState('');
  const [showAllModules, setShowAllModules] = useState(true);
  const [isDraggingWav, setIsDraggingWav] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const pointerDragRef = useRef<{ start: number; current: number } | null>(null);
  const dragDepthRef = useRef(0);

  const currentChannels = useMemo(() => renderChain(source.channels, modules, source.sampleRate), [source.channels, source.sampleRate, modules]);
  const currentSource = useMemo<AudioSource>(() => ({ ...source, channels: currentChannels }), [source, currentChannels]);
  const duration = source.duration;
  const viewDuration = duration / zoom;
  const selectionStart = Math.min(...selection);
  const selectionEnd = Math.max(...selection);
  const originalStats = useMemo(() => analyzeLoudness(source.channels, source.sampleRate), [source.channels, source.sampleRate]);
  const currentStats = useMemo(() => analyzeLoudness(currentChannels, source.sampleRate), [currentChannels, source.sampleRate]);
  const selectionOriginalStats = useMemo(() => analyzeLoudness(source.channels, source.sampleRate, selectionStart * source.sampleRate, selectionEnd * source.sampleRate), [source.channels, selectionStart, selectionEnd, source.sampleRate]);
  const selectionCurrentStats = useMemo(() => analyzeLoudness(currentChannels, source.sampleRate, selectionStart * source.sampleRate, selectionEnd * source.sampleRate), [currentChannels, selectionStart, selectionEnd, source.sampleRate]);

  useEffect(() => {
    const saved = loadProject();
    if (saved?.originalBase64?.length && saved.originalLength) {
      const channels = decodeChannels(saved.originalBase64, saved.originalLength);
      const next: AudioSource = { channels, sampleRate: saved.sampleRate, duration: channels[0].length / saved.sampleRate, name: saved.sourceName };
      setSource(next); setTitle(saved.title); setNotes(saved.notes); setModules(saved.modules); setMarkers(saved.markers); setRegions(saved.regions);
      setSavedStatus(`Restored ${new Date(saved.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    } else if (saved?.original?.length) {
      const channels = saved.original.map((channel) => new Float32Array(channel));
      const next: AudioSource = { channels, sampleRate: saved.sampleRate, duration: channels[0].length / saved.sampleRate, name: saved.sourceName };
      setSource(next); setTitle(saved.title); setNotes(saved.notes); setModules(saved.modules); setMarkers(saved.markers); setRegions(saved.regions);
      setSavedStatus(`Restored ${new Date(saved.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    }
  }, []);

  const stopPlayback = useCallback(() => {
    audioSourceRef.current?.stop();
    audioSourceRef.current?.disconnect();
    audioSourceRef.current = null;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    setIsPlaying(false);
  }, []);

  const play = useCallback(() => {
    if (isPlaying) { stopPlayback(); return; }
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) { setError('This browser does not expose Web Audio playback.'); return; }
    const context = audioContextRef.current ?? new AudioContextClass();
    audioContextRef.current = context;
    const buffer = context.createBuffer(monitor === 'original' ? source.channels.length : currentChannels.length, source.channels[0].length, source.sampleRate);
    const channels = monitor === 'original' ? source.channels : currentChannels;
    channels.forEach((channel, index) => buffer.getChannelData(index).set(channel));
    const node = context.createBufferSource();
    node.buffer = buffer; node.playbackRate.value = rate; node.connect(context.destination);
    const startAt = Math.min(playHead, Math.max(0, duration - .01));
    const startedAt = context.currentTime;
    node.loop = loop;
    node.loopStart = startAt;
    node.loopEnd = duration;
    node.onended = () => { if (!loop) { setPlayHead(duration); setIsPlaying(false); } };
    node.start(0, startAt);
    audioSourceRef.current = node; setIsPlaying(true);
    const tick = () => {
      if (!audioSourceRef.current) return;
      const elapsed = (context.currentTime - startedAt) * rate;
      const next = Math.min(duration, startAt + elapsed);
      setPlayHead(loop ? startAt + (elapsed % Math.max(.01, duration - startAt)) : next);
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  }, [currentChannels, duration, isPlaying, loop, monitor, playHead, rate, source.channels, source.sampleRate, stopPlayback]);

  useEffect(() => () => { stopPlayback(); audioContextRef.current?.close(); }, [stopPlayback]);

  const commitModules = useCallback((next: EditModule[]) => {
    setUndoStack((stack) => [...stack.slice(-39), modules]);
    setRedoStack([]);
    setModules(next);
    setSavedStatus('Unsaved local changes');
  }, [modules]);

  const updateModule = (id: string, patch: Partial<EditModule>) => commitModules(modules.map((module) => module.id === id ? { ...module, ...patch } : module));
  const updateParams = (id: string, key: string, value: number | string) => commitModules(modules.map((module) => module.id === id ? { ...module, params: { ...module.params, [key]: value } } : module));
  const addModule = (type: ModuleType) => { commitModules([...modules, makeModule(type)]); setModuleMenu(false); };
  const deleteModule = (id: string) => commitModules(modules.filter((module) => module.id !== id));
  const duplicateModule = (module: EditModule) => commitModules([...modules, { ...module, id: `${module.type}-${Date.now()}`, name: `${module.name} copy`, params: { ...module.params } }]);
  const moveModule = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= modules.length) return;
    const next = [...modules]; [next[index], next[destination]] = [next[destination], next[index]]; commitModules(next);
  };
  const undo = () => {
    const previous = undoStack.at(-1); if (!previous) return;
    setRedoStack((stack) => [...stack, modules]); setModules(previous); setUndoStack((stack) => stack.slice(0, -1));
  };
  const redo = () => {
    const next = redoStack.at(-1); if (!next) return;
    setUndoStack((stack) => [...stack, modules]); setModules(next); setRedoStack((stack) => stack.slice(0, -1));
  };

  const importWavFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.wav') && !['audio/wav', 'audio/x-wav', 'audio/wave'].includes(file.type)) {
      setError('Drop an uncompressed WAV file to begin editing.');
      return;
    }
    try {
      setError(''); const parsed = parseWav(await file.arrayBuffer(), file.name);
      stopPlayback(); setSource(parsed); setModules([]); setSelection([0, Math.min(parsed.duration, 5)]); setMarkers([]); setRegions([]); setTitle(file.name.replace(/\.wav$/i, '')); setSavedStatus('Imported · not saved');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to read this WAV file.'); }
  }, [stopPlayback]);

  const importFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void importWavFile(file);
    event.target.value = '';
  };

  const onDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (event.dataTransfer.types.includes('Files')) setIsDraggingWav(true);
  };

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingWav(false);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingWav(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) {
      setError('No file was found in that drop.');
      return;
    }
    void importWavFile(file);
  };

  const save = () => {
    const project = projectFromSource(source, modules, markers, regions, title, notes);
    const ok = saveProject(project);
    setSavedStatus(ok ? `Saved locally · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Storage full · export a project report');
  };

  const exportAudio = () => {
    const safeName = (title || source.name).replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').toLowerCase();
    downloadBlob(encodeWav(currentSource), `${safeName || 'field-restore'}-rx.wav`);
    const report = { tool: 'Field Restore', version: 'local preview', source: source.name, sampleRate: source.sampleRate, channels: source.channels.length, duration: duration, format: '32-bit IEEE float WAV', modules, selection: [selectionStart, selectionEnd], exportedAt: new Date().toISOString(), limitations: ['Edits are conservative sample-domain approximations in this browser build.', 'Original source remains immutable; export reflects enabled modules only.'] };
    downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `${safeName || 'field-restore'}-restoration-report.json`);
    setModal(null); setSavedStatus('WAV + report exported');
  };

  const canvasPointToTime = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return 0;
    const bounds = canvas.getBoundingClientRect(); const x = (event.clientX - bounds.left) / bounds.width;
    const center = selectionStart + (selectionEnd - selectionStart) / 2 || duration / 2;
    const viewStart = zoom === 1 ? 0 : Math.max(0, Math.min(duration - viewDuration, center - viewDuration / 2));
    return Math.max(0, Math.min(duration, viewStart + x * viewDuration));
  };
  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => { const time = canvasPointToTime(event); pointerDragRef.current = { start: time, current: time }; event.currentTarget.setPointerCapture(event.pointerId); setSelection([time, time]); };
  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => { if (!pointerDragRef.current) return; const time = canvasPointToTime(event); pointerDragRef.current.current = time; setSelection([pointerDragRef.current.start, time]); };
  const onCanvasPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => { if (!pointerDragRef.current) return; const time = canvasPointToTime(event); const start = pointerDragRef.current.start; setSelection([Math.min(start, time), Math.max(start, time)]); pointerDragRef.current = null; };

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const ratio = window.devicePixelRatio || 1; const width = canvas.clientWidth; const height = canvas.clientHeight;
    canvas.width = width * ratio; canvas.height = height * ratio; context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const center = selectionStart + (selectionEnd - selectionStart) / 2 || duration / 2;
    const viewStart = zoom === 1 ? 0 : Math.max(0, Math.min(duration - viewDuration, center - viewDuration / 2));
    const graphBottom = height - 28;
    context.fillStyle = '#17242c'; context.fillRect(0, 0, width, height);
    context.strokeStyle = 'rgba(218, 237, 196, .11)'; context.lineWidth = 1;
    for (let x = 0; x < width; x += width / 10) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, graphBottom); context.stroke(); }
    for (let y = 18; y < graphBottom; y += 32) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
    const selectedLeft = ((selectionStart - viewStart) / viewDuration) * width; const selectedRight = ((selectionEnd - viewStart) / viewDuration) * width;
    context.fillStyle = 'rgba(214, 237, 85, .13)'; context.fillRect(selectedLeft, 0, Math.max(2, selectedRight - selectedLeft), graphBottom);
    const drawWave = (channels: Float32Array[], color: string, alpha: number) => {
      context.strokeStyle = color; context.globalAlpha = alpha; context.lineWidth = 1;
      context.beginPath();
      const columns = Math.ceil(width); const startSample = Math.floor(viewStart * source.sampleRate); const sampleCount = Math.max(1, Math.floor(viewDuration * source.sampleRate));
      for (let x = 0; x < columns; x += 1) {
        const from = startSample + Math.floor((x / columns) * sampleCount); const to = Math.min(channels[0].length, startSample + Math.floor(((x + 1) / columns) * sampleCount));
        let min = 1; let max = -1; for (let i = from; i < Math.max(from + 1, to); i += 1) { const value = channels[0][i] ?? 0; min = Math.min(min, value); max = Math.max(max, value); }
        const mid = graphBottom / 2; context.moveTo(x, mid + min * (graphBottom * .43)); context.lineTo(x, mid + max * (graphBottom * .43));
      }
      context.stroke(); context.globalAlpha = 1;
    };
    drawWave(source.channels, '#8fa4a1', .42); drawWave(currentChannels, '#d8ed55', 1);
    context.strokeStyle = 'rgba(235, 250, 231, .28)'; context.beginPath(); context.moveTo(0, graphBottom / 2); context.lineTo(width, graphBottom / 2); context.stroke();
    markers.forEach((marker) => { const x = ((marker.time - viewStart) / viewDuration) * width; if (x >= 0 && x <= width) { context.strokeStyle = marker.color; context.setLineDash([3, 3]); context.beginPath(); context.moveTo(x, 0); context.lineTo(x, graphBottom); context.stroke(); context.setLineDash([]); context.fillStyle = marker.color; context.beginPath(); context.arc(x, 9, 3, 0, Math.PI * 2); context.fill(); } });
    const headX = ((playHead - viewStart) / viewDuration) * width; context.strokeStyle = '#ff8a4c'; context.lineWidth = 2; context.beginPath(); context.moveTo(headX, 0); context.lineTo(headX, graphBottom); context.stroke();
    context.fillStyle = '#f2f4e8'; context.font = '10px "Space Mono", monospace'; context.textAlign = 'left';
    for (let tick = 0; tick <= 6; tick += 1) { const time = viewStart + (tick / 6) * viewDuration; context.fillText(formatTime(time), (tick / 6) * width + 4, height - 8); }
  }, [activeTab, currentChannels, duration, markers, playHead, selectionEnd, selectionStart, source.channels, source.sampleRate, viewDuration, zoom]);

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.code === 'Space') { event.preventDefault(); play(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      if (event.key === 'Escape') { setModal(null); setModuleMenu(false); }
    };
    window.addEventListener('keydown', keyHandler); return () => window.removeEventListener('keydown', keyHandler);
  }, [play, redo, undo]);

  const addMarker = () => setMarkers((items) => [...items, { id: `marker-${Date.now()}`, time: selectionStart, label: `mark ${items.length + 1}`, color: colorForMarker }]);
  const addRegion = () => selectionEnd - selectionStart > .01 && setRegions((items) => [...items, { id: `region-${Date.now()}`, start: selectionStart, end: selectionEnd, label: `region ${items.length + 1}` }]);

  return (
    <div
      className={`app-shell noise ${isDraggingWav ? 'is-dragging-wav' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid="app-field-restore"
    >
      {isDraggingWav && (
        <div className="wav-drop-overlay" role="status" aria-live="polite" data-testid="wav-drop-overlay">
          <div className="wav-drop-card">
            <FileAudio size={34} strokeWidth={1.5} />
            <div>
              <div className="wav-drop-title">Drop WAV to open</div>
              <div className="wav-drop-copy">Your recording stays on this device. The original will remain unchanged.</div>
            </div>
          </div>
        </div>
      )}
      <aside className="sidebar-shell">
        <div className="px-4 py-5 flex items-center gap-3">
          <div className="brand-mark" aria-hidden="true" />
          <div className="brand-copy"><div className="font-bold tracking-tight text-[14px]">FIELD RESTORE</div><div className="text-[10px] opacity-55 tracking-[.12em] uppercase mt-0.5">local instrument</div></div>
        </div>
        <div className="px-3 mt-5 sidebar-title eyebrow text-[#91a69d]">Workspace</div>
        <nav className="px-3 mt-2 space-y-1" aria-label="Workspace navigation">
          {([['edit', Activity, 'Edit chain'], ['analyze', Gauge, 'Analyze'], ['project', FolderOpen, 'Project']] as const).map(([tab, Icon, label]) => <button key={tab} type="button" className={`nav-item ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)} data-testid={`nav-${tab}`}><Icon size={15} /><span className="nav-label">{label}</span></button>)}
        </nav>
        <div className="px-3 mt-8 sidebar-title eyebrow text-[#91a69d]">Session</div>
        <div className="px-3 mt-2 space-y-1">
          <button type="button" className="nav-item" onClick={() => fileRef.current?.click()} data-testid="nav-import"><FileAudio size={15} /><span className="nav-label">Import WAV</span></button>
          <button type="button" className="nav-item" onClick={() => { stopPlayback(); setSource(createDemoAudio()); setModules([makeModule('hum'), makeModule('wind'), makeModule('gain')]); setSelection([4.1, 7.8]); setMarkers([{ id: 'm-1', time: 7.8, label: 'transient', color: colorForMarker }]); setRegions([]); setTitle('Coastal dawn / north bluff'); setSavedStatus('Demo source loaded'); }} data-testid="nav-demo"><Waves size={15} /><span className="nav-label">Load demo source</span></button>
          <button type="button" className="nav-item" onClick={save} data-testid="nav-save"><Save size={15} /><span className="nav-label">Save locally</span></button>
          <button type="button" className="nav-item" onClick={() => setModal('export')} data-testid="nav-export"><Download size={15} /><span className="nav-label">Export</span></button>
        </div>
        <div className="mt-auto px-4 pb-5 sidebar-meta">
          <div className="border-t border-[#34454b] pt-4">
            <div className="flex items-center gap-2 text-[11px] text-[#b7c8bb]"><span className="w-2 h-2 rounded-full bg-[#d8ed55]" /> Offline / local only</div>
            <div className="font-mono-value text-[10px] text-[#829890] mt-2">{source.sampleRate / 1000} kHz · {source.channels.length} ch</div>
          </div>
        </div>
      </aside>
      <section className="main-shell">
        <header className="topbar">
          <div className="flex items-center gap-3 min-w-0">
            <button type="button" className="icon-btn md:hidden" aria-label="Open navigation" data-testid="button-menu"><Menu size={16} /></button>
            <div className="min-w-0"><div className="eyebrow">Current recording</div><div className="font-semibold text-[14px] mt-1 truncate max-w-[340px]" data-testid="text-source-name">{source.name}</div></div>
            <span className="chip hidden sm:inline-flex"><span className="w-1.5 h-1.5 bg-[#d8ed55] rounded-full" />{savedStatus}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" className="icon-btn" onClick={undo} disabled={!undoStack.length} aria-label="Undo last edit" data-testid="button-undo"><Undo2 size={16} /></button>
            <button type="button" className="icon-btn" onClick={redo} disabled={!redoStack.length} aria-label="Redo last edit" data-testid="button-redo"><Redo2 size={16} /></button>
            <span className="hidden lg:inline font-mono-value text-[10px] text-muted-foreground mx-2">⌘Z / ⌘⇧Z</span>
            <button type="button" className="quiet-btn" onClick={() => setModal('help')} data-testid="button-help"><CircleHelp size={14} /> <span className="hidden sm:inline">Help</span></button>
            <button type="button" className="quiet-btn" onClick={() => setModal('settings')} aria-label="Open settings" data-testid="button-settings"><Settings size={14} /></button>
            <button type="button" className="primary-btn" onClick={() => setModal('export')} data-testid="button-export"><Download size={14} /> Export</button>
          </div>
        </header>
        <main className="main-content scrollbar-thin">
          {error && <div className="max-w-[1660px] mx-auto mb-3 border border-[#d79c88] bg-[#fff0e9] text-[#8e3a2b] rounded-md px-3 py-2 text-[12px] flex items-center justify-between" role="alert" data-testid="status-error"><span>{error}</span><button type="button" className="icon-btn" onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button></div>}
          <div className="workspace-grid">
            <div className="min-w-0 space-y-4">
              <div className="flex items-center justify-between">
                <div><div className="eyebrow">Restoration workspace</div><h1 className="text-[21px] font-bold tracking-[-.03em] mt-1" data-testid="heading-workspace">{activeTab === 'edit' ? 'Listen closely. Change less.' : activeTab === 'analyze' ? 'Evidence before intervention.' : 'Project ledger.'}</h1></div>
                <div className="flex bg-[hsl(var(--muted))] rounded-md p-0.5" role="tablist" aria-label="Workspace view">
                  {(['edit', 'analyze', 'project'] as ViewTab[]).map((tab) => <button key={tab} type="button" className={`tab rounded ${activeTab === tab ? 'active bg-[hsl(var(--card))]' : ''}`} onClick={() => setActiveTab(tab)} role="tab" aria-selected={activeTab === tab} data-testid={`tab-${tab}`}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}
                </div>
              </div>
              {activeTab === 'project' ? (
                <ProjectPanel title={title} notes={notes} setTitle={setTitle} setNotes={setNotes} source={source} save={save} setModal={setModal} />
              ) : activeTab === 'analyze' ? (
                <AnalyzePanel originalStats={originalStats} currentStats={currentStats} selectionOriginalStats={selectionOriginalStats} selectionCurrentStats={selectionCurrentStats} duration={duration} selection={[selectionStart, selectionEnd]} modules={modules} />
              ) : (
                <>
                  <section className="panel instrument-grid" aria-label="Waveform editor">
                    <div className="panel-header">
                      <div className="flex items-center gap-3"><Waves size={17} color="hsl(var(--primary))" /><div><div className="section-title">Waveform / selection</div><div className="text-[10px] text-muted-foreground mt-0.5">Click-drag to mark a precise working range</div></div></div>
                      <div className="flex items-center gap-1"><button type="button" className="icon-btn" onClick={() => setZoom(Math.max(1, zoom / 1.8))} aria-label="Zoom out" data-testid="button-zoom-out"><ZoomOut size={15} /></button><span className="font-mono-value text-[10px] text-muted-foreground w-12 text-center">{zoom.toFixed(1)}×</span><button type="button" className="icon-btn" onClick={() => setZoom(Math.min(16, zoom * 1.8))} aria-label="Zoom in" data-testid="button-zoom-in"><ZoomIn size={15} /></button><button type="button" className="quiet-btn ml-2 !py-[5px]" onClick={() => setZoom(1)} data-testid="button-fit">Fit</button></div>
                    </div>
                    <div className="panel-body !pt-3">
                      <div className="waveform-wrap">
                        <canvas ref={canvasRef} className="waveform-canvas" onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerUp={onCanvasPointerUp} onPointerCancel={onCanvasPointerUp} aria-label="Interactive waveform selection" data-testid="canvas-waveform" />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><span className="inline-block w-3 h-3 rounded-sm bg-[#d8ed55]" /> current <span className="inline-block w-3 h-3 rounded-sm bg-[#8fa4a1] ml-2" /> original <span className="inline-block w-3 h-3 rounded-sm bg-[#ff8a4c] ml-2" /> playhead</div>
                        <div className="font-mono-value text-[11px]" data-testid="text-selection-time">{formatTime(selectionStart, true)} — {formatTime(selectionEnd, true)} <span className="text-muted-foreground">({(selectionEnd - selectionStart).toFixed(3)} s selected)</span></div>
                      </div>
                    </div>
                  </section>
                  <section className="transport" aria-label="Audio transport">
                    <button type="button" className="icon-btn !bg-[#d8ed55] !text-[#18231f] !rounded-full" onClick={play} aria-label={isPlaying ? 'Pause playback' : 'Play playback'} data-testid="button-play">{isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
                    <button type="button" className="icon-btn" onClick={() => { stopPlayback(); setPlayHead(0); }} aria-label="Stop and return to start" data-testid="button-stop"><Square size={14} fill="currentColor" /></button>
                    <div className="time-readout" data-testid="text-playhead">{formatTime(playHead)} <span className="font-sans text-[10px] opacity-55">/ {formatTime(duration)}</span></div>
                    <div className="h-5 w-px bg-white/15 mx-1" />
                    <button type="button" className={`icon-btn !text-[11px] !font-bold ${loop ? '!bg-white/10 !text-[#d8ed55]' : ''}`} onClick={() => setLoop(!loop)} aria-pressed={loop} data-testid="button-loop">LOOP</button>
                    <div className="ml-auto flex items-center gap-2"><span className="text-[10px] opacity-60">MONITOR</span><select className="bg-transparent border border-white/15 rounded px-2 py-1 text-[11px]" value={monitor} onChange={(event) => setMonitor(event.target.value as MonitorMode)} aria-label="Monitor source" data-testid="select-monitor"><option value="current">Current</option><option value="original">Original A/B</option></select><select className="bg-transparent border border-white/15 rounded px-2 py-1 text-[11px]" value={rate} onChange={(event) => setRate(Number(event.target.value))} aria-label="Playback rate" data-testid="select-playback-rate"><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option></select></div>
                  </section>
                  <section className="panel">
                    <div className="panel-header"><div className="flex items-center gap-2"><Layers3 size={16} color="hsl(var(--accent))" /><div><div className="section-title">Non-destructive edit chain</div><div className="text-[10px] text-muted-foreground mt-0.5">{modules.filter((module) => module.enabled).length} enabled · original stays untouched</div></div></div><div className="relative"><button type="button" className="primary-btn" onClick={() => setModuleMenu(!moduleMenu)} data-testid="button-add-module"><Plus size={14} /> Add module <ChevronDown size={13} /></button>{moduleMenu && <div className="absolute right-0 top-10 z-20 w-52 p-1 bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-md shadow-lg">{MODULE_TYPES.map((type) => <button type="button" key={type} className="w-full text-left px-3 py-2 rounded text-[12px] hover:bg-[hsl(var(--muted))]" onClick={() => addModule(type)} data-testid={`menu-module-${type}`}>{MODULE_LABELS[type]}<span className="block text-[10px] text-muted-foreground">{type === 'hum' ? 'conservative notch estimate' : type === 'ambient' ? 'blend local texture' : 'sample-domain pass'}</span></button>)}</div>}</div></div>
                    <div className="panel-body">
                      {modules.length === 0 ? <div className="empty-state border border-dashed rounded-md"><Layers3 size={20} className="mx-auto mb-2 opacity-45" /><div className="text-[12px] font-semibold text-foreground">No edits in the chain</div><div className="text-[11px] mt-1">Add a conservative module. Every change stays reversible.</div></div> : modules.map((module, index) => <ModuleCard key={module.id} module={module} index={index} total={modules.length} collapsed={!showAllModules} updateModule={updateModule} updateParams={updateParams} deleteModule={deleteModule} duplicateModule={duplicateModule} moveModule={moveModule} />)}
                      <div className="flex items-center justify-between pt-2"><button type="button" className="quiet-btn" onClick={() => setShowAllModules(!showAllModules)} data-testid="button-chain-toggle">{showAllModules ? 'Collapse details' : 'Expand details'}</button><div className="font-mono-value text-[10px] text-muted-foreground">processing is local / reversible</div></div>
                    </div>
                  </section>
                </>
              )}
            </div>
            <aside className="space-y-4">
              <section className="panel">
                <div className="panel-header"><div className="flex items-center gap-2"><Gauge size={15} color="hsl(var(--primary))" /><div className="section-title">Signal statistics</div></div><span className="chip">estimate</span></div>
                <div className="panel-body !pb-3"><div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Current / full file</div><StatsGrid stats={currentStats} /><div className="text-[10px] text-muted-foreground uppercase tracking-wider mt-4 mb-2">Selection · {formatTime(selectionEnd - selectionStart)}</div><StatsGrid stats={selectionCurrentStats} /></div>
                <div className="px-4 pb-4 text-[10px] leading-relaxed text-muted-foreground"><Info size={12} className="inline mr-1 -mt-0.5" />Local BS.1770-style K-weighting and gating; true peak uses 4× interpolation. Values are practical estimates, not certified meter readings.</div>
              </section>
              <section className="panel">
                <div className="panel-header"><div className="flex items-center gap-2"><AudioLines size={15} color="hsl(var(--accent))" /><div className="section-title">Markers & regions</div></div><span className="font-mono-value text-[10px] text-muted-foreground">{markers.length + regions.length}</span></div>
                <div className="panel-body !pt-2">
                  {markers.map((marker) => <div key={marker.id} className="flex items-center gap-2 py-2 border-b border-[hsl(var(--border))]"><span className="w-2 h-2 rounded-full bg-[#d8ed55]" /><input className="input-field !border-0 !p-0 !bg-transparent flex-1" value={marker.label} onChange={(event) => setMarkers((items) => items.map((item) => item.id === marker.id ? { ...item, label: event.target.value } : item))} aria-label={`Marker label ${marker.label}`} data-testid={`input-marker-${marker.id}`} /><span className="font-mono-value text-[10px] text-muted-foreground">{formatTime(marker.time)}</span><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => setMarkers((items) => items.filter((item) => item.id !== marker.id))} aria-label={`Delete marker ${marker.label}`} data-testid={`button-delete-marker-${marker.id}`}><Trash2 size={12} /></button></div>)}
                  {regions.map((region) => <div key={region.id} className="flex items-center gap-2 py-2 border-b border-[hsl(var(--border))]"><span className="w-2 h-2 rounded-sm bg-[#ff8a4c]" /><input className="input-field !border-0 !p-0 !bg-transparent flex-1 min-w-0" value={region.label} onChange={(event) => setRegions((items) => items.map((item) => item.id === region.id ? { ...item, label: event.target.value } : item))} aria-label={`Region label ${region.label}`} data-testid={`input-region-${region.id}`} /><span className="font-mono-value text-[10px] text-muted-foreground">{formatTime(region.end - region.start)}</span><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => setRegions((items) => items.filter((item) => item.id !== region.id))} aria-label={`Delete region ${region.label}`} data-testid={`button-delete-region-${region.id}`}><Trash2 size={12} /></button></div>)}
                  {!markers.length && !regions.length && <div className="text-[11px] text-muted-foreground py-3">Select a range, then add a marker or region.</div>}
                  <div className="flex gap-2 pt-3"><button type="button" className="quiet-btn flex-1 !py-1.5" onClick={addMarker} data-testid="button-add-marker"><Plus size={12} /> Marker</button><button type="button" className="quiet-btn flex-1 !py-1.5" onClick={addRegion} disabled={selectionEnd - selectionStart < .01} data-testid="button-add-region"><Plus size={12} /> Region</button></div>
                </div>
              </section>
              <section className="panel">
                <div className="panel-header"><div className="section-title">Local presets</div><button type="button" className="icon-btn" aria-label="Preset help" onClick={() => setModal('help')} data-testid="button-preset-help"><HelpCircle size={14} /></button></div>
                <div className="panel-body space-y-2"><button type="button" className="w-full text-left border border-[hsl(var(--border))] rounded p-2.5 hover:bg-[hsl(var(--muted))]" onClick={() => { setModules([makeModule('hum'), makeModule('wind'), makeModule('gain')]); setSavedStatus('Field clarity preset loaded'); }} data-testid="button-preset-clarity"><div className="text-[12px] font-bold">Field clarity</div><div className="text-[10px] text-muted-foreground mt-1">60 Hz hum · gentle low-cut · -2 dB headroom</div></button><button type="button" className="w-full text-left border border-[hsl(var(--border))] rounded p-2.5 hover:bg-[hsl(var(--muted))]" onClick={() => { setModules([makeModule('wind'), makeModule('dc')]); setSavedStatus('Low-end control preset loaded'); }} data-testid="button-preset-lowend"><div className="text-[12px] font-bold">Low-end control</div><div className="text-[10px] text-muted-foreground mt-1">Rumble reduction · measured offset correction</div></button></div>
              </section>
            </aside>
          </div>
        </main>
      </section>
      <input ref={fileRef} type="file" accept=".wav,audio/wav" onChange={importFile} className="hidden" data-testid="input-import-wav" />
      {modal === 'export' && <ExportModal onClose={() => setModal(null)} onExport={exportAudio} title={title} />}
      {modal === 'help' && <HelpModal onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
    </div>
  );
}

function StatsGrid({ stats }: { stats: LoudnessStats }) {
  return <div className="stat-grid"><div className="stat-cell"><div className="stat-value">{formatLevel(stats.truePeakDbtp, 'dBTP')}</div><div className="stat-label">True peak estimate</div></div><div className="stat-cell"><div className="stat-value">{formatLevel(stats.integratedLufs, 'LUFS')}</div><div className="stat-label">Integrated loudness</div></div><div className="stat-cell"><div className="stat-value">{formatLevel(stats.loudnessRangeLu, 'LU')}</div><div className="stat-label">Loudness range</div></div><div className="stat-cell"><div className="stat-value">{formatLevel(stats.maxShortTermLufs, 'LUFS')}</div><div className="stat-label">Max short-term</div></div></div>;
}

function ModuleCard({ module, index, total, collapsed, updateModule, updateParams, deleteModule, duplicateModule, moveModule }: { module: EditModule; index: number; total: number; collapsed: boolean; updateModule: (id: string, patch: Partial<EditModule>) => void; updateParams: (id: string, key: string, value: number | string) => void; deleteModule: (id: string) => void; duplicateModule: (module: EditModule) => void; moveModule: (index: number, direction: -1 | 1) => void }) {
  const p = module.params;
  const numberInput = (key: string, label: string, min: number, max: number, step: number, suffix = '') => <label className="block"><span className="field-label">{label} <span className="font-mono-value normal-case">{String(p[key])}{suffix}</span></span><input className="range-field" type="range" min={min} max={max} step={step} value={Number(p[key])} onChange={(event) => updateParams(module.id, key, Number(event.target.value))} data-testid={`range-${module.type}-${key}`} /></label>;
  return <div className={`module-card ${module.enabled ? '' : 'bypassed'}`} data-testid={`card-module-${module.id}`}><div className="module-head"><span className="module-index">{String(index + 1).padStart(2, '0')}</span><span className="module-dot" /><button type="button" className="module-name text-left" onDoubleClick={() => { const name = window.prompt('Rename module', module.name); if (name?.trim()) updateModule(module.id, { name: name.trim() }); }} title="Double-click to rename" data-testid={`button-rename-${module.id}`}>{module.name}</button><span className="module-summary">{module.type === 'gain' ? `${p.db} dB` : module.type === 'hum' ? `${p.mode} · ${p.frequency} Hz` : module.type === 'wind' ? `${p.cutoff} Hz` : module.type}</span><button type="button" className={`icon-btn !h-6 !min-w-6 ${module.enabled ? 'text-[hsl(var(--primary))]' : ''}`} onClick={() => updateModule(module.id, { enabled: !module.enabled })} aria-label={`${module.enabled ? 'Bypass' : 'Enable'} ${module.name}`} aria-pressed={module.enabled} data-testid={`button-bypass-${module.id}`}><Check size={13} /></button><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => moveModule(index, -1)} disabled={index === 0} aria-label="Move module up" data-testid={`button-up-${module.id}`}><ArrowUp size={12} /></button><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => moveModule(index, 1)} disabled={index === total - 1} aria-label="Move module down" data-testid={`button-down-${module.id}`}><ArrowDown size={12} /></button><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => duplicateModule(module)} aria-label="Duplicate module" data-testid={`button-duplicate-${module.id}`}><Layers3 size={12} /></button><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => deleteModule(module.id)} aria-label={`Delete ${module.name}`} data-testid={`button-delete-${module.id}`}><Trash2 size={12} /></button></div>
    {!collapsed && <div className="module-controls">
      {module.type === 'gain' && numberInput('db', 'Gain', -18, 12, .1, ' dB')}
      {module.type === 'fade' && <div className="grid grid-cols-2 gap-3">{numberInput('in', 'Fade in', 0, 10, .1, ' s')}{numberInput('out', 'Fade out', 0, 10, .1, ' s')}</div>}
      {module.type === 'eq' && <div className="grid grid-cols-3 gap-2">{numberInput('low', 'Low', -12, 12, .5, ' dB')}{numberInput('mid', 'Mid', -12, 12, .5, ' dB')}{numberInput('high', 'High', -12, 12, .5, ' dB')}</div>}
      {module.type === 'dc' && numberInput('amount', 'Offset estimate', -100, 100, 1, ' ×10⁻³')}
      {module.type === 'hum' && <div className="grid grid-cols-2 gap-3"><label><span className="field-label">Mode</span><select className="select-field" value={String(p.mode)} onChange={(event) => updateParams(module.id, 'mode', event.target.value)} data-testid={`select-hum-mode-${module.id}`}><option>Static</option><option>Dynamic</option><option>Adaptive</option></select></label>{numberInput('frequency', 'Fundamental', 40, 120, 1, ' Hz')}{numberInput('reduction', 'Reduction', 0, 24, 1, ' dB')}</div>}
      {module.type === 'wind' && <div className="grid grid-cols-2 gap-3">{numberInput('cutoff', 'Low cut', 40, 240, 5, ' Hz')}{numberInput('reduction', 'Reduction', 0, 12, .5, ' dB')}</div>}
      {module.type === 'region' && <div className="grid grid-cols-3 gap-2">{numberInput('start', 'Start', 0, 60, .1, ' s')}{numberInput('end', 'End', 0, 60, .1, ' s')}{numberInput('amount', 'Attenuate', -24, 0, .5, ' dB')}</div>}
      {module.type === 'ambient' && <div className="grid grid-cols-3 gap-2">{numberInput('start', 'Start', 0, 60, .1, ' s')}{numberInput('length', 'Length', .1, 8, .1, ' s')}{<div className="text-[10px] leading-relaxed text-muted-foreground self-end">Blends nearby ambience conservatively.</div>}</div>}
      <div className="text-[10px] text-muted-foreground flex items-center gap-1"><Info size={11} /> Browser-safe approximation. Preview before archival export.</div>
    </div>}
  </div>;
}

function AnalyzePanel({ originalStats, currentStats, selectionOriginalStats, selectionCurrentStats, duration, selection, modules }: { originalStats: LoudnessStats; currentStats: LoudnessStats; selectionOriginalStats: LoudnessStats; selectionCurrentStats: LoudnessStats; duration: number; selection: [number, number]; modules: EditModule[] }) {
  return (
    <div className="space-y-4">
      <section className="panel">
        <div className="panel-header">
          <div>
            <div className="section-title">Measured signal report</div>
            <div className="text-[10px] text-muted-foreground mt-1">Current processed signal · matches the right-side Signal statistics panel</div>
          </div>
          <span className="chip"><Check size={11} /> current</span>
        </div>
        <div className="panel-body grid md:grid-cols-2 gap-5">
          <div>
            <div className="eyebrow mb-2">Current / full file · {formatTime(duration)}</div>
            <StatsGrid stats={currentStats} />
          </div>
          <div>
            <div className="eyebrow mb-2">Current / selection · {formatTime(selection[1] - selection[0])}</div>
            <StatsGrid stats={selectionCurrentStats} />
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <div className="section-title">Original vs Current comparison</div>
            <div className="text-[10px] text-muted-foreground mt-1">A/B changes introduced by the enabled edit chain</div>
          </div>
          <span className="chip">{modules.filter((module) => module.enabled).length} edits enabled</span>
        </div>
        <div className="panel-body grid md:grid-cols-2 gap-5">
          <SignalComparison title={`Full file · ${formatTime(duration)}`} original={originalStats} current={currentStats} />
          <SignalComparison title={`Selection · ${formatTime(selection[1] - selection[0])}`} original={selectionOriginalStats} current={selectionCurrentStats} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><div className="section-title">Interpretation notes</div></div>
        <div className="panel-body grid md:grid-cols-3 gap-3 text-[12px]">
          <div className="border-l-2 border-[#d8ed55] pl-3"><strong>Loudness context</strong><p className="text-muted-foreground mt-1 leading-relaxed">Use integrated loudness for the overall program and loudness range for long-term variation. Preserve headroom for archival work.</p></div>
          <div className="border-l-2 border-[#ff8a4c] pl-3"><strong>Chain impact</strong><p className="text-muted-foreground mt-1 leading-relaxed">{modules.filter((module) => module.enabled).length} enabled modules are rendered in order. Bypassed modules remain editable.</p></div>
          <div className="border-l-2 border-[#91a69d] pl-3"><strong>Known boundary</strong><p className="text-muted-foreground mt-1 leading-relaxed">These browser-local readings follow BS.1770-style weighting and gating but are not a substitute for a calibrated compliance meter.</p></div>
        </div>
      </section>
    </div>
  );
}

function SignalComparison({ title, original, current }: { title: string; original: LoudnessStats; current: LoudnessStats }) {
  return (
    <div>
      <div className="eyebrow mb-2">{title}</div>
      <div className="stat-grid">
        <div className="stat-cell"><div className="stat-value">{formatLevel(original.truePeakDbtp, 'dBTP')}</div><div className="stat-label">Original true peak</div></div>
        <div className="stat-cell"><div className="stat-value">{formatLevel(current.truePeakDbtp, 'dBTP')}</div><div className="stat-label">Current true peak</div></div>
        <div className="stat-cell"><div className="stat-value">{formatLevel(original.integratedLufs, 'LUFS')}</div><div className="stat-label">Original integrated</div></div>
        <div className="stat-cell"><div className="stat-value">{formatLevel(current.integratedLufs, 'LUFS')}</div><div className="stat-label">Current integrated</div></div>
        <div className="stat-cell"><div className="stat-value">{formatLevel(original.loudnessRangeLu, 'LU')}</div><div className="stat-label">Original LRA</div></div>
        <div className="stat-cell"><div className="stat-value">{formatLevel(current.loudnessRangeLu, 'LU')}</div><div className="stat-label">Current LRA</div></div>
        <div className="stat-cell"><div className="stat-value">{formatLevel(original.maxShortTermLufs, 'LUFS')}</div><div className="stat-label">Original max short-term</div></div>
        <div className="stat-cell"><div className="stat-value">{formatLevel(current.maxShortTermLufs, 'LUFS')}</div><div className="stat-label">Current max short-term</div></div>
      </div>
    </div>
  );
}

function ProjectPanel({ title, notes, setTitle, setNotes, source, save, setModal }: { title: string; notes: string; setTitle: (value: string) => void; setNotes: (value: string) => void; source: AudioSource; save: () => void; setModal: (value: 'export' | 'help' | 'settings' | null) => void }) {
  return <div className="space-y-4"><section className="panel"><div className="panel-header"><div><div className="section-title">Project metadata</div><div className="text-[10px] text-muted-foreground mt-1">Stored only in this browser on this device</div></div><button type="button" className="primary-btn" onClick={save} data-testid="button-project-save"><Save size={14} /> Save locally</button></div><div className="panel-body space-y-5 max-w-[740px]"><label><span className="field-label">Project title</span><input className="input-field text-[16px]" value={title} onChange={(event) => setTitle(event.target.value)} data-testid="input-project-title" /></label><label><span className="field-label">Field notes</span><textarea className="textarea-field min-h-[170px]" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Describe place, mic, weather, handling, and decisions…" data-testid="textarea-project-notes" /></label><div className="grid sm:grid-cols-3 gap-3"><div className="p-3 bg-[hsl(var(--muted))] rounded"><div className="eyebrow">Source</div><div className="font-mono-value text-[11px] mt-2 truncate">{source.name}</div></div><div className="p-3 bg-[hsl(var(--muted))] rounded"><div className="eyebrow">Format</div><div className="font-mono-value text-[11px] mt-2">{source.sampleRate / 1000} kHz / {source.channels.length} ch</div></div><div className="p-3 bg-[hsl(var(--muted))] rounded"><div className="eyebrow">Duration</div><div className="font-mono-value text-[11px] mt-2">{formatTime(source.duration)}</div></div></div></div></section><section className="panel"><div className="panel-header"><div className="section-title">Local-first guarantees</div></div><div className="panel-body grid sm:grid-cols-2 gap-3 text-[12px]"><div className="border rounded p-3"><Check size={15} color="hsl(var(--primary))" /><div className="font-semibold mt-2">Original is immutable</div><div className="text-muted-foreground mt-1 leading-relaxed">All processing renders from a preserved source array. No destructive overwrite occurs.</div></div><div className="border rounded p-3"><Check size={15} color="hsl(var(--primary))" /><div className="font-semibold mt-2">No network required</div><div className="text-muted-foreground mt-1 leading-relaxed">WAV parsing, DSP estimates, playback, persistence, and export happen in this tab.</div></div><button type="button" className="quiet-btn justify-self-start" onClick={() => setModal('settings')} data-testid="button-project-settings"><Settings size={14} /> Storage settings</button></div></section></div>;
}

function ExportModal({ onClose, onExport, title }: { onClose: () => void; onExport: () => void; title: string }) {
  return <div className="modal-backdrop" role="presentation"><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className="modal-header"><div><div className="eyebrow">Output / local files</div><h2 id="export-title" className="text-[17px] font-bold mt-1">Export restoration</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="Close export dialog" data-testid="button-close-export"><X size={16} /></button></div><div className="modal-body space-y-4"><div className="p-3 bg-[hsl(var(--muted))] rounded text-[12px]"><div className="font-semibold">{title || 'Untitled project'}</div><div className="text-muted-foreground mt-1">Two files will be created: a valid WAV and a machine-readable restoration report.</div></div><div className="block p-3 border border-[hsl(var(--primary))] bg-[hsl(var(--muted))] rounded"><strong className="text-[12px]">Archival WAV · 32-bit IEEE float</strong><span className="block text-[11px] text-muted-foreground mt-1">Preserves floating-point precision, source sample rate, channel count, and stereo relationship. No normalization or dither is applied.</span></div><div className="text-[11px] text-muted-foreground border-l-2 border-[#ff8a4c] pl-3">Exports use enabled modules only. The original recording is never replaced.</div></div><div className="modal-footer"><button type="button" className="quiet-btn" onClick={onClose} data-testid="button-cancel-export">Cancel</button><button type="button" className="primary-btn" onClick={onExport} data-testid="button-confirm-export"><Download size={14} /> Export 32-bit float WAV + report</button></div></div></div>;
}

function HelpModal({ onClose }: { onClose: () => void }) {
  return <div className="modal-backdrop"><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="help-title"><div className="modal-header"><div><div className="eyebrow">Field notes</div><h2 id="help-title" className="text-[17px] font-bold mt-1">A quiet tool for noisy places</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="Close help" data-testid="button-close-help"><X size={16} /></button></div><div className="modal-body"><p className="text-[12px] leading-relaxed text-muted-foreground">Field Restore intentionally favors small, reversible moves. Import a WAV, select a moment, listen against the original, and keep an ear on the source—not just the meters.</p><div className="mt-4"><div className="eyebrow mb-2">Keyboard</div><div className="help-row"><span className="keycap">Space</span><span>Play / pause</span></div><div className="help-row"><span className="keycap">⌘ Z</span><span>Undo chain edit</span></div><div className="help-row"><span className="keycap">⇧⌘ Z</span><span>Redo chain edit</span></div><div className="help-row"><span className="keycap">Esc</span><span>Close a dialog or menu</span></div></div><div className="mt-5 p-3 bg-[hsl(var(--muted))] rounded text-[11px] leading-relaxed"><Keyboard size={14} className="inline mr-2 -mt-0.5" />For critical work, verify the exported WAV in a second application. Browser DSP here is conservative and deliberately labeled as an estimate.</div></div><div className="modal-footer"><button type="button" className="primary-btn" onClick={onClose} data-testid="button-done-help">Back to work</button></div></div></div>;
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggleTheme = () => { const next = !dark; setDark(next); document.documentElement.classList.toggle('dark', next); localStorage.setItem('field-restore-theme', next ? 'dark' : 'light'); };
  return <div className="modal-backdrop"><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-header"><div><div className="eyebrow">Instrument settings</div><h2 id="settings-title" className="text-[17px] font-bold mt-1">Preferences</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings" data-testid="button-close-settings"><X size={16} /></button></div><div className="modal-body space-y-4"><div className="flex items-center justify-between border rounded p-3"><div><div className="text-[12px] font-semibold">Darkroom contrast</div><div className="text-[11px] text-muted-foreground mt-1">Switch to a darker monitoring surface.</div></div><button type="button" className={`quiet-btn ${dark ? '!bg-[hsl(var(--primary))] !text-[hsl(var(--primary-foreground))]' : ''}`} onClick={toggleTheme} aria-pressed={dark} data-testid="button-toggle-theme">{dark ? 'On' : 'Off'}</button></div><div className="border rounded p-3 text-[11px] leading-relaxed text-muted-foreground"><RotateCcw size={14} className="inline mr-2 -mt-0.5" />Project storage uses browser localStorage. Clear site data in browser settings to remove it. No audio or metadata leaves this device.</div></div><div className="modal-footer"><button type="button" className="primary-btn" onClick={onClose} data-testid="button-done-settings">Done</button></div></div></div>;
}

export default App;