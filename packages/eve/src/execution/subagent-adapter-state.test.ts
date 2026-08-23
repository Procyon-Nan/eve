import { describe, expect, it } from "vitest";

import { isSubagentAdapterState } from "#execution/subagent-adapter-state.js";

const base = {
  callId: "call-1",
  parentContinuationToken: "parent-token",
  parentSessionId: "parent-1",
  subagentName: "reviewer",
};

describe("subagent adapter state", () => {
  it("accepts exact specialist lineage and rejects malformed host ownership", () => {
    const hostRuntime = {
      parent: {
        callId: "call-1",
        rootSessionId: "root-1",
        sessionId: "parent-1",
        subagentName: "reviewer",
        turnId: "turn-1",
      },
      reference: { providerKind: "baigong-agent", value: "opaque-specialist" },
    };

    expect(isSubagentAdapterState({ ...base, hostRuntime })).toBe(true);
    expect(
      isSubagentAdapterState({
        ...base,
        hostRuntime: { ...hostRuntime, extra: "not allowed" },
      }),
    ).toBe(false);
    expect(
      isSubagentAdapterState({
        ...base,
        hostRuntime: { ...hostRuntime, reference: { ...hostRuntime.reference, value: "" } },
      }),
    ).toBe(false);
  });
});
