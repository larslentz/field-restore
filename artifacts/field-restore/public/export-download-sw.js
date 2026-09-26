// One download per channel. The next browser stream pull requests the next audio chunk,
// so the worker never buffers the completed recording in memory.
const downloads = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const { type, id, filename } = event.data || {};
  if (type !== 'prepare' || !id || !event.ports[0]) return;
  const port = event.ports[0];
  const download = { port, filename: String(filename), pull: null, controller: null };
  downloads.set(id, download);
  port.onmessage = ({ data }) => {
    if (data.type === 'abort') {
      downloads.delete(id);
      if (download.controller) {
        download.controller.error(new Error('Export was cancelled.'));
        download.pull?.();
      }
      port.close();
    } else if (download.pull && data.type === 'chunk' && data.buffer instanceof ArrayBuffer) {
      download.controller.enqueue(new Uint8Array(data.buffer));
      download.pull();
      download.pull = null;
      port.postMessage({ type: 'ack' });
    } else if (download.pull && data.type === 'close') {
      download.controller.close();
      download.pull();
      download.pull = null;
      port.postMessage({ type: 'ack' });
      downloads.delete(id);
      port.close();
    }
  };
  port.postMessage({ type: 'ready' });
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const prefix = `${new URL(self.registration.scope).pathname}__export/`;
  if (event.request.method !== 'GET' || !url.pathname.startsWith(prefix)) return;
  const id = url.pathname.slice(prefix.length);
  const download = downloads.get(id);
  if (!download) {
    event.respondWith(new Response('Download is no longer available.', { status: 404 }));
    return;
  }
  // Avoid header injection; the anchor also supplies the preferred file name.
  const safeName = download.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  event.respondWith(new Response(new ReadableStream({
    pull(controller) {
      download.controller = controller;
      return new Promise((resolve) => {
        download.pull = resolve;
        download.port.postMessage({ type: 'pull' });
      });
    },
    cancel() {
      downloads.delete(id);
      download.port.postMessage({ type: 'cancel' });
      download.port.close();
    },
  }), {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(download.filename)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  }));
});