import './_group.css';
import { BrandPreview } from './_shared/BrandPreview';

export function BoldSilhouette() {
  return (
    <BrandPreview
      mark={
        <svg
          aria-hidden="true"
          width="28"
          height="28"
          viewBox="0 0 28 28"
          fill="currentColor"
          style={{ color: 'hsl(var(--sidebar-primary))', flexShrink: 0 }}
        >
          <path
            fillRule="evenodd"
            d="M23.8 3.6C15.6 3.5 8.5 5.1 5.2 9.8 2.3 13.9 3.5 19.5 6.4 22.6c3.5-4.3 8.1-7.9 13.8-10.8-4.2 3.5-7.8 7.8-10.4 12.2 5.8-.2 10.2-3.3 11.8-8.1 1.1-3.3.6-7.4 2.2-12.3ZM7.6 19.1c2.2-3.2 5.1-5.9 8.5-8.1-3 2.8-5.5 5.8-7.5 9.1-.6-.2-.9-.6-1-1Z"
            clipRule="evenodd"
          />
        </svg>
      }
      name="Bold silhouette"
      description="A solid, tapered leaf with a crisp open vein cut through its center."
    />
  );
}