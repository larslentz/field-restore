---
name: Repair marker discovery
description: Why file-backed click repair history is partial until playback visits it
---

File-backed click repair markers describe processed audio that has been buffered for edited playback. Do not label unvisited regions as free of repairs.

**Why:** A full-file scan on import or each parameter change would delay long-recording work and duplicate the bounded export path. The current display is intentionally partial; an optional background index would be a separate feature.

**How to apply:** Keep any marker claims honest about coverage when changing playback, seek, or export behavior. Use absolute source-frame positions rather than clock time or chunk-relative offsets so discoveries across sessions and processing paths agree.