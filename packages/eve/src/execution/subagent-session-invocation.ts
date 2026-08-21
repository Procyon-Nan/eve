import type { ChannelAdapter } from "#channel/adapter.js";
import type { SessionParent } from "#channel/types.js";
import {
  isSubagentAdapterState,
  SUBAGENT_ADAPTER_KIND,
} from "#execution/subagent-adapter-state.js";
import type { SubagentSessionInvocationMetadata } from "#protocol/message.js";

/** Resolves the stable invocation metadata emitted by a local subagent session. */
export function resolveSubagentSessionInvocation(
  parent: SessionParent | undefined,
  adapter: ChannelAdapter,
): SubagentSessionInvocationMetadata | undefined {
  if (adapter.kind !== SUBAGENT_ADAPTER_KIND) return undefined;

  if (!isCompleteSessionParent(parent)) {
    throw new Error(
      "Subagent session invocation invariant violated: parent session metadata is missing or malformed.",
    );
  }
  if (!isSubagentAdapterState(adapter.state)) {
    throw new Error(
      "Subagent session invocation invariant violated: adapter state is missing or malformed.",
    );
  }
  if (adapter.state.callId !== parent.callId) {
    throw new Error(
      "Subagent session invocation invariant violated: adapter callId does not match the parent callId.",
    );
  }
  if (adapter.state.parentSessionId !== parent.sessionId) {
    throw new Error(
      "Subagent session invocation invariant violated: adapter parentSessionId does not match the parent sessionId.",
    );
  }

  return {
    kind: "subagent",
    name: adapter.state.subagentName,
    parentCallId: parent.callId,
    parentSessionId: parent.sessionId,
    parentTurnId: parent.turn.id,
  };
}

function isCompleteSessionParent(parent: SessionParent | undefined): parent is SessionParent {
  return (
    parent !== undefined &&
    parent !== null &&
    typeof parent === "object" &&
    typeof parent.callId === "string" &&
    parent.callId.length > 0 &&
    typeof parent.rootSessionId === "string" &&
    parent.rootSessionId.length > 0 &&
    typeof parent.sessionId === "string" &&
    parent.sessionId.length > 0 &&
    typeof parent.turn?.id === "string" &&
    parent.turn.id.length > 0 &&
    Number.isInteger(parent.turn.sequence) &&
    parent.turn.sequence >= 0
  );
}
