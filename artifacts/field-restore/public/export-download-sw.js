// One download per channel. The next browser stream pull requests the next audio chunk,
// so the worker never buffers the completed recording in memory.
const downloads = new Map();

// Filled by the release build. Development must never cache Vite's live modules.
const OFFLINE = null;
const cacheName = OFFLINE ? `field-restore-shell-${OFFLINE.version}` : null;
const assetURLs = new Set(OFFLINE?.assets.map(file => new URL(file, self.registration.scope).href) || []);
self.addEventListener('install', (event) => {
  if (!OFFLINE) return;
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    try {
      for (const url of assetURLs) {
        const response = await fetch(url, { cache: 'reload' });
        if (!response.ok || response.type === 'opaque') throw new Error('Incomplete offline setup');
        await cache.put(url, response);
      }
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
    // Do NOT skipWaiting: updates must wait until ALL existing tabs/exports have closed.
  })());
});
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  if (OFFLINE) {
    for (const key of await caches.keys()) {
      if (key.startsWith('field-restore-shell-') && key !== cacheName) await caches.delete(key);
    }
  }
  await self.clients.claim();
})()));

self.addEventListener('message', (event) => {
  const { type, id, filename } = event.data || {};
  if (type === 'offline-status' && event.ports[0]) {
    event.waitUntil((async () => {
      const cache = cacheName ? await caches.open(cacheName) : null;
      const ready = Boolean(cache && (await Promise.all([...assetURLs].map(url => cache.match(url)))).every(Boolean));
      event.ports[0].postMessage({ ready, version: OFFLINE?.version });
    })());
    return;
  }
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
  if (event.request.method !== 'GET') return;
  if (!url.pathname.startsWith(prefix)) {
    if (!OFFLINE || url.origin !== new URL(self.registration.scope).origin) return;
    const resource = new URL(url.href);
    resource.search = '';
    const root = new URL(self.registration.scope);
    const target = resource.href === root.href ? new URL('index.html', root).href : resource.href;
    if (!assetURLs.has(target)) return;
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      try {
        // Prefer the current published file while online, but keep refreshing
        // the offline copy so an old shell cannot mask a successful deployment.
        const response = await fetch(event.request, { cache: 'no-cache' });
        if (response.ok && response.type !== 'opaque') {
          try { await cache.put(target, response.clone()); } catch { /* Keep the network response usable if storage is full. */ }
          return response;
        }
      } catch {
        // Offline use falls back to the last complete local copy.
      }
      const cached = await cache.match(target);
      return cached || new Response('This Field Restore file is not available offline. Reconnect and reload.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })());
    return;
  }
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