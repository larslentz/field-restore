import { Download, X } from 'lucide-react';

export function ExportModal({ onClose, onExport, title, exporting }: {
  onClose: () => void;
  onExport: () => void;
  title: string;
  exporting: boolean;
}) {
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
          <div className="text-[11px] text-muted-foreground border-l-2 border-[#ff8a4c] pl-3">Previously saved projects may sound different when reprocessed with the improved DC correction. The original recording stays untouched and is never replaced.</div>
        </div>
        <div className="modal-footer">
          <button type="button" className="quiet-btn" onClick={onClose} data-testid="button-cancel-export">Cancel</button>
          <button type="button" className="primary-btn" onClick={onExport} disabled={exporting} data-testid="button-confirm-export"><Download size={14} /> Export 32-bit float WAV + report</button>
        </div>
      </div>
    </div>
  );
}
