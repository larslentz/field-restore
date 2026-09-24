---
name: FLAC source integrity
description: Non-obvious parser and storage constraints for reliable lossless FLAC restoration.
---

Treat FLAC frame-parser output as an index candidate, not proof that every frame is complete. Check the compressed frame footer CRC, including the final frame.

**Why:** A streaming FLAC parser can yield a truncated final frame when flushed; STREAMINFO can legally report an unknown total sample count, so sample-count comparison alone does not detect a truncated recording.

**How to apply:** Preserve frame integrity checks when changing the source reader or parser. Report incomplete/corrupt recordings explicitly rather than allowing a later preview or export to fail.

Keep ordinary-length FLAC projects file-backed, even if their compressed files are small; only very short decoded sources belong in embedded local saves.

**Why:** The legacy local save serializes decoded floating-point samples and can exceed browser storage quotas long before a compressed FLAC file reaches the WAV large-file threshold.

**How to apply:** Base the memory/file-backed choice on decoded PCM size and save format, not just the compressed file size. Preserve re-link fingerprint verification when loading file-backed edits.