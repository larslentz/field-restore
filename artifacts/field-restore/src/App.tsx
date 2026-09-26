import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent, type FormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ArrowDown, ArrowUp, Check, ChevronDown, CircleHelp, Download, ExternalLink, FileAudio, FolderOpen, Gauge, GripVertical, Info, Keyboard, Layers3, LoaderCircle, Menu, PanelBottom, PanelLeft, PanelRightOpen, Pause, Play, Plus, Redo2, RotateCcw, Save, Settings, Square, Trash2, Undo2, Waves, X, ZoomIn, ZoomOut } from 'lucide-react';
import { createDemoAudio, downloadBlob, encodeWav, parseWav, type AudioSource } from '@/lib/audio';
import { decodeChannels, loadProject, projectFromSource, saveProject } from '@/lib/persistence';
import { AUTOMATIC_DC_REMOVAL, humOpeningReadout, isFixedLowRumble, isLegacyWind, lowEndShelfEnabled, lowEndShelfFollowsWind, makeDefaultChain, makeLowRumbleRemoval, makeModule, makeProcessingChain, makeRestorationReport, MODULE_LABELS, toggleEditableModules, withFadeRange, withoutLegacyDcModules, type EditModule, type HumScanState } from '@/lib/edit-chain';
import { WIND_COMPENSATION_TIMING, WIND_SHELF_SCOPE_DETECTED, WIND_SHELF_SCOPE_WHOLE, windCompensationTiming } from '@/lib/wind-reduction';
import { analyzeLoudness, type LoudnessStats } from '@/lib/loudness';
import { createPlaybackRangePlan, playbackPositionAtElapsed } from '@/lib/playback-range';
import type { SpectrogramData } from '@/lib/spectrogram';
import { withLargeExportLeaveWarning, writeFloat32WavChunks } from '@/lib/large-wav';
import { audioRange, fingerprintAudio, parseAudioMetadata, readAudioFrames, type AudioMetadata } from '@/lib/source-audio';
import { decodeFlac } from '@/lib/flac';
import { isVerifiedRelink, openVerifiedFileHandle } from '@/lib/file-access';
import { listProjects, loadProject as loadProjectV2, queryFileHandlePermission, requestFileHandlePermission, saveProject as saveProjectV2, type ProjectRecord } from '@/lib/project-store';
import { exportFilenames, filenameWord, what3wordsMapUrl } from '@/lib/project-metadata';
import { analyzeFileInitialHum, createStreamingEditChain } from '@/lib/streaming-edit-chain';
import type { SpectralRepairPatches } from '@/lib/streaming-edit-chain';
import { prepareSpectralRepairsInWorker } from '@/lib/worker-spectral-prep';
import { measureNoiseProfile, NOISE_PROFILE_BANDS, NOISE_SAMPLE_MAX_SECONDS, NOISE_SAMPLE_MIN_SECONDS } from '@/lib/noise-reduction';
import { humAnalysisWindowSize, humPrefixFrames } from '@/lib/hum-removal';
import { recordHumHistory, visibleHumHistory, type HumHistorySegment, type VisibleHumSegment } from '@/lib/hum-history';
import { recordWindHistory, windActivityAt, windActivityAtSorted, type WindHistorySegment } from '@/lib/wind-history';
import { preparePresetModules, readChainPresets, saveChainPreset, type ChainPreset } from '@/lib/chain-presets';
import { EqCurve } from '@/components/EqCurve';
import { LbprStat, PlrStat } from '@/components/SignalRatios';
import { anchoredFrequencyViewMin, anchoredLevelScaleCeiling, anchoredTimeViewStart, frequencyScaleTicks, levelScaleTicks } from '@/lib/spectrogram-scale';
import { SPECTROGRAM_DATA_HEIGHT, SPECTROGRAM_FFT_SIZE } from '@/lib/spectrogram-resolution';
import { DEFAULT_SPECTROGRAM_PALETTE, SPECTROGRAM_PALETTES, spectrogramColor, spectrogramColorCss, spectrogramLegendStops, type SpectrogramPaletteId } from '@/lib/spectrogram-palette';
import { startWorkerJob, type WorkerJob } from '@/lib/worker-analysis';
import { startMemoryRender, type MemoryRenderJob } from '@/lib/worker-memory-render';
import type { MemoryRenderResult } from '@/lib/memory-render';
import type { MemoryLoudnessResult } from '@/lib/memory-loudness.worker';
import { useMemorySpectrogram } from '@/lib/use-memory-spectrogram';
import { addRepairMark, MAX_REPAIR_MARKS, type RepairMark } from '@/lib/repair-markers';
import type { LargeAnalysisResult } from '@/lib/large-analysis';
import './index.css';

type ViewTab = 'edit' | 'analyze' | 'project';
type StatisticsOrientation = 'horizontal' | 'vertical';
type MonitorMode = 'current' | 'original';
type Marker = { id: string; time: number; label: string; color: string };
type Region = { id: string; start: number; end: number; label: string };
type SpectralBounds = { start: number; end: number; low: number; high: number };
type LargeSource = { file: File; metadata: AudioMetadata; fingerprint: string; fileHandle?: FileSystemFileHandle };
type HumEvent = MemoryRenderResult['events'][number];
type LiveHum = { source: AudioSource; chain: EditModule[]; frequencies: Record<string, number[]> };
type SpectrogramView = {
  left: SpectrogramData;
  right: SpectrogramData;
  startSeconds: number;
  durationSeconds: number;
  loading?: boolean;
  error?: string;
};

const MODULE_TYPES = ['gain', 'fade', 'low-rumble', 'hum', 'wind', 'noise', 'click-pop', 'spectral-repair'] as const;
type AddModuleType = typeof MODULE_TYPES[number];
const moduleOptionLabel = (type: AddModuleType) => type === 'low-rumble' ? 'Low Rumble Removal' : MODULE_LABELS[type];
const SAVE_PROJECT_DESCRIPTION = 'Save edits, markers, trim, and notes in this browser. No WAV is downloaded; use Export for audio.';
const SPECTROGRAM_LEFT = 48;
const SPECTROGRAM_RIGHT = 72;
const SPECTROGRAM_BOTTOM = 42;
const SPECTROGRAM_MAX_CEILING_DB = 24;
const SPECTROGRAM_DATA_FLOOR_DB = -180;
const SPECTROGRAM_DATA_CEILING_DB = 0;
const SPECTROGRAM_MIN_LEVEL_SPAN_DB = 10;
const SPECTROGRAM_MAX_LEVEL_SPAN_DB = 180;
const SPECTROGRAM_DISPLAY_HEIGHT = 110;
const HUM_MARKER_COLORS = ['#d8ed55', '#75d7ef', '#ffaf78', '#d7a7fa'];
const EMPTY_STATS: LoudnessStats = { truePeakDbtp: -Infinity, integratedLufs: -Infinity, loudnessRangeLu: NaN, maxShortTermLufs: -Infinity, plrLu: NaN, lbpr: { valueDb: NaN, channels: [] } };
const EMPTY_SPECTROGRAM = { width: 480, height: 110, values: new Float32Array(480 * 110) };

const EMPTY_CHANNELS: Float32Array[] = [];
function formatTime(seconds: number, precise = false) {
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  const remaining = safe - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remaining.toFixed(precise ? 3 : 1).padStart(precise ? 6 : 4, '0')}`;
}

function validTrim(range: [number, number] | undefined | null, duration: number): [number, number] | null {
  if (!range || !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || duration <= 0) return null;
  const start = Math.max(0, Math.min(duration, range[0]));
  const end = Math.max(start, Math.min(duration, range[1]));
  return end - start >= 1 / 192000 ? [start, end] : null;
}

async function warmFileProcessor(
  file: File, metadata: AudioMetadata, processor: ReturnType<typeof createStreamingEditChain>,
  start: number, end: number, signal?: AbortSignal, cancelled?: () => boolean,
) {
  const chunkFrames = Math.max(4096, metadata.sampleRate * 2);
  for (let frame = start; frame < end; frame += chunkFrames) {
    if (signal?.aborted || cancelled?.()) throw new DOMException('Processing cancelled.', 'AbortError');
    const count = Math.min(chunkFrames, end - frame);
    const channels = await readAudioFrames(file, metadata, frame, count, { signal });
    if (signal?.aborted || cancelled?.()) throw new DOMException('Processing cancelled.', 'AbortError');
    processor.process(channels, frame);
  }
}

function formatLevel(value: number, unit: 'dBTP' | 'LUFS' | 'LU') {
  if (!Number.isFinite(value)) return `-∞ ${unit}`;
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} ${unit}`;
}
function formatLra(value: number) {
  return Number.isFinite(value) ? formatLevel(value, 'LU') : 'N/A';
}

function moduleSummary(module: EditModule, humReadout?: ReturnType<typeof humOpeningReadout>) {
  const p = module.params;
  return module.type === 'gain' ? `${p.db} dB`
    : module.type === 'spectral-repair' ? `${p.mode} · ${Number(p.start).toFixed(2)}–${Number(p.end).toFixed(2)} s · ${Math.round(Number(p.low))}–${Math.round(Number(p.high))} Hz`
    : module.type === 'hum' ? humReadout?.summary ?? `${p.mode} · ${p.frequency} Hz`
      : module.type === 'wind' ? `${isFixedLowRumble(module) ? `HPF ${p.cutoff} Hz` : `Auto · ${p.detection ?? 'Medium'} detection · ${p.removal ?? 'Medium'} removal`} · ${lowEndShelfEnabled(p) ? `Low end ${Number(p.lowEndGain) >= 0 ? '+' : ''}${p.lowEndGain} dB · ${lowEndShelfFollowsWind(p) ? 'detected wind only' : 'whole recording'}` : 'Low end off'}`
        : module.type === 'noise' ? `${p.mode === 'Sample' ? 'Noise-only sample' : 'Auto'} · ${p.strength ?? 50}% strength`
        : module.type === 'click-pop' ? `Automatic · ${p.strength ?? 50}% strength`
        : module.type === 'eq' && p.mode === 'low-shelf' ? `${p.gain} dB · ${p.frequency} Hz`
          : module.type === 'fade' ? `${Number(p.inEnabled) === 0 ? 'In off' : `${p.in} s in`} · ${Number(p.outEnabled) === 0 ? 'Out off' : `${p.out} s out`}`
            : module.type;
}

