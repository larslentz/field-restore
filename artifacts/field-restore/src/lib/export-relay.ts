import type { WavDestination } from './large-wav';

const RELAY_READY = 'field-restore-export-relay-ready';
const RELAY_START = 'field-restore-export-relay-start';
const WAIT_MS = 30_000;

export interface ExportRelay {
  createDestination(filename: string, signal: AbortSignal, onCancel: () => void): Promise<WavDestination>;
  downloadReport(contents: string, filename: string): Promise<void>;
  abort(): void;
}

/** Open synchronously from the export click so Brave does not block the tab. */
export function openExportRelay(): ExportRelay {
  const url = new URL('export-relay.html', new URL(import.meta.env.BASE_URL, location.origin));
  const popup = window.open(url.href, '_blank');
  if (!popup) throw new Error('Allow the export tab popup, then try again.');

  let readyTimer: number;
  const ready = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(readyTimer);
      window.removeEventListener('message', onMessage);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== popup || event.origin !== location.origin || event.data?.type !== RELAY_READY) return;
      cleanup();
      resolve();
    };
    window.addEventListener('message', onMessage);
    readyTimer = window.setTimeout(() => {
      cleanup();
      reject(new Error('The export tab did not open in time. Try again in a standalone tab.'));
    }, 15_000);
  });

  let port: MessagePort | null = null;
  let serial = 0;
  let pending: { id: number; resolve: () => void; reject: (error: Error) => void; timer: number } | null = null;
  let cancelled = false;
  const fail = (error: Error) => {
    cancelled = true;
    if (pending) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
      pending = null;
    }
  };
  const send = (type: string, extras: Record<string, unknown> = {}, transfer: Transferable[] = []) => {
    if (!port || cancelled || popup.closed) return Promise.reject(new Error('The export tab was closed or the export was cancelled.'));
    const id = ++serial;
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending = null;
        reject(new Error('The export tab stopped responding. The download may be incomplete.'));
      }, WAIT_MS);
      pending = { id, resolve, reject, timer };
      port!.postMessage({ type, id, ...extras }, transfer);
    });
  };
  const abort = () => {
    if (cancelled) return;
    port?.postMessage({ type: 'abort' });
    fail(new Error('Export was cancelled.'));
    port?.close();
    port = null;
  };

  return {
    async createDestination(filename, signal, onCancel) {
      if (signal.aborted) throw new Error('Export was cancelled.');
      await ready;
      if (popup.closed) throw new Error('The export tab was closed.');
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = ({ data }) => {
        if (data?.type === 'cancel') { onCancel(); abort(); return; }
        if (!pending || data?.id !== pending.id) return;
        const current = pending;
        pending = null;
        window.clearTimeout(current.timer);
        if (data.type === 'error') current.reject(new Error(data.message || 'The export tab could not save the file.'));
        else current.resolve();
      };
      const onAbort = () => abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const start = send('start', { filename });
      popup.postMessage({ type: RELAY_START }, location.origin, [channel.port2]);
      try { await start; }
      catch (error) { signal.removeEventListener('abort', onAbort); abort(); throw error; }
      return {
        write: (buffer) => send('write', { buffer }, [buffer]),
        close: async () => {
          await send('close');
          signal.removeEventListener('abort', onAbort);
        },
        abort: async () => {
          signal.removeEventListener('abort', onAbort);
          abort();
        },
      };
    },
    downloadReport: async (contents, filename) => {
      await send('report', { contents, filename });
      port?.close();
      port = null;
    },
    abort,
  };
}