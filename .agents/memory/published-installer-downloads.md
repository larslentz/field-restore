---
name: Published installer downloads
description: Verify complete installer transfers rather than trusting successful HEAD responses.
---

Verify a published installer's complete GET and final checksum before describing its download as working. A successful HEAD response is insufficient.

**Why:** The published unsigned installer returned HTTP 200 for HEAD but HTTP 500 for a full GET. Bounded HTTP range requests retrieved the complete file with the correct checksum. The precise cause of the full-response failure was not established; do not assume a documented platform file-size limit.

**How to apply:** When investigating installer delivery, check full transfer separately from metadata, HEAD and range responses. A working range download can provide a temporary workaround, but does not establish browser download reliability or native Windows acceptance.