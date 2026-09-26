import type { WavDestination } from './large-wav';

const unavailable = 'Streaming downloads are unavailable in this browser context. Open Field Restore in a standalone Brave tab, then try again.';

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(unavailable)), ms);
    promise.then(
      (value) => { window.clearTimeout(timeout); resolve(value); },
      (error) => { window.clearTimeout(timeout); reject(error); },
    );
  });
}

/** Send one chunk per browser pull; never retain the complete WAV in page memory. */
export async function createBrowserWavDownload(
  filename: string, signal: AbortSignal, onCancel: () => void,
): Promise<WavDestination> {
  if (!('serviceWorker' in navigator)) throw new Error(unavailable);
  const base = new URL(import.meta.env.BASE_URL, location.origin);
  let registration: ServiceWorkerRegistration;
  try {
    registration = await within(navigator.serviceWorker.register(new URL('export-download-sw.js', base).href, { scope: base.pathname }), 15000);
    await within(navigator.serviceWorker.ready, 15000);
    if (navigator.serviceWorker.controller?.scriptURL !== registration.active?.scriptURL) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => { cleanup(); reject(new Error(unavailable)); }, 10000);
        const changed = () => {
          if (navigator.serviceWorker.controller?.scriptURL === registration.active?.scriptURL) {
            cleanup(); resolve();
          }
        };
        const cleanup = () => {
          window.clearTimeout(timeout);
          navigator.serviceWorker.removeEventListener('controllerchange', changed);
        };
        navigator.serviceWorker.addEventListener('controllerchange', changed);
        changed();
      });
    }
  } catch (error) {
    throw error instanceof Error && error.message === unavailable ? error : new Error(unavailable, { cause: error });
  }
  const worker = navigator.serviceWorker.controller;
  if (!worker) throw new Error(unavailable);
  const channel = new MessageChannel();
  const port = channel.port1;
  const id = crypto.randomUUID();
  let pulls = 0;
  let pending: { resolve: () => void; reject: (error: Error) => void; kind: 'pull' | 'ack' } | null = null;
  let stopped = false;
  const fail = (error: Error) => {
    stopped = true;
    pending?.reject(error);
    pending = null;
  };
  const wait = (kind: 'pull' | 'ack') => new Promise<void>((resolve, reject) => {
    if (stopped || signal.aborted) return reject(new Error('Export was cancelled.'));
    if (kind === 'pull' && pulls > 0) { pulls--; resolve(); return; }
    const timeout = window.setTimeout(() => {
      if (pending?.resolve === current.resolve) {
        pending = null;
        reject(new Error('The browser download stopped responding. Open Field Restore in a standalone tab and try again.'));
      }
    }, 30000);
    const current = {
      kind,
      resolve: () => { window.clearTimeout(timeout); resolve(); },
      reject: (error: Error) => { window.clearTimeout(timeout); reject(error); },
    };
    pending = current;
  });
  const onAbort = () => {
    if (stopped) return;
    fail(new Error('Export was cancelled.'));
    port.postMessage({ type: 'abort' });
    port.close();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  port.onmessage = ({ data }) => {
    if (data.type === 'cancel') { onCancel(); onAbort(); }
    if (data.type === 'pull') {
      if (pending?.kind === 'pull') { const current = pending; pending = null; current.resolve(); }
      else pulls++;
    }
    if (data.type === 'ack' && pending?.kind === 'ack') {
      const current = pending; pending = null; current.resolve();
    }
    if (data.type === 'ready' && pending?.kind === 'ack') {
      const current = pending; pending = null; current.resolve();
    }
  };
  worker.postMessage({ type: 'prepare', id, filename }, [channel.port2]);
  const ready = Promise.race([
    wait('ack'),
    new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error(unavailable)), 10000)),
  ]);
  try { await ready; }
  catch (error) { onAbort(); throw error; }
  if (signal.aborted) { onAbort(); throw new Error('Export was cancelled.'); }

  // Chromium bypasses service-worker fetch handlers for <a download> requests.
  // A frame navigation is intercepted and Content-Disposition starts the download.
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = new URL(`__export/${id}`, base).href;
  document.body.append(frame);

  return {
    async write(chunk) {
      await wait('pull');
      if (signal.aborted) throw new Error('Export was cancelled.');
      port.postMessage({ type: 'chunk', buffer: chunk }, [chunk]);
      await wait('ack');
    },
    async close() {
      await wait('pull');
      port.postMessage({ type: 'close' });
      await wait('ack');
      stopped = true;
      signal.removeEventListener('abort', onAbort);
      port.close();
      // The download event can arrive after the stream closes, especially via
      // the preview proxy. Keep the navigation alive until the handoff finishes.
      window.setTimeout(() => frame.remove(), 60_000);
    },
    async abort() {
      onAbort();
      signal.removeEventListener('abort', onAbort);
      frame.remove();
    },
  };
}