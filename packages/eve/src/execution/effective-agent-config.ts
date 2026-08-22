import type { LanguageModel } from "ai";

import type { ContextReader } from "#context/key.js";
import {
  DynamicSubagentAgentConfigKey,
  HostRuntimeContextKey,
  HostRuntimePreflightKey,
} from "#context/keys.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { AgentLimitsDefinition } from "#shared/agent-definition.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import type { DurableHostRuntimeContext } from "#shared/host-runtime.js";

export interface EffectiveAgentRuntime {
  readonly hostModel?: LanguageModel;
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
      durable: context.get(HostRuntimeContextKey),
      resolved: context.get(HostRuntimePreflightKey),
    },
  );
}

export function resolveEffectiveAgentRuntimeFromConfig(
  bundle: Pick<CompiledBundle, "resolvedAgent" | "turnAgent">,
  config: DynamicSubagentAgentConfig | undefined,
  host: {
    readonly durable?: DurableHostRuntimeContext;
    readonly resolved?: import("#shared/host-runtime.js").ResolvedHostRuntime;
  } = {},
): EffectiveAgentRuntime {
  if (config === undefined) {
    if (bundle.turnAgent.configResolver === true) {
      throw new Error("Dynamic subagent execution requires a selected concrete agent config.");
    }
    return {
      limits: bundle.resolvedAgent.config?.limits,
      thresholdPercent: bundle.resolvedAgent.config?.compaction?.thresholdPercent,
      turnAgent: bundle.turnAgent,
    };
  }

  const {
    compactionModel: _compiledCompactionModel,
    configResolver: _configResolver,
    dynamicModel: _dynamicModel,
    model: _compiledModel,
    ...turnAgent
  } = bundle.turnAgent;
  if (config.runtime !== undefined) {
    validateSpecialistRuntime(config, host.durable);
    const model = {
      id: host.resolved?.modelId ?? "host-runtime",
      ...(host.resolved?.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: host.resolved.contextWindowTokens }),
    };
    return {
      hostModel: host.resolved?.model,
      limits: config.limits,
      thresholdPercent: config.compaction?.thresholdPercent,
      turnAgent: {
        ...turnAgent,
        compactionModel: model,
        model,
        outputSchema: config.outputSchema,
        reasoning: config.reasoning,
      },
    };
  }

  return {
    limits: config.limits,
    thresholdPercent: config.compaction?.thresholdPercent,
    turnAgent: {
      ...turnAgent,
      compactionModel: config.compaction?.model,
      model: config.model,
      outputSchema: config.outputSchema,
      reasoning: config.reasoning,
    },
  };
}

function validateSpecialistRuntime(
  config: DynamicSubagentAgentConfig,
  durable: DurableHostRuntimeContext | undefined,
): void {
  const runtime = config.runtime;
  if (
    runtime === undefined ||
    runtime.reference === undefined ||
    runtime.parent === undefined ||
    durable?.ownership !== "specialist" ||
    durable.parent === undefined ||
    runtime.providerKind !== durable.reference.providerKind ||
    runtime.reference.providerKind !== durable.reference.providerKind ||
    runtime.reference.value !== durable.reference.value ||
    !sameParentLineage(runtime.parent, durable.parent)
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
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
