import { describe, expect, it } from "vitest";

import { normalizeResolvedDynamicSubagentDefinition } from "#runtime/resolve-dynamic-subagent.js";
import { defineHostRuntime } from "#public/definitions/agent.js";

describe("normalizeResolvedDynamicSubagentDefinition", () => {
  it("accepts and omits compile-time build configuration", () => {
    const handler = () => null;
    const resolved = normalizeResolvedDynamicSubagentDefinition(
      {
        eventNames: ["session.started"],
        logicalPath: "agent.ts",
        sourceId: "agent.ts",
        sourceKind: "module",
      },
      {
        events: { "session.started": handler },
        kind: "eve:dynamic",
      },
    );

    expect(resolved.events["session.started"]).toBe(handler);
    expect(resolved).not.toHaveProperty("build");
  });

  it("retains a validated turn-scoped host-runtime declaration", () => {
    const handler = () => null;
    const runtime = defineHostRuntime({ providerKind: "baigong-agent" });
    const resolved = normalizeResolvedDynamicSubagentDefinition(
      {
        eventNames: ["turn.started"],
        logicalPath: "agent.ts",
        sourceId: "agent.ts",
        sourceKind: "module",
      },
      {
        events: { "turn.started": handler },
        kind: "eve:dynamic",
        runtime,
      },
    );

    expect(resolved.runtime).toEqual(runtime);
    expect(resolved.events["turn.started"]).toBe(handler);
  });

  it("rejects host-runtime declarations outside turn scope", () => {
    expect(() =>
      normalizeResolvedDynamicSubagentDefinition(
        {
          eventNames: ["session.started"],
          logicalPath: "agent.ts",
          sourceId: "agent.ts",
          sourceKind: "module",
        },
        {
          events: { "session.started": () => null },
          kind: "eve:dynamic",
          runtime: defineHostRuntime({ providerKind: "baigong-agent" }),
        },
      ),
    ).toThrow("Host-runtime subagents may only handle turn.started.");
  });
});
