import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import {
  AuthKey,
  CapabilitiesKey,
  ChannelInstrumentationKey,
  HostRuntimeContextKey,
  InitiatorAuthKey,
  SessionIdKey,
  TurnDynamicSubagentSelectionsKey,
} from "#context/keys.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import { PENDING_HOST_RUNTIME_RELEASES_STATE_KEY } from "#harness/host-runtime-releases.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { setPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { HarnessSession } from "#harness/types.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";
import type { HostRuntimeProvider } from "#shared/host-runtime.js";
import { registerHostRuntimeProvider } from "#runtime/host-runtime/provider.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const mocks = vi.hoisted(() => ({
  createDurableSessionState: vi.fn(),
  createSession: vi.fn(),
  deserializeContext: vi.fn(),
  hydrateDurableSession: vi.fn(),
  readDurableSession: vi.fn(),
  runtimeInputs: [] as unknown[],
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: mocks.deserializeContext,
}));

vi.mock("#execution/durable-session-store.js", () => ({
  createDurableSessionState: mocks.createDurableSessionState,
  readDurableSession: mocks.readDurableSession,
}));

vi.mock("#execution/session.js", () => ({
  hydrateDurableSession: mocks.hydrateDurableSession,
  mintSubagentContinuationToken: (seed: string) => `subagent:${seed}`,
}));

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: (input: unknown) => {
    mocks.runtimeInputs.push(input);
    return {
      createSession: mocks.createSession,
      dispatchSession: vi.fn(),
    };
  },
  workflowEntryReference: { workflowId: "workflow//eve//workflowEntry" },
}));

const ADAPTER: ChannelAdapter = { kind: "channel:test" };
const BASE_STATE: DurableSessionState = {
  continuationToken: "parent-token",
  emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "" },
  hasProxyInputRequests: false,
  sessionId: "parent-session",
  version: 1,
};
const parentReference = {
  providerKind: "baigong-agent",
  value: "root-reference",
} as const;
const specialistReference = {
  providerKind: "baigong-agent",
  value: "specialist-reference",
} as const;
const model = {
  doGenerate: vi.fn(),
  doStream: vi.fn(),
  modelId: "root-model",
  provider: "test",
  specificationVersion: "v3",
  supportedUrls: {},
} as LanguageModel;

