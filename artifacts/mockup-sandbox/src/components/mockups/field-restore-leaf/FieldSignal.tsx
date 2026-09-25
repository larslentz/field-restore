import './_group.css';
import { BrandPreview } from './_shared/BrandPreview';

export function FieldSignal() {
  return (
    <BrandPreview
      mark={
        <svg
          aria-hidden="true"
          width="28"
          height="28"
          viewBox="0 0 28 28"
          fill="none"
          style={{ flexShrink: 0, color: 'hsl(var(--sidebar-primary))' }}
        >
          <path
            d="M4.25 23.1C4.06 15.22 5.67 8.68 11.58 5.24C15.05 3.22 19.5 3.17 23.73 3.63C23.92 8.03 23.25 12.41 20.7 15.69C16.65 20.96 10.45 22.83 4.25 23.1Z"
            fill="currentColor"
          />
          <path
            d="M5.61 21.78C10.29 17.58 13.38 14.47 20.45 6.08"
            stroke="hsl(var(--sidebar))"
            strokeWidth="1.65"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M8.08 19.53L9.85 16.77L11.39 17.83L13.05 13.61L14.66 14.82L16.31 10.5L18.76 8.1"
            stroke="hsl(var(--sidebar))"
            strokeWidth="1.65"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      }
      name="FieldSignal"
      description="A lime leaf silhouette with a cut-through waveform stem, joining field growth and recorded signal in one compact mark."
    />
  );
}