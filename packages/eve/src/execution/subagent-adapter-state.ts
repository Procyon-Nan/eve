/**
 * Durable state for the subagent adapter, split from the adapter itself so
 * harness code can identify a delegated child run without reaching the
 * adapter's workflow-coupled behavior (`runtime-boundary.test.ts`).
 */
import type { HostRuntimeParentLineage, HostRuntimeReference } from "#shared/host-runtime.js";
import {
  validateHostRuntimeParentLineage,
  validateHostRuntimeReference,
} from "#runtime/host-runtime/validation.js";

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
    typeof state.callId === "string" &&
    state.callId.length > 0 &&
    typeof state.parentContinuationToken === "string" &&
    state.parentContinuationToken.length > 0 &&
    typeof state.parentSessionId === "string" &&
    state.parentSessionId.length > 0 &&
    typeof state.subagentName === "string" &&
    state.subagentName.length > 0 &&
    isHostRuntimeState(state.hostRuntime)
  );
}

function isHostRuntimeState(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "parent") ||
    !Object.hasOwn(record, "reference")
  ) {
    return false;
  }
  try {
    validateHostRuntimeParentLineage(record.parent);
    validateHostRuntimeReference(record.reference);
    return true;
  } catch {
    return false;
  }
}
