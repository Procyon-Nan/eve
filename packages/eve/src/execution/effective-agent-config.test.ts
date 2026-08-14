import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  DynamicSubagentAgentConfigKey,
  HostRuntimeContextKey,
  HostRuntimePreflightKey,
} from "#context/keys.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";

describe("resolveEffectiveAgentRuntime", () => {
  it("applies the selected subagent model and runtime settings", () => {
    const ctx = new ContextContainer();
    ctx.set(DynamicSubagentAgentConfigKey, {
      compaction: {
        model: { id: "anthropic/claude-sonnet-4.5" },
        thresholdPercent: 0.75,
      },
      description: "Perform deep research.",
      limits: { sessionTimeoutMs: 120_000 },
      model: { id: "anthropic/claude-opus-4.6" },
      reasoning: "high",
    });
    const tools = [{ name: "search" }];

    const effective = resolveEffectiveAgentRuntime(
      {
        resolvedAgent: {
          config: {
            compaction: { thresholdPercent: 0.9 },
            limits: { sessionTimeoutMs: 60_000 },
          },
        },
        turnAgent: {
          id: "researcher",
          instructions: ["Research carefully."],
          model: { id: "openai/gpt-5.5" },
          tools,
          workspaceSpec: {} as never,
        },
      } as never,
      ctx,
    );

    expect(effective).toMatchObject({
      limits: { sessionTimeoutMs: 120_000 },
      thresholdPercent: 0.75,
      turnAgent: {
        compactionModel: { id: "anthropic/claude-sonnet-4.5" },
        model: { id: "anthropic/claude-opus-4.6" },
        reasoning: "high",
      },
    });
    expect(effective.turnAgent.instructions).toEqual(["Research carefully."]);
    expect(effective.turnAgent.tools).toBe(tools);
  });

  it("uses the resolved host model id for a specialist runtime identity", () => {
    const ctx = new ContextContainer();
    const parent = {
      callId: "call-1",
      rootSessionId: "root-session",
      sessionId: "root-session",
      subagentName: "reviewer",
      turnId: "turn-1",
    } as const;
    const reference = { providerKind: "baigong-agent", value: "specialist-reference" };
    ctx.set(DynamicSubagentAgentConfigKey, {
      description: "Review the work.",
      runtime: {
        kind: "eve.host-runtime",
        parent,
        providerKind: reference.providerKind,
        reference,
      },
    });
    ctx.set(HostRuntimeContextKey, {
      ownership: "specialist",
      parent,
      reference,
    });
    ctx.set(HostRuntimePreflightKey, {
      model: {} as never,
      modelId: "anthropic/claude-sonnet-4.6",
    });

    const effective = resolveEffectiveAgentRuntime(
      {
        resolvedAgent: { config: {} },
        turnAgent: {
          id: "reviewer",
          instructions: [],
          model: { id: "bootstrap" },
          tools: [],
          workspaceSpec: {} as never,
        },
      } as never,
      ctx,
    );

    expect(effective.turnAgent.model).toMatchObject({
      id: "anthropic/claude-sonnet-4.6",
      reference,
      type: "host-runtime",
    });
    expect(effective.turnAgent.compactionModel).toBe(effective.turnAgent.model);
  });
});
