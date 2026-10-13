import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';

export type WindPreviewLoader = (signal: AbortSignal) => Promise<string[]>;

export function ExportModal({ onClose, onExport, title, loadWindPreview, exporting }: {
  onClose: () => void;
  onExport: () => void;
  title: string;
  loadWindPreview: WindPreviewLoader;
  exporting: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<{
    loader: WindPreviewLoader; lines?: string[]; error?: string;
  } | null>(null);
  const current = preview?.loader === loadWindPreview ? preview : null;

  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    loadWindPreview(controller.signal).then(
      (lines) => {
        if (!controller.signal.aborted) setPreview({ loader: loadWindPreview, lines });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setPreview({
          loader: loadWindPreview,
          error: error instanceof Error ? error.message : 'Unable to prepare Wind Removal activity.',
        });
      },
    );
    return () => controller.abort();
  }, [loadWindPreview, attempt]);

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <div className="modal-header">
          <div>
            <div className="eyebrow">Output / local files</div>
            <h2 id="export-title" className="text-[17px] font-bold mt-1">Export restoration</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close export dialog" data-testid="button-close-export"><X size={16} /></button>
        </div>
        <div className="modal-body space-y-4">
          <div className="p-3 bg-[hsl(var(--muted))] rounded text-[12px]">
            <div className="font-semibold">{title || 'Untitled project'}</div>
            <div className="text-muted-foreground mt-1">Two files will be created: a valid WAV and a readable plain-text restoration report.</div>
          </div>
          <div className="block p-3 border border-[hsl(var(--primary))] bg-[hsl(var(--muted))] rounded">
            <strong className="text-[12px]">Archival WAV · 32-bit IEEE float</strong>
            <span className="block text-[11px] text-muted-foreground mt-1">Preserves floating-point precision, source sample rate, channel count, and stereo relationship. No normalization or dither is applied.</span>
          </div>
          <section className="rounded border border-border p-3 space-y-2 text-[11px]" aria-labelledby="wind-preview-title" data-testid="export-wind-preview">
            <h3 id="wind-preview-title" className="font-semibold text-[12px]">Wind Removal activity · report preview</h3>
            {current?.lines ? current.lines.filter((line, index) => index > 1 && line).map((line) => (
              <p key={line} className="leading-relaxed break-words">{line}</p>
            )) : current?.error ? (
              <div role="alert">
                <p>Wind activity preview unavailable: {current.error}</p>
                <button type="button" className="quiet-btn mt-2" onClick={() => setAttempt((value) => value + 1)} data-testid="button-retry-wind-preview">Retry preview</button>
              </div>
            ) : (
              <p role="status">Preparing export-range activity… For large recordings this may take a while. You can cancel without changing your edits or saving files.</p>
            )}
          </section>
          <div className="text-[11px] text-muted-foreground border-l-2 border-[#ff8a4c] pl-3">Previously saved projects may sound different when reprocessed with the improved DC correction. The original recording stays untouched and is never replaced.</div>
        </div>
        <div className="modal-footer">
          <button type="button" className="quiet-btn" onClick={onClose} data-testid="button-cancel-export">Cancel</button>
          <button type="button" className="primary-btn" onClick={onExport} disabled={!current?.lines || exporting} data-testid="button-confirm-export"><Download size={14} /> Export 32-bit float WAV + report</button>
        </div>
      </div>
    </div>
  );
}
