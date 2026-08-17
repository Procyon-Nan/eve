import { describe, expect, it, vi } from "vitest";

import {
  LocalSubagentStartClaimConflictError,
  recoverLocalSubagentStartClaim,
  resolveLocalSubagentStartClaim,
} from "#execution/local-subagent-start-claim.js";
import type { LocalSubagentStartIdentity } from "#execution/subagent-tool.js";
import {
  WorkflowSessionStartInvalidError,
  type WorkflowSessionStartSnapshot,
} from "#execution/workflow-runtime.js";

const identity: LocalSubagentStartIdentity = {
  callId: "call-1",
  continuationToken: "subagent:parent-session:call-1",
  nodeId: "subagents/reviewer",
  parentSessionId: "parent-session",
  parentTurnId: "turn-1",
  rootSessionId: "root-session",
  subagentName: "reviewer",
};
const parent = {
  callId: identity.callId,
  rootSessionId: identity.rootSessionId,
  sessionId: identity.parentSessionId,
  subagentName: identity.subagentName,
  turnId: identity.parentTurnId,
} as const;
const winnerReference = { providerKind: "baigong-agent", value: "winner-reference" } as const;

function createSnapshot(
  input: {
    readonly adapterHostRuntime?: unknown;
    readonly attributes?: Record<string, string>;
    readonly hostRuntime?: unknown;
    readonly overrides?: Record<string, unknown>;
  } = {},
): WorkflowSessionStartSnapshot {
  const adapterState: Record<string, unknown> = {
    callId: identity.callId,
    parentContinuationToken: "turn-inbox",
    parentSessionId: identity.parentSessionId,
    subagentName: identity.subagentName,
  };
  if (input.adapterHostRuntime !== undefined) {
    adapterState.hostRuntime = input.adapterHostRuntime;
  }
  const serializedContext: Record<string, unknown> = {
    "eve.channel": { kind: "subagent", state: adapterState },
    "eve.continuationToken": identity.continuationToken,
    "eve.parentSession": {
      callId: identity.callId,
      rootSessionId: identity.rootSessionId,
      sessionId: identity.parentSessionId,
      turn: { id: identity.parentTurnId, sequence: 1 },
    },
    ...input.overrides,
  };
  if (input.hostRuntime !== undefined) {
    serializedContext["eve.hostRuntime"] = input.hostRuntime;
  }

  return {
    attributes: {
      "$eve.parent": identity.parentSessionId,
      "$eve.parent_call": identity.callId,
      "$eve.parent_turn": identity.parentTurnId,
      "$eve.root": identity.rootSessionId,
      "$eve.subagent": identity.nodeId,
      "$eve.type": "subagent",
      ...input.attributes,
    },
    serializedContext,
    status: "running",
  };
}

