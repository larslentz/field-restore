import { createBrowserWavDownload } from './lib/browser-wav-download';
import { downloadBlob } from './lib/audio';

const status = document.getElementById('status')!;
const origin = location.origin;
if (!window.opener) {
  status.textContent = 'This export tab must be opened from Field Restore.';
} else {
  window.opener.postMessage({ type: 'field-restore-export-relay-ready' }, origin);
}

window.addEventListener('message', (event) => {
  if (event.origin !== origin || event.source !== window.opener || event.data?.type !== 'field-restore-export-relay-start') return;
  const port = event.ports[0];
  if (!port) return;
  let destination: Awaited<ReturnType<typeof createBrowserWavDownload>> | null = null;
  const controller = new AbortController();
  port.onmessage = async ({ data }) => {
    if (data?.type === 'abort') {
      controller.abort();
      await destination?.abort();
      status.textContent = 'Export cancelled. Return to Field Restore to try again.';
      port.close();
      return;
    }
    if (!data?.id) return;
    try {
      switch (data.type) {
        case 'start':
          status.textContent = 'Preparing the WAV download… Keep this tab open until both downloads start.';
          destination = await createBrowserWavDownload(data.filename, controller.signal, () => port.postMessage({ type: 'cancel' }));
          break;
        case 'write':
          if (!destination) throw new Error('The WAV destination is not ready.');
          await destination.write(data.buffer);
          break;
        case 'close':
          if (!destination) throw new Error('The WAV destination is not ready.');
          await destination.close();
          status.textContent = 'WAV download started. Preparing the restoration report…';
          break;
        case 'report':
          downloadBlob(new Blob([data.contents], { type: 'text/plain;charset=utf-8' }), data.filename);
          status.textContent = 'WAV and text report downloads started. Check Brave’s Downloads list for completion.';
          break;
        default:
          throw new Error('Unrecognized export message.');
      }
      port.postMessage({ type: 'ack', id: data.id });
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Export failed.';
      port.postMessage({ type: 'error', id: data.id, message: status.textContent });
    }
  };
});