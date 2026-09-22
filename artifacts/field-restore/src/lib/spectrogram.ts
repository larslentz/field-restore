export interface SpectrogramData {
  width: number;
  height: number;
  values: Float32Array;
}

function fft(real: Float64Array, imaginary: Float64Array) {
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
    const phaseStepReal = Math.cos(angle);
    const phaseStepImaginary = Math.sin(angle);
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
        const nextPhaseReal = phaseReal * phaseStepReal - phaseImaginary * phaseStepImaginary;
        phaseImaginary = phaseReal * phaseStepImaginary + phaseImaginary * phaseStepReal;
        phaseReal = nextPhaseReal;
      }
    }
  }
}

export function calculateSpectrogram(
  channels: Float32Array[],
  sampleRate: number,
  startSeconds: number,
  durationSeconds: number,
  width = 480,
  height = 220,
  maximumFrequency = 20000,
  floorDb = -105,
  ceilingDb = -20,
): SpectrogramData {
  const fftSize = 1024;
  const availableFrames = channels[0]?.length ?? 0;
  const startFrame = Math.max(0, Math.floor(startSeconds * sampleRate));
  const viewFrames = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const values = new Float32Array(width * height);
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const magnitudes = new Float64Array(fftSize / 2 + 1);
  const channelCount = Math.max(1, channels.length);
  for (let column = 0; column < width; column += 1) {
    const centerFrame = startFrame + Math.floor(((column + 0.5) / width) * viewFrames);
    const windowStart = centerFrame - Math.floor(fftSize / 2);
    magnitudes.fill(0);

    for (const channel of channels) {
      real.fill(0);
      imaginary.fill(0);
      for (let index = 0; index < fftSize; index += 1) {
        const frame = windowStart + index;
        const sample = frame >= 0 && frame < availableFrames ? channel[frame] ?? 0 : 0;
        const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (fftSize - 1));
        real[index] = sample * hann;
      }
      fft(real, imaginary);
      for (let bin = 0; bin < magnitudes.length; bin += 1) {
        const magnitude = Math.hypot(real[bin], imaginary[bin]) / (fftSize / 2);
        magnitudes[bin] += magnitude * magnitude;
      }
    }
    for (let bin = 0; bin < magnitudes.length; bin += 1) {
      magnitudes[bin] = Math.sqrt(magnitudes[bin] / channelCount);
    }

    for (let row = 0; row < height; row += 1) {
      const frequency = maximumFrequency * (1 - row / Math.max(1, height - 1));
      const exactBin = frequency * fftSize / sampleRate;
      let normalized = 0;
      if (exactBin <= fftSize / 2) {
        const lowerBin = Math.floor(exactBin);
        const upperBin = Math.min(magnitudes.length - 1, lowerBin + 1);
        const fraction = exactBin - lowerBin;
        const magnitude = magnitudes[lowerBin] * (1 - fraction) + magnitudes[upperBin] * fraction;
        const decibels = 20 * Math.log10(Math.max(1e-9, magnitude));
        normalized = Math.max(0, Math.min(1, (decibels - floorDb) / (ceilingDb - floorDb)));
      }
      values[row * width + column] = normalized;
    }
  }

  return { width, height, values };
}