function createParentSession(): HarnessSession {
  return setPendingRuntimeActionBatch({
    actions: [
      {
        callId: "call-reviewer",
        description: "Review the work",
        input: { message: "review this" },
        kind: "subagent-call",
        name: "reviewer",
        nodeId: "subagents/reviewer",
        subagentName: "reviewer",
      },
    ],
    event: { sequence: 1, stepIndex: 2, turnId: "turn-1" },
    responseMessages: [],
    session: {
      agent: {
        modelReference: { id: "test-model" },
        system: "",
        tools: [],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
    },
  });
}

function installContext(session: HarnessSession, delegatedSubagentNames: readonly string[]): void {
  const values = new Map<unknown, unknown>([
    [AuthKey, null],
    [
      BundleKey,
      {
        compiledArtifactsSource: {},
        resolvedAgent: { config: {} },
        subagentRegistry: {
          dynamicNodeIds: new Set(["subagents/reviewer"]),
          subagentsByNodeId: new Map(),
        },
        turnAgent: {
          id: "test-agent",
          instructions: [],
          model: { id: "test-model" },
          skills: [],
          tools: [],
          workspaceSpec: {},
        },
      },
    ],
    [CapabilitiesKey, undefined],
    [ChannelInstrumentationKey, undefined],
    [ChannelKey, ADAPTER],
    [
      HostRuntimeContextKey,
      {
        acceptanceKey: "accept-root",
        ownership: "root",
        reference: parentReference,
      },
    ],
    [InitiatorAuthKey, null],
    [SessionIdKey, "parent-session"],
    [
      TurnDynamicSubagentSelectionsKey,
      {
        "subagents/reviewer": {
          agentConfig: {
            description: "Review the work",
            runtime: {
              kind: "eve.host-runtime",
              providerKind: "baigong-agent",
            },
          },
          kind: "subagent",
          prepared: {},
        },
      },
    ],
  ]);
  mocks.deserializeContext.mockResolvedValue({
    get: (key: unknown) => values.get(key),
    require: (key: unknown) => {
      if (!values.has(key)) throw new Error("missing context key");
      return values.get(key);
    },
    setVirtualContext: (key: unknown, value: unknown) => {
      values.set(key, value);
    },
  });
  mocks.readDurableSession.mockResolvedValue(session);
  return void delegatedSubagentNames;
}

function createWritable(): WritableStream<Uint8Array> {
  return new WritableStream({ write() {} });
}

function readResultSessionState(
  result: Awaited<ReturnType<typeof dispatchRuntimeActionsStep>>,
  fallback: HarnessSession,
): HarnessSession["state"] {
  return result.sessionState.snapshot?.session.state ?? fallback.state;
}

async function runWithProvider(input: {
  readonly createSpecialistReference: NonNullable<HostRuntimeProvider["createSpecialistReference"]>;
  readonly delegatedSubagentNames?: readonly string[];
  readonly release?: HostRuntimeProvider["release"];
}) {
  const runtime = createRuntimeSession("dispatch-specialist-test");
  const session = createParentSession();
  installContext(session, input.delegatedSubagentNames ?? ["reviewer"]);
  return await withRuntimeSession(runtime, async () => {
    registerHostRuntimeProvider({
      createSpecialistReference: input.createSpecialistReference,
      providerKind: "baigong-agent",
      release: input.release,
      resolve: vi.fn(async () => ({
        delegatedSubagentNames: input.delegatedSubagentNames ?? ["reviewer"],
        model,
        modelId: "root-model",
      })),
    });
    const result = await dispatchRuntimeActionsStep({
      parentContinuationToken: "turn-inbox",
      parentWritable: createWritable(),
      serializedContext: {},
      sessionState: BASE_STATE,
    });
    return { result, session };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeInputs.length = 0;
  mocks.createSession.mockResolvedValue({ sessionId: "child-session" });
  mocks.hydrateDurableSession.mockImplementation(({ durable }) => durable);
  mocks.createDurableSessionState.mockImplementation(({ session }) => ({
    ...BASE_STATE,
    snapshot: { session, version: 1 },
  }));
});

describe("dispatchRuntimeActionsStep specialist host runtime", () => {
  it("creates one specialist reference and persists the same lineage everywhere", async () => {
    const createSpecialistReference = vi.fn(async () => specialistReference);
    const { result, session } = await runWithProvider({ createSpecialistReference });
    const parent = {
      callId: "call-reviewer",
      rootSessionId: "parent-session",
      sessionId: "parent-session",
      subagentName: "reviewer",
      turnId: "turn-1",
    };

    expect(createSpecialistReference).toHaveBeenCalledExactlyOnceWith({
      auth: null,
      callId: "call-reviewer",
      initiatorAuth: null,
      parentReference,
      parentSessionId: "parent-session",
      parentTurnId: "turn-1",
      subagentName: "reviewer",
    });
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: expect.objectContaining({
          state: expect.objectContaining({
            hostRuntime: { parent, reference: specialistReference },
          }),
        }),
        hostRuntime: {
          ownership: "specialist",
          parent,
          reference: specialistReference,
        },
      }),
    );
    expect(mocks.runtimeInputs[0]).toMatchObject({
      dynamicSubagentAgentConfig: {
        runtime: {
          kind: "eve.host-runtime",
          parent,
          providerKind: "baigong-agent",
          reference: specialistReference,
        },
      },
    });
    expect(getAgentHandleStore(readResultSessionState(result, session))).toMatchObject({
      handles: [
        {
          hostRuntime: { parent, reference: specialistReference },
          phase: "running",
        },
      ],
    });
  });

  it("does not call the factory when the current root snapshot no longer authorizes the specialist", async () => {
    const createSpecialistReference = vi.fn(async () => specialistReference);
    const { result } = await runWithProvider({
      createSpecialistReference,
      delegatedSubagentNames: [],
    });

    expect(createSpecialistReference).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      isError: true,
      output: { code: "HOST_RUNTIME_REFERENCE_INVALID" },
    });
  });

  it("records a start_failed release when child session creation fails", async () => {
    const createSpecialistReference = vi.fn(async () => specialistReference);
    mocks.createSession.mockRejectedValue(new Error("child start failed"));
    const { result, session } = await runWithProvider({ createSpecialistReference });
    const settledState = readResultSessionState(result, session);

    expect(getAgentHandleStore(settledState)).toEqual({ handles: [] });
    expect(settledState?.[PENDING_HOST_RUNTIME_RELEASES_STATE_KEY]).toEqual([
      expect.objectContaining({
        outcome: "start_failed",
        reference: specialistReference,
        sessionId: "parent-session",
      }),
    ]);
  });

  it("settles an eve-classified factory error without starting a child", async () => {
    const createSpecialistReference = vi.fn(async () => {
      throw new HostRuntimeError("HOST_RUNTIME_VERSION_UNAVAILABLE");
    });
    const { result } = await runWithProvider({ createSpecialistReference });

    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      isError: true,
      output: { code: "HOST_RUNTIME_VERSION_UNAVAILABLE" },
    });
  });

  it("preserves step retry semantics for an unclassified factory error", async () => {
    const runtime = createRuntimeSession("dispatch-specialist-retry-test");
    const session = createParentSession();
    installContext(session, ["reviewer"]);
    await withRuntimeSession(runtime, async () => {
      registerHostRuntimeProvider({
        createSpecialistReference: vi.fn(async () => {
          throw new Error("database temporarily unavailable");
        }),
        providerKind: "baigong-agent",
        resolve: vi.fn(async () => ({
          delegatedSubagentNames: ["reviewer"],
          model,
          modelId: "root-model",
        })),
      });

      await expect(
        dispatchRuntimeActionsStep({
          parentContinuationToken: "turn-inbox",
          parentWritable: createWritable(),
          serializedContext: {},
          sessionState: BASE_STATE,
        }),
      ).rejects.toThrow("Host runtime provider operation failed.");
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
