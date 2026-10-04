import type { WavDestination } from './large-wav';
interface DesktopBridge {
  selectSave(filename: string): Promise<string | null>;
  write(id: string, data: ArrayBuffer): Promise<void>;
  close(id: string): Promise<void>;
  abort(id: string): Promise<void>;
  protectSource(file: File): Promise<void>;
}
declare global { interface Window { fieldRestoreDesktop?: DesktopBridge } }

export async function createDesktopDestination(filename: string, signal?: AbortSignal): Promise<WavDestination> {
  const bridge = window.fieldRestoreDesktop;
  if (!bridge) throw new Error('Desktop save is unavailable.');
  const id = await bridge.selectSave(filename);
  if (!id) throw new DOMException('Save cancelled.', 'AbortError');
  let finished = false;
  const abort = async () => { if (!finished) { finished = true; await bridge.abort(id); } };
  const onAbort = () => { void abort(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const check = () => { if (finished || signal?.aborted) throw new DOMException('Save cancelled.', 'AbortError'); };
  if (signal?.aborted) { await abort(); check(); }
  return {
    async write(data) {
      check();
      // One IPC chunk at a time; acknowledgement is real disk-write backpressure.
      for (let offset = 0; offset < data.byteLength; offset += 1024 * 1024) {
        check(); await bridge.write(id, data.slice(offset, offset + 1024 * 1024));
      }
    },
    async close() { check(); await bridge.close(id); finished = true; signal?.removeEventListener('abort', onAbort); },
    async abort() { signal?.removeEventListener('abort', onAbort); await abort(); },
  };
}
export async function saveDesktopBlob(blob: Blob, filename: string) {
  const destination = await createDesktopDestination(filename);
  try {
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
      await destination.write(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer());
    }
    await destination.close();
  } catch (error) { await destination.abort?.(); throw error; }
}