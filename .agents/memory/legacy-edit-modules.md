---
name: Legacy edit modules
description: Compatibility rule for processors removed from the add-module menu.
---

Removing an edit type from the add-module menu should not remove its processing, controls, or saved-preset compatibility unless an explicit migration is planned.

**Why:** Existing user projects and presets can contain edit types that are no longer offered for new additions. Dropping support would silently change their audio or prevent restoration.

**How to apply:** Separate which modules users can newly add from which modules the engine can load, edit, process, and export. Keep older instances functional unless a safe migration is required.