function App() {
  const [source, setSource] = useState<AudioSource>(() => createDemoAudio());
  const [modules, setModules] = useState<EditModule[]>(makeDefaultChain);
  const [undoStack, setUndoStack] = useState<EditModule[][]>([]);
  const [redoStack, setRedoStack] = useState<EditModule[][]>([]);
  const [selection, setSelection] = useState<[number, number]>([4.1, 7.8]);
  const [spectralSelectionMode, setSpectralSelectionMode] = useState(false);
  const [spectralSelection, setSpectralSelection] = useState<SpectralBounds | null>(null);
  const [spectralError, setSpectralError] = useState('');
  const [trim, setTrim] = useState<[number, number] | null>(null);
  const [committedTrim, setCommittedTrim] = useState<[number, number] | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [activeTab, setActiveTab] = useState<ViewTab>('edit');
  const [statisticsOrientation, setStatisticsOrientation] = useState<StatisticsOrientation>(() =>
    localStorage.getItem('field-restore-statistics-orientation') === 'vertical' ? 'vertical' : 'horizontal');
  const [zoom, setZoom] = useState(1);
  const [playHead, setPlayHead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [liveHum, setLiveHum] = useState<LiveHum | null>(null);
  const [liveWind, setLiveWind] = useState<{ source: AudioSource; chain: EditModule[]; events: Array<{ moduleId: string; frame: number; active: boolean }> } | null>(null);
  const [humHistory, setHumHistory] = useState<{ source: AudioSource; chain: EditModule[]; segments: HumHistorySegment[] } | null>(null);
  const [windHistory, setWindHistory] = useState<{ source: AudioSource; chain: EditModule[]; segments: WindHistorySegment[] } | null>(null);
  const [fileRepairs, setFileRepairs] = useState<{ source: AudioSource; chain: EditModule[]; marks: RepairMark[] } | null>(null);
  const [selectedRepair, setSelectedRepair] = useState<RepairMark | null>(null);
  const humHistoryRef = useRef<HumHistorySegment[]>([]);
  const humHistoryOwnerRef = useRef<{ source: AudioSource; chain: EditModule[] } | null>(null);
  const lastHistoryPublishRef = useRef(0);
  const windHistoryRef = useRef<WindHistorySegment[]>([]);
  const windHistoryOwnerRef = useRef<{ source: AudioSource; chain: EditModule[] } | null>(null);
  const lastWindHistoryPublishRef = useRef(0);
  const [loop, setLoop] = useState(false);
  const [rate, setRate] = useState(1);
  const [monitor, setMonitor] = useState<MonitorMode>('current');
  const [spectrogramSource, setSpectrogramSource] = useState<MonitorMode>('current');
  const [moduleMenu, setModuleMenu] = useState(false);
  const sidebarAddRef = useRef<HTMLButtonElement>(null);
  const [sidebarMenuPosition, setSidebarMenuPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const [chainPresets, setChainPresets] = useState<ChainPreset[]>([]);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetError, setPresetError] = useState('');
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [draggedModuleId, setDraggedModuleId] = useState<string | null>(null);
  const [moduleDropTarget, setModuleDropTarget] = useState<{ id: string; edge: 'before' | 'after' } | null>(null);
  const [chainDrawerOpen, setChainDrawerOpen] = useState(false);
  const [modal, setModal] = useState<'export' | 'help' | 'settings' | null>(null);
  const modalOpenerRef = useRef<HTMLElement | null>(null);
  const openModal = (event: ReactMouseEvent<HTMLButtonElement>, name: 'export' | 'help' | 'settings') => {
    modalOpenerRef.current = event.currentTarget;
    setModal(name);
  };
  useEffect(() => {
    if (!modal && !presetDialogOpen) return;
    const dialog = document.querySelector<HTMLElement>('.modal-backdrop .modal-card[role="dialog"]');
    const opener = modalOpenerRef.current;
    dialog?.querySelector<HTMLElement>(presetDialogOpen ? '#preset-name' : 'button:not([disabled])')?.focus();
    const handleModalKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (presetDialogOpen) setPresetDialogOpen(false);
        else setModal(null);
      } else if (event.key === 'Tab' && dialog) {
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first) {
          event.preventDefault();
          dialog.focus();
        } else if (event.shiftKey && (!dialog.contains(document.activeElement) || document.activeElement === first || document.activeElement === dialog)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (!dialog.contains(document.activeElement) || document.activeElement === last)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handleModalKeyDown);
    return () => {
      window.removeEventListener('keydown', handleModalKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, [modal, presetDialogOpen]);
  const [title, setTitle] = useState('Coastal dawn / north bluff');
  const [notes, setNotes] = useState('Low-tide ambience. Keep the distant tern call at 07:48 intact.');
  const [what3wordsAddress, setWhat3wordsAddress] = useState('');
  const [descriptiveWords, setDescriptiveWords] = useState<string[]>([]);
  const [savedStatus, setSavedStatus] = useState('Local session');
  const [restoredProject, setRestoredProject] = useState(false);
  const [error, setError] = useState('');
  const [isDraggingWav, setIsDraggingWav] = useState(false);
  useEffect(() => {
    try {
      setChainPresets(readChainPresets(localStorage));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to read saved presets.');
    }
  }, []);
  const chainDrawerRef = useRef<HTMLElement>(null);
  const chainDrawerOpenerRef = useRef<HTMLButtonElement>(null);
  const [spectrogramMinFrequency, setSpectrogramMinFrequency] = useState(0);
  const [spectrogramMaxFrequency, setSpectrogramMaxFrequency] = useState(20000);
  useEffect(() => {
    const nyquist = Math.floor(source.sampleRate / 2);
    const minimumSpan = Math.min(500, nyquist);
    setSpectrogramMinFrequency((minimum) => Math.max(0, Math.min(minimum, nyquist - minimumSpan)));
    setSpectrogramMaxFrequency((maximum) => Math.min(nyquist, Math.max(minimumSpan, maximum)));
  }, [source.sampleRate]);
  const [spectrogramCeilingDb, setSpectrogramCeilingDb] = useState(-20);
  const [spectrogramLevelSpanDb, setSpectrogramLevelSpanDb] = useState(85);
  const [spectrogramPalette, setSpectrogramPalette] = useState<SpectrogramPaletteId>(() => {
    const saved = localStorage.getItem('field-restore-spectrogram-palette');
    return saved && saved in SPECTROGRAM_PALETTES ? saved as SpectrogramPaletteId : DEFAULT_SPECTROGRAM_PALETTE;
  });
  const [timeViewCenter, setTimeViewCenter] = useState<number | null>(null);
  const [largeSource, setLargeSource] = useState<LargeSource | null>(null);
  const [sourceFingerprint, setSourceFingerprint] = useState<string | null>(null);
  const noiseCaptureOwnerRef = useRef<{ source: AudioSource; file: LargeSource | null; modules: EditModule[] } | null>(null);
  noiseCaptureOwnerRef.current = { source, file: largeSource, modules };
  const [largeSpectrograms, setLargeSpectrograms] = useState<SpectrogramView>({
    left: EMPTY_SPECTROGRAM,
    right: EMPTY_SPECTROGRAM,
    startSeconds: 0,
    durationSeconds: source.duration,
  });
  const [largeOriginalSpectrograms, setLargeOriginalSpectrograms] = useState<SpectrogramView>({
    left: EMPTY_SPECTROGRAM,
    right: EMPTY_SPECTROGRAM,
    startSeconds: 0,
    durationSeconds: source.duration,
  });
  const [largeOriginalStats, setLargeOriginalStats] = useState<LoudnessStats>(EMPTY_STATS);
  const [largeCurrentStats, setLargeCurrentStats] = useState<LoudnessStats>(EMPTY_STATS);
  const [largeSelectionOriginalStats, setLargeSelectionOriginalStats] = useState<LoudnessStats>(EMPTY_STATS);
  const [largeSelectionCurrentStats, setLargeSelectionCurrentStats] = useState<LoudnessStats>(EMPTY_STATS);
  const selectedModule = modules.find((module) => module.id === selectedModuleId) ?? null;
  const automaticDcSelected = selectedModuleId === AUTOMATIC_DC_REMOVAL.id;

  const openChainDrawer = (event: ReactMouseEvent<HTMLButtonElement>, moduleId: string | null = null) => {
    chainDrawerOpenerRef.current = event.currentTarget;
    setSelectedModuleId(moduleId);
    setModuleMenu(false);
    setChainDrawerOpen(true);
  };

  useEffect(() => {
    if (!moduleMenu || chainDrawerOpen) return;
    const updatePosition = () => {
      const button = sidebarAddRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        setModuleMenu(false);
        return;
      }
      const margin = 8;
      const gap = 5;
      const width = Math.min(190, window.innerWidth - margin * 2);
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
      const above = Math.max(0, rect.top - gap - margin);
      const placeBelow = below >= above;
      const maxHeight = Math.min(420, placeBelow ? below : above);
      setSidebarMenuPosition({
        top: placeBelow ? rect.bottom + gap : rect.top - gap - maxHeight,
        left: Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin)),
        width,
        maxHeight,
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [moduleMenu, chainDrawerOpen]);

  useEffect(() => {
    if (!chainDrawerOpen) return;
    const drawer = chainDrawerRef.current;
    drawer?.focus();
    const handleDrawerKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setChainDrawerOpen(false);
        setModuleMenu(false);
      } else if (event.key === 'Tab' && drawer) {
        const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first) {
          event.preventDefault();
          drawer.focus();
        } else if (event.shiftKey && (!drawer.contains(document.activeElement) || document.activeElement === first || document.activeElement === drawer)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (!drawer.contains(document.activeElement) || document.activeElement === last)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handleDrawerKeyDown);
    return () => {
      window.removeEventListener('keydown', handleDrawerKeyDown);
      if (chainDrawerOpenerRef.current?.isConnected) chainDrawerOpenerRef.current.focus();
      chainDrawerOpenerRef.current = null;
    };
  }, [chainDrawerOpen]);

  useEffect(() => {
    if (selectedModuleId && selectedModuleId !== AUTOMATIC_DC_REMOVAL.id && !modules.some((module) => module.id === selectedModuleId)) {
      setSelectedModuleId(null);
      setChainDrawerOpen(false);
    }
  }, [modules, selectedModuleId]);
  const [operationStatus, setOperationStatus] = useState('');
  const [operationProgress, setOperationProgress] = useState(0);
  const [operationPaused, setOperationPaused] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState('');
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [spectrogramStatus, setSpectrogramStatus] = useState('');
  const [spectrogramProgress, setSpectrogramProgress] = useState(0);
  const [analysisRequestId, setAnalysisRequestId] = useState(0);
  const [analysisResultId, setAnalysisResultId] = useState(0);
  const [spectrogramRequestId, setSpectrogramRequestId] = useState(0);
  const [spectrogramResultId, setSpectrogramResultId] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<ProjectRecord | null>(null);
  const [pendingRelink, setPendingRelink] = useState<ProjectRecord | null>(null);
  const [isRenewingPermission, setIsRenewingPermission] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasBounds, setCanvasBounds] = useState({ width: 0, height: 0 });
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const playHeadRef = useRef(0);
  const selectionRef = useRef<[number, number]>([4.1, 7.8]);
  const trimRef = useRef<[number, number] | null>(null);
  const pointerDragRef = useRef<{ start: number; current: number; startClientX: number; moved: boolean } | null>(null);
  const spectralDragRef = useRef<{ start: number; frequency: number; pane: number; moved: boolean } | null>(null);
  const frequencyDragRef = useRef<{ grabbedFrequency: number; paneTop: number; paneHeight: number; span: number } | null>(null);
  const levelDragRef = useRef<{
    grabbedLevel: number;
    graphHeight: number;
    span: number;
  } | null>(null);
  const timeDragRef = useRef<{
    grabbedTime: number;
    plotLeft: number;
    plotWidth: number;
    viewDuration: number;
    startClientX: number;
    moved: boolean;
  } | null>(null);
  const dragDepthRef = useRef(0);
  const analysisJobRef = useRef<WorkerJob<LargeAnalysisResult> | null>(null);
  const spectrogramJobRef = useRef<Array<WorkerJob<SpectrogramData>>>([]);
  const analysisGenerationRef = useRef(0);
  const analysisCacheRef = useRef<{
    source: LargeSource | null;
    original?: LargeAnalysisResult;
    current?: { modules: EditModule[]; start: number; end: number; stats: LargeAnalysisResult };
    selectionOriginal?: { start: number; end: number; stats: LargeAnalysisResult };
    selectionCurrent?: { modules: EditModule[]; start: number; end: number; selectionStart: number; selectionEnd: number; stats: LoudnessStats };
  }>({ source: null });
  const spectrogramGenerationRef = useRef(0);
  const backgroundPausedRef = useRef(false);
  const exportJobRef = useRef<AbortController | null>(null);
  const memoryJobRef = useRef<{ source: AudioSource; chain: EditModule[]; job: MemoryRenderJob } | null>(null);
  const spectralPatchCacheRef = useRef<{
    source: LargeSource; chain: EditModule[]; patches?: SpectralRepairPatches; pending?: Promise<SpectralRepairPatches>;
  } | null>(null);
  const pendingMemoryPlaybackRef = useRef(false);
  const monitorRef = useRef<MonitorMode>(monitor);
  const [memoryResult, setMemoryResult] = useState<{ source: AudioSource; chain: EditModule[]; result: MemoryRenderResult } | null>(null);
  const [memoryRenderError, setMemoryRenderError] = useState('');
  const [memoryLoudness, setMemoryLoudness] = useState<{
    source: AudioSource; channels: Float32Array[]; start: number; end: number;
    selectionStart: number; selectionEnd: number; result: MemoryLoudnessResult;
  } | null>(null);
  const [memoryLoudnessError, setMemoryLoudnessError] = useState('');
  const scheduledNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const playbackSessionRef = useRef(0);
  const restoreTrim = useCallback((range: [number, number] | undefined | null, length: number) => {
    const next = validTrim(range, length);
    trimRef.current = next;
    setTrim(next);
    setCommittedTrim(next);
  }, []);

  const processingModules = useMemo(() => withFadeRange(
    makeProcessingChain(modules),
    Math.floor((committedTrim?.[0] ?? 0) * source.sampleRate),
    Math.min(Math.floor(source.duration * source.sampleRate), Math.ceil((committedTrim?.[1] ?? source.duration) * source.sampleRate)),
  ), [modules, committedTrim, source.sampleRate, source.duration]);
  const getSpectralPatches = useCallback(async (signal?: AbortSignal): Promise<SpectralRepairPatches> => {
    if (!largeSource) return {};
    const cached = spectralPatchCacheRef.current;
    if (cached?.source === largeSource && cached.chain === processingModules) {
      if (cached.patches) return cached.patches;
      if (cached.pending && !signal) return cached.pending;
    }
    const pending = prepareSpectralRepairsInWorker(largeSource.file, largeSource.metadata, processingModules, signal);
    if (!signal) spectralPatchCacheRef.current = { source: largeSource, chain: processingModules, pending };
    try {
      const patches = await pending;
      if (!signal?.aborted) spectralPatchCacheRef.current = { source: largeSource, chain: processingModules, patches };
      return patches;
    } catch (caught) {
      if (spectralPatchCacheRef.current?.pending === pending) spectralPatchCacheRef.current = null;
      throw caught;
    }
  }, [largeSource, processingModules]);
  useEffect(() => {
    humHistoryRef.current = [];
    humHistoryOwnerRef.current = null;
    setHumHistory(null);
    windHistoryRef.current = [];
    windHistoryOwnerRef.current = null;
    setWindHistory(null);
    setLiveHum(null);
    setLiveWind(null);
    setFileRepairs(null);
    setSelectedRepair(null);
  }, [source, processingModules]);
  useEffect(() => {
    setSpectralSelection(null);
    setSpectralError('');
  }, [source]);
  const recordHeardHum = useCallback((moduleId: string, frame: number, frequencies: number[], sampleRate: number) => {
    const previous = humHistoryRef.current;
    const next = recordHumHistory(previous, moduleId, frame, frequencies, sampleRate);
    if (next === previous) return;
    humHistoryRef.current = next;
    humHistoryOwnerRef.current = { source, chain: processingModules };
    const now = performance.now();
    if (next.length !== previous.length || now - lastHistoryPublishRef.current > 250) {
      setHumHistory({ source, chain: processingModules, segments: next });
      lastHistoryPublishRef.current = now;
    }
  }, [source, processingModules]);
  const flushHumHistory = useCallback(() => {
    if (humHistoryOwnerRef.current) setHumHistory({ ...humHistoryOwnerRef.current, segments: humHistoryRef.current });
  }, []);
  const recordHeardWind = useCallback((moduleId: string, frame: number, active: boolean, sampleRate: number, startNewVisit = false) => {
    const previous = windHistoryRef.current;
    const next = recordWindHistory(previous, moduleId, frame, active, sampleRate, startNewVisit);
    if (next === previous) return;
    windHistoryRef.current = next;
    windHistoryOwnerRef.current = { source, chain: processingModules };
    const previousVisit = previous.findLast((segment) => segment.moduleId === moduleId);
    const nextVisit = next.findLast((segment) => segment.moduleId === moduleId);
    const newVisit = !previousVisit || !nextVisit || previousVisit.startFrame !== nextVisit.startFrame ||
      previousVisit.active !== nextVisit.active;
    const now = performance.now();
    if (newVisit || now - lastWindHistoryPublishRef.current > 250) {
      setWindHistory({ source, chain: processingModules, segments: next });
      lastWindHistoryPublishRef.current = now;
    }
  }, [source, processingModules]);
  const flushWindHistory = useCallback(() => {
    if (windHistoryOwnerRef.current) setWindHistory({ ...windHistoryOwnerRef.current, segments: windHistoryRef.current });
  }, []);
  const historySegments = humHistory?.source === source && humHistory.chain === processingModules ? humHistory.segments : [];
  const windHistorySegments = windHistory?.source === source && windHistory.chain === processingModules ? windHistory.segments : [];
  const [fileHumScan, setFileHumScan] = useState<{
    source: LargeSource; chain: EditModule[]; frequencies: number[][]; error: boolean;
  } | null>(null);
  useEffect(() => {
    if (largeSource || !source.channels.length) return;
    const job = startMemoryRender(source.channels, processingModules, source.sampleRate);
    memoryJobRef.current = { source, chain: processingModules, job };
    setMemoryRenderError('');
    void job.promise.then((result) => {
      setMemoryResult({ source, chain: processingModules, result });
    }).catch((caught: unknown) => {
      if (caught instanceof Error && caught.name !== 'AbortError') setMemoryRenderError(caught.message);
    });
    return () => {
      job.cancel();
      if (memoryJobRef.current?.job === job) memoryJobRef.current = null;
    };
  }, [largeSource, source, processingModules]);
  const memoryRender = memoryResult?.source === source && memoryResult.chain === processingModules && !largeSource
    ? memoryResult.result : null;
  const memoryHumFrequencies = memoryRender?.frequencies ?? EMPTY_FREQUENCIES;
  const repairMarks = largeSource
    ? fileRepairs?.source === source && fileRepairs.chain === processingModules ? fileRepairs.marks : []
    : memoryRender?.repairs ?? [];
  useEffect(() => {
    if (!largeSource || !processingModules.some((module) =>
      module.enabled && module.type === 'hum' && module.params.mode !== 'Static' && Number(module.params.reduction) > 0)) return;
    let cancelled = false;
    void analyzeFileInitialHum(largeSource.file, largeSource.metadata, processingModules)
      .then((frequencies) => {
        if (!cancelled) setFileHumScan({ source: largeSource, chain: processingModules, frequencies, error: false });
      })
      .catch(() => {
        if (!cancelled) setFileHumScan({ source: largeSource, chain: processingModules, frequencies: [], error: true });
      });
    return () => { cancelled = true; };
  }, [largeSource, processingModules]);
  const humReadoutFor = (module: EditModule) => {
    const index = processingModules.findIndex((entry) => entry.id === module.id);
    const hasSource = largeSource || source.channels.length > 0;
    const enoughFrames = hasSource && humPrefixFrames(source.sampleRate,
      largeSource?.metadata.frameCount ?? source.channels[0]?.length ?? 0) === 2 * humAnalysisWindowSize(source.sampleRate);
    const scanCurrent = largeSource
      ? fileHumScan?.source === largeSource && fileHumScan.chain === processingModules
      : !!memoryRender;
    const state: HumScanState = !hasSource ? 'unavailable' : !enoughFrames ? 'too-short'
      : memoryRenderError && !largeSource ? 'error' : !scanCurrent ? 'loading' : fileHumScan?.error && largeSource ? 'error' : 'complete';
    return humOpeningReadout(module, state, largeSource ? (scanCurrent ? fileHumScan?.frequencies[index] : undefined) : memoryHumFrequencies[index]);
  };
  const liveHumFrequencies = isPlaying && monitor === 'current' &&
    liveHum?.source === source && liveHum.chain === processingModules ? liveHum.frequencies : null;
  const currentChannels = memoryRender?.channels ?? EMPTY_CHANNELS;
  const windActivityFor = (moduleId: string) => {
    if (!isPlaying || monitor !== 'current') return null;
    const events = largeSource
      ? (liveWind?.source === source && liveWind.chain === processingModules ? liveWind.events : [])
      : memoryRender?.windEvents ?? [];
    return largeSource
      ? windActivityAt(events, moduleId, playHead * source.sampleRate)
      : windActivityAtSorted(events, moduleId, playHead * source.sampleRate);
  };
  const windHistoryFor = (moduleId: string) => windHistorySegments.filter((segment) => segment.moduleId === moduleId);
  const duration = source.duration;
  const trimStart = trim?.[0] ?? 0;
  const trimEnd = trim?.[1] ?? duration;
  const committedTrimStart = committedTrim?.[0] ?? 0;
  const committedTrimEnd = committedTrim?.[1] ?? duration;
  const sourceChannelCount = largeSource?.metadata.channels ?? Number(pendingRelink?.source.channels ?? source.channels.length);
  const viewDuration = duration / zoom;
  const selectionStart = Math.min(...selection);
  const selectionEnd = Math.max(...selection);
  const hasSelection = selectionEnd - selectionStart >= 0.01;
  const selectionCenter = selectionStart + (selectionEnd - selectionStart) / 2 || duration / 2;
  const viewCenter = timeViewCenter ?? selectionCenter;
  const viewStart = zoom === 1 ? 0 : Math.max(0, Math.min(duration - viewDuration, viewCenter - viewDuration / 2));
  const visibleHumSegments = useMemo(
    () => visibleHumHistory(historySegments, source.sampleRate, viewStart, viewDuration),
    [historySegments, source.sampleRate, viewStart, viewDuration],
  );
  const visibleRepairs = repairMarks.filter((mark) => mark.frame / source.sampleRate >= viewStart &&
    mark.frame / source.sampleRate <= viewStart + viewDuration &&
    mark.frame / source.sampleRate >= committedTrimStart && mark.frame / source.sampleRate <= committedTrimEnd);
  useEffect(() => {
    if (largeSource || !memoryRender) return;
    // Debounce selection drags to avoid copying the same recording into many superseded workers.
    let worker: Worker | null = null;
    const timer = window.setTimeout(() => {
      worker = new Worker(new URL('./lib/memory-loudness.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ type: 'result'; result: MemoryLoudnessResult } | { type: 'error'; message: string }>) => {
        if (event.data.type === 'result') {
          setMemoryLoudness({ source, channels: currentChannels, start: committedTrimStart, end: committedTrimEnd,
            selectionStart, selectionEnd, result: event.data.result });
          setMemoryLoudnessError('');
        } else setMemoryLoudnessError(event.data.message);
        worker?.terminate();
      };
      worker.onerror = (event) => { setMemoryLoudnessError(event.message || 'Loudness analysis failed.'); worker?.terminate(); };
      worker.postMessage({ original: source.channels, current: currentChannels, sampleRate: source.sampleRate,
        kept: [committedTrimStart * source.sampleRate, committedTrimEnd * source.sampleRate],
        selection: hasSelection ? [selectionStart * source.sampleRate, selectionEnd * source.sampleRate] : null });
    }, 100);
    return () => { window.clearTimeout(timer); worker?.terminate(); };
  }, [largeSource, memoryRender, source, currentChannels, committedTrimStart, committedTrimEnd, selectionStart, selectionEnd, hasSelection]);
  const spectrogramFloorDb = spectrogramCeilingDb - spectrogramLevelSpanDb;
  const [memorySpectrogramView, setMemorySpectrogramView] = useState(() => ({
    startSeconds: viewStart,
    durationSeconds: viewDuration,
  }));
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setMemorySpectrogramView((current) => (
        current.startSeconds === viewStart && current.durationSeconds === viewDuration
          ? current
          : { startSeconds: viewStart, durationSeconds: viewDuration }
      ));
    }, 100);
    return () => window.clearTimeout(timer);
  }, [viewDuration, viewStart]);
  const memorySpectrograms = useMemorySpectrogram(largeSource ? EMPTY_CHANNELS : currentChannels, source.sampleRate, memorySpectrogramView);
  const memoryOriginalSpectrograms = useMemorySpectrogram(largeSource ? EMPTY_CHANNELS : source.channels, source.sampleRate, memorySpectrogramView);
  const spectrograms = spectrogramSource === 'original'
    ? (largeSource ? largeOriginalSpectrograms : memoryOriginalSpectrograms)
    : (largeSource ? largeSpectrograms : memorySpectrograms);
  const currentMemoryLoudness = memoryLoudness?.source === source && memoryLoudness.channels === currentChannels &&
    memoryLoudness.start === committedTrimStart && memoryLoudness.end === committedTrimEnd &&
    memoryLoudness.selectionStart === selectionStart && memoryLoudness.selectionEnd === selectionEnd ? memoryLoudness.result : null;
  const memoryOriginalStats = currentMemoryLoudness?.original ?? EMPTY_STATS;
  const memoryCurrentStats = currentMemoryLoudness?.current ?? EMPTY_STATS;
  const memorySelectionOriginalStats = currentMemoryLoudness?.selectionOriginal ?? EMPTY_STATS;
  const memorySelectionCurrentStats = currentMemoryLoudness?.selectionCurrent ?? EMPTY_STATS;
  const originalStats = largeSource ? largeOriginalStats : memoryOriginalStats;
  const currentStats = largeSource ? largeCurrentStats : memoryCurrentStats;
  const selectionOriginalStats = largeSource ? largeSelectionOriginalStats : memorySelectionOriginalStats;
  const selectionCurrentStats = largeSource ? largeSelectionCurrentStats : memorySelectionCurrentStats;
  const displayedStats = spectrogramSource === 'original' ? originalStats : currentStats;
  const displayedSelectionStats = spectrogramSource === 'original' ? selectionOriginalStats : selectionCurrentStats;
  const displayedSourceLabel = spectrogramSource === 'original' ? 'Original' : 'Edited';
  const statisticsPending = Boolean(largeSource && analysisRequestId !== analysisResultId) ||
    Boolean(!largeSource && !currentMemoryLoudness);
  const statisticsUnavailableLabel = !largeSource && !currentMemoryLoudness
    ? memoryRenderError || memoryLoudnessError ? `Statistics unavailable: ${memoryRenderError || memoryLoudnessError}` : 'Calculating statistics…'
    : analysisStatus ? 'Calculating statistics…' : 'Statistics unavailable';

  const stageSavedProject = useCallback((record: ProjectRecord) => {
    setRestoredProject(true);
    setProjectId(null);
    setTitle(record.title);
    setNotes(record.notes);
    setWhat3wordsAddress(record.what3wordsAddress ?? '');
    setDescriptiveWords(record.descriptiveWords ?? []);
    setModules([]);
    setMarkers([]);
    setRegions([]);
    restoreTrim(record.trim, Number(record.source.duration ?? 0));
    setLargeSource(null);
    setSourceFingerprint(null);
    setUndoStack([]);
    setRedoStack([]);
    setSource({ channels: [], sampleRate: record.source.sampleRate, duration: Number(record.source.duration ?? 0), name: record.source.name });
  }, [restoreTrim]);

  const restoreVerifiedProject = useCallback((record: ProjectRecord, verified: Awaited<ReturnType<typeof openVerifiedFileHandle>>) => {
    if (!record.fileHandle || !verified) return false;
    const { file, metadata, fingerprint } = verified;
    setLargeSource({ file, metadata, fingerprint, fileHandle: record.fileHandle });
    setSourceFingerprint(fingerprint);
    setUndoStack([]);
    setRedoStack([]);
    setSource({ channels: [], sampleRate: metadata.sampleRate, duration: metadata.frameCount / metadata.sampleRate, name: file.name });
    setModules(withoutLegacyDcModules(record.modules));
    setMarkers(record.markers);
    setRegions(record.regions);
    restoreTrim(record.trim, metadata.frameCount / metadata.sampleRate);
    setTitle(record.title);
    setNotes(record.notes);
    setWhat3wordsAddress(record.what3wordsAddress ?? '');
    setDescriptiveWords(record.descriptiveWords ?? []);
    setProjectId(record.id);
    setRestoredProject(true);
    setPendingPermission(null);
    setPendingRelink(null);
    setSelection([0, Math.min(5, metadata.frameCount / metadata.sampleRate)]);
    setSavedStatus(`Restored file-backed project${record.modules.some(isLegacyWind) ? ' · Wind Removal converted to automatic' : ''} · ${new Date(record.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    return true;
  }, [restoreTrim]);

  useEffect(() => {
    const saved = loadProject();
    if (saved?.originalBase64?.length && saved.originalLength) {
      setRestoredProject(true);
      const channels = decodeChannels(saved.originalBase64, saved.originalLength);
      const next: AudioSource = { channels, sampleRate: saved.sampleRate, duration: channels[0].length / saved.sampleRate, name: saved.sourceName };
      setSourceFingerprint(saved.sourceFingerprint ?? null);
      setSource(next); setTitle(saved.title); setNotes(saved.notes); setWhat3wordsAddress(saved.what3wordsAddress ?? ''); setDescriptiveWords(saved.descriptiveWords ?? []); setModules(withoutLegacyDcModules(saved.modules)); setMarkers(saved.markers); setRegions(saved.regions); restoreTrim(saved.trim, next.duration);
      setSavedStatus(`Restored${saved.modules.some(isLegacyWind) ? ' · Wind Removal converted to automatic' : ''} ${new Date(saved.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    } else if (saved?.original?.length) {
      setRestoredProject(true);
      const channels = saved.original.map((channel) => new Float32Array(channel));
      const next: AudioSource = { channels, sampleRate: saved.sampleRate, duration: channels[0].length / saved.sampleRate, name: saved.sourceName };
      setSourceFingerprint(saved.sourceFingerprint ?? null);
      setSource(next); setTitle(saved.title); setNotes(saved.notes); setWhat3wordsAddress(saved.what3wordsAddress ?? ''); setDescriptiveWords(saved.descriptiveWords ?? []); setModules(withoutLegacyDcModules(saved.modules)); setMarkers(saved.markers); setRegions(saved.regions); restoreTrim(saved.trim, next.duration);
      setSavedStatus(`Restored${saved.modules.some(isLegacyWind) ? ' · Wind Removal converted to automatic' : ''} ${new Date(saved.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    }
    void listProjects().then(async (projects) => {
      const latest = projects[0];
      if (!latest) return;
      const record = await loadProjectV2(latest.id);
      if (!record) return;
       stageSavedProject(record);
       if (!record.fileHandle) {
         setPendingRelink(record);
         setSavedStatus('Saved project loaded · relink source audio');
         return;
       }
       let permission: PermissionState;
       try {
         permission = await queryFileHandlePermission(record.fileHandle);
       } catch {
         setPendingRelink(record);
         setSavedStatus('Saved project loaded · relink source audio');
         return;
       }
       if (permission === 'prompt') {
         setPendingPermission(record);
         setSavedStatus('Saved project loaded · file access needed');
         return;
       }
       if (permission === 'granted') {
         const verified = await openVerifiedFileHandle(record.fileHandle, record.source.fingerprint ?? '');
         if (restoreVerifiedProject(record, verified)) return;
       }
       setPendingRelink(record);
       setSavedStatus('Saved project loaded · relink source audio');
    }).catch(() => {
      // Legacy localStorage restoration remains available when IndexedDB is unavailable.
    });
  }, [restoreTrim, restoreVerifiedProject, stageSavedProject]);

  useEffect(() => {
    if (!largeSource) return;
    let jobs: Array<WorkerJob<SpectrogramData>> = [];
    const timer = window.setTimeout(() => {
      const generation = ++spectrogramGenerationRef.current;
      setSpectrogramRequestId(generation);
      spectrogramJobRef.current.forEach((job) => job.cancel());
      const { file, metadata } = largeSource;
      const options = {
        startSeconds: viewStart,
        durationSeconds: viewDuration,
        width: 256,
        height: SPECTROGRAM_DATA_HEIGHT,
        minimumFrequency: 0,
        maximumFrequency: metadata.sampleRate / 2,
        floorDb: SPECTROGRAM_DATA_FLOOR_DB,
        ceilingDb: SPECTROGRAM_DATA_CEILING_DB,
        fftSize: SPECTROGRAM_FFT_SIZE,
        // Stateful filters settle within this bounded prefix; keeping it fixed
        // avoids multiplying half a second of DSP by every visible column.
        warmupFrames: 2048,
      };
      setSpectrogramStatus('Building original spectrogram');
      setSpectrogramProgress(0);
      setOperationPaused(false);
      const originalLeftJob = startWorkerJob<SpectrogramData>(
        { kind: 'spectrogram', file, metadata, modules: [], options: { ...options, channelIndex: 0 } },
        (fraction) => { if (generation === spectrogramGenerationRef.current) setSpectrogramProgress(fraction / 2); },
      );
      const originalRightJob = startWorkerJob<SpectrogramData>(
        { kind: 'spectrogram', file, metadata, modules: [], options: { ...options, channelIndex: Math.min(1, metadata.channels - 1) } },
        (fraction) => { if (generation === spectrogramGenerationRef.current) setSpectrogramProgress(0.5 + fraction / 2); },
      );
      jobs = [originalLeftJob, originalRightJob];
      spectrogramJobRef.current = jobs;
      Promise.all([originalLeftJob.promise, originalRightJob.promise]).then(async ([left, right]) => {
        if (generation === spectrogramGenerationRef.current) {
          setLargeOriginalSpectrograms({
            left,
            right,
            startSeconds: options.startSeconds,
            durationSeconds: options.durationSeconds,
          });
          setSpectrogramStatus('Building edited spectrogram');
          setSpectrogramProgress(0);
          const patches = await getSpectralPatches();
          if (generation !== spectrogramGenerationRef.current) return;
          const editedLeftJob = startWorkerJob<SpectrogramData>(
            { kind: 'spectrogram', file, metadata, modules: processingModules, patches, options: { ...options, channelIndex: 0 } },
            (fraction) => { if (generation === spectrogramGenerationRef.current) setSpectrogramProgress(fraction / 2); },
          );
          const editedRightJob = startWorkerJob<SpectrogramData>(
            { kind: 'spectrogram', file, metadata, modules: processingModules, patches, options: { ...options, channelIndex: Math.min(1, metadata.channels - 1) } },
            (fraction) => { if (generation === spectrogramGenerationRef.current) setSpectrogramProgress(0.5 + fraction / 2); },
          );
          jobs = [editedLeftJob, editedRightJob];
          spectrogramJobRef.current = jobs;
          Promise.all([editedLeftJob.promise, editedRightJob.promise]).then(([editedLeft, editedRight]) => {
            if (generation !== spectrogramGenerationRef.current) return;
            setLargeSpectrograms({
              left: editedLeft,
              right: editedRight,
              startSeconds: options.startSeconds,
              durationSeconds: options.durationSeconds,
            });
            setSpectrogramResultId(generation);
            setSpectrogramStatus('');
            setSpectrogramProgress(1);
            spectrogramJobRef.current = [];
          }).catch((caught) => {
            if (generation === spectrogramGenerationRef.current && (caught as Error).name !== 'AbortError') {
              setSpectrogramStatus('');
              setError(caught instanceof Error ? caught.message : 'Unable to build the edited spectrogram.');
            }
          });
        }
      }).catch((caught) => {
        if (generation === spectrogramGenerationRef.current && (caught as Error).name !== 'AbortError') {
          setSpectrogramStatus('');
          setError(caught instanceof Error ? caught.message : 'Unable to build the visible spectrogram.');
        }
      });
    }, 100);
    return () => {
      window.clearTimeout(timer);
      if (jobs.length) {
        spectrogramGenerationRef.current += 1;
        jobs.forEach((job) => job.cancel());
      }
    };
  }, [getSpectralPatches, largeSource, processingModules, viewDuration, viewStart]);

  useEffect(() => {
    if (!largeSource) return;
    analysisJobRef.current?.cancel();
    const generation = ++analysisGenerationRef.current;
    setAnalysisRequestId(generation);
    if (analysisCacheRef.current.source !== largeSource) analysisCacheRef.current = { source: largeSource };
    const cache = analysisCacheRef.current;
    const { file, metadata } = largeSource;
    const selectionStartFrame = Math.max(0, Math.floor(selectionStart * metadata.sampleRate));
    const selectionFrames = Math.max(1, Math.min(metadata.frameCount - selectionStartFrame, Math.ceil((selectionEnd - selectionStart) * metadata.sampleRate)));
    const selectionEndFrame = selectionStartFrame + selectionFrames;
    const selectionMetadata = audioRange(metadata, selectionStartFrame, selectionFrames);
    const editedSelectionStartFrame = Math.max(selectionStartFrame, Math.floor(committedTrimStart * metadata.sampleRate));
    const editedSelectionEndFrame = Math.min(selectionStartFrame + selectionFrames, Math.ceil(committedTrimEnd * metadata.sampleRate));
    const startFrame = Math.floor(committedTrimStart * metadata.sampleRate);
    const endFrame = Math.min(metadata.frameCount, Math.ceil(committedTrimEnd * metadata.sampleRate));
    setAnalysisStatus(hasSelection ? 'Analyzing selection' : 'Analyzing original recording');
    setAnalysisProgress(0);
    setOperationPaused(false);
    const run = async (request: Parameters<typeof startWorkerJob<LargeAnalysisResult>>[0], stage: number) => {
      if (request.kind === 'loudness' && request.modules) {
        const patches = await getSpectralPatches();
        if (generation !== analysisGenerationRef.current) throw new DOMException('Stale analysis.', 'AbortError');
        request = { ...request, patches };
      }
      const job = startWorkerJob<LargeAnalysisResult>(
        request,
        (fraction) => {
          if (generation === analysisGenerationRef.current) {
            setAnalysisProgress((stage + Math.max(0, Math.min(1, fraction))) / (hasSelection ? 4 : 2));
          }
        },
      );
      analysisJobRef.current = job;
      if (backgroundPausedRef.current) job.pause();
      return job.promise;
    };
    if (!hasSelection) {
      setLargeSelectionOriginalStats(EMPTY_STATS);
      setLargeSelectionCurrentStats(EMPTY_STATS);
    }
    const cachedSelectionOriginal = cache.selectionOriginal?.start === selectionStartFrame && cache.selectionOriginal.end === selectionEndFrame
      ? cache.selectionOriginal.stats : null;
    const selectionAnalysis = hasSelection ? (cachedSelectionOriginal
      ? Promise.resolve(cachedSelectionOriginal)
      : run({ kind: 'loudness', file, metadata: selectionMetadata, frameOffset: selectionStartFrame }, 0)
    ).then((stats) => {
      if (generation !== analysisGenerationRef.current) throw new DOMException('Stale analysis.', 'AbortError');
      cache.selectionOriginal = { start: selectionStartFrame, end: selectionEndFrame, stats };
      setLargeSelectionOriginalStats(stats);
      setAnalysisProgress(1 / 4);
      setAnalysisStatus('Analyzing processed selection');
      if (editedSelectionEndFrame <= editedSelectionStartFrame) return EMPTY_STATS;
      const cachedSelectionCurrent = cache.selectionCurrent;
      if (cachedSelectionCurrent?.modules === processingModules && cachedSelectionCurrent.start === startFrame &&
        cachedSelectionCurrent.end === endFrame && cachedSelectionCurrent.selectionStart === selectionStartFrame &&
        cachedSelectionCurrent.selectionEnd === selectionEndFrame) return cachedSelectionCurrent.stats;
      const editedFrames = editedSelectionEndFrame - editedSelectionStartFrame;
      const editedMetadata = audioRange(metadata, editedSelectionStartFrame, editedFrames);
      const needsFullNoiseHistory = processingModules.some((module) =>
        module.enabled && module.type === 'noise' && Number(module.params.strength) > 0);
      const warmStart = committedTrimStart > 0 || needsFullNoiseHistory ? 0 : Math.max(0, editedSelectionStartFrame - metadata.sampleRate * 2);
      return run({
        kind: 'loudness',
        file,
        metadata: editedMetadata,
        modules: processingModules,
        sourceMetadata: metadata,
        frameOffset: editedSelectionStartFrame,
        sourceFrameCount: metadata.frameCount,
        warmup: warmStart < editedSelectionStartFrame
          ? { metadata, startFrame: warmStart, frameCount: editedSelectionStartFrame - warmStart }
          : undefined,
      }, 1);
    }).then((stats) => {
      if (generation !== analysisGenerationRef.current) throw new DOMException('Stale analysis.', 'AbortError');
      cache.selectionCurrent = { modules: processingModules, start: startFrame, end: endFrame, selectionStart: selectionStartFrame, selectionEnd: selectionEndFrame, stats };
      setLargeSelectionCurrentStats(stats);
      setAnalysisProgress(2 / 4);
    }) : Promise.resolve();
    void selectionAnalysis.then(() => {
      if (generation !== analysisGenerationRef.current) throw new DOMException('Stale analysis.', 'AbortError');
      setAnalysisStatus('Analyzing original recording');
      return cache.original ?? run({ kind: 'loudness', file, metadata }, hasSelection ? 2 : 0);
    }).then((stats) => {
      if (generation !== analysisGenerationRef.current) throw new DOMException('Stale analysis.', 'AbortError');
      cache.original = stats;
      setLargeOriginalStats(stats);
      setAnalysisProgress(hasSelection ? 3 / 4 : 1 / 2);
      setAnalysisStatus('Analyzing processed recording');
      const cachedCurrent = cache.current;
      if (cachedCurrent?.modules === processingModules && cachedCurrent.start === startFrame && cachedCurrent.end === endFrame) return cachedCurrent.stats;
      const trimmedMetadata = audioRange(metadata, startFrame, endFrame - startFrame);
      return run({ kind: 'loudness', file, metadata: trimmedMetadata, modules: processingModules, frameOffset: startFrame, sourceFrameCount: metadata.frameCount,
         sourceMetadata: metadata,
         warmup: startFrame > 0 ? { metadata, startFrame: 0, frameCount: startFrame } : undefined,
       }, hasSelection ? 3 : 1);
    }).then((stats) => {
      if (generation === analysisGenerationRef.current) {
        cache.current = { modules: processingModules, start: startFrame, end: endFrame, stats };
        setLargeCurrentStats(stats);
        setAnalysisResultId(generation);
        setAnalysisStatus('');
        setAnalysisProgress(1);
        analysisJobRef.current = null;
      }
    }).catch((caught) => {
      if (generation === analysisGenerationRef.current && (caught as Error).name !== 'AbortError') {
        setAnalysisStatus('');
        setError(caught instanceof Error ? caught.message : 'Unable to analyze this recording.');
      }
      if (generation === analysisGenerationRef.current) analysisJobRef.current = null;
    });
    return () => {
      if (generation === analysisGenerationRef.current) analysisGenerationRef.current += 1;
      analysisJobRef.current?.cancel();
    };
  }, [committedTrimEnd, committedTrimStart, getSpectralPatches, hasSelection, largeSource, processingModules, selectionEnd, selectionStart]);

  const pauseBackgroundWork = useCallback(() => {
    backgroundPausedRef.current = true;
    analysisJobRef.current?.pause();
    spectrogramJobRef.current.forEach((job) => job.pause());
    setOperationPaused(true);
  }, []);

  const resumeBackgroundWork = useCallback(() => {
    backgroundPausedRef.current = false;
    analysisJobRef.current?.resume();
    spectrogramJobRef.current.forEach((job) => job.resume());
    setOperationPaused(false);
  }, []);

  const cancelBackgroundWork = useCallback(() => {
    analysisGenerationRef.current += 1;
    spectrogramGenerationRef.current += 1;
    analysisJobRef.current?.cancel();
    spectrogramJobRef.current.forEach((job) => job.cancel());
    analysisJobRef.current = null;
    spectrogramJobRef.current = [];
    backgroundPausedRef.current = false;
    setOperationPaused(false);
    setAnalysisStatus('');
    setAnalysisProgress(0);
    setSpectrogramStatus('');
    setSpectrogramProgress(0);
  }, []);

  const stopPlayback = useCallback(() => {
    playbackSessionRef.current += 1;
    pendingMemoryPlaybackRef.current = false;
    setLiveHum(null);
    flushHumHistory();
    flushWindHistory();
    scheduledNodesRef.current.forEach((node) => {
      node.onended = null;
      try { node.stop(); } catch { /* already stopped */ }
      node.disconnect();
    });
    scheduledNodesRef.current = [];
    if (audioSourceRef.current) {
      audioSourceRef.current.onended = null;
      audioSourceRef.current.stop();
      audioSourceRef.current.disconnect();
    }
    audioSourceRef.current = null;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    setIsPlaying(false);
  }, [flushHumHistory, flushWindHistory]);
  const clearSelection = () => {
    stopPlayback();
    if (zoom > 1) setTimeViewCenter(viewStart + viewDuration / 2);
    selectionRef.current = [0, 0];
    setSelection([0, 0]);
    setSpectralSelection(null);
    setSpectralError('');
    playHeadRef.current = 0;
    setPlayHead(0);
  };

  const startPlayback = useCallback((channels: Float32Array[], startPosition: number) => {
    // Any new source, including Original A/B, supersedes a queued edited Play.
    pendingMemoryPlaybackRef.current = false;
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) { setError('This browser does not expose Web Audio playback.'); return; }
    const context = audioContextRef.current ?? new AudioContextClass();
    audioContextRef.current = context;
    if (audioSourceRef.current) {
      audioSourceRef.current.onended = null;
      audioSourceRef.current.stop();
      audioSourceRef.current.disconnect();
    }
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    const plan = createPlaybackRangePlan({
      duration,
      loop,
      sampleRate: source.sampleRate,
      selection: selectionRef.current,
      startPosition,
      totalFrames: channels[0]?.length ?? 0,
      trim: monitor === 'current' ? trimRef.current ?? undefined : undefined,
    });
    if (plan.emptySelection) { setError('Selection is outside the edited range. Clear the selection or move it inside the kept range to play.'); return; }
    const bufferLength = Math.max(1, plan.bufferEndFrame - plan.bufferStartFrame);
    const buffer = context.createBuffer(channels.length, bufferLength, source.sampleRate);
    channels.forEach((channel, index) => buffer.getChannelData(index).set(channel.subarray(plan.bufferStartFrame, plan.bufferEndFrame)));
    const node = context.createBufferSource();
    node.buffer = buffer; node.playbackRate.value = rate; node.connect(context.destination);
    const startedAt = context.currentTime;
    node.loop = loop;
    node.loopStart = plan.bufferLoopStart;
    node.loopEnd = plan.bufferLoopEnd;
    node.onended = () => {
      if (!loop && audioSourceRef.current === node) {
        playHeadRef.current = plan.timelineEnd;
        setPlayHead(plan.timelineEnd);
        setIsPlaying(false);
        setLiveHum(null);
        flushHumHistory();
        flushWindHistory();
        audioSourceRef.current = null;
      }
    };
    node.start(0, plan.bufferStartOffset);
    audioSourceRef.current = node; setIsPlaying(true);
    setLiveHum(null);
    const windModules = monitor === 'current' ? processingModules.filter((module) =>
      module.enabled && module.type === 'wind' && !isFixedLowRumble(module)) : [];
    const memoryWindEvents = memoryRender?.windEvents ?? [];
    const heardWindActivity = new Map<string, boolean>();
    const windVisitsStarted = new Set<string>();
    let windEventIndex = 0;
    let previousWindFrame = -1;
    const tick = () => {
      if (audioSourceRef.current !== node) return;
      const elapsed = (context.currentTime - startedAt) * rate;
      const position = playbackPositionAtElapsed(plan, elapsed, loop);
      playHeadRef.current = position;
      setPlayHead(position);
      if (monitor === 'current' && context.state === 'running' && context.currentTime > startedAt) {
        const frame = Math.floor(position * source.sampleRate);
        if (frame < previousWindFrame) {
          windEventIndex = 0;
          heardWindActivity.clear();
        }
        while (windEventIndex < memoryWindEvents.length && memoryWindEvents[windEventIndex].frame <= frame) {
          const event = memoryWindEvents[windEventIndex++];
          heardWindActivity.set(event.moduleId, event.active);
        }
        previousWindFrame = frame;
        windModules.forEach((module) => {
          const active = heardWindActivity.get(module.id);
          if (active !== undefined) {
            recordHeardWind(module.id, frame, active, source.sampleRate, !windVisitsStarted.has(module.id));
            windVisitsStarted.add(module.id);
          }
        });
        const frequencies: Record<string, number[]> = {};
        processingModules.forEach((module, index) => {
          if (module.enabled && module.type === 'hum' && module.params.mode !== 'Static' && Number(module.params.reduction) > 0)
            frequencies[module.id] = memoryHumFrequencies[index] ?? [];
        });
        for (const event of memoryRender?.events ?? []) {
          if (event.frame > frame) break;
          frequencies[event.moduleId] = event.frequencies;
        }
        Object.entries(frequencies).forEach(([moduleId, values]) =>
          recordHeardHum(moduleId, frame, values, source.sampleRate));
        setLiveHum((previous) => previous?.source === source && previous.chain === processingModules &&
          Object.keys(frequencies).every((id) => previous.frequencies[id] === frequencies[id])
          ? previous : { source, chain: processingModules, frequencies });
      }
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  }, [duration, flushHumHistory, flushWindHistory, loop, memoryHumFrequencies, memoryRender, monitor, processingModules, rate, recordHeardHum, recordHeardWind, source]);

  const startLargePlayback = useCallback(async (startPosition: number) => {
    if (!largeSource) return;
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) { setError('This browser does not expose Web Audio playback.'); return; }
    stopPlayback();
    const context = audioContextRef.current ?? new AudioContextClass();
    audioContextRef.current = context;
    await context.resume();
    const session = playbackSessionRef.current + 1;
    playbackSessionRef.current = session;
    const { file, metadata } = largeSource;
    const plan = createPlaybackRangePlan({ duration, loop, sampleRate: metadata.sampleRate, selection: selectionRef.current, startPosition, totalFrames: metadata.frameCount, trim: monitor === 'current' ? trimRef.current ?? undefined : undefined });
    if (plan.emptySelection) { setError('Selection is outside the edited range. Clear the selection or move it inside the kept range to play.'); return; }
    const rangeEnd = plan.bufferEndFrame;
    let nextFrame = plan.timelineStartFrame;
    const loopStartFrame = plan.bufferStartFrame;
    let scheduledAt = context.currentTime + 0.08;
    const startedAt = scheduledAt;
    const chunkFrames = Math.max(4096, Math.floor(metadata.sampleRate * 4));
    const recentStart = Math.max(0, nextFrame - Math.floor(metadata.sampleRate * 2));
    const needsAlignedHumHistory = monitor === 'current' && processingModules.some((module) =>
      module.enabled && module.type === 'hum' && module.params.mode !== 'Static');
    const needsFullNoiseHistory = monitor === 'current' && processingModules.some((module) =>
      module.enabled && module.type === 'noise' && Number(module.params.strength) > 0);
    const humWindow = humAnalysisWindowSize(metadata.sampleRate);
    const seekWarmStart = monitor === 'current'
      ? (trimRef.current?.[0] || needsFullNoiseHistory ? 0 : needsAlignedHumHistory ? Math.floor(recentStart / humWindow) * humWindow : recentStart)
      : nextFrame;
    const warmStart = loop ? Math.min(seekWarmStart, loopStartFrame) : seekWarmStart;
    setOperationStatus('Buffering playback');
    let initialHumFrequencies: number[][];
    let spectralPatches: SpectralRepairPatches;
    try {
      spectralPatches = monitor === 'current' ? await getSpectralPatches() : {};
      initialHumFrequencies = monitor === 'current'
        ? await analyzeFileInitialHum(file, metadata, processingModules)
        : [];
    } catch (caught) {
      if (playbackSessionRef.current === session) {
        setOperationStatus('');
        setError(caught instanceof Error ? caught.message : 'Unable to analyze the opening audio.');
      }
      return;
    }
    if (playbackSessionRef.current !== session) return;
    let chunkEvents: HumEvent[] | null = null;
    let chunkRepairs: RepairMark[] | null = null;
    const windEvents: Array<{ moduleId: string; frame: number; active: boolean }> = [];
    const recordWindEvent = (moduleId: string, frame: number, active: boolean) => {
      windEvents.push({ moduleId, frame, active });
      if (windEvents.length > 512) windEvents.splice(0, windEvents.length - 512);
      setLiveWind({ source, chain: processingModules, events: [...windEvents] });
    };
    const processor = createStreamingEditChain(processingModules, metadata.sampleRate, metadata.frameCount, warmStart,
      initialHumFrequencies, (moduleId, frame, frequencies) => chunkEvents?.push({ moduleId, frame, frequencies }),
      recordWindEvent,
       (moduleId, frame) => {
         if (chunkRepairs) chunkRepairs = addRepairMark(chunkRepairs, { moduleId, frame }, metadata.sampleRate);
        }, spectralPatches);
    const seedWindActivity = (frame: number) => {
      Object.entries(processor.trackedWindActivity()).forEach(([moduleId, active]) =>
        recordWindEvent(moduleId, frame, active));
    };
    const loopStateFrame = loop ? loopStartFrame : nextFrame;
    if (monitor === 'current' && warmStart < loopStateFrame) {
      try {
        await warmFileProcessor(file, metadata, processor, warmStart, loopStateFrame, undefined, () => playbackSessionRef.current !== session);
      } catch (caught) {
        if (playbackSessionRef.current === session) {
          setOperationStatus('');
          if ((caught as Error).name !== 'AbortError') setError(caught instanceof Error ? caught.message : 'Unable to buffer playback.');
        }
        return;
      }
    }
    if (playbackSessionRef.current !== session) return;
    // Save the processing state at the repeat boundary, before warming to the initial seek.
    const loopState = processor.snapshot();
    if (monitor === 'current' && loopStateFrame < nextFrame) {
      try {
        await warmFileProcessor(file, metadata, processor, loopStateFrame, nextFrame, undefined, () => playbackSessionRef.current !== session);
      } catch (caught) {
        if (playbackSessionRef.current === session) {
          setOperationStatus('');
          if ((caught as Error).name !== 'AbortError') setError(caught instanceof Error ? caught.message : 'Unable to buffer playback.');
        }
        return;
      }
    }
    if (playbackSessionRef.current !== session) return;
    seedWindActivity(nextFrame);
    const pending: Array<{ at: number; frame: number; moduleId: string; frequencies: number[] }> = [];
    const windVisitsStarted = new Set<string>();
    let audible = processor.trackedHumFrequencies();
    setLiveHum({ source, chain: processingModules, frequencies: audible });
    setIsPlaying(true);
    setOperationStatus('Buffering playback');

    const pump = async () => {
      if (playbackSessionRef.current !== session) return;
      try {
        while (scheduledAt < context.currentTime + 10 && playbackSessionRef.current === session) {
          if (nextFrame >= rangeEnd) {
            if (!loop) break;
            nextFrame = loopStartFrame;
            processor.restore(loopState);
            seedWindActivity(loopStartFrame);
            pending.push(...Object.entries(processor.trackedHumFrequencies()).map(([moduleId, frequencies]) =>
              ({ at: scheduledAt, frame: loopStartFrame, moduleId, frequencies })));
          }
          const count = Math.min(chunkFrames, rangeEnd - nextFrame);
          const readStart = nextFrame;
          let channels = await readAudioFrames(file, metadata, readStart, count, { signal: undefined });
          if (playbackSessionRef.current !== session) return;
          if (monitor === 'current') {
            chunkEvents = [];
             chunkRepairs = [];
            channels = processor.process(channels, readStart);
             if (chunkRepairs.length && playbackSessionRef.current === session) {
               const found = chunkRepairs;
               setFileRepairs((previous) => {
                 let marks = previous?.source === source && previous.chain === processingModules ? previous.marks : [];
                 for (const mark of found) marks = addRepairMark(marks, mark, metadata.sampleRate);
                 return { source, chain: processingModules, marks };
               });
             }
             chunkRepairs = null;
            pending.push(...chunkEvents.map((event) => ({
              at: scheduledAt + (event.frame - readStart) / metadata.sampleRate / rate,
              frame: event.frame, moduleId: event.moduleId, frequencies: event.frequencies,
            })).sort((a, b) => a.at - b.at));
            chunkEvents = null;
          }
          const buffer = context.createBuffer(metadata.channels, count, metadata.sampleRate);
          channels.forEach((channel, index) => buffer.getChannelData(index).set(channel.subarray(0, count)));
          const node = context.createBufferSource();
          node.buffer = buffer;
          node.playbackRate.value = rate;
          node.connect(context.destination);
          node.start(scheduledAt);
          scheduledNodesRef.current.push(node);
          const cleanupNode = () => {
            scheduledNodesRef.current = scheduledNodesRef.current.filter((item) => item !== node);
            node.disconnect();
          };
          node.onended = cleanupNode;
          scheduledAt += count / metadata.sampleRate / rate;
          nextFrame += count;
          if (nextFrame >= rangeEnd && !loop) {
            node.onended = () => {
              cleanupNode();
              if (playbackSessionRef.current !== session) return;
              playHeadRef.current = plan.timelineEnd;
              setPlayHead(plan.timelineEnd);
              setIsPlaying(false);
              setLiveHum(null);
              flushHumHistory();
              flushWindHistory();
              setOperationStatus('');
              scheduledNodesRef.current = [];
            };
            break;
          }
        }
        if (playbackSessionRef.current === session && (loop || nextFrame < rangeEnd)) window.setTimeout(() => void pump(), 500);
        setOperationStatus('');
      } catch (caught) {
        if (playbackSessionRef.current === session) {
          stopPlayback();
          setError(caught instanceof Error ? caught.message : 'Unable to stream playback.');
        }
      }
    };
    void pump();
    const tick = () => {
      if (playbackSessionRef.current !== session) return;
      const elapsed = Math.max(0, context.currentTime - startedAt) * rate;
      const position = playbackPositionAtElapsed(plan, elapsed, loop);
      playHeadRef.current = position;
      setPlayHead(position);
      if (monitor === 'current' && context.currentTime >= startedAt) {
         const frame = Math.floor(position * metadata.sampleRate);
         processingModules.forEach((module) => {
           if (!module.enabled || module.type !== 'wind' || isFixedLowRumble(module)) return;
           const active = windActivityAt(windEvents, module.id, frame);
           if (active !== null) {
             recordHeardWind(module.id, frame, active, metadata.sampleRate, !windVisitsStarted.has(module.id));
             windVisitsStarted.add(module.id);
           }
         });
         let changed = false;
         while (pending.length && pending[0].at <= context.currentTime) {
           const event = pending.shift()!;
           audible = { ...audible, [event.moduleId]: event.frequencies };
           recordHeardHum(event.moduleId, event.frame, event.frequencies, metadata.sampleRate);
           changed = true;
         }
         if (changed) setLiveHum({ source, chain: processingModules, frequencies: audible });
         Object.entries(audible).forEach(([moduleId, frequencies]) =>
           recordHeardHum(moduleId, frame, frequencies, metadata.sampleRate));
      }
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  }, [duration, flushHumHistory, flushWindHistory, getSpectralPatches, largeSource, loop, monitor, processingModules, rate, recordHeardHum, recordHeardWind, source, stopPlayback]);

  useEffect(() => {
    playHeadRef.current = playHead;
  }, [playHead]);

  useEffect(() => {
    selectionRef.current = [selectionStart, selectionEnd];
  }, [selectionEnd, selectionStart]);

  const play = useCallback(() => {
    if (isPlaying) { stopPlayback(); return; }
    if (largeSource) { void startLargePlayback(playHeadRef.current); return; }
    if (monitor === 'current' && !memoryRender) {
      if (pendingMemoryPlaybackRef.current) { stopPlayback(); return; }
      const pending = memoryJobRef.current;
      if (!pending || pending.source !== source || pending.chain !== processingModules) {
        setError(memoryRenderError ? `Unable to render edited audio: ${memoryRenderError}` : 'Edited audio is not ready. Please try again.');
        return;
      }
      pendingMemoryPlaybackRef.current = true;
      const session = playbackSessionRef.current;
      void pending.job.promise.then((result) => {
        if (!pendingMemoryPlaybackRef.current || monitorRef.current !== 'current' ||
          playbackSessionRef.current !== session || memoryJobRef.current !== pending) return;
        pendingMemoryPlaybackRef.current = false;
        startPlayback(result.channels, playHeadRef.current);
      }).catch((caught: unknown) => {
        if (playbackSessionRef.current !== session) return;
        pendingMemoryPlaybackRef.current = false;
        if (caught instanceof Error && caught.name !== 'AbortError') setError(`Unable to render edited audio: ${caught.message}`);
      });
      return;
    }
    const channels = monitor === 'original' ? source.channels : currentChannels;
    startPlayback(channels, playHeadRef.current);
  }, [currentChannels, isPlaying, largeSource, memoryRender, memoryRenderError, monitor, processingModules, source, startLargePlayback, startPlayback, stopPlayback]);

  const seekTo = useCallback((time: number) => {
    const position = Math.max(0, Math.min(duration, time));
    playHeadRef.current = position;
    setPlayHead(position);
    if (isPlaying) {
      if (largeSource) { void startLargePlayback(position); return; }
      if (monitor === 'current' && !memoryRender) { stopPlayback(); return; }
      const channels = monitor === 'original' ? source.channels : currentChannels;
      startPlayback(channels, position);
    }
  }, [currentChannels, duration, isPlaying, largeSource, memoryRender, monitor, source.channels, startLargePlayback, startPlayback, stopPlayback]);

  const seekToPlayhead = useCallback((time: number) => {
    // A direct seek replaces an older playback range. Deliberate drag selections
    // and repair auditions still use seekTo so their ranges remain active.
    if (Math.abs(selectionRef.current[1] - selectionRef.current[0]) >= 0.01) {
      selectionRef.current = [0, 0];
      setSelection([0, 0]);
    }
    seekTo(time);
  }, [seekTo]);

  const chooseRepair = (mark: RepairMark) => {
    const time = mark.frame / source.sampleRate;
    stopPlayback();
    setSelectedRepair(mark);
    // A short audition range makes A/B work even when a different selection was active.
    const start = Math.max(committedTrimStart, Math.min(committedTrimEnd - .02, time - .12));
    const end = Math.min(committedTrimEnd, Math.max(time + .38, start + .02));
    selectionRef.current = [start, end];
    setSelection([start, end]);
    seekTo(start);
    setTimeViewCenter(time);
  };

  const playbackChannels = monitor === 'original' ? source.channels : currentChannels;
  const streamingPlaybackChain = largeSource ? processingModules : null;
  useEffect(() => {
    if (!isPlaying) return;
    if (largeSource) { void startLargePlayback(playHeadRef.current); return; }
    if (!playbackChannels.length) { stopPlayback(); return; }
    startPlayback(playbackChannels, playHeadRef.current);
  }, [playbackChannels, largeSource, loop, monitor, rate, source, streamingPlaybackChain]);

  useEffect(() => () => { stopPlayback(); audioContextRef.current?.close(); }, [stopPlayback]);

  const commitModules = useCallback((next: EditModule[]) => {
    setUndoStack((stack) => [...stack.slice(-39), modules]);
    setRedoStack([]);
    setModules(next);
    setSavedStatus('Unsaved local changes');
  }, [modules]);

  const saveCurrentChainPreset = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const updated = saveChainPreset(localStorage, presetName, modules, sourceFingerprint);
      setChainPresets(updated);
      setPresetDialogOpen(false);
      setPresetName('');
      setPresetError('');
      setSavedStatus(`Preset “${presetName.trim()}” saved locally · project not saved`);
    } catch (caught) {
      setPresetError(caught instanceof Error ? caught.message : 'Unable to save preset on this device.');
    }
  };
  const loadChainPreset = (value: string, opener: HTMLSelectElement) => {
    if (value === 'save') {
      modalOpenerRef.current = opener;
      setPresetName('');
      setPresetError('');
      setPresetDialogOpen(true);
    } else if (value === 'common-field') {
      commitModules(makeDefaultChain());
      setSavedStatus('Common Field Recording Adjustments loaded · project not saved');
    } else if (value.startsWith('saved:')) {
      const preset = chainPresets[Number(value.slice(6))];
      if (!preset) return;
      const { modules: presetModules, discardedSamples } = preparePresetModules(preset, sourceFingerprint);
      commitModules(presetModules.map((module) => ({
        ...module,
        id: `${module.type}-${crypto.randomUUID()}`,
        params: { ...module.params },
      })));
      setSavedStatus(`Preset “${preset.name}” loaded${discardedSamples ? ' · noise sample removed' : ''}${preset.modules.some(isLegacyWind) ? ' · Wind Removal converted to automatic' : ''} · project not saved`);
      if (discardedSamples) setError('This preset’s noise-only sample could not be verified for this recording. Noise Reduction is now Automatic. Select a noise-only passage and capture a new sample if you prefer.');
    }
  };

  const updateModule = (id: string, patch: Partial<EditModule>) => commitModules(modules.map((module) => module.id === id ? { ...module, ...patch } : module));
  const toggleAllModules = () => {
    if (modules.length) commitModules(toggleEditableModules(modules));
  };
  const updateParams = (id: string, key: string, value: number | string) => commitModules(modules.map((module) => module.id === id ? { ...module, params: { ...module.params, [key]: value } } : module));
  const captureNoiseSample = async (id: string) => {
    const start = Math.max(0, Math.floor(selectionStart * source.sampleRate));
    const end = Math.min(Math.floor(duration * source.sampleRate), Math.ceil(selectionEnd * source.sampleRate),
      start + Math.floor(NOISE_SAMPLE_MAX_SECONDS * source.sampleRate));
    const length = (end - start) / source.sampleRate;
    if (length < NOISE_SAMPLE_MIN_SECONDS || length > NOISE_SAMPLE_MAX_SECONDS) {
      setError(`Select ${NOISE_SAMPLE_MIN_SECONDS}–${NOISE_SAMPLE_MAX_SECONDS} seconds of noise only.`);
      return;
    }
    const selectedSource = source;
    const selectedFile = largeSource;
    try {
      setError('');
      const lead = Math.min(start, Math.ceil(source.sampleRate * .1));
      const channels = selectedFile
        ? await readAudioFrames(selectedFile.file, selectedFile.metadata, start - lead, end - start + lead)
        : source.channels.map((channel) => channel.slice(start - lead, end));
      const owner = noiseCaptureOwnerRef.current;
      if (owner?.source !== selectedSource || owner.file !== selectedFile || owner.modules !== modules) return;
      const profile = measureNoiseProfile(channels, source.sampleRate, lead);
      commitModules(modules.map((module) => module.id === id ? {
        ...module,
        params: {
          ...module.params, mode: 'Sample', sampleStart: start / source.sampleRate, sampleEnd: end / source.sampleRate,
          ...Object.fromEntries(Array.from({ length: NOISE_PROFILE_BANDS }, (_, i) => [`profile${i}`, profile[i]])),
        },
      } : module));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read the selected noise-only sample.');
    }
  };
  const addSpectralRepair = (bounds: SpectralBounds | null, opener?: HTMLButtonElement) => {
    if (!bounds || bounds.end <= bounds.start || bounds.high <= bounds.low) {
      setSpectralSelectionMode(true);
      setSpectralError('Draw a rectangle across time and frequency inside either channel, then click Apply Short Sound Repair. A time-only selection is not enough (10 seconds maximum).');
      return;
    }
    if (bounds.end - bounds.start > 10) {
      setSpectralSelectionMode(true);
      setSpectralError('This rectangle is longer than 10 seconds. Draw a shorter time-and-frequency rectangle in either channel.');
      return;
    }
    const module = makeModule('spectral-repair');
    commitModules([...modules, {
      ...module,
      params: { ...module.params, ...bounds, mode: 'Attenuate', strength: 75, context: 0.2, weighting: 50 },
    }]);
    setSpectralError('');
    setModuleMenu(false);
    chainDrawerOpenerRef.current = opener ?? sidebarAddRef.current;
    setSelectedModuleId(module.id);
    setChainDrawerOpen(true);
  };
  const addModule = (type: AddModuleType) => {
    if (type === 'spectral-repair') {
      setModuleMenu(false);
      setChainDrawerOpen(false);
      setActiveTab('edit');
      setSpectralSelection(null);
      setSpectralError('');
      setSpectralSelectionMode(true);
      requestAnimationFrame(() => canvasRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      return;
    }
    const module = type === 'low-rumble' ? makeLowRumbleRemoval() : makeModule(type);
    commitModules([...modules, module]);
    setModuleMenu(false);
  };
  const deleteModule = (id: string) => commitModules(modules.filter((module) => module.id !== id));
  const duplicateModule = (module: EditModule) => commitModules([...modules, { ...module, id: `${module.type}-${Date.now()}`, name: `${module.name} copy`, params: { ...module.params } }]);
  const moveModule = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= modules.length) return;
    const next = [...modules]; [next[index], next[destination]] = [next[destination], next[index]]; commitModules(next);
  };
  const dropModule = (targetId: string, edge: 'before' | 'after') => {
    if (!draggedModuleId) return;
    const sourceIndex = modules.findIndex((module) => module.id === draggedModuleId);
    const targetIndex = modules.findIndex((module) => module.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    let insertionIndex = targetIndex + (edge === 'after' ? 1 : 0);
    const next = [...modules];
    const [movedModule] = next.splice(sourceIndex, 1);
    if (sourceIndex < insertionIndex) insertionIndex -= 1;
    if (insertionIndex !== sourceIndex) {
      next.splice(insertionIndex, 0, movedModule);
      commitModules(next);
    }
    setDraggedModuleId(null);
    setModuleDropTarget(null);
  };
  const undo = () => {
    const previous = undoStack.at(-1); if (!previous) return;
    setRedoStack((stack) => [...stack, modules]); setModules(previous); setUndoStack((stack) => stack.slice(0, -1));
  };
  const redo = () => {
    const next = redoStack.at(-1); if (!next) return;
    setUndoStack((stack) => [...stack, modules]); setModules(next); setRedoStack((stack) => stack.slice(0, -1));
  };

  const importAudioFile = useCallback(async (file: File, fileHandle?: FileSystemFileHandle) => {
    if (!/\.(wav|flac)$/i.test(file.name) && !['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/flac', 'audio/x-flac'].includes(file.type)) {
      setError('Choose an uncompressed WAV or lossless FLAC recording to begin editing.');
      return;
    }
    try {
      setError('');
      setOperationStatus('Reading audio metadata');
      const metadata = await parseAudioMetadata(file, { name: file.name });
      const fingerprint = await fingerprintAudio(file, metadata);
      // Embedded project saves serialize decoded samples; keep FLAC in memory only while that
      // serialized project can still fit reliably in browser storage.
      const useFileBackedPath = file.size >= 64 * 1024 * 1024 || metadata.format === 'RF64' ||
        (metadata.format === 'FLAC' && metadata.frameCount * metadata.channels * 4 >= 512 * 1024);
      stopPlayback();
      if (useFileBackedPath) {
        const next: AudioSource = { channels: [], sampleRate: metadata.sampleRate, duration: metadata.frameCount / metadata.sampleRate, name: file.name };
        setLargeSource({ file, metadata, fingerprint, fileHandle });
        setSourceFingerprint(fingerprint);
        setSource(next);
        setLargeOriginalStats(EMPTY_STATS);
        setLargeCurrentStats(EMPTY_STATS);
        setLargeSelectionOriginalStats(EMPTY_STATS);
        setLargeSelectionCurrentStats(EMPTY_STATS);
        setSavedStatus(`File-backed ${metadata.format} · not saved`);
      } else {
        const parsed = metadata.format === 'FLAC' ? await decodeFlac(file, metadata) : parseWav(await file.arrayBuffer(), file.name);
        setLargeSource(null);
        setSourceFingerprint(fingerprint);
        setSource(parsed);
        setSavedStatus('Imported · not saved');
      }
       const savedProject = pendingRelink ?? pendingPermission;
       setUndoStack([]);
       setRedoStack([]);
       const relinkMatches = savedProject
         && isVerifiedRelink(savedProject.source.fingerprint, fingerprint);
      if (relinkMatches) {
        setRestoredProject(true);
        setModules(withoutLegacyDcModules(savedProject.modules));
        setMarkers(savedProject.markers);
        setRegions(savedProject.regions);
         restoreTrim(savedProject.trim, metadata.frameCount / metadata.sampleRate);
        setTitle(savedProject.title);
        setNotes(savedProject.notes);
        setWhat3wordsAddress(savedProject.what3wordsAddress ?? '');
        setDescriptiveWords(savedProject.descriptiveWords ?? []);
        setProjectId(savedProject.id);
        setPendingPermission(null);
        setPendingRelink(null);
         setSavedStatus(`Source relinked · project restored${savedProject.modules.some(isLegacyWind) ? ' · Wind Removal converted to automatic' : ''}`);
      } else {
         setRestoredProject(false);
        setModules(makeDefaultChain()); setMarkers([]); setRegions([]); setTitle(file.name.replace(/\.(wav|flac)$/i, '')); setWhat3wordsAddress(''); setDescriptiveWords([]); setProjectId(null);
         restoreTrim(null, metadata.frameCount / metadata.sampleRate);
      }
      setSelection([0, Math.min(metadata.frameCount / metadata.sampleRate, 5)]); setOperationStatus('');
    } catch (caught) {
      setOperationStatus('');
      setError(caught instanceof Error ? caught.message : 'Unable to read this audio file.');
    }
  }, [pendingPermission, pendingRelink, restoreTrim, stopPlayback]);

  const pickAudioFile = useCallback(async () => {
    const picker = (window as typeof window & {
      showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>;
    }).showOpenFilePicker;
    if (!picker) { fileRef.current?.click(); return; }
    try {
      const [handle] = await picker({ multiple: false, types: [{ description: 'WAV or FLAC audio', accept: { 'audio/wav': ['.wav'], 'audio/flac': ['.flac'] } }] });
      if (handle) void importAudioFile(await handle.getFile(), handle);
    } catch (caught) {
      if ((caught as Error).name !== 'AbortError') setError(caught instanceof Error ? caught.message : 'Unable to open this audio file.');
    }
  }, [importAudioFile]);

  const renewSavedFilePermission = useCallback(async () => {
    const record = pendingPermission;
    if (!record?.fileHandle) return;
    setIsRenewingPermission(true);
    setError('');
    try {
      const permission = await requestFileHandlePermission(record.fileHandle);
      if (permission !== 'granted') {
        setPendingPermission(null);
        setPendingRelink(record);
        setSavedStatus('File access denied · relink source audio');
        return;
      }
      const verified = await openVerifiedFileHandle(record.fileHandle, record.source.fingerprint ?? '');
      if (!restoreVerifiedProject(record, verified)) {
        setPendingPermission(null);
        setPendingRelink(record);
        setSavedStatus('Saved source changed · relink source audio');
        setError('The saved file no longer matches this project. Relink the original WAV or FLAC recording to restore its edits.');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to renew access to the saved audio file.');
    } finally {
      setIsRenewingPermission(false);
    }
  }, [pendingPermission, restoreVerifiedProject]);

  const importFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void importAudioFile(file);
    event.target.value = '';
  };

  const onDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingWav(true);
  };

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingWav(false);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingWav(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) {
      setError('No file was found in that drop.');
      return;
    }
    void importAudioFile(file);
  };

  const save = async () => {
    if (largeSource) {
      try {
        const record = await saveProjectV2({
          id: projectId ?? undefined,
          title,
          notes,
          what3wordsAddress,
          descriptiveWords,
          modules,
          markers,
          regions,
          trim: trim ?? undefined,
          source: {
            name: source.name,
            sampleRate: source.sampleRate,
            duration,
            channels: largeSource.metadata.channels,
            size: largeSource.file.size,
            lastModified: largeSource.file.lastModified,
            format: largeSource.metadata.format,
            bitsPerSample: largeSource.metadata.bitsPerSample,
            frameCount: largeSource.metadata.frameCount,
            fingerprint: largeSource.fingerprint,
          },
          fileHandle: largeSource.fileHandle,
          analysis: { original: largeOriginalStats, current: largeCurrentStats, selectionOriginal: largeSelectionOriginalStats, selectionCurrent: largeSelectionCurrentStats },
        });
        setProjectId(record.id);
        setSavedStatus(`Project saved in this browser · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${largeSource.fileHandle ? '' : ' · relink source file after reopening'}`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to save this project.');
      }
      return;
    }
    const project = projectFromSource(source, modules, markers, regions, title, notes, trim ?? undefined, sourceFingerprint, what3wordsAddress, descriptiveWords);
    const ok = saveProject(project);
    setSavedStatus(ok ? `Project saved in this browser · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Browser storage full · project not saved; Export creates WAV + report, not a project backup');
  };

  const exportAudio = async () => {
    const filenames = exportFilenames(title, source.name, descriptiveWords);
    if (largeSource) {
      const picker = (window as typeof window & {
        showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
      }).showSaveFilePicker;
      if (!picker) {
        setError('Large-file export requires desktop Chrome or Edge with the file save picker.');
        return;
      }
      const controller = new AbortController();
      exportJobRef.current?.abort();
      exportJobRef.current = controller;
      try {
        const handle = await picker({ suggestedName: filenames.wav, types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }] });
        await withLargeExportLeaveWarning(async () => {
          const { file, metadata } = largeSource;
          const firstFrame = Math.floor(trimStart * metadata.sampleRate);
          const lastFrame = Math.min(metadata.frameCount, Math.ceil(trimEnd * metadata.sampleRate));
          const warmStart = 0;
          setOperationStatus('Analyzing opening audio');
          const spectralPatches = await getSpectralPatches(controller.signal);
          const initialHumFrequencies = await analyzeFileInitialHum(file, metadata, processingModules, controller.signal);
          const processor = createStreamingEditChain(processingModules, metadata.sampleRate, metadata.frameCount, warmStart,
            initialHumFrequencies, undefined, undefined, undefined, spectralPatches);
          if (warmStart < firstFrame) {
            setOperationStatus('Preparing trimmed export');
            await warmFileProcessor(file, metadata, processor, warmStart, firstFrame, controller.signal);
          }
          const writable = await handle.createWritable();
          setOperationStatus('Exporting file-backed WAV');
          await writeFloat32WavChunks(writable, {
            channels: metadata.channels,
            sampleRate: metadata.sampleRate,
            frameCount: lastFrame - firstFrame,
            signal: controller.signal,
            readFrames: (start, count, signal) => readAudioFrames(file, metadata, firstFrame + start, count, { signal }),
            processFrames: (channels, start) => processor.process(channels, firstFrame + start),
            onProgress: (completed, total) => setOperationProgress(completed / total),
          });
        });
      } catch (caught) {
        const cancelledAtPicker = (caught as Error).name === 'AbortError';
        setError(cancelledAtPicker
          ? 'Export incomplete: no output file was created.'
          : caught instanceof Error ? caught.message : 'Export incomplete: unable to export this recording.');
        setOperationStatus('');
        return;
      } finally {
        if (exportJobRef.current === controller) exportJobRef.current = null;
      }
    } else {
      let rendered = memoryRender;
      if (!rendered) {
        const pending = memoryJobRef.current;
        if (!pending || pending.source !== source || pending.chain !== processingModules) {
          setError(memoryRenderError ? `Unable to render edited audio: ${memoryRenderError}` : 'Edited audio is not ready for export. Please try again.');
          return;
        }
        setOperationStatus('Preparing edited audio');
        try {
          rendered = await pending.job.promise;
        } catch (caught) {
          setOperationStatus('');
          setError(caught instanceof Error ? `Unable to render edited audio: ${caught.message}` : 'Unable to render edited audio.');
          return;
        }
        // Never export a result that was superseded while the user waited.
        if (memoryJobRef.current !== pending) {
          setOperationStatus('');
          setError('The edits changed while preparing the export. Please export again.');
          return;
        }
      }
      const firstFrame = Math.floor(trimStart * source.sampleRate);
      const lastFrame = Math.min(source.channels[0]?.length ?? 0, Math.ceil(trimEnd * source.sampleRate));
      downloadBlob(encodeWav({ ...source, channels: rendered.channels.map((channel) => channel.subarray(firstFrame, lastFrame)) }), filenames.wav);
    }
    const report = makeRestorationReport({
      source: source.name,
      sampleRate: source.sampleRate,
      channels: sourceChannelCount,
      duration: trimEnd - trimStart,
      sourceDuration: duration,
      trim: [trimStart, trimEnd],
      container: largeSource && (Math.ceil(trimEnd * source.sampleRate) - Math.floor(trimStart * source.sampleRate)) * sourceChannelCount * 4 + 36 > 0xffffffff ? 'RF64' : 'RIFF',
      modules,
      selection: [selectionStart, selectionEnd],
    });
    downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), filenames.report);
    setOperationStatus(''); setModal(null); setSavedStatus('WAV + report exported');
  };

  const canvasPointToTime = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return 0;
    const bounds = canvas.getBoundingClientRect();
    const plotWidth = Math.max(1, bounds.width - SPECTROGRAM_LEFT - SPECTROGRAM_RIGHT);
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left - SPECTROGRAM_LEFT) / plotWidth));
    return Math.max(0, Math.min(duration, viewStart + x * viewDuration));
  };
  const canvasPointToFrequency = (event: ReactPointerEvent<HTMLCanvasElement>, pane: number) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const paneHeight = Math.max(1, (bounds.height - SPECTROGRAM_BOTTOM) / 2);
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top - pane * paneHeight) / paneHeight));
    return spectrogramMaxFrequency - y * (spectrogramMaxFrequency - spectrogramMinFrequency);
  };
  const setTrimEdge = (edge: 'start' | 'end', time: number, commit = false) => {
    const current = trimRef.current ?? [0, duration];
    const gap = Math.min(0.01, duration / 2);
    const next: [number, number] = edge === 'start'
      ? [Math.max(0, Math.min(current[1] - gap, time)), current[1]]
      : [current[0], Math.min(duration, Math.max(current[0] + gap, time))];
    trimRef.current = next;
    setTrim(next);
    if (commit) setCommittedTrim(next);
    setSavedStatus('Unsaved local changes');
  };
  const timeAtClientX = (clientX: number) => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left - SPECTROGRAM_LEFT) / Math.max(1, bounds.width - SPECTROGRAM_LEFT - SPECTROGRAM_RIGHT)));
    return viewStart + ratio * viewDuration;
  };
  const trimHandleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, edge: 'start' | 'end') => {
    let time: number;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') time = (edge === 'start' ? trimStart : trimEnd) + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 : 0.1);
    else if (event.key === 'Home') time = 0;
    else if (event.key === 'End') time = duration;
    else return;
    event.preventDefault();
    stopPlayback();
    setTrimEdge(edge, time, true);
  };
  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    const graphBottom = bounds.height - SPECTROGRAM_BOTTOM;
    if (localY >= graphBottom && localX > SPECTROGRAM_LEFT && localX < bounds.width - SPECTROGRAM_RIGHT) {
      const plotWidth = Math.max(1, bounds.width - SPECTROGRAM_LEFT - SPECTROGRAM_RIGHT);
      const pointerX = Math.max(0, Math.min(plotWidth, localX - SPECTROGRAM_LEFT));
      timeDragRef.current = {
        grabbedTime: viewStart + (pointerX / plotWidth) * viewDuration,
        plotLeft: SPECTROGRAM_LEFT,
        plotWidth,
        viewDuration,
        startClientX: event.clientX,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (localX <= SPECTROGRAM_LEFT) {
      if (localY >= 0 && localY < graphBottom) {
        const paneHeight = graphBottom / 2;
        const paneTop = localY >= paneHeight ? paneHeight : 0;
        const span = spectrogramMaxFrequency - spectrogramMinFrequency;
        frequencyDragRef.current = {
          grabbedFrequency: spectrogramMaxFrequency - ((localY - paneTop) / paneHeight) * span,
          paneTop,
          paneHeight,
          span,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (localX >= bounds.width - SPECTROGRAM_RIGHT) {
      if (localY < graphBottom) {
        levelDragRef.current = {
          grabbedLevel: spectrogramCeilingDb - (localY / graphBottom) * spectrogramLevelSpanDb,
          graphHeight: graphBottom,
          span: spectrogramLevelSpanDb,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (spectralSelectionMode && localY >= 0 && localY < graphBottom) {
      const pane = localY < graphBottom / 2 ? 0 : 1;
      spectralDragRef.current = { start: canvasPointToTime(event), frequency: canvasPointToFrequency(event, pane), pane, moved: false };
      setSpectralError('');
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const time = canvasPointToTime(event);
    pointerDragRef.current = { start: time, current: time, startClientX: event.clientX, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    seekToPlayhead(time);
  };
  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (spectralDragRef.current) {
      const drag = spectralDragRef.current;
      const time = canvasPointToTime(event);
      const frequency = canvasPointToFrequency(event, drag.pane);
      if (Math.abs(time - drag.start) > 0.001 || Math.abs(frequency - drag.frequency) > 1) drag.moved = true;
      if (drag.moved) setSpectralSelection({
        start: Math.min(drag.start, time), end: Math.max(drag.start, time),
        low: Math.min(drag.frequency, frequency), high: Math.max(drag.frequency, frequency),
      });
      return;
    }
    if (timeDragRef.current) {
      if (!timeDragRef.current.moved) {
        if (Math.abs(event.clientX - timeDragRef.current.startClientX) < 3) return;
        timeDragRef.current.moved = true;
      }
      const bounds = event.currentTarget.getBoundingClientRect();
      const pointerX = event.clientX - bounds.left - timeDragRef.current.plotLeft;
      const nextViewStart = anchoredTimeViewStart(
        timeDragRef.current.grabbedTime,
        pointerX,
        timeDragRef.current.plotWidth,
        timeDragRef.current.viewDuration,
        duration,
      );
      setTimeViewCenter(nextViewStart + timeDragRef.current.viewDuration / 2);
      return;
    }
    if (frequencyDragRef.current) {
      const nyquist = Math.floor(source.sampleRate / 2);
      const bounds = event.currentTarget.getBoundingClientRect();
      const pointerY = event.clientY - bounds.top - frequencyDragRef.current.paneTop;
      const span = Math.min(frequencyDragRef.current.span, nyquist);
      const nextMin = anchoredFrequencyViewMin(
        frequencyDragRef.current.grabbedFrequency,
        pointerY,
        frequencyDragRef.current.paneHeight,
        span,
        nyquist,
      );
      setSpectrogramMinFrequency(nextMin);
      setSpectrogramMaxFrequency(nextMin + span);
      return;
    }
    if (levelDragRef.current) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const pointerY = event.clientY - bounds.top;
      setSpectrogramCeilingDb(anchoredLevelScaleCeiling(
        levelDragRef.current.grabbedLevel,
        pointerY,
        levelDragRef.current.graphHeight,
        levelDragRef.current.span,
        SPECTROGRAM_DATA_FLOOR_DB,
        SPECTROGRAM_MAX_CEILING_DB,
      ));
      return;
    }
    if (!pointerDragRef.current) return;
    if (!pointerDragRef.current.moved) {
      if (Math.abs(event.clientX - pointerDragRef.current.startClientX) < 3) return;
      pointerDragRef.current.moved = true;
    }
    const time = canvasPointToTime(event);
    pointerDragRef.current.current = time;
    selectionRef.current = [Math.min(pointerDragRef.current.start, time), Math.max(pointerDragRef.current.start, time)];
    setSelection([pointerDragRef.current.start, time]);
  };
  const onCanvasPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (spectralDragRef.current) {
      const drag = spectralDragRef.current;
      if (drag.moved) {
        const time = canvasPointToTime(event);
        const frequency = canvasPointToFrequency(event, drag.pane);
        setSpectralSelection({
          start: Math.min(drag.start, time), end: Math.max(drag.start, time),
          low: Math.min(drag.frequency, frequency), high: Math.max(drag.frequency, frequency),
        });
      }
      spectralDragRef.current = null;
      return;
    }
    if (timeDragRef.current) {
      timeDragRef.current = null;
      return;
    }
    if (frequencyDragRef.current) {
      frequencyDragRef.current = null;
      return;
    }
    if (levelDragRef.current) {
      levelDragRef.current = null;
      return;
    }
    if (!pointerDragRef.current) return;
    if (!pointerDragRef.current.moved) {
      pointerDragRef.current = null;
      return;
    }
    const time = canvasPointToTime(event);
    const start = pointerDragRef.current.start;
    const selectionStartTime = Math.min(start, time);
    const selectionEndTime = Math.max(start, time);
    selectionRef.current = [selectionStartTime, selectionEndTime];
    setSelection([selectionStartTime, selectionEndTime]);
    if (isPlaying || loop || selectionStartTime !== start) seekTo(selectionStartTime);
    pointerDragRef.current = null;
  };
  const onSpectrogramWheel = useCallback((event: WheelEvent) => {
    const canvas = canvasRef.current;
    if (!canvas || event.deltaY === 0) return;
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const graphBottom = bounds.height - SPECTROGRAM_BOTTOM;
    if (y >= graphBottom && x > SPECTROGRAM_LEFT && x < bounds.width - SPECTROGRAM_RIGHT) {
      event.preventDefault();
      event.stopPropagation();
      const plotWidth = Math.max(1, bounds.width - SPECTROGRAM_LEFT - SPECTROGRAM_RIGHT);
      const pointerRatio = Math.max(0, Math.min(1, (x - SPECTROGRAM_LEFT) / plotWidth));
      const pointerTime = viewStart + pointerRatio * viewDuration;
      const factor = event.deltaY > 0 ? 1 / 1.25 : 1.25;
      const nextZoom = Math.max(1, Math.min(16, zoom * factor));
      const nextViewDuration = duration / nextZoom;
      const nextViewStart = anchoredTimeViewStart(pointerTime, x - SPECTROGRAM_LEFT, plotWidth, nextViewDuration, duration);
      setTimeViewCenter(nextViewStart + nextViewDuration / 2);
      setZoom(nextZoom);
    } else if (x <= SPECTROGRAM_LEFT) {
      event.preventDefault();
      event.stopPropagation();
      const nyquist = Math.floor(source.sampleRate / 2);
      const paneHeight = graphBottom / 2;
      const paneY = ((y % paneHeight) + paneHeight) % paneHeight;
      const pointerRatio = Math.max(0, Math.min(1, 1 - paneY / paneHeight));
      const pointerFrequency = spectrogramMinFrequency + pointerRatio * (spectrogramMaxFrequency - spectrogramMinFrequency);
      const factor = event.deltaY > 0 ? 1.25 : 1 / 1.25;
      const nextSpan = Math.max(500, Math.min(nyquist, (spectrogramMaxFrequency - spectrogramMinFrequency) * factor));
      const nextMin = Math.max(0, Math.min(nyquist - nextSpan, pointerFrequency - pointerRatio * nextSpan));
      const roundedMin = Math.max(0, Math.min(nyquist - 500, Math.round(nextMin / 100) * 100));
      const roundedMax = Math.max(roundedMin + 500, Math.min(nyquist, Math.round((nextMin + nextSpan) / 100) * 100));
      setSpectrogramMinFrequency(roundedMin);
      setSpectrogramMaxFrequency(roundedMax);
    } else if (x >= bounds.width - SPECTROGRAM_RIGHT) {
      event.preventDefault();
      event.stopPropagation();
      const pointerRatio = Math.max(0, Math.min(1, 1 - y / graphBottom));
      const pointerLevel = spectrogramFloorDb + pointerRatio * spectrogramLevelSpanDb;
      const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15;
      const nextSpan = Math.max(SPECTROGRAM_MIN_LEVEL_SPAN_DB, Math.min(SPECTROGRAM_MAX_LEVEL_SPAN_DB, spectrogramLevelSpanDb * factor));
      let nextFloor = pointerLevel - pointerRatio * nextSpan;
      let nextCeiling = nextFloor + nextSpan;
      if (nextCeiling > SPECTROGRAM_MAX_CEILING_DB) {
        nextFloor -= nextCeiling - SPECTROGRAM_MAX_CEILING_DB;
        nextCeiling = SPECTROGRAM_MAX_CEILING_DB;
      }
      if (nextFloor < SPECTROGRAM_DATA_FLOOR_DB) {
        nextCeiling += SPECTROGRAM_DATA_FLOOR_DB - nextFloor;
        nextFloor = SPECTROGRAM_DATA_FLOOR_DB;
      }
      setSpectrogramLevelSpanDb(nextCeiling - nextFloor);
      setSpectrogramCeilingDb(nextCeiling);
    }
  }, [duration, source.sampleRate, spectrogramFloorDb, spectrogramLevelSpanDb, spectrogramMaxFrequency, spectrogramMinFrequency, viewDuration, viewStart, zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', onSpectrogramWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onSpectrogramWheel);
  }, [activeTab, onSpectrogramWheel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      setCanvasBounds((previous) => previous.width === width && previous.height === height ? previous : { width, height });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [activeTab]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const ratio = window.devicePixelRatio || 1; const width = canvas.clientWidth; const height = canvas.clientHeight;
    canvas.width = width * ratio; canvas.height = height * ratio; context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const graphBottom = height - SPECTROGRAM_BOTTOM;
    const graphLeft = SPECTROGRAM_LEFT;
    const graphRight = width - SPECTROGRAM_RIGHT;
    const graphWidth = Math.max(1, graphRight - graphLeft);
    const paneHeight = graphBottom / 2;
    const displayHeight = Math.min(256, Math.max(SPECTROGRAM_DISPLAY_HEIGHT, Math.ceil(paneHeight)));
    const frequencyTicks = frequencyScaleTicks(spectrogramMinFrequency, spectrogramMaxFrequency, paneHeight);
    context.fillStyle = '#17242c'; context.fillRect(0, 0, width, height);

    const drawSpectrogramPane = (spectrogram: typeof spectrograms.left, top: number) => {
      const imageCanvas = document.createElement('canvas');
      imageCanvas.width = spectrogram.width;
      imageCanvas.height = displayHeight;
      const imageContext = imageCanvas.getContext('2d');
      if (imageContext) {
        const image = imageContext.createImageData(spectrogram.width, displayHeight);
        const nyquist = source.sampleRate / 2;
        for (let row = 0; row < displayHeight; row += 1) {
          const frequency = spectrogramMaxFrequency - (row / Math.max(1, displayHeight - 1)) * (spectrogramMaxFrequency - spectrogramMinFrequency);
          const sourceRowPosition = Math.max(0, Math.min(spectrogram.height - 1, (1 - frequency / nyquist) * (spectrogram.height - 1)));
          const lowerRow = Math.floor(sourceRowPosition);
          const upperRow = Math.min(spectrogram.height - 1, lowerRow + 1);
          const rowBlend = sourceRowPosition - lowerRow;
          for (let column = 0; column < spectrogram.width; column += 1) {
            const displayTime = viewStart + ((column + 0.5) / spectrogram.width) * viewDuration;
            const sourceColumnPosition = ((displayTime - spectrograms.startSeconds) / Math.max(Number.EPSILON, spectrograms.durationSeconds)) * spectrogram.width - 0.5;
            let storedIntensity = 0;
            if (sourceColumnPosition >= -0.5 && sourceColumnPosition <= spectrogram.width - 0.5) {
              const lowerColumn = Math.max(0, Math.floor(sourceColumnPosition));
              const upperColumn = Math.min(spectrogram.width - 1, lowerColumn + 1);
              const columnBlend = Math.max(0, sourceColumnPosition - lowerColumn);
              const lowerLeft = spectrogram.values[lowerRow * spectrogram.width + lowerColumn] ?? 0;
              const lowerRight = spectrogram.values[lowerRow * spectrogram.width + upperColumn] ?? lowerLeft;
              const upperLeft = spectrogram.values[upperRow * spectrogram.width + lowerColumn] ?? lowerLeft;
              const upperRight = spectrogram.values[upperRow * spectrogram.width + upperColumn] ?? upperLeft;
              const lower = lowerLeft + (lowerRight - lowerLeft) * columnBlend;
              const upper = upperLeft + (upperRight - upperLeft) * columnBlend;
              storedIntensity = lower + (upper - lower) * rowBlend;
            }
            const decibels = SPECTROGRAM_DATA_FLOOR_DB + storedIntensity * (SPECTROGRAM_DATA_CEILING_DB - SPECTROGRAM_DATA_FLOOR_DB);
            const intensity = Math.max(0, Math.min(1, (decibels - spectrogramFloorDb) / (spectrogramCeilingDb - spectrogramFloorDb)));
            const [red, green, blue] = spectrogramColor(intensity, spectrogramPalette);
            const pixel = (row * spectrogram.width + column) * 4;
            image.data[pixel] = red;
            image.data[pixel + 1] = green;
            image.data[pixel + 2] = blue;
            image.data[pixel + 3] = 255;
          }
        }
        imageContext.putImageData(image, 0, 0);
        context.imageSmoothingEnabled = true;
        context.drawImage(imageCanvas, graphLeft, top, graphWidth, paneHeight);
      }
    };
    drawSpectrogramPane(spectrograms.left, 0);
    drawSpectrogramPane(spectrograms.right, paneHeight);

    context.strokeStyle = 'rgba(235, 250, 231, .13)'; context.lineWidth = 1;
    for (let tick = 0; tick <= 10; tick += 1) {
      const x = graphLeft + (tick / 10) * graphWidth;
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, graphBottom); context.stroke();
    }
    for (const top of [0, paneHeight]) {
      for (const { y } of frequencyTicks) {
        context.beginPath(); context.moveTo(graphLeft, top + y); context.lineTo(graphRight, top + y); context.stroke();
      }
    }
    context.strokeStyle = 'rgba(242, 244, 232, .55)'; context.lineWidth = 1;
    context.beginPath(); context.moveTo(graphLeft, paneHeight); context.lineTo(graphRight, paneHeight); context.stroke();

    const selectedLeft = graphLeft + ((selectionStart - viewStart) / viewDuration) * graphWidth;
    const selectedRight = graphLeft + ((selectionEnd - viewStart) / viewDuration) * graphWidth;
    if (hasSelection) {
      context.fillStyle = 'rgba(214, 237, 85, .13)'; context.fillRect(selectedLeft, 0, selectedRight - selectedLeft, graphBottom);
      context.strokeStyle = 'rgba(216, 237, 85, .5)'; context.strokeRect(selectedLeft, 0, selectedRight - selectedLeft, graphBottom);
    }
    const drawSpectralBounds = (bounds: SpectralBounds, saved: boolean, enabled = true) => {
      const left = graphLeft + (bounds.start - viewStart) / viewDuration * graphWidth;
      const right = graphLeft + (bounds.end - viewStart) / viewDuration * graphWidth;
      const top = (spectrogramMaxFrequency - bounds.high) / Math.max(1, spectrogramMaxFrequency - spectrogramMinFrequency) * paneHeight;
      const bottom = (spectrogramMaxFrequency - bounds.low) / Math.max(1, spectrogramMaxFrequency - spectrogramMinFrequency) * paneHeight;
      if (right < graphLeft || left > graphRight || bottom < 0 || top > paneHeight) return;
      for (const paneTop of [0, paneHeight]) {
        context.save();
        context.beginPath();
        context.rect(graphLeft, paneTop, graphWidth, paneHeight);
        context.clip();
        context.fillStyle = saved ? 'rgba(255, 175, 120, .10)' : 'rgba(216, 237, 85, .21)';
        context.strokeStyle = saved ? 'rgba(255, 175, 120, .86)' : '#d8ed55';
        context.lineWidth = saved ? 1.5 : 2;
        context.setLineDash(saved || !enabled ? [5, 3] : []);
        context.fillRect(left, paneTop + top, right - left, bottom - top);
        context.strokeRect(left, paneTop + top, right - left, bottom - top);
        context.restore();
      }
    };
    modules.filter((module) => module.type === 'spectral-repair').forEach((module) => {
      const p = module.params;
      const bounds = { start: Number(p.start), end: Number(p.end), low: Number(p.low), high: Number(p.high) };
      if (Object.values(bounds).every(Number.isFinite)) drawSpectralBounds(bounds, true, module.enabled);
    });
    if (spectralSelection) drawSpectralBounds(spectralSelection, false);
    if (spectrogramSource === 'current') {
      const startX = Math.max(graphLeft, Math.min(graphRight, graphLeft + ((trimStart - viewStart) / viewDuration) * graphWidth));
      const endX = Math.max(graphLeft, Math.min(graphRight, graphLeft + ((trimEnd - viewStart) / viewDuration) * graphWidth));
      context.fillStyle = 'rgba(5, 12, 18, .72)';
      context.fillRect(graphLeft, 0, startX - graphLeft, graphBottom);
      context.fillRect(endX, 0, graphRight - endX, graphBottom);
    }
    const headX = graphLeft + ((playHead - viewStart) / viewDuration) * graphWidth; context.strokeStyle = '#ff8a4c'; context.lineWidth = 2; context.beginPath(); context.moveTo(headX, 0); context.lineTo(headX, graphBottom); context.stroke();

    context.fillStyle = '#f2f4e8'; context.font = '10px "Space Mono", monospace'; context.textAlign = 'left';
    const timeTickCount = Math.max(2, Math.min(6, Math.floor(graphWidth / 90)));
    for (let tick = 0; tick <= timeTickCount; tick += 1) { const time = viewStart + (tick / timeTickCount) * viewDuration; context.fillText(formatTime(time), graphLeft + (tick / timeTickCount) * graphWidth + 4, graphBottom + 13); }
    context.textAlign = 'right';
    for (const top of [0, paneHeight]) {
      for (const { frequency, y } of frequencyTicks) {
        const label = frequency === 0 ? '0' : `${Number((frequency / 1000).toFixed(1))}k`;
        context.fillText(label, graphLeft - 6, Math.max(top + 10, Math.min(top + paneHeight - 3, top + y + 3)));
      }
    }
    context.textAlign = 'left';
    const gradient = context.createLinearGradient(0, 3, 0, graphBottom - 3);
    for (const [position, color] of spectrogramLegendStops(spectrogramPalette)) gradient.addColorStop(position, color);
    context.fillStyle = gradient;
    context.fillRect(graphRight + 6, 3, 9, graphBottom - 6);
    context.strokeStyle = 'rgba(242, 244, 232, .35)';
    context.strokeRect(graphRight + 6, 3, 9, graphBottom - 6);
    context.fillStyle = '#f2f4e8';
    for (const { level, y } of levelScaleTicks(spectrogramCeilingDb, spectrogramLevelSpanDb, graphBottom)) {
      context.fillText(level > 0 ? `+${level}` : `${level}`, graphRight + 19, Math.max(10, Math.min(graphBottom - 3, y + 3)));
    }
    context.textAlign = 'left';
    context.fillStyle = '#d8ed55';
    context.fillText(sourceChannelCount > 1 ? 'L' : 'MONO', graphLeft + 6, 14);
    context.fillText(sourceChannelCount > 1 ? 'R' : 'MONO', graphLeft + 6, paneHeight + 14);
    context.font = '600 10px "Space Mono", monospace';
    context.fillStyle = '#b8cbbf';
    context.textAlign = 'center';
    context.fillText('TIME (mm:ss.s)', graphLeft + graphWidth / 2, height - 8);
    context.save();
    context.translate(15, graphBottom / 2);
    context.rotate(-Math.PI / 2);
    context.fillText('FREQUENCY (Hz)', 0, 0);
    context.restore();
    context.save();
    context.translate(width - 16, graphBottom / 2);
    context.rotate(Math.PI / 2);
    context.fillText('LEVEL (dB)', 0, 0);
    context.restore();
  }, [activeTab, canvasBounds, hasSelection, modules, spectralSelection, playHead, selectionEnd, selectionStart, sourceChannelCount, spectrogramCeilingDb, spectrogramFloorDb, spectrogramMaxFrequency, spectrogramMinFrequency, spectrogramPalette, spectrogramSource, spectrograms, trimEnd, trimStart, viewDuration, viewStart]);

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (modal || presetDialogOpen) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.closest('[data-trim-handle]'))) return;
      if (event.code === 'Space') { event.preventDefault(); play(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      if (event.key === 'Escape') setModuleMenu(false);
    };
    window.addEventListener('keydown', keyHandler); return () => window.removeEventListener('keydown', keyHandler);
  }, [modal, presetDialogOpen, play, redo, undo]);

  return (
    <div
      className={`app-shell noise ${activeTab === 'edit' ? 'has-edit-layout' : ''} ${isDraggingWav ? 'is-dragging-wav' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid="app-field-restore"
    >
      {isDraggingWav && (
        <div className="wav-drop-overlay" role="status" aria-live="polite" inert={!!modal || presetDialogOpen} aria-hidden={modal || presetDialogOpen ? true : undefined} data-testid="wav-drop-overlay">
          <div className="wav-drop-card">
            <FileAudio size={34} strokeWidth={1.5} />
            <div>
              <div className="wav-drop-title">Drop WAV or FLAC to open</div>
              <div className="wav-drop-copy">Your recording stays on this device. The original will remain unchanged.</div>
            </div>
          </div>
        </div>
      )}
      <aside className="sidebar-shell" inert={!!modal || presetDialogOpen} aria-hidden={modal || presetDialogOpen ? true : undefined}>
        <div className="px-4 py-5 flex items-center gap-3">
          <svg className="brand-leaf" aria-hidden="true" width="28" height="28" viewBox="0 0 28 28" fill="none">
            <path
              d="M22.9 4.9C15.1 4.8 8.2 7 5.6 12.1c-2.2 4.3.1 8.7 4.2 9.5 5.9 1.1 11.8-5.8 13.1-16.7Z"
              stroke="currentColor"
              strokeWidth="1.55"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M5.7 21.4c3.5-4.1 7.4-7.2 13.6-11.9"
              stroke="currentColor"
              strokeWidth="1.35"
              strokeLinecap="round"
            />
          </svg>
          <div className="brand-copy">
            <div className="font-bold tracking-tight text-[14px]">FIELD RESTORE</div>
            <div className="text-[10px] opacity-55 tracking-[.12em] mt-0.5">BY LARS LENTZ</div>
            <a className="brand-links" href="https://sleek.bio/larslentz" target="_blank" rel="noopener noreferrer" aria-label="More by Lars (opens in new tab)" data-testid="link-more-by-lars">
              More by Lars <ExternalLink size={11} aria-hidden="true" />
            </a>
          </div>
        </div>
        <div className="px-3 mt-5 sidebar-title eyebrow text-[#91a69d]">Workspace</div>
        <nav className="px-3 mt-2 space-y-1" aria-label="Workspace navigation">
          {([['edit', Activity, 'Edit chain'], ['analyze', Gauge, 'Analyze'], ['project', FolderOpen, 'Project']] as const).map(([tab, Icon, label]) => <button key={tab} type="button" className={`nav-item ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)} data-testid={`nav-${tab}`}><Icon size={15} /><span className="nav-label">{label}</span></button>)}
          <button type="button" className="nav-item compact-chain-trigger" onClick={(event) => openChainDrawer(event)} aria-label="Open edit chain" data-testid="button-open-chain"><Layers3 size={15} /><span className="nav-label">Modules</span></button>
          <a className="nav-item compact-more-link" href="https://sleek.bio/larslentz" target="_blank" rel="noopener noreferrer" aria-label="More by Lars (opens in new tab)" title="More by Lars (opens in new tab)" data-testid="link-more-by-lars-compact">
            <ExternalLink size={15} aria-hidden="true" /><span className="compact-more-caption" aria-hidden="true">LARS</span>
          </a>
        </nav>
        <section className="sidebar-chain" aria-label="Non-destructive edit chain">
          <div className="sidebar-chain-heading">
            <button type="button" className="sidebar-chain-title" onClick={(event) => openChainDrawer(event)} data-testid="button-open-full-chain"><div className="eyebrow text-[#91a69d]">Edit chain</div><div className="sidebar-chain-count">{modules.filter((module) => module.enabled).length}/{modules.length} editable enabled</div></button>
            <div className="sidebar-chain-actions">
              <EditChainToggle modules={modules} onToggle={toggleAllModules} testId="toggle-all-modules-sidebar" />
              <button type="button" className="sidebar-open-button" onClick={(event) => openChainDrawer(event)} aria-label="Open full edit chain" title="Open full edit chain"><PanelRightOpen size={13} /></button>
              <div className="relative">
                <button ref={sidebarAddRef} type="button" className="sidebar-add-button" onClick={() => setModuleMenu(!moduleMenu)} aria-label="Add module" aria-expanded={moduleMenu && !chainDrawerOpen} aria-controls="sidebar-add-module-menu" data-testid="button-add-module"><Plus size={13} /></button>
                {moduleMenu && !chainDrawerOpen && sidebarMenuPosition && createPortal(
                  <div id="sidebar-add-module-menu" className="sidebar-module-menu" style={sidebarMenuPosition} data-testid="sidebar-module-menu">
                    {MODULE_TYPES.map((type) => <button type="button" key={type} onClick={() => addModule(type)} data-testid={`menu-module-${type}`}>{moduleOptionLabel(type)}</button>)}
                  </div>, document.body)}
              </div>
            </div>
          </div>
          <div className={`sidebar-chain-row automatic ${automaticDcSelected && chainDrawerOpen ? 'selected' : ''}`} data-testid="sidebar-automatic-dc">
            <span className="sidebar-drag-spacer" aria-hidden="true" />
            <button type="button" className="sidebar-chain-select" onClick={(event) => openChainDrawer(event, AUTOMATIC_DC_REMOVAL.id)} data-testid="button-open-automatic-dc">
              <span className="module-index">01</span><span className="module-dot" />
              <span className="sidebar-chain-copy"><strong>{AUTOMATIC_DC_REMOVAL.name}</strong><small>Always applied first</small></span>
            </button>
            <span className="sidebar-bypass" aria-label="Always applied"><Check size={12} /></span>
          </div>
          <div className="sidebar-chain-list">
            {modules.length === 0 ? <div className="sidebar-chain-empty">No additional edits yet</div> : modules.map((module, index) => (
              <div
                key={module.id}
                data-testid={`sidebar-module-${module.id}`}
                className={`sidebar-chain-row ${module.enabled ? '' : 'bypassed'} ${selectedModuleId === module.id && chainDrawerOpen ? 'selected' : ''} ${draggedModuleId === module.id ? 'dragging' : ''} ${moduleDropTarget?.id === module.id ? `drop-${moduleDropTarget.edge}` : ''}`}
                onDragOver={(event) => {
                  if (!draggedModuleId || draggedModuleId === module.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setModuleDropTarget({ id: module.id, edge: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' });
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const edge = moduleDropTarget?.id === module.id ? moduleDropTarget.edge : 'before';
                  dropModule(module.id, edge);
                }}
              >
                <span
                  className="sidebar-drag-handle"
                  data-testid={`drag-module-${module.id}`}
                  draggable
                  title={`Drag to reorder ${module.name}`}
                  aria-hidden="true"
                  onDragStart={(event) => {
                    setDraggedModuleId(module.id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', module.id);
                  }}
                  onDragEnd={() => {
                    setDraggedModuleId(null);
                    setModuleDropTarget(null);
                  }}
                >
                  <GripVertical size={12} />
                </span>
                <button type="button" className="sidebar-chain-select" onClick={(event) => openChainDrawer(event, module.id)} data-testid={`button-open-module-${module.id}`}>
                  <span className="module-index">{String(index + 2).padStart(2, '0')}</span><span className="module-dot" />
                  <span className="sidebar-chain-copy"><strong>{module.name}</strong><small>{moduleSummary(module, module.type === 'hum' ? humReadoutFor(module) : undefined)}</small></span>
                </button>
                <button type="button" className="sidebar-bypass" onClick={() => updateModule(module.id, { enabled: !module.enabled })} aria-label={`${module.enabled ? 'Bypass' : 'Enable'} ${module.name}`} aria-pressed={module.enabled}><Check size={12} /></button>
              </div>
            ))}
          </div>
        </section>
        <div className="px-3 mt-5 sidebar-title eyebrow text-[#91a69d]">Session</div>
        <div className="px-3 mt-2 space-y-1">
          <button type="button" className="nav-item" onClick={() => void pickAudioFile()} data-testid="nav-import" aria-describedby="import-format-note"><FileAudio size={15} /><span className="nav-label">Import WAV or FLAC</span></button>
          <p id="import-format-note" className="px-3 pb-2 text-[10px] leading-relaxed text-[#abbdb4]">32-bit floating point WAV recommended for maximum editing headroom. Lossless FLAC is also supported; lossy formats are not.</p>
          <button type="button" className="nav-item" onClick={(event) => openModal(event, 'export')} aria-label="Export 32-bit WAV" data-testid="nav-export"><Download size={15} /><span className="nav-label">Export 32-bit WAV</span></button>
          <button type="button" className="nav-item" onClick={save} aria-label="Save project" aria-describedby="sidebar-save-project-description" data-testid="nav-save"><Save size={15} /><span className="nav-label">Save project</span></button>
          <p id="sidebar-save-project-description" className="sidebar-save-note">{SAVE_PROJECT_DESCRIPTION}</p>
          <button type="button" className="nav-item" onClick={() => { stopPlayback(); setRestoredProject(false); setLargeSource(null); setSourceFingerprint(null); setUndoStack([]); setRedoStack([]); setSource(createDemoAudio()); restoreTrim(null, 18); setModules(makeDefaultChain()); setSelection([4.1, 7.8]); setMarkers([]); setRegions([]); setTitle('Coastal dawn / north bluff'); setWhat3wordsAddress(''); setDescriptiveWords([]); setSavedStatus('Demo source loaded'); }} data-testid="nav-demo"><Waves size={15} /><span className="nav-label">Load demo source</span></button>
        </div>
        <div className="mt-auto px-4 pb-5 sidebar-meta">
          <div className="border-t border-[#34454b] pt-4">
            <div className="flex items-center gap-2 text-[11px] text-[#b7c8bb]"><span className="w-2 h-2 rounded-full bg-[#d8ed55]" /> Offline / local only</div>
            <div className="font-mono-value text-[10px] text-[#829890] mt-2">{source.sampleRate / 1000} kHz · {sourceChannelCount} ch</div>
          </div>
        </div>
      </aside>
      <section className="main-shell" inert={!!modal || presetDialogOpen} aria-hidden={modal || presetDialogOpen ? true : undefined}>
        <header className={`topbar ${analysisStatus || spectrogramStatus || operationStatus ? 'topbar-processing' : ''}`}>
          <div className="topbar-recording flex items-center gap-3 min-w-0">
            <button type="button" className="icon-btn md:hidden" aria-label="Open navigation" data-testid="button-menu"><Menu size={16} /></button>
          <div className="topbar-recording-copy min-w-0"><div className="eyebrow">Current recording</div><div className="font-semibold text-[14px] mt-1 truncate max-w-[340px]" data-testid="text-source-name">{source.name}</div>{restoredProject && <div className="text-[10px] text-[#b7c8bb] max-w-[340px]" role="note">Reprocessing saved projects may sound different with improved DC correction. Your original recording is untouched.</div>}</div>
            <span className="chip hidden sm:inline-flex"><span className="w-1.5 h-1.5 bg-[#d8ed55] rounded-full" />{savedStatus}</span>
             <span className="dc-status hidden lg:inline-flex" data-testid="status-dc-removal"><Check size={12} />DC offset removed automatically</span>
          </div>
          {(analysisStatus || spectrogramStatus || operationStatus) && (() => {
            const backgroundStatus = analysisStatus || spectrogramStatus;
            const visibleStatus = backgroundStatus || operationStatus;
            const visibleProgress = analysisStatus ? analysisProgress : spectrogramStatus ? spectrogramProgress : operationProgress;
            const measuredProgress = Boolean(backgroundStatus || operationStatus.startsWith('Exporting'));
            const title = analysisStatus ? 'Analyzing recording' : spectrogramStatus ? 'Building spectrogram' : operationStatus === 'Reading audio metadata' ? 'Opening recording' : operationStatus;
            return <div className="work-banner" role="status" data-testid="status-background-work" data-progress={visibleProgress}>
              <LoaderCircle size={18} className={`work-banner-spinner ${operationPaused && backgroundStatus ? 'paused' : ''}`} aria-hidden="true" />
              <div className="work-banner-copy"><strong>{title}{operationPaused && backgroundStatus ? ' · paused' : ''}</strong><span>{visibleStatus} · Your recording is still being processed.</span></div>
              <div className="work-banner-progress">
                <div className={`work-banner-meter ${measuredProgress ? '' : 'indeterminate'}`} role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={measuredProgress ? Math.round(visibleProgress * 100) : undefined}><span style={measuredProgress ? { width: `${Math.max(4, visibleProgress * 100)}%` } : undefined} /></div>
                <span className="font-mono-value">{measuredProgress ? `${Math.round(visibleProgress * 100)}%` : 'Working…'}</span>
              </div>
              {backgroundStatus && <div className="work-banner-actions"><button type="button" className="quiet-btn" onClick={operationPaused ? resumeBackgroundWork : pauseBackgroundWork} aria-label={operationPaused ? 'Resume analysis' : 'Pause analysis'} title={operationPaused ? 'Resume analysis' : 'Pause analysis'} data-testid="button-analysis-pause">{operationPaused ? <Play size={12} /> : <Pause size={12} />}</button><button type="button" className="icon-btn" onClick={cancelBackgroundWork} aria-label="Cancel background analysis" title="Cancel background analysis" data-testid="button-analysis-cancel"><X size={13} /></button></div>}
            </div>;
          })()}
          <div className="topbar-actions flex items-center gap-1.5">
            <button type="button" className="icon-btn" onClick={undo} disabled={!undoStack.length} aria-label="Undo last edit" data-testid="button-undo"><Undo2 size={16} /></button>
            <button type="button" className="icon-btn" onClick={redo} disabled={!redoStack.length} aria-label="Redo last edit" data-testid="button-redo"><Redo2 size={16} /></button>
            <span className="hidden lg:inline font-mono-value text-[10px] text-muted-foreground mx-2">⌘Z / ⌘⇧Z</span>
            <button type="button" className="quiet-btn" onClick={(event) => openModal(event, 'help')} data-testid="button-help"><CircleHelp size={14} /> <span className="hidden sm:inline">Help</span></button>
            <button type="button" className="quiet-btn" onClick={(event) => openModal(event, 'settings')} aria-label="Open settings" data-testid="button-settings"><Settings size={14} /></button>
            <button type="button" className="primary-btn" onClick={(event) => openModal(event, 'export')} data-testid="button-export"><Download size={14} /> Export 32-bit WAV</button>
          </div>
        </header>
        <main className={`main-content scrollbar-thin ${activeTab === 'edit' ? 'main-content-edit' : ''}`}>
          {error && <div className="max-w-[1660px] mx-auto mb-3 border border-[#d79c88] bg-[#fff0e9] text-[#8e3a2b] rounded-md px-3 py-2 text-[12px] flex items-center justify-between" role="alert" data-testid="status-error"><span>{error}</span><button type="button" className="icon-btn" onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button></div>}
           {pendingPermission && (
             <div className="max-w-[1660px] mx-auto mb-3 border border-[hsl(var(--border))] bg-[hsl(var(--card))] rounded-md px-3 py-2.5 text-[12px] flex flex-wrap items-center gap-3" role="status" data-testid="status-file-permission">
               <div className="min-w-0 flex-1">
                 <div className="font-semibold">Allow access to restore this saved project</div>
                 <div className="text-muted-foreground mt-0.5">Field Restore will reopen “{pendingPermission.source.name}”, verify it matches the saved recording, then restore your edits.</div>
               </div>
               <button type="button" className="primary-btn" onClick={() => void renewSavedFilePermission()} disabled={isRenewingPermission} data-testid="button-renew-file-permission">
                 <FolderOpen size={14} /> {isRenewingPermission ? 'Requesting access…' : 'Allow file access'}
               </button>
             </div>
           )}
           <div className={`workspace-grid${activeTab === 'edit' && statisticsOrientation === 'vertical' ? ' workspace-grid-stats-vertical' : ''}`}>
               <div className={`min-w-0 ${activeTab === 'edit' ? `edit-workspace stats-${statisticsOrientation}` : 'space-y-4'}`}>
              {activeTab === 'project' ? (
                 <ProjectPanel title={title} notes={notes} setTitle={setTitle} setNotes={setNotes} what3wordsAddress={what3wordsAddress} setWhat3wordsAddress={setWhat3wordsAddress} descriptiveWords={descriptiveWords} setDescriptiveWords={setDescriptiveWords} source={source} sourceChannelCount={sourceChannelCount} save={() => void save()} openSettings={(event) => openModal(event, 'settings')} />
              ) : activeTab === 'analyze' ? (
                <AnalyzePanel originalStats={originalStats} currentStats={currentStats} selectionOriginalStats={selectionOriginalStats} selectionCurrentStats={selectionCurrentStats} duration={duration} selection={[selectionStart, selectionEnd]} trim={[committedTrimStart, committedTrimEnd]} hasSelection={hasSelection} modules={modules} />
              ) : (
                <>
                  <section className="panel instrument-grid" aria-label="Spectrogram editor">
                    <div className="panel-header spectrogram-panel-header">
                      <div className="flex items-center gap-3"><Waves size={17} color="hsl(var(--primary))" /><div><div className="section-title">Spectrogram / selection</div><div className="text-[10px] text-muted-foreground mt-0.5">{spectralSelectionMode ? 'Spectral selection on · drag across time and frequency inside either channel (10 seconds max) · axis gestures still work' : 'Drag to select time · double-click to clear · scroll/drag the bottom time axis · scroll/drag the left frequency axis · scroll/drag the right dB axis'}</div></div></div>
                      <div className="spectrogram-header-actions">
                        <button type="button" className={`spectral-mode-toggle ${spectralSelectionMode ? 'active' : ''}`} onClick={() => { setSpectralSelectionMode((value) => !value); setSpectralError(''); }} aria-pressed={spectralSelectionMode} data-testid="button-spectral-selection-mode">Spectral selection</button>
                        <div className="spectrogram-source-control" aria-label="Spectrogram source">
                          <span className="spectrogram-source-caption">Viewing</span>
                          <div className="spectrogram-source-toggle">
                            <button type="button" className={spectrogramSource === 'original' ? 'active' : ''} onClick={() => setSpectrogramSource('original')} aria-pressed={spectrogramSource === 'original'} data-testid="button-spectrogram-original">Original</button>
                            <button type="button" className={spectrogramSource === 'current' ? 'active' : ''} onClick={() => setSpectrogramSource('current')} aria-pressed={spectrogramSource === 'current'} data-testid="button-spectrogram-edited">Edited</button>
                          </div>
                        </div>
                        <div className="spectrogram-tabs flex bg-[hsl(var(--muted))] rounded-md p-0.5" role="tablist" aria-label="Workspace view">
                          {(['edit', 'analyze', 'project'] as ViewTab[]).map((tab) => <button key={tab} type="button" className={`tab rounded ${activeTab === tab ? 'active bg-[hsl(var(--card))]' : ''}`} onClick={() => setActiveTab(tab)} role="tab" aria-selected={activeTab === tab} data-testid={`tab-${tab}`}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}
                        </div>
                        <div className="flex items-center gap-1"><button type="button" className="icon-btn" onClick={() => { setTimeViewCenter(viewStart + viewDuration / 2); setZoom(Math.max(1, zoom / 1.8)); }} aria-label="Zoom out" data-testid="button-zoom-out"><ZoomOut size={15} /></button><span className="font-mono-value text-[10px] text-muted-foreground w-12 text-center">{zoom.toFixed(1)}×</span><button type="button" className="icon-btn" onClick={() => { setTimeViewCenter(viewStart + viewDuration / 2); setZoom(Math.min(16, zoom * 1.8)); }} aria-label="Zoom in" data-testid="button-zoom-in"><ZoomIn size={15} /></button><button type="button" className="quiet-btn ml-2 !py-[5px]" onClick={() => { setZoom(1); setTimeViewCenter(null); }} data-testid="button-fit">Fit</button></div>
                      </div>
                    </div>
                     <div className="panel-body !pt-3">
                      <div className="waveform-wrap">
                         <canvas ref={canvasRef} className={`waveform-canvas ${spectralSelectionMode ? 'spectral-selecting' : ''}`} onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerUp={onCanvasPointerUp} onPointerCancel={onCanvasPointerUp} onDoubleClick={(event) => { event.preventDefault(); if (spectralSelectionMode) { setSpectralSelection(null); setSpectralError(''); } else clearSelection(); }} aria-label={`${spectrogramSource === 'original' ? 'Original recording' : 'Edited signal'} interactive spectrogram from ${spectrogramMinFrequency / 1000} to ${spectrogramMaxFrequency / 1000} kilohertz with ${spectrogramFloorDb.toFixed(6)} to ${spectrogramCeilingDb.toFixed(6)} decibel scale, time from ${formatTime(viewStart)} to ${formatTime(viewStart + viewDuration)}`} data-testid="canvas-spectrogram" data-request-id={spectrogramRequestId} data-result-id={spectrogramResultId} />
                        {spectrogramSource === 'current' && visibleRepairs.length > 0 && <div className="repair-marker-rail" aria-label="Detected click and pop repairs on the time axis">
                          {visibleRepairs.map((mark) => {
                            const time = mark.frame / source.sampleRate;
                            const module = processingModules.find((entry) => entry.id === mark.moduleId);
                            return <button key={`${mark.moduleId}-${mark.frame}`} type="button" className={`repair-marker ${selectedRepair?.moduleId === mark.moduleId && selectedRepair.frame === mark.frame ? 'selected' : ''}`}
                              style={{ left: `${(time - viewStart) / viewDuration * 100}%` }}
                              title={`${module?.name ?? 'Click & Pop Removal'} repair at ${formatTime(time, true)}`}
                              aria-label={`Audition ${module?.name ?? 'Click & Pop Removal'} repair at ${formatTime(time, true)}`}
                              onClick={() => chooseRepair(mark)} data-testid="click-repair-marker" />;
                          })}
                        </div>}
                        <div className={`spectrogram-source-label ${spectrogramSource} ${spectrogramSource === 'current' && visibleHumSegments.length > 0 ? 'with-hum-history' : ''}`} data-testid="label-spectrogram-source">{spectrogramSource === 'original' ? 'Original recording' : 'Edited signal · chain applied'}</div>
                        {spectrogramSource === 'current' && visibleHumSegments.length > 0 && <HumSpectrogramOverlay
                         modules={processingModules} segments={visibleHumSegments} sampleRate={source.sampleRate} onSeek={seekToPlayhead} />}
                        {spectrogramSource === 'current' && <div className="trim-overlay" aria-label="Edited recording trim handles">
                          {(['start', 'end'] as const).map((edge) => {
                            const position = edge === 'start' ? trimStart : trimEnd;
                            const ratio = (position - viewStart) / viewDuration;
                            if (ratio < 0 || ratio > 1) return null;
                            return <button key={edge} type="button" data-trim-handle={edge} data-testid={`trim-handle-${edge}`} className={`trim-handle ${edge}`} style={{ left: `${ratio * 100}%` }}
                              aria-label={`Edited recording ${edge}: ${formatTime(position, true)}. Drag or use arrow keys to adjust.`}
                              title={`Drag to set edited ${edge} · ${formatTime(position, true)}`}
                              onPointerDown={(event) => { event.preventDefault(); stopPlayback(); event.currentTarget.setPointerCapture(event.pointerId); }}
                              onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setTrimEdge(edge, timeAtClientX(event.clientX)); }}
                              onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { setTrimEdge(edge, timeAtClientX(event.clientX), true); event.currentTarget.releasePointerCapture(event.pointerId); } }}
                              onPointerCancel={() => setCommittedTrim(trimRef.current)}
                              onKeyDown={(event) => trimHandleKeyDown(event, edge)}>
                              <span className="trim-handle-tag" aria-hidden="true">{edge === 'start' ? 'START' : 'END'}</span>
                            </button>;
                          })}
                        </div>}
                      </div>
                       <div className="spectrogram-footer">
                        <div className="spectrogram-meta scrollbar-thin">
                         {!largeSource && (spectrograms.error
                           ? <p role="alert" className="text-[11px] text-red-700 mt-2">Spectrogram unavailable: {spectrograms.error}</p>
                           : spectrograms.loading && <p role="status" className="text-[11px] text-muted-foreground mt-2">Preparing spectrogram…</p>)}
                         <div className="trim-summary" data-testid="trim-summary">
                        <span><strong>Edited range</strong> {formatTime(trimStart, true)} – {formatTime(trimEnd, true)} <span className="text-muted-foreground">({formatTime(trimEnd - trimStart, true)} kept)</span></span>
                        <span className="text-muted-foreground">Drag START and END on the edited spectrogram. Original stays untouched.</span>
                        {trim && (trimStart > 0 || trimEnd < duration) && <button type="button" className="quiet-btn !py-1 !px-2 !text-[10px]" onClick={() => { stopPlayback(); restoreTrim(null, duration); setSavedStatus('Unsaved local changes'); }} data-testid="button-reset-trim">Reset trim</button>}
                         </div>
                         <div className="flex flex-wrap items-center justify-end gap-3 mt-2">
                        <div className="flex items-center gap-2">
                          <div className="font-mono-value text-[11px]" data-testid="text-selection-time">{hasSelection ? <>{formatTime(selectionStart, true)} — {formatTime(selectionEnd, true)} <span className="text-muted-foreground">({(selectionEnd - selectionStart).toFixed(3)} s selected)</span></> : 'No selection · full track'}</div>
                          {hasSelection && <button type="button" className="quiet-btn !py-1 !px-2 !text-[10px]" onClick={clearSelection} title="Clear selection and return playback to the start" data-testid="button-clear-selection"><X size={12} /> Clear selection</button>}
                        </div>
                         </div>
                        </div>
                        <div className="spectrogram-action-slot scrollbar-thin">
                         {(spectralSelectionMode || spectralSelection || spectralError) && <div className="spectral-action-strip">
                          <div className="spectral-action-copy"><strong>Short Sound Repair · 10 seconds max</strong>{spectralError && <p role="alert" data-testid="status-spectral-error" className="spectral-error">{spectralError}</p>}<span data-testid="text-spectral-selection" aria-live="polite">{spectralSelection ? `${formatTime(spectralSelection.start, true)}–${formatTime(spectralSelection.end, true)} · ${Math.round(spectralSelection.low)}–${Math.round(spectralSelection.high)} Hz` : 'Drag diagonally inside either channel to draw a time-and-frequency rectangle, then click Apply. Time-only selection does not count.'}</span></div>
                         <button type="button" className="primary-btn" onClick={(event) => addSpectralRepair(spectralSelection, event.currentTarget)} data-testid="button-add-spectral-repair">Apply Short Sound Repair</button>
                         </div>}
                         {!(spectralSelectionMode || spectralSelection || spectralError) && <div className="spectrogram-legend text-[11px] text-muted-foreground">
                           <span className="inline-block w-3 h-3 rounded-sm ring-1 ring-black/20" style={{ background: spectrogramColorCss(0.08, spectrogramPalette) }} /> low energy <span className="inline-block w-3 h-3 rounded-sm ml-2 ring-1 ring-black/20" style={{ background: spectrogramColorCss(0.92, spectrogramPalette) }} /> high energy <span className="inline-block w-3 h-3 rounded-sm bg-[#ff8a4c] ml-2" /> playhead
                         </div>}
                        </div>
                       </div>
                    </div>
                  </section>
                   <section className="panel signal-stats-bar" data-testid="panel-signal-statistics" data-request-id={analysisRequestId} data-result-id={analysisResultId}>
                      <div className="signal-stats-heading">
                       <div className="flex items-center gap-2"><Gauge size={15} color="hsl(var(--primary))" /><div className="section-title">Signal statistics</div></div>
                        <div className="signal-stats-tools">
                          <span className="chip" data-testid="label-statistics-source">{displayedSourceLabel}</span>
                          <button type="button" className="stats-orientation-button" aria-label={`Show signal statistics ${statisticsOrientation === 'horizontal' ? 'vertically' : 'horizontally'}`} title={`Show statistics ${statisticsOrientation === 'horizontal' ? 'vertically' : 'horizontally'}`} onClick={() => {
                            const next = statisticsOrientation === 'horizontal' ? 'vertical' : 'horizontal';
                            setStatisticsOrientation(next);
                            localStorage.setItem('field-restore-statistics-orientation', next);
                          }} data-testid="button-statistics-orientation">
                            {statisticsOrientation === 'horizontal' ? <PanelLeft size={13} /> : <PanelBottom size={13} />}
                            {statisticsOrientation === 'horizontal' ? 'Vertical' : 'Horizontal'}
                          </button>
                        </div>
                        <span className="stats-narrow-hint">Vertical view is shown on wider screens</span>
                     </div>
                      <div className="signal-stats-group">
                        <div className="signal-stats-label">{hasSelection
                          ? spectrogramSource === 'current'
                            ? `Edited / selection within kept range · ${formatTime(Math.max(0, Math.min(selectionEnd, committedTrimEnd) - Math.max(selectionStart, committedTrimStart)))}`
                            : `Original / selection · ${formatTime(selectionEnd - selectionStart)}`
                          : spectrogramSource === 'current' ? `Edited / kept range · ${formatTime(committedTrimEnd - committedTrimStart)}` : `Original / full file · ${formatTime(duration)}`}</div>
                        {hasSelection && spectrogramSource === 'current' && Math.min(selectionEnd, committedTrimEnd) <= Math.max(selectionStart, committedTrimStart)
                          ? <div className="signal-stats-pending">Selection is outside the edited range</div>
                          : statisticsPending ? <div className="signal-stats-pending">{statisticsUnavailableLabel}</div>
                            : <StatsGrid stats={hasSelection ? displayedSelectionStats : displayedStats} />}
                     </div>
                       <div className="signal-stats-note"><Info size={12} />Local BS.1770-style estimates with 4× true-peak interpolation. Not certified meter readings.</div>
                   </section>
                    <div className="edit-secondary scrollbar-thin" aria-label="Edit details" data-testid="edit-secondary">
                    {processingModules.some((module) => module.enabled && module.type === 'click-pop' && Number(module.params.strength) > 0) &&
                      <div className="repair-summary" data-testid="repair-summary">
                        <span><strong>Click & pop repairs</strong> · {repairMarks.length} marked {largeSource ? 'during buffered edited playback' : 'in the edited render'}{repairMarks.length >= MAX_REPAIR_MARKS ? ` · latest ${MAX_REPAIR_MARKS} retained` : ''}. Marks sit on the time axis; select one to audition a short range.</span>
                        {selectedRepair && <span className="repair-compare" data-testid="repair-compare">
                          {formatTime(selectedRepair.frame / source.sampleRate, true)} ·
                          <button type="button" className={monitor === 'current' ? 'active' : ''} onClick={() => { monitorRef.current = 'current'; setMonitor('current'); }} aria-pressed={monitor === 'current'}>Edited</button>
                          <button type="button" className={monitor === 'original' ? 'active' : ''} onClick={() => { monitorRef.current = 'original'; setMonitor('original'); }} aria-pressed={monitor === 'original'}>Original</button>
                          <button type="button" onClick={play}>{isPlaying ? 'Pause' : 'Play'} comparison</button>
                        </span>}
                      </div>}
                    {spectrogramSource === 'current' && historySegments.length > 0 && <div className="hum-overlay-note" data-testid="hum-overlay-note">
                      <span><strong>Hum Removal playback history.</strong> Colored solid lines show where a hum filter was confirmed during playback; gray dashed lines mean no filter was confirmed. Dots mark heard positions you can select to seek. Unmarked gaps have no retained confirmation.</span>
                      <div className="hum-overlay-legend">{processingModules.filter((module) => historySegments.some((segment) => segment.moduleId === module.id)).map((module, index) =>
                        <span key={module.id}><i style={{ background: HUM_MARKER_COLORS[index % HUM_MARKER_COLORS.length] }} />{module.name}</span>)}</div>
                    </div>}
                   {isPlaying && monitor === 'current' && modules.some((module) =>
                     module.enabled && module.type === 'hum' && module.params.mode !== 'Static' && Number(module.params.reduction) > 0) &&
                     <div className="text-[11px] text-muted-foreground px-2 py-1" role="status" data-testid="live-hum-transport">
                       Now playing · tracked hum filter estimates: {modules.filter((module) =>
                         module.enabled && module.type === 'hum' && module.params.mode !== 'Static' && Number(module.params.reduction) > 0)
                         .map((module) => `${module.name}: ${liveHumFrequencies?.[module.id]
                           ? liveHumFrequencies[module.id].length ? liveHumFrequencies[module.id].map((frequency) => `${frequency.toFixed(1)} Hz`).join(', ') : 'none currently confirmed'
                           : 'buffering…'}`).join(' · ')}. Current position only; not a whole-recording measurement.
                     </div>}
                   {historySegments.length > 0 && <HumHistoryView
                     modules={processingModules} segments={historySegments} sampleRate={source.sampleRate}
                     duration={duration} onSeek={seekToPlayhead} />}
                    </div>
                </>
              )}
            </div>
          </div>
        </main>
        {activeTab === 'edit' && <div className="transport-dock" data-testid="transport-dock">
          <section className="transport" aria-label="Audio transport">
            <button type="button" className="icon-btn !bg-[#d8ed55] !text-[#18231f] !rounded-full" onClick={play} aria-label={isPlaying ? 'Pause playback' : 'Play playback'} data-testid="button-play">{isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
            {!largeSource && monitor === 'current' && !memoryRender &&
              <span role="status" className="text-[11px] text-muted-foreground" data-testid="memory-render-status">
                {memoryRenderError ? 'Edited audio could not be rendered' : 'Preparing edited audio…'}
              </span>}
            <button type="button" className="icon-btn" onClick={() => { stopPlayback(); setPlayHead(0); }} aria-label="Stop and return to start" data-testid="button-stop"><Square size={14} fill="currentColor" /></button>
            <div className="time-readout" data-testid="text-playhead">{formatTime(playHead)} <span className="font-sans text-[10px] opacity-55">/ {formatTime(duration)}</span></div>
            <div className="h-5 w-px bg-white/15 mx-1" />
            <button type="button" className={`icon-btn !text-[11px] !font-bold ${loop ? '!bg-white/10 !text-[#d8ed55]' : ''}`} onClick={() => setLoop(!loop)} aria-pressed={loop} data-testid="button-loop">LOOP</button>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <span className="text-[10px] opacity-60">PRESET</span>
              <select className="transport-select border border-white/15 rounded px-2 py-1 text-[11px] max-w-[210px]" value="" onChange={(event) => loadChainPreset(event.target.value, event.currentTarget)} aria-label="Load or save local preset" data-testid="select-local-preset">
                <option value="" disabled>Load or save preset…</option>
                <option value="save">Save current chain as preset…</option>
                <option value="common-field">Common Field Recording Adjustments</option>
                {chainPresets.length > 0 && <optgroup label="Your saved presets">{chainPresets.map((preset, index) => <option key={index} value={`saved:${index}`}>{preset.name}</option>)}</optgroup>}
              </select>
              <span className="h-5 w-px bg-white/15 mx-1" />
              <span className="text-[10px] opacity-60">MONITOR</span>
              <select className="transport-select border border-white/15 rounded px-2 py-1 text-[11px]" value={monitor} onChange={(event) => {
                const next = event.target.value as MonitorMode;
                monitorRef.current = next;
                pendingMemoryPlaybackRef.current = false;
                setMonitor(next);
              }} aria-label="Monitor source" data-testid="select-monitor"><option value="current">Current</option><option value="original">Original A/B</option></select>
              <select className="transport-select border border-white/15 rounded px-2 py-1 text-[11px]" value={rate} onChange={(event) => setRate(Number(event.target.value))} aria-label="Playback rate" data-testid="select-playback-rate"><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option></select>
            </div>
          </section>
        </div>}
      </section>
      <input ref={fileRef} type="file" accept=".wav,.flac,audio/wav,audio/flac" onChange={importFile} className="hidden" inert={!!modal || presetDialogOpen} aria-hidden={modal || presetDialogOpen ? true : undefined} data-testid="input-import-wav" />
      {modal === 'export' && <ExportModal onClose={() => setModal(null)} onExport={exportAudio} title={title} />}
      {modal === 'help' && <HelpModal onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} spectrogramPalette={spectrogramPalette} onSpectrogramPaletteChange={(palette) => { setSpectrogramPalette(palette); localStorage.setItem('field-restore-spectrogram-palette', palette); }} />}
      {presetDialogOpen && <div className="modal-backdrop" inert={!!modal} aria-hidden={modal ? true : undefined}>
        <form className="modal-card" role="dialog" aria-modal="true" aria-labelledby="preset-dialog-title" onSubmit={saveCurrentChainPreset}>
          <div className="modal-header"><div><div className="eyebrow">Local preset</div><h2 id="preset-dialog-title" className="text-[17px] font-bold mt-1">Save edit chain</h2></div><button type="button" className="icon-btn" onClick={() => setPresetDialogOpen(false)} aria-label="Close save preset" data-testid="button-close-save-preset"><X size={16} /></button></div>
          <div className="modal-body">
            <label htmlFor="preset-name" className="field-label">Preset name</label>
            <input id="preset-name" className="input-field" value={presetName} onChange={(event) => { setPresetName(event.target.value); setPresetError(''); }} maxLength={60} required placeholder="e.g. Quiet morning ambience" data-testid="input-preset-name" />
            <p className="text-[11px] text-muted-foreground mt-2">Saves all {modules.length} editable modules, in order, on this device. The original recording is unchanged.</p>
            {presetError && <p role="alert" className="text-[11px] text-[#a34935] mt-2">{presetError}</p>}
          </div>
          <div className="modal-footer"><button type="button" className="quiet-btn" onClick={() => setPresetDialogOpen(false)}>Cancel</button><button type="submit" className="primary-btn" data-testid="button-confirm-save-preset"><Save size={14} /> Save preset</button></div>
        </form>
      </div>}
      {chainDrawerOpen && <div className="chain-drawer-backdrop" inert={!!modal || presetDialogOpen} aria-hidden={modal || presetDialogOpen ? true : undefined} onPointerDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); setChainDrawerOpen(false); } }}>
        <aside ref={chainDrawerRef} className="chain-drawer" role="dialog" aria-modal="true" aria-label={automaticDcSelected ? AUTOMATIC_DC_REMOVAL.name : selectedModule ? `Edit ${selectedModule.name}` : 'Edit chain'} tabIndex={-1}>
          <div className="chain-drawer-header">
            <div><div className="eyebrow">Non-destructive edit chain</div><div className="section-title mt-1">{automaticDcSelected ? AUTOMATIC_DC_REMOVAL.name : selectedModule ? selectedModule.name : 'Modules'}</div></div>
            <button type="button" className="icon-btn" onClick={() => setChainDrawerOpen(false)} aria-label="Close edit chain" data-testid="button-close-chain"><X size={16} /></button>
          </div>
          <div className="chain-drawer-mobile-list">
            <EditChainToggle modules={modules} onToggle={toggleAllModules} testId="toggle-all-modules-drawer" compact />
            <button type="button" className={automaticDcSelected ? 'selected' : ''} onClick={() => setSelectedModuleId(AUTOMATIC_DC_REMOVAL.id)}><span>01</span><strong>{AUTOMATIC_DC_REMOVAL.name}</strong><small>Always applied</small></button>
            {modules.map((module, index) => <button type="button" key={module.id} className={selectedModuleId === module.id ? 'selected' : ''} onClick={() => setSelectedModuleId(module.id)}><span>{String(index + 2).padStart(2, '0')}</span><strong>{module.name}</strong><small>{moduleSummary(module, module.type === 'hum' ? humReadoutFor(module) : undefined)}</small></button>)}
             <div className="relative"><button type="button" className="quiet-btn w-full" onClick={() => setModuleMenu(!moduleMenu)}><Plus size={13} /> Add module</button>{moduleMenu && <div className="drawer-module-menu">{MODULE_TYPES.map((type) => <button type="button" key={type} onClick={() => addModule(type)}>{moduleOptionLabel(type)}</button>)}</div>}</div>
          </div>
          <div className="chain-drawer-body">
              {automaticDcSelected ? <AutomaticDcCard /> : selectedModule ? <ModuleCard module={selectedModule} humReadout={selectedModule.type === 'hum' ? humReadoutFor(selectedModule) : undefined} liveFrequencies={liveHumFrequencies?.[selectedModule.id]} windActive={windActivityFor(selectedModule.id)} windHistory={windHistoryFor(selectedModule.id)} sampleRate={source.sampleRate} duration={duration} index={modules.findIndex((module) => module.id === selectedModule.id)} total={modules.length} collapsed={false} updateModule={updateModule} updateParams={updateParams} captureNoiseSample={captureNoiseSample} selectionLength={selectionEnd - selectionStart} deleteModule={deleteModule} duplicateModule={duplicateModule} moveModule={moveModule} /> : <div className="chain-drawer-full-list"><AutomaticDcCard />{modules.map((module, index) => <ModuleCard key={module.id} module={module} humReadout={module.type === 'hum' ? humReadoutFor(module) : undefined} liveFrequencies={liveHumFrequencies?.[module.id]} windActive={windActivityFor(module.id)} windHistory={windHistoryFor(module.id)} sampleRate={source.sampleRate} duration={duration} index={index} total={modules.length} collapsed={false} updateModule={updateModule} updateParams={updateParams} captureNoiseSample={captureNoiseSample} selectionLength={selectionEnd - selectionStart} deleteModule={deleteModule} duplicateModule={duplicateModule} moveModule={moveModule} />)}{modules.length === 0 && <div className="empty-state">No additional edits yet.</div>}</div>}
          </div>
          <div className="chain-drawer-footer">processing is local · original stays untouched</div>
        </aside>
      </div>}
    </div>
  );
}

