---
"eve": patch
---

Add an explicit `disableSandbox()` authoring API. Agents that opt out pass inline file parts directly to the model without provisioning a sandbox backend, while file-aware compaction estimates preserve the active user turn and avoid counting encoded attachment bytes as text tokens.
