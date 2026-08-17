import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { DispatchOutcome, RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { SUBAGENT_START_CONFLICT, SUBAGENT_START_FAILED } from "#harness/agent-handle-errors.js";
import {
  confirmAgentStarted,
  prepareAgentStart,
  rejectAgentEffect,
} from "#harness/handles/transitions.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import { mintStartOperation } from "#execution/dispatch-start-operation.js";
import {
  buildLocalSubagentStartIdentity,
  buildSubagentRunInput,
  type SubagentInputSource,
} from "#execution/subagent-tool.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createErrorId, createLogger, logError } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import { releaseHostRuntimeReference } from "#runtime/host-runtime/preflight.js";
import { isHostRuntimeError } from "#runtime/host-runtime/errors.js";
import type { DurableHostRuntimeContext } from "#shared/host-runtime.js";
import { enqueueHostRuntimeRelease } from "#harness/host-runtime-releases.js";
import {
  LocalSubagentStartClaimConflictError,
  recoverLocalSubagentStartClaim,
  resolveLocalSubagentStartClaim,
  type RecoveredLocalSubagentStart,
} from "#execution/local-subagent-start-claim.js";
import { isRuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
import { prepareLocalSubagentHostRuntime } from "#execution/local-subagent-host-runtime.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";

const log = createLogger("execution.dispatch-runtime-actions");

export async function startLocalSubagent(input: {
  readonly action: RuntimeSubagentCallActionRequest;
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  readonly currentSession: RuntimeSession;
  readonly delegationMessage: string;
  readonly dynamicSubagentAgentConfig?: DynamicSubagentAgentConfig;
  readonly fanoutSize: number;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly parentHostRuntime: DurableHostRuntimeContext | undefined;
  readonly authorizedSpecialistNames: ReadonlySet<string>;
  readonly parentContinuationToken: string | undefined;
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
  readonly persistentSessions: boolean;
  readonly session: RuntimeSession;
  readonly source: SubagentInputSource;
}): Promise<DispatchOutcome> {
  const { action, source } = input;
  const startIdentity = buildLocalSubagentStartIdentity({
    action,
    batchEvent: input.batchEvent,
    session: input.session,
  });
  let dynamicSubagentAgentConfig = input.dynamicSubagentAgentConfig;
  const specialistProviderKind = dynamicSubagentAgentConfig?.runtime?.providerKind;
  let childRuntime = createWorkflowRuntime({
    compiledArtifactsSource: input.bundle.compiledArtifactsSource,
    dynamicSubagentAgentConfig,
    nodeId: action.nodeId,
  });
  const targetKind = source.type === "runtime" ? ("agent/self" as const) : ("agent/local" as const);
  const { identity, operation } = mintStartOperation({
    callId: startIdentity.callId,
    name: startIdentity.subagentName,
    nodeId: startIdentity.nodeId,
    parentSessionId: startIdentity.parentSessionId,
    parentTurnId: startIdentity.parentTurnId,
  });

  let existing: RecoveredLocalSubagentStart | undefined;
  try {
    existing = await resolveLocalSubagentStartClaim({
      identity: startIdentity,
      runtime: childRuntime,
      specialistProviderKind,
    });
  } catch (error) {
    if (!(error instanceof LocalSubagentStartClaimConflictError)) throw error;
    log.warn("local subagent start claim conflicted", {
      callId: action.callId,
      errorId: createErrorId(),
      ownerSessionId: error.ownerSessionId,
      parentSessionId: input.session.sessionId,
      parentTurnId: input.batchEvent.turnId,
      subagentName: action.subagentName,
    });
    return createStartConflictOutcome({ action, session: input.currentSession });
  }
  if (existing !== undefined) {
    const address = {
      continuationToken: startIdentity.continuationToken,
      kind: targetKind,
      sessionId: existing.sessionId,
    } as const;
    const preparedSession = prepareAgentStart(input.currentSession, {
      identity,
      operation,
      target: { continuationToken: startIdentity.continuationToken, kind: targetKind },
      ...(existing.specialistHostRuntime === undefined
        ? {}
        : { hostRuntime: existing.specialistHostRuntime }),
    });
    return createCalledOutcome({
      action,
      address,
      delegationMessage: input.delegationMessage,
      operationId: operation.id,
      preparedSession,
    });
  }

  let specialistHostRuntime: DurableHostRuntimeContext | undefined;
  try {
    const prepared = await prepareLocalSubagentHostRuntime({
      auth: input.auth,
      authorizedSpecialistNames: input.authorizedSpecialistNames,
      config: dynamicSubagentAgentConfig,
      initiatorAuth: input.initiatorAuth,
      parentHostRuntime: input.parentHostRuntime,
      persistentSessions: input.persistentSessions,
      session: input.session,
      startIdentity,
    });
    dynamicSubagentAgentConfig = prepared.config;
    specialistHostRuntime = prepared.hostRuntime;
  } catch (error) {
    if (!isHostRuntimeError(error)) throw error;
    return {
      kind: "error",
      result: {
        callId: action.callId,
        isError: true,
        kind: "subagent-result",
        origin: "dispatch",
        output: { code: error.code, message: error.code },
        subagentName: action.subagentName,
      },
      session: input.currentSession,
    };
  }
  childRuntime = createWorkflowRuntime({
    compiledArtifactsSource: input.bundle.compiledArtifactsSource,
    dynamicSubagentAgentConfig,
    nodeId: action.nodeId,
  });
  const childHostRuntime =
    specialistHostRuntime ??
    (action.subagentName === "agent" && input.parentHostRuntime !== undefined
      ? {
          ownership: "inherited" as const,
          parent: {
            callId: startIdentity.callId,
            rootSessionId: startIdentity.rootSessionId,
            sessionId: startIdentity.parentSessionId,
            subagentName: startIdentity.subagentName,
            turnId: startIdentity.parentTurnId,
          },
          reference: input.parentHostRuntime.reference,
        }
      : undefined);
  const { childContinuationToken, runInput } = buildSubagentRunInput({
    action,
    auth: input.auth,
    batchEvent: input.batchEvent,
    capabilities: input.capabilities,
    channelMetadata: input.channelMetadata,
    delegationMessage: input.delegationMessage,
    fanoutSize: input.fanoutSize,
    initiatorAuth: input.initiatorAuth,
    hostRuntime: childHostRuntime,
    parentContinuationToken: input.parentContinuationToken,
    parentTraceContext: input.parentTraceContext,
    persistentSessions: input.persistentSessions,
    session: input.session,
    source,
    startIdentity,
  });

  // Ownership is recorded before the start side effect, and the prepared
  // (or rejected) store rides every outcome into the step result. The
  // guarantee is intra-step: a crash between the accepted start and the
  // step-result commit still replays the whole dispatch step, so the
  // orphan window shrinks to that boundary rather than disappearing.
  let preparedSession: RuntimeSession;
  try {
    preparedSession = prepareAgentStart(input.currentSession, {
      identity,
      operation,
      target: { continuationToken: childContinuationToken, kind: targetKind },
    });
  } catch (error) {
    if (specialistHostRuntime?.parent !== undefined) {
      await releaseHostRuntimeReference({
        outcome: "start_failed",
        parent: specialistHostRuntime.parent,
        reference: specialistHostRuntime.reference,
        sessionId: input.session.sessionId,
      });
    }
    throw error;
  }

  let childSessionId: string;
  try {
    const handle = await childRuntime.createSession(runInput);
    childSessionId = handle.sessionId;
  } catch (error) {
    if (isRuntimeSessionOwnershipConflictError(error)) {
      let recovered: RecoveredLocalSubagentStart;
      try {
        if (error.continuationToken !== startIdentity.continuationToken) {
          throw new LocalSubagentStartClaimConflictError(error.ownerSessionId);
        }
        recovered = await recoverLocalSubagentStartClaim({
          identity: startIdentity,
          ownerSessionId: error.ownerSessionId,
          runtime: childRuntime,
          specialistProviderKind,
        });
      } catch (claimError) {
        if (!(claimError instanceof LocalSubagentStartClaimConflictError)) throw claimError;
        await childRuntime.cancelSessionStart(error.sessionId);
        let rejectedSession = rejectAgentEffect(preparedSession, {
          disposition: "dead",
          operationId: operation.id,
        });
        if (specialistHostRuntime?.parent !== undefined) {
          rejectedSession = enqueueHostRuntimeRelease(rejectedSession, {
            outcome: "start_failed",
            parent: specialistHostRuntime.parent,
            reference: specialistHostRuntime.reference,
            sessionId: input.session.sessionId,
          });
        }
        log.warn("local subagent ownership conflict was not recoverable", {
          callId: action.callId,
          errorId: createErrorId(),
          losingSessionId: error.sessionId,
          ownerSessionId: error.ownerSessionId,
          parentSessionId: input.session.sessionId,
          parentTurnId: input.batchEvent.turnId,
          subagentName: action.subagentName,
        });
        return createStartConflictOutcome({ action, session: rejectedSession });
      }

      await childRuntime.cancelSessionStart(error.sessionId);
      if (specialistHostRuntime?.parent !== undefined) {
        preparedSession = enqueueHostRuntimeRelease(preparedSession, {
          outcome: "start_failed",
          parent: specialistHostRuntime.parent,
          reference: specialistHostRuntime.reference,
          sessionId: input.session.sessionId,
        });
      }
      const address = {
        continuationToken: startIdentity.continuationToken,
        kind: targetKind,
        sessionId: recovered.sessionId,
      } as const;
      return createCalledOutcome({
        action,
        address,
        delegationMessage: input.delegationMessage,
        hostRuntime: recovered.specialistHostRuntime,
        operationId: operation.id,
        preparedSession,
      });
    }

    logError(log, "local subagent start failed", error, {
      callId: action.callId,
      nodeId: action.nodeId,
      subagentName: action.subagentName,
    });
    let rejectedSession = rejectAgentEffect(preparedSession, {
      disposition: "dead",
      operationId: operation.id,
    });
    if (specialistHostRuntime?.parent !== undefined) {
      rejectedSession = enqueueHostRuntimeRelease(rejectedSession, {
        outcome: "start_failed",
        parent: specialistHostRuntime.parent,
        reference: specialistHostRuntime.reference,
        sessionId: input.session.sessionId,
      });
    }
    return {
      kind: "error",
      result: {
        callId: action.callId,
        isError: true,
        kind: "subagent-result",
        origin: "dispatch",
        output: {
          code: SUBAGENT_START_FAILED,
          message: toErrorMessage(error),
        },
        subagentName: action.subagentName,
      },
      session: rejectedSession,
    };
  }

  const address = {
    continuationToken: childContinuationToken,
    kind: targetKind,
    sessionId: childSessionId,
  } as const;
  return createCalledOutcome({
    action,
    address,
    delegationMessage: input.delegationMessage,
    hostRuntime:
      specialistHostRuntime?.parent === undefined
        ? undefined
        : {
            parent: specialistHostRuntime.parent,
            reference: specialistHostRuntime.reference,
          },
    operationId: operation.id,
    preparedSession,
  });
}

function createCalledOutcome(input: {
  readonly action: RuntimeSubagentCallActionRequest;
  readonly address: Extract<DispatchOutcome, { readonly kind: "called" }>["address"];
  readonly delegationMessage: string;
  readonly hostRuntime?: RecoveredLocalSubagentStart["specialistHostRuntime"];
  readonly operationId: string;
  readonly preparedSession: RuntimeSession;
}): DispatchOutcome {
  return {
    address: input.address,
    callId: input.action.callId,
    kind: "called",
    message: input.delegationMessage,
    name: input.action.name,
    session: confirmAgentStarted(input.preparedSession, {
      address: input.address,
      hostRuntime: input.hostRuntime,
      operationId: input.operationId,
    }),
    toolName: input.action.subagentName,
  };
}

function createStartConflictOutcome(input: {
  readonly action: RuntimeSubagentCallActionRequest;
  readonly session: RuntimeSession;
}): DispatchOutcome {
  return {
    kind: "error",
    result: {
      callId: input.action.callId,
      isError: true,
      kind: "subagent-result",
      origin: "dispatch",
      output: { code: SUBAGENT_START_CONFLICT, message: SUBAGENT_START_CONFLICT },
      subagentName: input.action.subagentName,
    },
    session: input.session,
  };
}
