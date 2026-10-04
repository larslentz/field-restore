---
name: Windows packaging
description: Distinguish cross-building from native verification, and avoid unreliable Wine helper prerequisites on this host.
---

A successful Wine version check is not enough to establish that Windows installer helpers can execute on this Replit host. Prefer native NSIS compilation for unsigned full installers, or an actual Windows build runner when Windows-specific tooling is required.

**Why:** The classic 32-bit Wine loader could not execute in this container, and newer WoW64 bootstrap attempts stalled even with a virtual display. These are environment constraints, not proof that the application or compiled installer is broken.

**How to apply:** Build the complete local runtime without executing Windows helpers on Linux. Keep unsigned distribution explicit. Treat installer compilation, bundled-file inspection, and Linux streaming-save tests as separate evidence from installation and offline launch on supported native Windows; never report the latter as passing without actually performing it.