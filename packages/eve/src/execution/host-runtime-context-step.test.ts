import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { HostRuntimeContextKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { readActiveRootHostRuntime } from "#execution/host-runtime-context.js";
import { installTurnHostRuntimeStep } from "#execution/host-runtime-context-step.js";

const parent = {
  callId: "call-agent",
  rootSessionId: "root-session",
  sessionId: "parent-session",
  subagentName: "agent",
  turnId: "turn-parent",
} as const;

describe("installTurnHostRuntimeStep", () => {
  it("replaces an inherited reference without acquiring root release ownership", async () => {
    const ctx = new ContextContainer();
    ctx.set(HostRuntimeContextKey, {
      ownership: "inherited",
      parent,
      reference: { providerKind: "baigong-agent", value: "old-reference" },
    });

    const serialized = await installTurnHostRuntimeStep({
      hostRuntime: {
        ownership: "inherited",
        parent,
        reference: { providerKind: "baigong-agent", value: "new-reference" },
      },
      serializedContext: serializeContext(ctx),
    });
    const restored = await deserializeContext(serialized);

    expect(restored.get(HostRuntimeContextKey)).toEqual({
      ownership: "inherited",
      parent,
      reference: { providerKind: "baigong-agent", value: "new-reference" },
    });
    expect(readActiveRootHostRuntime(serialized)).toBeUndefined();
  });

  it("rejects malformed inherited parent lineage before it reaches a provider", async () => {
    await expect(
      installTurnHostRuntimeStep({
        hostRuntime: {
          ownership: "inherited",
          parent: { ...parent, injected: "unexpected" } as typeof parent,
          reference: { providerKind: "baigong-agent", value: "new-reference" },
        },
        serializedContext: serializeContext(new ContextContainer()),
      }),
    ).rejects.toMatchObject({ code: "HOST_RUNTIME_REFERENCE_INVALID" });
  });

  it("clears a stale inherited reference when the new logical turn has no runtime", async () => {
    const ctx = new ContextContainer();
    ctx.set(HostRuntimeContextKey, {
      ownership: "inherited",
      parent,
      reference: { providerKind: "baigong-agent", value: "old-reference" },
    });

    const serialized = await installTurnHostRuntimeStep({
      hostRuntime: undefined,
      serializedContext: serializeContext(ctx),
    });
    const restored = await deserializeContext(serialized);

    expect(restored.get(HostRuntimeContextKey)).toBeUndefined();
  });
});
