import './_group.css';
import { BrandPreview } from './_shared/BrandPreview';

export function BotanicalOutline() {
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
            d="M22.9 4.9C15.1 4.8 8.2 7 5.6 12.1c-2.2 4.3.1 8.7 4.2 9.5 5.9 1.1 11.8-5.8 13.1-16.7Z"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5.7 21.4c3.5-4.1 7.4-7.2 13.6-11.9"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
          />
        </svg>
      }
      name="Botanical outline"
      description="A fine leaf silhouette with one clean vein—quietly natural and precise."
    />
  );
}