function EditChainToggle({ modules, onToggle, testId, compact = false }: {
  modules: EditModule[]; onToggle: () => void; testId: string; compact?: boolean;
}) {
  const allEnabled = modules.length > 0 && modules.every((module) => module.enabled);
  const mixed = !allEnabled && modules.some((module) => module.enabled);
  return <label className={`chain-all-toggle ${compact ? 'in-drawer' : ''} ${modules.length === 0 ? 'disabled' : ''}`} title={allEnabled ? 'Bypass all editable modules' : 'Enable all editable modules'}>
    <input
      type="checkbox"
      checked={allEnabled}
      ref={(element) => { if (element) element.indeterminate = mixed; }}
      onChange={onToggle}
      disabled={modules.length === 0}
      aria-label="All editable modules"
      data-testid={testId}
    />
    {compact && <span>All editable modules</span>}
  </label>;
}

function HumSpectrogramOverlay({ modules, segments, sampleRate, onSeek }: {
  modules: EditModule[]; segments: VisibleHumSegment[]; sampleRate: number; onSeek: (seconds: number) => void;
}) {
  const tracked = modules.filter((module) =>
    module.enabled && module.type === 'hum' && module.params.mode !== 'Static' && Number(module.params.reduction) > 0);
  return <div className="hum-spectrogram-overlay" aria-label="Hum Removal playback history; colored solid spans have confirmed hum filters, gray dashed spans have no confirmed filter" data-testid="hum-spectrogram-overlay">
    <span className="hum-spectrogram-label" aria-hidden="true">Hum Removal history</span>
    {segments.map(({ segment, left, right, seekFrame }, index) => {
      const lane = tracked.findIndex((module) => module.id === segment.moduleId);
      if (lane < 0) return null;
      const module = tracked[lane];
      const description = segment.frequencies.length
        ? segment.frequencies.map((frequency) => `${frequency.toFixed(1)} Hz`).join(', ')
        : 'no filter confirmed';
      const label = `${module.name} · ${formatTime(seekFrame / sampleRate, true)} · ${description} · heard during processed playback`;
      const position = { top: `${27 + lane * 19}px`, left: `${left * 100}%` };
      return <div key={`${segment.moduleId}-${index}`} className="hum-spectrogram-visit"
        style={{ top: position.top, '--hum-marker-color': HUM_MARKER_COLORS[lane % HUM_MARKER_COLORS.length] } as React.CSSProperties}>
        {right > left && <span className={`hum-spectrogram-span ${segment.frequencies.length ? '' : 'unfiltered'}`}
          style={{ left: position.left, width: `${(right - left) * 100}%` }} aria-hidden="true" />}
        <button type="button" className={`hum-spectrogram-marker ${segment.frequencies.length ? '' : 'unfiltered'}`}
          style={{ left: position.left, width: `max(14px, ${(right - left) * 100}%)`, zIndex: index + 1 }}
          title={label} aria-label={`Seek to ${label}`} data-testid="hum-spectrogram-marker"
          onClick={() => onSeek(seekFrame / sampleRate)}>
          <span aria-hidden="true" className="hum-spectrogram-dot" />
        </button>
      </div>;
    })}
  </div>;
}

