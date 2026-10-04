---
name: Windows packaging
description: Distinguish cross-building, complete download verification and native Windows checks; avoid unreliable Wine helpers on this host.
---

A successful Wine version check is not enough to establish that Windows installer helpers can execute on this Replit host. Prefer native NSIS compilation for unsigned full installers, or an actual Windows build runner when Windows-specific tooling is required.

**Why:** The classic 32-bit Wine loader could not execute in this container, and newer WoW64 bootstrap attempts stalled even with a virtual display. These are environment constraints, not proof that the application or compiled installer is broken.

**How to apply:** Build the complete local runtime without executing Windows helpers on Linux. Keep unsigned distribution explicit. Treat installer compilation, bundled-file inspection, and Linux streaming-save tests as separate evidence from installation and offline launch on supported native Windows; never report the latter as passing without actually performing it.

## Verify complete published downloads

Installer availability requires a complete GET and checksum match, not just successful HEAD requests, release metadata, or small range reads.

**Why:** The published static handler returned valid headers and small byte ranges for the roughly 107 MB installer, but full downloads returned an empty HTTP 500. The identical file downloaded successfully from the workspace. Header-only checks had missed the actual delivery failure.

**How to apply:** Use bounded streaming delivery for large release files rather than relying on that static handler. Verify the complete response against the release checksum, including the published route after publication. Keep delivery verification separate from native Windows installation/launch verification. Do not infer a fixed platform file-size limit from this observation.