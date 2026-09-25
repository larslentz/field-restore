import type { EditModule } from './edit-chain';
import type { AudioMetadata } from './source-audio';
import type { SpectralRepairPatches } from './streaming-edit-chain';

/** Keep long file scans and DSP off the UI thread. */
export function prepareSpectralRepairsInWorker(
  file: File, metadata: AudioMetadata, modules: EditModule[], signal?: AbortSignal,
): Promise<SpectralRepairPatches> {
  if (!modules.some((module) => module.enabled && module.type === 'spectral-repair' && Number(module.params.strength) > 0)) {
    return Promise.resolve({});
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./spectral-prep.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      return true;
    };
    const onAbort = () => {
      if (finish()) reject(new DOMException('Spectral repair preparation was cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    worker.onmessage = (event: MessageEvent<{ patches?: SpectralRepairPatches; error?: string }>) => {
      if (!finish()) return;
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.patches ?? {});
    };
    worker.onerror = (event) => {
      if (finish()) reject(new Error(event.message || 'Spectral repair preparation failed.'));
    };
    worker.postMessage({ file, metadata, modules });
  });
}