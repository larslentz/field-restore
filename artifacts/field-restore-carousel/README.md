# Field Restore social carousel

Ten editable Slides 2.0 documents, with the approved text reproduced verbatim.
The social output is **1080 × 1350 pixels (4:5)**, ordered `01` through `10`.

## Design and source imagery

- Professional product introduction for field recordists reading on a social feed.
- Cream background, slate text, olive image frames, and orange progress accents,
  converted directly from the Field Restore light-mode CSS tokens.
- Figtree for headings/body; Space Mono for navigation labels.
- Consistent header, image frame, and slide-number motif; a larger product cover
  and closing call to action establish the opening and ending.
- Images are screenshots of the actual running Field Restore application in its
  demo session, not mock interfaces. Measurements shown belong to the demo and
  are not performance claims.
- `scripts/capture-product.cjs` documents how the genuine app panels were captured.
  Cropped derivatives isolate controls without altering their text, values,
  proportions, or colors. Source PNGs are retained in `public/images/`.
- The original image notes are retained verbatim in `src/data/approved-copy.json`.

## Portrait compatibility

The generated Slides 2.0 scaffold defaults to 1920 × 1080. This standalone deck
uses 1080 × 1350 instead: the canvas constants and the viewer/export dimensions
are adapted locally. The editor, slide IDs, route handling, navigation effects,
document loading, and `.slide[data-slide-id]` export wrappers are unchanged.
No Field Restore application or manual files are modified.

## Commands

From the workspace root:

```sh
pnpm --filter @workspace/field-restore-carousel validate-slides
node artifacts/field-restore-carousel/scripts/export-carousel.cjs
```

The export command loads the running artifact, waits for fonts and imagery,
checks the approved copy, captures each slide at native size, and writes numbered
PNG images plus a ZIP in `generated-artifacts/field-restore-carousel/`.
Those generated downloads are intentionally excluded from Git and deployment.
