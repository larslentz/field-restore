import { cloneChannels, type ChannelData } from './audio';

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

export const makeDefaultChain = (): EditModule[] => [
  makeModule('gain', { name: 'Gain', params: { db: 0 } }),
  makeModule('dc', { name: 'DC Offset Removal', params: { mode: 'Auto', amount: 0 } }),
  makeModule('wind', { name: 'Low Rumble Removal', params: { cutoff: 55.5, q: 0.38 } }),
  makeModule('hum', { name: 'Hum Removal', params: { mode: 'Adaptive', frequency: 60, reduction: 12 } }),
  makeModule('eq', { name: 'Bring Back the Low End', params: { mode: 'low-shelf', frequency: 55, q: 0.4, gain: 3 } }),
  makeModule('fade', { name: 'Fade In', params: { in: 0.25, out: 0 } }),
  makeModule('fade', { name: 'Fade Out', params: { in: 0, out: 0.25 } }),
];

const dbToAmp = (db: number) => 10 ** (db / 20);

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

function averageAt(channels: ChannelData, index: number) {
  return channels.reduce((sum, channel) => sum + (channel[index] ?? 0), 0) / Math.max(1, channels.length);
}

export function applyModule(input: ChannelData, module: EditModule, sampleRate: number): ChannelData {
  const output = cloneChannels(input);
  if (!module.enabled) return output;
  const length = output[0]?.length ?? 0;
  const p = module.params;
  if (module.type === 'gain') {
    const amp = dbToAmp(Number(p.db) || 0);
    output.forEach((channel) => channel.forEach((sample, i) => { channel[i] = Math.max(-1, Math.min(1, sample * amp)); }));
  } else if (module.type === 'fade') {
    const fadeIn = Math.floor(Number(p.in) * sampleRate);
    const fadeOut = Math.floor(Number(p.out) * sampleRate);
    output.forEach((channel) => channel.forEach((sample, i) => {
      let factor = 1;
      if (fadeIn > 0 && i < fadeIn) factor *= i / fadeIn;
      if (fadeOut > 0 && i > length - fadeOut) factor *= Math.max(0, (length - i) / fadeOut);
      channel[i] = sample * factor;
    }));
  } else if (module.type === 'dc') {
    output.forEach((channel) => {
      const amount = p.mode === 'Auto'
        ? channel.reduce((sum, sample) => sum + sample, 0) / Math.max(1, channel.length)
        : Number(p.amount) / 1000;
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
    const frequency = Math.max(20, Number(p.frequency) || 60);
    const reduction = dbToAmp(-(Number(p.reduction) || 0));
    output.forEach((channel) => {
      let phase = 0;
      channel.forEach((sample, i) => {
        phase += (2 * Math.PI * frequency) / sampleRate;
        const hum = Math.sin(phase) * sample * .16;
        channel[i] = sample - hum * (1 - reduction);
      });
    });
  } else if (module.type === 'wind') {
    const cutoff = Math.max(20, Number(p.cutoff) || 100);
    const q = Math.max(0.1, Number(p.q) || 0.7);
    const coefficients = highPass(sampleRate, cutoff, q);
    output.forEach((channel) => processBiquad(channel, coefficients));
  } else if (module.type === 'region') {
    const start = Math.floor(Math.max(0, Number(p.start)) * sampleRate);
    const end = Math.min(length, Math.floor(Math.max(Number(p.end), Number(p.start)) * sampleRate));
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

export function renderChain(original: ChannelData, modules: EditModule[], sampleRate: number) {
  return modules.reduce((audio, module) => applyModule(audio, module, sampleRate), cloneChannels(original));
}