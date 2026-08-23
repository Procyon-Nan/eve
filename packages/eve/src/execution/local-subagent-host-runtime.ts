import type { SessionAuthContext } from "#channel/types.js";
import {
  HostRuntimeError,
  sanitizeHostRuntimeProviderFailure,
} from "#runtime/host-runtime/errors.js";
import { validateHostRuntimeReference } from "#runtime/host-runtime/validation.js";
import { releaseHostRuntimeReference } from "#runtime/host-runtime/release.js";
import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import type { DurableHostRuntimeContext, HostRuntimeParentLineage } from "#shared/host-runtime.js";

export async function prepareLocalSubagentHostRuntime(input: {
  readonly auth: SessionAuthContext | null;
  readonly authorizedSpecialistNames: ReadonlySet<string>;
  readonly callId: string;
  readonly config: DynamicSubagentAgentConfig | undefined;
  readonly initiatorAuth: SessionAuthContext | null;
  readonly parentHostRuntime: DurableHostRuntimeContext | undefined;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly persistentSessions: boolean;
  readonly rootSessionId: string;
  readonly subagentName: string;
  readonly taskOwned: boolean;
}): Promise<{
  readonly config: DynamicSubagentAgentConfig | undefined;
  readonly hostRuntime: DurableHostRuntimeContext | undefined;
}> {
  if (input.config?.runtime === undefined) {
    return { config: input.config, hostRuntime: undefined };
  }
  if (input.persistentSessions && !input.taskOwned) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }

  const parent = input.parentHostRuntime;
  if (
    parent?.ownership !== "root" ||
    parent.reference.providerKind !== input.config.runtime.providerKind ||
    !input.authorizedSpecialistNames.has(input.subagentName)
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
    callId: input.callId,
    rootSessionId: input.rootSessionId,
    sessionId: input.parentSessionId,
    subagentName: input.subagentName,
    turnId: input.parentTurnId,
  };

  let created: unknown;
  try {
    created = await provider.createSpecialistReference({
      auth: input.auth,
      callId: input.callId,
      initiatorAuth: input.initiatorAuth,
      parentReference: parent.reference,
      parentSessionId: input.parentSessionId,
      parentTurnId: input.parentTurnId,
      subagentName: input.subagentName,
    });
  } catch (error) {
    throw sanitizeHostRuntimeProviderFailure(error);
  }

  const reference = validateHostRuntimeReference(created);
  if (reference.providerKind !== input.config.runtime.providerKind) {
    await releaseHostRuntimeReference(
      {
        outcome: "start_failed",
        parent: lineage,
        reference,
        sessionId: input.parentSessionId,
      },
      provider,
    );
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }

  return {
    config: {
      ...input.config,
      runtime: { ...input.config.runtime, parent: lineage, reference },
    },
    hostRuntime: { ownership: "specialist", parent: lineage, reference },
  };
}
