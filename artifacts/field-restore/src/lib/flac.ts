import CodecParser from 'codec-parser';
import { FLACDecoder } from '@wasm-audio-decoders/flac';
import type { AudioSource } from './audio';

export interface FlacFrame {
  offset: number;
  length: number;
  start: number;
  count: number;
}

export interface FlacMetadata {
  format: 'FLAC';
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  frameCount: number;
  dataOffset: number;
  /** Absolute frame offset for an analysis range; the index remains relative to the source. */
  frameStart?: number;
  frames: FlacFrame[];
  name?: string;
}

function abort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
}

function validFrameCrc(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  let crc = 0;
  for (let i = 0; i < data.length - 2; i++) {
    crc ^= data[i] << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x8005 : 0)) & 0xffff;
  }
  return crc === ((data[data.length - 2] << 8) | data[data.length - 1]);
}

export async function parseFlacMetadata(file: Blob, options: { signal?: AbortSignal; name?: string } = {}): Promise<FlacMetadata> {
  const { signal } = options;
  if (file.size < 42) throw new Error('The file is too small to be a FLAC recording.');
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (String.fromCharCode(...signature) !== 'fLaC') throw new Error('This file does not contain a native FLAC header.');
  let offset = 4;
  let sampleRate = 0; let channels = 0; let bitsPerSample = 0; let totalSamples = 0;
  let last = false;
  while (!last) {
    abort(signal);
    if (offset + 4 > file.size) throw new Error('The FLAC metadata is incomplete.');
    const header = new Uint8Array(await file.slice(offset, offset + 4).arrayBuffer());
    const type = header[0] & 0x7f;
    last = Boolean(header[0] & 0x80);
    const length = (header[1] << 16) | (header[2] << 8) | header[3];
    if (offset + 4 + length > file.size) throw new Error('The FLAC metadata is truncated.');
    if (type === 0) {
      if (sampleRate || length !== 34) throw new Error('Invalid FLAC STREAMINFO block.');
      const info = new Uint8Array(await file.slice(offset + 4, offset + 38).arrayBuffer());
      sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >>> 4);
      channels = ((info[12] >>> 1) & 7) + 1;
      bitsPerSample = (((info[12] & 1) << 4) | (info[13] >>> 4)) + 1;
      const count = (BigInt(info[13] & 15) << 32n) | (BigInt(info[14]) << 24n) |
        (BigInt(info[15]) << 16n) | (BigInt(info[16]) << 8n) | BigInt(info[17]);
      if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('FLAC frame count is too large.');
      totalSamples = Number(count);
    }
    offset += 4 + length;
  }
  if (!sampleRate || !channels || !bitsPerSample || offset >= file.size) throw new Error('Invalid or empty FLAC recording.');
  const dataOffset = offset;
  const parser = new CodecParser('audio/flac', { enableFrameCRC32: false });
  const frames: FlacFrame[] = [];
  let decodedFrames = 0;
  const addFrame = (frame: { data: Uint8Array; totalBytesOut: number; samples: number; totalSamples: number }) => {
    const at = dataOffset + frame.totalBytesOut;
    if (!frame.samples || !validFrameCrc(frame.data) || frame.totalSamples !== decodedFrames || at < dataOffset ||
      at + frame.data.length > file.size || (frames.length && at !== frames[frames.length - 1].offset + frames[frames.length - 1].length)) {
      throw new Error('The FLAC frame sequence is incomplete or invalid.');
    }
    frames.push({ offset: at, length: frame.data.length, start: decodedFrames, count: frame.samples });
    decodedFrames += frame.samples;
  };
  const consume = (iterator: ReturnType<typeof parser.parseChunk>) => {
    for (let item = iterator.next(); !item.done; item = iterator.next()) {
      addFrame(item.value as Parameters<typeof addFrame>[0]);
    }
  };
  for (let position = dataOffset; position < file.size; position += 256 * 1024) {
    abort(signal);
    const chunk = new Uint8Array(await file.slice(position, position + 256 * 1024).arrayBuffer());
    consume(parser.parseChunk(chunk));
  }
  consume(parser.flush());
  if (!frames.length || frames[0].offset !== dataOffset ||
    frames[frames.length - 1].offset + frames[frames.length - 1].length !== file.size ||
    (totalSamples && decodedFrames !== totalSamples)) {
    throw new Error('The FLAC recording is incomplete or its frame count does not match its header.');
  }
  return { format: 'FLAC', channels, sampleRate, bitsPerSample, frameCount: decodedFrames, dataOffset, frames, name: options.name };
}

