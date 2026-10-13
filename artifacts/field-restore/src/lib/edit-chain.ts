import { cloneChannels, type ChannelData } from './audio';
import { HumProcessor, humAnalysisWindowSize, humPrefixFrames } from './hum-removal';
import { WindProcessor, WIND_COMPENSATION_TIMING, WIND_DEFAULTS, WIND_SHELF_SCOPE_DETECTED, WIND_SHELF_SCOPE_WHOLE, windCompensationTiming, windCrossoverFrequency, windLevel, windReductionPercent, windSmoothing } from './wind-reduction';
import { NoiseReductionProcessor, noiseProfileFromParams } from './noise-reduction';
import { ClickPopProcessor } from './click-pop-removal';
import { renderSpectralRepair } from './spectral-repair';
import { normalizeTrackDescription, TRACK_DESCRIPTION_FIELDS, type TrackDescription } from './track-description';

export type ModuleType = 'gain' | 'fade' | 'eq' | 'dc' | 'hum' | 'wind' | 'noise' | 'click-pop' | 'spectral-repair' | 'region' | 'ambient';
export interface EditModule {
  id: string;
  type: ModuleType;
  name: string;
  enabled: boolean;
  params: Record<string, number | string>;
}

export const MODULE_LABELS: Record<ModuleType, string> = {
  gain: 'Gain', fade: 'Fade In/Out', eq: 'EQ', dc: 'DC Offset', hum: 'Hum Removal', wind: 'Wind Removal', noise: 'Noise Reduction',
  'click-pop': 'Click & Pop Removal', 'spectral-repair': 'Short Sound Repair', region: 'Region Attenuation', ambient: 'Ambient Patch',
};

const DEFAULT_WIND_NAMES = new Set(['Wind / Rumble', 'Wind / Rumble Removal', MODULE_LABELS.wind]);

let idCounter = 1;
export const makeModule = (type: ModuleType, options?: { name?: string; params?: Record<string, number | string> }): EditModule => {
  const defaults: Record<ModuleType, Record<string, number | string>> = {
    gain: { db: -2 }, fade: { in: 7, out: 7, inEnabled: 1, outEnabled: 1 }, eq: { mode: 'three-band', low: 0, mid: 0, high: -1, frequency: 55, q: 0.4, gain: 0 }, dc: { mode: 'Auto', amount: 0 },
    hum: { mode: 'Static', frequency: 60, reduction: 12 }, wind: { mode: 'Automatic', ...WIND_DEFAULTS, compensationAttackMs: WIND_COMPENSATION_TIMING.attack.defaultMs, compensationReleaseMs: WIND_COMPENSATION_TIMING.release.defaultMs, lowEndEnabled: 0, lowEndScope: WIND_SHELF_SCOPE_WHOLE, lowEndFrequency: 55, lowEndQ: .4, lowEndGain: 2 }, noise: { strength: 50 },
    'click-pop': { mode: 'Automatic', strength: 75 },
    'spectral-repair': { start: 0, end: .5, low: 1000, high: 5000, mode: 'Attenuate', strength: 75, context: .2, weighting: 50, fundamental: 100 },
    region: { start: 0, end: 0, amount: -8 }, ambient: { start: 0, end: 0, length: 1 },
  };
  return {
    id: `${type}-${Date.now()}-${idCounter++}`,
    type,
    name: options?.name ?? MODULE_LABELS[type],
    enabled: true,
    params: { ...defaults[type], ...options?.params },
  };
};

export const makeLowRumbleRemoval = (): EditModule => {
  const module = makeModule('wind', { name: 'Low Rumble Removal' });
  return { ...module, params: { mode: 'Fixed low rumble', cutoff: 55.5, q: 0.38, lowEndEnabled: 1, lowEndFrequency: 55, lowEndQ: .4, lowEndGain: 2 } };
};

const makeFieldRecordingChain = (): EditModule[] => [
  makeModule('gain', { name: 'Gain', params: { db: 0 } }),
  makeLowRumbleRemoval(),
  makeModule('hum', { name: 'Hum Removal', params: { mode: 'Adaptive', frequency: 60, reduction: 12 } }),
  makeModule('wind'),
  makeModule('fade'),
  makeModule('gain', { name: 'Gain', params: { db: 0 } }),
];

