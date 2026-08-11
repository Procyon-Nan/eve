---
issue: TBD
status: in-progress
last_updated: "2026-08-11"
---

# Baigong 0.31 maintenance migration

## Purpose

Move the Baigong-specific runtime contracts from the immutable
`eve@0.27.12-baigong.6` line onto `eve@0.31.2` without rewriting the published
0.27 history or carrying obsolete implementation details across the upstream
runtime refactor.

The old `baigong/0.27-maintenance` branch and its signed releases remain the
rollback line. New work targets `baigong/0.31-maintenance`, created directly
from upstream `eve@0.31.2` (`4719e114`).

## Migration boundary

Only externally required behavior moves forward. Release-only commits,
prerelease bookkeeping, repository-wide line-ending changes, and old
changesets do not move. Each retained behavior is implemented against the
current source and receives current-tier tests.

| 0.27 behavior                                             | Upstream 0.31 state                                                                                                                                                    | Decision                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation model failures remain resumable              | Recoverable failures park, but structural model errors still terminate the session                                                                                     | Retain: use the bounded conversation retry budget and park after exhaustion; keep task-mode terminal semantics                               |
| Explicit `disableSandbox()`                               | Every runtime node still resolves a sandbox and no opt-out authoring API exists                                                                                        | Retain: add an explicit compiled disabled marker and make sandbox-dependent capabilities reject it                                           |
| Disabled-sandbox multimodal attachments                   | Attachment staging and hydration assume the default sandbox path                                                                                                       | Retain: pass accepted inline file parts through when disabled and reject historical `eve-sandbox:` references without provisioning a sandbox |
| File-aware compaction accounting                          | Content-output files are stubbed during compaction, but the threshold estimator still serializes payload bytes and the active user turn is not protected as one region | Retain the estimator and active-turn protections                                                                                             |
| Tool-output file projection to a synthetic user message   | AI SDK 7 and eve's current `ToolModelOutput` contract carry model-facing content file parts directly                                                                   | Retire the projection; preserve one durable tool result without a synthetic duplicate                                                        |
| Projection labels avoid tool replay                       | The retired projection path no longer exists                                                                                                                           | Retire with the projection; cover the direct content-output path instead                                                                     |
| Dynamic Tool `toModelOutput` survives turn/session replay | Live step tools retain the mapper, but durable metadata and replay omit it                                                                                             | Retain: serialize, register, and replay the mapper with its closure snapshot                                                                 |
| Dynamic Tool mapper compiler transform                    | The current transform hoists only `execute`                                                                                                                            | Retain: hoist inline `toModelOutput` functions under the same replay contract                                                                |
| Child `session.started.data.invocation` lineage           | The public type and event factory exist, but the harness does not populate them from the authoritative parent and adapter state                                        | Retain: validate the split lineage owners once and emit the metadata on the child's first event                                              |
| Exact `subagent.called.data.message`                      | The event omits the delegation message; continuation dispatch also converts invalid input to an empty string                                                           | Retain: validate once before side effects and carry the exact string through fresh and continued local/remote dispatch                       |

## Implementation sequence

1. Restore resumable conversation model failures.
2. Add explicit sandbox opt-out and its multimodal/compaction behavior.
3. Restore durable Dynamic Tool model-output mapping.
4. Populate child-session invocation lineage.
5. Add the exact structured delegation message to every successful agent dispatch.

Each stage must pass its focused Unit or Integration files before the next
stage begins. After all stages, run build, typecheck, formatting, lint,
invariant and documentation checks, then the narrow Subagent and attachment
integration suites. Scenario and E2E requirements remain separate because E2E
runs only in CI.

## Release boundary

The first release from the new line is `eve@0.31.2-baigong.0` with signed DCO
commits and a signed immutable tag. Baigong Agent adoption happens only after
the eve tarball, SHA-256, clean install, package version, CLI version, and
public imports have been verified independently.
