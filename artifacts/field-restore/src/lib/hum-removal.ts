/**
 * Bounded, stereo-linked hum detector and narrow-band remover.
 * Only persistent spectral peaks are eligible. Adaptive treats even isolated
 * sustained wanted tones as hum; attenuation is limited by the reduction knob.
 */
type Filter = { x1: number; x2: number; y1: number; y2: number };
type Notch = { frequency: number; b0: number; b1: number; b2: number; a1: number; a2: number; history: Filter[] };

export function humAnalysisWindowSize(sampleRate: number) {
  return Math.min(65536, 2 ** Math.ceil(Math.log2(Math.max(4096, sampleRate * .25))));
}

/** Two complete windows are required to confirm a persistent tone. */
export function humPrefixFrames(sampleRate: number, totalFrames: number) {
  return Math.min(totalFrames, 2 * humAnalysisWindowSize(sampleRate));
}

export interface HumSnapshot {
  collected: number;
  capture: number[][];
  pending: number[];
  notches: Notch[];
  transition: { notches: Notch[]; remaining: number } | undefined;
}

function copyNotches(filters: Notch[]): Notch[] {
  return filters.map((filter) => ({ ...filter, history: filter.history.map((history) => ({ ...history })) }));
}

function notch(frequency: number, sampleRate: number, channels: number): Notch {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cosine = Math.cos(omega);
  // A very high Q near Nyquist takes too long to settle to the advertised
  // reduction; cap it while keeping the notch narrow relative to frequency.
  const alpha = Math.sin(omega) / (2 * Math.min(500, Math.max(12, frequency / 4)));
  const a0 = 1 + alpha;
  return {
    frequency, b0: 1 / a0, b1: -2 * cosine / a0, b2: 1 / a0,
    a1: -2 * cosine / a0, a2: (1 - alpha) / a0,
    history: Array.from({ length: channels }, () => ({ x1: 0, x2: 0, y1: 0, y2: 0 })),
  };
}

function spectrum(samples: number[]): Float64Array {
  const size = samples.length;
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let i = 0; i < size; i++) real[i] = samples[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
    }
  }
  for (let width = 2; width <= size; width *= 2) {
    const half = width / 2;
    for (let k = 0; k < half; k++) {
      const angle = -2 * Math.PI * k / width;
      const wr = Math.cos(angle);
      const wi = Math.sin(angle);
      for (let start = 0; start < size; start += width) {
        const right = start + k + half;
        const tr = wr * real[right] - wi * imaginary[right];
        const ti = wr * imaginary[right] + wi * real[right];
        real[right] = real[start + k] - tr;
        imaginary[right] = imaginary[start + k] - ti;
        real[start + k] += tr;
        imaginary[start + k] += ti;
      }
    }
  }
  const power = new Float64Array(size / 2);
  for (let k = 0; k < power.length; k++) power[k] = real[k] ** 2 + imaginary[k] ** 2;
  return power;
}

