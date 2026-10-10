import type {} from './desktop-save';
type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
export interface OfflineState {
  phase: 'idle' | 'preparing' | 'ready' | 'error' | 'desktop' | 'development';
  message: string;
  installAvailable: boolean;
  installed: boolean;
  updateAvailable: boolean;
  persistent: boolean;
}
let state: OfflineState = {
  phase: 'idle', message: 'First complete setup needs internet.', installAvailable: false,
  installed: matchMedia('(display-mode: standalone)').matches, updateAvailable: false, persistent: false,
};
const listeners = new Set<() => void>();
const set = (next: Partial<OfflineState>) => { state = { ...state, ...next }; listeners.forEach(fn => fn()); };
export const getOfflineState = () => state;
export const subscribeOffline = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
let installEvent: InstallEvent | null = null;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault(); installEvent = event as InstallEvent; set({ installAvailable: true });
});
window.addEventListener('appinstalled', () => {
  installEvent = null; set({ installAvailable: false, installed: true });
});
export async function installBrowserApp() {
  if (!installEvent) return;
  await installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null; set({ installAvailable: false });
}
export async function requestPersistentStorage() {
  const persistent = await navigator.storage?.persist?.() ?? false;
  set({ persistent });
}
let preparing: Promise<void> | null = null;
const monitoredRegistrations = new WeakSet<ServiceWorkerRegistration>();

function monitorForUpdates(registration: ServiceWorkerRegistration) {
  if (monitoredRegistrations.has(registration)) return;
  monitoredRegistrations.add(registration);

  const noticeUpdate = () => set({ updateAvailable: Boolean(registration.waiting) });
  registration.addEventListener('updatefound', () => {
    registration.installing?.addEventListener('statechange', noticeUpdate);
  });
  noticeUpdate();

  const check = () => {
    if (navigator.onLine && document.visibilityState === 'visible') {
      void registration.update().catch(() => {
        // A transient update-check failure does not affect the active offline copy.
      });
    }
  };
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', check);
  window.setInterval(check, 30 * 60 * 1000);
}

export async function prepareOffline(): Promise<void> {
  if (preparing) return preparing;
  if (window.fieldRestoreDesktop) { set({ phase: 'desktop', message: 'Bundled desktop app · works offline' }); return; }
  if (import.meta.env.DEV) { set({ phase: 'development', message: 'Offline setup is available in the release build, not this development preview.' }); return; }
  if (!navigator.serviceWorker || !window.isSecureContext) {
    set({ phase: 'error', message: 'Open the published app in a standalone secure Chrome or Edge tab to set up offline use.' }); return;
  }
  preparing = (async () => {
    set({ phase: 'preparing', message: 'Downloading all app assets for offline use…' });
    try {
      const base = new URL(import.meta.env.BASE_URL, location.origin);
      const workerURL = new URL('export-download-sw.js', base);
      const existing = await navigator.serviceWorker.getRegistration(base.href);
      // An offline launch must not depend on fetching the worker script again.
      const registration = existing?.active?.scriptURL === workerURL.href
        ? existing
        : await navigator.serviceWorker.register(workerURL, { scope: base.pathname, updateViaCache: 'none' });
      monitorForUpdates(registration);
      if (existing === registration && navigator.onLine) {
        void registration.update().catch(() => {
          // Readiness is checked from the existing complete cache, not an update request.
          set({ message: 'Update check could not reach the server. Your existing offline copy is unchanged.' });
        });
      }
      if (!registration.active) {
        await new Promise<void>((resolve, reject) => {
          const worker = registration.installing ?? registration.waiting;
          const timer = setTimeout(() => reject(new Error('Offline setup timed out. Reconnect and try again.')), 60000);
          const check = () => {
            if (worker?.state === 'activated') { clearTimeout(timer); resolve(); }
            if (worker?.state === 'redundant') { clearTimeout(timer); reject(new Error('Offline setup did not finish. Reconnect and try again.')); }
          };
          worker?.addEventListener('statechange', check);
          check();
        });
      }
      set({ updateAvailable: Boolean(registration.waiting) });
      const ready = await new Promise<boolean>((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 5000);
        channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data.ready === true); };
        registration.active?.postMessage({ type: 'offline-status' }, [channel.port2]);
      });
      set({
        phase: ready ? 'ready' : 'error',
        message: ready ? 'Ready for offline use' : 'Offline setup is incomplete. If an update is queued, save your work, close all app tabs, then reopen online.',
        persistent: await navigator.storage?.persisted?.() ?? false,
      });
    } catch (error) {
      set({ phase: 'error', message: error instanceof Error ? error.message : 'Offline setup failed. Reconnect and try again.' });
    }
  })().finally(() => { preparing = null; });
  return preparing;
}