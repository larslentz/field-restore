import type { ChannelData } from './audio';
import { automaticDcBlockerPole, analyzeInitialHum, fadeGainAtFrame, isFixedLowRumble, lowEndShelfCoefficients, lowEndShelfEnabled, lowEndShelfFollowsWind, type EditModule } from './edit-chain';
import { WindProcessor, windLevel, type WindSnapshot } from './wind-reduction';
import { HumProcessor, humPrefixFrames, type HumSnapshot } from './hum-removal';
import { NoiseReductionProcessor, noiseProfileFromParams, type NoiseReductionSnapshot } from './noise-reduction';
import { ClickPopProcessor, type ClickPopSnapshot } from './click-pop-removal';
import { readAudioFrames, type AudioMetadata } from './source-audio';

export interface SpectralRepairPatch {
  startFrame: number;
  channels: Float32Array[];
}
export type SpectralRepairPatches = Record<string, SpectralRepairPatch>;

interface FilterState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

interface ModuleState {
  filters: FilterState[];
  shelfFilters: FilterState[];
  low: number[];
  dcX: number[];
  dcY: number[];
  phase: number;
  ambientBed: number[] | undefined;
  hum: HumProcessor | undefined;
  wind: WindProcessor | undefined;
  noise: NoiseReductionProcessor | undefined;
  clickPop: ClickPopProcessor | undefined;
}

