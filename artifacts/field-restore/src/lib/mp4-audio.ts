import { AudioSampleSink, BlobSource, Input, MP4, type InputAudioTrack } from 'mediabunny';

/** Only decoded audio is exposed to the editor. The MP4 itself remains the immutable source. */
export interface Mp4Metadata {
  format: 'MP4';
  trackId: number;
  codec: string;
  channels: number;
  sampleRate: number;
  bitsPerSample: 32;
  frameCount: number;
  /** Relative frame offset for range-only analysis; the source retains the complete timeline. */
  frameStart?: number;
  name?: string;
}

interface Mp4Session {
  input: Input<BlobSource>;
  track: InputAudioTrack;
  sink: AudioSampleSink;
  trackId: number;
  codec: string;
  channels: number;
  sampleRate: number;
  frameCount: number;
  firstTimestamp: number;
}

const sessions = new WeakMap<Blob, Promise<Mp4Session>>();
const PRE_ROLL_SECONDS = 0.5;

function abort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
}

async function sessionFor(file: Blob, signal?: AbortSignal): Promise<Mp4Session> {
  abort(signal);
  let pending = sessions.get(file);
  if (!pending) {
    pending = (async () => {
      const input = new Input({ formats: [MP4], source: new BlobSource(file, {
        maxCacheSize: 8 * 1024 * 1024, useStreamReader: false,
      }) });
      try {
        if (!await input.canRead()) throw new Error('This file does not contain a readable MP4 container.');
        const track = await input.getPrimaryAudioTrack();
        if (!track) throw new Error('This MP4 does not contain an audio track.');
        const codec = await track.getCodec();
        const [channels, sampleRate] = await Promise.all([track.getNumberOfChannels(), track.getSampleRate()]);
        if ((channels !== 1 && channels !== 2) || !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
          throw new Error('This MP4 audio track has an unsupported channel layout or sample rate. Use mono or stereo audio at 8–192 kHz.');
        }
        if (!codec || !await track.canDecode()) {
          throw new Error(`The MP4 audio codec${codec ? ` (${codec})` : ''} cannot be decoded in this browser or desktop app.`);
        }
        const [firstTimestamp, metadataDuration] = await Promise.all([
          track.getFirstTimestamp(), track.getDurationFromMetadata(),
        ]);
        const duration = metadataDuration ?? await track.computeDuration();
        const frameCount = Math.round(duration * sampleRate);
        if (!Number.isSafeInteger(frameCount) || frameCount <= 0 || !Number.isFinite(firstTimestamp)) {
          throw new Error('This MP4 has no usable audio duration.');
        }
        return { input, track, sink: new AudioSampleSink(track), trackId: track.id, codec, channels,
          sampleRate, frameCount, firstTimestamp };
      } catch (error) {
        input.dispose();
        throw error;
      }
    })();
    sessions.set(file, pending);
    void pending.catch(() => { if (sessions.get(file) === pending) sessions.delete(file); });
  }
  const session = await pending;
  abort(signal);
  return session;
}

async function decodeRange(
  session: Mp4Session, metadata: Mp4Metadata, startFrame: number, frameCount: number,
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  abort(signal);
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(frameCount) || frameCount < 0) {
    throw new RangeError('Frame range must be non-negative safe integers.');
  }
  const count = Math.min(frameCount, Math.max(0, metadata.frameCount - startFrame));
  const output = Array.from({ length: metadata.channels }, () => new Float32Array(count));
  if (!count) return output;
  const absoluteStart = (metadata.frameStart ?? 0) + startFrame;
  const absoluteEnd = absoluteStart + count;
  // Decode some earlier packets for codecs with inter-frame overlap / decoder priming.
  const from = Math.max(session.firstTimestamp, absoluteStart / metadata.sampleRate - PRE_ROLL_SECONDS);
  let hadAudio = false;
  for await (const sample of session.sink.samples(from, absoluteEnd / metadata.sampleRate)) {
    try {
      abort(signal);
      if (sample.numberOfChannels !== metadata.channels || sample.sampleRate !== metadata.sampleRate) {
        throw new Error('The MP4 audio track changes channel layout or sample rate during playback.');
      }
      const sampleStart = Math.round(sample.timestamp * metadata.sampleRate);
      const first = Math.max(absoluteStart, sampleStart);
      const last = Math.min(absoluteEnd, sampleStart + sample.numberOfFrames);
      if (first >= last) continue;
      hadAudio = true;
      for (let channel = 0; channel < metadata.channels; channel++) {
        sample.copyTo(output[channel].subarray(first - absoluteStart, last - absoluteStart), {
          format: 'f32-planar', planeIndex: channel,
          frameOffset: first - sampleStart, frameCount: last - first,
        });
      }
    } finally {
      sample.close();
    }
  }
  abort(signal);
  if (!hadAudio && absoluteEnd / metadata.sampleRate > session.firstTimestamp &&
    absoluteStart / metadata.sampleRate < session.frameCount / metadata.sampleRate - 0.05) {
    throw new Error('The MP4 audio track ended before the requested audio could be decoded.');
  }
  return output;
}

export async function parseMp4Metadata(file: Blob, options: { signal?: AbortSignal; name?: string } = {}): Promise<Mp4Metadata> {
  try {
    const session = await sessionFor(file, options.signal);
    const metadata: Mp4Metadata = {
      format: 'MP4', trackId: session.trackId, codec: session.codec, channels: session.channels,
      sampleRate: session.sampleRate, bitsPerSample: 32, frameCount: session.frameCount, name: options.name,
    };
    // A codec claim in the header is not enough: verify that both ends can actually be read
    // before replacing the current recording. No video frames are decoded.
    const probe = Math.min(session.frameCount, Math.round(session.sampleRate / 10));
    await decodeRange(session, metadata, 0, probe, options.signal);
    if (session.frameCount > probe) {
      await decodeRange(session, metadata, session.frameCount - probe, probe, options.signal);
    }
    return metadata;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error(`Unable to read MP4 audio: ${error instanceof Error ? error.message : 'The file is damaged or incomplete.'}`);
  }
}

export async function readMp4Frames(
  file: Blob, metadata: Mp4Metadata, startFrame: number, frameCount: number,
  options: { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void } = {},
): Promise<Float32Array[]> {
  const session = await sessionFor(file, options.signal);
  if (session.trackId !== metadata.trackId || session.sampleRate !== metadata.sampleRate ||
    session.channels !== metadata.channels || session.codec !== metadata.codec) {
    throw new Error('The MP4 audio track no longer matches this recording.');
  }
  const channels = await decodeRange(session, metadata, startFrame, frameCount, options.signal);
  options.onProgress?.(channels[0]?.length ?? 0, frameCount);
  return channels;
}
