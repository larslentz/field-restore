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

For Adaptive Hum Removal, treat every persistent narrowband tone as hum, including isolated non-mains tones and wanted held sounds. Require persistence to distinguish short/changing sounds, not a harmonic family or mains frequency.

**Why:** The user explicitly prefers removing all sustained tones over protecting ambiguous wanted notes; preserving an isolated tone solely because it lacks harmonics left obvious interference in the demo.

**How to apply:** Detect independent persistent peaks across the supported range, warn that wanted held notes and calls will also be reduced, and keep bypass available for comparison. For seekable file playback, align analysis history with full-file processing so the preview is representative of export.

For automatic hum removal, a bounded opening scan may seed *confirmed frequencies* at source frame zero, but never transplant filter history from the scan into the render. Treat the scan as a decision, not as processed playback time.

**Why:** Reusing warmed histories at frame zero introduces a discontinuity, while letting playback, export, and preview make separate initial decisions leaves the opening inconsistent.

**How to apply:** Run the opening scan through preceding edits, then start fresh filter histories for actual rendering and carry the same frequency decision through seek, loop, analysis, and export routes.

When dense adaptive tone cleanup becomes slow, move the canonical processing off the UI thread rather than capping confirmed tones or replacing its filter decisions with a faster approximation. Keep the original source available for A/B playback, and do not expose a stale render after edits change.

**Why:** Hundreds of simultaneous confirmed tones can take seconds to render a long recording; dropping tones or using separate render logic for playback and export would violate the user's full-coverage preference and make comparisons unreliable.

**How to apply:** Ensure async results belong to the active source and edit chain, and make edited playback and export wait for the same completed processing result.

Live hum readouts must follow the audible playhead, not the detector's render progress. File-backed playback buffers ahead, so a newly rendered decision is not yet what the listener hears.

**Why:** Showing a future filter choice while older audio is playing misrepresents the current restoration; an opening scan is also not a whole-recording measurement.

**How to apply:** Timestamp detector decisions in source frames and map them onto scheduled playback time, including loop restores and seeks. Keep the opening scan readout separate and clear live estimates when the source or edit chain changes.

Time-positioned hum history is an observation of audible processed playback, not a scan. Unobserved or evicted positions have no retained confirmation; an observed position with no active filter is a different result.

**Why:** Streaming buffers can make future decisions available before they are heard, and bounded history cannot establish what happened outside its retained positions.

**How to apply:** Retain only audible-playhead decisions in local bounded history, preserve gaps across seeks and loops, and reset the history whenever its source or edit chain changes.

Automatic broadband cleanup must be judged against wanted audio *inside noise*, not just isolated clean tones and noise-only clips. Preserve short onsets after the estimate has settled, and check high-sample-rate recordings.

**Why:** An estimate learned from steady hiss can attenuate the first milliseconds of a wanted sound; a tone protected in silence can still be softened when mixed with hiss. Broad frequency-band ratios change with the recording's Nyquist frequency and can mistake high-rate white noise for a tonal signal.

**How to apply:** Compare quiet and loud mixed tones, late short transients, stereo-only events, and steady hiss at common and high sample rates. For file-backed visual previews, a stateful adaptive floor needs the same source history as playback and export, not an independent short warmup for each visible slice.

Noise-only samples are recording-specific. Keep the compact estimate tied to the original source audio rather than asking each render path to relearn it. A chain preset may retain a sample only when its recorded source identity matches the active recording; missing identity is not a match. Project restoration is separate and retains samples after its source verification.

**Why:** File-backed previews, worker analysis, seeks, and exports must use one identical noise estimate; silently treating a profile from another recording as universally applicable can soften wanted sounds.

**How to apply:** Preserve the user's sample and mode in saved edits; on unverified cross-recording preset use, discard the old estimate and switch to Automatic while offering recapture. Keep preview and export using the same resulting chain.

Automatic click/pop cleanup in a same-length streaming pipeline cannot know at an abrupt onset whether it is a defect or a wanted attack: both have the same initial samples. Treat this as a product limitation rather than promising perfect classification.

**Why:** A fixed-duration hold can mute a genuine sustained onset and create a second audible edge when released; quieter clicks also disappear from detection if the threshold is tied to a loudness floor.

**How to apply:** Prefer bounded, gradually decaying correction with a threshold informed by local variation, disclose that sharp wanted impacts may soften, and check the pop tail and abrupt-onset release as well as the first corrected sample.
