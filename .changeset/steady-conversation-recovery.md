---
"eve": patch
---

Keep conversation sessions resumable after model-call failures exhaust their bounded retry budget. Correct the model or provider configuration, then send another message through the same session instead of starting over.
