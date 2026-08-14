import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import type {
  CancelTurnInput,
  CancelTurnResult,
  DeliverHookPayload,
  DispatchContinuationInput,
  DispatchSessionInput,
  GetEventStreamOptions,
  RunHandle,
  RunInput,
  Runtime,
  SessionCommand,
  SessionCommandResult,
} from "#channel/types.js";
import { serializeContext } from "#context/serialize.js";
import {
  buildSessionAttributes,
  buildSubagentRootAttributes,
  readParentLineage,
} from "#execution/eve-workflow-attributes.js";
import { createLogger, logError } from "#internal/logging.js";
import { getHookByToken, getRun, resumeHook } from "#internal/workflow/runtime.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import { RuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
import type { WorkflowEntryInput } from "#execution/workflow-entry.js";
import { walkCauseChain } from "#shared/errors.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { sendCommandToDelivery } from "#execution/session-command-wire.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { startWorkflowPreferLatest } from "#execution/workflow-start.js";
import { workflowEntryReference } from "#execution/workflow-references.js";

export {
  LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE,
  startWorkflowPreferLatest,
} from "#execution/workflow-start.js";
export {
  hostRuntimeAcceptanceWorkflowReference,
  sessionTimeoutWorkflowReference,
  STABLE_WORKFLOW_NAMES,
  turnWorkflowReference,
  workflowEntryReference,
} from "#execution/workflow-references.js";

const COMMAND_HOOK_READY_TIMEOUT_MS = 30_000;
const log = createLogger("execution.workflow-runtime");

interface WorkflowHookRecord {
  readonly runId: string;
}

/**
 * Creates a workflow-backed runtime whose long-lived driver owns the
 * event stream and dispatches each turn as a child workflow run.
 */
export function createWorkflowRuntime(config: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly nodeId?: string;
}): Runtime {
  return {
    async createSession(input: RunInput): Promise<RunHandle> {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: config.compiledArtifactsSource,
        nodeId: config.nodeId,
      });
      const ctx = buildRunContext({
        bundle,
        dynamicSubagentAgentConfig: config.dynamicSubagentAgentConfig,
        run: input,
      });
      const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
      const serializedContext = serializeContext(ctx);
      const parentLineage = readParentLineage(serializedContext);
      const sessionTimeoutMs = effectiveAgent.limits?.sessionTimeoutMs;
      const workflowInput: {
        -readonly [K in keyof WorkflowEntryInput]: WorkflowEntryInput[K];
      } = {
        input: input.input,
        limits: input.limits,
        serializedContext,
      };
      if (sessionTimeoutMs !== undefined) {
        workflowInput.sessionTimeoutMs = sessionTimeoutMs;
      }

      const attributes =
        parentLineage.sessionId === undefined
          ? buildSessionAttributes({
              inputMessage: input.title ?? input.input.message,
              serializedContext,
            })
          : buildSubagentRootAttributes({
              identity: { nodeId: bundle.nodeId ?? ROOT_RUNTIME_AGENT_NODE_ID },
              parentCallId: parentLineage.callId,
              parentSessionId: parentLineage.sessionId,
              parentTurnId: parentLineage.turnId,
              rootSessionId: parentLineage.rootSessionId ?? parentLineage.sessionId,
              serializedContext,
            });

      let run: Awaited<ReturnType<typeof startWorkflowPreferLatest>>;
      try {
        run = await startWorkflowPreferLatest(workflowEntryReference, [workflowInput], {
          allowReservedAttributes: true,
          attributes: normalizeEveAttributes(attributes),
        });
      } catch (error) {
        logError(log, "failed to start workflow run", error, {
          continuationToken: input.continuationToken,
        });
        throw error;
      }

      await waitForOwnedCommandHook(sessionCommandHookToken(run.runId), run.runId);
      if (input.continuationToken) {
        const owner = await waitForCommandHookOwner(input.continuationToken);
        if (owner.runId !== run.runId) {
          throw new RuntimeSessionOwnershipConflictError({
            continuationToken: input.continuationToken,
            ownerSessionId: owner.runId,
            sessionId: run.runId,
          });
        }
      }

      let events: ReadableStream<MessageStreamEvent> | undefined;
      const getEvents = () => {
        events ??= parseNdjsonStream<MessageStreamEvent>(() => getRun(run.runId).getReadable());
        return events;
      };

      return {
        get events() {
          return getEvents();
        },
        sessionId: run.runId,
      };
    },

    async dispatchContinuation<TCommand extends SessionCommand>(
      input: DispatchContinuationInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await dispatchWorkflowCommand(input.continuationToken, input.command);
    },

    async dispatchSession<TCommand extends SessionCommand>(
      input: DispatchSessionInput<TCommand>,
    ): Promise<SessionCommandResult<TCommand>> {
      return await dispatchWorkflowCommand(sessionCommandHookToken(input.sessionId), input.command);
    },

    async getEventStream(
      sessionId: string,
      options?: GetEventStreamOptions,
    ): Promise<ReadableStream<MessageStreamEvent>> {
      return parseNdjsonStream<MessageStreamEvent>(() =>
        getRun(sessionId).getReadable({ startIndex: options?.startIndex }),
      );
    },

    async getStreamTailIndex(sessionId: string): Promise<number> {
      // The readable is never consumed; cancel it so the unread source does not linger.
      const readable = getRun(sessionId).getReadable();
      try {
        return await readable.getTailIndex();
      } finally {
        await readable.cancel().catch(() => {});
      }
    },

    async resolveContinuation(
      continuationToken: string,
    ): Promise<{ sessionId: string } | undefined> {
      try {
        const hook = await getHookByToken(continuationToken);
        return { sessionId: hook.runId };
      } catch (error) {
        if (HookNotFoundError.is(error)) {
          return undefined;
        }
        logError(log, "failed to resolve session by continuation token", error, {
          continuationToken,
        });
        throw error;
      }
    },
  };
}

