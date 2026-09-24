import { fingerprintWav, parseWavMetadata, readFrames, type WavMetadata } from './large-wav';
import { parseFlacMetadata, readFlacFrames, type FlacMetadata } from './flac';

export type AudioMetadata = WavMetadata | FlacMetadata;

export async function parseAudioMetadata(file: Blob, options: { signal?: AbortSignal; name?: string } = {}): Promise<AudioMetadata> {
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const magic = String.fromCharCode(...signature);
  const name = (options.name ?? (file instanceof File ? file.name : undefined))?.toLowerCase();
  if (magic === 'fLaC') {
    if (name?.endsWith('.wav')) throw new Error('The file is FLAC audio, not a WAV file.');
    return parseFlacMetadata(file, options);
  }
  if (name?.endsWith('.flac')) throw new Error('The file does not contain FLAC audio.');
  return parseWavMetadata(file, options);
}

export async function fingerprintAudio(file: Blob, metadata: AudioMetadata, signal?: AbortSignal): Promise<string> {
  if (metadata.format !== 'FLAC') return fingerprintWav(file, metadata, signal);
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const sampleSize = 64 * 1024;
  const starts = [0, Math.max(0, Math.floor(file.size / 2) - sampleSize / 2), Math.max(0, file.size - sampleSize)];
  const samples = await Promise.all(starts.map((start) => file.slice(start, start + sampleSize).arrayBuffer()));
  const descriptor = new TextEncoder().encode(JSON.stringify({
    size: file.size, format: metadata.format, channels: metadata.channels, sampleRate: metadata.sampleRate,
    bitsPerSample: metadata.bitsPerSample, frameCount: metadata.frameCount, dataOffset: metadata.dataOffset,
  }));
  const bytes = new Uint8Array(descriptor.length + samples.reduce((sum, sample) => sum + sample.byteLength, 0));
  bytes.set(descriptor);
  let offset = descriptor.length;
  for (const sample of samples) { bytes.set(new Uint8Array(sample), offset); offset += sample.byteLength; }
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function audioRange(metadata: AudioMetadata, startFrame: number, frameCount: number): AudioMetadata {
  if (metadata.format === 'FLAC') return { ...metadata, frameStart: (metadata.frameStart ?? 0) + startFrame, frameCount };
  const dataLength = frameCount * metadata.frameSize;
  return { ...metadata, dataOffset: metadata.dataOffset + startFrame * metadata.frameSize,
    frameCount, dataLength, dataLengthBigInt: BigInt(dataLength) };
}

export async function readAudioFrames(
  file: Blob, metadata: AudioMetadata, startFrame: number, frameCount: number,
  options: { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void } = {},
): Promise<Float32Array[]> {
  if (metadata.format !== 'FLAC') return readFrames(file, metadata, startFrame, frameCount, options);
  const channels = await readFlacFrames(file, metadata, startFrame, frameCount, options);
  options.onProgress?.(channels[0]?.length ?? 0, frameCount);
  return channels;
}