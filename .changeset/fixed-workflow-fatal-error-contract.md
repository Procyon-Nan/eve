---
"eve": patch
---

Restore the Workflow bundle's complete `FatalError` contract so host-runtime Turn failures retain their original classification instead of being replaced by a `TypeError` and terminating the session. Host-runtime preflight snapshots now remain available after framework providers initialize the model step, and delegated specialist workflows preserve their durable host-runtime reference during session creation.
