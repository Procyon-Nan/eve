import { beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchToAgentHandle } from "#execution/agent-handle-dispatch.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import {
  AGENT_HANDLES_STATE_KEY,
  deriveAgentId,
  type AgentHandle,
} from "#harness/handles/store.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

const mocks = vi.hoisted(() => ({
  dispatchSession: vi.fn(),
}));

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: () => ({ dispatchSession: mocks.dispatchSession }),
}));

const firstOperationId = deriveAgentOperationId({
  callId: "call-0",
  parentSessionId: "parent-session",
  parentTurnId: "turn-0",
});
const handle: AgentHandle = {
  address: {
    continuationToken: "child-token",
    kind: "agent/self",
    sessionId: "child-session",
  },
  identity: {
    id: deriveAgentId("agent", firstOperationId),
    name: "agent",
    nodeId: "root",
  },
  lastStatus: "waiting",
  phase: "parked",
};
const action: RuntimeSubagentCallActionRequest = {
  callId: "call-1",
  description: "Continue the root agent copy",
  input: { agentId: handle.identity.id, message: "continue" },
  kind: "subagent-call",
  name: "agent",
  nodeId: "root",
  subagentName: "agent",
};
const bundle = {
  compiledArtifactsSource: {},
} as CompiledBundle;

function createSession() {
  return {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
    state: {
      [AGENT_HANDLES_STATE_KEY]: { handles: [handle] },
    },
  };
}

describe("dispatchToAgentHandle host-runtime continuation", () => {
  beforeEach(() => {
    mocks.dispatchSession.mockReset();
    mocks.dispatchSession.mockResolvedValue({
      sessionId: "child-session",
      status: "accepted",
    });
  });

  it("passes the current root reference to a persistent built-in agent copy", async () => {
    await dispatchToAgentHandle({
      action,
      agentId: handle.identity.id,
      bundle,
      currentSession: createSession(),
      delegationMessage: "continue",
      parentHostRuntime: {
        acceptanceKey: "accept-2",
        ownership: "root",
        reference: { providerKind: "baigong-agent", value: "root-reference-2" },
      },
      parentToken: "parent-turn-hook",
      parentTurnId: "turn-1",
    });

    expect(mocks.dispatchSession).toHaveBeenCalledWith({
      command: {
        caller: {
          callId: "call-1",
          replyTo: { kind: "hook", token: "parent-turn-hook" },
          subagentName: "agent",
        },
        hostRuntime: {
          ownership: "inherited",
          parent: {
            callId: "call-1",
            rootSessionId: "parent-session",
            sessionId: "parent-session",
            subagentName: "agent",
            turnId: "turn-1",
          },
          reference: { providerKind: "baigong-agent", value: "root-reference-2" },
        },
        kind: "send",
        payload: { message: "continue", outputSchema: undefined },
      },
      sessionId: "child-session",
    });
  });

  it("does not leak a root reference into a regular local child", async () => {
    const localHandle: AgentHandle = {
      address: {
        continuationToken: "child-token",
        kind: "agent/local",
        sessionId: "child-session",
      },
      identity: { ...handle.identity, name: "research" },
      lastStatus: "waiting",
      phase: "parked",
    };
    const session = createSession();
    session.state[AGENT_HANDLES_STATE_KEY] = { handles: [localHandle] };

    await dispatchToAgentHandle({
      action: { ...action, name: "research", subagentName: "research" },
      agentId: localHandle.identity.id,
      bundle,
      currentSession: session,
      delegationMessage: "continue",
      parentHostRuntime: {
        acceptanceKey: "accept-2",
        ownership: "root",
        reference: { providerKind: "baigong-agent", value: "root-reference-2" },
      },
      parentToken: "parent-turn-hook",
      parentTurnId: "turn-1",
    });

    expect(mocks.dispatchSession.mock.calls[0]?.[0].command.hostRuntime).toBeUndefined();
  });
});
