---
name: Browser download completion
description: What a browser-managed download can and cannot confirm after a streamed export.
---

When exporting without a user-selected file handle, describe completion as a download **started** or handed off, not as a verified file save. Keep local stream and rendering errors visible, but do not claim the final WAV was saved to disk merely because its response stream closed.

**Why:** A browser download can be cancelled or fail after the application has supplied the final bytes. Ordinary web pages have no reliable event that confirms the browser finished writing the download.

**How to apply:** Use cautious status text and direct users to the browser's Downloads list for final confirmation; reserve definite “exported” wording for a destination whose close operation the app can verify.