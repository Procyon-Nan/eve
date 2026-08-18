---
"eve": patch
---

Bound finite session snapshot responses at the durable tail observed when each request opens, and release the Workflow stream reader before the response closes. Repeated snapshots and replay cancellations no longer depend on a parked session reaching EOF or on transport cancellation propagating back to the server.
