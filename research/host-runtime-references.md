---
issue: TBD
status: in-progress
last_updated: "2026-08-22"
---

# Trusted host runtime references

## Summary

eve needs a trusted, durable reference to runtime configuration owned by an external host. The
reference lets a root turn and an authorized local specialist resolve one locked model,
instruction, tool, timeout, and delegation snapshot without serializing credentials or live model
objects into workflow state.

The downstream eve 0.31 implementation proved this contract, but eve 0.40 has since replaced its
turn driver, subagent dispatch, task ownership, runtime snapshots, and extension contracts. This
work reimplements the behavior on the current architecture. It does not cherry-pick the old file
layout, release metadata, or known defects fixed by the subsequent 0.31 patches.

```text
trusted channel authentication
           |
           v
durable root-turn reference -----> per-model-call preflight
                                      |       |       |
                                      v       v       v
                                    model  instructions tools
                                      |
                                      v
                              authorized specialist
                                      |
                                      v
                         durable specialist reference
                                      |
                                      v
                         terminal settlement and release
```

## Observable contract

### Host-owned reference

```ts
interface HostRuntimeReference {
  readonly providerKind: string;
  readonly value: string;
}

interface ResolvedHostRuntime {
  readonly model: LanguageModel;
  readonly modelId: string;
  readonly contextWindowTokens?: number;
  readonly modelCallTimeoutMs?: number;
  readonly instructions?: string;
  readonly tools?: DynamicToolSet;
  readonly delegatedSubagentNames?: readonly string[];
}
```

`providerKind` selects a provider registered in the active `RuntimeSession`. `value` is an opaque
host token. eve validates its shape but never interprets it. Resolved capabilities are live,
request-scoped values and never enter durable state.

The reference has no arbitrary extension fields. `providerKind` must match
`^[a-z][a-z0-9_-]{0,79}$`; `value` is 1–512 characters. Model identifiers are 1–255 characters,
token limits are positive safe integers, and timeouts are positive integers no greater than
2,147,483,647 milliseconds so the runtime deadline cannot overflow Node.js timers.

### Provider lifecycle

```ts
interface HostRuntimeProvider {
  readonly providerKind: string;
  resolve(input: HostRuntimeResolveInput): Promise<ResolvedHostRuntime>;
  createSpecialistReference?(
    input: SpecialistReferenceFactoryInput,
  ): Promise<HostRuntimeReference>;
  release?(input: HostRuntimeReleaseInput): Promise<void>;
}

registerHostRuntimeProvider(provider): () => void;
```

The active `RuntimeSession` is the only provider-registry owner. Registration rejects duplicate
provider kinds, and the returned disposer removes only its own registration. Tests use
`withRuntimeSession` for isolation.

`createSpecialistReference` is idempotent for the parent session, parent turn, call id, and
subagent name. `release` is an idempotent final notification after eve commits the corresponding
core terminal state. A release failure is logged without rolling that state back.

### Specialist declaration

```ts
defineDynamic({
  runtime: defineHostRuntime({ providerKind: "my-host" }),
  events: {
    "turn.started": () =>
      defineAgent({
        description: "Review delegated work.",
        runtime: defineHostRuntime({ providerKind: "my-host" }),
      }),
  },
});
```

Host-runtime declarations are valid only for dynamic local subagents selected at
`turn.started`. They cannot declare their own model, compaction model, model options, or context
window. Remote agents keep their existing protocol and cannot receive a local host reference.

Only a true top-level root session (`rootSessionId` absent and normalized subagent depth `0`) may
consume `delegatedSubagentNames`. Root-agent copies and specialist sessions receive an empty
effective authorization set even when they inherit a root reference. Selection and dispatch both
enforce this rule.

### Trusted root-turn ingress

The browser request schema, `clientContext`, ordinary auth attributes, authored resolver context,
and model-visible messages do not expose the host reference. A branded server-only authentication
result attaches `{ acceptanceKey, reference }` after the channel has authenticated and authorized
the request.

Each accepted create, send, or respond command atomically records its command, acceptance key, and
root reference before returning success. A trusted status probe returns only `ACCEPTED` or
`NOT_ACCEPTED`. An indeterminate durable read fails instead of reporting `NOT_ACCEPTED`.

Every accepted client-visible logical turn owns a distinct root reference. Cancel, stream, clear,
compact, and reset do not create one. A root-agent copy may inherit the reference for execution but
does not own or release it.

### Unified preflight

