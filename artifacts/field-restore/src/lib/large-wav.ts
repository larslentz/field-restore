/** File-backed WAV helpers. These functions deliberately only read the slices
 * needed for a header or a requested range of samples. */

export interface WavMetadata {
  format: 'RIFF' | 'RF64';
  audioFormat: 1 | 3;
  channels: number;
  sampleRate: number;
  bitsPerSample: 8 | 16 | 24 | 32;
  frameSize: number;
  frameCount: number;
  dataOffset: number;
  dataLength: number;
  /** Present for RF64 files, including values too large for a JS safe number. */
  dataLengthBigInt?: bigint;
  name?: string;
}

export interface WavProgress {
  (completed: number, total: number): void;
}

interface BeforeUnloadTarget {
  addEventListener(type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void): void;
  removeEventListener(type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void): void;
}

/** Warn while an operation can leave a partially written large export behind. */
export async function withLargeExportLeaveWarning<T>(
  operation: () => Promise<T>,
  target: BeforeUnloadTarget = window,
): Promise<T> {
  const warnBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = '';
  };
  target.addEventListener('beforeunload', warnBeforeUnload);
  try {
    return await operation();
  } finally {
    target.removeEventListener('beforeunload', warnBeforeUnload);
  }
}

function id(view: DataView, at: number) {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}
function checkedNumber(value: bigint, label: string) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the JavaScript safe integer range.`);
  return Number(value);
}
function abort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
}
async function bytes(file: Blob, start: number, end: number, signal?: AbortSignal) {
  abort(signal);
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Parse only the container and chunks necessary to locate fmt and data. */
export async function parseWavMetadata(file: Blob, options: { signal?: AbortSignal; name?: string } = {}): Promise<WavMetadata> {
  if (file.size < 12) throw new Error('The file is too small to be a WAV file.');
  const first = new DataView(await bytes(file, 0, 12, options.signal).then((x) => x.buffer));
  const format = id(first, 0);
  if ((format !== 'RIFF' && format !== 'RF64') || id(first, 8) !== 'WAVE') throw new Error('This file does not contain a RIFF/WAVE header.');
  let offset = 12;
  let riffSize: bigint | undefined;
  let dataSize: bigint | undefined;
  let channels = 0; let sampleRate = 0; let bits = 0; let audioFormat = 0;
  let dataOffset = -1;
  while (offset + 8 <= file.size) {
    abort(options.signal);
    const head = new DataView((await bytes(file, offset, offset + 8, options.signal)).buffer);
    const chunk = id(head, 0);
    const rawSize = BigInt(head.getUint32(4, true));
    if (chunk === 'ds64' && format === 'RF64') {
      const length = checkedNumber(rawSize, 'ds64 chunk size');
      const ds = new DataView((await bytes(file, offset + 8, offset + 8 + Math.min(length, 40), options.signal)).buffer);
      if (ds.byteLength >= 24) {
        riffSize = ds.getBigUint64(0, true);
        dataSize = ds.getBigUint64(8, true);
      }
    } else if (chunk === 'fmt ') {
      const f = new DataView((await bytes(file, offset + 8, offset + 8 + Math.min(40, checkedNumber(rawSize, 'fmt chunk size')), options.signal)).buffer);
      if (f.byteLength >= 16) {
        audioFormat = f.getUint16(0, true); channels = f.getUint16(2, true);
        sampleRate = f.getUint32(4, true); bits = f.getUint16(14, true);
      }
    } else if (chunk === 'data') {
      dataOffset = offset + 8;
      const size = format === 'RF64' && rawSize === 0xffffffffn ? dataSize : rawSize;
      if (size === undefined) throw new Error('RF64 data chunk is missing its ds64 size.');
      dataSize = size;
      break;
    }
    const advance = checkedNumber(rawSize, 'WAV chunk size') + 8 + (Number(rawSize & 1n));
    if (advance <= 8) throw new Error('Invalid WAV chunk size.');
    offset += advance;
  }
  if (audioFormat !== 1 && audioFormat !== 3) throw new Error('Compressed WAV formats are not supported.');
  if (!channels || !sampleRate || dataOffset < 0 || ![8, 16, 24, 32].includes(bits as number)) throw new Error('Unsupported WAV layout. Use PCM 8/16/24/32-bit or IEEE float32 WAV.');
  if (audioFormat === 3 && bits !== 32) throw new Error('Only IEEE float32 WAV is supported.');
  const lengthBig = dataSize ?? 0n;
  const dataLength = checkedNumber(lengthBig, 'WAV data');
  if (BigInt(dataOffset) + lengthBig > BigInt(file.size)) {
    throw new Error('The WAV data chunk is truncated or incomplete.');
  }
  const frameSize = channels * (bits / 8);
  return { format, audioFormat: audioFormat as 1 | 3, channels, sampleRate, bitsPerSample: bits as WavMetadata['bitsPerSample'], frameSize, frameCount: Math.floor(dataLength / frameSize), dataOffset, dataLength, dataLengthBigInt: lengthBig, name: options.name };
}

export const parseLargeWav = parseWavMetadata;
export const parseWavFile = parseWavMetadata;

/** Bounded source identity based on container metadata and three sampled regions. */
export async function fingerprintWav(file: Blob, metadata: WavMetadata, signal?: AbortSignal): Promise<string> {
  abort(signal);
  const sampleSize = 64 * 1024;
  const starts = [
    0,
    Math.max(0, Math.floor(file.size / 2) - Math.floor(sampleSize / 2)),
    Math.max(0, file.size - sampleSize),
  ];
  const samples = await Promise.all(starts.map((start) => bytes(file, start, Math.min(file.size, start + sampleSize), signal)));
  const descriptor = new TextEncoder().encode(JSON.stringify({
    size: file.size,
    format: metadata.format,
    audioFormat: metadata.audioFormat,
    channels: metadata.channels,
    sampleRate: metadata.sampleRate,
    bitsPerSample: metadata.bitsPerSample,
    frameCount: metadata.frameCount,
    dataOffset: metadata.dataOffset,
  }));
  const total = descriptor.byteLength + samples.reduce((sum, sample) => sum + sample.byteLength, 0);
  const input = new Uint8Array(total);
  input.set(descriptor);
  let offset = descriptor.byteLength;
  for (const sample of samples) {
    input.set(sample, offset);
    offset += sample.byteLength;
  }
  abort(signal);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function readFrames(file: Blob, metadata: WavMetadata, startFrame: number, frameCount: number, options: { signal?: AbortSignal; onProgress?: WavProgress } = {}): Promise<Float32Array[]> {
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(frameCount) || frameCount < 0) throw new RangeError('Frame range must be non-negative safe integers.');
  const count = Math.min(frameCount, Math.max(0, metadata.frameCount - startFrame));
  const result = Array.from({ length: metadata.channels }, () => new Float32Array(count));
  const raw = await bytes(file, metadata.dataOffset + startFrame * metadata.frameSize, metadata.dataOffset + startFrame * metadata.frameSize + count * metadata.frameSize, options.signal);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let frame = 0; frame < count; frame++) {
    if ((frame & 0x3fff) === 0) { abort(options.signal); options.onProgress?.(frame, count); }
    for (let channel = 0; channel < metadata.channels; channel++) {
      const at = frame * metadata.frameSize + channel * (metadata.bitsPerSample / 8);
      let sample: number;
      if (metadata.audioFormat === 3) sample = view.getFloat32(at, true);
      else if (metadata.bitsPerSample === 8) sample = (view.getUint8(at) - 128) / 128;
      else if (metadata.bitsPerSample === 16) sample = view.getInt16(at, true) / 32768;
      else if (metadata.bitsPerSample === 24) { let v = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16); if (v & 0x800000) v -= 0x1000000; sample = v / 8388608; }
      else sample = view.getInt32(at, true) / 2147483648;
      result[channel][frame] = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
    }
  }
  options.onProgress?.(count, count);
  return result;
}

export interface Float32HeaderOptions { channels: number; sampleRate: number; frameCount: number | bigint; rf64?: boolean }
export function generateFloat32WavHeader(options: Float32HeaderOptions): Uint8Array {
  const frames = BigInt(options.frameCount); const data = frames * BigInt(options.channels) * 4n;
  const rf64 = options.rf64 ?? data + 36n > 0xffffffffn;
  const length = rf64 ? 80 : 44; const out = new Uint8Array(length); const v = new DataView(out.buffer);
  const put = (at: number, text: string) => text.split('').forEach((c, i) => out[at + i] = c.charCodeAt(0));
  put(0, rf64 ? 'RF64' : 'RIFF'); v.setUint32(4, rf64 ? 0xffffffff : Number(data + 36n), true); put(8, 'WAVE');
  let p = 12;
  if (rf64) { put(p, 'ds64'); v.setUint32(p + 4, 28, true); v.setBigUint64(p + 8, data + 72n, true); v.setBigUint64(p + 16, data, true); v.setBigUint64(p + 24, frames, true); v.setUint32(p + 32, 0, true); p += 36; }
  put(p, 'fmt '); v.setUint32(p + 4, 16, true); v.setUint16(p + 8, 3, true); v.setUint16(p + 10, options.channels, true); v.setUint32(p + 12, options.sampleRate, true); v.setUint32(p + 16, options.sampleRate * options.channels * 4, true); v.setUint16(p + 20, options.channels * 4, true); v.setUint16(p + 22, 32, true); p += 24;
  put(p, 'data'); v.setUint32(p + 4, rf64 ? 0xffffffff : Number(data), true);
  return out;
}

export interface Float32ChunkWriterOptions {
  channels: number;
  sampleRate: number;
  frameCount: number;
  readFrames: (startFrame: number, frameCount: number, signal?: AbortSignal) => Promise<Float32Array[]>;
  processFrames?: (channels: Float32Array[], startFrame: number) => Float32Array[];
  signal?: AbortSignal;
  onProgress?: WavProgress;
  chunkFrames?: number;
}

function incompleteExportError(error: unknown) {
  const detail = error instanceof Error && error.name === 'AbortError'
    ? 'Export was cancelled.'
    : error instanceof Error && error.message
      ? error.message
      : 'The destination could not be written.';
  return new Error(`Export incomplete: ${detail}`, { cause: error });
}

/** Accepts both the file picker and bounded browser-download destinations. */
export interface WavDestination {
  write(chunk: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

/** Streams a file-backed WAV and aborts the destination unless every byte and close succeed. */
export async function writeFloat32WavChunks(stream: WavDestination, options: Float32ChunkWriterOptions): Promise<void> {
  const { channels, sampleRate, frameCount, signal, onProgress } = options;
  const chunkFrames = Math.max(1, options.chunkFrames ?? Math.max(4096, Math.floor(sampleRate * 2)));
  try {
    abort(signal);
    const header = generateFloat32WavHeader({ channels, sampleRate, frameCount });
    const headerBuffer = new ArrayBuffer(header.byteLength);
    new Uint8Array(headerBuffer).set(header);
    await stream.write(headerBuffer);
    for (let start = 0; start < frameCount; start += chunkFrames) {
      abort(signal);
      const count = Math.min(chunkFrames, frameCount - start);
      let source = await options.readFrames(start, count, signal);
      source = options.processFrames?.(source, start) ?? source;
      if (source.length !== channels || source.some((channel) => channel.length !== count)) {
        throw new Error('A rendered audio chunk had an unexpected size.');
      }
      const output = new ArrayBuffer(count * channels * 4);
      const view = new DataView(output);
      let offset = 0;
      for (let frame = 0; frame < count; frame += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
          const sample = source[channel][frame];
          view.setFloat32(offset, Number.isFinite(sample) ? sample : 0, true);
          offset += 4;
        }
      }
      await stream.write(output);
      onProgress?.(start + count, frameCount);
    }
    abort(signal);
    await stream.close();
  } catch (error) {
    try {
      await stream.abort(error);
    } catch {
      // Preserve the original write/cancellation failure.
    }
    throw incompleteExportError(error);
  }
}

export async function writeFloat32Wav(stream: WavDestination, source: Float32Array[], sampleRate: number, options: { signal?: AbortSignal; onProgress?: WavProgress; frameCount?: number | bigint } = {}) {
  const channels = source.length;
  const frameCount = options.frameCount ?? BigInt(source[0]?.length ?? 0);
  const header = generateFloat32WavHeader({ channels, sampleRate, frameCount });
  const headerBuffer = new ArrayBuffer(header.byteLength);
  new Uint8Array(headerBuffer).set(header);
  await stream.write(headerBuffer);
  const frames = Number(frameCount); const chunk = 16384;
  for (let start = 0; start < frames; start += chunk) {
    abort(options.signal); const end = Math.min(frames, start + chunk); const block = new ArrayBuffer((end - start) * channels * 4); const view = new DataView(block); let at = 0;
    for (let i = start; i < end; i++) for (let c = 0; c < channels; c++) { view.setFloat32(at, Number.isFinite(source[c][i]) ? source[c][i] : 0, true); at += 4; }
    await stream.write(block); options.onProgress?.(end, frames);
  }
  await stream.close();
}
export const exportWavFloat32 = writeFloat32Wav;
export const streamWavFloat32 = writeFloat32Wav;
export const encodeWavStream = writeFloat32Wav;