interface DecodeSession {
  decoder: FLACDecoder;
  queue: Promise<unknown>;
  cache: Map<number, Float32Array[]>;
  cacheBytes: number;
}
const sessions = new WeakMap<Blob, DecodeSession>();
function sessionFor(file: Blob): DecodeSession {
  let session = sessions.get(file);
  if (!session) {
    session = { decoder: new FLACDecoder(), queue: Promise.resolve(), cache: new Map(), cacheBytes: 0 };
    sessions.set(file, session);
  }
  return session;
}

export async function readFlacFrames(
  file: Blob, metadata: FlacMetadata, startFrame: number, frameCount: number, options: { signal?: AbortSignal } = {},
): Promise<Float32Array[]> {
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(frameCount) || frameCount < 0) {
    throw new RangeError('Frame range must be non-negative safe integers.');
  }
  const count = Math.min(frameCount, Math.max(0, metadata.frameCount - startFrame));
  const output = Array.from({ length: metadata.channels }, () => new Float32Array(count));
  if (!count) return output;
  const absoluteStart = (metadata.frameStart ?? 0) + startFrame;
  const end = absoluteStart + count;
  const session = sessionFor(file);
  const read = async () => {
    abort(options.signal);
    await session.decoder.ready;
    const frames = metadata.frames;
    let low = 0; let high = frames.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (frames[mid].start + frames[mid].count <= absoluteStart) low = mid + 1;
      else high = mid;
    }
    let index = low;
    while (index < frames.length && frames[index].start < end) {
      abort(options.signal);
      if (!session.cache.has(index)) {
        const first = index;
        let last = first;
        let bytes = 0;
        while (last < frames.length && frames[last].start < end && !session.cache.has(last) &&
          last - first < 32 && bytes + frames[last].length <= 512 * 1024) {
          bytes += frames[last].length;
          last++;
        }
        if (last === first) last++;
        const slices = await Promise.all(frames.slice(first, last).map((frame) =>
          file.slice(frame.offset, frame.offset + frame.length).arrayBuffer().then((buffer) => new Uint8Array(buffer))));
        abort(options.signal);
        await session.decoder.reset();
        const decoded = await session.decoder.decodeFrames(slices);
        const expected = frames.slice(first, last).reduce((sum, frame) => sum + frame.count, 0);
        if (decoded.errors.length || decoded.samplesDecoded !== expected ||
          decoded.channelData.length !== metadata.channels || decoded.sampleRate !== metadata.sampleRate) {
          throw new Error('The FLAC recording contains an undecodable audio frame.');
        }
        let position = 0;
        for (let i = first; i < last; i++) {
          const sampleCount = frames[i].count;
          const channels = decoded.channelData.map((channel) => channel.slice(position, position + sampleCount));
          const size = sampleCount * channels.length * 4;
          while (session.cacheBytes + size > 8 * 1024 * 1024 && session.cache.size) {
            const oldest = session.cache.keys().next().value!;
            session.cacheBytes -= session.cache.get(oldest)!.reduce((sum, channel) => sum + channel.byteLength, 0);
            session.cache.delete(oldest);
          }
          session.cache.set(i, channels);
          session.cacheBytes += size;
          position += sampleCount;
        }
      }
      const frame = frames[index];
      const source = session.cache.get(index);
      if (!source) throw new Error('FLAC decoder cache is unavailable.');
      const from = Math.max(frame.start, absoluteStart);
      const to = Math.min(frame.start + frame.count, end);
      output.forEach((channel, c) => channel.set(source[c].subarray(from - frame.start, to - frame.start), from - absoluteStart));
      index++;
    }
    if (index === low || frames[Math.min(index - 1, frames.length - 1)].start + frames[Math.min(index - 1, frames.length - 1)].count < end) {
      throw new Error('The FLAC recording ended before the requested samples.');
    }
    abort(options.signal);
    return output;
  };
  const result = session.queue.then(read, read);
  session.queue = result.catch(() => {});
  return result;
}

export async function decodeFlac(file: File, metadata: FlacMetadata): Promise<AudioSource> {
  const decoder = new FLACDecoder();
  try {
    await decoder.ready;
    const decoded = await decoder.decodeFile(new Uint8Array(await file.arrayBuffer()));
    if (decoded.errors.length || decoded.samplesDecoded !== metadata.frameCount ||
      decoded.channelData.length !== metadata.channels || decoded.sampleRate !== metadata.sampleRate) {
      throw new Error('The FLAC recording could not be decoded completely.');
    }
    return { channels: decoded.channelData, sampleRate: decoded.sampleRate,
      duration: decoded.samplesDecoded / decoded.sampleRate, name: file.name };
  } finally {
    decoder.free();
  }
}