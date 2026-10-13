---
name: Carousel export boundary
description: Which slide state carousel PNG downloads should export and why exports stay browser-local.
---

Carousel image downloads target the latest saved SDM deck, not uncommitted text-caret state in the surrounding editor. Keep that boundary explicit to the user.

**Why:** The workspace editor owns editing state and persistence; independently exporting partial editor state risks inconsistent slides. Browser-local rendering also keeps the download usable from a static viewer without adding a server just for export.

**How to apply:** Use a fresh saved-deck render for every batch, never reuse old generated PNGs as a fallback, and abort the complete batch when fonts, assets, or document rendering fail.
