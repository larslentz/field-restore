import type { ChannelData } from './audio';

export interface ClickPopSnapshot {
  seen: number;
  lastRaw: number[];
  previousRaw: number[];
  lastEstimate: number[];
  previousEstimate: number[];
  typicalJump: number[];
  age: number[];
  correction: number[];
}

/**
 * Causal, bounded repair for isolated discontinuities. It cannot distinguish
 * every intentional sharp impact from a defect, so it only reacts to jumps
 * that are both unusually large and much sharper than the recent signal.
 */
export class ClickPopProcessor {
  private state: ClickPopSnapshot;
  private readonly strength: number;
  private readonly maxAge: number;
  private readonly decay: number;
  private readonly warmupFrames: number;

  constructor(params: Record<string, number | string>, sampleRate: number, channels: number) {
    const requested = Number(params.strength ?? 75);
    this.strength = Number.isFinite(requested) ? Math.max(0, Math.min(1, requested / 100)) : 0;
    this.maxAge = Math.max(8, Math.ceil(sampleRate * .016));
    this.decay = Math.exp(-1 / Math.max(1, sampleRate * .001));
    this.warmupFrames = Math.max(4, Math.ceil(sampleRate * .001));
    this.state = {
      seen: 0,
      lastRaw: Array(channels).fill(0),
      previousRaw: Array(channels).fill(0),
      lastEstimate: Array(channels).fill(0),
      previousEstimate: Array(channels).fill(0),
      typicalJump: Array(channels).fill(0),
      age: Array(channels).fill(0),
      correction: Array(channels).fill(0),
    };
  }

  snapshot(): ClickPopSnapshot {
    return {
      seen: this.state.seen,
      lastRaw: [...this.state.lastRaw],
      previousRaw: [...this.state.previousRaw],
      lastEstimate: [...this.state.lastEstimate],
      previousEstimate: [...this.state.previousEstimate],
      typicalJump: [...this.state.typicalJump],
      age: [...this.state.age],
      correction: [...this.state.correction],
    };
  }

  restore(saved: ClickPopSnapshot) {
    this.state = {
      seen: saved.seen,
      lastRaw: [...saved.lastRaw],
      previousRaw: [...saved.previousRaw],
      lastEstimate: [...saved.lastEstimate],
      previousEstimate: [...saved.previousEstimate],
      typicalJump: [...saved.typicalJump],
      age: [...saved.age],
      correction: [...saved.correction],
    };
  }

  process(channels: ChannelData) {
    if (!channels.length || this.strength === 0) return;
    const state = this.state;
    for (let frame = 0; frame < channels[0].length; frame++) {
      for (let channel = 0; channel < channels.length; channel++) {
        const raw = channels[channel][frame];
        if (state.seen === 0 && channels[channel].length >= 3) {
          const next = channels[channel][1];
          const following = channels[channel][2];
          const prediction = 2 * next - following;
          const firstThreshold = Math.max(.008, 9 * Math.abs(following - next));
          const initialClick = Math.abs(raw - prediction) > firstThreshold;
          const first = initialClick ? prediction : raw;
          state.lastRaw[channel] = raw;
          state.lastEstimate[channel] = first;
          state.previousEstimate[channel] = first;
          state.typicalJump[channel] = Math.abs(following - next);
          channels[channel][frame] = raw + (first - raw) * this.strength;
          continue;
        }
        const previous = state.lastRaw[channel];
        const jump = Math.abs(raw - previous);
        const threshold = Math.max(.008, 9 * state.typicalJump[channel]);
        const curvature = Math.abs(raw - 2 * previous + state.previousRaw[channel]);
        const estimate = state.lastEstimate[channel] +
          Math.max(-.02, Math.min(.02, state.lastEstimate[channel] - state.previousEstimate[channel])) * .985;
        if (!state.age[channel] && state.seen >= this.warmupFrames &&
          jump > threshold && curvature > threshold && Math.abs(raw - estimate) > threshold) {
          state.age[channel] = 1;
          state.correction[channel] = raw - estimate;
        }
        let value = raw;
        let cleanEstimate = raw;
        if (state.age[channel]) {
          const age = state.age[channel];
          if (age > 1) state.correction[channel] *= this.decay;
          const residual = raw - estimate;
          if (age > 1 && (Math.sign(residual) !== Math.sign(state.correction[channel]) ||
            Math.abs(residual) < threshold * .25)) {
            state.age[channel] = 0;
          } else {
            const correction = Math.sign(state.correction[channel]) *
              Math.min(Math.abs(state.correction[channel]), Math.abs(residual));
            value = raw - correction * this.strength;
            cleanEstimate = estimate;
            state.age[channel] = age >= this.maxAge || Math.abs(state.correction[channel]) < .0005 ? 0 : age + 1;
          }
        }
        // Keep the detector's floor independent of anomalies and the wet mix.
        if (!state.age[channel] && value === raw) {
          state.typicalJump[channel] += .006 * (Math.min(jump, threshold) - state.typicalJump[channel]);
        }
        state.previousRaw[channel] = previous;
        state.lastRaw[channel] = raw;
        state.previousEstimate[channel] = state.lastEstimate[channel];
        state.lastEstimate[channel] = cleanEstimate;
        channels[channel][frame] = Number.isFinite(value) ? value : 0;
      }
      state.seen++;
    }
  }
}