const bypassOptionalCleanup = (modules: EditModule[]): EditModule[] => modules.map((module) =>
  module.name === 'Hum Removal' || module.name === 'Wind Removal'
    ? { ...module, enabled: false }
    : module,
);

export const makeDefaultChain = (): EditModule[] => bypassOptionalCleanup(makeFieldRecordingChain());
export const makeCommonFieldChain = (): EditModule[] => bypassOptionalCleanup(makeFieldRecordingChain());

export const AUTOMATIC_DC_REMOVAL: EditModule = {
  id: 'automatic-dc-removal',
  type: 'dc',
  name: 'Remove DC Offset',
  enabled: true,
  params: { mode: 'Auto', amount: 0 },
};

/** Older low-rumble edits have no type marker; retain the named item or its distinctive factory settings. */
export const isFixedLowRumble = (module: EditModule) => module.type === 'wind' &&
  (module.params.mode === 'Fixed low rumble' ||
    (module.params.mode === undefined && (module.name === 'Low Rumble Removal' ||
      (!DEFAULT_WIND_NAMES.has(module.name) &&
        Number(module.params.cutoff) === 55.5 && Number(module.params.q) === .38))));

export const lowEndShelfEnabled = (params: EditModule['params']) => Number(params.lowEndEnabled) === 1;
export const lowEndShelfFollowsWind = (params: EditModule['params']) =>
  params.lowEndScope === WIND_SHELF_SCOPE_DETECTED;
export const lowEndShelfCoefficients = (params: EditModule['params'], sampleRate: number) =>
  lowShelf(sampleRate, Math.max(20, Number(params.lowEndFrequency) || 55),
    Math.max(.1, Number(params.lowEndQ) || .4), Number(params.lowEndGain) || 0);

export const isLegacyWind = (module: EditModule) =>
  module.type === 'wind' && !isFixedLowRumble(module) && module.params.mode !== 'Automatic';

export const normalizeWindModule = (module: EditModule): EditModule => {
  if (module.type !== 'wind') return module;
  if (isFixedLowRumble(module)) return module.params.mode === 'Fixed low rumble' ? module :
    { ...module, params: { ...module.params, mode: 'Fixed low rumble' } };
  const name = DEFAULT_WIND_NAMES.has(module.name) ? MODULE_LABELS.wind : module.name;
  const existing = module.params.mode === 'Automatic' ? module.params : {};
  const timing = windCompensationTiming(existing);
  const params = { ...existing };
  delete params.removal;
  Object.assign(params, {
    mode: 'Automatic',
    detection: windLevel(existing.detection ?? module.params.detection),
    reduction: windReductionPercent(module.params.reduction, module.params.removal),
    crossoverHz: windCrossoverFrequency(existing.crossoverHz),
    smoothing: windSmoothing(existing.smoothing),
    compensationAttackMs: timing.attackMs || WIND_COMPENSATION_TIMING.attack.defaultMs,
    compensationReleaseMs: timing.releaseMs || WIND_COMPENSATION_TIMING.release.defaultMs,
  });
  return { ...module, name, params };
};

export const withoutLegacyDcModules = (modules: EditModule[]): EditModule[] =>
  modules.filter((module) => module.type !== 'dc').map((module) => {
    const normalized = normalizeWindModule(module);
    return normalized.type === 'spectral-repair' && normalized.name === 'Spectral Repair'
      ? { ...normalized, name: MODULE_LABELS['spectral-repair'] }
      : normalized;
  });

export const restoreSavedChain = (modules: EditModule[]): EditModule[] => {
  const editable = withoutLegacyDcModules(modules);
  return editable.length ? editable : makeCommonFieldChain();
};

export const makeProcessingChain = (modules: EditModule[]): EditModule[] => [
  AUTOMATIC_DC_REMOVAL,
  ...withoutLegacyDcModules(modules),
];