function findTones(capture: number[][], sampleRate: number, mode: string, target: number): number[] {
  const size = capture[0].length;
  const power = new Float64Array(size / 2);
  let energy = 0;
  for (const channel of capture) {
    const spectrumPower = spectrum(channel);
    for (let k = 0; k < power.length; k++) power[k] += spectrumPower[k];
    for (const sample of channel) energy += sample * sample;
  }
  const rms = Math.sqrt(energy / (size * capture.length));
  const binWidth = sampleRate / size;
  const lower = mode === 'Dynamic' ? Math.max(35, target * .88) : 20;
  const upper = mode === 'Dynamic' ? Math.min(1200, target * 1.12) : Math.min(20000, sampleRate / 2);
  const peaks: Array<{ frequency: number; score: number }> = [];
  const measurePeak = (k: number, minimumAmplitude: number) => {
    if (k < 4 || k >= power.length - 9) return null;
    if (power[k] <= power[k - 1] || power[k] < power[k + 1]) return null;
    const surroundings = [-8, -7, -6, -5, 5, 6, 7, 8]
      .map((offset) => power[k + offset])
      .filter((value) => value !== undefined)
      .sort((a, b) => a - b);
    const floor = surroundings[Math.floor(surroundings.length / 2)] + 1e-18;
    const amplitude = 4 * Math.sqrt(power[k] / capture.length) / size;
    if (power[k] / floor < 70 || amplitude < minimumAmplitude) return null;
    // A Hann window's logarithmic parabolic peak gives sub-bin frequency estimates.
    const left = Math.log(power[k - 1] + 1e-18);
    const center = Math.log(power[k] + 1e-18);
    const right = Math.log(power[k + 1] + 1e-18);
    const offset = Math.max(-.5, Math.min(.5, .5 * (left - right) / (left - 2 * center + right || 1)));
    return { frequency: (k + offset) * binWidth, score: amplitude * Math.min(1000, power[k] / floor) };
  };
  // Search neighboring bins too: interpolation can place a true boundary
  // frequency inside the requested range when its peak bin is just outside.
  for (let k = Math.max(4, Math.floor(lower / binWidth) - 1); k <= Math.min(power.length - 11, Math.ceil(upper / binWidth) + 1); k++) {
    const peak = measurePeak(k, mode === 'Adaptive' ? Math.max(.0008, rms * .025) : Math.max(.0015, rms * .08));
    if (peak && peak.frequency >= lower - .1 && peak.frequency <= upper + .1) peaks.push(peak);
  }
  peaks.sort((a, b) => b.score - a.score);
  if (mode === 'Adaptive') {
    // Persistence across two windows, checked by the caller, rejects short or
    // moving peaks. No mains, harmonic-family, or two-fundamental restriction.
    return peaks.filter((peak, index) => !peaks.slice(0, index).some((other) =>
      Math.abs(peak.frequency - other.frequency) < Math.max(5, binWidth * 2),
    )).map((peak) => peak.frequency).sort((a, b) => a - b);
  }
  const fundamentals = peaks.filter((peak, index) => !peaks.slice(0, index).some((other) =>
    Math.abs(peak.frequency - other.frequency) < Math.max(5, binWidth * 2) ||
    Math.abs(peak.frequency / other.frequency - Math.round(peak.frequency / other.frequency)) < .025,
  )).map((peak) => peak.frequency);
  const tones: number[] = [];
  let accepted = 0;
  for (const fundamental of fundamentals) {
    const harmonics: number[] = [];
    for (let harmonic = 2; harmonic <= 4 && harmonic * fundamental <= Math.min(1200, sampleRate * .45); harmonic++) {
      const targetBin = Math.round(harmonic * fundamental / binWidth);
      let candidate: { frequency: number; score: number } | null = null;
      for (let k = targetBin - 2; k <= targetBin + 2; k++) {
        const peak = measurePeak(k, Math.max(.0015, rms * .04));
        if (peak && (!candidate || peak.score > candidate.score)) candidate = peak;
      }
      if (candidate && Math.abs(candidate.frequency - harmonic * fundamental) <= Math.max(2, binWidth * .5) &&
        !tones.some((frequency) => Math.abs(frequency - candidate.frequency) < 3)) harmonics.push(candidate.frequency);
    }
    tones.push(fundamental, ...harmonics);
    if (++accepted === 1) break;
  }
  return tones.sort((a, b) => a - b);
}

export class HumProcessor {
  private readonly size: number;
  private readonly sampleRate: number;
  private readonly mode: string;
  private readonly target: number;
  private readonly mix: number;
  private state: HumSnapshot;

  constructor(
    params: Record<string, number | string>, sampleRate: number, channels: number,
    initialFrequencies: number[] = [], private readonly onChange?: (frame: number, frequencies: number[]) => void,
  ) {
    this.sampleRate = sampleRate;
    this.mode = params.mode === 'Adaptive' || params.mode === 'Dynamic' ? String(params.mode) : 'Static';
    this.target = Math.max(40, Math.min(1200, Number(params.frequency) || 60));
    this.mix = 1 - 10 ** (-Math.max(0, Math.min(24, Number(params.reduction) || 0)) / 20);
    this.size = humAnalysisWindowSize(sampleRate);
    this.state = {
      collected: 0,
      capture: Array.from({ length: channels }, () => new Array<number>(this.size).fill(0)),
      pending: [...initialFrequencies],
      notches: this.makeNotches(this.mode === 'Static' ? [this.target] : initialFrequencies, channels),
      transition: undefined,
    };
  }

