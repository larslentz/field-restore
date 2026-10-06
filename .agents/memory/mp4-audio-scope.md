---
name: MP4 audio scope
description: Why MP4 input remains audio-only and how pending-source relinking differs from opening another recording.
---

The user chose audio-only WAV export for MP4 restoration. Do not turn that choice into video editing or MP4 remuxing without a new request.

**Why:** The requested workflow modifies the embedded audio while leaving the original video unchanged. The existing local, non-destructive, bounded-memory constraints also apply to video sources.

**How to apply:** Keep the source MP4 external to saved projects. Prefer bounded local decoding, not a whole-video virtual filesystem or remote codec service. Unsupported runtime codecs must fail explicitly.

A recording selected while a project is waiting for its original source must not silently become a different project when identity verification fails. Opening a different recording is an explicit separate action.

**Why:** A mistaken relink otherwise discards the waiting workspace's unsaved edits and description identity.

**How to apply:** Reject identity mismatches before committing source state; preserve the waiting workspace until a verified relink or a successful, explicit new-recording action.
