import { readFrames, type WavMetadata } from './large-wav';
import type { LoudnessStats } from './loudness';

export interface LargeAnalysisProgress {
  completed: number;
  total: number;
  fraction: number;
}

export interface LargeAnalysisOptions {
  signal?: AbortSignal;
  chunkFrames?: number;
  onProgress?: (progress: LargeAnalysisProgress) => void;
  /** Cooperatively pause between bounded chunks without retaining file audio. */
  checkpoint?: () => void | Promise<void>;
  /** Apply the current edit chain to a chunk before it is analysed. */
  transform?: (channels: Float32Array[], startFrame: number) => Float32Array[] | Promise<Float32Array[]>;
}

export interface LargeAnalysisResult extends LoudnessStats {
  progress: LargeAnalysisProgress;
}

interface Coefficients { b0: number; b1: number; b2: number; a1: number; a2: number }
interface State { x1: number; x2: number; y1: number; y2: number }
const OFFSET = -0.691;
const SILENCE = -Infinity;

function abort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
}
function state(): State { return { x1: 0, x2: 0, y1: 0, y2: 0 }; }
function shelf(rate: number): Coefficients {
  const k = Math.tan(Math.PI * 1681.974450955533 / rate);
  const vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416;
  const d = 1 + k / 0.7071752369554196 + k * k;
  return { b0: (vh + vb * k / 0.7071752369554196 + k * k) / d, b1: 2 * (k * k - vh) / d,
    b2: (vh - vb * k / 0.7071752369554196 + k * k) / d, a1: 2 * (k * k - 1) / d,
    a2: (1 - k / 0.7071752369554196 + k * k) / d };
}
function highPass(rate: number): Coefficients {
  const k = Math.tan(Math.PI * 38.13547087602444 / rate);
  const q = 0.5003270373238773; const d = 1 + k / q + k * k;
  return { b0: 1 / d, b1: -2 / d, b2: 1 / d, a1: 2 * (k * k - 1) / d, a2: (1 - k / q + k * k) / d };
}
function biquad(x: number, c: Coefficients, s: State) {
  const y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
  s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y; return y;
}
function lufs(energy: number) { return energy > 0 ? OFFSET + 10 * Math.log10(energy) : SILENCE; }
function energy(db: number) { return 10 ** ((db - OFFSET) / 10); }
function bin(db: number) { return Math.max(0, Math.min(560, Math.floor((db + 120) * 4))); }
function histogramPercentile(bins: Uint32Array, minimumDb: number, percentile: number) {
  let count = 0;
  for (let i = 0; i < bins.length; i += 1) if (-120 + i / 4 >= minimumDb) count += bins[i];
  if (!count) return SILENCE;
  const position = (count - 1) * percentile;
  const valueAtRank = (rank: number) => {
    let cumulative = 0;
    for (let i = 0; i < bins.length; i += 1) {
      if (-120 + i / 4 < minimumDb) continue;
      cumulative += bins[i];
      if (cumulative > rank) return -120 + i / 4;
    }
    return SILENCE;
  };
  const lowerRank = Math.floor(position);
  const upperRank = Math.ceil(position);
  const lower = valueAtRank(lowerRank);
  const upper = valueAtRank(upperRank);
  return lower * (1 - (position - lowerRank)) + upper * (position - lowerRank);
}

/**
 * Analyse a WAV without materialising it. The two histograms retain enough
 * information for the EBU-style absolute/relative gates while using a fixed
 * amount of memory regardless of file length.
 */
