import { readParentLineage } from "#execution/eve-workflow-attributes.js";
import {
  SUBAGENT_ADAPTER_KIND,
  isSubagentAdapterState,
} from "#execution/subagent-adapter-state.js";
import type { LocalSubagentStartIdentity } from "#execution/subagent-tool.js";
import {
  WorkflowSessionStartInvalidError,
  type WorkflowRuntime,
  type WorkflowSessionStartSnapshot,
} from "#execution/workflow-runtime.js";
import {
  validateHostRuntimeParentLineage,
  validateHostRuntimeReference,
} from "#runtime/host-runtime/validation.js";
import type { HostRuntimeParentLineage, HostRuntimeReference } from "#shared/host-runtime.js";

export interface RecoveredLocalSubagentStart {
  readonly sessionId: string;
  readonly specialistHostRuntime?: {
    readonly parent: HostRuntimeParentLineage;
    readonly reference: HostRuntimeReference;
  };
}

export class LocalSubagentStartClaimConflictError extends Error {
  readonly ownerSessionId: string;

  constructor(ownerSessionId: string) {
    super(`Local subagent start owner "${ownerSessionId}" does not match the requested identity.`);
    this.name = "LocalSubagentStartClaimConflictError";
    this.ownerSessionId = ownerSessionId;
  }
}

export async function resolveLocalSubagentStartClaim(input: {
  readonly identity: LocalSubagentStartIdentity;
  readonly runtime: Pick<WorkflowRuntime, "inspectSessionStart" | "resolveContinuation">;
  readonly specialistProviderKind?: string;
}): Promise<RecoveredLocalSubagentStart | undefined> {
  const owner = await input.runtime.resolveContinuation(input.identity.continuationToken);
  if (owner === undefined) return undefined;
  return await recoverLocalSubagentStartClaim({
    ...input,
    ownerSessionId: owner.sessionId,
  });
}

export async function recoverLocalSubagentStartClaim(input: {
  readonly identity: LocalSubagentStartIdentity;
  readonly ownerSessionId: string;
  readonly runtime: Pick<WorkflowRuntime, "inspectSessionStart">;
  readonly specialistProviderKind?: string;
}): Promise<RecoveredLocalSubagentStart> {
  let snapshot: WorkflowSessionStartSnapshot;
  try {
    snapshot = await input.runtime.inspectSessionStart(input.ownerSessionId);
  } catch (error) {
    if (!(error instanceof WorkflowSessionStartInvalidError)) throw error;
    throw new LocalSubagentStartClaimConflictError(input.ownerSessionId);
  }
  try {
    return inspectLocalSubagentStartClaim({ ...input, snapshot });
  } catch (error) {
    if (error instanceof LocalSubagentStartClaimConflictError) throw error;
    throw new LocalSubagentStartClaimConflictError(input.ownerSessionId);
  }
}

function inspectLocalSubagentStartClaim(input: {
  readonly identity: LocalSubagentStartIdentity;
  readonly ownerSessionId: string;
  readonly snapshot: WorkflowSessionStartSnapshot;
  readonly specialistProviderKind?: string;
}): RecoveredLocalSubagentStart {
  const { attributes, serializedContext } = input.snapshot;
  const lineage = readParentLineage(serializedContext);
  const channel = serializedContext["eve.channel"] as
    | { readonly kind?: unknown; readonly state?: unknown }
    | undefined;
  const adapterState = channel?.state;

  if (
    serializedContext["eve.continuationToken"] !== input.identity.continuationToken ||
    attributes["$eve.type"] !== "subagent" ||
    attributes["$eve.parent"] !== input.identity.parentSessionId ||
    attributes["$eve.parent_turn"] !== input.identity.parentTurnId ||
    attributes["$eve.parent_call"] !== input.identity.callId ||
    attributes["$eve.root"] !== input.identity.rootSessionId ||
    attributes["$eve.subagent"] !== input.identity.nodeId ||
    lineage.sessionId !== input.identity.parentSessionId ||
    lineage.turnId !== input.identity.parentTurnId ||
    lineage.callId !== input.identity.callId ||
    lineage.rootSessionId !== input.identity.rootSessionId ||
    channel?.kind !== SUBAGENT_ADAPTER_KIND ||
    !isSubagentAdapterState(adapterState) ||
    adapterState.callId !== input.identity.callId ||
    adapterState.parentSessionId !== input.identity.parentSessionId ||
    adapterState.subagentName !== input.identity.subagentName
  ) {
    throw new LocalSubagentStartClaimConflictError(input.ownerSessionId);
  }

  const durableHostRuntime = serializedContext["eve.hostRuntime"] as
    | {
        readonly ownership?: unknown;
        readonly parent?: unknown;
        readonly reference?: unknown;
      }
    | undefined;
  if (input.specialistProviderKind === undefined) {
    if (durableHostRuntime?.ownership === "specialist" || adapterState.hostRuntime !== undefined) {
      throw new LocalSubagentStartClaimConflictError(input.ownerSessionId);
    }
    return { sessionId: input.ownerSessionId };
  }

  if (durableHostRuntime?.ownership !== "specialist" || adapterState.hostRuntime === undefined) {
    throw new LocalSubagentStartClaimConflictError(input.ownerSessionId);
  }

  let parent: HostRuntimeParentLineage;
  let reference: HostRuntimeReference;
  let adapterParent: HostRuntimeParentLineage;
  let adapterReference: HostRuntimeReference;
  try {
    parent = validateHostRuntimeParentLineage(durableHostRuntime.parent);
    reference = validateHostRuntimeReference(durableHostRuntime.reference);
    adapterParent = validateHostRuntimeParentLineage(adapterState.hostRuntime.parent);
    adapterReference = validateHostRuntimeReference(adapterState.hostRuntime.reference);
  } catch {
    throw new LocalSubagentStartClaimConflictError(input.ownerSessionId);
  }
  const expectedParent: HostRuntimeParentLineage = {
    callId: input.identity.callId,
    rootSessionId: input.identity.rootSessionId,
    sessionId: input.identity.parentSessionId,
    subagentName: input.identity.subagentName,
    turnId: input.identity.parentTurnId,
  };
  if (
    reference.providerKind !== input.specialistProviderKind ||
    !sameParent(parent, expectedParent) ||
    !sameParent(adapterParent, expectedParent) ||
    !sameReference(adapterReference, reference)
  ) {
    throw new LocalSubagentStartClaimConflictError(input.ownerSessionId);
  }

  return {
    sessionId: input.ownerSessionId,
    specialistHostRuntime: { parent, reference },
  };
}

function sameParent(left: HostRuntimeParentLineage, right: HostRuntimeParentLineage): boolean {
  return (
    left.callId === right.callId &&
    left.rootSessionId === right.rootSessionId &&
    left.sessionId === right.sessionId &&
    left.subagentName === right.subagentName &&
    left.turnId === right.turnId
  );
}

function sameReference(left: HostRuntimeReference, right: HostRuntimeReference): boolean {
  return left.providerKind === right.providerKind && left.value === right.value;
}
