---
"eve": patch
---

Fix Workflow stream readers reconnecting after cancellation and retaining readers that arrive after cancellation. Release reader locks on completion and failure while preserving cursor-based reconnection for active streams.
