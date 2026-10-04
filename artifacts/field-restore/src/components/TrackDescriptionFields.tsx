import { TRACK_DESCRIPTION_FIELDS, type TrackDescription } from '@/lib/track-description';
import { Download } from 'lucide-react';

interface Props {
  value: TrackDescription;
  onChange: (value: TrackDescription) => void;
  onDownload: () => void;
}

export function TrackDescriptionFields({ value, onChange, onDownload }: Props) {
  return (
    <fieldset className="space-y-4 min-w-0" data-testid="project-track-description">
      <legend className="section-title mb-2">The three-sentence method</legend>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Describe what happens, how the space unfolds, and why you kept the recording.
        These fields are saved with your project and included in the exported text report.
      </p>
      {TRACK_DESCRIPTION_FIELDS.map(({ key, label, guidance, placeholder }) => (
        <div key={key}>
          <label htmlFor={`project-description-${key}`} className="field-label">{label}</label>
          <p id={`project-description-${key}-guidance`} className="text-[12px] leading-relaxed text-muted-foreground mb-2">{guidance}</p>
          <textarea
            id={`project-description-${key}`}
            className={`textarea-field ${key === 'continuation' ? 'min-h-[170px]' : 'min-h-[72px]'}`}
            rows={key === 'continuation' ? 7 : 2}
            value={value[key]}
            onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            placeholder={placeholder}
            aria-describedby={`project-description-${key}-guidance`}
            data-testid={`textarea-project-description-${key}`}
          />
        </div>
      ))}
      <div>
        <button type="button" className="quiet-btn" onClick={onDownload} aria-describedby="project-description-download-hint" data-testid="button-download-track-description">
          <Download size={14} /> Download description (.txt)
        </button>
        <p id="project-description-download-hint" className="text-[12px] leading-relaxed text-muted-foreground mt-2">
          Downloads the current four fields, including unsaved changes. No audio export; Field notes stay separate.
        </p>
      </div>
    </fieldset>
  );
}