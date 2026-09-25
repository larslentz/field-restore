import { useEffect, useMemo, useState } from 'react';
import type { SpectrogramData } from './spectrogram';

type View = { startSeconds: number; durationSeconds: number };
type Result = { channels: Float32Array[]; view: View; left: SpectrogramData; right: SpectrogramData };
const EMPTY = { width: 480, height: 110, values: new Float32Array(480 * 110) };

/** Only display a result for the current audio and viewport; terminate superseded calculations. */
export function useMemorySpectrogram(channels: Float32Array[], sampleRate: number, view: View) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!channels[0]) return;
    const worker = new Worker(new URL('./memory-spectrogram.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<
      { type: 'result'; left: SpectrogramData; right: SpectrogramData } | { type: 'error'; message: string }
    >) => {
      if (event.data.type === 'result') {
        setResult({ channels, view, left: event.data.left, right: event.data.right });
        setError('');
      } else setError(event.data.message);
      worker.terminate();
    };
    worker.onerror = (event) => { setError(event.message || 'Spectrogram failed.'); worker.terminate(); };
    worker.postMessage({ channels, sampleRate, ...view });
    return () => worker.terminate();
  }, [channels, sampleRate, view]);
  return useMemo(() => ({
    left: result?.channels === channels && result.view === view ? result.left : EMPTY,
    right: result?.channels === channels && result.view === view ? result.right : EMPTY,
    startSeconds: view.startSeconds,
    durationSeconds: view.durationSeconds,
    loading: !!channels[0] && !(result?.channels === channels && result.view === view),
    error,
  }), [result, channels, view, error]);
}