  confirmedFrequencies(): number[] {
    return this.state.notches.map((filter) => filter.frequency);
  }

  private makeNotches(fundamentals: number[], channels: number): Notch[] {
    const frequencies = (this.mode === 'Static' ? fundamentals.flatMap((frequency) =>
      Array.from({ length: Math.min(4, Math.floor(Math.min(1200, this.sampleRate * .45) / frequency)) }, (_, harmonic) => frequency * (harmonic + 1)),
    ) : fundamentals).filter((frequency, index, all) => !all.slice(0, index).some((previous) => Math.abs(previous - frequency) < 3));
    return frequencies.map((frequency) => notch(frequency, this.sampleRate, channels));
  }

  snapshot(): HumSnapshot {
    return {
      collected: this.state.collected,
      capture: this.state.capture.map((channel) => [...channel]),
      pending: [...this.state.pending],
      notches: copyNotches(this.state.notches),
      transition: this.state.transition ? {
        notches: copyNotches(this.state.transition.notches),
        remaining: this.state.transition.remaining,
      } : undefined,
    };
  }

  restore(saved: HumSnapshot) {
    this.state = {
      collected: saved.collected,
      capture: saved.capture.map((channel) => [...channel]),
      pending: [...saved.pending],
      notches: copyNotches(saved.notches),
      transition: saved.transition ? {
        notches: copyNotches(saved.transition.notches),
        remaining: saved.transition.remaining,
      } : undefined,
    };
  }

  private filterSample(input: number, channel: number, filters: Notch[]) {
    let value = input;
    for (const filter of filters) {
      const history = filter.history[channel];
      const wet = filter.b0 * value + filter.b1 * history.x1 + filter.b2 * history.x2
        - filter.a1 * history.y1 - filter.a2 * history.y2;
      history.x2 = history.x1; history.x1 = value;
      history.y2 = history.y1; history.y1 = wet;
      value += (wet - value) * this.mix;
    }
    return value;
  }

  process(channels: Float32Array[]) {
    if (!channels.length || this.mix === 0) return;
    const length = channels[0].length;
    for (let frame = 0; frame < length; frame++) {
      for (let channel = 0; channel < channels.length; channel++) {
        const input = channels[channel][frame];
        if (this.mode !== 'Static') this.state.capture[channel][this.state.collected] = input;
        let value = this.filterSample(input, channel, this.state.notches);
        if (this.state.transition) {
          const old = this.filterSample(input, channel, this.state.transition.notches);
          const fadeFrames = Math.max(64, Math.floor(this.sampleRate * .012));
          const blend = 1 - this.state.transition.remaining / fadeFrames;
          value = old * (1 - blend) + value * blend;
        }
        channels[channel][frame] = Number.isFinite(value) ? value : 0;
      }
      if (this.state.transition && --this.state.transition.remaining <= 0) this.state.transition = undefined;
      if (this.mode === 'Static' || ++this.state.collected < this.size) continue;
      const detected = findTones(this.state.capture, this.sampleRate, this.mode, this.target);
      const tolerance = this.mode === 'Adaptive'
        ? Math.max(.5, Math.min(1, .22 * this.sampleRate / this.size))
        : Math.max(2, this.sampleRate / this.size);
      const stable = detected.filter((frequency) => this.state.pending.some((previous) => Math.abs(previous - frequency) < tolerance));
      const next = stable.length ? this.makeNotches(stable, channels.length) : [];
      if (next.length !== this.state.notches.length ||
        next.some((filter, index) => Math.abs(filter.frequency - this.state.notches[index].frequency) > 1)) {
        this.state.transition = { notches: this.state.notches, remaining: Math.max(64, Math.floor(this.sampleRate * .012)) };
        this.state.notches = next;
        this.onChange?.(frame + 1, this.confirmedFrequencies());
      }
      this.state.pending = detected;
      this.state.collected = 0;
    }
  }
}