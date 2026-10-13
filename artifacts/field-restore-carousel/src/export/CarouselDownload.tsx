import { useRef, useState } from 'react';
import { exportCarousel } from './carouselExport';

export function CarouselDownload() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const running = useRef(false);

  const download = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailed(false);
    setMessage('');
    try {
      const blob = await exportCarousel(setMessage);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'Field-Restore-Social-Carousel.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setMessage('ZIP sent to your browser: ten 1080 × 1350 PNGs, numbered 01–10.');
    } catch (error) {
      setFailed(true);
      setMessage(`Download failed. ${error instanceof Error ? error.message : 'Please try again.'}`);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <aside className="carousel-download" aria-label="Carousel image download">
      <button type="button" onClick={download} disabled={busy} aria-busy={busy}>
        {busy ? 'Preparing PNGs…' : 'Download all PNGs (ZIP)'}
      </button>
      <p>Exports the current saved deck. Finish saving slide edits before downloading.</p>
      {message && <p role={failed ? 'alert' : 'status'} className={failed ? 'download-error' : ''}>{message}</p>}
    </aside>
  );
}
