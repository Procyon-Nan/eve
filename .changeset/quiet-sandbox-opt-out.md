---
"eve": patch
---

Add `disableSandbox()` for agent nodes that need no filesystem or process runtime. Disabled nodes pass multimodal attachments directly to the model, omit sandbox-backed framework tools, and reject capabilities that require sandbox files during compilation.
