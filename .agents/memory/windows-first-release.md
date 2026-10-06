---
name: First Windows release
description: User-confirmed release history and how first-release update testing differs from missing evidence.
---

The user stated on October 6, 2026 that Field Restore has not yet been publicly released. Treat the existing 1.0.0 installer as a pre-release candidate, not as a released predecessor.

**Why:** The user clarified that installer availability does not mean the product has launched. A pre-release installer must not be described as an earlier public release.

**How to apply:** Do not treat the existing installer as a public predecessor when planning release or upgrade tests. Keep native Windows acceptance scoped to the exact tested installer and Windows version, independent of signing.

While the product is unreleased, replace the existing installer in place without archiving an older binary or advancing the product version. Keep the numeric internal packaging value; this is not a public release history.

**Why:** The user explicitly requested overwriting the current candidate, not keeping the old one, and avoiding version bumps before launch. Windows/Electron packaging still requires a numeric version.

**How to apply:** Refresh checksum metadata whenever the bytes change, even when the filename/version stays the same. Earlier native test evidence never transfers to the replacement binary.