describe("local subagent start claim recovery", () => {
  it("returns undefined without reading a session when the token has no owner", async () => {
    const runtime = {
      inspectSessionStart: vi.fn(),
      resolveContinuation: vi.fn(async () => undefined),
    };

    await expect(resolveLocalSubagentStartClaim({ identity, runtime })).resolves.toBeUndefined();
    expect(runtime.inspectSessionStart).not.toHaveBeenCalled();
  });

  it("recovers a matching ordinary local subagent owner", async () => {
    const runtime = {
      inspectSessionStart: vi.fn(async () => createSnapshot()),
      resolveContinuation: vi.fn(async () => ({ sessionId: "winner-session" })),
    };

    await expect(resolveLocalSubagentStartClaim({ identity, runtime })).resolves.toEqual({
      sessionId: "winner-session",
    });
  });

  it.each([
    ["continuation token", { overrides: { "eve.continuationToken": "subagent:other" } }],
    ["workflow type", { attributes: { "$eve.type": "session" } }],
    ["parent session", { attributes: { "$eve.parent": "other-parent" } }],
    ["parent turn", { attributes: { "$eve.parent_turn": "other-turn" } }],
    ["parent call", { attributes: { "$eve.parent_call": "other-call" } }],
    ["root session", { attributes: { "$eve.root": "other-root" } }],
    ["node id", { attributes: { "$eve.subagent": "subagents/other" } }],
    [
      "adapter call id",
      {
        overrides: {
          "eve.channel": {
            kind: "subagent",
            state: {
              callId: "other-call",
              parentContinuationToken: "turn-inbox",
              parentSessionId: identity.parentSessionId,
              subagentName: identity.subagentName,
            },
          },
        },
      },
    ],
    [
      "adapter parent session",
      {
        overrides: {
          "eve.channel": {
            kind: "subagent",
            state: {
              callId: identity.callId,
              parentContinuationToken: "turn-inbox",
              parentSessionId: "other-parent",
              subagentName: identity.subagentName,
            },
          },
        },
      },
    ],
    [
      "adapter subagent name",
      {
        overrides: {
          "eve.channel": {
            kind: "subagent",
            state: {
              callId: identity.callId,
              parentContinuationToken: "turn-inbox",
              parentSessionId: identity.parentSessionId,
              subagentName: "other",
            },
          },
        },
      },
    ],
    [
      "parent context lineage",
      {
        overrides: {
          "eve.parentSession": {
            callId: identity.callId,
            rootSessionId: identity.rootSessionId,
            sessionId: identity.parentSessionId,
            turn: { id: "other-turn", sequence: 1 },
          },
        },
      },
    ],
  ])("fails closed for a mismatched %s", async (_title, snapshotInput) => {
    const runtime = { inspectSessionStart: vi.fn(async () => createSnapshot(snapshotInput)) };

    await expect(
      recoverLocalSubagentStartClaim({
        identity,
        ownerSessionId: "winner-session",
        runtime,
      }),
    ).rejects.toBeInstanceOf(LocalSubagentStartClaimConflictError);
  });

  it("fails closed when the owner start metadata cannot be inspected", async () => {
    const runtime = {
      inspectSessionStart: vi.fn(async () => {
        throw new WorkflowSessionStartInvalidError("winner-session");
      }),
    };

    await expect(
      recoverLocalSubagentStartClaim({
        identity,
        ownerSessionId: "winner-session",
        runtime,
      }),
    ).rejects.toMatchObject({
      name: "LocalSubagentStartClaimConflictError",
      ownerSessionId: "winner-session",
    });
  });

  it("rethrows transient owner inspection failures", async () => {
    const transientError = new Error("workflow store unavailable");
    const runtime = {
      inspectSessionStart: vi.fn(async () => {
        throw transientError;
      }),
    };

    await expect(
      recoverLocalSubagentStartClaim({
        identity,
        ownerSessionId: "winner-session",
        runtime,
      }),
    ).rejects.toBe(transientError);
  });

  it("recovers and validates the winner's specialist Host Runtime reference", async () => {
    const hostRuntime = { ownership: "specialist", parent, reference: winnerReference };
    const runtime = {
      inspectSessionStart: vi.fn(async () =>
        createSnapshot({ adapterHostRuntime: { parent, reference: winnerReference }, hostRuntime }),
      ),
    };

    await expect(
      recoverLocalSubagentStartClaim({
        identity,
        ownerSessionId: "winner-session",
        runtime,
        specialistProviderKind: "baigong-agent",
      }),
    ).resolves.toEqual({
      sessionId: "winner-session",
      specialistHostRuntime: { parent, reference: winnerReference },
    });
  });

  it.each([
    [
      "provider kind",
      {
        adapterHostRuntime: { parent, reference: winnerReference },
        hostRuntime: {
          ownership: "specialist",
          parent,
          reference: { providerKind: "other-provider", value: "winner-reference" },
        },
      },
    ],
    [
      "Host Runtime lineage",
      {
        adapterHostRuntime: { parent, reference: winnerReference },
        hostRuntime: {
          ownership: "specialist",
          parent: { ...parent, turnId: "other-turn" },
          reference: winnerReference,
        },
      },
    ],
    [
      "adapter reference",
      {
        adapterHostRuntime: {
          parent,
          reference: { ...winnerReference, value: "other-reference" },
        },
        hostRuntime: { ownership: "specialist", parent, reference: winnerReference },
      },
    ],
    [
      "reference shape",
      {
        adapterHostRuntime: { parent, reference: winnerReference },
        hostRuntime: {
          ownership: "specialist",
          parent,
          reference: { providerKind: "baigong-agent", value: "" },
        },
      },
    ],
  ])("fails closed for a mismatched specialist %s", async (_title, snapshotInput) => {
    const runtime = { inspectSessionStart: vi.fn(async () => createSnapshot(snapshotInput)) };

    await expect(
      recoverLocalSubagentStartClaim({
        identity,
        ownerSessionId: "winner-session",
        runtime,
        specialistProviderKind: "baigong-agent",
      }),
    ).rejects.toBeInstanceOf(LocalSubagentStartClaimConflictError);
  });

  it("rejects specialist ownership on an ordinary local subagent path", async () => {
    const hostRuntime = { ownership: "specialist", parent, reference: winnerReference };
    const runtime = {
      inspectSessionStart: vi.fn(async () =>
        createSnapshot({ adapterHostRuntime: { parent, reference: winnerReference }, hostRuntime }),
      ),
    };

    await expect(
      recoverLocalSubagentStartClaim({
        identity,
        ownerSessionId: "winner-session",
        runtime,
      }),
    ).rejects.toBeInstanceOf(LocalSubagentStartClaimConflictError);
  });
});
