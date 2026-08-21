import { describe, expect, it } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { SessionParent } from "#channel/types.js";
import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter-state.js";
import { resolveSubagentSessionInvocation } from "#execution/subagent-session-invocation.js";

const parent: SessionParent = {
  callId: "call-1",
  rootSessionId: "root-1",
  sessionId: "session-1",
  turn: { id: "turn-1", sequence: 0 },
};

function subagentAdapter(overrides: Record<string, unknown> = {}): ChannelAdapter {
  return {
    kind: SUBAGENT_ADAPTER_KIND,
    state: {
      callId: parent.callId,
      parentContinuationToken: "token-1",
      parentSessionId: parent.sessionId,
      subagentName: "researcher",
      ...overrides,
    },
  };
}

describe("resolveSubagentSessionInvocation", () => {
  it("combines immediate parent lineage with the subagent name", () => {
    expect(resolveSubagentSessionInvocation(parent, subagentAdapter())).toEqual({
      kind: "subagent",
      name: "researcher",
      parentCallId: "call-1",
      parentSessionId: "session-1",
      parentTurnId: "turn-1",
    });
  });

  it("uses the immediate parent for a nested subagent", () => {
    const nestedParent: SessionParent = {
      callId: "call-nested",
      rootSessionId: parent.rootSessionId,
      sessionId: "session-child",
      turn: { id: "turn-child", sequence: 2 },
    };

    expect(
      resolveSubagentSessionInvocation(
        nestedParent,
        subagentAdapter({
          callId: nestedParent.callId,
          parentSessionId: nestedParent.sessionId,
          subagentName: "writer",
        }),
      ),
    ).toEqual({
      kind: "subagent",
      name: "writer",
      parentCallId: "call-nested",
      parentSessionId: "session-child",
      parentTurnId: "turn-child",
    });
  });

  it("omits invocation metadata for root adapters", () => {
    expect(resolveSubagentSessionInvocation(undefined, { kind: "http" })).toBeUndefined();
  });

  it("rejects malformed or inconsistent subagent lineage", () => {
    expect(() => resolveSubagentSessionInvocation(undefined, subagentAdapter())).toThrow(
      "parent session metadata is missing or malformed",
    );
    expect(() =>
      resolveSubagentSessionInvocation(parent, subagentAdapter({ parentSessionId: "" })),
    ).toThrow("adapter state is missing or malformed");
    expect(() =>
      resolveSubagentSessionInvocation(parent, subagentAdapter({ callId: "call-other" })),
    ).toThrow("adapter callId does not match the parent callId");
    expect(() =>
      resolveSubagentSessionInvocation(
        parent,
        subagentAdapter({ parentSessionId: "session-other" }),
      ),
    ).toThrow("adapter parentSessionId does not match the parent sessionId");
  });
});