function StatsGrid({ stats }: { stats: LoudnessStats }) {
  return <div className="stat-grid">
    <div className="stat-cell"><div className="stat-value">{formatLevel(stats.truePeakDbtp, 'dBTP')}</div><div className="stat-label">True peak estimate</div></div>
    <div className="stat-cell"><div className="stat-value">{formatLevel(stats.integratedLufs, 'LUFS')}</div><div className="stat-label">Integrated loudness</div></div>
    <div className="stat-cell"><div className="stat-value">{formatLra(stats.loudnessRangeLu)}</div><div className="stat-label">Loudness range (LRA)</div></div>
    <div className="stat-cell"><div className="stat-value">{formatLevel(stats.maxShortTermLufs, 'LUFS')}</div><div className="stat-label">Max short-term</div></div>
    <PlrStat stats={stats} label="Peak-to-loudness ratio (PLR)" />
    <LbprStat stats={stats} label="Loud-Block Peak-to-RMS (LBPR)" />
  </div>;
}

function RangeControl({ label, value, min, max, step, suffix, onChange, resetValue, wheelStep, testId }: { label: string; value: number; min: number; max: number; step: number; suffix: string; onChange: (value: number) => void; resetValue?: number; wheelStep?: number; testId?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !wheelStep) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = event.deltaY < 0 ? 1 : -1;
      const next = Math.max(min, Math.min(max, value + direction * wheelStep));
      onChange(Number(next.toFixed(6)));
    };
    input.addEventListener('wheel', handleWheel, { passive: false });
    return () => input.removeEventListener('wheel', handleWheel);
  }, [max, min, onChange, value, wheelStep]);

  return <label className="block"><span className="field-label">{label} <span className="font-mono-value normal-case">{value}{suffix}</span></span><input ref={inputRef} className="range-field" type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} onDoubleClick={() => { if (resetValue !== undefined) onChange(resetValue); }} title={resetValue !== undefined ? `Double-click to reset to ${resetValue}${suffix}` : undefined} data-testid={testId} /></label>;
}

