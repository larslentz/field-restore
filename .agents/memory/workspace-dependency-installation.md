---
name: Workspace dependency installation
description: Package-tool limitations in this pnpm workspace and the release-age guard.
---

The package-install callback operates at the workspace root and rejects package-manager flags such as a workspace filter. It cannot directly target this artifact package.

**Why:** Root installation fails pnpm's workspace-root check, while passing a filter fails the callback's package-token validation.

**How to apply:** When that limitation still applies, add the dependency to the intended artifact manifest and resolve the workspace lockfile with pnpm for that package. Do not introduce an unnecessary root runtime dependency.

Respect the package release-age policy: pin a mature compatible release rather than disabling the guard to install the newest version.

**Why:** A registry's latest version can exist but still be intentionally ineligible for installation in this workspace.

**How to apply:** Check publication times before selecting another version after a maturity rejection.
