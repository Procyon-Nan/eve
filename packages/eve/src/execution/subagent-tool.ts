import { SUBAGENT_ADAPTER_KIND } from "#execution/subagent-adapter-state.js";
import {
  formatSubagentInput,
  normalizeRequestedOutputSchema,
} from "#execution/subagent-invocation.js";
import type {
  ChannelInstrumentationProjection,
  RunInput,
  RunSessionLimits,
  SessionAuthContext,
  SessionCapabilities,
  SessionTraceContext,
} from "#channel/types.js";
import type { HarnessSession } from "#harness/types.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#runtime/actions/types.js";
import { mintSubagentContinuationToken } from "#execution/session.js";
import { resolveSubagentDepth } from "#harness/subagent-depth.js";
import { resolveRemainingSessionTokenLimits } from "#harness/subagent-token-budget.js";
import type { DurableHostRuntimeContext } from "#shared/host-runtime.js";

/**
 * Pending runtime-action batch event metadata needed for child run lineage.
 */
interface BatchEventMetadata {
  readonly sequence: number;
  readonly turnId: string;
}

/** Durable coordinates that identify one logical local subagent start. */
export interface LocalSubagentStartIdentity {
  readonly callId: string;
  readonly continuationToken: string;
  readonly nodeId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly rootSessionId: string;
  readonly subagentName: string;
}

export type SubagentInputSource =
  | {
      readonly description: string;
      readonly type: "local";
    }
  | {
      readonly type: "runtime";
    };

/**
 * Result of {@link buildSubagentRunInput}.
 *
 * Exposes the derived `childContinuationToken` alongside the
 * {@link RunInput} so dispatch sites never re-derive the token from
 * `(callId, parentSessionId)` on their own.
 */
export interface SubagentRunInputBuild {
  readonly childContinuationToken: string;
  readonly runInput: RunInput;
}

/** Derives the single identity shared by local child creation and replay recovery. */
export function buildLocalSubagentStartIdentity(input: {
  readonly action: RuntimeSubagentCallActionRequest;
  readonly batchEvent: BatchEventMetadata;
  readonly session: HarnessSession;
}): LocalSubagentStartIdentity {
  return {
    callId: input.action.callId,
    continuationToken: mintSubagentContinuationToken(
      `${input.session.sessionId}:${input.action.callId}`,
    ),
    nodeId: input.action.nodeId,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.batchEvent.turnId,
    rootSessionId: input.session.rootSessionId ?? input.session.sessionId,
    subagentName: input.action.subagentName,
  };
}

/** Reads the exact delegation message submitted through an agent action. */
export function resolveSubagentDelegationMessage(
  action: RuntimeSubagentCallActionRequest | RuntimeRemoteAgentCallActionRequest,
): string {
  const message = action.input.message;
  if (typeof message !== "string") {
    throw new TypeError(`Subagent action "${action.callId}" input.message must be a string.`);
  }

  return message;
}

/**
 * Builds the {@link RunInput} for one delegated subagent child run.
 */
