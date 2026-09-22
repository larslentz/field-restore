---
name: Audio restoration integrity
description: Product constraints for trustworthy restoration behavior that are not fully captured by individual implementations.
---

Keep audio processing local and non-destructive until explicit export. Preserve channel timing and stereo linkage by default, and label detector confidence and advanced statistics as estimates rather than facts.

**Why:** The product is intended for field and binaural recordings where privacy, reversibility, and spatial coherence matter more than aggressive cleanup or impressive claims.

**How to apply:** Any new processor, preview, analysis, persistence path, or export option must leave the original immutable, avoid silent downmixing, and state limitations when browser DSP cannot support a standards-grade result.