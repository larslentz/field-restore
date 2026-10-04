---
name: Editable project backup boundaries
description: Product constraints for portable local backups and source access.
---

Editable backups are explicit local files, not cloud sync, automatic browser-to-desktop migration, or WAV/report exports. Browser and desktop storage must stay independent.

**Why:** The user requires a way to recover editable work after site-data loss without introducing uploads or automatic migration.

**How to apply:** Keep backups usable offline. Large source recordings stay external and are verified with bounded fingerprints; browser file handles must never be treated as portable permissions.

Description-draft recovery remains an explicit action separate from backing up, restoring, and Save project.

**Why:** Unfinished writing must not silently overwrite saved project text or follow the wrong source.

**How to apply:** Back up the currently selected description text without normalizing whitespace. Require resolving pending draft recovery before export; importing a backup may offer a local draft but must not apply or delete it automatically.

Relinking must preserve the restored project's storage authority, even when the selected recording is small enough for an older embedded-audio save path.

**Why:** Saving new edits into a second store leaves an older authoritative project that can silently win on the next reload.

**How to apply:** Keep restored projects on one persistence path across relink, subsequent saves, and reopening; source size alone must not switch that authority.