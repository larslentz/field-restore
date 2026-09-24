import type { ChannelData } from './audio';

export type WindLevel = 'Low' | 'Medium' | 'High';
export const WIND_DEFAULTS = { detection: 'Medium', removal: 'Medium' } as const;

export function windLevel(value: unknown): WindLevel {
  return value === 'Low' || value === 'High' ? value : 'Medium';
}

interface ChannelState {
  slow: number; low: number; upper: number; wide: number;
  x1: number; x2: number; y1: number; y2: number;
  bandEnergy: number;
  lastCrossing: number;
  previousPositive: boolean;
  crossingCount: number;
  crossingSum: number;
  crossingSquares: number;
}

export interface WindSnapshot {
  channels: ChannelState[];
  lowEnergy: number;
  upperEnergy: number;
  midEnergy: number;
  count: number;
  frame: number;
  target: number;
  wet: number;
  active: boolean;
}

const newChannel = (): ChannelState => ({
  slow: 0, low: 0, upper: 0, wide: 0, x1: 0, x2: 0, y1: 0, y2: 0,
  bandEnergy: 0, lastCrossing: -1, previousPositive: false,
  crossingCount: 0, crossingSum: 0, crossingSquares: 0,
});

/** Bounded, causal detector and stereo-linked, crossfaded high-pass. */
export class WindProcessor {
  private state: WindSnapshot;
  private readonly window: number;
  private readonly slowAlpha: number;
  private readonly lowAlpha: number;
  private readonly upperAlpha: number;
  private readonly wideAlpha: number;
  private readonly attack: number;
  private readonly release: number;
  private readonly coefficients: { b0: number; b1: number; b2: number; a1: number; a2: number };

  constructor(private readonly sampleRate: number, private readonly channelCount: number,
    private readonly detection: WindLevel, private readonly removal: WindLevel,
    private readonly onChange?: (frame: number, active: boolean) => void, initialFrame = 0) {
    this.window = Math.max(512, Math.round(sampleRate * .1));
    const pole = (hz: number) => 1 - Math.exp(-2 * Math.PI * hz / sampleRate);
    this.slowAlpha = pole(18);
    this.lowAlpha = pole(75);
    this.upperAlpha = pole(180);
    this.wideAlpha = pole(1100);
    this.attack = 1 - Math.exp(-1 / (.025 * sampleRate));
    this.release = 1 - Math.exp(-1 / (.18 * sampleRate));
    const omega = 2 * Math.PI * Math.min(140, sampleRate * .2) / sampleRate;
    const cos = Math.cos(omega);
    const alpha = Math.sin(omega) / (2 * .707);
    const a0 = 1 + alpha;
    this.coefficients = {
      b0: (1 + cos) / (2 * a0), b1: -(1 + cos) / a0, b2: (1 + cos) / (2 * a0),
      a1: -2 * cos / a0, a2: (1 - alpha) / a0,
    };
    this.state = this.empty(initialFrame);
  }

  private empty(frame: number): WindSnapshot {
    return {
      channels: Array.from({ length: this.channelCount }, newChannel),
      lowEnergy: 0, upperEnergy: 0, midEnergy: 0, count: 0,
      frame, target: 0, wet: 0, active: false,
    };
  }

  reset(frame = 0) { this.state = this.empty(frame); }
  snapshot(): WindSnapshot { return structuredClone(this.state); }
  restore(snapshot: WindSnapshot) { this.state = structuredClone(snapshot); }
  isActive() { return this.state.active; }

  process(channels: ChannelData) {
    const s = this.state;
    const { b0, b1, b2, a1, a2 } = this.coefficients;
    const maxWet = this.removal === 'Low' ? .38 : this.removal === 'High' ? .96 : .72;
    const threshold = this.detection === 'Low' ? 1.8 : this.detection === 'High' ? .7 : 1;
    const floor = this.detection === 'Low' ? .005 : this.detection === 'High' ? .0015 : .003;
    for (let i = 0; i < (channels[0]?.length ?? 0); i++) {
      let lowEnergy = 0; let upperEnergy = 0; let midEnergy = 0;
      for (let c = 0; c < channels.length; c++) {
        const f = s.channels[c];
        const sample = channels[c][i];
        f.slow += this.slowAlpha * (sample - f.slow);
        f.low += this.lowAlpha * (sample - f.low);
        f.upper += this.upperAlpha * (sample - f.upper);
        f.wide += this.wideAlpha * (sample - f.wide);
        const bass = f.low - f.slow;
        const upper = f.upper - f.low;
        const mid = f.wide - f.upper;
        lowEnergy += bass * bass;
        upperEnergy += upper * upper;
        midEnergy += mid * mid;
        f.bandEnergy += bass * bass + upper * upper;
        const positive = f.upper - f.slow >= 0;
        if (positive && !f.previousPositive) {
          if (f.lastCrossing >= 0) {
            const interval = s.frame - f.lastCrossing;
            if (interval > 0) {
              f.crossingCount++;
              f.crossingSum += interval;
              f.crossingSquares += interval * interval;
            }
          }
          f.lastCrossing = s.frame;
        }
        f.previousPositive = positive;
      }
      s.lowEnergy += lowEnergy / channels.length;
      s.upperEnergy += upperEnergy / channels.length;
      s.midEnergy += midEnergy / channels.length;
      s.count++;
      s.frame++;
      if (s.count >= this.window) {
        const low = Math.sqrt(s.lowEnergy / s.count);
        const upper = Math.sqrt(s.upperEnergy / s.count);
        const mid = Math.sqrt(s.midEnergy / s.count);
        const strongest = s.channels.reduce((selected, channel) =>
          channel.bandEnergy > selected.bandEnergy ? channel : selected, s.channels[0]);
        const mean = strongest.crossingSum / Math.max(1, strongest.crossingCount);
        const variation = Math.sqrt(Math.max(0, strongest.crossingSquares / Math.max(1, strongest.crossingCount) - mean * mean)) / Math.max(1, mean);
        const tonal = strongest.crossingCount >= 4 && variation < .2;
        const detected = !tonal && low + upper > Math.max(floor, mid * threshold)
          && Math.min(low, upper) > Math.max(floor * .12, Math.max(low, upper) * .12);
        s.target = detected ? maxWet : 0;
        if (detected !== s.active) {
          s.active = detected;
          this.onChange?.(s.frame, detected);
        }
        s.lowEnergy = 0; s.upperEnergy = 0; s.midEnergy = 0; s.count = 0;
        for (const f of s.channels) {
          f.bandEnergy = 0; f.crossingCount = 0; f.crossingSum = 0;
          f.crossingSquares = 0; f.lastCrossing = -1;
        }
      }
      s.wet += (s.target - s.wet) * (s.target > s.wet ? this.attack : this.release);
      for (let c = 0; c < channels.length; c++) {
        const f = s.channels[c];
        const sample = channels[c][i];
        const filtered = b0 * sample + b1 * f.x1 + b2 * f.x2 - a1 * f.y1 - a2 * f.y2;
        f.x2 = f.x1; f.x1 = sample; f.y2 = f.y1; f.y1 = filtered;
        channels[c][i] = sample + s.wet * (filtered - sample);
      }
    }
  }
}