export interface StreamingEditChainSnapshot {
  nextFrame: number;
  state: Array<Omit<ModuleState, 'hum' | 'wind' | 'noise' | 'clickPop'> & {
    hum: HumSnapshot | undefined; wind: WindSnapshot | undefined;
    noise: NoiseReductionSnapshot | undefined; clickPop: ClickPopSnapshot | undefined;
  }>;
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
  private readonly dcPole: number;
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
    private readonly onClickRepair?: (moduleId: string, frame: number) => void,
    private readonly spectralPatches: SpectralRepairPatches = {},
  ) {
    this.modules = modules;
    this.sampleRate = sampleRate;
    this.dcPole = automaticDcBlockerPole(sampleRate);
    this.totalFrames = totalFrames;
    this.initialHumFrequencies = initialHumFrequencies;
    this.state = modules.map(() => ({
      filters: [],
      shelfFilters: [],
      low: [],
      dcX: [],
      dcY: [],
      phase: 0,
      ambientBed: undefined,
      hum: undefined,
      wind: undefined,
      noise: undefined,
      clickPop: undefined,
    }));
    this.nextFrame = initialFrame;
  }

  reset(startFrame = 0) {
    this.state.forEach((state) => {
      state.filters = [];
      state.shelfFilters = [];
      state.low = [];
      state.dcX = [];
      state.dcY = [];
      state.phase = (2 * Math.PI * 60 * startFrame) / this.sampleRate;
      state.ambientBed = undefined;
      state.hum = undefined;
      state.wind = undefined;
      state.noise = undefined;
      state.clickPop = undefined;
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
        shelfFilters: state.shelfFilters.map((filter) => ({ ...filter })),
        low: [...state.low],
        dcX: [...state.dcX],
        dcY: [...state.dcY],
        phase: state.phase,
        ambientBed: state.ambientBed ? [...state.ambientBed] : undefined,
        hum: state.hum?.snapshot(),
        wind: state.wind?.snapshot(),
        noise: state.noise?.snapshot(),
        clickPop: state.clickPop?.snapshot(),
      })),
    };
  }

  restore(snapshot: StreamingEditChainSnapshot) {
    snapshot.state.forEach((saved, index) => {
      const target = this.state[index];
      if (!target) return;
      target.filters = saved.filters.map((filter) => ({ ...filter }));
      target.shelfFilters = saved.shelfFilters.map((filter) => ({ ...filter }));
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
      target.noise = saved.noise
        ? new NoiseReductionProcessor(this.sampleRate, saved.noise.lows.length, Number(this.modules[index].params.strength),
          noiseProfileFromParams(this.modules[index].params))
        : undefined;
      if (saved.noise) target.noise?.restore(saved.noise);
      target.clickPop = saved.clickPop
        ? new ClickPopProcessor(this.modules[index].params, this.sampleRate, saved.clickPop.lastRaw.length,
          (frame) => this.onClickRepair?.(this.modules[index].id, frame))
        : undefined;
      if (saved.clickPop) target.clickPop?.restore(saved.clickPop);
    });
    this.nextFrame = snapshot.nextFrame;
  }

  process(channels: Float32Array[], startFrame: number): Float32Array[] {
    if (startFrame !== this.nextFrame) this.reset(startFrame);
    const output = channels.map((channel) => new Float32Array(channel));
    const length = output[0]?.length ?? 0;
    const ensure = (state: ModuleState, count: number) => {
      while (state.filters.length < count) state.filters.push({ x1: 0, x2: 0, y1: 0, y2: 0 });
      while (state.shelfFilters.length < count) state.shelfFilters.push({ x1: 0, x2: 0, y1: 0, y2: 0 });
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
        output.forEach((channel) => channel.forEach((sample, i) => {
          channel[i] = finite(sample * fadeGainAtFrame(p, startFrame + i, this.sampleRate, this.totalFrames));
        }));
      } else if (module.type === 'dc') {
        output.forEach((channel, c) => channel.forEach((sample, i) => {
          let value: number;
          if (p.mode === 'Auto') {
            // A leaky DC blocker, unlike a chunk mean, has continuous history.
            const x = finite(sample);
            const y = x - state.dcX[c] + this.dcPole * state.dcY[c];
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
        const followsWind = !isFixedLowRumble(module) && lowEndShelfEnabled(p) && lowEndShelfFollowsWind(p);
        const shelf = followsWind ? lowEndShelfCoefficients(p, this.sampleRate) : undefined;
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
          state.wind.process(output, followsWind ? (frame, amount) => {
            for (let c = 0; c < output.length; c++) {
              const channel = output[c];
              const filter = state.shelfFilters[c];
              const sample = channel[frame];
              const filtered = shelf!.b0 * sample + shelf!.b1 * filter.x1 + shelf!.b2 * filter.x2
                - shelf!.a1 * filter.y1 - shelf!.a2 * filter.y2;
              filter.x2 = filter.x1; filter.x1 = sample; filter.y2 = filter.y1; filter.y1 = filtered;
              channel[frame] = finite(sample + amount * (filtered - sample));
            }
          } : undefined);
        }
        if (lowEndShelfEnabled(p) && !followsWind) {
          const coefficients = lowEndShelfCoefficients(p, this.sampleRate);
          output.forEach((channel, c) => channel.forEach((sample, i) => {
            const f = state.shelfFilters[c];
            const value = coefficients.b0 * sample + coefficients.b1 * f.x1 + coefficients.b2 * f.x2
              - coefficients.a1 * f.y1 - coefficients.a2 * f.y2;
            f.x2 = f.x1; f.x1 = sample; f.y2 = f.y1; f.y1 = value;
            channel[i] = finite(value);
          }));
        }
      } else if (module.type === 'noise') {
        state.noise ??= new NoiseReductionProcessor(this.sampleRate, output.length, Number(p.strength), noiseProfileFromParams(p));
        state.noise.process(output);
      } else if (module.type === 'click-pop') {
        state.clickPop ??= new ClickPopProcessor(p, this.sampleRate, output.length,
          (frame) => this.onClickRepair?.(module.id, frame));
        state.clickPop.process(output, startFrame);
      } else if (module.type === 'spectral-repair') {
        const first = Math.max(0, Math.floor(Number(p.start) * this.sampleRate));
        const last = Math.min(this.totalFrames, Math.ceil(Number(p.end) * this.sampleRate));
        if (startFrame < last && startFrame + length > first && Number(p.strength) > 0) {
          const patch = this.spectralPatches[module.id];
          if (!patch) throw new Error(`Spectral Repair "${module.name}" is not prepared for file-backed processing.`);
          const from = Math.max(startFrame, first);
          const until = Math.min(startFrame + length, last);
          if (from < patch.startFrame || until > patch.startFrame + (patch.channels[0]?.length ?? 0) ||
            patch.channels.length !== output.length) {
            throw new Error('Prepared Spectral Repair does not cover this audio range.');
          }
          output.forEach((channel, index) => channel.set(
            patch.channels[index].subarray(from - patch.startFrame, until - patch.startFrame),
            from - startFrame,
          ));
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
  onClickRepair?: (moduleId: string, frame: number) => void,
  spectralPatches: SpectralRepairPatches = {},
) => new StreamingEditChain(modules, sampleRate, totalFrames, initialFrame, initialHumFrequencies, onHumChange, onWindChange, onClickRepair, spectralPatches);

/** Reads at most two detector windows from a file; never decodes the whole take. */
export async function analyzeFileInitialHum(file: Blob, metadata: AudioMetadata, modules: EditModule[], signal?: AbortSignal) {
  if (!modules.some((module) => module.enabled && module.type === 'hum' && module.params.mode !== 'Static')) return [];
  const frames = humPrefixFrames(metadata.sampleRate, metadata.frameCount);
  if (!frames) return [];
  const prefix = await readAudioFrames(file, metadata, 0, frames, { signal });
  return analyzeInitialHum(prefix, modules, metadata.sampleRate, metadata.frameCount);
}