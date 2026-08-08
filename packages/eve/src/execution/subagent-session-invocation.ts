import type { ChannelAdapter } from "#channel/adapter.js";
import type { SessionParent } from "#channel/types.js";
import { isSubagentAdapterState, SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
import type { SubagentSessionInvocationMetadata } from "#protocol/message.js";

/**
 * Resolves the authoritative parent invocation metadata for a local subagent session.
 *
 * @internal
 */
export function resolveSubagentSessionInvocation(input: {
  readonly adapter: ChannelAdapter;
  readonly parent: SessionParent | undefined;
}): SubagentSessionInvocationMetadata | undefined {
  if (input.adapter.kind !== SUBAGENT_ADAPTER_KIND) {
    return undefined;
  }

  const parent = input.parent;
  if (!isCompleteSessionParent(parent)) {
    throw new Error(
      "Subagent session invocation invariant violated: parent session metadata is missing or malformed.",
    );
  }

  const state = input.adapter.state;
  if (!isSubagentAdapterState(state)) {
    throw new Error(
      "Subagent session invocation invariant violated: adapter state is missing or malformed.",
    );
  }

  if (state.callId !== parent.callId) {
    throw new Error(
      "Subagent session invocation invariant violated: adapter callId does not match the parent callId.",
    );
  }

  if (state.parentSessionId !== parent.sessionId) {
    throw new Error(
      "Subagent session invocation invariant violated: adapter parentSessionId does not match the parent sessionId.",
    );
  }

  return {
    kind: "subagent",
    name: state.subagentName,
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
    parent.turn !== null &&
    typeof parent.turn === "object" &&
    typeof parent.turn.id === "string" &&
    parent.turn.id.length > 0 &&
    Number.isInteger(parent.turn.sequence) &&
    parent.turn.sequence >= 0
  );
}
