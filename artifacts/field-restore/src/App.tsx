import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Activity, ArrowDown, ArrowUp, Check, ChevronDown, CircleHelp, Download, FileAudio, FolderOpen, Gauge, Info, Keyboard, Layers3, Menu, Pause, Play, Plus, Redo2, RotateCcw, Save, Settings, Square, Trash2, Undo2, Waves, X, ZoomIn, ZoomOut } from 'lucide-react';
import { createDemoAudio, downloadBlob, encodeWav, parseWav, type AudioSource } from '@/lib/audio';
import { decodeChannels, loadProject, projectFromSource, saveProject } from '@/lib/persistence';
import { makeDefaultChain, makeModule, makeProcessingChain, makeRestorationReport, MODULE_LABELS, renderChain, withoutLegacyDcModules, type EditModule, type ModuleType } from '@/lib/edit-chain';
import { analyzeLoudness, type LoudnessStats } from '@/lib/loudness';
import { createPlaybackRangePlan } from '@/lib/playback-range';
import { calculateSpectrogram, type SpectrogramData } from '@/lib/spectrogram';
import { fingerprintWav, parseWavMetadata, readFrames, withLargeExportLeaveWarning, writeFloat32WavChunks, type WavMetadata } from '@/lib/large-wav';
import { isVerifiedRelink, openVerifiedFileHandle } from '@/lib/file-access';
import { listProjects, loadProject as loadProjectV2, queryFileHandlePermission, requestFileHandlePermission, saveProject as saveProjectV2, type ProjectRecord } from '@/lib/project-store';
import { createStreamingEditChain } from '@/lib/streaming-edit-chain';
import { anchoredLevelScaleCeiling, anchoredTimeViewStart } from '@/lib/spectrogram-scale';
import { SPECTROGRAM_DATA_HEIGHT, SPECTROGRAM_FFT_SIZE } from '@/lib/spectrogram-resolution';
import { startWorkerJob, type WorkerJob } from '@/lib/worker-analysis';
import type { LargeAnalysisResult } from '@/lib/large-analysis';
import './index.css';

type ViewTab = 'edit' | 'analyze' | 'project';
type MonitorMode = 'current' | 'original';
type SpectrogramPaletteId = 'cyan-orange' | 'field-restore' | 'magma' | 'grayscale';
type Marker = { id: string; time: number; label: string; color: string };
type Region = { id: string; start: number; end: number; label: string };
type LargeSource = { file: File; metadata: WavMetadata; fingerprint: string; fileHandle?: FileSystemFileHandle };
type SpectrogramView = {
  left: SpectrogramData;
  right: SpectrogramData;
  startSeconds: number;
  durationSeconds: number;
};

const MODULE_TYPES: ModuleType[] = ['gain', 'fade', 'eq', 'hum', 'wind', 'region', 'ambient'];
const SPECTROGRAM_LEFT = 48;
const SPECTROGRAM_RIGHT = 72;
const SPECTROGRAM_BOTTOM = 28;
const SPECTROGRAM_SCALE_DIVISIONS = 5;
const SPECTROGRAM_MAX_CEILING_DB = 24;
const SPECTROGRAM_DATA_FLOOR_DB = -180;
const SPECTROGRAM_DATA_CEILING_DB = 0;
const SPECTROGRAM_MIN_LEVEL_SPAN_DB = 10;
const SPECTROGRAM_MAX_LEVEL_SPAN_DB = 180;
const SPECTROGRAM_DISPLAY_HEIGHT = 110;
const EMPTY_STATS: LoudnessStats = { truePeakDbtp: -Infinity, integratedLufs: -Infinity, loudnessRangeLu: 0, maxShortTermLufs: -Infinity };
const EMPTY_SPECTROGRAM = { width: 480, height: 110, values: new Float32Array(480 * 110) };
const SPECTROGRAM_PALETTES: Record<SpectrogramPaletteId, { label: string; description: string; stops: Array<[number, string]> }> = {
  'cyan-orange': {
    label: 'Cyan → orange',
    description: 'Cool detail with warm peaks',
    stops: [[0, '#071018'], [0.2, '#0a2943'], [0.4, '#075e78'], [0.58, '#09a4b1'], [0.73, '#7bd1be'], [0.86, '#e5cf72'], [1, '#f1873f']],
  },
  'field-restore': {
    label: 'Field Restore',
    description: 'Original blue, green, and amber scale',
    stops: [[0, '#0e1b26'], [0.35, '#2d6570'], [0.55, '#547b7b'], [0.72, '#989a56'], [1, '#f0a12e']],
  },
  magma: {
    label: 'Magma',
    description: 'Dark violet through coral and gold',
    stops: [[0, '#09071b'], [0.24, '#32115d'], [0.48, '#7b2382'], [0.7, '#d64d68'], [0.86, '#f58b4b'], [1, '#f8df8b']],
  },
  grayscale: {
    label: 'Grayscale',
    description: 'Neutral monochrome contrast',
    stops: [[0, '#090d10'], [0.35, '#303b42'], [0.68, '#87949a'], [1, '#f2f4ed']],
  },
};

function hexToRgb(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16, (value >> 8) & 255, value & 255] as const;
}

function spectrogramColor(intensity: number, paletteId: SpectrogramPaletteId) {
  const stops = SPECTROGRAM_PALETTES[paletteId].stops;
  const value = Math.max(0, Math.min(1, intensity));
  const upperIndex = stops.findIndex(([position]) => position >= value);
  if (upperIndex <= 0) return hexToRgb(stops[0][1]);
  const [lowerPosition, lowerHex] = stops[upperIndex - 1];
  const [upperPosition, upperHex] = stops[upperIndex];
  const amount = (value - lowerPosition) / Math.max(0.0001, upperPosition - lowerPosition);
  const lower = hexToRgb(lowerHex);
  const upper = hexToRgb(upperHex);
  return lower.map((channel, index) => Math.round(channel + (upper[index] - channel) * amount)) as unknown as readonly [number, number, number];
}

