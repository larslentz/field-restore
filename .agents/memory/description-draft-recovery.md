---
name: Description draft recovery
description: Preserve the distinction between local writing recovery and explicit project saves.
---

Local description recovery must remain separate from Save project. Offer restore or discard explicitly; neither decision changes the saved project. Allow writing recovery while a file-backed project waits for relink, but do not save a replacement project without its verified source.

**Why:** Reload protection must not silently overwrite intentional project saves or associate unfinished writing with a different recording.

**How to apply:** Keep recovery tied to stable project identity while source access is pending. For unsaved imports, require the matching recording to be reimported before offering its draft. Preserve drafts when switching away, and retire them only on explicit discard, a return to the saved text, or a successful project save.