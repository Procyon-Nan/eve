---
"eve": patch
---

Fix local stream readers silently skipping chunks after file read failures. Failed reads now report an error and release their listeners and polling timer, while concurrent disk reads and live events are deduplicated before delivery.
