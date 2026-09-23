import type { LargeAnalysisResult } from './large-analysis';
import type { SpectrogramData } from './spectrogram';
import type { WorkerJobRequest, WorkerOutboundMessage } from './analysis-worker-protocol';

export interface WorkerJob<T> {
  promise: Promise<T>;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
}

export function startWorkerJob<T extends LargeAnalysisResult | SpectrogramData>(
  request: WorkerJobRequest,
  onProgress?: (fraction: number) => void,
): WorkerJob<T> {
  const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectJob: (reason?: unknown) => void = () => undefined;
  const finish = () => {
    if (settled) return false;
    settled = true;
    worker.terminate();
    return true;
  };
  const promise = new Promise<T>((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
      const message = event.data;
      if (message.type === 'progress') onProgress?.(message.fraction);
      if (message.type === 'result' && finish()) resolve(message.result as T);
      if (message.type === 'cancelled' && finish()) reject(new DOMException('The operation was cancelled.', 'AbortError'));
      if (message.type === 'error' && finish()) {
        const error = new Error(message.message);
        error.name = message.name;
        reject(error);
      }
    };
    worker.onerror = (event) => {
      if (finish()) reject(new Error(event.message || 'Worker analysis failed.'));
    };
    worker.postMessage({ type: 'start', request });
  });
  return {
    promise,
    pause: () => { if (!settled) worker.postMessage({ type: 'pause' }); },
    resume: () => { if (!settled) worker.postMessage({ type: 'resume' }); },
    cancel: () => {
      if (settled) return;
      worker.postMessage({ type: 'cancel' });
      finish();
      rejectJob(new DOMException('The operation was cancelled.', 'AbortError'));
    },
  };
}