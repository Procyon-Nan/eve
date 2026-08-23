import { describe, expect, it, vi } from "vitest";

import { prepareLocalSubagentHostRuntime } from "#execution/local-subagent-host-runtime.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";

const parentReference = { providerKind: "baigong-agent", value: "root-reference" } as const;
const config = {
  description: "Review delegated work.",
  runtime: { kind: "eve.host-runtime", providerKind: "baigong-agent" },
} as const;

function prepare(input: Partial<Parameters<typeof prepareLocalSubagentHostRuntime>[0]> = {}) {
  return prepareLocalSubagentHostRuntime({
    auth: null,
    authorizedSpecialistNames: new Set(["reviewer"]),
    callId: "call-1",
    config,
    initiatorAuth: null,
    parentHostRuntime: {
      acceptanceKey: "command-1",
      ownership: "root",
      reference: parentReference,
    },
    parentSessionId: "parent-1",
    parentTurnId: "turn-1",
    persistentSessions: false,
    rootSessionId: "parent-1",
    subagentName: "reviewer",
    taskOwned: false,
    ...input,
  });
}

describe("local specialist host runtime", () => {
  it("calls the factory with stable lineage and returns matching durable child state", async () => {
    const factory = vi.fn(async () => ({
      providerKind: "baigong-agent",
      value: "specialist:turn-1:call-1:reviewer",
    }));
    const session = createRuntimeSession("specialist-factory");
    session.hostRuntimeProviders.set("baigong-agent", {
      createSpecialistReference: factory,
      providerKind: "baigong-agent",
      resolve: vi.fn(),
    });

    await withRuntimeSession(session, async () => {
      const first = await prepare();
      const replay = await prepare();

      expect(factory).toHaveBeenNthCalledWith(1, {
        auth: null,
        callId: "call-1",
        initiatorAuth: null,
        parentReference,
        parentSessionId: "parent-1",
        parentTurnId: "turn-1",
        subagentName: "reviewer",
      });
      expect(factory.mock.calls[1]).toEqual(factory.mock.calls[0]);
      expect(replay).toEqual(first);
      expect(first).toMatchObject({
        config: {
          runtime: {
            parent: {
              callId: "call-1",
              rootSessionId: "parent-1",
              sessionId: "parent-1",
              subagentName: "reviewer",
              turnId: "turn-1",
            },
            reference: { value: "specialist:turn-1:call-1:reviewer" },
          },
        },
        hostRuntime: { ownership: "specialist" },
      });
    });
  });

  it("keeps parallel calls distinct while preserving their stable keys", async () => {
    const factory = vi.fn(async (input: { readonly callId: string }) => ({
      providerKind: "baigong-agent",
      value: `specialist:${input.callId}`,
    }));
    const session = createRuntimeSession("specialist-parallel");
    session.hostRuntimeProviders.set("baigong-agent", {
      createSpecialistReference: factory,
      providerKind: "baigong-agent",
      resolve: vi.fn(),
    });

    await withRuntimeSession(session, async () => {
      const [first, second] = await Promise.all([
        prepare({ callId: "call-1" }),
        prepare({ callId: "call-2" }),
      ]);
      expect(first.hostRuntime?.reference.value).toBe("specialist:call-1");
      expect(second.hostRuntime?.reference.value).toBe("specialist:call-2");
    });
  });

  it("fails closed before the factory for unauthorized, nested, and plain persistent calls", async () => {
    const factory = vi.fn(async () => ({ providerKind: "baigong-agent", value: "child" }));
    const session = createRuntimeSession("specialist-denied");
    session.hostRuntimeProviders.set("baigong-agent", {
      createSpecialistReference: factory,
      providerKind: "baigong-agent",
      resolve: vi.fn(),
    });

    await withRuntimeSession(session, async () => {
      await expect(prepare({ authorizedSpecialistNames: new Set() })).rejects.toEqual(
        expect.objectContaining({ code: "HOST_RUNTIME_REFERENCE_INVALID" }),
      );
      await expect(
        prepare({
          parentHostRuntime: {
            ownership: "inherited",
            reference: parentReference,
          },
        }),
      ).rejects.toBeInstanceOf(HostRuntimeError);
      await expect(prepare({ persistentSessions: true })).rejects.toEqual(
        expect.objectContaining({ code: "HOST_RUNTIME_RESOLUTION_FAILED" }),
      );
      expect(factory).not.toHaveBeenCalled();
    });
  });

  it("allows task-owned persistent specialists", async () => {
    const session = createRuntimeSession("specialist-task");
    session.hostRuntimeProviders.set("baigong-agent", {
      createSpecialistReference: async () => ({
        providerKind: "baigong-agent",
        value: "task-specialist",
      }),
      providerKind: "baigong-agent",
      resolve: vi.fn(),
    });

    await withRuntimeSession(session, async () => {
      await expect(prepare({ persistentSessions: true, taskOwned: true })).resolves.toMatchObject({
        hostRuntime: { ownership: "specialist", reference: { value: "task-specialist" } },
      });
    });
  });

  it("classifies missing, invalid, and transient factory failures without exposing provider text", async () => {
    const missing = createRuntimeSession("specialist-factory-missing");
    missing.hostRuntimeProviders.set("baigong-agent", {
      providerKind: "baigong-agent",
      resolve: vi.fn(),
    });
    await withRuntimeSession(missing, async () => {
      await expect(prepare()).rejects.toEqual(
        expect.objectContaining({ code: "HOST_RUNTIME_RESOLUTION_FAILED" }),
      );
    });

    const invalid = createRuntimeSession("specialist-factory-invalid");
    const release = vi.fn(async () => {});
    invalid.hostRuntimeProviders.set("baigong-agent", {
      createSpecialistReference: async () => ({ providerKind: "other-host", value: "child" }),
      providerKind: "baigong-agent",
      release,
      resolve: vi.fn(),
    });
    await withRuntimeSession(invalid, async () => {
      await expect(prepare()).rejects.toEqual(
        expect.objectContaining({ code: "HOST_RUNTIME_REFERENCE_INVALID" }),
      );
      expect(release).toHaveBeenCalledExactlyOnceWith({
        outcome: "start_failed",
        parent: {
          callId: "call-1",
          rootSessionId: "parent-1",
          sessionId: "parent-1",
          subagentName: "reviewer",
          turnId: "turn-1",
        },
        reference: { providerKind: "other-host", value: "child" },
        sessionId: "parent-1",
      });
    });

    const transient = createRuntimeSession("specialist-factory-transient");
    transient.hostRuntimeProviders.set("baigong-agent", {
      createSpecialistReference: async () => {
        throw new Error("database password leaked");
      },
      providerKind: "baigong-agent",
      resolve: vi.fn(),
    });
    await withRuntimeSession(transient, async () => {
      await expect(prepare()).rejects.toThrow("Host runtime provider operation failed.");
      await expect(prepare()).rejects.not.toThrow("database password leaked");
    });
  });
});
