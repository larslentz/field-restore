import { TRACK_DESCRIPTION_FIELDS, type TrackDescription } from '@/lib/track-description';

interface Props {
  value: TrackDescription;
  onChange: (value: TrackDescription) => void;
}

export function TrackDescriptionFields({ value, onChange }: Props) {
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
    </fieldset>
  );
}