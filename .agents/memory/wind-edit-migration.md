---
name: Wind edit migration
description: User-approved compatibility choice for converting old wind edits.
---

Previously saved Wind / Rumble edits and presets should use automatic detection and reduction when reopened. The separate Low Rumble Removal item should retain its fixed behavior; it is a distinct edit, even though it historically shared the same processor type.

**Why:** The user explicitly chose conversion to automatic rather than preserving the old manual Wind / Rumble sound. This may change how older projects sound, but their original recordings remain untouched.

**How to apply:** When changing wind processing or project/preset migrations, do not silently restore the old manual Wind / Rumble path or convert Low Rumble Removal. Explain changes to processed sound in the interface.