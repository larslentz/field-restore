export const SPECTROGRAM_FFT_SIZE = 4096;
export const SPECTROGRAM_DATA_HEIGHT = SPECTROGRAM_FFT_SIZE / 2 + 1;

export function validateSpectrogramFftSize(fftSize: number) {
  if (!Number.isSafeInteger(fftSize) || fftSize < 256 || fftSize > 16384 || (fftSize & (fftSize - 1)) !== 0) {
    throw new RangeError('Spectrogram FFT size must be a power of two between 256 and 16384.');
  }
  return fftSize;
}