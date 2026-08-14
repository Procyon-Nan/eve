/**
 * Core agent authoring helpers for `agent/agent.ts`.
 */

export {
  type AgentCompactionDefinition,
  type AgentDefinition,
  type AgentExperimentalDefinition,
  type AgentLimitsDefinition,
  type AgentModelDefinition,
  type AgentModelOptionsDefinition,
  type AgentReasoningDefinition,
  type AgentWorkflowDefinition,
  type AgentWorkflowWorldDefinition,
  type DefinedAgent,
  type DynamicSubagentDefinition,
  type DynamicLocalSubagentDefinition,
  type HostRuntimeAgentDefinition,
  defineAgent,
  defineDynamic,
  defineHostRuntime,
} from "#public/definitions/agent.js";
export { type HostRuntimeErrorCode, HostRuntimeError } from "#runtime/host-runtime/errors.js";
export { registerHostRuntimeProvider } from "#runtime/host-runtime/provider.js";
export {
  hostRuntimeInstructions,
  hostRuntimeModel,
  hostRuntimeTools,
} from "#runtime/host-runtime/resolve-context.js";
export { withHostRuntime } from "#runtime/host-runtime/trusted-auth.js";
export type {
  HostRuntimeAcceptanceStatus,
  HostRuntimeDefinition,
  HostRuntimeParentLineage,
  HostRuntimeProvider,
  HostRuntimeReference,
  HostRuntimeReleaseInput,
  HostRuntimeReleaseOutcome,
  HostRuntimeResolveInput,
  ResolvedHostRuntime,
  SpecialistReferenceFactoryInput,
  TrustedHostRuntimeInput,
} from "#shared/host-runtime.js";
export type { DynamicResolveContext, DynamicSentinel } from "#shared/dynamic-tool-definition.js";
export {
  type RemoteAgentDefinition,
  type RemoteAgentDefinitionInput,
  type RemoteAgentUrl,
  defineRemoteAgent,
} from "#public/definitions/remote-agent.js";