export async function analyzeLargeLoudness(
  file: Blob, metadata: WavMetadata, options: LargeAnalysisOptions = {},
): Promise<LargeAnalysisResult> {
  const total = metadata.frameCount;
  const chunkSize = Math.max(256, Math.floor(options.chunkFrames ?? 16384));
  const rate = metadata.sampleRate;
  const momentaryWindow = Math.max(1, Math.round(rate * 0.4));
  const momentaryHop = Math.max(1, Math.round(rate * 0.1));
  const shortWindow = Math.max(1, Math.round(rate * 3));
  const shortHop = Math.max(1, rate);
  const rolling = new Float64Array(shortWindow);
  const momentaryBins = new Uint32Array(561);
  const momentaryEnergy = new Float64Array(561);
  const shortBins = new Uint32Array(561);
  const shelfFilter = shelf(rate); const highFilter = highPass(rate);
  const shelfStates = Array.from({ length: metadata.channels }, state);
  const highStates = Array.from({ length: metadata.channels }, state);
  let shortSum = 0; let momentarySum = 0; let frame = 0; let peak = 0;
  let previous: number[][] = Array.from({ length: metadata.channels }, () => []);

  const addMomentary = (value: number) => {
    const db = lufs(value); if (!Number.isFinite(db) || db < -120) return;
    const i = bin(db); momentaryBins[i] += 1; momentaryEnergy[i] += value;
  };
  const addShort = (value: number) => {
    const db = lufs(value); if (!Number.isFinite(db) || db < -120) return;
    shortBins[bin(db)] += 1;
  };
  const truePeak = (a: number, b: number, c: number, d: number) => {
    for (let phase = 0; phase < 4; phase += 1) {
      const t = phase / 4; const t2 = t * t; const t3 = t2 * t;
      peak = Math.max(peak, Math.abs(0.5 * (2 * b + (-a + c) * t
        + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)));
    }
  };

  while (frame < total) {
    abort(options.signal);
    await options.checkpoint?.();
    abort(options.signal);
    const start = frame;
    let channels = await readFrames(file, metadata, start, Math.min(chunkSize, total - start), { signal: options.signal });
    if (options.transform) channels = await options.transform(channels, start);
    const count = Math.min(channels[0]?.length ?? 0, total - start);
    for (let i = 0; i < count; i += 1) {
      abort(options.signal);
      let frameEnergy = 0;
      for (let c = 0; c < metadata.channels; c += 1) {
        const sample = channels[c]?.[i] ?? 0;
        const filtered = biquad(biquad(sample, shelfFilter, shelfStates[c]), highFilter, highStates[c]);
        frameEnergy += filtered * filtered;
        const p = previous[c]; p.push(sample);
        if (p.length >= 4) { truePeak(p[p.length - 4], p[p.length - 3], p[p.length - 2], p[p.length - 1]); p.shift(); }
      }
      const ringIndex = frame % shortWindow;
      const oldShort = frame >= shortWindow ? rolling[ringIndex] : 0;
      const oldMoment = frame >= momentaryWindow ? rolling[(frame - momentaryWindow) % shortWindow] : 0;
      shortSum += frameEnergy - oldShort; momentarySum += frameEnergy - oldMoment; rolling[ringIndex] = frameEnergy;
      if (frame + 1 >= momentaryWindow && (frame + 1 - momentaryWindow) % momentaryHop === 0) addMomentary(momentarySum / momentaryWindow);
      if (frame + 1 >= shortWindow && (frame + 1 - shortWindow) % shortHop === 0) addShort(shortSum / shortWindow);
      frame += 1;
    }
    if (count === 0) break;
    const progress = { completed: frame, total, fraction: total ? frame / total : 1 };
    options.onProgress?.(progress);
  }
  // Flush the interpolation tail with duplicated edge samples.
  for (const p of previous) if (p.length >= 2) truePeak(p[0], p[0], p[1], p[1]);
  if (!momentaryBins.some(Boolean)) addMomentary(momentarySum / Math.max(1, frame));
  if (!shortBins.some(Boolean)) addShort(shortSum / Math.max(1, frame));

  let absoluteCount = 0; let absoluteEnergy = 0;
  for (let i = 0; i < momentaryBins.length; i += 1) if (-120 + i / 4 >= -70) {
    absoluteCount += momentaryBins[i]; absoluteEnergy += momentaryEnergy[i];
  }
  const preliminary = absoluteCount ? lufs(absoluteEnergy / absoluteCount) : SILENCE;
  const gate = Number.isFinite(preliminary) ? preliminary - 10 : -70;
  let gatedCount = 0; let gatedEnergy = 0;
  for (let i = 0; i < momentaryBins.length; i += 1) if (-120 + i / 4 >= Math.max(-70, gate)) {
    gatedCount += momentaryBins[i]; gatedEnergy += momentaryEnergy[i];
  }
  const integratedLufs = gatedCount ? lufs(gatedEnergy / gatedCount) : SILENCE;
  const lraGate = Number.isFinite(integratedLufs) ? integratedLufs - 20 : -70;
  let maxShort = SILENCE; let shortCount = 0;
  for (let i = 0; i < shortBins.length; i += 1) if (shortBins[i]) {
    const db = -120 + i / 4;
    maxShort = Math.max(maxShort, db);
    if (db >= -70 && db >= lraGate) shortCount += shortBins[i];
  }
  const percentileGate = Math.max(-70, lraGate);
  const low = histogramPercentile(shortBins, percentileGate, 0.1);
  const high = histogramPercentile(shortBins, percentileGate, 0.95);
  const result: LargeAnalysisResult = { truePeakDbtp: peak ? 20 * Math.log10(peak) : SILENCE, integratedLufs,
    loudnessRangeLu: shortCount > 1 && Number.isFinite(low) && Number.isFinite(high) ? Math.max(0, high - low) : 0, maxShortTermLufs: maxShort,
    progress: { completed: frame, total, fraction: total ? frame / total : 1 } };
  options.onProgress?.(result.progress);
  return result;
}

export const analyzeLargeWav = analyzeLargeLoudness;