Before each model-call assembly, eve resolves and validates the active reference once. The same
preflight value supplies the model, dynamic instructions, ordinary dynamic tools, model timeout,
and effective specialist authorization. A later model step may resolve the same durable reference
again; it cannot select another durable reference for that turn.

The preflight is fail-closed. Deterministic `HOST_RUNTIME_*` errors fail the current root turn or
specialist invocation as a unit and cross the workflow step boundary as non-retryable failures.
Unclassified provider failures retain normal workflow retry behavior. Model-provider failures that
occur after successful preflight retain eve's existing model-call recovery semantics.

`modelCallTimeoutMs` limits one model request, including compaction, and composes with the caller's
abort signal. It does not limit tool execution, human-input waiting, or the entire turn.

## Durable ownership

Durable state stores only validated references, acceptance keys, immutable parent lineage, and
release status. It never stores a resolved `LanguageModel`, tool implementation, instruction text,
credential, or provider exception.

### Root turns

A root reference is released after the owning logical turn commits `completed`, `failed`, or
`cancelled`. Conversation recovery may leave the session waiting, but the failed turn's reference
is still terminal; the next accepted message must provide a new reference. Duplicate terminal
delivery may repeat the same release outcome but cannot change it.

### Specialist calls

A specialist reference belongs to one complete delegated call, not to an individual child turn or
an intermediate `session.waiting` event. The parent call id and durable agent handle remain the
correlation authority.

Plain dispatch releases after the call commits success, failure, cancellation, or start failure.
Task dispatch retains ownership through the delegated task and releases only when the task commits
its terminal outcome. Workflow-originated calls use the same plain-or-task dispatcher and do not
create a second lifecycle. A continuation outside the owning task or call fails closed rather than
silently adopting a released reference.

The specialist factory runs only after the full dispatch batch passes validation and before child
creation. Replays reuse the durable specialist reference. A crash after factory success but before
step commit calls the same idempotent factory key and must receive the same logical reference.

## Stable errors

| Code                                   | Meaning                                                   |
| -------------------------------------- | --------------------------------------------------------- |
| `HOST_RUNTIME_PROVIDER_NOT_REGISTERED` | The active runtime has no matching provider.              |
| `HOST_RUNTIME_REFERENCE_INVALID`       | A reference, acceptance key, or lineage is invalid.       |
| `HOST_RUNTIME_VERSION_UNAVAILABLE`     | The host confirms that the locked version is unavailable. |
| `HOST_RUNTIME_RESOLUTION_FAILED`       | The provider returned an invalid resolved runtime.        |

Error conversion recognizes only eve's exported structured error. Error events and logs include
the stable code, provider kind, and non-secret lineage when useful, but never include the opaque
reference or the provider's untrusted exception text.

## Compatibility boundaries

- Existing static and dynamic model definitions keep their current precedence and behavior.
- Existing local, recursive `agent`, dynamic, and remote subagents remain unchanged when they do
  not declare a host runtime.
- Existing dynamic instruction error isolation remains unchanged outside host preflight.
- Host tools reuse eve's dynamic tool validation, naming, approval, and execution surfaces.
- Native dynamic skills keep their Sandbox requirement. A no-Sandbox host supplies database skill
  loading as ordinary dynamic tools.
- The public event stream, tracing transcript, tool input, and remote-agent wire protocol never
  include the opaque reference.
- Published-package changes receive a patch changeset and new extension capability epochs where
  the public event or authoring type surface changes.

## Implementation progress

The checklist is authoritative for this branch. Each implementation phase updates this section in
the same commit as its code.

- [x] Phase 0: Audit eve 0.40 boundaries and land this execution plan.
- [x] Phase 1: Add contracts, validation, errors, provider registration, and specialist authoring
      types.
- [x] Phase 2: Add trusted root-turn ingress, atomic durable acceptance, and the status probe.
- [x] Phase 3: Add unified preflight, model/instruction/tool composition, and model-call timeout.
- [x] Phase 4: Add top-level specialist authorization, factory creation, durable lineage, and
      replay-safe dispatch for plain, task, and Workflow calls.
- [ ] Phase 5: Add root and specialist terminal release across completed, failed, cancelled, and
      start-failed paths.
- [ ] Phase 6: Complete public documentation, extension compatibility metadata, full validation,
      and final code review.

## Phase gates and commit boundaries

### Phase 0 — plan

Deliver only this research document. Verify frontmatter and repository formatting before the plan
commit.