export const withFadeRange = (modules: EditModule[], startFrame: number, endFrame: number): EditModule[] =>
  modules.map((module) => module.type === 'fade'
    ? { ...module, params: { ...module.params, fadeStartFrame: startFrame, fadeEndFrame: endFrame } }
    : module);

export function fadeGainAtFrame(params: EditModule['params'], frame: number, sampleRate: number, totalFrames: number): number {
  const start = Number(params.fadeStartFrame ?? 0);
  const end = Number(params.fadeEndFrame ?? totalFrames);
  const fadeIn = Number(params.inEnabled) === 0 ? 0 : Math.floor(Number(params.in) * sampleRate);
  const fadeOut = Number(params.outEnabled) === 0 ? 0 : Math.floor(Number(params.out) * sampleRate);
  let factor = 1;
  if (fadeIn > 0 && frame < start + fadeIn) factor *= Math.max(0, (frame - start) / fadeIn);
  if (fadeOut > 0 && frame > end - fadeOut) factor *= Math.max(0, (end - frame) / fadeOut);
  return factor;
}

export const toggleEditableModules = (modules: EditModule[]): EditModule[] => {
  if (modules.length === 0) return modules;
  const enable = modules.some((module) => !module.enabled);
  return modules.map((module) => ({ ...module, enabled: enable }));
};

export interface RestorationReportInput {
  source: string;
  sampleRate: number;
  channels: number;
  duration: number;
  container: 'RIFF' | 'RF64';
  modules: EditModule[];
  selection: [number, number];
  trim?: [number, number];
  sourceDuration?: number;
  exportedAt?: string;
  trackDescription?: TrackDescription;
}

export function makeRestorationReport(input: RestorationReportInput) {
  return {
    tool: 'Field Restore',
    version: 'local preview',
    source: input.source,
    sampleRate: input.sampleRate,
    channels: input.channels,
    duration: input.duration,
    sourceDuration: input.sourceDuration ?? input.duration,
    trim: input.trim ?? [0, input.duration],
    format: '32-bit IEEE float WAV',
    container: input.container,
    automaticDcOffsetRemoval: true,
    modules: withoutLegacyDcModules(input.modules),
    selection: input.selection,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    trackDescription: normalizeTrackDescription(input.trackDescription),
    limitations: [
      'Automatic DC offset removal is always applied before editable modules.',
      'Previously saved projects may sound different when reprocessed with the updated DC correction; original recordings remain untouched.',
      'Adaptive Hum Removal attenuates detected sustained tones regardless of their source, including wanted held notes and calls; short or changing tones may not be detected.',
      'Automatic wind/rumble detection may miss interference or reduce wanted low sounds.',
      'Click & Pop Removal estimates isolated short discontinuities; it may miss longer defects or soften abrupt wanted impacts.',
        'Short Sound Repair estimates short time-frequency patches; pattern and harmonic suppression can also reduce wanted repeating sounds or harmonics. It cannot recover fully masked sound.',
      'Edits are conservative sample-domain approximations in this browser build.',
      'Original source remains immutable; export reflects automatic DC correction and enabled modules.',
    ],
  };
}

