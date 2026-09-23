---
name: Spectrogram resolution budget
description: Performance and data-retention constraints for future spectrogram quality changes.
---

Precompute and retain enough full-band frequency detail that frequency-axis zoom can remap existing data instead of restarting analysis. Keep large-file work bounded by visible time columns and file-backed reads.

**Why:** Frequency detail should improve without restoring long preview waits. A representative processed file-backed high-detail pass completed in about 400 ms per channel worker, so future changes should treat roughly half a second as the current interactive budget rather than increasing resolution without measurement.

**How to apply:** Benchmark both in-memory and processed file-backed paths whenever FFT or stored spectrogram dimensions change. Prefer independent worker processing and bounded data arrays; use progressive refinement only if the detailed result exceeds the interactive budget.