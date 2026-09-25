import './_group.css';
import { BrandPreview } from './_shared/BrandPreview';

export function Current() {
  return (
    <BrandPreview
      mark={<div className="brand-mark" aria-hidden="true" />}
      name="Current mark"
      description="Circle and center dot, shown unchanged for comparison."
    />
  );
}