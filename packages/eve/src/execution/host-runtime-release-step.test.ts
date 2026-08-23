import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { HostRuntimeContextKey, SessionIdKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { installRootHostRuntimeStep } from "#execution/host-runtime-context-step.js";
import { readActiveRootHostRuntime } from "#execution/host-runtime-finalization.js";
import { recordTerminalTaskViewsStep } from "#execution/tasks/parent/hitl-proxy-steps.js";
import {
  notifyRootHostRuntimeReleaseStep,
  recordRootHostRuntimeReleaseStep,
  settleHostRuntimeReleasesStep,
  settleTerminatedHostRuntimeHandlesStep,
} from "#execution/host-runtime-release-step.js";
import { AGENT_HANDLES_STATE_KEY, type AgentHandle } from "#harness/handles/store.js";
import {
  enqueueHostRuntimeRelease,
  readPendingHostRuntimeReleases,
} from "#harness/host-runtime-releases.js";
import type { HarnessSession } from "#harness/types.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import type { HostRuntimeProvider } from "#shared/host-runtime.js";

const reference = { providerKind: "baigong-agent", value: "opaque-reference" } as const;
const parent = {
  callId: "call-1",
  rootSessionId: "root-session",
  sessionId: "parent-session",
  subagentName: "reviewer",
  turnId: "turn-1",
} as const;

function createSession(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: { modelReference: { id: "model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 4, threshold: 1_000 },
    continuationToken: "continuation",
    history: [],
    sessionId: "parent-session",
    state,
  };
}

function createRootContext(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "root-session");
  ctx.set(HostRuntimeContextKey, {
    acceptanceKey: "acceptance-1",
    ownership: "root",
    reference,
  });
  return ctx;
}

function createProvider(release: NonNullable<HostRuntimeProvider["release"]>): HostRuntimeProvider {
  return {
    providerKind: reference.providerKind,
    release,
    resolve: vi.fn(),
  };
}

describe("root host runtime release", () => {
  it("retains only an unreleased root reference for internal authorization delivery", () => {
    const active = serializeContext(createRootContext());
    expect(readActiveRootHostRuntime(active)).toMatchObject({ ownership: "root", reference });
    expect(
      readActiveRootHostRuntime({
        ...active,
        "eve.hostRuntime": {
          acceptanceKey: "acceptance-1",
          ownership: "root",
          reference,
          releasedOutcome: "completed",
        },
      }),
    ).toBeUndefined();
  });

  it("replaces a released root reference for the next accepted turn", async () => {
    const previous = createRootContext();
    previous.set(HostRuntimeContextKey, {
      acceptanceKey: "acceptance-1",
      ownership: "root",
      reference,
      releasedOutcome: "completed",
    });
    const next = {
      acceptanceKey: "acceptance-2",
      ownership: "root" as const,
      reference: { ...reference, value: "next-opaque-reference" },
    };

    const serialized = await installRootHostRuntimeStep({
      hostRuntime: next,
      serializedContext: serializeContext(previous),
    });

    expect((await deserializeContext(serialized)).get(HostRuntimeContextKey)).toEqual(next);
  });

  it("removes released root ownership when the next delivery has no reference", async () => {
    const previous = createRootContext();
    previous.set(HostRuntimeContextKey, {
      acceptanceKey: "acceptance-1",
      ownership: "root",
      reference,
      releasedOutcome: "completed",
    });

    const serialized = await installRootHostRuntimeStep({
      serializedContext: serializeContext(previous),
    });

    expect((await deserializeContext(serialized)).get(HostRuntimeContextKey)).toBeUndefined();
  });

  it("commits the stable outcome before notifying the provider", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const runtime = createRuntimeSession("root-release");
    runtime.hostRuntimeProviders.set(reference.providerKind, createProvider(release));

    await withRuntimeSession(runtime, async () => {
      const recorded = await recordRootHostRuntimeReleaseStep({
        outcome: "completed",
        serializedContext: serializeContext(createRootContext()),
      });
      expect(release).not.toHaveBeenCalled();
      expect((await deserializeContext(recorded)).get(HostRuntimeContextKey)).toMatchObject({
        releasedOutcome: "completed",
      });

      await notifyRootHostRuntimeReleaseStep({ serializedContext: recorded });
      expect(release).toHaveBeenCalledExactlyOnceWith({
        outcome: "completed",
        reference,
        sessionId: "root-session",
      });
    });
  });

  it("keeps the first terminal outcome stable and swallows callback failure", async () => {
    const release = vi.fn().mockRejectedValue(new Error("provider secret"));
    const runtime = createRuntimeSession("root-release-failure");
    runtime.hostRuntimeProviders.set(reference.providerKind, createProvider(release));

    await withRuntimeSession(runtime, async () => {
      const recorded = await recordRootHostRuntimeReleaseStep({
        outcome: "failed",
        serializedContext: serializeContext(createRootContext()),
      });
      await expect(notifyRootHostRuntimeReleaseStep({ serializedContext: recorded })).resolves.toBe(
        undefined,
      );
      await expect(
        recordRootHostRuntimeReleaseStep({ outcome: "completed", serializedContext: recorded }),
      ).rejects.toMatchObject({ code: "HOST_RUNTIME_REFERENCE_INVALID" });
    });
  });
});