Commit purpose: `docs(research): 制定宿主运行引用实施方案`.

### Phase 1 — contracts and registration

Add the host-runtime data contracts, strict validators, structured errors, and the provider
registry on `RuntimeSession`. Extend `defineAgent` and dynamic local subagent normalization without
changing runtime execution yet. Cover duplicate registration, disposal ownership, validation,
exact authoring types, unsupported event scopes, and compatibility with existing definitions.

Gate: focused unit tests, public type tests, eve typecheck, lint, invariants, formatting, and diff
checks.

Commit purpose: `feat(runtime): 增加宿主运行引用公共契约`.

### Phase 2 — trusted acceptance

Add a non-enumerable, branded channel-auth handoff for `{ acceptanceKey, reference }`. Carry it
through new-session and existing-session create, send, and respond paths into versioned durable
turn input. Add the server-only acceptance probe and distinguish confirmed rejection from an
indeterminate durable read. Keep ordinary clients, auth attributes, and authored context unchanged.

Gate: unit and integration coverage for create/send/respond, duplicate acceptance keys, atomic
acceptance, probe authorization, serialization boundaries, and secret non-disclosure.

Commit purpose: `feat(channels): 支持可信宿主运行引用接收`.

### Phase 3 — preflight and capability composition

Resolve the active reference once before dynamic model, instruction, tool, and subagent assembly.
Expose capability-specific helpers without exposing the raw value to authored code. Integrate the
resolved model and context window with effective agent configuration, and compose the per-call
timeout with cancellation. Convert deterministic host errors at the current workflow step boundary
without reclassifying ordinary provider or model-call errors.

Gate: focused unit and integration tests for single-flight resolution, atomic failure, no fallback,
multi-step recovery, compaction timeout, abort composition, and ordinary dynamic compatibility.

Commit purpose: `feat(execution): 统一解析宿主运行能力`.

### Phase 4 — specialist creation and dispatch

Compute effective specialist authorization only for a true top-level root. Persist an explicit null
selection for unauthorized host specialists, recheck authorization at dispatch, call the provider
factory with stable lineage, and store the resulting reference before child creation. Propagate the
reference through local child input and adapter state. Plain, task, and Workflow dispatch share one
factory and replay contract.

Gate: local/dynamic/parallel dispatch tests, unauthorized and nested-session tests, factory replay
tests, tasks tests, Workflow tests, compile/build tests, and secret non-disclosure assertions.

Commit purpose: `feat(execution): 支持宿主运行专业 Agent 委派`.

### Phase 5 — terminal ownership and release

Add one settlement owner for each root turn and delegated specialist call. Record the release
outcome durably before best-effort provider notification. Cover completed, failed, cancelled,
start-failed, replayed, task-owned, proxy-HITL, reset, and termination paths without releasing on an
intermediate child waiting event.

Gate: terminal-path integration tests, cancellation and task tests, replay tests, release-failure
tests, session continuation tests, and handle/concurrency settlement assertions.

Commit purpose: `fix(execution): 完成宿主运行引用生命周期结算`.

### Phase 6 — documentation and full review

Update the current dynamic capability, subagent, TypeScript API, and skill documentation from the
final source. Generate required extension compatibility fixtures and reports, add the patch
changeset, and run repository-wide checks. Review the complete Phase 1–6 range against this plan,
the public contract, security boundaries, state ownership, task semantics, and replay behavior.

Gate: focused suites, `pnpm test:unit`, `pnpm test:integration`, relevant scenario tests,
`pnpm typecheck`, `pnpm lint`, `pnpm fmt`, `pnpm guard:invariants`, `pnpm docs:check`, build, package
smoke test, and `git diff --check`. CI-only e2e and real-host acceptance remain explicitly pending
until push and downstream integration.

Commit purpose: `docs(eve): 完善宿主运行引用文档与兼容契约`.

## Final review criteria

The implementation is complete only when the final review confirms all of the following:

1. One durable owner exists for every root and specialist reference.
2. Every terminal path records one stable outcome before best-effort release.
3. Resolved runtime values are request-scoped and never serialized.
4. The opaque reference is absent from public events, model input, tools, tracing, and logs.
5. Top-level authorization is enforced before resolver execution and again before dispatch.
6. Plain, tasks, Workflow, replay, cancellation, and proxy-HITL paths obey the same ownership
   contract.
7. Existing non-host applications retain their current behavior.
8. Automated checks are reported separately from CI e2e and downstream real-host acceptance.
