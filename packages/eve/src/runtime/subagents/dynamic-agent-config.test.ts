import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { defineAgent, defineHostRuntime } from "#public/definitions/agent.js";
import { normalizeDynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";

describe("normalizeDynamicSubagentAgentConfig", () => {
  it("normalizes a host-runtime specialist without resolving a durable model", async () => {
    const runtime = defineHostRuntime({ providerKind: "baigong-agent" });
    const config = await normalizeDynamicSubagentAgentConfig({
      name: "reviewer",
      state: new ContextContainer(),
      value: defineAgent({
        compaction: { thresholdPercent: 0.8 },
        description: "Review delegated work.",
        runtime,
      }),
    });

    expect(config).toEqual({
      compaction: { thresholdPercent: 0.8 },
      description: "Review delegated work.",
      runtime,
    });
    expect(config.model).toBeUndefined();
  });
});