describe("specialist host runtime release", () => {
  it("delivers and clears a durable outbox after handle settlement", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const runtime = createRuntimeSession("specialist-release");
    runtime.hostRuntimeProviders.set(reference.providerKind, createProvider(release));
    const session = enqueueHostRuntimeRelease(createSession(), {
      outcome: "completed",
      parent,
      reference,
      sessionId: "child-session",
    });

    await withRuntimeSession(runtime, async () => {
      const settled = await settleHostRuntimeReleasesStep({
        sessionState: createDurableSessionState({ session }),
      });
      expect(release).toHaveBeenCalledExactlyOnceWith({
        outcome: "completed",
        parent,
        reference,
        sessionId: "child-session",
      });
      expect(readPendingHostRuntimeReleases(settled.snapshot?.session ?? {})).toEqual([]);
    });
  });

  it("clears a durable outbox when the provider callback fails", async () => {
    const release = vi.fn().mockRejectedValue(new Error("provider secret"));
    const runtime = createRuntimeSession("specialist-release-failure");
    runtime.hostRuntimeProviders.set(reference.providerKind, createProvider(release));
    const session = enqueueHostRuntimeRelease(createSession(), {
      outcome: "failed",
      parent,
      reference,
      sessionId: "child-session",
    });

    await withRuntimeSession(runtime, async () => {
      const settled = await settleHostRuntimeReleasesStep({
        sessionState: createDurableSessionState({ session }),
      });

      expect(release).toHaveBeenCalledOnce();
      expect(readPendingHostRuntimeReleases(settled.snapshot?.session ?? {})).toEqual([]);
    });
  });

  it("records cancellation and removes specialist handles before notification", async () => {
    const handle: AgentHandle = {
      address: {
        continuationToken: "child-token",
        kind: "agent/local",
        sessionId: "child-session",
      },
      hostRuntime: { parent, reference },
      identity: { id: "agent-1", name: "reviewer", nodeId: "reviewer" },
      lastStatus: "waiting",
      phase: "parked",
    };
    const state = createDurableSessionState({
      session: createSession({ [AGENT_HANDLES_STATE_KEY]: { handles: [handle] } }),
    });

    const settled = await settleTerminatedHostRuntimeHandlesStep({ sessionState: state });
    expect(settled.snapshot?.session.state?.[AGENT_HANDLES_STATE_KEY]).toEqual({ handles: [] });
    expect(readPendingHostRuntimeReleases(settled.snapshot?.session ?? {})).toEqual([
      { outcome: "cancelled", parent, reference, sessionId: "child-session" },
    ]);
  });

  it("settles concurrent specialist handles independently", async () => {
    const handles: AgentHandle[] = ["first", "second"].map((suffix, index) => ({
      address: {
        continuationToken: `child-token-${suffix}`,
        kind: "agent/local" as const,
        sessionId: `child-session-${suffix}`,
      },
      hostRuntime: {
        parent: {
          ...parent,
          callId: `call-${String(index + 1)}`,
          subagentName: `reviewer-${suffix}`,
        },
        reference: { ...reference, value: `opaque-${suffix}` },
      },
      identity: {
        id: `agent-${suffix}`,
        name: `reviewer-${suffix}`,
        nodeId: `reviewer-${suffix}`,
      },
      lastStatus: "waiting",
      phase: "parked" as const,
    }));
    const state = createDurableSessionState({
      session: createSession({ [AGENT_HANDLES_STATE_KEY]: { handles } }),
    });

    const settled = await settleTerminatedHostRuntimeHandlesStep({ sessionState: state });

    expect(settled.snapshot?.session.state?.[AGENT_HANDLES_STATE_KEY]).toEqual({ handles: [] });
    expect(readPendingHostRuntimeReleases(settled.snapshot?.session ?? {})).toEqual(
      handles.map((handle) => {
        if (handle.phase !== "parked" || handle.hostRuntime === undefined) {
          throw new Error("Expected a parked specialist handle.");
        }
        return {
          outcome: "cancelled",
          parent: handle.hostRuntime.parent,
          reference: handle.hostRuntime.reference,
          sessionId: handle.address.sessionId,
        };
      }),
    );
  });

  it("does not re-release a task specialist after duplicate terminal delivery", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const runtime = createRuntimeSession("task-specialist-terminal-replay");
    runtime.hostRuntimeProviders.set(reference.providerKind, createProvider(release));
    const handle: AgentHandle = {
      address: {
        continuationToken: "child-token",
        kind: "agent/local",
        sessionId: "child-session",
      },
      hostRuntime: { parent, reference },
      identity: { id: "agent-1", name: "reviewer", nodeId: "reviewer" },
      phase: "addressed",
    };
    const view = {
      lastOutput: { data: "done", type: "result" as const },
      metadata: {
        agentId: "agent-1",
        kind: "subagent" as const,
        mode: "local" as const,
        name: "reviewer",
      },
      status: "completed" as const,
      taskId: "task-1",
    };
    const initial = createDurableSessionState({
      session: createSession({ [AGENT_HANDLES_STATE_KEY]: { handles: [handle] } }),
    });

    await withRuntimeSession(runtime, async () => {
      const recorded = await recordTerminalTaskViewsStep({ sessionState: initial, views: [view] });
      const flushed = await settleHostRuntimeReleasesStep({ sessionState: recorded });
      const replayed = await recordTerminalTaskViewsStep({ sessionState: flushed, views: [view] });
      const reflushed = await settleHostRuntimeReleasesStep({ sessionState: replayed });

      expect(release).toHaveBeenCalledOnce();
      expect(readPendingHostRuntimeReleases(reflushed.snapshot?.session ?? {})).toEqual([]);
    });
  });
});