function AutomaticDcCard() {
  return <div className="module-card" data-testid="card-automatic-dc">
    <div className="module-head">
      <span className="module-index">01</span><span className="module-dot" />
      <strong className="module-name">{AUTOMATIC_DC_REMOVAL.name}</strong>
      <span className="module-summary">Always applied</span><Check size={13} className="text-[hsl(var(--primary))]" aria-hidden="true" />
    </div>
    <div className="module-controls text-[11px] text-muted-foreground">Automatically applied before all editable modules. There are no settings to change, and this step cannot be bypassed or moved.</div>
  </div>;
}

function HumHistoryView({ modules, segments, sampleRate, duration, onSeek }: {
  modules: EditModule[]; segments: HumHistorySegment[]; sampleRate: number; duration: number; onSeek: (seconds: number) => void;
}) {
  const tracked = modules.filter((module) =>
    module.enabled && module.type === 'hum' && module.params.mode !== 'Static' && Number(module.params.reduction) > 0);
  if (!tracked.length) return null;
  return <section className="px-3 py-2 border-t border-white/10 text-[11px]" aria-label="Hum filter playback history" data-testid="hum-playback-history">
    <div className="font-semibold">Hum filter history · heard positions only</div>
    <p className="text-muted-foreground mt-0.5">Recent processed playback in this tab, not a whole-recording scan. Unmarked positions have no retained confirmation; “no filter confirmed” means that position was heard but no filter was active. Select a position to listen again.</p>
    {tracked.map((module) => {
      const visits = segments.filter((segment) => segment.moduleId === module.id);
      if (!visits.length) return null;
      const recent = visits.slice(-6);
      return <div key={module.id} className="mt-2" data-testid={`hum-history-${module.id}`}>
        <div className="font-medium">{module.name}</div>
        <div className="relative h-2 rounded bg-white/10 mt-1 overflow-hidden" aria-hidden="true" title="Unmarked positions have not been confirmed by playback">
          {visits.map((segment, index) => <div key={index} className="absolute top-0 h-full"
            style={{
              left: `${Math.min(100, segment.startFrame / sampleRate / Math.max(duration, .001) * 100)}%`,
              width: `${Math.max(.2, (segment.endFrame - segment.startFrame) / sampleRate / Math.max(duration, .001) * 100)}%`,
              background: segment.frequencies.length ? '#d8ed55' : '#8291a1',
            }} />)}
        </div>
        <div className="flex flex-wrap gap-1 mt-1.5">
          {recent.map((segment, index) => <span key={index} className="inline-flex items-center gap-1">
            {index > 0 && segment.startFrame > recent[index - 1].endFrame + sampleRate * .5 &&
              <span className="text-muted-foreground">· gap unconfirmed here ·</span>}
            <button type="button" className="rounded border border-white/15 px-1.5 py-0.5 hover:border-white/40 text-left"
              onClick={() => onSeek(segment.startFrame / sampleRate)}
              aria-label={`Seek to ${formatTime(segment.startFrame / sampleRate, true)}, ${segment.frequencies.length ? segment.frequencies.map((frequency) => `${frequency.toFixed(1)} hertz`).join(', ') : 'no filter confirmed'}`}>
              {formatTime(segment.startFrame / sampleRate, true)}–{formatTime(segment.endFrame / sampleRate, true)}: {segment.frequencies.length
                ? segment.frequencies.map((frequency) => `${frequency.toFixed(1)} Hz`).join(', ')
                : 'no filter confirmed'}
            </button>
          </span>)}
          {visits.length > recent.length && <span className="text-muted-foreground self-center">Showing latest {recent.length} changes</span>}
        </div>
      </div>;
    })}
  </section>;
}

