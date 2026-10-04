const { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { NativeSaves } = require('./native-save.cjs');
const saves = new NativeSaves();
const ORIGIN = 'field-restore://app';
protocol.registerSchemesAsPrivileged([{ scheme: 'field-restore', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);
// Fixed name and scheme keep browser storage stable between launches and versions.
app.setName('Field Restore');
app.setPath('userData', path.join(app.getPath('appData'), 'Field Restore'));
let window;
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'self'";
function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame ||
    !event.senderFrame.url.startsWith(`${ORIGIN}/`)) throw new Error('Untrusted save request.');
}
function external(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') void shell.openExternal(parsed.href);
  } catch {}
}
app.whenReady().then(() => {
  const assets = path.join(__dirname, 'web');
  protocol.handle('field-restore', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Not found', { status: 404 });
    let filename;
    try {
      filename = path.resolve(assets, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    } catch { return new Response('Invalid path', { status: 400 }); }
    if (!filename.startsWith(`${assets}${path.sep}`)) return new Response('Not found', { status: 404 });
    try {
      const content = await fs.readFile(filename);
      return new Response(content, { headers: { 'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream',
        'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${ORIGIN}/`) && !/^(blob:|data:|devtools:)/.test(details.url) });
  });
  window = new BrowserWindow({
    width: 1500, height: 950, minWidth: 720, minHeight: 560, backgroundColor: '#f5f3ed',
    title: 'Field Restore', icon: path.join(assets, 'icons/app-512.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== `${ORIGIN}/` && url !== `${ORIGIN}/index.html`) { event.preventDefault(); external(url); }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'fullscreen');
  });
  ipcMain.handle('field-restore:save-select', async (event, filename) => {
    trusted(event);
    if (typeof filename !== 'string' || filename.length > 240 || /[\\/\x00-\x1f]/.test(filename) || !/\.(wav|txt)$/i.test(filename)) throw new Error('Invalid output filename.');
    const result = await dialog.showSaveDialog(window, { defaultPath: path.join(app.getPath('documents'), filename),
      filters: [{ name: filename.endsWith('.wav') ? 'WAV audio' : 'Plain text', extensions: [path.extname(filename).slice(1)] }] });
    if (result.canceled || !result.filePath) return null;
    return saves.create(result.filePath);
  });
  for (const method of ['write', 'close', 'abort']) {
    ipcMain.handle(`field-restore:save-${method}`, async (event, ...args) => { trusted(event); return saves[method](...args); });
  }
  ipcMain.handle('field-restore:protect-source', async (event, filename) => { trusted(event); return saves.protect(filename); });
  window.webContents.on('will-prevent-unload', event => {
    const answer = dialog.showMessageBoxSync(window, { type: 'warning', buttons: ['Keep working', 'Leave'],
      defaultId: 0, cancelId: 0, message: 'Leave Field Restore?', detail: 'Save your work and finish exports first. An unfinished export will be removed.' });
    if (answer === 1) event.preventDefault();
  });
  window.on('closed', () => { void saves.abortAll(); window = null; });
  void window.loadURL(`${ORIGIN}/`);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { void saves.abortAll(); });