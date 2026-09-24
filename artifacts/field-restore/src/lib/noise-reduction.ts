/**
 * A conservative, causal multiband expander for steady broadband noise.
 * In automatic mode each band follows a slowly rising, quickly falling floor.
 * Sample mode uses a bounded profile measured from the original recording.
 * All channels use the same smoothed gain per band.
 * The bounded state makes preview, chunked export and restored loops agree.
 */
export interface NoiseReductionSnapshot {
  lows: number[][];
  envelope: number[];
  floor: number[];
  gain: number[];
  transientHold: number[];
  recent: number[][];
  position: number;
  frames: number;
  tonality: number;
}

const CROSSOVERS = [150, 360, 800, 1700, 3400, 6500, 11000];
const BANDS = CROSSOVERS.length + 1;
export const NOISE_PROFILE_BANDS = BANDS;
export const NOISE_SAMPLE_MIN_SECONDS = .2;
export const NOISE_SAMPLE_MAX_SECONDS = 5;
const PERIOD_LAGS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 36, 42, 48, 52, 56, 60, 64, 72, 80, 96, 104, 112, 128, 144, 160, 176, 192, 208, 224];

export function noiseProfileFromParams(params: Record<string, number | string>): number[] | undefined {
  if (params.mode !== 'Sample') return undefined;
  const profile = Array.from({ length: BANDS }, (_, i) => Number(params[`profile${i}`]));
  if (profile.some((value) => !Number.isFinite(value) || value < 0) ||
    !Number.isFinite(Number(params.sampleStart)) || !Number.isFinite(Number(params.sampleEnd)) ||
    Number(params.sampleEnd) - Number(params.sampleStart) < NOISE_SAMPLE_MIN_SECONDS - 1e-6 ||
    Number(params.sampleEnd) - Number(params.sampleStart) > NOISE_SAMPLE_MAX_SECONDS + 1e-6) {
    throw new Error('Noise-only sample settings are incomplete. Choose a new sample or switch to Automatic.');
  }
  return profile;
}

/** Mean absolute energy per crossover band, shared across channels. The brief lead-in
 * settles the crossover filters without retaining or serializing any source audio. */
export function measureNoiseProfile(channels: Float32Array[], sampleRate: number, leadFrames = 0): number[] {
  if (!channels.length || !channels[0]?.length || channels.some((channel) => channel.length !== channels[0].length)) {
    throw new Error('The noise-only sample could not be read.');
  }
  const coefficients = CROSSOVERS.map((frequency) =>
    1 - Math.exp(-2 * Math.PI * Math.min(frequency, sampleRate * .45) / sampleRate));
  const sums = new Float64Array(BANDS);
  const count = channels[0].length - leadFrames;
  if (count <= 0) throw new Error('Select a longer noise-only sample.');
  for (const channel of channels) {
    const lows = new Float64Array(CROSSOVERS.length);
    for (let frame = 0; frame < channel.length; frame++) {
      const sample = channel[frame];
      let previous = 0;
      for (let band = 0; band < CROSSOVERS.length; band++) {
        lows[band] += coefficients[band] * (sample - lows[band]);
        if (frame >= leadFrames) sums[band] += Math.abs(lows[band] - previous);
        previous = lows[band];
      }
      if (frame >= leadFrames) sums[BANDS - 1] += Math.abs(sample - previous);
    }
  }
  return Array.from(sums, (sum) => sum / (count * channels.length));
}

export class NoiseReductionProcessor {
  private readonly lows: Float64Array[];
  private readonly envelope = new Float64Array(BANDS);
  private readonly floor = new Float64Array(BANDS);
  private readonly gain = new Float64Array(BANDS).fill(1);
  private readonly transientHold = new Int32Array(BANDS);
  private readonly recent: Float64Array[];
  private position = 0;
  private frames = 0;
  private tonality = 0;
  private readonly coefficients: number[];
  private readonly envelopeAttack: number;
  private readonly envelopeRelease: number;
  private readonly floorRise: number;
  private readonly floorFall: number;
  private readonly gainSmooth: number;
  private readonly reduction: number;
  private readonly sampleProfile?: number[];
  private readonly transientFrames: number;

  constructor(sampleRate: number, channelCount: number, strength: number, sampleProfile?: number[]) {
    if (sampleProfile && (sampleProfile.length !== BANDS || sampleProfile.some((value) => !Number.isFinite(value) || value < 0))) {
      throw new Error('Invalid noise-only sample profile.');
    }
    this.sampleProfile = sampleProfile;
    this.lows = Array.from({ length: channelCount }, () => new Float64Array(CROSSOVERS.length));
    this.recent = Array.from({ length: channelCount }, () => new Float64Array(512));
    this.transientFrames = Math.ceil(sampleRate * .025);
    this.coefficients = CROSSOVERS.map((frequency) =>
      1 - Math.exp(-2 * Math.PI * Math.min(frequency, sampleRate * .45) / sampleRate));
    this.envelopeAttack = 1 - Math.exp(-1 / (sampleRate * .012));
    this.envelopeRelease = 1 - Math.exp(-1 / (sampleRate * .09));
    this.floorRise = 1 - Math.exp(-1 / (sampleRate * 2));
    this.floorFall = 1 - Math.exp(-1 / (sampleRate * .35));
    this.gainSmooth = 1 - Math.exp(-1 / (sampleRate * .06));
    this.reduction = .6 * Math.max(0, Math.min(100, Number.isFinite(strength) ? strength : 0)) / 100;
  }

