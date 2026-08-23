import { HostRuntimeContextKey, SessionIdKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import {
  clearPendingHostRuntimeReleases,
  readPendingHostRuntimeReleases,
} from "#harness/host-runtime-releases.js";
import { terminateHostRuntimeAgentHandles } from "#harness/handles/transitions.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";
import { releaseHostRuntimeReference } from "#runtime/host-runtime/release.js";
import { validateDurableHostRuntimeContext } from "#runtime/host-runtime/validation.js";
import type { HostRuntimeReleaseOutcome } from "#shared/host-runtime.js";

/** Durably records a root-turn outcome after its core terminal transition commits. */
export async function recordRootHostRuntimeReleaseStep(input: {
  readonly outcome: Exclude<HostRuntimeReleaseOutcome, "start_failed">;
  readonly serializedContext: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const durable = ctx.get(HostRuntimeContextKey);
  if (durable === undefined || durable.ownership !== "root") return input.serializedContext;
  const validated = validateDurableHostRuntimeContext(durable);
  if (validated.releasedOutcome !== undefined) {
    if (validated.releasedOutcome !== input.outcome) {
      throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
    }
    return input.serializedContext;
  }
  ctx.set(HostRuntimeContextKey, { ...validated, releasedOutcome: input.outcome });
  return serializeContext(ctx);
}

/** Delivers a root release whose outcome was committed by the preceding step. */
export async function notifyRootHostRuntimeReleaseStep(input: {
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const durable = ctx.get(HostRuntimeContextKey);
  if (durable?.ownership !== "root" || durable.releasedOutcome === undefined) return;
  const validated = validateDurableHostRuntimeContext(durable);
  const outcome = validated.releasedOutcome;
  if (outcome === undefined) return;
  await releaseHostRuntimeReference({
    outcome,
    reference: validated.reference,
    sessionId: ctx.require(SessionIdKey),
  });
}

/** Delivers parent-owned specialist notices after handle settlement commits. */
export async function settleHostRuntimeReleasesStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<DurableSessionState> {
  "use step";

  const session = await readDurableSession(input.sessionState);
  const releases = readPendingHostRuntimeReleases(session);
  if (releases.length === 0) return input.sessionState;

  for (const release of releases) {
    await releaseHostRuntimeReference(release);
  }
  return {
    ...input.sessionState,
    snapshot: {
      ...input.sessionState.snapshot,
      session: clearPendingHostRuntimeReleases(session),
      version: input.sessionState.version,
    },
  };
}

/** Records cancellation for specialist handles whose parent session is terminating. */
export async function settleTerminatedHostRuntimeHandlesStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<DurableSessionState> {
  "use step";

  // Snapshot-less states predate host-runtime handle ownership, so their
  // legacy stream cannot contain a specialist reference to settle.
  if (input.sessionState.snapshot === undefined) return input.sessionState;
  const session = await readDurableSession(input.sessionState);
  const settled = terminateHostRuntimeAgentHandles(session);
  if (settled === session) return input.sessionState;
  return {
    ...input.sessionState,
    snapshot: {
      ...input.sessionState.snapshot,
      session: settled,
      version: input.sessionState.version,
    },
  };
}