function WindHistoryTimeline({ moduleId, moduleName, segments, sampleRate, duration }: {
  moduleId: string; moduleName: string; segments: WindHistorySegment[]; sampleRate: number; duration: number;
}) {
  const safeDuration = Math.max(duration, .001);
  return <div className="rounded-md border border-border px-2.5 py-2 space-y-1" data-testid={`wind-history-${moduleId}`}>
    <div className="text-[10px] font-semibold">Playback history · heard positions only</div>
    <p className="text-[10px] leading-relaxed text-muted-foreground">
      Recent processed playback in this tab. Bright marks mean the detector confirmed wind reduction; gray marks mean it was idle. Unmarked areas have no retained confirmation.
    </p>
    <div className="relative h-2 rounded bg-white/10 overflow-hidden" role="img"
      aria-label={`${moduleName} recent processed playback history. Bright spans show confirmed wind reduction; gray spans show confirmed idle detection; unmarked spans are unconfirmed.`}
      data-testid={`wind-history-track-${moduleId}`}>
      {segments.map((segment, index) => {
        const start = Math.max(0, Math.min(duration, segment.startFrame / sampleRate));
        const end = Math.max(start, Math.min(duration, segment.endFrame / sampleRate));
        const left = Math.min(100, start / safeDuration * 100);
        const width = Math.max(.15, Math.min(100 - left, (end - start) / safeDuration * 100));
        return <span key={`${segment.startFrame}-${segment.endFrame}-${index}`}
          className="absolute top-0 h-full"
          style={{ left: `${left}%`, width: `${width}%`, background: segment.active ? '#d8ed55' : '#718096' }}
          title={`${formatTime(start, true)}–${formatTime(end, true)} · ${segment.active ? 'wind reduction active' : 'detector idle'}`}
          aria-hidden="true" />;
      })}
    </div>
    <div className="flex gap-3 text-[10px] text-muted-foreground">
      <span><i className="inline-block w-2 h-2 rounded-sm mr-1 bg-[#d8ed55]" />Reduction active</span>
      <span><i className="inline-block w-2 h-2 rounded-sm mr-1 bg-[#718096]" />Detector idle</span>
    </div>
    {!segments.length && <p className="text-[10px] text-muted-foreground">Play the edited recording to build a local history.</p>}
  </div>;
}