async function dispatchWorkflowCommand<TCommand extends SessionCommand>(
  token: string,
  command: TCommand,
): Promise<SessionCommandResult<TCommand>> {
  let hook: WorkflowHookRecord;
  try {
    hook = normalizeWorkflowHook(await resumeHook(token, sessionHookPayload(command)));
  } catch (error) {
    if (isInactiveCommandTarget(error)) {
      return inactiveCommandResult(command);
    }
    logError(log, "failed to dispatch session command", error, {
      command: command.kind,
      token,
    });
    throw error;
  }

  if (command.kind === "reset") {
    await waitForCommandHookRelease(sessionCommandHookToken(hook.runId), hook.runId);
  }

  return activeCommandResult(command, hook.runId);
}

function sessionHookPayload(command: SessionCommand): SessionCommand | DeliverHookPayload {
  return command.kind === "send" ? sendCommandToDelivery(command) : command;
}

function activeCommandResult<TCommand extends SessionCommand>(
  command: TCommand,
  sessionId: string,
): SessionCommandResult<TCommand> {
  const result =
    command.kind === "reset"
      ? { previousSessionId: sessionId, status: "reset" as const }
      : command.kind === "cancel"
        ? { sessionId, status: "accepted" as const }
        : { sessionId, status: "accepted" as const };
  return result as SessionCommandResult<TCommand>;
}

function inactiveCommandResult<TCommand extends SessionCommand>(
  command: TCommand,
): SessionCommandResult<TCommand> {
  const result =
    command.kind === "send"
      ? { status: "session_not_active" as const }
      : command.kind === "cancel"
        ? { status: "no_active_turn" as const }
        : { status: "no_active_session" as const };
  return result as SessionCommandResult<TCommand>;
}

/** Requests cancellation through a session's stable command inbox. */
export async function requestWorkflowTurnCancellation(
  input: CancelTurnInput,
): Promise<CancelTurnResult> {
  return await dispatchWorkflowCommand(sessionCommandHookToken(input.sessionId), {
    kind: "cancel",
    turnId: input.turnId,
  });
}

function isInactiveCommandTarget(error: unknown): boolean {
  if (HookNotFoundError.is(error)) return true;
  for (const candidate of walkCauseChain(error)) {
    if (
      WorkflowRunNotFoundError.is(candidate) ||
      RunExpiredError.is(candidate) ||
      EntityConflictError.is(candidate)
    ) {
      return true;
    }
  }
  return false;
}

async function waitForOwnedCommandHook(token: string, sessionId: string): Promise<void> {
  const owner = await waitForCommandHookOwner(token);
  if (owner.runId !== sessionId) {
    throw new RuntimeSessionOwnershipConflictError({
      continuationToken: token,
      ownerSessionId: owner.runId,
      sessionId,
    });
  }
}

async function waitForCommandHookOwner(token: string): Promise<WorkflowHookRecord> {
  const deadline = Date.now() + COMMAND_HOOK_READY_TIMEOUT_MS;
  while (true) {
    try {
      return normalizeWorkflowHook(await getHookByToken(token));
    } catch (error) {
      if (!HookNotFoundError.is(error) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function waitForCommandHookRelease(token: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + COMMAND_HOOK_READY_TIMEOUT_MS;
  while (true) {
    try {
      const owner = normalizeWorkflowHook(await getHookByToken(token));
      if (owner.runId !== sessionId) return;
    } catch (error) {
      if (HookNotFoundError.is(error)) return;
      throw error;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for session "${sessionId}" to release its command inbox.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function normalizeWorkflowHook(value: unknown): WorkflowHookRecord {
  if (value === null || typeof value !== "object" || !("runId" in value)) {
    throw new Error("Workflow hook did not include a run id.");
  }

  const runId = (value as { runId?: unknown }).runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Workflow hook did not include a run id.");
  }

  return {
    runId,
  };
}
