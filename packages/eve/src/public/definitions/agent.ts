import type {
  AgentBuildDefinition,
  PublicAgentDefinition,
  PublicHostRuntimeAgentDefinition,
} from "#shared/agent-definition.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { RemoteAgentDefinition } from "#public/definitions/remote-agent.js";
import { defineDynamic as defineDynamicBase } from "#public/definitions/tool.js";
import type {
  DynamicEvents,
  DynamicEventsWithFallback,
  DynamicSentinel,
} from "#shared/dynamic-tool-definition.js";
import { HOST_RUNTIME_DEFINITION_KIND, type HostRuntimeDefinition } from "#shared/host-runtime.js";
import {
  validateHostRuntimeDefinition,
  validateProviderKind,
} from "#runtime/host-runtime/validation.js";

declare const DEFINED_AGENT: unique symbol;

export type {
  AgentModelResolveContext,
  AgentModelOptionsDefinition,
  AgentModelResolver,
  AgentReasoningDefinition,
  AgentBuildDefinition,
  PublicAgentDynamicModelDefinition as AgentDynamicModelDefinition,
  PublicAgentDynamicModelResult as AgentDynamicModelResult,
  AgentExperimentalDefinition,
  AgentLimitsDefinition,
  PublicAgentModelSelectionDefinition as AgentModelSelectionDefinition,
  AgentWorkflowDefinition,
  AgentWorkflowWorldDefinition,
  PublicAgentModelDefinition as AgentModelDefinition,
  PublicAgentStaticModelDefinition as AgentStaticModelDefinition,
  PublicAgentCompactionDefinition as AgentCompactionDefinition,
} from "#shared/agent-definition.js";

/**
 * Additive public agent configuration authored in `agent.ts`.
 *
 * The compiler derives identity at compile time from `manifest.agentId` (the
 * package name or app-root basename), so do not author a `name` field.
 *
 * Declare authentication and network policies on the channel that handles the
 * inbound request, not here. See `eve/channels/auth` for the verifier helpers a
 * channel uses to gate its `fetch` handler.
 */
export type AgentDefinition = PublicAgentDefinition;

/** Runtime-complete local specialist definition selected at turn scope. */
export type HostRuntimeAgentDefinition = PublicHostRuntimeAgentDefinition & {
  readonly description: string;
};

/** Literal-preserving value returned by {@link defineAgent}. */
export type DefinedAgent<
  TAgent extends AgentDefinition | HostRuntimeAgentDefinition =
    | AgentDefinition
    | HostRuntimeAgentDefinition,
> = TAgent & {
  readonly [DEFINED_AGENT]: true;
};

/**
 * Agent configuration returned by a dynamic subagent resolver. The description
 * tells the parent agent when to delegate.
 */
export type DynamicLocalSubagentDefinition =
  | (AgentDefinition & { readonly description: string })
  | HostRuntimeAgentDefinition;

/** Definition a dynamic subagent resolver may select at runtime. */
export type DynamicSubagentDefinition = DynamicLocalSubagentDefinition | RemoteAgentDefinition;

type DynamicEventHandler<TEvents extends DynamicEvents> = Extract<
  NonNullable<TEvents[keyof TEvents]>,
  (...args: never[]) => unknown
>;
type DynamicEventResult<TEvents extends DynamicEvents> = Awaited<
  ReturnType<DynamicEventHandler<TEvents>>
>;
type DynamicSubagentDescriptionConstraint<TEvents extends DynamicEvents> =
  Exclude<
    Extract<DynamicEventResult<TEvents>, DefinedAgent>,
    DynamicLocalSubagentDefinition
  > extends never
    ? unknown
    : { readonly "Dynamic subagent definitions require a description": never };
type DynamicHostRuntimeConstraint<TEvents extends DynamicEvents> =
  Extract<
    Extract<DynamicEventResult<TEvents>, DefinedAgent>,
    HostRuntimeAgentDefinition
  > extends never
    ? { readonly runtime?: HostRuntimeDefinition }
    : { readonly runtime: HostRuntimeDefinition };

interface DefineDynamicAgent {
  <const TEvents extends DynamicEventsWithFallback, TFallback = unknown>(
    definition: {
      readonly fallback: TFallback;
      readonly events: TEvents;
    } & DynamicSubagentDescriptionConstraint<TEvents> &
      DynamicHostRuntimeConstraint<TEvents>,
  ): DynamicSentinel<Exclude<DynamicEventResult<TEvents>, undefined>, TFallback>;
  <const TEvents extends DynamicEvents>(
    definition: {
      readonly build?: AgentBuildDefinition;
      readonly events: TEvents;
    } & DynamicSubagentDescriptionConstraint<TEvents> &
      DynamicHostRuntimeConstraint<TEvents>,
  ): DynamicSentinel<DynamicEventResult<TEvents>> & { readonly runtime?: HostRuntimeDefinition };
}

/**
 * Defines dynamic agent configuration. A returned subagent requires a
 * description so its parent knows when to delegate. Use `build` for static
 * packaging controls that must apply before the runtime resolver runs.
 */
export const defineDynamic: DefineDynamicAgent = ((definition: {
  readonly build?: AgentBuildDefinition;
  readonly events: DynamicEvents;
  readonly fallback?: unknown;
  readonly runtime?: HostRuntimeDefinition;
}) => {
  const sentinel = Object.hasOwn(definition, "fallback")
    ? defineDynamicBase({ events: definition.events, fallback: definition.fallback })
    : defineDynamicBase({ events: definition.events });
  const result: Record<string, unknown> = { ...sentinel };
  if (definition.build !== undefined) result.build = definition.build;
  if (definition.runtime !== undefined) {
    result.runtime = validateHostRuntimeDefinition(definition.runtime);
  }
  return result;
}) as DefineDynamicAgent;

/**
 * Defines the agent configuration authored in `agent.ts` and returns it
 * unchanged, preserving its literal type.
 *
 * TypeScript checks the argument against {@link AgentDefinition}: any key outside
 * that shape is a compile error. The compiler derives identity (the agent name)
 * at compile time from `manifest.agentId` (the package name or app-root
 * basename), so do not author a `name` field.
 */
export function defineAgent<TAgent extends AgentDefinition>(
  definition: ExactDefinition<TAgent, AgentDefinition>,
): DefinedAgent<TAgent>;
export function defineAgent<TAgent extends HostRuntimeAgentDefinition>(
  definition: ExactDefinition<TAgent, HostRuntimeAgentDefinition>,
): DefinedAgent<TAgent>;
export function defineAgent<TAgent extends AgentDefinition | HostRuntimeAgentDefinition>(
  definition: TAgent extends HostRuntimeAgentDefinition
    ? ExactDefinition<TAgent, HostRuntimeAgentDefinition>
    : ExactDefinition<TAgent, AgentDefinition>,
): DefinedAgent<TAgent>;
export function defineAgent(
  definition: AgentDefinition | HostRuntimeAgentDefinition,
): AgentDefinition | HostRuntimeAgentDefinition {
  return definition;
}

/** Declares that a dynamic local specialist obtains its runtime from the host. */
export function defineHostRuntime(input: { readonly providerKind: string }): HostRuntimeDefinition {
  return {
    kind: HOST_RUNTIME_DEFINITION_KIND,
    providerKind: validateProviderKind(input.providerKind),
  };
}
