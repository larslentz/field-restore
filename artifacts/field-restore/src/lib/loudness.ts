export interface LoudnessStats {
  truePeakDbtp: number;
  integratedLufs: number;
  loudnessRangeLu: number;
  maxShortTermLufs: number;
}

interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

const SILENCE_LUFS = -Infinity;
const LUFS_OFFSET = -0.691;

function shelvingCoefficients(sampleRate: number): BiquadCoefficients {
  const frequency = 1681.974450955533;
  const gain = 3.999843853973347;
  const quality = 0.7071752369554196;
  const k = Math.tan(Math.PI * frequency / sampleRate);
  const vh = 10 ** (gain / 20);
  const vb = vh ** 0.4996667741545416;
  const denominator = 1 + k / quality + k * k;
  return {
    b0: (vh + vb * k / quality + k * k) / denominator,
    b1: 2 * (k * k - vh) / denominator,
    b2: (vh - vb * k / quality + k * k) / denominator,
    a1: 2 * (k * k - 1) / denominator,
    a2: (1 - k / quality + k * k) / denominator,
  };
}

function highPassCoefficients(sampleRate: number): BiquadCoefficients {
  const frequency = 38.13547087602444;
  const quality = 0.5003270373238773;
  const k = Math.tan(Math.PI * frequency / sampleRate);
  const denominator = 1 + k / quality + k * k;
  return {
    b0: 1 / denominator,
    b1: -2 / denominator,
    b2: 1 / denominator,
    a1: 2 * (k * k - 1) / denominator,
    a2: (1 - k / quality + k * k) / denominator,
  };
}

function processBiquad(sample: number, coefficients: BiquadCoefficients, state: BiquadState) {
  const output = coefficients.b0 * sample
    + coefficients.b1 * state.x1
    + coefficients.b2 * state.x2
    - coefficients.a1 * state.y1
    - coefficients.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = sample;
  state.y2 = state.y1;
  state.y1 = output;
  return output;
}

function emptyState(): BiquadState {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

function energyToLufs(energy: number) {
  return energy > 0 ? LUFS_OFFSET + 10 * Math.log10(energy) : SILENCE_LUFS;
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(sortedValues: number[], percentileValue: number) {
  if (!sortedValues.length) return SILENCE_LUFS;
  const index = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function gatedIntegratedLoudness(blockEnergies: number[]) {
  const absoluteGated = blockEnergies.filter((energy) => energyToLufs(energy) >= -70);
  if (!absoluteGated.length) return SILENCE_LUFS;
  const preliminary = energyToLufs(mean(absoluteGated));
  const relativeGated = absoluteGated.filter((energy) => energyToLufs(energy) >= preliminary - 10);
  return energyToLufs(mean(relativeGated));
}

function estimateTruePeak(channels: Float32Array[], from: number, to: number) {
  let peak = 0;
  for (const channel of channels) {
    for (let index = from; index < to; index += 1) {
      const a = channel[Math.max(from, index - 1)] ?? 0;
      const b = channel[index] ?? 0;
      const c = channel[Math.min(to - 1, index + 1)] ?? b;
      const d = channel[Math.min(to - 1, index + 2)] ?? c;
      for (let phase = 0; phase < 4; phase += 1) {
        const t = phase / 4;
        const t2 = t * t;
        const t3 = t2 * t;
        const interpolated = 0.5 * (
          2 * b
          + (-a + c) * t
          + (2 * a - 5 * b + 4 * c - d) * t2
          + (-a + 3 * b - 3 * c + d) * t3
        );
        peak = Math.max(peak, Math.abs(interpolated));
      }
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

export function analyzeLoudness(
  channels: Float32Array[],
  sampleRate: number,
  start = 0,
  end = channels[0]?.length ?? 0,
): LoudnessStats {
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(channels[0]?.length ?? 0, Math.max(from + 1, Math.floor(end)));
  const frameCount = Math.max(1, to - from);
  const momentaryWindow = Math.max(1, Math.round(sampleRate * 0.4));
  const momentaryHop = Math.max(1, Math.round(sampleRate * 0.1));
  const shortTermWindow = Math.max(1, Math.round(sampleRate * 3));
  const shortTermHop = Math.max(1, Math.round(sampleRate));
  const ring = new Float64Array(shortTermWindow);
  const shelf = shelvingCoefficients(sampleRate);
  const highPass = highPassCoefficients(sampleRate);
  const shelfStates = channels.map(() => emptyState());
  const highPassStates = channels.map(() => emptyState());
  const momentaryEnergies: number[] = [];
  const shortTermEnergies: number[] = [];
  let momentarySum = 0;
  let shortTermSum = 0;

  for (let offset = 0; offset < frameCount; offset += 1) {
    let frameEnergy = 0;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const input = channels[channelIndex][from + offset] ?? 0;
      const shelved = processBiquad(input, shelf, shelfStates[channelIndex]);
      const weighted = processBiquad(shelved, highPass, highPassStates[channelIndex]);
      frameEnergy += weighted * weighted;
    }

    const ringIndex = offset % shortTermWindow;
    const outgoingShort = offset >= shortTermWindow ? ring[ringIndex] : 0;
    const outgoingMomentary = offset >= momentaryWindow
      ? ring[(offset - momentaryWindow) % shortTermWindow]
      : 0;
    shortTermSum += frameEnergy - outgoingShort;
    momentarySum += frameEnergy - outgoingMomentary;
    ring[ringIndex] = frameEnergy;

    if (offset + 1 >= momentaryWindow && (offset + 1 - momentaryWindow) % momentaryHop === 0) {
      momentaryEnergies.push(momentarySum / momentaryWindow);
    }
    if (offset + 1 >= shortTermWindow && (offset + 1 - shortTermWindow) % shortTermHop === 0) {
      shortTermEnergies.push(shortTermSum / shortTermWindow);
    }
  }

  if (!momentaryEnergies.length) momentaryEnergies.push(momentarySum / frameCount);
  const integratedLufs = gatedIntegratedLoudness(momentaryEnergies);
  const shortTermLoudness = shortTermEnergies.map(energyToLufs).filter(Number.isFinite);
  // Tech 3342 gates LRA against the absolute-gated *short-term* mean, not the
  // separately computed, -10 LU relative-gated programme loudness.
  const absoluteGatedShort = shortTermEnergies.filter((energy) => energyToLufs(energy) >= -70);
  const shortTermMean = absoluteGatedShort.length ? energyToLufs(mean(absoluteGatedShort)) : SILENCE_LUFS;
  const lraGate = Math.max(-70, shortTermMean - 20);
  const gatedShortTerm = shortTermLoudness.filter((value) => value >= lraGate).sort((a, b) => a - b);
  const loudnessRangeLu = gatedShortTerm.length > 1
    ? Math.max(0, percentile(gatedShortTerm, 0.95) - percentile(gatedShortTerm, 0.1))
    : NaN;

  return {
    truePeakDbtp: estimateTruePeak(channels, from, to),
    integratedLufs,
    loudnessRangeLu,
    maxShortTermLufs: shortTermLoudness.length ? Math.max(...shortTermLoudness) : energyToLufs(shortTermSum / frameCount),
  };
}