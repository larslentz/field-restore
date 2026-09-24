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

When a file-backed edited range starts after source time zero, warm processing state through the discarded prefix in bounded chunks before rendering the kept portion. Do not replace this with a fixed two-second warmup for trimmed output.

**Why:** A stateful Ambient Patch can capture its bed sample earlier than that window but remain active at the kept boundary. Starting a processor nearby misses that sample, so a file-backed export or analysis can disagree with the in-memory render.

**How to apply:** Treat trim as an output window, not a new DSP origin. Preserve absolute source frame positions for fades and regions; check cancellation between pre-roll chunks. If optimizing pre-roll, prove parity for ambient capture as well as filter state.

DC offset removal is a mandatory hidden baseline stage, not an editable module. Apply it before user edits in previews, analysis, processed playback, and exports; absorb legacy saved DC modules to prevent duplicate correction.

**Why:** DC correction is required for every recording and must not be bypassed, deleted, or applied twice when older projects are restored.

**How to apply:** Keep the original source immutable for A/B comparison, identify processed output as automatically DC-corrected, and record the baseline stage in restoration reports.

Automatic tonal cleanup must prefer missing an ambiguous tone over removing a wanted one. A single sustained spectral peak is not enough evidence for unsupervised removal; look for a convincing interference pattern and expose the limits.

**Why:** Field calls, sustained environmental sounds, and music can look like hum in a short analysis window, especially when the cleanup is enabled by default.

**How to apply:** Keep auto-detection conservative and auditionable; manual tuning can target a single known frequency. For seekable file playback, align analysis history with full-file processing so the preview is representative of export.

For automatic hum removal, a bounded opening scan may seed *confirmed frequencies* at source frame zero, but never transplant filter history from the scan into the render. Treat the scan as a decision, not as processed playback time.

**Why:** Reusing warmed histories at frame zero introduces a discontinuity, while letting playback, export, and preview make separate initial decisions leaves the opening inconsistent.

**How to apply:** Run the opening scan through preceding edits, then start fresh filter histories for actual rendering and carry the same frequency decision through seek, loop, analysis, and export routes.

Live hum readouts must follow the audible playhead, not the detector's render progress. File-backed playback buffers ahead, so a newly rendered decision is not yet what the listener hears.

**Why:** Showing a future filter choice while older audio is playing misrepresents the current restoration; an opening scan is also not a whole-recording measurement.

**How to apply:** Timestamp detector decisions in source frames and map them onto scheduled playback time, including loop restores and seeks. Keep the opening scan readout separate and clear live estimates when the source or edit chain changes.

Time-positioned hum history is an observation of audible processed playback, not a scan. Unobserved or evicted positions have no retained confirmation; an observed position with no active filter is a different result.

**Why:** Streaming buffers can make future decisions available before they are heard, and bounded history cannot establish what happened outside its retained positions.

**How to apply:** Retain only audible-playhead decisions in local bounded history, preserve gaps across seeks and loops, and reset the history whenever its source or edit chain changes.