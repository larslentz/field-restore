import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MonitorDown, X } from 'lucide-react';
import {
  getOfflineState,
  installBrowserApp,
  prepareOffline,
  requestPersistentStorage,
  subscribeOffline,
} from '@/lib/offline';
import './install-panel.css';

interface WindowsRelease {
  filename: string;
  version: string;
  sha256: string;
}

const SAFE_EXE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}\.exe$/i;

function parseRelease(value: unknown): WindowsRelease | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.filename !== 'string' || typeof r.version !== 'string' || typeof r.sha256 !== 'string') return null;
  if (r.unsigned !== true) return null;
  if (!SAFE_EXE.test(r.filename) || r.filename.includes('..')) return null;
  if (!/^[A-Fa-f0-9]{64}$/.test(r.sha256)) return null;
  if (!r.version.trim() || r.version.length > 40) return null;
  return { filename: r.filename, version: r.version, sha256: r.sha256.toLowerCase() };
}

export function InstallPanel() {
  const state = useSyncExternalStore(subscribeOffline, getOfflineState, getOfflineState);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [release, setRelease] = useState<WindowsRelease | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    fetch(`${import.meta.env.BASE_URL}releases/windows-release.json`, { cache: 'no-cache', signal: ctl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setRelease(parseRelease(json)))
      .catch(() => setRelease(null));
    return () => ctl.abort();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    dialogRef.current?.focus();
    return () => trigger?.focus();
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); return; }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setFailure('');
    try { await fn(); } catch (err) { setFailure(err instanceof Error ? err.message : 'That action did not finish.'); }
    finally { setBusy(false); }
  };

  const desktop = state.phase === 'desktop';
  const dev = state.phase === 'development';
  const preparing = state.phase === 'preparing' || busy;
  const label = desktop ? 'Desktop' : state.phase === 'ready' ? 'Offline ready' : 'Install';

  return (
    <>
      <button ref={triggerRef} type="button" className="quiet-btn" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`Install and offline status: ${label}`} title="Install and offline status" data-testid="button-install">
        <MonitorDown size={14} aria-hidden="true" /> <span className="hidden sm:inline">{label}</span>
      </button>
      {open && (
        <div className="install-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div ref={dialogRef} className="install-dialog" role="dialog" aria-modal="true" aria-labelledby="install-title" tabIndex={-1} onKeyDown={onKeyDown} data-testid="dialog-install">
            <div className="panel-header">
              <div><div className="eyebrow">Local-first</div><h2 id="install-title" className="section-title mt-1">{desktop ? 'Desktop app' : 'Install and offline setup'}</h2></div>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close install dialog" data-testid="button-install-close"><X size={15} /></button>
            </div>
            <div className="install-body scrollbar-thin">
              <div className={`install-status ${state.phase === 'error' || failure ? 'error' : ''}`} role="status" data-testid="status-install">
                <strong>{state.phase === 'ready' ? 'Offline ready' : state.phase === 'preparing' ? 'Preparing offline files' : state.phase === 'error' ? 'Setup problem' : desktop ? 'Desktop build' : dev ? 'Development mode' : 'Not yet set up for offline'}</strong>
                <div>{failure || state.message}</div>
                {state.persistent && <div>Persistent storage granted.</div>}
              </div>

              {desktop ? (
                <>
                  <section><h3>Offline in the desktop app</h3><p>Desktop always runs from its bundled assets, so no browser setup is needed and nothing is uploaded.</p></section>
                  <section><h3>Projects are separate</h3><p>Desktop and browser projects are independent. Neither sees the other's saved work. Originals stay where they are on disk and need relinking if moved.</p></section>
                </>
              ) : dev ? (
                <section><h3>Offline setup is off in development</h3><p>Offline caching only runs in a production build, so install and offline setup are unavailable here.</p></section>
              ) : (
                <>
                  <section>
                    <h3>1. Complete setup once, online</h3>
                    <p>Offline readiness is separate from installing. Prepare downloads the app files into this browser so it can open without a connection. Installing only adds a shortcut and its own window.</p>
                    <div className="install-actions mt-2">
                      <button type="button" className="primary-btn" disabled={preparing || state.phase === 'ready'} onClick={() => run(prepareOffline)} data-testid="button-prepare-offline">{preparing ? 'Preparing…' : state.phase === 'ready' ? 'Offline ready' : state.phase === 'error' ? 'Retry offline setup' : 'Prepare for offline use'}</button>
                      <button type="button" className="quiet-btn" disabled={busy || state.installed || !state.installAvailable} onClick={() => run(installBrowserApp)} data-testid="button-install-app">{state.installed ? 'Installed' : 'Install app'}</button>
                      <button type="button" className="quiet-btn" disabled={busy || state.persistent} onClick={() => run(requestPersistentStorage)} data-testid="button-persist-storage">{state.persistent ? 'Storage persistent' : 'Request persistent storage'}</button>
                    </div>
                  </section>
                  {!state.installAvailable && !state.installed && (
                    <section><h3>Install from the browser</h3><p>If Install app is unavailable, use Chrome or Edge's install icon in the address bar, or the browser menu and choose Install Field Restore (or Apps, then Install this site as an app).</p></section>
                  )}
                  {state.updateAvailable && (
                    <section className="install-status" role="note"><h3>Update queued</h3><p>Field Restore never reloads on its own. After saving and finishing any export, close all Field Restore tabs and windows, then reopen the app while online to install the update.</p></section>
                  )}
                  <section><h3>Limits to know</h3><ul>
                    <li>Browsers may evict stored files when space is low, and clearing site data removes the offline copy and browser projects. Persistent storage lowers, but doesn't remove, that risk.</li>
                    <li>Original recordings stay where they are. If one is moved or access is lost, relink it.</li>
                    <li>Browser and desktop projects are independent.</li>
                  </ul></section>
                </>
              )}

              {release && (
                <section data-testid="section-windows-installer">
                  <h3>Windows installer · v{release.version}</h3>
                  <p>This installer is unsigned, so Windows SmartScreen may warn about an unknown publisher. Verify the SHA-256 below before choosing to run it.</p>
                  <div className="install-hash mt-1" data-testid="text-installer-sha256">SHA-256 {release.sha256}</div>
                  <div className="install-actions mt-2"><a className="secondary-btn" style={{ color: 'hsl(var(--secondary-foreground))', textDecoration: 'none' }} href={`${import.meta.env.BASE_URL}releases/${encodeURIComponent(release.filename)}`} download data-testid="link-windows-installer">Download {release.filename}</a></div>
                </section>
              )}

              {!desktop && !dev && (
                <p>Help: <a href="https://support.google.com/chrome/answer/9658361" target="_blank" rel="noopener noreferrer">Install a site as an app in Chrome</a> (opens a web page, so it needs internet).</p>
              )}
            </div>
            <div className="install-footer"><button type="button" className="quiet-btn" onClick={() => setOpen(false)} data-testid="button-install-done">Close</button></div>
          </div>
        </div>
      )}
    </>
  );
}

export default InstallPanel;
