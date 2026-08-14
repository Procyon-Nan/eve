/**
 * Durable state for the subagent adapter, split from the adapter itself so
 * harness code can identify a delegated child run without reaching the
 * adapter's workflow-coupled behavior (`runtime-boundary.test.ts`).
 */
import type { HostRuntimeParentLineage, HostRuntimeReference } from "#shared/host-runtime.js";

/**
 * Durable adapter kind used for delegated subagent child runs.
 *
 * Framework-owned — authored channel code never constructs a subagent
 * adapter directly. Emitted by `buildSubagentRunInput`
 * (`execution/subagent-tool.ts`) when a parent dispatches a child
 * subagent.
 */
export const SUBAGENT_ADAPTER_KIND = "subagent";

/**
 * Durable state carried on a subagent adapter instance.
 *
 * Populated by `buildSubagentRunInput` at dispatch time so the child
 * run retains the parent lineage metadata required to resume its parent
 * when the child finishes and to forward HITL requests up the chain.
 *
 * The parent's turn identifier is not duplicated here — it lives on
 * `RunInput.parent.turn.id` which is the single source of truth for the
 * child's parent-turn lineage.
 */
export interface SubagentAdapterState extends Record<string, unknown> {
  readonly callId: string;
  readonly parentContinuationToken: string;
  readonly parentSessionId: string;
  readonly subagentName: string;
  readonly hostRuntime?: {
    readonly parent: HostRuntimeParentLineage;
    readonly reference: HostRuntimeReference;
  };
}

/**
 * Narrow runtime guard for {@link SubagentAdapterState}.
 *
 * Framework adapters live through a JSON round-trip at every workflow
 * step boundary, so consumers that want to treat the adapter state as
 * a structured record must validate the shape explicitly.
 */
export function isSubagentAdapterState(value: unknown): value is SubagentAdapterState {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const state = value as Partial<SubagentAdapterState>;

  return (
    isNonEmptyString(state.callId) &&
    isNonEmptyString(state.parentContinuationToken) &&
    isNonEmptyString(state.parentSessionId) &&
    isNonEmptyString(state.subagentName) &&
    isHostRuntimeState(state.hostRuntime)
  );
}

function isHostRuntimeState(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object") return false;
  const state = value as {
    readonly parent?: Partial<HostRuntimeParentLineage>;
    readonly reference?: Partial<HostRuntimeReference>;
  };
  return (
    typeof state.reference?.providerKind === "string" &&
    /^[a-z][a-z0-9_-]{0,79}$/.test(state.reference.providerKind) &&
    isNonEmptyString(state.reference.value) &&
    state.reference.value.length <= 512 &&
    isNonEmptyString(state.parent?.rootSessionId) &&
    isNonEmptyString(state.parent.sessionId) &&
    isNonEmptyString(state.parent.turnId) &&
    isNonEmptyString(state.parent.callId) &&
    isNonEmptyString(state.parent.subagentName)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
