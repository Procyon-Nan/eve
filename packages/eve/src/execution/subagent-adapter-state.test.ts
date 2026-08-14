import { describe, expect, it } from "vitest";

import { isSubagentAdapterState } from "#execution/subagent-adapter-state.js";

describe("isSubagentAdapterState", () => {
  const base = {
    callId: "call-1",
    parentContinuationToken: "parent-token",
    parentSessionId: "parent-session",
    subagentName: "reviewer",
  };

  it("validates durable specialist host-runtime lineage", () => {
    expect(
      isSubagentAdapterState({
        ...base,
        hostRuntime: {
          parent: {
            callId: "call-1",
            rootSessionId: "root-session",
            sessionId: "parent-session",
            subagentName: "reviewer",
            turnId: "turn-1",
          },
          reference: { providerKind: "baigong-agent", value: "specialist-reference" },
        },
      }),
    ).toBe(true);
  });

  it("rejects empty lineage and invalid provider namespaces", () => {
    expect(isSubagentAdapterState({ ...base, callId: "" })).toBe(false);
    expect(
      isSubagentAdapterState({
        ...base,
        hostRuntime: {
          parent: {
            callId: "call-1",
            rootSessionId: "root-session",
            sessionId: "parent-session",
            subagentName: "reviewer",
            turnId: "turn-1",
          },
          reference: { providerKind: "Invalid Provider", value: "specialist-reference" },
        },
      }),
    ).toBe(false);
  });
});