export function buildSubagentRunInput(input: {
  readonly action: RuntimeSubagentCallActionRequest;
  readonly auth: SessionAuthContext | null;
  readonly batchEvent: BatchEventMetadata;
  /**
   * Parent's session capabilities. Forwarded verbatim so HITL
   * readiness flows transparently down through a subagent chain. Undefined
   * parent capabilities produce an undefined child capability set.
   */
  readonly capabilities?: SessionCapabilities;
  readonly channelMetadata?: ChannelInstrumentationProjection;
  /**
   * Number of local subagent calls dispatched in this batch. The parent's
   * remaining token quota is split evenly across them so parallel children
   * are collectively, not individually, bounded by it. Remote agents run
   * under their own deployment's limits and are not counted.
   */
  readonly fanoutSize?: number;
  readonly initiatorAuth: SessionAuthContext | null;
  readonly startIdentity: LocalSubagentStartIdentity;
  readonly hostRuntime?: DurableHostRuntimeContext;
  /** Exact message already validated before the dispatch batch starts. */
  readonly delegationMessage?: string;
  /** Hook token owned by the workflow currently waiting for this child. */
  readonly parentContinuationToken?: string;
  readonly parentTraceContext?: SessionTraceContext;
  /**
   * Whether the parent agent opted into
   * `experimental.subagentPersistentSessions`. Persistent children run in
   * conversation mode so their sessions survive the first answer; otherwise
   * children run as one-shot task sessions.
   */
  readonly persistentSessions?: boolean;
  readonly session: HarnessSession;
  readonly source: SubagentInputSource;
}): SubagentRunInputBuild {
  const {
    action,
    auth,
    batchEvent,
    capabilities,
    channelMetadata,
    initiatorAuth,
    session,
    source,
  } = input;

  const delegationMessage =
    input.delegationMessage ?? resolveSubagentDelegationMessage(input.action);

  const childContinuationToken = input.startIdentity.continuationToken;

  // Denormalize the chain root onto the child's `parent` metadata so
  // every descendant in a nested dispatch can attribute itself to the
  // top user-facing session in a single hop. A subagent that itself
  // dispatches more subagents reads the root from
  // `session.rootSessionId` here; a top-level session carries no
  // explicit root, so its own `sessionId` becomes the root for its
  // children.
  const rootSessionId = input.startIdentity.rootSessionId;
  const subagentDepth = resolveSubagentDepth(session);
  const inheritedLimits: {
    -readonly [K in keyof RunSessionLimits]: RunSessionLimits[K];
  } = resolveRemainingSessionTokenLimits(session, input.fanoutSize);
  const requestedOutputSchema = normalizeRequestedOutputSchema(action.input.outputSchema);

  const runInput: {
    -readonly [K in keyof RunInput]: RunInput[K];
  } = {
    adapter: {
      kind: SUBAGENT_ADAPTER_KIND,
      state: {
        callId: input.startIdentity.callId,
        parentContinuationToken: input.parentContinuationToken ?? session.continuationToken,
        parentSessionId: input.startIdentity.parentSessionId,
        subagentName: input.startIdentity.subagentName,
        ...(input.hostRuntime?.ownership === "specialist" && input.hostRuntime.parent !== undefined
          ? {
              hostRuntime: {
                parent: input.hostRuntime.parent,
                reference: input.hostRuntime.reference,
              },
            }
          : {}),
        ...(action.subagentName === "agent" && session.sandboxState
          ? { parentSandboxState: session.sandboxState, sandboxSessionId: session.sessionId }
          : {}),
      },
    },
    auth,
    capabilities,
    channelMetadata,
    continuationToken: childContinuationToken,
    initiatorAuth,
    input: {
      message: formatSubagentCallInputMessage({
        message: delegationMessage,
        name: action.subagentName,
        persistentSession: input.persistentSessions,
        source,
      }),
      outputSchema: requestedOutputSchema,
    },
    limits: inheritedLimits,
    mode: input.persistentSessions === true ? "conversation" : "task",
    parent: {
      callId: input.startIdentity.callId,
      rootSessionId,
      sessionId: input.startIdentity.parentSessionId,
      turn: {
        id: input.startIdentity.parentTurnId,
        sequence: batchEvent.sequence,
      },
    },
    parentTraceContext: input.parentTraceContext,
    subagentDepth: subagentDepth.nextChildDepth,
  };
  if (input.hostRuntime !== undefined) runInput.hostRuntime = input.hostRuntime;

  return { childContinuationToken, runInput };
}

/**
 * Formats the synthesized child input message for one delegated subagent call.
 */
function formatSubagentCallInputMessage(input: {
  readonly message: string;
  readonly name: string;
  readonly persistentSession?: boolean;
  readonly source: SubagentInputSource;
}): string {
  switch (input.source.type) {
    case "local":
      return formatSubagentInput({
        description: input.source.description,
        message: input.message,
        name: input.name,
        persistentSession: input.persistentSession,
        type: "local",
      }).message;
    case "runtime":
      return formatSubagentInput({
        message: input.message,
        name: input.name,
        persistentSession: input.persistentSession,
        type: "runtime",
      }).message;
    default: {
      const _exhaustive: never = input.source;
      return _exhaustive;
    }
  }
}
