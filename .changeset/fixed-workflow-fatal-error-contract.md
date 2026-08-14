---
"eve": patch
---

Restore the Workflow bundle's complete `FatalError` contract so host-runtime Turn failures retain their original classification instead of being replaced by a `TypeError` and terminating the session. Host-runtime preflight snapshots now also remain available after framework providers initialize the model step.
