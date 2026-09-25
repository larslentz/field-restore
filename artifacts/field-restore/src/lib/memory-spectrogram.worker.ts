/// <reference lib="webworker" />
import { calculateSpectrogram } from './spectrogram';
import { SPECTROGRAM_DATA_HEIGHT, SPECTROGRAM_FFT_SIZE } from './spectrogram-resolution';

const scope = self as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<{
  channels: Float32Array[]; sampleRate: number; startSeconds: number; durationSeconds: number;
}>) => {
  try {
    const { channels, sampleRate, startSeconds, durationSeconds } = event.data;
    const render = (channel: Float32Array) =>
      calculateSpectrogram([channel], sampleRate, startSeconds, durationSeconds, 480,
        SPECTROGRAM_DATA_HEIGHT, 0, sampleRate / 2, -180, 0, SPECTROGRAM_FFT_SIZE);
    const left = render(channels[0]);
    const right = render(channels[1] ?? channels[0]);
    scope.postMessage({ type: 'result', left, right }, [left.values.buffer, right.values.buffer]);
  } catch (caught) {
    scope.postMessage({ type: 'error', message: caught instanceof Error ? caught.message : 'Spectrogram failed.' });
  }
};