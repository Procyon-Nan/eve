import { describe, expect, it } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { SessionParent } from "#channel/types.js";
import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter.js";
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
  it("returns undefined for a non-subagent adapter", () => {
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

  it("fails when the adapter call id disagrees with the parent", () => {
    expect(() =>
      resolveSubagentSessionInvocation({
        adapter: createSubagentAdapter({ callId: "call-other" }),
        parent: PARENT,
      }),
    ).toThrow("adapter callId does not match the parent callId");
  });

  it("fails when the adapter parent session id disagrees with the parent", () => {
    expect(() =>
      resolveSubagentSessionInvocation({
        adapter: createSubagentAdapter({ parentSessionId: "session-other" }),
        parent: PARENT,
      }),
    ).toThrow("adapter parentSessionId does not match the parent sessionId");
  });

  it("keeps sibling child invocation metadata isolated", () => {
    const secondParent: SessionParent = {
      callId: "call-writer",
      rootSessionId: "session-root",
      sessionId: "session-parent-2",
      turn: { id: "turn-parent-2", sequence: 7 },
    };

    const researcher = resolveSubagentSessionInvocation({
      adapter: createSubagentAdapter(),
      parent: PARENT,
    });
    const writer = resolveSubagentSessionInvocation({
      adapter: createSubagentAdapter({
        callId: secondParent.callId,
        parentSessionId: secondParent.sessionId,
        subagentName: "writer",
      }),
      parent: secondParent,
    });

    expect(researcher).toMatchObject({
      name: "researcher",
      parentCallId: "call-researcher",
      parentSessionId: "session-parent",
      parentTurnId: "turn-parent",
    });
    expect(writer).toMatchObject({
      name: "writer",
      parentCallId: "call-writer",
      parentSessionId: "session-parent-2",
      parentTurnId: "turn-parent-2",
    });
  });
});
