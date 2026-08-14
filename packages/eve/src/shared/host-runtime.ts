import type { LanguageModel } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { DynamicToolSet } from "#shared/dynamic-tool-definition.js";

export const HOST_RUNTIME_DEFINITION_KIND = "eve.host-runtime" as const;
export const HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE = "$eve.host_runtime_acceptance";
export const HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE = "$eve.host_runtime_acceptance_status";

/** Durable, opaque reference to a host-owned runtime snapshot. */
export interface HostRuntimeReference {
  readonly providerKind: string;
  readonly value: string;
}

/** Source declaration used by a dynamic local specialist. */
export interface HostRuntimeDefinition {
  readonly kind: typeof HOST_RUNTIME_DEFINITION_KIND;
  readonly providerKind: string;
}

/** Stable parent coordinates attached to a specialist reference. */
export interface HostRuntimeParentLineage {
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly subagentName: string;
}

export interface HostRuntimeResolveInput {
  readonly reference: HostRuntimeReference;
  readonly sessionId: string;
  readonly parent?: HostRuntimeParentLineage;
}

export interface SpecialistReferenceFactoryInput {
  readonly parentReference: HostRuntimeReference;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly callId: string;
  readonly subagentName: string;
  readonly auth: SessionAuthContext | null;
  readonly initiatorAuth: SessionAuthContext | null;
}

export interface ResolvedHostRuntime {
  readonly model: LanguageModel;
  readonly modelId: string;
  readonly contextWindowTokens?: number;
  readonly modelCallTimeoutMs?: number;
  readonly instructions?: string;
  readonly tools?: DynamicToolSet;
  readonly delegatedSubagentNames?: readonly string[];
}

export type HostRuntimeReleaseOutcome = "completed" | "failed" | "cancelled" | "start_failed";

export type HostRuntimeReleaseInput = HostRuntimeResolveInput & {
  readonly outcome: HostRuntimeReleaseOutcome;
};

export interface HostRuntimeProvider {
  readonly providerKind: string;
  readonly resolve: (input: HostRuntimeResolveInput) => Promise<ResolvedHostRuntime>;
  readonly createSpecialistReference?: (
    input: SpecialistReferenceFactoryInput,
  ) => Promise<HostRuntimeReference>;
  readonly release?: (input: HostRuntimeReleaseInput) => Promise<void>;
}

/** Durable ownership metadata kept out of authored resolver projections. */
export interface DurableHostRuntimeContext {
  readonly acceptanceKey?: string;
  readonly ownership: "root" | "specialist" | "inherited";
  readonly parent?: HostRuntimeParentLineage;
  readonly reference: HostRuntimeReference;
  readonly releasedOutcome?: HostRuntimeReleaseOutcome;
}

export interface TrustedHostRuntimeInput {
  readonly acceptanceKey: string;
  readonly reference: HostRuntimeReference;
}

export type HostRuntimeAcceptanceStatus = "ACCEPTED" | "NOT_ACCEPTED";

export function isHostRuntimeDefinition(value: unknown): value is HostRuntimeDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly kind?: unknown }).kind === HOST_RUNTIME_DEFINITION_KIND
  );
}