  snapshot(): NoiseReductionSnapshot {
    return {
      lows: this.lows.map((low) => Array.from(low)),
      envelope: Array.from(this.envelope),
      floor: Array.from(this.floor),
      gain: Array.from(this.gain),
      transientHold: Array.from(this.transientHold),
      recent: this.recent.map((channel) => Array.from(channel)),
      position: this.position,
      frames: this.frames,
      tonality: this.tonality,
    };
  }

  restore(saved: NoiseReductionSnapshot) {
    this.lows.forEach((low, channel) => low.set(saved.lows[channel] ?? []));
    this.envelope.set(saved.envelope);
    this.floor.set(saved.floor);
    this.gain.set(saved.gain);
    this.transientHold.set(saved.transientHold);
    this.recent.forEach((channel, index) => channel.set(saved.recent[index] ?? []));
    this.position = saved.position;
    this.frames = saved.frames;
    this.tonality = saved.tonality;
  }

  private updateTonality(channels: Float32Array[], frame: number) {
    this.recent.forEach((recent, channel) => { recent[this.position] = channels[channel][frame]; });
    this.position = (this.position + 1) % 512;
    this.frames += 1;
    if (this.frames < this.recent.length || this.frames % 128 !== 0) return;
    let strongest = 0;
    for (const recent of this.recent) {
      for (const lag of PERIOD_LAGS) {
        let cross = 0;
        let firstPower = 0;
        let secondPower = 0;
        for (let index = 0; index < 128; index += 1) {
          const first = recent[(this.position - 1 - index + 512) % 512];
          const second = recent[(this.position - 1 - index - lag + 1024) % 512];
          cross += first * second;
          firstPower += first * first;
          secondPower += second * second;
        }
        if (firstPower > 1e-8 && secondPower > 1e-8) {
          strongest = Math.max(strongest, cross / Math.sqrt(firstPower * secondPower));
        }
      }
    }
    const target = Math.max(0, Math.min(1, (strongest - .45) / .27));
    this.tonality += .4 * (target - this.tonality);
  }

  process(channels: Float32Array[]) {
    if (!channels.length || this.reduction === 0) return;
    const bands = channels.map(() => new Float64Array(BANDS));
    const activity = new Float64Array(BANDS);
    const length = channels[0].length;
    for (let frame = 0; frame < length; frame += 1) {
      this.updateTonality(channels, frame);
      activity.fill(0);
      for (let channel = 0; channel < channels.length; channel += 1) {
        const sample = channels[channel][frame];
        const lows = this.lows[channel];
        const parts = bands[channel];
        let previous = 0;
        for (let band = 0; band < CROSSOVERS.length; band += 1) {
          lows[band] += this.coefficients[band] * (sample - lows[band]);
          parts[band] = lows[band] - previous;
          previous = lows[band];
          activity[band] += Math.abs(parts[band]);
        }
        parts[BANDS - 1] = sample - previous;
        activity[BANDS - 1] += Math.abs(parts[BANDS - 1]);
      }

      for (let band = 0; band < BANDS; band += 1) {
        const level = activity[band] / channels.length;
        const envelope = this.envelope[band];
        // Recover gain immediately for the onset of a short wanted sound.
        if (level > .003 && level > envelope * 3 && level > this.floor[band] * 3) {
          this.transientHold[band] = this.transientFrames;
        }
        const next = envelope + (level > envelope ? this.envelopeAttack : this.envelopeRelease) * (level - envelope);
        this.envelope[band] = next;
        this.floor[band] += (next > this.floor[band] ? this.floorRise : this.floorFall) * (next - this.floor[band]);
      }
      // Periodicity indicates a likely wanted note or call even when mixed with hiss.
      // Broad-band concentration is not useful here: its ratio changes with sample rate.
      const tonalProtection = 1 - .88 * this.tonality;
      for (let band = 0; band < BANDS; band += 1) {
        if (this.transientHold[band] > 0) {
          this.transientHold[band] -= 1;
          this.gain[band] = 1;
          continue;
        }
        const noiseShare = Math.min(1, (this.sampleProfile?.[band] ?? this.floor[band]) / (this.envelope[band] + 1e-8));
        const target = 1 - this.reduction * tonalProtection * noiseShare;
        this.gain[band] += this.gainSmooth * (target - this.gain[band]);
      }
      for (let channel = 0; channel < channels.length; channel += 1) {
        let sample = 0;
        for (let band = 0; band < BANDS; band += 1) sample += bands[channel][band] * this.gain[band];
        channels[channel][frame] = Math.max(-1, Math.min(1, sample));
      }
    }
  }
}