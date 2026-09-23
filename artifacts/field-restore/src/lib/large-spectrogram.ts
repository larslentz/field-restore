import { readFrames, type WavMetadata } from './large-wav';
import type { SpectrogramData } from './spectrogram';

export interface FileSpectrogramOptions {
  startSeconds?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  minimumFrequency?: number;
  maximumFrequency?: number;
  floorDb?: number;
  ceilingDb?: number;
  /** The channel to render. If omitted, the first channel is rendered. */
  channelIndex?: number;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  /** Cooperatively pause between FFT columns. */
  checkpoint?: () => void | Promise<void>;
  transform?: (channels: Float32Array[], startFrame: number) => Float32Array[] | Promise<Float32Array[]>;
  /** Sequential frames processed before each FFT window to warm stateful DSP. */
  warmupFrames?: number;
}

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
}

function fft(real: Float64Array, imaginary: Float64Array): void {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let size = 2; size <= length; size <<= 1) {
    const angle = -2 * Math.PI / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < length; start += size) {
      let phaseReal = 1;
      let phaseImaginary = 0;
      for (let offset = 0; offset < size / 2; offset += 1) {
        const even = start + offset;
        const odd = even + size / 2;
        const oddReal = real[odd] * phaseReal - imaginary[odd] * phaseImaginary;
        const oddImaginary = real[odd] * phaseImaginary + imaginary[odd] * phaseReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = phaseReal * stepReal - phaseImaginary * stepImaginary;
        phaseImaginary = phaseReal * stepImaginary + phaseImaginary * stepReal;
        phaseReal = nextReal;
      }
    }
  }
}

/**
 * Creates a spectrogram directly from a file. A single 1024-frame slice is
 * fetched for each column; the complete recording is never held in memory.
 */
export async function calculateFileSpectrogram(
  file: Blob,
  metadata: WavMetadata,
  options: FileSpectrogramOptions = {},
): Promise<SpectrogramData> {
  const width = options.width ?? 480;
  const height = options.height ?? 220;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError('Spectrogram dimensions must be positive safe integers.');
  }

  const startSeconds = options.startSeconds ?? 0;
  const durationSeconds = options.durationSeconds ?? metadata.frameCount / metadata.sampleRate;
  if (!Number.isFinite(startSeconds) || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new RangeError('Spectrogram time range must be finite and non-negative.');
  }
  const minimumFrequency = options.minimumFrequency ?? 0;
  const maximumFrequency = options.maximumFrequency ?? 20000;
  const floorDb = options.floorDb ?? -105;
  const ceilingDb = options.ceilingDb ?? -20;
  if (!Number.isFinite(minimumFrequency) || !Number.isFinite(maximumFrequency) ||
      maximumFrequency < minimumFrequency || !Number.isFinite(floorDb) ||
      !Number.isFinite(ceilingDb) || ceilingDb <= floorDb) {
    throw new RangeError('Invalid spectrogram frequency or dB range.');
  }
  const channel = options.channelIndex ?? 0;
  if (!Number.isSafeInteger(channel) || channel < 0 || channel >= metadata.channels) {
    throw new RangeError('Spectrogram channel is outside the WAV channel range.');
  }

  const fftSize = 1024;
  const half = fftSize / 2;
  const startFrame = Math.max(0, Math.floor(startSeconds * metadata.sampleRate));
  const viewFrames = Math.max(1, Math.floor(durationSeconds * metadata.sampleRate));
  const values = new Float32Array(width * height);
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const magnitudes = new Float64Array(half + 1);
  const window = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1));
  }

  for (let column = 0; column < width; column += 1) {
    abort(options.signal);
    await options.checkpoint?.();
    abort(options.signal);
    const center = startFrame + Math.floor(((column + 0.5) / width) * viewFrames);
    const windowStart = center - half;
    const targetReadStart = Math.max(0, windowStart);
    const skip = targetReadStart - windowStart;
    const framesToRead = Math.max(0, Math.min(fftSize - skip, metadata.frameCount - targetReadStart));
    const processingStart = Math.max(0, targetReadStart - Math.max(0, Math.floor(options.warmupFrames ?? 0)));
    const prefix = targetReadStart - processingStart;
    let channels = framesToRead > 0
      ? await readFrames(file, metadata, processingStart, prefix + framesToRead, { signal: options.signal })
      : [];
    if (channels.length && options.transform) channels = await options.transform(channels, processingStart);
    real.fill(0);
    imaginary.fill(0);
    const samples = channels[channel];
    for (let i = 0; i < framesToRead; i += 1) real[skip + i] = (samples?.[prefix + i] ?? 0) * window[skip + i];
    fft(real, imaginary);
    for (let bin = 0; bin <= half; bin += 1) magnitudes[bin] = Math.hypot(real[bin], imaginary[bin]) / half;

    for (let row = 0; row < height; row += 1) {
      const frequency = minimumFrequency + (maximumFrequency - minimumFrequency) *
        (1 - row / Math.max(1, height - 1));
      const exactBin = frequency * fftSize / metadata.sampleRate;
      let normalized = 0;
      if (exactBin >= 0 && exactBin <= half) {
        const lower = Math.floor(exactBin);
        const upper = Math.min(half, lower + 1);
        const magnitude = magnitudes[lower] * (1 - exactBin + lower) +
          magnitudes[upper] * (exactBin - lower);
        const decibels = 20 * Math.log10(Math.max(1e-9, magnitude));
        normalized = Math.max(0, Math.min(1, (decibels - floorDb) / (ceilingDb - floorDb)));
      }
      values[row * width + column] = normalized;
    }
    options.onProgress?.(column + 1, width);
  }
  return { width, height, values };
}