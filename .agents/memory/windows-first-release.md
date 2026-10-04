---
name: First Windows release
description: User-confirmed release history and how first-release update testing differs from missing evidence.
---

The user confirmed that 1.0.0 is the first and only released Windows installer. There is no genuine earlier released installer to use for its cross-version update check.

**Why:** Treating the lack of a predecessor as a failed or blocked first-release test repeatedly requested evidence that could not exist. A same-version reinstall is useful retention evidence, but is not a cross-version update.

**How to apply:** For this first release, record the cross-version update check as not applicable with the user-confirmed reason. For a later release, test upgrading from the genuine 1.0.0 release; a merely unavailable predecessor is not grounds to waive that test. Native acceptance is scoped to the exact tested installer and the Windows version actually reported, independent of signing.