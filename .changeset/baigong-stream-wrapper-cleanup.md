---
"eve": patch
---

Cancel active source streams when NDJSON parsing fails and wait for cancellation cleanup before releasing reader locks. Session tail-index queries now read stream metadata directly without opening a live reader.
