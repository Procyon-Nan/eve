import { describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { settleHostRuntimeReleasesStep } from "#execution/settle-host-runtime-releases-step.js";
import { PENDING_HOST_RUNTIME_RELEASES_STATE_KEY } from "#harness/host-runtime-releases.js";
import { registerHostRuntimeProvider } from "#runtime/host-runtime/provider.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";

describe("settleHostRuntimeReleasesStep", () => {
  it("releases a parent-settled specialist and clears the durable outbox", async () => {
    const release = vi.fn(async () => {});
    const runtime = createRuntimeSession("specialist-release");
    await withRuntimeSession(runtime, async () => {
      registerHostRuntimeProvider({
        providerKind: "baigong-agent",
        release,
        resolve: vi.fn(async () => {
          throw new Error("not used");
        }),
      });
      const parent = {
        callId: "call-1",
        rootSessionId: "root-session",
        sessionId: "parent-session",
        subagentName: "reviewer",
        turnId: "turn-1",
      } as const;
      const reference = { providerKind: "baigong-agent", value: "specialist-ref" } as const;
      const state: DurableSessionState = {
        continuationToken: "child-token",
        emissionState: { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "" },
        hasProxyInputRequests: false,
        sessionId: "parent-session",
        snapshot: {
          session: {
            agent: { system: "" },
            continuationToken: "parent-token",
            history: [],
            sessionId: "parent-session",
            state: {
              keep: true,
              [PENDING_HOST_RUNTIME_RELEASES_STATE_KEY]: [
                { outcome: "completed", parent, reference, sessionId: "child-session" },
              ],
            },
          },
          version: 1,
        },
        version: 1,
      };

      const settled = await settleHostRuntimeReleasesStep({ sessionState: state });

      expect(release).toHaveBeenCalledExactlyOnceWith({
        outcome: "completed",
        parent,
        reference,
        sessionId: "child-session",
      });
      expect(settled.snapshot?.session.state).toEqual({ keep: true });
    });
  });
});
