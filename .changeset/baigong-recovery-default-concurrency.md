---
"eve": patch
---

Local Workflow delivery concurrency now defaults to 16, with recovery using at most half the active slots. The recovery waiting buffer defaults to the same limit; both limits remain configurable.
