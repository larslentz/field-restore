import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';

export function BrandPreview({ mark, name, description }: {
  mark: ReactNode;
  name: string;
  description: string;
}) {
  return (
    <div className="field-restore-leaf-preview">
      <div className="brand-preview-row">
        <aside className="sidebar-shell">
          <div className="px-4 py-5 flex items-center gap-3">
            {mark}
            <div className="brand-copy">
              <div className="font-bold tracking-tight text-[14px]">FIELD RESTORE</div>
              <div className="text-[10px] opacity-55 tracking-[.12em] mt-0.5">BY LARS LENTZ</div>
              <a className="brand-links" href="https://sleek.bio/larslentz" target="_blank" rel="noopener noreferrer" aria-label="More by Lars (opens in new tab)">
                More by Lars <ExternalLink size={11} aria-hidden="true" />
              </a>
            </div>
          </div>
        </aside>
        <aside className="sidebar-shell compact-preview">
          <div className="px-4 py-5 flex items-center gap-3">
            {mark}
            <div className="brand-copy">
              <div className="font-bold tracking-tight text-[14px]">FIELD RESTORE</div>
              <div className="text-[10px] opacity-55 tracking-[.12em] mt-0.5">BY LARS LENTZ</div>
            </div>
          </div>
        </aside>
      </div>
      <div className="brand-preview-caption"><span>Full sidebar</span><span>Compact</span></div>
      <div className="brand-preview-detail">
        <div className="brand-preview-detail-symbol">{mark}</div>
        <div className="brand-preview-detail-copy"><strong>{name}</strong>{description}</div>
      </div>
    </div>
  );
}