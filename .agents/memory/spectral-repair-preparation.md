---
name: Spectral repair preparation
description: Why future-aware local repair is prepared before chunked file rendering and what ranged analysis must preserve.
---

File-backed spectral replacement uses a prepared local patch instead of computing independently inside each playback/export chunk.

**Why:** Replacement needs clean audio after the selected region, but the synchronous streaming processor must return the current chunk immediately and cannot revise samples emitted at a chunk boundary. Preparing from the upstream edit-chain signal also preserves module order across playback, loops, analysis, and export.

**How to apply:** When adding another future-dependent edit, keep its source reads bounded near the edit and reuse the same prepared output across consumers. Ranged analysis metadata may describe only the requested slice; preparation must still receive full-source metadata, or valid edits later in the file will be rejected. Stateful upstream modules may require warming from the beginning even when the retained patch is local.