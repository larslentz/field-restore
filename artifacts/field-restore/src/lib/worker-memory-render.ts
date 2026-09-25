import type { EditModule } from './edit-chain';
import type { MemoryRenderResult } from './memory-render';

export type MemoryRenderJob = { promise: Promise<MemoryRenderResult>; cancel: () => void };

export function startMemoryRender(channels: Float32Array[], modules: EditModule[], sampleRate: number): MemoryRenderJob {
  const worker = new Worker(new URL('./memory-render.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectJob: (reason: Error) => void = () => undefined;
  const finish = () => {
    if (settled) return false;
    settled = true;
    worker.terminate();
    return true;
  };
  const promise = new Promise<MemoryRenderResult>((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = (event: MessageEvent<{ type: 'result'; result: MemoryRenderResult } | { type: 'error'; message: string }>) => {
      if (!finish()) return;
      if (event.data.type === 'result') resolve(event.data.result);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => { if (finish()) reject(new Error(event.message || 'Audio render failed.')); };
    // Do not transfer source buffers: original monitoring and non-destructive edits still need them.
    worker.postMessage({ channels, modules, sampleRate });
  });
  return {
    promise,
    cancel: () => {
      if (finish()) rejectJob(new DOMException('Audio render cancelled.', 'AbortError'));
    },
  };
}