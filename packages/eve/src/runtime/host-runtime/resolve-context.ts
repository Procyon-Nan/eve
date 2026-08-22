import type { PublicAgentModelSelectionDefinition } from "#shared/agent-definition.js";
import type { DynamicResolveContext, DynamicToolSet } from "#shared/dynamic-tool-definition.js";
import type { ResolvedHostRuntime } from "#shared/host-runtime.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";

const STORE_KEY = Symbol.for("eve.host-runtime-resolve-context-store");

interface HostRuntimeResolveContextGlobal {
  [STORE_KEY]?: WeakMap<object, HostRuntimeResolveHandle>;
}

interface HostRuntimeResolveHandle {
  readonly scope: HostRuntimeResolveScope;
  readonly resolved: ResolvedHostRuntime;
}

export interface HostRuntimeResolveScope {
  readonly capability: "instructions" | "model" | "tool";
  readonly eventType: string;
}

const globalContainer = globalThis as typeof globalThis & HostRuntimeResolveContextGlobal;
globalContainer[STORE_KEY] ??= new WeakMap();
const store = globalContainer[STORE_KEY];

export function attachHostRuntimeResolveHandle(
  context: DynamicResolveContext,
  resolved: ResolvedHostRuntime | undefined,
  scope: HostRuntimeResolveScope | undefined,
): void {
  if (resolved !== undefined && scope !== undefined) {
    store.set(context, { resolved, scope });
  }
}

function requireResolvedHostRuntime(
  context: DynamicResolveContext,
  capability: HostRuntimeResolveScope["capability"],
  allowedEvents: ReadonlySet<string>,
): ResolvedHostRuntime {
  const handle = store.get(context);
  if (
    handle === undefined ||
    handle.scope.capability !== capability ||
    !allowedEvents.has(handle.scope.eventType)
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return handle.resolved;
}

const TURN_EVENTS = new Set(["turn.started"]);
const STEP_EVENTS = new Set(["step.started"]);
const TURN_OR_STEP_EVENTS = new Set(["turn.started", "step.started"]);

/** Returns the step-scoped host model without exposing its durable reference. */
export function hostRuntimeModel(
  context: DynamicResolveContext,
): PublicAgentModelSelectionDefinition {
  const resolved = requireResolvedHostRuntime(context, "model", STEP_EVENTS);
  return {
    model: resolved.model,
    ...(resolved.contextWindowTokens === undefined
      ? {}
      : { modelContextWindowTokens: resolved.contextWindowTokens }),
  };
}

/** Returns host-owned instructions for the active turn boundary. */
export function hostRuntimeInstructions(context: DynamicResolveContext): string | undefined {
  return requireResolvedHostRuntime(context, "instructions", TURN_EVENTS).instructions;
}

/** Returns host-owned ordinary tools for the active turn or step boundary. */
export function hostRuntimeTools(context: DynamicResolveContext): DynamicToolSet | undefined {
  return requireResolvedHostRuntime(context, "tool", TURN_OR_STEP_EVENTS).tools;
}
