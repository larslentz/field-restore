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
export const makeModule = (type: ModuleType): EditModule => {
  const defaults: Record<ModuleType, Record<string, number | string>> = {
    gain: { db: -2 }, fade: { in: 0, out: 0 }, eq: { low: 0, mid: 0, high: -1 }, dc: { amount: 0 },
    hum: { mode: 'Static', frequency: 60, reduction: 12 }, wind: { cutoff: 100, reduction: 4 },
    region: { start: 0, end: 0, amount: -8 }, ambient: { start: 0, end: 0, length: 1 },
  };
  return { id: `${type}-${Date.now()}-${idCounter++}`, type, name: MODULE_LABELS[type], enabled: true, params: { ...defaults[type] } };
};

const dbToAmp = (db: number) => 10 ** (db / 20);

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
    const amount = Number(p.amount) / 1000;
    output.forEach((channel) => channel.forEach((sample, i) => { channel[i] = Math.max(-1, Math.min(1, sample - amount)); }));
  } else if (module.type === 'eq') {
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
    const alpha = Math.min(.3, (2 * Math.PI * cutoff) / sampleRate);
    const reduction = Math.min(.95, Math.max(0, Number(p.reduction) / 20));
    output.forEach((channel) => {
      let filtered = 0;
      channel.forEach((sample, i) => { filtered += (sample - filtered) * alpha; channel[i] = sample - filtered * reduction; });
    });
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