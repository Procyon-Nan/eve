---
"eve": patch
---

Use one deadline for persisting and confirming host-runtime acceptance receipts. Receipt waits now query durable acceptance state directly instead of leaving a Workflow return-value poll running after timeout.
