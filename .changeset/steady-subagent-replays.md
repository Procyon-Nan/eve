---
"eve": patch
---

Local subagent starts now recover the existing child session when an at-least-once Workflow delivery replays after creation. Replay validates the full parent and Host Runtime lineage, cancels concurrent losing sessions, and keeps specialist references owned by exactly one child.
