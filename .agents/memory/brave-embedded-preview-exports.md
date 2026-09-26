---
name: Brave embedded preview exports
description: A browser-context constraint affecting service-worker-based file downloads in the embedded preview.
---

Standard desktop Brave permits the streaming download service worker in a standalone Field Restore tab, but when the app is embedded as a cross-site iframe on Replit's page, service-worker registration can fail with `NotSupportedError: The user denied permission to use Service Worker.` This is a browser permission boundary, not proof that the WAV stream or report is corrupt.

**Why:** Direct navigation to the proxied development URL and embedding that same URL in a Replit-origin iframe produce different browser permission contexts. A direct-URL check alone cannot validate the embedded preview.

**How to apply:** For browser download verification, distinguish standalone tabs, direct proxied navigation, and actual embedded preview. Do not claim an embedded download completed based on direct proxied navigation; verify the browser's Downloads list and saved bytes in each supported context. If embedded processing needs a first-party browser permission, open a same-origin tab during the user's click and pass bounded chunks across it rather than buffering the full recording in the iframe.