function spectrogramColorCss(intensity: number, paletteId: SpectrogramPaletteId) {
  const [red, green, blue] = spectrogramColor(intensity, paletteId);
  return `rgb(${red}, ${green}, ${blue})`;
}

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
  const [modules, setModules] = useState<EditModule[]>(makeDefaultChain);
  const [undoStack, setUndoStack] = useState<EditModule[][]>([]);
  const [redoStack, setRedoStack] = useState<EditModule[][]>([]);
  const [selection, setSelection] = useState<[number, number]>([4.1, 7.8]);
  const [markers, setMarkers] = useState<Marker[]>([]);
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
  const [spectrogramMinFrequency, setSpectrogramMinFrequency] = useState(0);
  const [spectrogramMaxFrequency, setSpectrogramMaxFrequency] = useState(20000);
  const [spectrogramCeilingDb, setSpectrogramCeilingDb] = useState(-20);
  const [spectrogramLevelSpanDb, setSpectrogramLevelSpanDb] = useState(85);
  const [spectrogramPalette, setSpectrogramPalette] = useState<SpectrogramPaletteId>(() => {
    const saved = localStorage.getItem('field-restore-spectrogram-palette');
    return saved && saved in SPECTROGRAM_PALETTES ? saved as SpectrogramPaletteId : 'cyan-orange';
  });
  const [timeViewCenter, setTimeViewCenter] = useState<number | null>(null);
  const [largeSource, setLargeSource] = useState<LargeSource | null>(null);
  const [largeSpectrograms, setLargeSpectrograms] = useState<SpectrogramView>({
    left: EMPTY_SPECTROGRAM,
    right: EMPTY_SPECTROGRAM,
    startSeconds: 0,
    durationSeconds: source.duration,
  });
  const [largeOriginalStats, setLargeOriginalStats] = useState<LoudnessStats>(EMPTY_STATS);
  const [largeCurrentStats, setLargeCurrentStats] = useState<LoudnessStats>(EMPTY_STATS);
  const [largeSelectionOriginalStats, setLargeSelectionOriginalStats] = useState<LoudnessStats>(EMPTY_STATS);
  const [largeSelectionCurrentStats, setLargeSelectionCurrentStats] = useState<LoudnessStats>(EMPTY_STATS);
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
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const playHeadRef = useRef(0);
  const selectionRef = useRef<[number, number]>([4.1, 7.8]);
  const pointerDragRef = useRef<{ start: number; current: number; startClientX: number; moved: boolean } | null>(null);
  const frequencyDragRef = useRef<{ startY: number; startMaximum: number } | null>(null);
  const levelDragRef = useRef<{
    grabbedLevel: number;
    paneTop: number;
    paneHeight: number;
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
  const spectrogramGenerationRef = useRef(0);
  const backgroundPausedRef = useRef(false);
  const exportJobRef = useRef<AbortController | null>(null);
  const scheduledNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const playbackSessionRef = useRef(0);

  const processingModules = useMemo(() => makeProcessingChain(modules), [modules]);
  const currentChannels = useMemo(() => largeSource ? [] : renderChain(source.channels, processingModules, source.sampleRate), [largeSource, source.channels, source.sampleRate, processingModules]);
  const currentSource = useMemo<AudioSource>(() => ({ ...source, channels: currentChannels }), [source, currentChannels]);
  const duration = source.duration;
  const sourceChannelCount = largeSource?.metadata.channels ?? Number(pendingRelink?.source.channels ?? source.channels.length);
  const viewDuration = duration / zoom;
  const selectionStart = Math.min(...selection);
  const selectionEnd = Math.max(...selection);
  const selectionCenter = selectionStart + (selectionEnd - selectionStart) / 2 || duration / 2;
  const viewCenter = timeViewCenter ?? selectionCenter;
  const viewStart = zoom === 1 ? 0 : Math.max(0, Math.min(duration - viewDuration, viewCenter - viewDuration / 2));
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
  const memorySpectrograms = useMemo(
    () => ({
      left: largeSource || !currentChannels[0] ? EMPTY_SPECTROGRAM : calculateSpectrogram([currentChannels[0]], source.sampleRate, memorySpectrogramView.startSeconds, memorySpectrogramView.durationSeconds, 480, SPECTROGRAM_DATA_HEIGHT, 0, source.sampleRate / 2, SPECTROGRAM_DATA_FLOOR_DB, SPECTROGRAM_DATA_CEILING_DB, SPECTROGRAM_FFT_SIZE),
      right: largeSource || !currentChannels[0] ? EMPTY_SPECTROGRAM : calculateSpectrogram([currentChannels[1] ?? currentChannels[0]], source.sampleRate, memorySpectrogramView.startSeconds, memorySpectrogramView.durationSeconds, 480, SPECTROGRAM_DATA_HEIGHT, 0, source.sampleRate / 2, SPECTROGRAM_DATA_FLOOR_DB, SPECTROGRAM_DATA_CEILING_DB, SPECTROGRAM_FFT_SIZE),
      startSeconds: memorySpectrogramView.startSeconds,
      durationSeconds: memorySpectrogramView.durationSeconds,
    }),
    [currentChannels, largeSource, memorySpectrogramView, source.sampleRate],
  );
  const spectrograms = largeSource ? largeSpectrograms : memorySpectrograms;
  const memoryOriginalStats = useMemo(() => largeSource ? EMPTY_STATS : analyzeLoudness(source.channels, source.sampleRate), [largeSource, source.channels, source.sampleRate]);
  const memoryCurrentStats = useMemo(() => largeSource ? EMPTY_STATS : analyzeLoudness(currentChannels, source.sampleRate), [currentChannels, largeSource, source.sampleRate]);
  const memorySelectionOriginalStats = useMemo(() => largeSource ? EMPTY_STATS : analyzeLoudness(source.channels, source.sampleRate, selectionStart * source.sampleRate, selectionEnd * source.sampleRate), [largeSource, source.channels, selectionStart, selectionEnd, source.sampleRate]);
  const memorySelectionCurrentStats = useMemo(() => largeSource ? EMPTY_STATS : analyzeLoudness(currentChannels, source.sampleRate, selectionStart * source.sampleRate, selectionEnd * source.sampleRate), [currentChannels, largeSource, selectionStart, selectionEnd, source.sampleRate]);
  const originalStats = largeSource ? largeOriginalStats : memoryOriginalStats;
  const currentStats = largeSource ? largeCurrentStats : memoryCurrentStats;
  const selectionOriginalStats = largeSource ? largeSelectionOriginalStats : memorySelectionOriginalStats;
  const selectionCurrentStats = largeSource ? largeSelectionCurrentStats : memorySelectionCurrentStats;

  const stageSavedProject = useCallback((record: ProjectRecord) => {
    setProjectId(null);
    setTitle(record.source.name.replace(/\.wav$/i, ''));
    setNotes('');
    setModules([]);
    setMarkers([]);
    setRegions([]);
    setLargeSource(null);
    setSource({ channels: [], sampleRate: record.source.sampleRate, duration: Number(record.source.duration ?? 0), name: record.source.name });
  }, []);

  const restoreVerifiedProject = useCallback((record: ProjectRecord, verified: Awaited<ReturnType<typeof openVerifiedFileHandle>>) => {
    if (!record.fileHandle || !verified) return false;
    const { file, metadata, fingerprint } = verified;
    setLargeSource({ file, metadata, fingerprint, fileHandle: record.fileHandle });
    setSource({ channels: [], sampleRate: metadata.sampleRate, duration: metadata.frameCount / metadata.sampleRate, name: file.name });
    setModules(withoutLegacyDcModules(record.modules));
    setMarkers(record.markers);
    setRegions(record.regions);
    setTitle(record.title);
    setNotes(record.notes);
    setProjectId(record.id);
    setPendingPermission(null);
    setPendingRelink(null);
    setSelection([0, Math.min(5, metadata.frameCount / metadata.sampleRate)]);
    setSavedStatus(`Restored file-backed project · ${new Date(record.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    return true;
  }, []);

  useEffect(() => {
    const saved = loadProject();
    if (saved?.originalBase64?.length && saved.originalLength) {
      const channels = decodeChannels(saved.originalBase64, saved.originalLength);
      const next: AudioSource = { channels, sampleRate: saved.sampleRate, duration: channels[0].length / saved.sampleRate, name: saved.sourceName };
      setSource(next); setTitle(saved.title); setNotes(saved.notes); setModules(withoutLegacyDcModules(saved.modules)); setMarkers(saved.markers); setRegions(saved.regions);
      setSavedStatus(`Restored ${new Date(saved.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    } else if (saved?.original?.length) {
      const channels = saved.original.map((channel) => new Float32Array(channel));
      const next: AudioSource = { channels, sampleRate: saved.sampleRate, duration: channels[0].length / saved.sampleRate, name: saved.sourceName };
      setSource(next); setTitle(saved.title); setNotes(saved.notes); setModules(withoutLegacyDcModules(saved.modules)); setMarkers(saved.markers); setRegions(saved.regions);
      setSavedStatus(`Restored ${new Date(saved.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    }
    void listProjects().then(async (projects) => {
      const latest = projects[0];
      if (!latest) return;
      const record = await loadProjectV2(latest.id);
      if (!record) return;
       stageSavedProject(record);
       if (!record.fileHandle) {
         setPendingRelink(record);
         setSavedStatus('Saved project loaded · relink source WAV');
         return;
       }
       let permission: PermissionState;
       try {
         permission = await queryFileHandlePermission(record.fileHandle);
       } catch {
         setPendingRelink(record);
         setSavedStatus('Saved project loaded · relink source WAV');
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
       setSavedStatus('Saved project loaded · relink source WAV');
    }).catch(() => {
      // Legacy localStorage restoration remains available when IndexedDB is unavailable.
    });
  }, [restoreVerifiedProject, stageSavedProject]);

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
      setSpectrogramStatus('Building visible spectrogram');
      setSpectrogramProgress(0);
      setOperationPaused(false);
      const leftJob = startWorkerJob<SpectrogramData>(
        { kind: 'spectrogram', file, metadata, modules: processingModules, options: { ...options, channelIndex: 0 } },
        (fraction) => { if (generation === spectrogramGenerationRef.current) setSpectrogramProgress(fraction / 2); },
      );
      const rightJob = startWorkerJob<SpectrogramData>(
        { kind: 'spectrogram', file, metadata, modules: processingModules, options: { ...options, channelIndex: Math.min(1, metadata.channels - 1) } },
        (fraction) => { if (generation === spectrogramGenerationRef.current) setSpectrogramProgress(0.5 + fraction / 2); },
      );
      jobs = [leftJob, rightJob];
      spectrogramJobRef.current = jobs;
      Promise.all([leftJob.promise, rightJob.promise]).then(([left, right]) => {
        if (generation === spectrogramGenerationRef.current) {
          setLargeSpectrograms({
            left,
            right,
            startSeconds: options.startSeconds,
            durationSeconds: options.durationSeconds,
          });
          setSpectrogramResultId(generation);
          setSpectrogramStatus('');
          setSpectrogramProgress(1);
          spectrogramJobRef.current = [];
        }
      }).catch((caught) => {
        if ((caught as Error).name !== 'AbortError') setError(caught instanceof Error ? caught.message : 'Unable to build the visible spectrogram.');
      });
    }, 100);
    return () => {
      window.clearTimeout(timer);
      if (jobs.length) {
        spectrogramGenerationRef.current += 1;
        jobs.forEach((job) => job.cancel());
      }
    };
  }, [largeSource, processingModules, viewDuration, viewStart]);

  useEffect(() => {
    if (!largeSource) return;
    analysisJobRef.current?.cancel();
    const generation = ++analysisGenerationRef.current;
    setAnalysisRequestId(generation);
    const { file, metadata } = largeSource;
    const selectionStartFrame = Math.max(0, Math.floor(selectionStart * metadata.sampleRate));
    const selectionFrames = Math.max(1, Math.min(metadata.frameCount - selectionStartFrame, Math.ceil((selectionEnd - selectionStart) * metadata.sampleRate)));
    const selectionWarmStart = Math.max(0, selectionStartFrame - Math.floor(metadata.sampleRate * 2));
    const selectionMetadata: WavMetadata = {
      ...metadata,
      dataOffset: metadata.dataOffset + selectionStartFrame * metadata.frameSize,
      frameCount: selectionFrames,
      dataLength: selectionFrames * metadata.frameSize,
      dataLengthBigInt: BigInt(selectionFrames * metadata.frameSize),
    };
    setAnalysisStatus('Analyzing selection');
    setAnalysisProgress(0);
    setOperationPaused(false);
    const run = (request: Parameters<typeof startWorkerJob<LargeAnalysisResult>>[0]) => {
      const job = startWorkerJob<LargeAnalysisResult>(
        request,
        (fraction) => { if (generation === analysisGenerationRef.current) setAnalysisProgress(fraction); },
      );
      analysisJobRef.current = job;
      if (backgroundPausedRef.current) job.pause();
      return job.promise;
    };
    void run({ kind: 'loudness', file, metadata: selectionMetadata, frameOffset: selectionStartFrame }).then((stats) => {
      if (generation !== analysisGenerationRef.current) throw new DOMException('Stale analysis.', 'AbortError');
      setLargeSelectionOriginalStats(stats);
      setAnalysisStatus('Analyzing processed selection');
      return run({
        kind: 'loudness',
        file,
        metadata: selectionMetadata,
        modules: processingModules,
        frameOffset: selectionStartFrame,
        sourceFrameCount: metadata.frameCount,
        warmup: selectionWarmStart < selectionStartFrame
          ? { metadata, startFrame: selectionWarmStart, frameCount: selectionStartFrame - selectionWarmStart }
          : undefined,
      });
    }).then((stats) => {
      if (generation !== analysisGenerationRef.current) throw new DOMException('Stale analysis.', 'AbortError');
      setLargeSelectionCurrentStats(stats);
      setAnalysisStatus('Analyzing original recording');
      return run({ kind: 'loudness', file, metadata });
    }).then((stats) => {
      if (generation !== analysisGenerationRef.current) throw new DOMException('Stale analysis.', 'AbortError');
      setLargeOriginalStats(stats);
      setAnalysisStatus('Analyzing processed recording');
      return run({ kind: 'loudness', file, metadata, modules: processingModules });
    }).then((stats) => {
      if (generation === analysisGenerationRef.current) {
        setLargeCurrentStats(stats);
        setAnalysisResultId(generation);
        setAnalysisStatus('');
        setAnalysisProgress(1);
        analysisJobRef.current = null;
      }
    }).catch((caught) => {
      if ((caught as Error).name !== 'AbortError') setError(caught instanceof Error ? caught.message : 'Unable to analyze this recording.');
    });
    return () => {
      if (generation === analysisGenerationRef.current) analysisGenerationRef.current += 1;
      analysisJobRef.current?.cancel();
    };
  }, [largeSource, processingModules, selectionEnd, selectionStart]);

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
  }, []);

  const startPlayback = useCallback((channels: Float32Array[], startPosition: number) => {
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
    });
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
        audioSourceRef.current = null;
      }
    };
    node.start(0, plan.bufferStartOffset);
    audioSourceRef.current = node; setIsPlaying(true);
    const tick = () => {
      if (audioSourceRef.current !== node) return;
      const elapsed = (context.currentTime - startedAt) * rate;
      const next = Math.min(plan.timelineEnd, plan.timelineStart + elapsed);
      const position = loop ? plan.timelineStart + (elapsed % Math.max(.01, plan.timelineEnd - plan.timelineStart)) : next;
      playHeadRef.current = position;
      setPlayHead(position);
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  }, [duration, loop, rate, source.sampleRate]);

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
    const plan = createPlaybackRangePlan({ duration, loop, sampleRate: metadata.sampleRate, selection: selectionRef.current, startPosition, totalFrames: metadata.frameCount });
    const rangeStart = plan.bufferStartFrame;
    const rangeEnd = plan.bufferEndFrame;
    let nextFrame = plan.timelineStartFrame;
    const loopStartFrame = nextFrame;
    let scheduledAt = context.currentTime + 0.08;
    const startedAt = scheduledAt;
    const playbackStart = nextFrame / metadata.sampleRate;
    const chunkFrames = Math.max(4096, Math.floor(metadata.sampleRate * 4));
    const warmStart = monitor === 'current' ? Math.max(0, nextFrame - Math.floor(metadata.sampleRate * 2)) : nextFrame;
    const processor = createStreamingEditChain(processingModules, metadata.sampleRate, metadata.frameCount, warmStart);
    if (monitor === 'current' && warmStart < nextFrame) {
      const warmup = await readFrames(file, metadata, warmStart, nextFrame - warmStart);
      processor.process(warmup, warmStart);
    }
    const loopState = processor.snapshot();
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
          }
          const count = Math.min(chunkFrames, rangeEnd - nextFrame);
          const readStart = nextFrame;
          let channels = await readFrames(file, metadata, readStart, count, { signal: undefined });
          if (playbackSessionRef.current !== session) return;
          if (monitor === 'current') channels = processor.process(channels, readStart);
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
      const span = Math.max(0.01, plan.timelineEnd - (plan.hasSelection ? plan.timelineStart : playbackStart));
      const position = loop
        ? (plan.hasSelection ? plan.timelineStart : playbackStart) + (elapsed % span)
        : Math.min(plan.timelineEnd, playbackStart + elapsed);
      playHeadRef.current = position;
      setPlayHead(position);
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  }, [duration, largeSource, loop, monitor, processingModules, rate, stopPlayback]);

  useEffect(() => {
    playHeadRef.current = playHead;
  }, [playHead]);

  useEffect(() => {
    selectionRef.current = [selectionStart, selectionEnd];
  }, [selectionEnd, selectionStart]);

  const play = useCallback(() => {
    if (isPlaying) { stopPlayback(); return; }
    if (largeSource) { void startLargePlayback(playHeadRef.current); return; }
    const channels = monitor === 'original' ? source.channels : currentChannels;
    startPlayback(channels, playHeadRef.current);
  }, [currentChannels, isPlaying, largeSource, monitor, source.channels, startLargePlayback, startPlayback, stopPlayback]);

  const seekTo = useCallback((time: number) => {
    const position = Math.max(0, Math.min(duration, time));
    playHeadRef.current = position;
    setPlayHead(position);
    if (isPlaying) {
      if (largeSource) { void startLargePlayback(position); return; }
      const channels = monitor === 'original' ? source.channels : currentChannels;
      startPlayback(channels, position);
    }
  }, [currentChannels, duration, isPlaying, largeSource, monitor, source.channels, startLargePlayback, startPlayback]);

  useEffect(() => {
    if (!isPlaying) return;
    if (largeSource) { void startLargePlayback(playHeadRef.current); return; }
    const channels = monitor === 'original' ? source.channels : currentChannels;
    startPlayback(channels, playHeadRef.current);
  }, [currentChannels, largeSource, loop, monitor, rate]);

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

  const importWavFile = useCallback(async (file: File, fileHandle?: FileSystemFileHandle) => {
    if (!file.name.toLowerCase().endsWith('.wav') && !['audio/wav', 'audio/x-wav', 'audio/wave'].includes(file.type)) {
      setError('Drop an uncompressed WAV file to begin editing.');
      return;
    }
    try {
      setError('');
      setOperationStatus('Reading WAV metadata');
      const metadata = await parseWavMetadata(file, { name: file.name });
      const fingerprint = await fingerprintWav(file, metadata);
      const useFileBackedPath = file.size >= 64 * 1024 * 1024 || metadata.format === 'RF64';
      stopPlayback();
      if (useFileBackedPath) {
        const next: AudioSource = { channels: [], sampleRate: metadata.sampleRate, duration: metadata.frameCount / metadata.sampleRate, name: file.name };
        setLargeSource({ file, metadata, fingerprint, fileHandle });
        setSource(next);
        setLargeOriginalStats(EMPTY_STATS);
        setLargeCurrentStats(EMPTY_STATS);
        setLargeSelectionOriginalStats(EMPTY_STATS);
        setLargeSelectionCurrentStats(EMPTY_STATS);
        setSavedStatus(`File-backed ${metadata.format} · not saved`);
      } else {
        const parsed = parseWav(await file.arrayBuffer(), file.name);
        setLargeSource(null);
        setSource(parsed);
        setSavedStatus('Imported · not saved');
      }
       const savedProject = pendingRelink ?? pendingPermission;
       const relinkMatches = savedProject
         && isVerifiedRelink(savedProject.source.fingerprint, fingerprint);
      if (relinkMatches) {
        setModules(withoutLegacyDcModules(savedProject.modules));
        setMarkers(savedProject.markers);
        setRegions(savedProject.regions);
        setTitle(savedProject.title);
        setNotes(savedProject.notes);
        setProjectId(savedProject.id);
        setPendingPermission(null);
        setPendingRelink(null);
        setSavedStatus('Source relinked · project restored');
      } else {
        setModules(makeDefaultChain()); setMarkers([]); setRegions([]); setTitle(file.name.replace(/\.wav$/i, '')); setProjectId(null);
      }
      setSelection([0, Math.min(metadata.frameCount / metadata.sampleRate, 5)]); setOperationStatus('');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to read this WAV file.'); }
  }, [pendingPermission, pendingRelink, stopPlayback]);

  const pickWavFile = useCallback(async () => {
    const picker = (window as typeof window & {
      showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>;
    }).showOpenFilePicker;
    if (!picker) { fileRef.current?.click(); return; }
    try {
      const [handle] = await picker({ multiple: false, types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }] });
      if (handle) void importWavFile(await handle.getFile(), handle);
    } catch (caught) {
      if ((caught as Error).name !== 'AbortError') setError(caught instanceof Error ? caught.message : 'Unable to open this WAV file.');
    }
  }, [importWavFile]);

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
        setSavedStatus('File access denied · relink source WAV');
        return;
      }
      const verified = await openVerifiedFileHandle(record.fileHandle, record.source.fingerprint ?? '');
      if (!restoreVerifiedProject(record, verified)) {
        setPendingPermission(null);
        setPendingRelink(record);
        setSavedStatus('Saved source changed · relink source WAV');
        setError('The saved file no longer matches this project. Relink the original WAV to restore its edits.');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to renew access to the saved WAV file.');
    } finally {
      setIsRenewingPermission(false);
    }
  }, [pendingPermission, restoreVerifiedProject]);

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

  const save = async () => {
    if (largeSource) {
      try {
        const record = await saveProjectV2({
          id: projectId ?? undefined,
          title,
          notes,
          modules,
          markers,
          regions,
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
        setSavedStatus(`Saved locally · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${largeSource.fileHandle ? '' : ' · relink required after restart'}`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to save this project.');
      }
      return;
    }
    const project = projectFromSource(source, modules, markers, regions, title, notes);
    const ok = saveProject(project);
    setSavedStatus(ok ? `Saved locally · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Storage full · export a project report');
  };

  const exportAudio = async () => {
    const safeName = (title || source.name).replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').toLowerCase();
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
        const handle = await picker({ suggestedName: `${safeName || 'field-restore'}-rx.wav`, types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }] });
        await withLargeExportLeaveWarning(async () => {
          const writable = await handle.createWritable();
          const { file, metadata } = largeSource;
          const processor = createStreamingEditChain(processingModules, metadata.sampleRate, metadata.frameCount, 0);
          setOperationStatus('Exporting file-backed WAV');
          await writeFloat32WavChunks(writable, {
            channels: metadata.channels,
            sampleRate: metadata.sampleRate,
            frameCount: metadata.frameCount,
            signal: controller.signal,
            readFrames: (start, count, signal) => readFrames(file, metadata, start, count, { signal }),
            processFrames: (channels, start) => processor.process(channels, start),
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
      downloadBlob(encodeWav(currentSource), `${safeName || 'field-restore'}-rx.wav`);
    }
    const report = makeRestorationReport({
      source: source.name,
      sampleRate: source.sampleRate,
      channels: sourceChannelCount,
      duration,
      container: largeSource && largeSource.metadata.frameCount * sourceChannelCount * 4 + 36 > 0xffffffff ? 'RF64' : 'RIFF',
      modules,
      selection: [selectionStart, selectionEnd],
    });
    downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), `${safeName || 'field-restore'}-restoration-report.json`);
    setOperationStatus(''); setModal(null); setSavedStatus('WAV + report exported');
  };

  const canvasPointToTime = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return 0;
    const bounds = canvas.getBoundingClientRect();
    const plotWidth = Math.max(1, bounds.width - SPECTROGRAM_LEFT - SPECTROGRAM_RIGHT);
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left - SPECTROGRAM_LEFT) / plotWidth));
    return Math.max(0, Math.min(duration, viewStart + x * viewDuration));
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
      frequencyDragRef.current = { startY: event.clientY, startMaximum: spectrogramMaxFrequency };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (localX >= bounds.width - SPECTROGRAM_RIGHT) {
      if (localY < graphBottom) {
        const paneHeight = graphBottom / 2;
        const paneTop = localY >= paneHeight ? paneHeight : 0;
        const paneY = Math.max(0, Math.min(paneHeight, localY - paneTop));
        levelDragRef.current = {
          grabbedLevel: spectrogramCeilingDb - (paneY / paneHeight) * spectrogramLevelSpanDb,
          paneTop,
          paneHeight,
          span: spectrogramLevelSpanDb,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    const time = canvasPointToTime(event);
    pointerDragRef.current = { start: time, current: time, startClientX: event.clientX, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    seekTo(time);
  };
  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
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
      const deltaFrequency = (event.clientY - frequencyDragRef.current.startY) * 75;
      const nextFrequency = Math.round((frequencyDragRef.current.startMaximum + deltaFrequency) / 100) * 100;
      setSpectrogramMaxFrequency(Math.max(spectrogramMinFrequency + 500, Math.min(nyquist, nextFrequency)));
      return;
    }
    if (levelDragRef.current) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const paneY = event.clientY - bounds.top - levelDragRef.current.paneTop;
      setSpectrogramCeilingDb(anchoredLevelScaleCeiling(
        levelDragRef.current.grabbedLevel,
        paneY,
        levelDragRef.current.paneHeight,
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
    if (loop || selectionStartTime !== start) seekTo(selectionStartTime);
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
      const paneHeight = graphBottom / 2;
      const paneY = ((Math.max(0, Math.min(graphBottom, y)) % paneHeight) + paneHeight) % paneHeight;
      const pointerRatio = Math.max(0, Math.min(1, 1 - paneY / paneHeight));
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
    const canvas = canvasRef.current; if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const ratio = window.devicePixelRatio || 1; const width = canvas.clientWidth; const height = canvas.clientHeight;
    canvas.width = width * ratio; canvas.height = height * ratio; context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const graphBottom = height - SPECTROGRAM_BOTTOM;
    const graphLeft = SPECTROGRAM_LEFT;
    const graphRight = width - SPECTROGRAM_RIGHT;
    const graphWidth = Math.max(1, graphRight - graphLeft);
    const paneHeight = graphBottom / 2;
    context.fillStyle = '#17242c'; context.fillRect(0, 0, width, height);

    const drawSpectrogramPane = (spectrogram: typeof spectrograms.left, top: number) => {
      const imageCanvas = document.createElement('canvas');
      imageCanvas.width = spectrogram.width;
      imageCanvas.height = SPECTROGRAM_DISPLAY_HEIGHT;
      const imageContext = imageCanvas.getContext('2d');
      if (imageContext) {
        const image = imageContext.createImageData(spectrogram.width, SPECTROGRAM_DISPLAY_HEIGHT);
        const nyquist = source.sampleRate / 2;
        for (let row = 0; row < SPECTROGRAM_DISPLAY_HEIGHT; row += 1) {
          const frequency = spectrogramMaxFrequency - (row / Math.max(1, SPECTROGRAM_DISPLAY_HEIGHT - 1)) * (spectrogramMaxFrequency - spectrogramMinFrequency);
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
      for (let tick = 0; tick <= SPECTROGRAM_SCALE_DIVISIONS; tick += 1) {
        const frequency = spectrogramMinFrequency + (tick / SPECTROGRAM_SCALE_DIVISIONS) * (spectrogramMaxFrequency - spectrogramMinFrequency);
        const y = top + paneHeight - ((frequency - spectrogramMinFrequency) / (spectrogramMaxFrequency - spectrogramMinFrequency)) * paneHeight;
        context.beginPath(); context.moveTo(graphLeft, y); context.lineTo(graphRight, y); context.stroke();
      }
    }
    context.strokeStyle = 'rgba(242, 244, 232, .55)'; context.lineWidth = 1;
    context.beginPath(); context.moveTo(graphLeft, paneHeight); context.lineTo(graphRight, paneHeight); context.stroke();

    const selectedLeft = graphLeft + ((selectionStart - viewStart) / viewDuration) * graphWidth;
    const selectedRight = graphLeft + ((selectionEnd - viewStart) / viewDuration) * graphWidth;
    context.fillStyle = 'rgba(214, 237, 85, .13)'; context.fillRect(selectedLeft, 0, Math.max(2, selectedRight - selectedLeft), graphBottom);
    context.strokeStyle = 'rgba(216, 237, 85, .5)'; context.strokeRect(selectedLeft, 0, Math.max(2, selectedRight - selectedLeft), graphBottom);
    const headX = graphLeft + ((playHead - viewStart) / viewDuration) * graphWidth; context.strokeStyle = '#ff8a4c'; context.lineWidth = 2; context.beginPath(); context.moveTo(headX, 0); context.lineTo(headX, graphBottom); context.stroke();

    context.fillStyle = '#f2f4e8'; context.font = '10px "Space Mono", monospace'; context.textAlign = 'left';
    for (let tick = 0; tick <= 6; tick += 1) { const time = viewStart + (tick / 6) * viewDuration; context.fillText(formatTime(time), graphLeft + (tick / 6) * graphWidth + 4, height - 8); }
    context.textAlign = 'right';
    for (const top of [0, paneHeight]) {
      for (let tick = 0; tick <= SPECTROGRAM_SCALE_DIVISIONS; tick += 1) {
        const frequency = spectrogramMinFrequency + (tick / SPECTROGRAM_SCALE_DIVISIONS) * (spectrogramMaxFrequency - spectrogramMinFrequency);
        const y = top + paneHeight - ((frequency - spectrogramMinFrequency) / (spectrogramMaxFrequency - spectrogramMinFrequency)) * paneHeight;
        const label = frequency === 0 ? '0' : `${Number((frequency / 1000).toFixed(1))}k`;
        context.fillText(label, graphLeft - 6, Math.max(top + 10, Math.min(top + paneHeight - 3, y + 3)));
      }
    }
    context.textAlign = 'left';
    for (const top of [0, paneHeight]) {
      const gradient = context.createLinearGradient(0, top + 3, 0, top + paneHeight - 3);
      gradient.addColorStop(0, spectrogramColorCss(1, spectrogramPalette));
      gradient.addColorStop(0.5, spectrogramColorCss(0.5, spectrogramPalette));
      gradient.addColorStop(1, spectrogramColorCss(0, spectrogramPalette));
      context.fillStyle = gradient;
      context.fillRect(graphRight + 6, top + 3, 9, paneHeight - 6);
      context.strokeStyle = 'rgba(242, 244, 232, .35)';
      context.strokeRect(graphRight + 6, top + 3, 9, paneHeight - 6);
      context.fillStyle = '#f2f4e8';
      for (let tick = 0; tick <= SPECTROGRAM_SCALE_DIVISIONS; tick += 1) {
        const decibels = spectrogramCeilingDb - (tick / SPECTROGRAM_SCALE_DIVISIONS) * (spectrogramCeilingDb - spectrogramFloorDb);
        const y = top + (tick / SPECTROGRAM_SCALE_DIVISIONS) * paneHeight;
        const levelLabel = Math.round(decibels);
        context.fillText(levelLabel > 0 ? `+${levelLabel}` : `${levelLabel}`, graphRight + 19, Math.max(top + 10, Math.min(top + paneHeight - 3, y + 3)));
      }
    }
    context.textAlign = 'left';
    context.fillStyle = '#d8ed55';
    context.fillText(sourceChannelCount > 1 ? 'L' : 'MONO', graphLeft + 6, 14);
    context.fillText(sourceChannelCount > 1 ? 'R' : 'MONO', graphLeft + 6, paneHeight + 14);
    context.save();
    context.translate(11, graphBottom / 2);
    context.rotate(-Math.PI / 2);
    context.fillStyle = '#91a69d';
    context.textAlign = 'center';
    context.fillText('FREQUENCY (Hz)', 0, 0);
    context.restore();
    context.save();
    context.translate(width - 7, graphBottom / 2);
    context.rotate(Math.PI / 2);
    context.fillStyle = '#91a69d';
    context.textAlign = 'center';
    context.fillText('LEVEL (dB)', 0, 0);
    context.restore();
  }, [activeTab, playHead, selectionEnd, selectionStart, sourceChannelCount, spectrogramCeilingDb, spectrogramFloorDb, spectrogramMaxFrequency, spectrogramMinFrequency, spectrogramPalette, spectrograms, viewDuration, viewStart]);

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.code === 'Space') { event.preventDefault(); play(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      if (event.key === 'Escape') { setModal(null); setModuleMenu(false); }
    };
    window.addEventListener('keydown', keyHandler); return () => window.removeEventListener('keydown', keyHandler);
  }, [play, redo, undo]);

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
          <button type="button" className="nav-item" onClick={() => void pickWavFile()} data-testid="nav-import"><FileAudio size={15} /><span className="nav-label">Import WAV</span></button>
          <button type="button" className="nav-item" onClick={() => { stopPlayback(); setLargeSource(null); setSource(createDemoAudio()); setModules(makeDefaultChain()); setSelection([4.1, 7.8]); setMarkers([]); setRegions([]); setTitle('Coastal dawn / north bluff'); setSavedStatus('Demo source loaded'); }} data-testid="nav-demo"><Waves size={15} /><span className="nav-label">Load demo source</span></button>
          <button type="button" className="nav-item" onClick={save} data-testid="nav-save"><Save size={15} /><span className="nav-label">Save locally</span></button>
          <button type="button" className="nav-item" onClick={() => setModal('export')} data-testid="nav-export"><Download size={15} /><span className="nav-label">Export</span></button>
        </div>
        <div className="mt-auto px-4 pb-5 sidebar-meta">
          <div className="border-t border-[#34454b] pt-4">
            <div className="flex items-center gap-2 text-[11px] text-[#b7c8bb]"><span className="w-2 h-2 rounded-full bg-[#d8ed55]" /> Offline / local only</div>
            <div className="font-mono-value text-[10px] text-[#829890] mt-2">{source.sampleRate / 1000} kHz · {sourceChannelCount} ch</div>
          </div>
        </div>
      </aside>
      <section className="main-shell">
        <header className="topbar">
          <div className="flex items-center gap-3 min-w-0">
            <button type="button" className="icon-btn md:hidden" aria-label="Open navigation" data-testid="button-menu"><Menu size={16} /></button>
            <div className="min-w-0"><div className="eyebrow">Current recording</div><div className="font-semibold text-[14px] mt-1 truncate max-w-[340px]" data-testid="text-source-name">{source.name}</div></div>
            <span className="chip hidden sm:inline-flex"><span className="w-1.5 h-1.5 bg-[#d8ed55] rounded-full" />{savedStatus}</span>
             <span className="dc-status hidden lg:inline-flex" data-testid="status-dc-removal"><Check size={12} />DC offset removed automatically</span>
          </div>
          {(analysisStatus || spectrogramStatus || operationStatus) && (() => {
            const backgroundStatus = analysisStatus || spectrogramStatus;
            const visibleStatus = backgroundStatus || operationStatus;
            const visibleProgress = analysisStatus ? analysisProgress : spectrogramStatus ? spectrogramProgress : operationProgress;
            return <div className="topbar-work-status" role="status" data-testid="status-background-work" data-progress={visibleProgress}><span className="truncate">{operationPaused && backgroundStatus ? `${visibleStatus} · paused` : visibleStatus}</span><div className="h-1.5 flex-1 bg-[hsl(var(--muted))] rounded overflow-hidden"><div className="h-full bg-[hsl(var(--primary))]" style={{ width: `${Math.max(4, visibleProgress * 100)}%` }} /></div><span className="font-mono-value">{Math.round(visibleProgress * 100)}%</span>{backgroundStatus && <><button type="button" className="quiet-btn !py-1" onClick={operationPaused ? resumeBackgroundWork : pauseBackgroundWork} data-testid="button-analysis-pause">{operationPaused ? <Play size={12} /> : <Pause size={12} />}{operationPaused ? 'Resume' : 'Pause'}</button><button type="button" className="icon-btn !h-7 !min-w-7" onClick={cancelBackgroundWork} aria-label="Cancel background analysis" data-testid="button-analysis-cancel"><X size={13} /></button></>}</div>;
          })()}
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
          <div className="workspace-grid">
            <div className="min-w-0 space-y-4">
              {activeTab === 'project' ? (
                <ProjectPanel title={title} notes={notes} setTitle={setTitle} setNotes={setNotes} source={source} sourceChannelCount={sourceChannelCount} save={() => void save()} setModal={setModal} />
              ) : activeTab === 'analyze' ? (
                <AnalyzePanel originalStats={originalStats} currentStats={currentStats} selectionOriginalStats={selectionOriginalStats} selectionCurrentStats={selectionCurrentStats} duration={duration} selection={[selectionStart, selectionEnd]} modules={modules} />
              ) : (
                <>
                  <section className="panel instrument-grid" aria-label="Spectrogram editor">
                    <div className="panel-header spectrogram-panel-header">
                      <div className="flex items-center gap-3"><Waves size={17} color="hsl(var(--primary))" /><div><div className="section-title">Spectrogram / selection</div><div className="text-[10px] text-muted-foreground mt-0.5">Drag to select · scroll/drag the bottom time axis · scroll/drag the left frequency axis · scroll/drag the right dB axis</div></div></div>
                      <div className="spectrogram-header-actions">
                        <div className="spectrogram-tabs flex bg-[hsl(var(--muted))] rounded-md p-0.5" role="tablist" aria-label="Workspace view">
                          {(['edit', 'analyze', 'project'] as ViewTab[]).map((tab) => <button key={tab} type="button" className={`tab rounded ${activeTab === tab ? 'active bg-[hsl(var(--card))]' : ''}`} onClick={() => setActiveTab(tab)} role="tab" aria-selected={activeTab === tab} data-testid={`tab-${tab}`}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}
                        </div>
                        <div className="flex items-center gap-1"><button type="button" className="icon-btn" onClick={() => { setTimeViewCenter(viewStart + viewDuration / 2); setZoom(Math.max(1, zoom / 1.8)); }} aria-label="Zoom out" data-testid="button-zoom-out"><ZoomOut size={15} /></button><span className="font-mono-value text-[10px] text-muted-foreground w-12 text-center">{zoom.toFixed(1)}×</span><button type="button" className="icon-btn" onClick={() => { setTimeViewCenter(viewStart + viewDuration / 2); setZoom(Math.min(16, zoom * 1.8)); }} aria-label="Zoom in" data-testid="button-zoom-in"><ZoomIn size={15} /></button><button type="button" className="quiet-btn ml-2 !py-[5px]" onClick={() => { setZoom(1); setTimeViewCenter(null); }} data-testid="button-fit">Fit</button></div>
                      </div>
                    </div>
                    <div className="panel-body !pt-3">
                      <div className="waveform-wrap">
                        <canvas ref={canvasRef} className="waveform-canvas" onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerUp={onCanvasPointerUp} onPointerCancel={onCanvasPointerUp} aria-label={`Interactive spectrogram from ${spectrogramMinFrequency / 1000} to ${spectrogramMaxFrequency / 1000} kilohertz with ${spectrogramFloorDb} to ${spectrogramCeilingDb} decibel scale`} data-testid="canvas-spectrogram" data-request-id={spectrogramRequestId} data-result-id={spectrogramResultId} />
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: spectrogramColorCss(0.08, spectrogramPalette) }} /> low energy <span className="inline-block w-3 h-3 rounded-sm ml-2" style={{ background: spectrogramColorCss(0.92, spectrogramPalette) }} /> high energy <span className="inline-block w-3 h-3 rounded-sm bg-[#ff8a4c] ml-2" /> playhead</div>
                        <div className="font-mono-value text-[11px]" data-testid="text-selection-time">{formatTime(selectionStart, true)} — {formatTime(selectionEnd, true)} <span className="text-muted-foreground">({(selectionEnd - selectionStart).toFixed(3)} s selected)</span></div>
                      </div>
                    </div>
                  </section>
                   <section className="panel signal-stats-bar" data-testid="panel-signal-statistics" data-request-id={analysisRequestId} data-result-id={analysisResultId}>
                     <div className="signal-stats-heading">
                       <div className="flex items-center gap-2"><Gauge size={15} color="hsl(var(--primary))" /><div className="section-title">Signal statistics</div></div>
                       <span className="chip">estimate</span>
                     </div>
                     <div className="signal-stats-groups">
                       <div className="signal-stats-group">
                         <div className="signal-stats-label">Current / full file</div>
                         <StatsGrid stats={currentStats} />
                       </div>
                       <div className="signal-stats-group">
                         <div className="signal-stats-label">Selection · {formatTime(selectionEnd - selectionStart)}</div>
                         <StatsGrid stats={selectionCurrentStats} />
                       </div>
                     </div>
                     <div className="signal-stats-note"><Info size={12} />Local BS.1770-style estimates with 4× true-peak interpolation; not certified meter readings.</div>
                   </section>
                  <section className="transport" aria-label="Audio transport">
                    <button type="button" className="icon-btn !bg-[#d8ed55] !text-[#18231f] !rounded-full" onClick={play} aria-label={isPlaying ? 'Pause playback' : 'Play playback'} data-testid="button-play">{isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
                    <button type="button" className="icon-btn" onClick={() => { stopPlayback(); setPlayHead(0); }} aria-label="Stop and return to start" data-testid="button-stop"><Square size={14} fill="currentColor" /></button>
                    <div className="time-readout" data-testid="text-playhead">{formatTime(playHead)} <span className="font-sans text-[10px] opacity-55">/ {formatTime(duration)}</span></div>
                    <div className="h-5 w-px bg-white/15 mx-1" />
                    <button type="button" className={`icon-btn !text-[11px] !font-bold ${loop ? '!bg-white/10 !text-[#d8ed55]' : ''}`} onClick={() => setLoop(!loop)} aria-pressed={loop} data-testid="button-loop">LOOP</button>
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2"><span className="text-[10px] opacity-60">PRESET</span><select className="transport-select border border-white/15 rounded px-2 py-1 text-[11px] max-w-[210px]" value="" onChange={(event) => { if (event.target.value === 'common-field') { commitModules(makeDefaultChain()); setSavedStatus('Common Field Recording Adjustments preset loaded'); } }} aria-label="Load local preset" data-testid="select-local-preset"><option value="" disabled>Load preset…</option><option value="common-field">Common Field Recording Adjustments</option></select><span className="h-5 w-px bg-white/15 mx-1" /><span className="text-[10px] opacity-60">MONITOR</span><select className="transport-select border border-white/15 rounded px-2 py-1 text-[11px]" value={monitor} onChange={(event) => setMonitor(event.target.value as MonitorMode)} aria-label="Monitor source" data-testid="select-monitor"><option value="current">Current</option><option value="original">Original A/B</option></select><select className="transport-select border border-white/15 rounded px-2 py-1 text-[11px]" value={rate} onChange={(event) => setRate(Number(event.target.value))} aria-label="Playback rate" data-testid="select-playback-rate"><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option></select></div>
                  </section>
                  <section className="panel">
                    <div className="panel-header"><div className="flex items-center gap-2"><Layers3 size={16} color="hsl(var(--accent))" /><div><div className="section-title">Non-destructive edit chain</div><div className="text-[10px] text-muted-foreground mt-0.5">{modules.filter((module) => module.enabled).length} enabled · automatic DC correction applied first · original stays untouched</div></div></div><div className="relative"><button type="button" className="primary-btn" onClick={() => setModuleMenu(!moduleMenu)} data-testid="button-add-module"><Plus size={14} /> Add module <ChevronDown size={13} /></button>{moduleMenu && <div className="absolute right-0 top-10 z-20 w-52 p-1 bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-md shadow-lg">{MODULE_TYPES.map((type) => <button type="button" key={type} className="w-full text-left px-3 py-2 rounded text-[12px] hover:bg-[hsl(var(--muted))]" onClick={() => addModule(type)} data-testid={`menu-module-${type}`}>{MODULE_LABELS[type]}<span className="block text-[10px] text-muted-foreground">{type === 'hum' ? 'conservative notch estimate' : type === 'ambient' ? 'blend local texture' : 'sample-domain pass'}</span></button>)}</div>}</div></div>
                    <div className="panel-body">
                      {modules.length === 0 ? <div className="empty-state border border-dashed rounded-md"><Layers3 size={20} className="mx-auto mb-2 opacity-45" /><div className="text-[12px] font-semibold text-foreground">No edits in the chain</div><div className="text-[11px] mt-1">Add a conservative module. Every change stays reversible.</div></div> : modules.map((module, index) => <ModuleCard key={module.id} module={module} index={index} total={modules.length} collapsed={!showAllModules} updateModule={updateModule} updateParams={updateParams} deleteModule={deleteModule} duplicateModule={duplicateModule} moveModule={moveModule} />)}
                      <div className="flex items-center justify-between pt-2"><button type="button" className="quiet-btn" onClick={() => setShowAllModules(!showAllModules)} data-testid="button-chain-toggle">{showAllModules ? 'Collapse details' : 'Expand details'}</button><div className="font-mono-value text-[10px] text-muted-foreground">processing is local / reversible</div></div>
                    </div>
                  </section>
                </>
              )}
            </div>
          </div>
        </main>
      </section>
      <input ref={fileRef} type="file" accept=".wav,audio/wav" onChange={importFile} className="hidden" data-testid="input-import-wav" />
      {modal === 'export' && <ExportModal onClose={() => setModal(null)} onExport={exportAudio} title={title} />}
      {modal === 'help' && <HelpModal onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} spectrogramPalette={spectrogramPalette} onSpectrogramPaletteChange={(palette) => { setSpectrogramPalette(palette); localStorage.setItem('field-restore-spectrogram-palette', palette); }} />}
    </div>
  );
}

function StatsGrid({ stats }: { stats: LoudnessStats }) {
  return <div className="stat-grid"><div className="stat-cell"><div className="stat-value">{formatLevel(stats.truePeakDbtp, 'dBTP')}</div><div className="stat-label">True peak estimate</div></div><div className="stat-cell"><div className="stat-value">{formatLevel(stats.integratedLufs, 'LUFS')}</div><div className="stat-label">Integrated loudness</div></div><div className="stat-cell"><div className="stat-value">{formatLevel(stats.loudnessRangeLu, 'LU')}</div><div className="stat-label">Loudness range</div></div><div className="stat-cell"><div className="stat-value">{formatLevel(stats.maxShortTermLufs, 'LUFS')}</div><div className="stat-label">Max short-term</div></div></div>;
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

function ModuleCard({ module, index, total, collapsed, updateModule, updateParams, deleteModule, duplicateModule, moveModule }: { module: EditModule; index: number; total: number; collapsed: boolean; updateModule: (id: string, patch: Partial<EditModule>) => void; updateParams: (id: string, key: string, value: number | string) => void; deleteModule: (id: string) => void; duplicateModule: (module: EditModule) => void; moveModule: (index: number, direction: -1 | 1) => void }) {
  const p = module.params;
  const numberInput = (key: string, label: string, min: number, max: number, step: number, suffix = '', options?: { resetValue?: number; wheelStep?: number }) => <RangeControl label={label} value={Number(p[key])} min={min} max={max} step={step} suffix={suffix} resetValue={options?.resetValue} wheelStep={options?.wheelStep} onChange={(value) => updateParams(module.id, key, value)} testId={`range-${module.type}-${key}`} />;
  return <div className={`module-card ${module.enabled ? '' : 'bypassed'}`} data-testid={`card-module-${module.id}`}><div className="module-head"><span className="module-index">{String(index + 1).padStart(2, '0')}</span><span className="module-dot" /><button type="button" className="module-name text-left" onDoubleClick={() => { const name = window.prompt('Rename module', module.name); if (name?.trim()) updateModule(module.id, { name: name.trim() }); }} title="Double-click to rename" data-testid={`button-rename-${module.id}`}>{module.name}</button><span className="module-summary">{module.type === 'gain' ? `${p.db} dB` : module.type === 'hum' ? `${p.mode} · ${p.frequency} Hz` : module.type === 'wind' ? `HPF ${p.cutoff} Hz · Q ${p.q}` : module.type === 'eq' && p.mode === 'low-shelf' ? `Low shelf ${p.gain} dB · ${p.frequency} Hz · Q ${p.q}` : module.type === 'fade' ? `${Number(p.in) > 0 ? `${p.in} s in` : `${p.out} s out`}` : module.type}</span><button type="button" className={`icon-btn !h-6 !min-w-6 ${module.enabled ? 'text-[hsl(var(--primary))]' : ''}`} onClick={() => updateModule(module.id, { enabled: !module.enabled })} aria-label={`${module.enabled ? 'Bypass' : 'Enable'} ${module.name}`} aria-pressed={module.enabled} data-testid={`button-bypass-${module.id}`}><Check size={13} /></button><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => moveModule(index, -1)} disabled={index === 0} aria-label="Move module up" data-testid={`button-up-${module.id}`}><ArrowUp size={12} /></button><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => moveModule(index, 1)} disabled={index === total - 1} aria-label="Move module down" data-testid={`button-down-${module.id}`}><ArrowDown size={12} /></button><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => duplicateModule(module)} aria-label={`Duplicate ${module.name}`} data-testid={`button-duplicate-${module.id}`}><Layers3 size={12} /></button><button type="button" className="icon-btn !h-6 !min-w-6" onClick={() => deleteModule(module.id)} aria-label={`Delete ${module.name}`} data-testid={`button-delete-${module.id}`}><Trash2 size={12} /></button></div>
    {!collapsed && <div className="module-controls">
      {module.type === 'gain' && numberInput('db', 'Gain', -30, 30, .1, ' dB', { resetValue: 0, wheelStep: 1 })}
      {module.type === 'fade' && <div className="grid grid-cols-2 gap-3">{numberInput('in', 'Fade in', 0, 10, .1, ' s')}{numberInput('out', 'Fade out', 0, 10, .1, ' s')}</div>}
      {module.type === 'eq' && p.mode === 'low-shelf' && <div className="grid grid-cols-3 gap-2">{numberInput('frequency', 'Low shelf', 20, 240, .5, ' Hz')}{numberInput('q', 'Q', .1, 2, .01)}{numberInput('gain', 'Gain', -12, 12, .1, ' dB')}</div>}
      {module.type === 'eq' && p.mode !== 'low-shelf' && <div className="grid grid-cols-3 gap-2">{numberInput('low', 'Low', -12, 12, .5, ' dB')}{numberInput('mid', 'Mid', -12, 12, .5, ' dB')}{numberInput('high', 'High', -12, 12, .5, ' dB')}</div>}
      {module.type === 'dc' && <div className="grid grid-cols-2 gap-3"><label><span className="field-label">Detection</span><select className="select-field" value={String(p.mode)} onChange={(event) => updateParams(module.id, 'mode', event.target.value)}><option>Auto</option><option>Manual</option></select></label>{p.mode === 'Manual' && numberInput('amount', 'Offset estimate', -100, 100, 1, ' ×10⁻³')}</div>}
      {module.type === 'hum' && <div className="grid grid-cols-2 gap-3"><label><span className="field-label">Mode</span><select className="select-field" value={String(p.mode)} onChange={(event) => updateParams(module.id, 'mode', event.target.value)} data-testid={`select-hum-mode-${module.id}`}><option>Static</option><option>Dynamic</option><option>Adaptive</option></select></label>{numberInput('frequency', 'Fundamental', 40, 120, 1, ' Hz')}{numberInput('reduction', 'Reduction', 0, 24, 1, ' dB')}</div>}
      {module.type === 'wind' && <div className="grid grid-cols-2 gap-3">{numberInput('cutoff', 'High-pass cutoff', 20, 240, .5, ' Hz')}{numberInput('q', 'Q', .1, 2, .01)}</div>}
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

function ProjectPanel({ title, notes, setTitle, setNotes, source, sourceChannelCount, save, setModal }: { title: string; notes: string; setTitle: (value: string) => void; setNotes: (value: string) => void; source: AudioSource; sourceChannelCount: number; save: () => void; setModal: (value: 'export' | 'help' | 'settings' | null) => void }) {
  return <div className="space-y-4"><section className="panel"><div className="panel-header"><div><div className="section-title">Project metadata</div><div className="text-[10px] text-muted-foreground mt-1">Stored only in this browser on this device</div></div><button type="button" className="primary-btn" onClick={save} data-testid="button-project-save"><Save size={14} /> Save locally</button></div><div className="panel-body space-y-5 max-w-[740px]"><label><span className="field-label">Project title</span><input className="input-field text-[16px]" value={title} onChange={(event) => setTitle(event.target.value)} data-testid="input-project-title" /></label><label><span className="field-label">Field notes</span><textarea className="textarea-field min-h-[170px]" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Describe place, mic, weather, handling, and decisions…" data-testid="textarea-project-notes" /></label><div className="grid sm:grid-cols-3 gap-3"><div className="p-3 bg-[hsl(var(--muted))] rounded"><div className="eyebrow">Source</div><div className="font-mono-value text-[11px] mt-2 truncate">{source.name}</div></div><div className="p-3 bg-[hsl(var(--muted))] rounded"><div className="eyebrow">Format</div><div className="font-mono-value text-[11px] mt-2">{source.sampleRate / 1000} kHz / {sourceChannelCount} ch</div></div><div className="p-3 bg-[hsl(var(--muted))] rounded"><div className="eyebrow">Duration</div><div className="font-mono-value text-[11px] mt-2">{formatTime(source.duration)}</div></div></div></div></section><section className="panel"><div className="panel-header"><div className="section-title">Local-first guarantees</div></div><div className="panel-body grid sm:grid-cols-2 gap-3 text-[12px]"><div className="border rounded p-3"><Check size={15} color="hsl(var(--primary))" /><div className="font-semibold mt-2">Original is immutable</div><div className="text-muted-foreground mt-1 leading-relaxed">All processing reads from the original local file. No destructive overwrite occurs.</div></div><div className="border rounded p-3"><Check size={15} color="hsl(var(--primary))" /><div className="font-semibold mt-2">No network required</div><div className="text-muted-foreground mt-1 leading-relaxed">WAV parsing, DSP estimates, playback, persistence, and export happen in this tab.</div></div><button type="button" className="quiet-btn justify-self-start" onClick={() => setModal('settings')} data-testid="button-project-settings"><Settings size={14} /> Storage settings</button></div></section></div>;
}

function ExportModal({ onClose, onExport, title }: { onClose: () => void; onExport: () => void; title: string }) {
  return <div className="modal-backdrop" role="presentation"><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className="modal-header"><div><div className="eyebrow">Output / local files</div><h2 id="export-title" className="text-[17px] font-bold mt-1">Export restoration</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="Close export dialog" data-testid="button-close-export"><X size={16} /></button></div><div className="modal-body space-y-4"><div className="p-3 bg-[hsl(var(--muted))] rounded text-[12px]"><div className="font-semibold">{title || 'Untitled project'}</div><div className="text-muted-foreground mt-1">Two files will be created: a valid WAV and a machine-readable restoration report.</div></div><div className="block p-3 border border-[hsl(var(--primary))] bg-[hsl(var(--muted))] rounded"><strong className="text-[12px]">Archival WAV · 32-bit IEEE float</strong><span className="block text-[11px] text-muted-foreground mt-1">Preserves floating-point precision, source sample rate, channel count, and stereo relationship. No normalization or dither is applied.</span></div><div className="text-[11px] text-muted-foreground border-l-2 border-[#ff8a4c] pl-3">Exports use enabled modules only. The original recording is never replaced.</div></div><div className="modal-footer"><button type="button" className="quiet-btn" onClick={onClose} data-testid="button-cancel-export">Cancel</button><button type="button" className="primary-btn" onClick={onExport} data-testid="button-confirm-export"><Download size={14} /> Export 32-bit float WAV + report</button></div></div></div>;
}

function HelpModal({ onClose }: { onClose: () => void }) {
  return <div className="modal-backdrop"><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="help-title"><div className="modal-header"><div><div className="eyebrow">Field notes</div><h2 id="help-title" className="text-[17px] font-bold mt-1">A quiet tool for noisy places</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="Close help" data-testid="button-close-help"><X size={16} /></button></div><div className="modal-body"><p className="text-[12px] leading-relaxed text-muted-foreground">Field Restore intentionally favors small, reversible moves. Import a WAV, select a moment, listen against the original, and keep an ear on the source—not just the meters.</p><div className="mt-4"><div className="eyebrow mb-2">Keyboard</div><div className="help-row"><span className="keycap">Space</span><span>Play / pause</span></div><div className="help-row"><span className="keycap">⌘ Z</span><span>Undo chain edit</span></div><div className="help-row"><span className="keycap">⇧⌘ Z</span><span>Redo chain edit</span></div><div className="help-row"><span className="keycap">Esc</span><span>Close a dialog or menu</span></div></div><div className="mt-5 p-3 bg-[hsl(var(--muted))] rounded text-[11px] leading-relaxed"><Keyboard size={14} className="inline mr-2 -mt-0.5" />For critical work, verify the exported WAV in a second application. Browser DSP here is conservative and deliberately labeled as an estimate.</div></div><div className="modal-footer"><button type="button" className="primary-btn" onClick={onClose} data-testid="button-done-help">Back to work</button></div></div></div>;
}

function SettingsModal({ onClose, spectrogramPalette, onSpectrogramPaletteChange }: { onClose: () => void; spectrogramPalette: SpectrogramPaletteId; onSpectrogramPaletteChange: (palette: SpectrogramPaletteId) => void }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggleTheme = () => { const next = !dark; setDark(next); document.documentElement.classList.toggle('dark', next); localStorage.setItem('field-restore-theme', next ? 'dark' : 'light'); };
  return <div className="modal-backdrop"><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-header"><div><div className="eyebrow">Instrument settings</div><h2 id="settings-title" className="text-[17px] font-bold mt-1">Preferences</h2></div><button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings" data-testid="button-close-settings"><X size={16} /></button></div><div className="modal-body space-y-4"><div className="flex items-center justify-between border rounded p-3"><div><div className="text-[12px] font-semibold">Darkroom contrast</div><div className="text-[11px] text-muted-foreground mt-1">Switch to a darker monitoring surface.</div></div><button type="button" className={`quiet-btn ${dark ? '!bg-[hsl(var(--primary))] !text-[hsl(var(--primary-foreground))]' : ''}`} onClick={toggleTheme} aria-pressed={dark} data-testid="button-toggle-theme">{dark ? 'On' : 'Off'}</button></div><fieldset><legend className="field-label">Spectrogram color scale</legend><div className="palette-grid">{(Object.entries(SPECTROGRAM_PALETTES) as Array<[SpectrogramPaletteId, typeof SPECTROGRAM_PALETTES[SpectrogramPaletteId]]>).map(([id, palette]) => <button key={id} type="button" className={`palette-option ${spectrogramPalette === id ? 'selected' : ''}`} onClick={() => onSpectrogramPaletteChange(id)} aria-pressed={spectrogramPalette === id} data-testid={`button-palette-${id}`}><span className="palette-swatch" style={{ background: `linear-gradient(90deg, ${palette.stops.map(([position, color]) => `${color} ${position * 100}%`).join(', ')})` }} /><span><strong>{palette.label}</strong><small>{palette.description}</small></span>{spectrogramPalette === id && <Check size={14} />}</button>)}</div></fieldset><div className="border rounded p-3 text-[11px] leading-relaxed text-muted-foreground"><RotateCcw size={14} className="inline mr-2 -mt-0.5" />Project storage uses browser localStorage. Clear site data in browser settings to remove it. No audio or metadata leaves this device.</div></div><div className="modal-footer"><button type="button" className="primary-btn" onClick={onClose} data-testid="button-done-settings">Done</button></div></div></div>;
}

export default App;