function ModuleCard({ module, humReadout, liveFrequencies, windActive, windHistory, sampleRate, duration, index, total, collapsed, updateModule, updateParams, captureNoiseSample, selectionLength, deleteModule, duplicateModule, moveModule }: { module: EditModule; humReadout?: ReturnType<typeof humOpeningReadout>; liveFrequencies?: number[]; windActive?: boolean | null; windHistory: WindHistorySegment[]; sampleRate: number; duration: number; index: number; total: number; collapsed: boolean; updateModule: (id: string, patch: Partial<EditModule>) => void; updateParams: (id: string, key: string, value: number | string) => void; captureNoiseSample: (id: string) => Promise<void>; selectionLength: number; deleteModule: (id: string) => void; duplicateModule: (module: EditModule) => void; moveModule: (index: number, direction: -1 | 1) => void }) {
  const p = module.params;
  const numberInput = (key: string, label: string, min: number, max: number, step: number, suffix = '', options?: { resetValue?: number; wheelStep?: number }) => <RangeControl label={label} value={Number(p[key])} min={min} max={max} step={step} suffix={suffix} resetValue={options?.resetValue} wheelStep={options?.wheelStep} onChange={(value) => updateParams(module.id, key, value)} testId={`range-${module.type}-${key}`} />;
  const spectralBoundInput = (key: 'start' | 'end' | 'low' | 'high', label: string, max: number, step: number) => <label><span className="field-label">{label} {key === 'start' || key === 'end' ? '(s)' : '(Hz)'}</span><input key={`${module.id}-${key}-${p[key]}`} className="input-field font-mono-value" type="number" min={0} max={max} step={step} defaultValue={Number(p[key])} onBlur={(event) => {
    const value = Number(event.currentTarget.value);
    const next = { start: Number(p.start), end: Number(p.end), low: Number(p.low), high: Number(p.high), [key]: value };
    if (!event.currentTarget.value.trim() || !Number.isFinite(value) || value < 0 || value > max ||
      next.end <= next.start || next.end - next.start > 10 || next.high <= next.low) {
      event.currentTarget.value = String(p[key]);
      return;
    }
    updateParams(module.id, key, value);
  }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} data-testid={`input-spectral-${key}-${module.id}`} /></label>;
  return <div className={`module-card ${module.enabled ? '' : 'bypassed'}`} data-testid={`card-module-${module.id}`}><div className="module-head"><span className="module-index">{String(index + 2).padStart(2, '0')}</span><span className="module-dot" /><button type="button" className="module-name text-left" onDoubleClick={() => { const name = window.prompt('Rename module', module.name); if (name?.trim()) updateModule(module.id, { name: name.trim() }); }} title="Double-click to rename" data-testid={`button-rename-${module.id}`}>{module.name}</button><span className="module-summary">{moduleSummary(module, humReadout)}</span><button type="button" className={`icon-btn !h-6 !min-w-6 ${module.enabled ? 'text-[hsl(var(--primary))]' : ''}`} onClick={() => updateModule(module.id, { enabled: !module.enabled })} aria-label={`${module.enabled ? 'Bypass' : 'Enable'} ${module.name}`} aria-pressed={module.enabled} data-testid={`button-bypass-${module.id}`}><Check size={13} /></button><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => moveModule(index, -1)} disabled={index === 0} aria-label="Move module up" data-testid={`button-up-${module.id}`}><ArrowUp size={12} /></button><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => moveModule(index, 1)} disabled={index === total - 1} aria-label="Move module down" data-testid={`button-down-${module.id}`}><ArrowDown size={12} /></button><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => duplicateModule(module)} aria-label={`Duplicate ${module.name}`} data-testid={`button-duplicate-${module.id}`}><Layers3 size={12} /></button><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => deleteModule(module.id)} aria-label={`Delete ${module.name}`} data-testid={`button-delete-${module.id}`}><Trash2 size={12} /></button></div>
    {!collapsed && <div className="module-controls">
      {module.type === 'gain' && numberInput('db', 'Gain', -30, 30, .1, ' dB', { resetValue: 0, wheelStep: 1 })}
      {module.type === 'fade' && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-md border border-border p-3 space-y-3">
          <label className="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" checked={Number(p.inEnabled) !== 0} onChange={(event) => updateParams(module.id, 'inEnabled', event.target.checked ? 1 : 0)} data-testid="toggle-fade-in" /> Fade In enabled</label>
          {numberInput('in', 'Fade in', 0, 20, .1, ' s')}
          <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="fade-in-usage-note">This creates a fade in from the Start marker position.</p>
        </div>
        <div className="rounded-md border border-border p-3 space-y-3">
          <label className="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" checked={Number(p.outEnabled) !== 0} onChange={(event) => updateParams(module.id, 'outEnabled', event.target.checked ? 1 : 0)} data-testid="toggle-fade-out" /> Fade Out enabled</label>
          {numberInput('out', 'Fade out', 0, 20, .1, ' s')}
          <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="fade-out-usage-note">This creates a fade out that ends at the End marker position.</p>
        </div>
      </div>}
      {module.type === 'eq' && p.mode === 'low-shelf' && <div className="space-y-2">
        <div className="grid grid-cols-3 gap-2">{numberInput('frequency', 'Low shelf', 20, 240, .5, ' Hz')}{numberInput('q', 'Q', .1, 2, .01)}{numberInput('gain', 'Gain', -12, 12, .1, ' dB')}</div>
        <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="bring-back-low-end-usage-note">Only use this filter if you previously used the Low Rumble Removal filter. This one attempts to bring back a bit of low end to smooth and compensate for what was removed with Low Rumble Removal. Adjust values to somewhat match what was used in the Low Rumble Removal filter, or adjust to taste.</p>
      </div>}
      {module.type === 'eq' && p.mode !== 'low-shelf' && <div className="grid grid-cols-3 gap-2">{numberInput('low', 'Low', -12, 12, .5, ' dB')}{numberInput('mid', 'Mid', -12, 12, .5, ' dB')}{numberInput('high', 'High', -12, 12, .5, ' dB')}</div>}
      {module.type === 'dc' && <div className="grid grid-cols-2 gap-3"><label><span className="field-label">Detection</span><select className="select-field" value={String(p.mode)} onChange={(event) => updateParams(module.id, 'mode', event.target.value)}><option>Auto</option><option>Manual</option></select></label>{p.mode === 'Manual' && numberInput('amount', 'Offset estimate', -100, 100, 1, ' ×10⁻³')}</div>}
       {module.type === 'hum' && <div className="grid grid-cols-2 gap-3"><label><span className="field-label">Mode</span><select className="select-field" value={String(p.mode)} onChange={(event) => updateParams(module.id, 'mode', event.target.value)} data-testid={`select-hum-mode-${module.id}`}><option>Static</option><option>Dynamic</option><option>Adaptive</option></select></label>{p.mode !== 'Adaptive' && numberInput('frequency', 'Fundamental', 40, 120, 1, ' Hz')}{numberInput('reduction', 'Reduction', 0, 24, 1, ' dB')}<p className="col-span-2 text-[11px] leading-relaxed" data-testid={`hum-scan-${module.id}`} role="status">{humReadout?.detail}</p>{liveFrequencies && <p className="col-span-2 text-[11px] leading-relaxed" data-testid={`hum-live-${module.id}`}>Now playing · estimated filters: {liveFrequencies.length ? liveFrequencies.map((frequency) => `${frequency.toFixed(1)} Hz`).join(', ') : 'none currently confirmed'}. Current position only, not a whole-recording measurement.</p>}<p className="col-span-2 text-[10px] leading-relaxed text-muted-foreground">{p.mode === 'Adaptive' ? 'Scans 20 Hz–20 kHz (or below the recording’s limit) for persistent tones, including isolated non-mains tones. A bounded opening scan starts confirmed filters at the first frame; short or changing sounds may not qualify.' : p.mode === 'Dynamic' ? 'Tracks a sustained tone near the selected frequency (±12%) and its harmonics. A bounded opening scan starts confirmed filters at the first frame; changing hum may still take time to detect. Preview before exporting.' : 'Applies fixed narrow filters at the selected frequency and its first few harmonics. Preview before exporting.'}</p>{p.mode === 'Adaptive' && <p className="col-span-2 text-[11px] leading-relaxed text-[#ffaf78]" role="note">Adaptive also reduces sustained wanted sounds, including held notes and calls. Compare with bypass before exporting.</p>}</div>}
       {module.type === 'noise' && <div className="space-y-2">
          <label className="block"><span className="field-label">Noise estimate</span><select className="select-field" value={p.mode === 'Sample' ? 'Sample' : 'Automatic'} onChange={(event) => updateParams(module.id, 'mode', event.target.value === 'Sample' ? 'Sample' : 'Automatic')} data-testid={`select-noise-mode-${module.id}`}><option value="Automatic">Automatic</option>{p.profile0 !== undefined && <option value="Sample">Noise-only sample</option>}</select></label>
          <button type="button" className="quiet-btn" onClick={() => void captureNoiseSample(module.id)} disabled={selectionLength < NOISE_SAMPLE_MIN_SECONDS || selectionLength > NOISE_SAMPLE_MAX_SECONDS} data-testid={`button-noise-sample-${module.id}`}>{p.profile0 !== undefined ? 'Replace sample with current selection' : 'Use current selection as noise-only sample'}</button>
          <p className="text-[11px] leading-relaxed text-muted-foreground">Select {NOISE_SAMPLE_MIN_SECONDS}–{NOISE_SAMPLE_MAX_SECONDS} seconds in the timeline. {p.mode === 'Sample' ? `Using ${formatTime(Number(p.sampleStart), true)}–${formatTime(Number(p.sampleEnd), true)} from the original recording. Switch to Automatic to compare; your sample stays available.` : 'Automatic estimation needs no sample.'}</p>
           <p className="text-[11px] leading-relaxed text-[#ffaf78]" role="note">Choose a passage with only steady background noise. Speech, animal calls, music, or other wanted sounds in the sample may be mistaken for noise and softened throughout the recording. Preset samples are only reused when the original recording can be verified; otherwise this step switches to Automatic until you capture a new sample.</p>
         {numberInput('strength', 'Reduction strength', 0, 100, 1, '%', { resetValue: 50, wheelStep: 5 })}
          <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="noise-reduction-usage-note">This gentle, stereo-linked reduction is approximate and may soften wanted ambience. It will not repair clicks, isolate voices, or remove all noise. Compare with bypass before exporting.</p>
       </div>}
        {module.type === 'click-pop' && <div className="space-y-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">Automatic detection</p>
          {numberInput('strength', 'Removal strength', 0, 100, 1, '%', { resetValue: 75, wheelStep: 5 })}
          <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="click-pop-usage-note">Targets short, isolated clicks and pops. Longer or overlapping sounds may remain, and wanted transients can be softened. Compare with bypass before exporting.</p>
        </div>}
       {module.type === 'wind' && (isFixedLowRumble(module)
          ? <div className="space-y-2">
            <div className="grid grid-cols-2 gap-3">{numberInput('cutoff', 'High-pass cutoff', 20, 240, .5, ' Hz')}{numberInput('q', 'Q', .1, 2, .01)}</div>
             <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="low-rumble-usage-note">Only use if there is audible low rumble. Adjust the frequency downward and Q value, if needed, to just remove low fluttering (rumble) noise, if present. It is set by default at 55 Hz, but reduce this as needed until you can just hear the rumble come back, then go up a bit. This filter can remove desirable low frequencies (thunder, etc.) that cannot be retrieved, so be careful.</p>
          </div>
         : <div className="space-y-2">
           <div className="grid grid-cols-2 gap-3">
             {([['detection', 'Detection sensitivity'], ['removal', 'Removal strength']] as const).map(([key, label]) =>
               <label key={key}><span className="field-label">{label}</span><select className="select-field" value={String(p[key] ?? 'Medium')} onChange={(event) => updateParams(module.id, key, event.target.value)} data-testid={`select-wind-${key}-${module.id}`}>
                 <option>Low</option><option>Medium</option><option>High</option>
               </select></label>)}
           </div>
           <p role="status" className="text-[11px] leading-relaxed" data-testid={`wind-activity-${module.id}`}>
              {!module.enabled ? 'Bypassed · no wind reduction applied.' : windActive === null || windActive === undefined ? 'Play edited audio to check this position; the timeline below keeps recent confirmed observations.' : windActive ? 'Now playing · low-frequency interference detected; reduction active.' : 'Now playing · no interference confirmed here; reduction idle.'}
           </p>
            {module.enabled && <WindHistoryTimeline moduleId={module.id} moduleName={module.name} segments={windHistory} sampleRate={sampleRate} duration={duration} />}
            <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="wind-rumble-usage-note">This item is far from perfect and you can end up removing sounds you want to keep, so be careful using it. Some wind noise overloads the microphones so much that it simply cannot be removed with a filter of this type or by any means. Remember that some wind noise is not so bad because it can simulate what your ears hear when out in the wind, which is realistic and generally accepted and sometimes desired.</p>
           <p className="text-[10px] leading-relaxed text-muted-foreground">Automatic detection is approximate. Wanted bass or low calls may be reduced; some wind may remain. Older saved wind edits now use automatic settings and may sound different. Compare with bypass before exporting.</p>
         </div>)}
        {module.type === 'wind' && isFixedLowRumble(module) && <EqCurve module={module} sampleRate={sampleRate} />}
        {module.type === 'wind' && <div className="rounded-md border border-border p-3 space-y-3" data-testid={`low-end-controls-${module.id}`}>
          <label className="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" checked={lowEndShelfEnabled(p)} onChange={(event) => updateParams(module.id, 'lowEndEnabled', event.target.checked ? 1 : 0)} data-testid={`toggle-low-end-${module.id}`} /> Bring Back the Low End</label>
           {!isFixedLowRumble(module) && <label className="block"><span className="field-label">Apply compensation</span><select className="select-field" value={lowEndShelfFollowsWind(p) ? WIND_SHELF_SCOPE_DETECTED : WIND_SHELF_SCOPE_WHOLE} onChange={(event) => updateParams(module.id, 'lowEndScope', event.target.value)} data-testid={`select-low-end-scope-${module.id}`}><option value={WIND_SHELF_SCOPE_WHOLE}>Whole recording</option><option value={WIND_SHELF_SCOPE_DETECTED}>Detected wind only</option></select></label>}
          <div className="grid grid-cols-3 gap-2">
            {numberInput('lowEndFrequency', 'Low shelf', 20, 240, .5, ' Hz')}
            {numberInput('lowEndQ', 'Q', .1, 2, .01)}
            {numberInput('lowEndGain', 'Gain', -12, 12, .1, ' dB')}
          </div>
           {!isFixedLowRumble(module) && lowEndShelfEnabled(p) && lowEndShelfFollowsWind(p) && <div className="space-y-2 border-t border-border pt-3" data-testid={`wind-compensation-timing-${module.id}`}>
             <div className="text-[11px] font-semibold">Detected-wind fade timing</div>
             <div className="grid grid-cols-2 gap-3">
               <RangeControl label="Attack" value={windCompensationTiming(p).attackMs} min={WIND_COMPENSATION_TIMING.attack.minMs} max={WIND_COMPENSATION_TIMING.attack.maxMs} step={5} suffix=" ms" resetValue={WIND_COMPENSATION_TIMING.attack.defaultMs} onChange={(value) => updateParams(module.id, 'compensationAttackMs', value)} testId={`range-wind-compensation-attack-${module.id}`} />
               <RangeControl label="Release" value={windCompensationTiming(p).releaseMs} min={WIND_COMPENSATION_TIMING.release.minMs} max={WIND_COMPENSATION_TIMING.release.maxMs} step={10} suffix=" ms" resetValue={WIND_COMPENSATION_TIMING.release.defaultMs} onChange={(value) => updateParams(module.id, 'compensationReleaseMs', value)} testId={`range-wind-compensation-release-${module.id}`} />
             </div>
             <p className="text-[10px] leading-relaxed text-muted-foreground">These fades affect detected-wind low-end compensation only. Wind Removal’s own response keeps its existing timing. Double-click a control to restore its default.</p>
           </div>}
            <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid={`bring-back-low-end-usage-note-${module.id}`}>Only use this filter if you previously used the {isFixedLowRumble(module) ? 'Low Rumble Removal' : 'Wind Removal'} filter. This one attempts to bring back a bit of low end to smooth and compensate for what was removed with {isFixedLowRumble(module) ? 'Low Rumble Removal' : 'Wind Removal'}. {isFixedLowRumble(module) ? 'Adjust values to somewhat match the removed filter, or adjust to taste.' : lowEndShelfFollowsWind(p) ? 'Detected-wind mode follows the detector with the adjustable fade timing above, leaving other passages unchanged.' : 'Whole-recording mode keeps the shelf active throughout, as before.'}</p>
        </div>}
        {module.type === 'wind' && <EqCurve module={module} sampleRate={sampleRate} profile="low-end" />}
        {module.type === 'eq' && <EqCurve module={module} sampleRate={sampleRate} />}
      {module.type === 'region' && <div className="grid grid-cols-3 gap-2">{numberInput('start', 'Start', 0, 60, .1, ' s')}{numberInput('end', 'End', 0, 60, .1, ' s')}{numberInput('amount', 'Attenuate', -24, 0, .5, ' dB')}</div>}
      {module.type === 'spectral-repair' && <div className="spectral-module-settings">
        <p className="spectral-module-note">One rectangle, restored independently in each channel. The original recording remains untouched.</p>
        <div className="spectral-bounds-grid">
          {spectralBoundInput('start', 'Start', 86400, .001)}
          {spectralBoundInput('end', 'End', 86400, .001)}
          {spectralBoundInput('low', 'Low', sampleRate / 2, 1)}
          {spectralBoundInput('high', 'High', sampleRate / 2, 1)}
        </div>
         <label><span className="field-label">Repair mode</span><select className="select-field" value={String(p.mode)} onChange={(event) => updateParams(module.id, 'mode', event.target.value)} data-testid={`select-spectral-mode-${module.id}`}><option>Attenuate</option><option>Replace</option><option>Pattern Suppress</option><option>Harmonic Suppress</option></select></label>
         <p className="spectral-module-note" data-testid={`spectral-mode-help-${module.id}`}>
           {p.mode === 'Pattern Suppress' ? 'For intermittent repeating interference: estimates a typical level from nearby audio on both sides and reduces louder bursts in the selected band. If the pattern fills most of the context, it may remain.' :
             p.mode === 'Harmonic Suppress' ? 'For a known repeating set of tones: reduces narrow multiples of the fundamental frequency within the selected band. Wanted harmonics at those frequencies may also be reduced.' :
               p.mode === 'Replace' ? 'For a short localized defect: blends complex spectra from before and after the selection. Long or changing sounds may not match.' :
                 'For a louder localized event: limits selected frequencies toward nearby audio while retaining the local phase.'}
         </p>
         {p.mode === 'Harmonic Suppress' && <label><span className="field-label">Harmonic fundamental (Hz)</span><input className="input-field font-mono-value" type="number" min={20} max={sampleRate / 2} step={1} value={Number(p.fundamental ?? 100)} onChange={(event) => {
           const value = Number(event.target.value);
           if (Number.isFinite(value) && value >= 20 && value <= sampleRate / 2) updateParams(module.id, 'fundamental', value);
         }} data-testid={`input-spectral-fundamental-${module.id}`} /></label>}
        {numberInput('strength', 'Strength', 0, 100, 1, '%', { resetValue: 75, wheelStep: 5 })}
         {numberInput('context', 'Context', .02, 1, .01, ' s', { resetValue: .2 })}
         {p.mode !== 'Harmonic Suppress' && numberInput('weighting', 'Before / after weighting', 0, 100, 1, '%', { resetValue: 50, wheelStep: 5 })}
          <p className="spectral-module-note">{p.mode === 'Harmonic Suppress' ? 'Context and before / after weighting do not affect this mode. Compare with bypass before exporting.' : '0% favors audio after; 100% favors audio before; 50% balances both. Compare with bypass before exporting.'}</p>
      </div>}
      {module.type === 'ambient' && <div className="grid grid-cols-3 gap-2">{numberInput('start', 'Start', 0, 60, .1, ' s')}{numberInput('length', 'Length', .1, 8, .1, ' s')}{<div className="text-[10px] leading-relaxed text-muted-foreground self-end">Blends nearby ambience conservatively.</div>}</div>}
      <div className="text-[10px] text-muted-foreground flex items-center gap-1"><Info size={11} /> Browser-safe approximation. Preview before archival export.</div>
    </div>}
  </div>;
}

