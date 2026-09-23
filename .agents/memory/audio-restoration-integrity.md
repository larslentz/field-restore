---
name: Audio restoration integrity
description: Product constraints for trustworthy restoration behavior that are not fully captured by individual implementations.
---

Keep audio processing local and non-destructive until explicit export. Preserve channel timing and stereo linkage by default, and label detector confidence and advanced statistics as estimates rather than facts.

**Why:** The product is intended for field and binaural recordings where privacy, reversibility, and spatial coherence matter more than aggressive cleanup or impressive claims.

**How to apply:** Any new processor, preview, analysis, persistence path, or export option must leave the original immutable, avoid silent downmixing, and state limitations when browser DSP cannot support a standards-grade result.

For file-backed recordings, carry DSP state across sequential chunks and restore an identical warmed state at selection loop boundaries. Verify persisted source identity before applying a saved edit chain.

**Why:** Resetting filters per chunk creates boundary artifacts and inconsistent analysis/export, while weak relinking can silently apply restoration decisions to a different recording.

**How to apply:** Use bounded chunk readers with stateful processors for playback, analysis, and export; use a bounded content fingerprint plus parsed format metadata for restore and relink checks.

DC offset removal is a mandatory hidden baseline stage, not an editable module. Apply it before user edits in previews, analysis, processed playback, and exports; absorb legacy saved DC modules to prevent duplicate correction.

**Why:** DC correction is required for every recording and must not be bypassed, deleted, or applied twice when older projects are restored.

**How to apply:** Keep the original source immutable for A/B comparison, identify processed output as automatically DC-corrected, and record the baseline stage in restoration reports.