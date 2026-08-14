import type { DurableHostRuntimeContext } from "#shared/host-runtime.js";

/** Reads the active root reference that may be inherited by a built-in child. */
export function readActiveRootHostRuntime(
  serializedContext: Record<string, unknown>,
): DurableHostRuntimeContext | undefined {
  const hostRuntime = serializedContext["eve.hostRuntime"] as DurableHostRuntimeContext | undefined;
  return hostRuntime?.ownership === "root" && hostRuntime.releasedOutcome === undefined
    ? hostRuntime
    : undefined;
}
