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

Installing a Python inspection dependency into this Node workspace can scaffold an unrelated root Python project and add native libraries to the Replit configuration.

**Why:** The package installer initializes a Python project when none exists, even when the package is needed only for temporary document inspection.

**How to apply:** After one-off Python inspection, remove installer-created scaffolding and configuration changes that are not part of the deliverable. Do not make the web build depend on inspection-only packages.
