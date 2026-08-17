import type { SessionAuthContext } from "#channel/types.js";
import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import type { LocalSubagentStartIdentity } from "#execution/subagent-tool.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import {
  HostRuntimeError,
  sanitizeHostRuntimeProviderFailure,
} from "#runtime/host-runtime/errors.js";
import { validateHostRuntimeReference } from "#runtime/host-runtime/validation.js";
import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import type { DurableHostRuntimeContext, HostRuntimeParentLineage } from "#shared/host-runtime.js";

const log = createLogger("execution.dispatch-runtime-actions");

export async function prepareLocalSubagentHostRuntime(input: {
  readonly auth: SessionAuthContext | null;
  readonly authorizedSpecialistNames: ReadonlySet<string>;
  readonly config: DynamicSubagentAgentConfig | undefined;
  readonly initiatorAuth: SessionAuthContext | null;
  readonly parentHostRuntime: DurableHostRuntimeContext | undefined;
  readonly persistentSessions: boolean;
  readonly session: RuntimeSession;
  readonly startIdentity: LocalSubagentStartIdentity;
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
    !input.authorizedSpecialistNames.has(input.startIdentity.subagentName)
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
    callId: input.startIdentity.callId,
    rootSessionId: input.startIdentity.rootSessionId,
    sessionId: input.startIdentity.parentSessionId,
    subagentName: input.startIdentity.subagentName,
    turnId: input.startIdentity.parentTurnId,
  };

  let createdReference: unknown;
  try {
    createdReference = await provider.createSpecialistReference({
      auth: input.auth,
      callId: input.startIdentity.callId,
      initiatorAuth: input.initiatorAuth,
      parentReference: parent.reference,
      parentSessionId: input.startIdentity.parentSessionId,
      parentTurnId: input.startIdentity.parentTurnId,
      subagentName: input.startIdentity.subagentName,
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
          callId: input.startIdentity.callId,
          errorId: createErrorId(),
          providerKind: parent.reference.providerKind,
          subagentName: input.startIdentity.subagentName,
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
