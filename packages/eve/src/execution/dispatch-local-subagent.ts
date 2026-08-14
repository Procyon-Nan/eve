import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { DispatchOutcome, RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { SUBAGENT_START_FAILED } from "#harness/agent-handle-errors.js";
import {
  confirmAgentStarted,
  prepareAgentStart,
  rejectAgentEffect,
} from "#harness/handles/transitions.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import { mintStartOperation } from "#execution/dispatch-start-operation.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#execution/subagent-tool.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createErrorId, createLogger, logError } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { releaseHostRuntimeReference } from "#runtime/host-runtime/preflight.js";
import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";
import {
  HostRuntimeError,
  isHostRuntimeError,
  sanitizeHostRuntimeProviderFailure,
} from "#runtime/host-runtime/errors.js";
import { validateHostRuntimeReference } from "#runtime/host-runtime/validation.js";
import type { DurableHostRuntimeContext, HostRuntimeParentLineage } from "#shared/host-runtime.js";
import { enqueueHostRuntimeRelease } from "#harness/host-runtime-releases.js";

const log = createLogger("execution.dispatch-runtime-actions");

export type DynamicSubagentAgentConfig = NonNullable<
  Extract<
    ReturnType<typeof getDynamicSubagentSelection>,
    { readonly kind: "subagent" }
  >["agentConfig"]
>;

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
  let dynamicSubagentAgentConfig = input.dynamicSubagentAgentConfig;
  let specialistHostRuntime: DurableHostRuntimeContext | undefined;
  try {
    const prepared = await prepareSpecialistHostRuntime({
      action,
      auth: input.auth,
      authorizedSpecialistNames: input.authorizedSpecialistNames,
      config: dynamicSubagentAgentConfig,
      initiatorAuth: input.initiatorAuth,
      parentHostRuntime: input.parentHostRuntime,
      persistentSessions: input.persistentSessions,
      session: input.session,
      turnId: input.batchEvent.turnId,
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
  const childRuntime = createWorkflowRuntime({
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
            callId: action.callId,
            rootSessionId: input.session.rootSessionId ?? input.session.sessionId,
            sessionId: input.session.sessionId,
            subagentName: action.subagentName,
            turnId: input.batchEvent.turnId,
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
  });

  const targetKind = source.type === "runtime" ? ("agent/self" as const) : ("agent/local" as const);
  const { identity, operation } = mintStartOperation({
    callId: action.callId,
    name: action.subagentName,
    nodeId: action.nodeId,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.batchEvent.turnId,
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
      ...(specialistHostRuntime?.parent === undefined
        ? {}
        : {
            hostRuntime: {
              parent: specialistHostRuntime.parent,
              reference: specialistHostRuntime.reference,
            },
          }),
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
  return {
    address,
    callId: action.callId,
    kind: "called",
    message: input.delegationMessage,
    name: action.name,
    session: confirmAgentStarted(preparedSession, {
      address,
      operationId: operation.id,
    }),
    toolName: action.subagentName,
  };
}

async function prepareSpecialistHostRuntime(input: {
  readonly action: RuntimeSubagentCallActionRequest;
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly authorizedSpecialistNames: ReadonlySet<string>;
  readonly config: DynamicSubagentAgentConfig | undefined;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly parentHostRuntime: DurableHostRuntimeContext | undefined;
  readonly persistentSessions: boolean;
  readonly session: RuntimeSession;
  readonly turnId: string;
}): Promise<{
  readonly config: DynamicSubagentAgentConfig | undefined;
  readonly hostRuntime: DurableHostRuntimeContext | undefined;
}> {
  if (input.config?.runtime === undefined) {
    return { config: input.config, hostRuntime: undefined };
  }
  if (input.persistentSessions) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
  const parent = input.parentHostRuntime;
  if (
    parent === undefined ||
    parent.ownership !== "root" ||
    !input.authorizedSpecialistNames.has(input.action.subagentName)
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  const provider = getActiveRuntimeSession().hostRuntimeProviders.get(
    parent.reference.providerKind,
  );
  if (provider === undefined) {
    throw new HostRuntimeError("HOST_RUNTIME_PROVIDER_NOT_REGISTERED");
  }
  if (provider.createSpecialistReference === undefined) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
  const lineage: HostRuntimeParentLineage = {
    callId: input.action.callId,
    rootSessionId: input.session.rootSessionId ?? input.session.sessionId,
    sessionId: input.session.sessionId,
    subagentName: input.action.subagentName,
    turnId: input.turnId,
  };

  let createdReference: unknown;
  try {
    createdReference = await provider.createSpecialistReference({
      auth: input.auth,
      callId: input.action.callId,
      initiatorAuth: input.initiatorAuth,
      parentReference: parent.reference,
      parentSessionId: input.session.sessionId,
      parentTurnId: input.turnId,
      subagentName: input.action.subagentName,
    });
  } catch (error) {
    throw sanitizeHostRuntimeProviderFailure(error);
  }
  const reference = validateHostRuntimeReference(createdReference);
  if (
    reference.providerKind !== input.config.runtime.providerKind ||
    !getActiveRuntimeSession().hostRuntimeProviders.has(reference.providerKind)
  ) {
    if (provider.release !== undefined) {
      try {
        await provider.release({
          outcome: "start_failed",
          parent: lineage,
          reference,
          sessionId: input.session.sessionId,
        });
      } catch {
        log.warn("host runtime release callback failed", {
          callId: input.action.callId,
          errorId: createErrorId(),
          providerKind: parent.reference.providerKind,
          subagentName: input.action.subagentName,
        });
      }
    }
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  const hostRuntime: DurableHostRuntimeContext = {
    ownership: "specialist",
    parent: lineage,
    reference,
  };
  return {
    config: {
      ...input.config,
      runtime: { ...input.config.runtime, parent: lineage, reference },
    },
    hostRuntime,
  };
}
