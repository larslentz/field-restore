export type ChannelData = Float32Array[];

export interface AudioSource {
  channels: ChannelData;
  sampleRate: number;
  duration: number;
  name: string;
}

export function createDemoAudio(sampleRate = 48000, duration = 18): AudioSource {
  const length = Math.floor(sampleRate * duration);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  let seed = 404;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const bird = Math.sin(2 * Math.PI * (1400 + Math.sin(t * .7) * 180) * t) * Math.max(0, Math.sin(t * 2.1 - 1.3)) ** 10 * .14;
    const low = Math.sin(2 * Math.PI * 82 * t) * .018 + Math.sin(2 * Math.PI * 124 * t) * .01;
    const texture = (random() * 2 - 1) * .017;
    const bed = Math.sin(2 * Math.PI * 220 * t) * .038 + Math.sin(2 * Math.PI * 327 * t) * .018;
    const transient = Math.exp(-((t - 7.8) ** 2) / .004) * .24;
    left[i] = bed + low + texture + bird + transient;
    right[i] = bed * .94 + low * .8 + texture * .88 + bird * .92 + transient * .96;
  }
  return { channels: [left, right], sampleRate, duration, name: 'coastal-dawn_demo.wav' };
}

function readAscii(view: DataView, offset: number, length: number) {
  return Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join('');
}

export function parseWav(buffer: ArrayBuffer, name = 'recording.wav'): AudioSource {
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('This file does not contain a RIFF/WAVE header.');
  }
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 1;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      audioFormat = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = Math.min(size, view.byteLength - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!channels || !sampleRate || dataOffset < 0 || ![8, 16, 24, 32].includes(bitsPerSample)) {
    throw new Error('Unsupported WAV layout. Use PCM 8/16/24/32-bit WAV.');
  }
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error('Compressed WAV formats are not supported for local editing.');
  }
  const bytesPerSample = bitsPerSample / 8;
  const frameSize = channels * bytesPerSample;
  const frameCount = Math.floor(dataLength / frameSize);
  const result = Array.from({ length: channels }, () => new Float32Array(frameCount));
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const position = dataOffset + frame * frameSize + channel * bytesPerSample;
      let sample = 0;
      if (audioFormat === 3 && bitsPerSample === 32) sample = view.getFloat32(position, true);
      else if (bitsPerSample === 8) sample = (view.getUint8(position) - 128) / 128;
      else if (bitsPerSample === 16) sample = view.getInt16(position, true) / 32768;
      else if (bitsPerSample === 24) {
        const value = view.getInt8(position) | (view.getUint8(position + 1) << 8) | (view.getUint8(position + 2) << 16);
        sample = (value / 8388608);
      } else sample = view.getInt32(position, true) / 2147483648;
      result[channel][frame] = Math.max(-1, Math.min(1, sample));
    }
  }
  return { channels: result, sampleRate, duration: frameCount / sampleRate, name };
}

export function encodeWav(source: AudioSource, format: 'archival' | 'listening' = 'archival') {
  const channels = source.channels.length;
  const sourceLength = source.channels[0]?.length ?? 0;
  const bitDepth = format === 'archival' ? 24 : 16;
  const bytesPerSample = bitDepth / 8;
  const dataLength = sourceLength * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const put = (offset: number, text: string) => text.split('').forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  put(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true); put(8, 'WAVE'); put(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, source.sampleRate, true); view.setUint32(28, source.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, bitDepth, true); put(36, 'data'); view.setUint32(40, dataLength, true);
  let offset = 44;
  for (let i = 0; i < sourceLength; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.max(-1, Math.min(1, source.channels[channel][i] ?? 0));
      if (bitDepth === 16) view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
      else {
        const integer = Math.round(value < 0 ? value * 8388608 : value * 8388607);
        view.setUint8(offset, integer & 255); view.setUint8(offset + 1, (integer >> 8) & 255); view.setUint8(offset + 2, (integer >> 16) & 255);
      }
      offset += bytesPerSample;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function cloneChannels(channels: ChannelData): ChannelData {
  return channels.map((channel) => new Float32Array(channel));
}

export function sliceChannels(channels: ChannelData, start: number, end: number): ChannelData {
  return channels.map((channel) => channel.slice(start, end));
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}