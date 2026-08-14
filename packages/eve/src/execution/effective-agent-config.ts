import type { ContextReader } from "#context/key.js";
import {
  DynamicSubagentAgentConfigKey,
  HostRuntimeContextKey,
  HostRuntimePreflightKey,
} from "#context/keys.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { AgentLimitsDefinition } from "#shared/agent-definition.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import type { DurableHostRuntimeContext, ResolvedHostRuntime } from "#shared/host-runtime.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";

export interface EffectiveAgentRuntime {
  readonly limits?: AgentLimitsDefinition;
  readonly thresholdPercent?: number;
  readonly turnAgent: RuntimeTurnAgent;
}

export function resolveEffectiveAgentRuntime(
  bundle: Pick<CompiledBundle, "resolvedAgent" | "turnAgent">,
  context: ContextReader,
): EffectiveAgentRuntime {
  return resolveEffectiveAgentRuntimeFromConfig(
    bundle,
    context.get(DynamicSubagentAgentConfigKey),
    {
      hostRuntime: context.get(HostRuntimeContextKey),
      resolvedHostRuntime: context.get(HostRuntimePreflightKey),
    },
  );
}

export function resolveEffectiveAgentRuntimeFromConfig(
  bundle: Pick<CompiledBundle, "resolvedAgent" | "turnAgent">,
  config: DynamicSubagentAgentConfig | undefined,
  host: {
    readonly hostRuntime?: DurableHostRuntimeContext;
    readonly resolvedHostRuntime?: ResolvedHostRuntime;
  } = {},
): EffectiveAgentRuntime {
  if (config === undefined) {
    return {
      limits: bundle.resolvedAgent.config.limits,
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
      turnAgent: bundle.turnAgent,
    };
  }

  const hostReference = resolveHostRuntimeReference(config, host.hostRuntime);
  const model =
    hostReference === undefined
      ? config.model
      : {
          id: host.resolvedHostRuntime?.modelId ?? "host-runtime",
          type: "host-runtime" as const,
          reference: hostReference,
          ...(host.resolvedHostRuntime?.contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens: host.resolvedHostRuntime.contextWindowTokens }),
        };
  if (model === undefined) {
    throw new Error("Dynamic subagent config is missing its runtime model.");
  }

  return {
    limits: config.limits,
    thresholdPercent: config.compaction?.thresholdPercent,
    turnAgent: {
      ...bundle.turnAgent,
      compactionModel: hostReference === undefined ? config.compaction?.model : model,
      dynamicModel: undefined,
      model,
      outputSchema: config.outputSchema,
      reasoning: config.reasoning,
    },
  };
}

function resolveHostRuntimeReference(
  config: DynamicSubagentAgentConfig,
  durable: DurableHostRuntimeContext | undefined,
): DurableHostRuntimeContext["reference"] | undefined {
  if (config.runtime === undefined) return undefined;
  if (
    durable === undefined ||
    durable.ownership !== "specialist" ||
    durable.parent === undefined ||
    config.runtime.reference === undefined ||
    config.runtime.parent === undefined ||
    config.runtime.providerKind !== durable.reference.providerKind ||
    config.runtime.reference.providerKind !== durable.reference.providerKind ||
    config.runtime.reference.value !== durable.reference.value ||
    !sameParentLineage(config.runtime.parent, durable.parent)
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return durable.reference;
}

function sameParentLineage(
  left: NonNullable<NonNullable<DynamicSubagentAgentConfig["runtime"]>["parent"]>,
  right: NonNullable<DurableHostRuntimeContext["parent"]>,
): boolean {
  return (
    left.rootSessionId === right.rootSessionId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.callId === right.callId &&
    left.subagentName === right.subagentName
  );
}
