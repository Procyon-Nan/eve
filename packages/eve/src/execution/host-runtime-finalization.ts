import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  notifyRootHostRuntimeReleaseStep,
  recordRootHostRuntimeReleaseStep,
  settleHostRuntimeReleasesStep,
  settleTerminatedHostRuntimeHandlesStep,
} from "#execution/host-runtime-release-step.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import { PENDING_HOST_RUNTIME_RELEASES_STATE_KEY } from "#harness/host-runtime-releases.js";
import type { DurableHostRuntimeContext, HostRuntimeReleaseOutcome } from "#shared/host-runtime.js";
import {
  HOST_RUNTIME_ERROR_CODES,
  type HostRuntimeErrorCode,
} from "#runtime/host-runtime/errors.js";

export function ownsRootHostRuntime(serializedContext: Record<string, unknown>): boolean {
  const hostRuntime = serializedContext["eve.hostRuntime"] as
    | { readonly ownership?: unknown }
    | undefined;
  return hostRuntime?.ownership === "root";
}

/** Carries an unreleased root reference across framework-owned internal deliveries. */
export function readActiveRootHostRuntime(
  serializedContext: Record<string, unknown>,
): DurableHostRuntimeContext | undefined {
  const hostRuntime = serializedContext["eve.hostRuntime"] as
    | { readonly ownership?: unknown; readonly releasedOutcome?: unknown }
    | undefined;
  return hostRuntime?.ownership === "root" && hostRuntime.releasedOutcome === undefined
    ? (hostRuntime as DurableHostRuntimeContext)
    : undefined;
}

export function hasPendingHostRuntimeReleases(sessionState: DurableSessionState): boolean {
  const pending = sessionState.snapshot?.session.state?.[PENDING_HOST_RUNTIME_RELEASES_STATE_KEY];
  return Array.isArray(pending) && pending.length > 0;
}

export async function flushHostRuntimeReleases(
  sessionState: DurableSessionState,
): Promise<DurableSessionState> {
  return hasPendingHostRuntimeReleases(sessionState)
    ? await settleHostRuntimeReleasesStep({ sessionState })
    : sessionState;
}

export async function terminateChildSessionsAndSettleHostRuntime(input: {
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<DurableSessionState> {
  await terminateChildSessionsStep(input);
  const settled = await settleTerminatedHostRuntimeHandlesStep({
    sessionState: input.sessionState,
  });
  return await flushHostRuntimeReleases(settled);
}

export async function settleRootHostRuntime(input: {
  readonly outcome: Exclude<HostRuntimeReleaseOutcome, "start_failed">;
  readonly serializedContext: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  if (!ownsRootHostRuntime(input.serializedContext)) return input.serializedContext;
  const hostRuntime = input.serializedContext["eve.hostRuntime"] as {
    readonly releasedOutcome?: unknown;
  };
  if (hostRuntime.releasedOutcome !== undefined) return input.serializedContext;
  const serializedContext = await recordRootHostRuntimeReleaseStep(input);
  await notifyRootHostRuntimeReleaseStep({ serializedContext });
  return serializedContext;
}

export function readFatalHostRuntimeErrorCode(error: unknown): HostRuntimeErrorCode | undefined {
  if (typeof error !== "object" || error === null || Reflect.get(error, "fatal") !== true) {
    return undefined;
  }
  return HOST_RUNTIME_ERROR_CODES.find((code) => Reflect.get(error, "message") === code);
}
