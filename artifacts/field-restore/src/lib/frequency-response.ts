import { highPass, lowShelf, type EditModule } from './edit-chain';

function biquadResponseDb(coefficients: ReturnType<typeof highPass>, sampleRate: number, frequency: number): number {
  const angle = 2 * Math.PI * frequency / sampleRate;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cos2 = Math.cos(2 * angle);
  const sin2 = Math.sin(2 * angle);
  const numeratorReal = coefficients.b0 + coefficients.b1 * cos + coefficients.b2 * cos2;
  const numeratorImag = -coefficients.b1 * sin - coefficients.b2 * sin2;
  const denominatorReal = 1 + coefficients.a1 * cos + coefficients.a2 * cos2;
  const denominatorImag = -coefficients.a1 * sin - coefficients.a2 * sin2;
  const numerator = Math.hypot(numeratorReal, numeratorImag);
  const denominator = Math.hypot(denominatorReal, denominatorImag);
  return 20 * Math.log10(Math.max(1e-8, numerator / denominator));
}

/** The linear, steady-state response of an individual edit (before output clipping). */
export function moduleFrequencyResponseDb(module: EditModule, sampleRate: number, frequency: number): number {
  const p = module.params;
  if (module.type === 'wind') {
    return biquadResponseDb(
      highPass(sampleRate, Math.max(20, Number(p.cutoff) || 100), Math.max(0.1, Number(p.q) || 0.7)),
      sampleRate, frequency,
    );
  }
  if (module.type !== 'eq') return 0;
  if (p.mode === 'low-shelf') {
    return biquadResponseDb(
      lowShelf(sampleRate, Math.max(20, Number(p.frequency) || 55), Math.max(0.1, Number(p.q) || 0.4), Number(p.gain) || 0),
      sampleRate, frequency,
    );
  }
  // Mirrors the three-band processor: a one-pole low pass, with the residual
  // shared between the mid (72%) and high (28%) gains.
  const angle = 2 * Math.PI * frequency / sampleRate;
  const alpha = 0.015;
  const denominatorReal = 1 - (1 - alpha) * Math.cos(angle);
  const denominatorImag = (1 - alpha) * Math.sin(angle);
  const denominatorSquared = denominatorReal ** 2 + denominatorImag ** 2;
  const lowReal = alpha * denominatorReal / denominatorSquared;
  const lowImag = -alpha * denominatorImag / denominatorSquared;
  const lowGain = 10 ** ((Number(p.low) || 0) / 20);
  const upperGain = 0.72 * 10 ** ((Number(p.mid) || 0) / 20) + 0.28 * 10 ** ((Number(p.high) || 0) / 20);
  return 20 * Math.log10(Math.max(1e-8, Math.hypot(
    upperGain + (lowGain - upperGain) * lowReal,
    (lowGain - upperGain) * lowImag,
  )));
}