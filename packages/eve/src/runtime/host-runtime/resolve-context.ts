import type { DynamicResolveContext, DynamicToolSet } from "#shared/dynamic-tool-definition.js";
import type { PublicAgentModelSelectionDefinition } from "#shared/agent-definition.js";
import type { ResolvedHostRuntime } from "#shared/host-runtime.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";

const HOST_RUNTIME_RESOLVE_CONTEXT_STORE = Symbol.for("eve.host-runtime-resolve-context-store");

interface HostRuntimeResolveContextGlobal {
  [HOST_RUNTIME_RESOLVE_CONTEXT_STORE]?: WeakMap<object, ResolvedHostRuntime>;
}

const globalContainer = globalThis as typeof globalThis & HostRuntimeResolveContextGlobal;
globalContainer[HOST_RUNTIME_RESOLVE_CONTEXT_STORE] ??= new WeakMap();
const hostRuntimeResolveContextStore = globalContainer[HOST_RUNTIME_RESOLVE_CONTEXT_STORE];

export function attachHostRuntimeResolveHandle(
  context: DynamicResolveContext,
  resolved: ResolvedHostRuntime | undefined,
): void {
  if (resolved === undefined) return;
  hostRuntimeResolveContextStore.set(context, resolved);
}

function requireResolvedHostRuntime(context: DynamicResolveContext): ResolvedHostRuntime {
  const resolved = hostRuntimeResolveContextStore.get(context);
  if (resolved === undefined) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return resolved;
}

/** Returns the active host model selection without exposing the durable reference. */
export function hostRuntimeModel(
  context: DynamicResolveContext,
): PublicAgentModelSelectionDefinition {
  const resolved = requireResolvedHostRuntime(context);
  return {
    model: resolved.model,
    ...(resolved.contextWindowTokens === undefined
      ? {}
      : { modelContextWindowTokens: resolved.contextWindowTokens }),
  };
}

/** Returns only the host-owned business instructions for the current preflight. */
export function hostRuntimeInstructions(context: DynamicResolveContext): string | undefined {
  return requireResolvedHostRuntime(context).instructions;
}

/** Returns only the host-owned ordinary dynamic tools for the current preflight. */
export function hostRuntimeTools(context: DynamicResolveContext): DynamicToolSet | undefined {
  return requireResolvedHostRuntime(context).tools;
}