function AnalyzePanel({ originalStats, currentStats, selectionOriginalStats, selectionCurrentStats, duration, selection, trim, hasSelection, modules }: { originalStats: LoudnessStats; currentStats: LoudnessStats; selectionOriginalStats: LoudnessStats; selectionCurrentStats: LoudnessStats; duration: number; selection: [number, number]; trim: [number, number]; hasSelection: boolean; modules: EditModule[] }) {
  const keptSelectionDuration = Math.max(0, Math.min(selection[1], trim[1]) - Math.max(selection[0], trim[0]));
  const isTrimmed = trim[0] > 0 || trim[1] < duration;
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
            <div className="eyebrow mb-2">Edited / kept range · {formatTime(trim[1] - trim[0])}</div>
            <StatsGrid stats={currentStats} />
          </div>
          <div>
            <div className="eyebrow mb-2">{hasSelection ? `Edited / selection within kept range · ${formatTime(keptSelectionDuration)}` : 'Edited / no selection'}</div>
            {hasSelection ? keptSelectionDuration > 0 ? <StatsGrid stats={selectionCurrentStats} /> : <div className="text-[11px] text-muted-foreground">Selection is outside the edited range.</div> : <div className="text-[11px] text-muted-foreground">Select a range to analyze it.</div>}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <div className="section-title">Original vs Current comparison</div>
            <div className="text-[10px] text-muted-foreground mt-1">{isTrimmed ? 'Original and Edited cover different durations; differences include trimming and enabled edits.' : 'A/B changes introduced by the enabled edit chain'}</div>
          </div>
          <span className="chip">{modules.filter((module) => module.enabled).length} edits enabled</span>
        </div>
        <div className="panel-body grid md:grid-cols-2 gap-5">
          <SignalComparison title={isTrimmed ? `Original full file ${formatTime(duration)} / Edited kept range ${formatTime(trim[1] - trim[0])}` : `Full file · ${formatTime(duration)}`} original={originalStats} current={currentStats} />
          {hasSelection ? keptSelectionDuration > 0 ? <SignalComparison title={isTrimmed ? `Original selection ${formatTime(selection[1] - selection[0])} / Edited intersecting range ${formatTime(keptSelectionDuration)}` : `Selection · ${formatTime(selection[1] - selection[0])}`} original={selectionOriginalStats} current={selectionCurrentStats} /> : <div className="text-[11px] text-muted-foreground">Selection is outside the edited range; there is no Edited comparison.</div> : <div className="text-[11px] text-muted-foreground">No selection · full track playback</div>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><div className="section-title">Interpretation notes</div></div>
        <div className="panel-body grid md:grid-cols-3 gap-3 text-[12px]">
          <div className="border-l-2 border-[#d8ed55] pl-3"><strong>Loudness context</strong><p className="text-muted-foreground mt-1 leading-relaxed">Use integrated loudness for the overall program and loudness range (LRA) for long-term variation. LRA needs at least two valid 3-second readings; shorter or silent ranges show N/A. PLR is estimated true peak minus integrated loudness. LBPR uses sample peaks and the loudest 20% of non-silent, non-overlapping 3-second RMS blocks; it includes a final partial block and is a DR14-style estimate, not official TT DR. Preserve headroom for archival work.</p></div>
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
        <div className="stat-cell"><div className="stat-value">{formatLra(original.loudnessRangeLu)}</div><div className="stat-label">Original loudness range (LRA)</div></div>
        <div className="stat-cell"><div className="stat-value">{formatLra(current.loudnessRangeLu)}</div><div className="stat-label">Current loudness range (LRA)</div></div>
        <div className="stat-cell"><div className="stat-value">{formatLevel(original.maxShortTermLufs, 'LUFS')}</div><div className="stat-label">Original max short-term</div></div>
        <div className="stat-cell"><div className="stat-value">{formatLevel(current.maxShortTermLufs, 'LUFS')}</div><div className="stat-label">Current max short-term</div></div>
        <PlrStat stats={original} label="Original peak-to-loudness ratio (PLR)" />
        <PlrStat stats={current} label="Current peak-to-loudness ratio (PLR)" />
        <LbprStat stats={original} label="Original Loud-Block Peak-to-RMS (LBPR)" />
        <LbprStat stats={current} label="Current Loud-Block Peak-to-RMS (LBPR)" />
      </div>
    </div>
  );
}

type ProjectPanelProps = {
  title: string;
  notes: string;
  setTitle: (value: string) => void;
  setNotes: (value: string) => void;
  what3wordsAddress: string;
  setWhat3wordsAddress: (value: string) => void;
  descriptiveWords: string[];
  setDescriptiveWords: (words: string[]) => void;
  source: AudioSource;
  sourceChannelCount: number;
  save: () => void;
  openSettings: (event: ReactMouseEvent<HTMLButtonElement>) => void;
};

function ProjectPanel({ title, notes, setTitle, setNotes, what3wordsAddress, setWhat3wordsAddress, descriptiveWords, setDescriptiveWords, source, sourceChannelCount, save, openSettings }: ProjectPanelProps) {
  const [wordDraft, setWordDraft] = useState('');
  const mapUrl = what3wordsMapUrl(what3wordsAddress);
  const filenames = exportFilenames(title, source.name, descriptiveWords);
  const addWords = () => {
    const words = [...descriptiveWords];
    for (const entry of wordDraft.split(/[,;\n]+/)) {
      const word = entry.trim();
      const token = filenameWord(word);
      if (token && !words.some((saved) => filenameWord(saved) === token)) words.push(word);
    }
    setDescriptiveWords(words);
    setWordDraft('');
  };

  return <div className="space-y-4">
    <section className="panel">
      <div className="panel-header project-save-header">
        <div className="section-title">Project metadata</div>
        <div className="project-save-action">
          <button type="button" className="primary-btn" onClick={save} aria-describedby="project-save-description" data-testid="button-project-save"><Save size={14} /> Save project</button>
          <p id="project-save-description" className="text-[11px] leading-relaxed text-muted-foreground">{SAVE_PROJECT_DESCRIPTION}</p>
        </div>
      </div>
      <div className="panel-body space-y-5 max-w-[740px]">
        <label><span className="field-label">Project title</span><input className="input-field text-[16px]" value={title} onChange={(event) => setTitle(event.target.value)} data-testid="input-project-title" /></label>
        <div>
          <label htmlFor="project-what3words" className="field-label">What3Words location</label>
          <input id="project-what3words" className="input-field" value={what3wordsAddress} onChange={(event) => setWhat3wordsAddress(event.target.value)} placeholder="///filled.count.soap" spellCheck={false} autoComplete="off" data-testid="input-project-what3words" />
          <div className="project-location-links">
            {mapUrl
              ? <a href={mapUrl} target="_blank" rel="noopener noreferrer" data-testid="link-what3words-map">Open location on What3Words map <ExternalLink size={12} aria-hidden="true" /></a>
              : <span>{what3wordsAddress.trim() ? 'Enter three words separated by periods to open the map.' : 'Add a three-word address to open its map.'}</span>}
            <a href="https://what3words.com/" target="_blank" rel="noopener noreferrer" data-testid="link-what3words-choose">Choose a location on What3Words <ExternalLink size={12} aria-hidden="true" /></a>
          </div>
          <p className="project-metadata-hint">Links open an external site and share the address you enter with What3Words. The app does not look up or verify addresses.</p>
        </div>
        <div>
          <label htmlFor="project-descriptive-word" className="field-label">Descriptive words for export</label>
          <div className="project-word-entry">
            <input id="project-descriptive-word" className="input-field" value={wordDraft} onChange={(event) => setWordDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addWords(); } }} placeholder="Add a word (or separate several with commas)" data-testid="input-project-descriptive-word" />
            <button type="button" className="quiet-btn" onClick={addWords} disabled={!wordDraft.trim()} data-testid="button-add-descriptive-word"><Plus size={13} /> Add</button>
          </div>
          {descriptiveWords.length > 0 && <ul className="project-word-list" aria-label="Descriptive words" data-testid="list-project-descriptive-words">
            {descriptiveWords.map((word, index) => <li key={`${index}-${word}`} className="project-word-chip">{word}<button type="button" aria-label={`Remove ${word}`} onClick={() => setDescriptiveWords(descriptiveWords.filter((_, wordIndex) => wordIndex !== index))}><X size={12} /></button></li>)}
          </ul>}
          <p className="project-metadata-hint">WAV filename: <span className="font-mono-value break-all" data-testid="text-export-filename">{filenames.wav}</span></p>
        </div>
        <label><span className="field-label">Field notes</span><textarea className="textarea-field min-h-[170px]" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Describe place, mic, weather, handling, and decisions…" data-testid="textarea-project-notes" /></label>
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="p-3 bg-[hsl(var(--muted))] rounded"><div className="eyebrow">Source</div><div className="font-mono-value text-[11px] mt-2 truncate">{source.name}</div></div>
          <div className="p-3 bg-[hsl(var(--muted))] rounded"><div className="eyebrow">Format</div><div className="font-mono-value text-[11px] mt-2">{source.sampleRate / 1000} kHz / {sourceChannelCount} ch</div></div>
          <div className="p-3 bg-[hsl(var(--muted))] rounded"><div className="eyebrow">Duration</div><div className="font-mono-value text-[11px] mt-2">{formatTime(source.duration)}</div></div>
        </div>
      </div>
    </section>
    <section className="panel">
      <div className="panel-header"><div className="section-title">Local-first guarantees</div></div>
      <div className="panel-body grid sm:grid-cols-2 gap-3 text-[12px]">
        <div className="border rounded p-3"><Check size={15} color="hsl(var(--primary))" /><div className="font-semibold mt-2">Original is immutable</div><div className="text-muted-foreground mt-1 leading-relaxed">All processing reads from the original local file. No destructive overwrite occurs.</div></div>
        <div className="border rounded p-3"><Check size={15} color="hsl(var(--primary))" /><div className="font-semibold mt-2">No network required for audio</div><div className="text-muted-foreground mt-1 leading-relaxed">WAV parsing, DSP estimates, playback, persistence, and export happen in this tab. Location links open What3Words separately.</div></div>
        <button type="button" className="quiet-btn justify-self-start" onClick={openSettings} data-testid="button-project-settings"><Settings size={14} /> Storage settings</button>
      </div>
    </section>
  </div>;
}

function ExportModal({ onClose, onExport, title }: { onClose: () => void; onExport: () => void; title: string }) {
  return <div className="modal-backdrop" role="presentation"><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className="modal-header"><div><div className="eyebrow">Output / local files</div><h2 id="export-title" className="text-[17px] font-bold mt-1">Export restoration</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="Close export dialog" data-testid="button-close-export"><X size={16} /></button></div><div className="modal-body space-y-4"><div className="p-3 bg-[hsl(var(--muted))] rounded text-[12px]"><div className="font-semibold">{title || 'Untitled project'}</div><div className="text-muted-foreground mt-1">Two files will be created: a valid WAV and a machine-readable restoration report.</div></div><div className="block p-3 border border-[hsl(var(--primary))] bg-[hsl(var(--muted))] rounded"><strong className="text-[12px]">Archival WAV · 32-bit IEEE float</strong><span className="block text-[11px] text-muted-foreground mt-1">Preserves floating-point precision, source sample rate, channel count, and stereo relationship. No normalization or dither is applied.</span></div><div className="text-[11px] text-muted-foreground border-l-2 border-[#ff8a4c] pl-3">Previously saved projects may sound different when reprocessed with the improved DC correction. The original recording stays untouched and is never replaced.</div></div><div className="modal-footer"><button type="button" className="quiet-btn" onClick={onClose} data-testid="button-cancel-export">Cancel</button><button type="button" className="primary-btn" onClick={onExport} data-testid="button-confirm-export"><Download size={14} /> Export 32-bit float WAV + report</button></div></div></div>;
}

function HelpModal({ onClose }: { onClose: () => void }) {
  return <div className="modal-backdrop"><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="help-title"><div className="modal-header"><div><div className="eyebrow">Field notes</div><h2 id="help-title" className="text-[17px] font-bold mt-1">A quiet tool for noisy places</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="Close help" data-testid="button-close-help"><X size={16} /></button></div><div className="modal-body"><p className="text-[12px] leading-relaxed text-muted-foreground">Field Restore intentionally favors small, reversible moves. Import a WAV, select a moment, listen against the original, and keep an ear on the source—not just the meters.</p><div className="mt-4"><div className="eyebrow mb-2">Keyboard</div><div className="help-row"><span className="keycap">Space</span><span>Play / pause</span></div><div className="help-row"><span className="keycap">⌘ Z</span><span>Undo chain edit</span></div><div className="help-row"><span className="keycap">⇧⌘ Z</span><span>Redo chain edit</span></div><div className="help-row"><span className="keycap">Esc</span><span>Close a dialog or menu</span></div></div><div className="mt-5 p-3 bg-[hsl(var(--muted))] rounded text-[11px] leading-relaxed"><Keyboard size={14} className="inline mr-2 -mt-0.5" />For critical work, verify the exported WAV in a second application. Browser DSP here is conservative and deliberately labeled as an estimate.</div></div><div className="modal-footer"><button type="button" className="primary-btn" onClick={onClose} data-testid="button-done-help">Back to work</button></div></div></div>;
}

function SettingsModal({ onClose, spectrogramPalette, onSpectrogramPaletteChange }: { onClose: () => void; spectrogramPalette: SpectrogramPaletteId; onSpectrogramPaletteChange: (palette: SpectrogramPaletteId) => void }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggleTheme = () => { const next = !dark; setDark(next); document.documentElement.classList.toggle('dark', next); localStorage.setItem('field-restore-theme', next ? 'dark' : 'light'); };
  return <div className="modal-backdrop">
    <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="modal-header"><div><div className="eyebrow">Instrument settings</div><h2 id="settings-title" className="text-[17px] font-bold mt-1">Preferences</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings" data-testid="button-close-settings"><X size={16} /></button></div>
      <div className="modal-body space-y-4">
        <div className="flex items-center justify-between border rounded p-3">
          <div><div className="text-[12px] font-semibold">Darkroom contrast</div><div className="text-[11px] text-muted-foreground mt-1">Switch to a darker monitoring surface.</div></div>
          <button type="button" className={`quiet-btn ${dark ? '!bg-[hsl(var(--primary))] !text-[hsl(var(--primary-foreground))]' : ''}`} onClick={toggleTheme} aria-pressed={dark} data-testid="button-toggle-theme">{dark ? 'On' : 'Off'}</button>
        </div>
        <fieldset><legend className="field-label">Spectrogram color scale</legend><div className="palette-grid">{(Object.entries(SPECTROGRAM_PALETTES) as Array<[SpectrogramPaletteId, typeof SPECTROGRAM_PALETTES[SpectrogramPaletteId]]>).map(([id, palette]) => <button key={id} type="button" className={`palette-option ${spectrogramPalette === id ? 'selected' : ''}`} onClick={() => onSpectrogramPaletteChange(id)} aria-pressed={spectrogramPalette === id} data-testid={`button-palette-${id}`}><span className="palette-swatch" style={{ background: `linear-gradient(90deg, ${palette.stops.map(([position, color]) => `${color} ${position * 100}%`).join(', ')})` }} /><span><strong>{palette.label}</strong><small>{palette.description}</small></span>{spectrogramPalette === id && <Check size={14} />}</button>)}</div></fieldset>
        <div className="border rounded p-3 text-[11px] leading-relaxed text-muted-foreground"><RotateCcw size={14} className="inline mr-2 -mt-0.5" />Projects are stored in this browser. Audio stays on this device; opening a What3Words location link shares that address with What3Words.</div>
      </div>
      <div className="modal-footer"><button type="button" className="primary-btn" onClick={onClose} data-testid="button-done-settings">Done</button></div>
    </div>
  </div>;
}

export default App;

const EMPTY_FREQUENCIES: number[][] = [];
