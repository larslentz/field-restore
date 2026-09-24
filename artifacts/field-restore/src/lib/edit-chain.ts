import { cloneChannels, type ChannelData } from './audio';
import { HumProcessor, humAnalysisWindowSize, humPrefixFrames } from './hum-removal';

export type ModuleType = 'gain' | 'fade' | 'eq' | 'dc' | 'hum' | 'wind' | 'region' | 'ambient';
export interface EditModule {
  id: string;
  type: ModuleType;
  name: string;
  enabled: boolean;
  params: Record<string, number | string>;
}

export const MODULE_LABELS: Record<ModuleType, string> = {
  gain: 'Gain', fade: 'Fade', eq: 'EQ', dc: 'DC Offset', hum: 'Hum Removal', wind: 'Wind / Rumble',
  region: 'Region Attenuation', ambient: 'Ambient Patch',
};

let idCounter = 1;
export const makeModule = (type: ModuleType, options?: { name?: string; params?: Record<string, number | string> }): EditModule => {
  const defaults: Record<ModuleType, Record<string, number | string>> = {
    gain: { db: -2 }, fade: { in: 0, out: 0 }, eq: { mode: 'three-band', low: 0, mid: 0, high: -1, frequency: 55, q: 0.4, gain: 0 }, dc: { mode: 'Auto', amount: 0 },
    hum: { mode: 'Static', frequency: 60, reduction: 12 }, wind: { cutoff: 100, q: 0.7 },
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

export const makeLowRumbleRemoval = (): EditModule =>
  makeModule('wind', { name: 'Low Rumble Removal', params: { cutoff: 55.5, q: 0.38 } });

export const makeBringBackLowEnd = (): EditModule =>
  makeModule('eq', { name: 'Bring Back the Low End', params: { mode: 'low-shelf', frequency: 55, q: 0.4, gain: 3 } });

export const makeDefaultChain = (): EditModule[] => [
  makeModule('gain', { name: 'Gain', params: { db: 0 } }),
  makeLowRumbleRemoval(),
  makeModule('hum', { name: 'Hum Removal', params: { mode: 'Adaptive', frequency: 60, reduction: 12 } }),
  makeModule('wind', { name: 'Wind / Rumble', params: { cutoff: 100, q: 0.7 } }),
  makeBringBackLowEnd(),
  makeModule('fade', { name: 'Fade In', params: { in: 7, out: 0 } }),
  makeModule('fade', { name: 'Fade Out', params: { in: 0, out: 7 } }),
  makeModule('gain', { name: 'Gain', params: { db: 0 } }),
];

export const AUTOMATIC_DC_REMOVAL: EditModule = {
  id: 'automatic-dc-removal',
  type: 'dc',
  name: 'Remove DC Offset',
  enabled: true,
  params: { mode: 'Auto', amount: 0 },
};

export const withoutLegacyDcModules = (modules: EditModule[]): EditModule[] =>
  modules.filter((module) => module.type !== 'dc');

export const makeProcessingChain = (modules: EditModule[]): EditModule[] => [
  AUTOMATIC_DC_REMOVAL,
  ...withoutLegacyDcModules(modules),
];

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
    limitations: [
      'Automatic DC offset removal is always applied before editable modules.',
      'Adaptive hum detection is conservative: it can miss interference or affect wanted steady tones.',
      'Edits are conservative sample-domain approximations in this browser build.',
      'Original source remains immutable; export reflects automatic DC correction and enabled modules.',
    ],
  };
}

const dbToAmp = (db: number) => 10 ** (db / 20);
export const AUTOMATIC_DC_BLOCKER_POLE = 0.995;

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
    const fadeIn = Math.floor(Number(p.in) * sampleRate);
    const fadeOut = Math.floor(Number(p.out) * sampleRate);
    output.forEach((channel) => channel.forEach((sample, i) => {
      let factor = 1;
      const absoluteFrame = frameOffset + i;
      if (fadeIn > 0 && absoluteFrame < fadeIn) factor *= absoluteFrame / fadeIn;
      if (fadeOut > 0 && absoluteFrame > totalFrames - fadeOut) factor *= Math.max(0, (totalFrames - absoluteFrame) / fadeOut);
      channel[i] = sample * factor;
    }));
  } else if (module.type === 'dc') {
    output.forEach((channel) => {
      if (p.mode === 'Auto') {
        let previousInput = 0;
        let previousOutput = 0;
        channel.forEach((sample, i) => {
          const value = sample - previousInput + AUTOMATIC_DC_BLOCKER_POLE * previousOutput;
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
    new HumProcessor(p, sampleRate, output.length, context.initialHumFrequencies).process(output);
  } else if (module.type === 'wind') {
    const cutoff = Math.max(20, Number(p.cutoff) || 100);
    const q = Math.max(0.1, Number(p.q) || 0.7);
    const coefficients = highPass(sampleRate, cutoff, q);
    output.forEach((channel) => processBiquad(channel, coefficients));
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

export function renderChain(original: ChannelData, modules: EditModule[], sampleRate: number, context: RenderContext = {}, initialSeeds?: number[][]) {
  const seeds = context.frameOffset ? [] : initialSeeds ?? analyzeInitialHum(original, modules, sampleRate, context.totalFrames ?? original[0]?.length ?? 0);
  return modules.reduce((audio, module, index) => applyModule(audio, module, sampleRate,
    { ...context, initialHumFrequencies: seeds[index] }), cloneChannels(original));
}