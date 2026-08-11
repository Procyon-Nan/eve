import { describe, expect, it } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { SessionParent } from "#channel/types.js";
import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter-state.js";
import { resolveSubagentSessionInvocation } from "#execution/subagent-session-invocation.js";

const PARENT: SessionParent = {
  callId: "call-researcher",
  rootSessionId: "session-root",
  sessionId: "session-parent",
  turn: { id: "turn-parent", sequence: 3 },
};

function createSubagentAdapter(overrides: Record<string, unknown> = {}): ChannelAdapter {
  return {
    kind: SUBAGENT_ADAPTER_KIND,
    state: {
      callId: PARENT.callId,
      parentContinuationToken: "continuation-parent",
      parentSessionId: PARENT.sessionId,
      subagentName: "researcher",
      ...overrides,
    },
  };
}

describe("resolveSubagentSessionInvocation", () => {
  it("returns undefined for a root session adapter", () => {
    expect(
      resolveSubagentSessionInvocation({
        adapter: { kind: "http" },
        parent: undefined,
      }),
    ).toBeUndefined();
  });

  it("combines parent lineage and adapter state into exact invocation metadata", () => {
    expect(
      resolveSubagentSessionInvocation({
        adapter: createSubagentAdapter(),
        parent: PARENT,
      }),
    ).toEqual({
      kind: "subagent",
      name: "researcher",
      parentCallId: "call-researcher",
      parentSessionId: "session-parent",
      parentTurnId: "turn-parent",
    });
  });

  it("uses the immediate parent while preserving nested lineage isolation", () => {
    const nestedParent: SessionParent = {
      callId: "call-writer",
      rootSessionId: "session-root",
      sessionId: "session-child",
      turn: { id: "turn-child", sequence: 1 },
    };

    expect(
      resolveSubagentSessionInvocation({
        adapter: createSubagentAdapter({
          callId: nestedParent.callId,
          parentSessionId: nestedParent.sessionId,
          subagentName: "writer",
        }),
        parent: nestedParent,
      }),
    ).toEqual({
      kind: "subagent",
      name: "writer",
      parentCallId: "call-writer",
      parentSessionId: "session-child",
      parentTurnId: "turn-child",
    });
  });

  it("fails when the parent context is missing or malformed", () => {
    expect(() =>
      resolveSubagentSessionInvocation({
        adapter: createSubagentAdapter(),
        parent: undefined,
      }),
    ).toThrow("parent session metadata is missing or malformed");

    expect(() =>
      resolveSubagentSessionInvocation({
        adapter: createSubagentAdapter(),
        parent: { ...PARENT, turn: { id: "", sequence: 3 } },
      }),
    ).toThrow("parent session metadata is missing or malformed");
  });

  it("fails when adapter state is missing or malformed", () => {
    for (const adapter of [
      { kind: SUBAGENT_ADAPTER_KIND },
      createSubagentAdapter({ parentSessionId: "" }),
      createSubagentAdapter({ subagentName: null }),
    ]) {
      expect(() => resolveSubagentSessionInvocation({ adapter, parent: PARENT })).toThrow(
        "adapter state is missing or malformed",
      );
    }
  });

  it("fails when the split lineage owners disagree", () => {
    expect(() =>
      resolveSubagentSessionInvocation({
        adapter: createSubagentAdapter({ callId: "call-other" }),
        parent: PARENT,
      }),
    ).toThrow("adapter callId does not match the parent callId");

    expect(() =>
      resolveSubagentSessionInvocation({
        adapter: createSubagentAdapter({ parentSessionId: "session-other" }),
        parent: PARENT,
      }),
    ).toThrow("adapter parentSessionId does not match the parent sessionId");
  });
});
