import type { ChannelData } from './audio';
import { AUTOMATIC_DC_BLOCKER_POLE, analyzeInitialHum, isFixedLowRumble, type EditModule } from './edit-chain';
import { WindProcessor, windLevel, type WindSnapshot } from './wind-reduction';
import { HumProcessor, humPrefixFrames, type HumSnapshot } from './hum-removal';
import { readFrames, type WavMetadata } from './large-wav';

interface FilterState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

interface ModuleState {
  filters: FilterState[];
  low: number[];
  dcX: number[];
  dcY: number[];
  phase: number;
  ambientBed: number[] | undefined;
  hum: HumProcessor | undefined;
  wind: WindProcessor | undefined;
}

export interface StreamingEditChainSnapshot {
  nextFrame: number;
  state: Array<Omit<ModuleState, 'hum' | 'wind'> & { hum: HumSnapshot | undefined; wind: WindSnapshot | undefined }>;
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

const dbToAmp = (db: number) => 10 ** (db / 20);
const clamp = (value: number) => Math.max(-1, Math.min(1, value));
const finite = (value: number) => Number.isFinite(value) ? value : 0;

function highPass(sampleRate: number, frequency: number, q: number): Biquad {
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

function lowShelf(sampleRate: number, frequency: number, q: number, gainDb: number): Biquad {
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

/**
 * A chunk-oriented edit chain. Only filter history and a small amount of
 * module state are retained; audio preceding the current chunk is never kept.
 */
export class StreamingEditChain {
  private readonly state: ModuleState[];
  private readonly modules: EditModule[];
  private readonly sampleRate: number;
  private readonly totalFrames: number;
  private readonly initialHumFrequencies: number[][];
  private nextFrame: number;

  constructor(
    modules: EditModule[],
    sampleRate: number,
    totalFrames: number,
    initialFrame = 0,
    initialHumFrequencies: number[][] = [],
    private readonly onHumChange?: (moduleId: string, frame: number, frequencies: number[]) => void,
    private readonly onWindChange?: (moduleId: string, frame: number, active: boolean) => void,
  ) {
    this.modules = modules;
    this.sampleRate = sampleRate;
    this.totalFrames = totalFrames;
    this.initialHumFrequencies = initialHumFrequencies;
    this.state = modules.map(() => ({
      filters: [],
      low: [],
      dcX: [],
      dcY: [],
      phase: 0,
      ambientBed: undefined,
      hum: undefined,
      wind: undefined,
    }));
    this.nextFrame = initialFrame;
  }

  reset(startFrame = 0) {
    this.state.forEach((state) => {
      state.filters = [];
      state.low = [];
      state.dcX = [];
      state.dcY = [];
      state.phase = (2 * Math.PI * 60 * startFrame) / this.sampleRate;
      state.ambientBed = undefined;
      state.hum = undefined;
      state.wind = undefined;
    });
    this.nextFrame = startFrame;
  }

  /** Current applied filters, not a measurement of the full recording. */
  trackedHumFrequencies(): Record<string, number[]> {
    return Object.fromEntries(this.modules.flatMap((module, index) =>
      module.enabled && module.type === 'hum' && module.params.mode !== 'Static' && Number(module.params.reduction) > 0
        ? [[module.id, this.state[index].hum?.confirmedFrequencies() ?? this.initialHumFrequencies[index] ?? []]]
        : []));
  }

  snapshot(): StreamingEditChainSnapshot {
    return {
      nextFrame: this.nextFrame,
      state: this.state.map((state) => ({
        filters: state.filters.map((filter) => ({ ...filter })),
        low: [...state.low],
        dcX: [...state.dcX],
        dcY: [...state.dcY],
        phase: state.phase,
        ambientBed: state.ambientBed ? [...state.ambientBed] : undefined,
        hum: state.hum?.snapshot(),
        wind: state.wind?.snapshot(),
      })),
    };
  }

  restore(snapshot: StreamingEditChainSnapshot) {
    snapshot.state.forEach((saved, index) => {
      const target = this.state[index];
      if (!target) return;
      target.filters = saved.filters.map((filter) => ({ ...filter }));
      target.low = [...saved.low];
      target.dcX = [...saved.dcX];
      target.dcY = [...saved.dcY];
      target.phase = saved.phase;
      target.ambientBed = saved.ambientBed ? [...saved.ambientBed] : undefined;
      target.hum = saved.hum
        ? new HumProcessor(this.modules[index].params, this.sampleRate, saved.hum.capture.length, [],
          (frame, frequencies) => this.onHumChange?.(this.modules[index].id, this.nextFrame + frame, frequencies))
        : undefined;
      if (saved.hum) target.hum?.restore(saved.hum);
      target.wind = saved.wind
        ? new WindProcessor(this.sampleRate, this.modules[index].type === 'wind' ? saved.wind.channels.length : 0,
          windLevel(this.modules[index].params.detection), windLevel(this.modules[index].params.removal),
          (frame, active) => this.onWindChange?.(this.modules[index].id, frame, active))
        : undefined;
      if (saved.wind) target.wind?.restore(saved.wind);
    });
    this.nextFrame = snapshot.nextFrame;
  }

  process(channels: Float32Array[], startFrame: number): Float32Array[] {
    if (startFrame !== this.nextFrame) this.reset(startFrame);
    const output = channels.map((channel) => new Float32Array(channel));
    const length = output[0]?.length ?? 0;
    const ensure = (state: ModuleState, count: number) => {
      while (state.filters.length < count) state.filters.push({ x1: 0, x2: 0, y1: 0, y2: 0 });
      while (state.low.length < count) state.low.push(0);
      while (state.dcX.length < count) state.dcX.push(0);
      while (state.dcY.length < count) state.dcY.push(0);
    };

    this.modules.forEach((module, moduleIndex) => {
      if (!module.enabled) return;
      const p = module.params;
      const state = this.state[moduleIndex];
      ensure(state, output.length);
      if (module.type === 'gain') {
        const amp = dbToAmp(Number(p.db) || 0);
        output.forEach((channel) => channel.forEach((sample, i) => { channel[i] = clamp(finite(sample * amp)); }));
      } else if (module.type === 'fade') {
        const fadeIn = Math.floor(Number(p.in) * this.sampleRate);
        const fadeOut = Math.floor(Number(p.out) * this.sampleRate);
        output.forEach((channel) => channel.forEach((sample, i) => {
          const frame = startFrame + i;
          let factor = 1;
          if (fadeIn > 0 && frame < fadeIn) factor *= frame / fadeIn;
          if (fadeOut > 0 && frame > this.totalFrames - fadeOut) {
            factor *= Math.max(0, (this.totalFrames - frame) / fadeOut);
          }
          channel[i] = finite(sample * factor);
        }));
      } else if (module.type === 'dc') {
        output.forEach((channel, c) => channel.forEach((sample, i) => {
          let value: number;
          if (p.mode === 'Auto') {
            // A leaky DC blocker, unlike a chunk mean, has continuous history.
            const x = finite(sample);
            const y = x - state.dcX[c] + AUTOMATIC_DC_BLOCKER_POLE * state.dcY[c];
            state.dcX[c] = x; state.dcY[c] = y; value = y;
          } else value = sample - (Number(p.amount) || 0) / 1000;
          channel[i] = clamp(finite(value));
        }));
      } else if (module.type === 'eq') {
        if (p.mode === 'low-shelf') {
          const coefficients = lowShelf(this.sampleRate, Math.max(20, Number(p.frequency) || 55),
            Math.max(0.1, Number(p.q) || 0.4), Number(p.gain) || 0);
          output.forEach((channel, c) => channel.forEach((sample, i) => {
            const f = state.filters[c];
            const value = coefficients.b0 * sample + coefficients.b1 * f.x1 + coefficients.b2 * f.x2
              - coefficients.a1 * f.y1 - coefficients.a2 * f.y2;
            f.x2 = f.x1; f.x1 = sample; f.y2 = f.y1; f.y1 = value;
            channel[i] = finite(value);
          }));
        } else {
          const low = dbToAmp(Number(p.low) || 0);
          const high = dbToAmp(Number(p.high) || 0);
          output.forEach((channel, c) => channel.forEach((sample, i) => {
            state.low[c] += (sample - state.low[c]) * .015;
            const highPart = sample - state.low[c];
            channel[i] = clamp(finite(state.low[c] * low + highPart * dbToAmp(Number(p.mid) || 0) * .72
              + highPart * high * .28));
          }));
        }
      } else if (module.type === 'hum') {
        state.hum ??= new HumProcessor(p, this.sampleRate, output.length, this.initialHumFrequencies[moduleIndex],
          (frame, frequencies) => this.onHumChange?.(module.id, this.nextFrame + frame, frequencies));
        state.hum.process(output);
      } else if (module.type === 'wind') {
        if (isFixedLowRumble(module)) {
          const coefficients = highPass(this.sampleRate, Math.max(20, Number(p.cutoff) || 55.5),
            Math.max(0.1, Number(p.q) || .38));
          output.forEach((channel, c) => channel.forEach((sample, i) => {
            const f = state.filters[c];
            const value = coefficients.b0 * sample + coefficients.b1 * f.x1 + coefficients.b2 * f.x2
              - coefficients.a1 * f.y1 - coefficients.a2 * f.y2;
            f.x2 = f.x1; f.x1 = sample; f.y2 = f.y1; f.y1 = value; channel[i] = finite(value);
          }));
        } else {
          state.wind ??= new WindProcessor(this.sampleRate, output.length, windLevel(p.detection), windLevel(p.removal),
            (frame, active) => this.onWindChange?.(module.id, frame, active), startFrame);
          state.wind.process(output);
        }
      } else if (module.type === 'region') {
        const start = Math.max(0, Math.floor(Math.max(0, Number(p.start)) * this.sampleRate));
        const end = Math.floor(Math.max(Number(p.end), Number(p.start)) * this.sampleRate);
        const factor = dbToAmp(Number(p.amount) || 0);
        output.forEach((channel) => channel.forEach((sample, i) => {
          const frame = startFrame + i;
          if (frame >= start && frame < end) channel[i] = finite(sample * factor);
        }));
      } else if (module.type === 'ambient') {
        const start = Math.floor(Math.max(0, Number(p.start)) * this.sampleRate);
        const end = start + Math.floor(Math.max(.1, Number(p.length)) * this.sampleRate);
        const blend = Math.min(.9, Math.max(.05, Number(p.length) / 4));
        output.forEach((channel, c) => channel.forEach((sample, i) => {
          const frame = startFrame + i;
          if (frame === start) {
            if (!state.ambientBed) state.ambientBed = [];
            state.ambientBed[c] = finite(sample);
          }
          if (frame >= start && frame < end) {
            const bed = state.ambientBed?.[c] ?? 0;
            channel[i] = finite(sample * (1 - blend) + bed * blend);
          }
        }));
      }
    });
    this.nextFrame = startFrame + length;
    return output;
  }
}

export const createStreamingEditChain = (
  modules: EditModule[], sampleRate: number, totalFrames: number, initialFrame = 0, initialHumFrequencies: number[][] = [],
  onHumChange?: (moduleId: string, frame: number, frequencies: number[]) => void,
  onWindChange?: (moduleId: string, frame: number, active: boolean) => void,
) => new StreamingEditChain(modules, sampleRate, totalFrames, initialFrame, initialHumFrequencies, onHumChange, onWindChange);

/** Reads at most two detector windows from a file; never decodes the whole take. */
export async function analyzeFileInitialHum(file: Blob, metadata: WavMetadata, modules: EditModule[], signal?: AbortSignal) {
  if (!modules.some((module) => module.enabled && module.type === 'hum' && module.params.mode !== 'Static')) return [];
  const frames = humPrefixFrames(metadata.sampleRate, metadata.frameCount);
  if (!frames) return [];
  const prefix = await readFrames(file, metadata, 0, frames, { signal });
  return analyzeInitialHum(prefix, modules, metadata.sampleRate, metadata.frameCount);
}