const humanizeReportSetting = (module: EditModule, key: string, value: number | string, sampleRate: number) => {
  const labels: Record<string, string> = {
    db: 'Gain',
    frequency: 'Frequency',
    cutoff: 'Cutoff',
    reduction: 'Reduction',
    strength: 'Strength',
    q: 'Q factor',
    lowEndFrequency: 'Low-end frequency',
    lowEndGain: 'Low-end gain',
    lowEndQ: 'Low-end Q factor',
    compensationAttackMs: 'Compensation attack',
    compensationReleaseMs: 'Compensation release',
    crossoverHz: 'Crossover frequency',
    in: 'Fade-in length',
    out: 'Fade-out length',
    inEnabled: 'Fade-in',
    outEnabled: 'Fade-out',
    sampleStart: 'Noise sample start',
    sampleEnd: 'Noise sample end',
    fadeStartFrame: 'Fade range start',
    fadeEndFrame: 'Fade range end',
  };
  const genericLabel = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const label = module.type === 'spectral-repair' && key === 'low' ? 'Lower frequency'
    : module.type === 'spectral-repair' && key === 'high' ? 'Upper frequency'
      : labels[key] ?? genericLabel;
  let displayValue: string;
  if (key === 'inEnabled' || key === 'outEnabled' || key === 'lowEndEnabled') {
    displayValue = Number(value) ? 'On' : 'Off';
  } else if ((key === 'fadeStartFrame' || key === 'fadeEndFrame') && typeof value === 'number') {
    displayValue = `${(value / sampleRate).toFixed(3)} s`;
  } else if (typeof value === 'number') {
    const isEqBand = module.type === 'eq' && ['low', 'mid', 'high'].includes(key);
    const unit = key.endsWith('Ms') ? ' ms'
      : (module.type === 'wind' && (key === 'reduction' || key === 'smoothing')) ? '%'
        : (['db', 'gain', 'amount', 'reduction', 'lowEndGain'].includes(key) || isEqBand) ? ' dB'
          : ['frequency', 'cutoff', 'lowEndFrequency', 'fundamental', 'crossoverHz'].includes(key) ? ' Hz'
          : module.type === 'spectral-repair' && (key === 'low' || key === 'high') ? ' Hz'
          : ['in', 'out', 'start', 'end', 'context', 'length', 'sampleStart', 'sampleEnd'].includes(key) ? ' s'
            : key === 'strength' || key === 'weighting' ? '%'
              : '';
    const valueText = Number.isInteger(value) ? value.toLocaleString('en-US') : String(value);
    displayValue = `${valueText}${unit}`;
  } else {
    displayValue = value;
  }
  return `   ${label}: ${displayValue}`;
};

const reportTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return 'Unknown';
  const milliseconds = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const wholeSeconds = Math.floor(milliseconds / 1000) % 60;
  const fraction = milliseconds % 1000;
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`;
};

export function formatRestorationReport(report: ReturnType<typeof makeRestorationReport>): string {
  const channelLabel = report.channels === 1 ? 'Mono'
    : report.channels === 2 ? 'Stereo'
      : `${report.channels} channels`;
  const chain = report.modules.length
    ? report.modules.map((module, index) => [
      `${index + 1}. ${module.name} — ${module.enabled ? 'Enabled' : 'Bypassed'}`,
      ...Object.entries(module.params).map(([key, value]) => humanizeReportSetting(module, key, value, report.sampleRate)),
    ].join('\n')).join('\n')
    : 'No editable modules.';
  return [
    'FIELD RESTORE — RESTORATION REPORT',
    '==================================',
    `Exported: ${report.exportedAt} (UTC)`,
    `Source recording: ${report.source}`,
    `Output format: ${report.format}`,
    `WAV container: ${report.container}`,
    `Sample rate: ${report.sampleRate.toLocaleString('en-US')} Hz`,
    `Channels: ${channelLabel} (${report.channels})`,
    `Export duration: ${reportTime(report.duration)}`,
    `Original duration: ${reportTime(report.sourceDuration)}`,
    `Trim range: ${reportTime(report.trim[0])} – ${reportTime(report.trim[1])}`,
    `Selection: ${reportTime(report.selection[0])} – ${reportTime(report.selection[1])}`,
    `Automatic DC offset removal: ${report.automaticDcOffsetRemoval ? 'Applied' : 'Not applied'}`,
    '',
    'TRACK DESCRIPTION',
    '-----------------',
    ...TRACK_DESCRIPTION_FIELDS.flatMap(({ key, label }) => [
      label,
      report.trackDescription[key].trim() ? report.trackDescription[key] : 'Not provided.',
      '',
    ]),
    'EDIT CHAIN',
    '----------',
    chain,
    '',
    'PROCESSING NOTES',
    '----------------',
    ...report.limitations.map((limitation) => `- ${limitation}`),
    '',
  ].join('\n');
}

const dbToAmp = (db: number) => 10 ** (db / 20);

/** A 2 Hz corner settles a constant offset within a second while preserving 20 Hz bass. */
export const automaticDcBlockerPole = (sampleRate: number) => Math.exp(-2 * Math.PI * 2 / sampleRate);
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function processBiquad(channel: Float32Array, coefficients: Biquad) {
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  channel.forEach((sample, index) => {
    const value = coefficients.b0 * sample + coefficients.b1 * x1 + coefficients.b2 * x2 - coefficients.a1 * y1 - coefficients.a2 * y2;
    x2 = x1; x1 = sample; y2 = y1; y1 = value;
    channel[index] = value;
  });
}

export function highPass(sampleRate: number, frequency: number, q: number): Biquad {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosine) / 2) / a0,
    b1: -(1 + cosine) / a0,
    b2: ((1 + cosine) / 2) / a0,
    a1: (-2 * cosine) / a0,
    a2: (1 - alpha) / a0,
  };
}

export function lowShelf(sampleRate: number, frequency: number, q: number, gainDb: number): Biquad {
  const amplitude = 10 ** (gainDb / 40);
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * q);
  const rootAmplitude = Math.sqrt(amplitude);
  const a0 = (amplitude + 1) + (amplitude - 1) * cosine + 2 * rootAmplitude * alpha;
  return {
    b0: amplitude * ((amplitude + 1) - (amplitude - 1) * cosine + 2 * rootAmplitude * alpha) / a0,
    b1: 2 * amplitude * ((amplitude - 1) - (amplitude + 1) * cosine) / a0,
    b2: amplitude * ((amplitude + 1) - (amplitude - 1) * cosine - 2 * rootAmplitude * alpha) / a0,
    a1: -2 * ((amplitude - 1) + (amplitude + 1) * cosine) / a0,
    a2: ((amplitude + 1) + (amplitude - 1) * cosine - 2 * rootAmplitude * alpha) / a0,
  };
}

function averageAt(channels: ChannelData, index: number) {
  return channels.reduce((sum, channel) => sum + (channel[index] ?? 0), 0) / Math.max(1, channels.length);
}

export interface RenderContext {
  frameOffset?: number;
  totalFrames?: number;
  initialHumFrequencies?: number[];
  onHumChange?: (frame: number, frequencies: number[]) => void;
  onWindChange?: (frame: number, active: boolean) => void;
  onClickRepair?: (frame: number) => void;
}

export function applyModule(input: ChannelData, module: EditModule, sampleRate: number, context: RenderContext = {}): ChannelData {
  const output = cloneChannels(input);
  if (!module.enabled) return output;
  const length = output[0]?.length ?? 0;
  const frameOffset = context.frameOffset ?? 0;
  const totalFrames = context.totalFrames ?? length;
  const p = module.params;
  if (module.type === 'gain') {
    const amp = dbToAmp(Number(p.db) || 0);
    output.forEach((channel) => channel.forEach((sample, i) => { channel[i] = Math.max(-1, Math.min(1, sample * amp)); }));
  } else if (module.type === 'fade') {
    output.forEach((channel) => channel.forEach((sample, i) => {
      channel[i] = sample * fadeGainAtFrame(p, frameOffset + i, sampleRate, totalFrames);
    }));
  } else if (module.type === 'dc') {
    output.forEach((channel) => {
      if (p.mode === 'Auto') {
        const pole = automaticDcBlockerPole(sampleRate);
        let previousInput = 0;
        let previousOutput = 0;
        channel.forEach((sample, i) => {
          const value = sample - previousInput + pole * previousOutput;
          previousInput = sample;
          previousOutput = value;
          channel[i] = Math.max(-1, Math.min(1, value));
        });
        return;
      }
      const amount = Number(p.amount) / 1000;
      channel.forEach((sample, i) => { channel[i] = Math.max(-1, Math.min(1, sample - amount)); });
    });
  } else if (module.type === 'eq') {
    if (p.mode === 'low-shelf') {
      const coefficients = lowShelf(sampleRate, Math.max(20, Number(p.frequency) || 55), Math.max(0.1, Number(p.q) || 0.4), Number(p.gain) || 0);
      output.forEach((channel) => processBiquad(channel, coefficients));
    } else {
      const low = dbToAmp(Number(p.low) || 0);
      const high = dbToAmp(Number(p.high) || 0);
      output.forEach((channel) => {
        let lowState = 0;
        channel.forEach((sample, i) => {
          lowState += (sample - lowState) * .015;
          const highPart = sample - lowState;
          channel[i] = Math.max(-1, Math.min(1, lowState * low + highPart * dbToAmp(Number(p.mid) || 0) * .72 + highPart * high * .28));
        });
      });
    }
  } else if (module.type === 'hum') {
    new HumProcessor(p, sampleRate, output.length, context.initialHumFrequencies,
      context.onHumChange && ((frame, frequencies) => context.onHumChange!(frameOffset + frame, frequencies))).process(output);
  } else if (module.type === 'wind') {
    const followsWind = !isFixedLowRumble(module) && lowEndShelfEnabled(p) && lowEndShelfFollowsWind(p);
    const shelf = followsWind ? lowEndShelfCoefficients(p, sampleRate) : undefined;
    const shelfFilters = followsWind
      ? output.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }))
      : [];
    const applyShelfAtFrame = (frame: number, amount: number) => {
      for (let c = 0; c < output.length; c++) {
        const channel = output[c];
        const filter = shelfFilters[c];
        const sample = channel[frame];
        const filtered = shelf!.b0 * sample + shelf!.b1 * filter.x1 + shelf!.b2 * filter.x2
          - shelf!.a1 * filter.y1 - shelf!.a2 * filter.y2;
        filter.x2 = filter.x1; filter.x1 = sample; filter.y2 = filter.y1; filter.y1 = filtered;
        channel[frame] = sample + amount * (filtered - sample);
      }
    };
    if (isFixedLowRumble(module)) {
      const coefficients = highPass(sampleRate, Math.max(20, Number(p.cutoff) || 55.5), Math.max(.1, Number(p.q) || .38));
      output.forEach((channel) => processBiquad(channel, coefficients));
    } else {
      new WindProcessor(sampleRate, output.length, windLevel(p.detection), windReductionPercent(p.reduction, p.removal),
        context.onWindChange && ((frame, active) => context.onWindChange!(frameOffset + frame, active)),
        0, windCompensationTiming(p), windCrossoverFrequency(p.crossoverHz, sampleRate), windSmoothing(p.smoothing))
        .process(output, followsWind ? applyShelfAtFrame : undefined);
    }
    if (lowEndShelfEnabled(p) && !followsWind) {
      const coefficients = lowEndShelfCoefficients(p, sampleRate);
      output.forEach((channel) => processBiquad(channel, coefficients));
    }
  } else if (module.type === 'noise') {
    new NoiseReductionProcessor(sampleRate, output.length, Number(p.strength), noiseProfileFromParams(p)).process(output);
  } else if (module.type === 'click-pop') {
    new ClickPopProcessor(p, sampleRate, output.length,
      context.onClickRepair && ((frame) => context.onClickRepair!(frameOffset + frame))).process(output);
  } else if (module.type === 'spectral-repair') {
    return renderSpectralRepair(output, sampleRate, p, frameOffset);
  } else if (module.type === 'region') {
    const start = Math.max(0, Math.floor(Math.max(0, Number(p.start)) * sampleRate) - frameOffset);
    const end = Math.min(length, Math.floor(Math.max(Number(p.end), Number(p.start)) * sampleRate) - frameOffset);
    const factor = dbToAmp(Number(p.amount) || 0);
    output.forEach((channel) => { for (let i = start; i < end; i += 1) channel[i] *= factor; });
  } else if (module.type === 'ambient') {
    const start = Math.floor(Math.max(0, Number(p.start)) * sampleRate);
    const end = Math.min(length, start + Math.floor(Math.max(.1, Number(p.length)) * sampleRate));
    const blend = Math.min(.9, Math.max(.05, Number(p.length) / 4));
    output.forEach((channel) => {
      const bed = averageAt(input, Math.min(length - 1, start));
      for (let i = start; i < end; i += 1) channel[i] = channel[i] * (1 - blend) + bed * blend;
    });
  }
  return output;
}

/** Analyze only the opening two windows through the preceding modules, without retaining source audio. */
export function analyzeInitialHum(original: ChannelData, modules: EditModule[], sampleRate: number, totalFrames: number): number[][] {
  const seeds = modules.map(() => [] as number[]);
  if (!modules.some((module) => module.enabled && module.type === 'hum' && module.params.mode !== 'Static')) return seeds;
  const frames = humPrefixFrames(sampleRate, totalFrames);
  if (frames < 2 * humAnalysisWindowSize(sampleRate) || !original.length ||
    original.some((channel) => channel.length < frames)) return seeds;
  let audio: ChannelData = original.map((channel) => channel.slice(0, frames));
  modules.forEach((module, index) => {
    if (module.enabled && module.type === 'hum' && module.params.mode !== 'Static') {
      const processor = new HumProcessor(module.params, sampleRate, audio.length);
      const next = cloneChannels(audio);
      processor.process(next);
      seeds[index] = processor.confirmedFrequencies();
      audio = next;
    } else {
      audio = applyModule(audio, module, sampleRate, { totalFrames });
    }
  });
  return seeds;
}

export type HumScanState = 'loading' | 'complete' | 'too-short' | 'unavailable' | 'error';

/** Report only the opening decision, not frequencies that may be tracked later in the recording. */
export function humOpeningReadout(module: EditModule, state: HumScanState, frequencies: number[] = []) {
  if (!module.enabled) return { summary: 'Bypassed', detail: 'Hum cleanup is bypassed; no filters are applied.' };
  if (Number(module.params.reduction) <= 0) return { summary: 'Disabled · 0 dB', detail: 'Hum cleanup is disabled at 0 dB reduction; no filters are applied.' };
  if (module.params.mode === 'Static') return {
    summary: `Static · ${module.params.frequency} Hz`,
    detail: 'Manual frequency; no automatic opening scan is used.',
  };
  const mode = String(module.params.mode);
  if (state === 'loading') return { summary: `${mode} · scanning`, detail: 'Checking the opening of this recording for sustained hum…' };
  if (state === 'unavailable') return { summary: `${mode} · source unavailable`, detail: 'Relink the original recording to check for hum.' };
  if (state === 'error') return { summary: `${mode} · scan failed`, detail: 'Opening scan failed; no frequency estimate is available. Playback may still detect hum later.' };
  if (state === 'too-short') return { summary: `${mode} · scan unavailable`, detail: 'Recording is too short for the two-window opening scan. Playback may still detect hum later.' };
  if (!frequencies.length) return {
    summary: `${mode} · none confirmed`,
    detail: 'Opening scan: no confirmed interference. Hum later in the recording may still be detected.',
  };
  const formatted = frequencies.map((frequency) => `${frequency.toFixed(1)} Hz`);
  return {
    summary: `${mode} · ~${Math.round(frequencies[0])} Hz${frequencies.length > 1 ? ` +${frequencies.length - 1}` : ''}`,
    detail: `Opening scan confirmed hum. Estimated filter frequencies: ${formatted.join(', ')}. These may change during playback.`,
  };
}

export function renderChain(original: ChannelData, modules: EditModule[], sampleRate: number, context: RenderContext = {}, initialSeeds?: number[][],
  onHumChange?: (moduleId: string, frame: number, frequencies: number[]) => void,
  onWindChange?: (moduleId: string, frame: number, active: boolean) => void,
  onClickRepair?: (moduleId: string, frame: number) => void) {
  const seeds = context.frameOffset ? [] : initialSeeds ?? analyzeInitialHum(original, modules, sampleRate, context.totalFrames ?? original[0]?.length ?? 0);
  return modules.reduce((audio, module, index) => applyModule(audio, module, sampleRate,
    { ...context, initialHumFrequencies: seeds[index],
      onHumChange: onHumChange && ((frame, frequencies) => onHumChange(module.id, frame, frequencies)),
       onWindChange: onWindChange && ((frame, active) => onWindChange(module.id, frame, active)),
       onClickRepair: onClickRepair && ((frame) => onClickRepair(module.id, frame)) }), cloneChannels(original));
}
