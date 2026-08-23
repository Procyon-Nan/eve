import {
  validateHostRuntimeParentLineage,
  validateHostRuntimeReference,
} from "#runtime/host-runtime/validation.js";
import type {
  HostRuntimeParentLineage,
  HostRuntimeReference,
  HostRuntimeReleaseOutcome,
} from "#shared/host-runtime.js";

export const PENDING_HOST_RUNTIME_RELEASES_STATE_KEY = "eve.runtime.pendingHostRuntimeReleases";

export interface PendingHostRuntimeRelease {
  readonly outcome: HostRuntimeReleaseOutcome;
  readonly parent: HostRuntimeParentLineage;
  readonly reference: HostRuntimeReference;
  readonly sessionId: string;
}

type Stateful = { readonly state?: Readonly<Record<string, unknown>> };

/** Records one stable specialist outcome for delivery by a later durable step. */
export function enqueueHostRuntimeRelease<T extends Stateful>(
  session: T,
  release: PendingHostRuntimeRelease,
): T {
  const validated = validatePendingHostRuntimeRelease(release);
  const pending = readPendingHostRuntimeReleases(session);
  const existing = pending.find((candidate) => sameReleaseOwner(candidate, validated));
  if (existing !== undefined) {
    if (
      existing.outcome !== validated.outcome ||
      existing.sessionId !== validated.sessionId ||
      existing.reference.providerKind !== validated.reference.providerKind ||
      existing.reference.value !== validated.reference.value
    ) {
      throw new Error("Host runtime release cannot change after settlement.");
    }
    return session;
  }
  return {
    ...session,
    state: {
      ...session.state,
      [PENDING_HOST_RUNTIME_RELEASES_STATE_KEY]: [...pending, validated],
    },
  } as T;
}

/** Strictly reads the specialist release outbox. Corruption is never treated as absence. */
export function readPendingHostRuntimeReleases(
  session: Stateful,
): readonly PendingHostRuntimeRelease[] {
  const value = session.state?.[PENDING_HOST_RUNTIME_RELEASES_STATE_KEY];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Corrupt host runtime release outbox.");
  }
  return value.map(validatePendingHostRuntimeRelease);
}

export function hasPendingHostRuntimeReleases(session: Stateful): boolean {
  return readPendingHostRuntimeReleases(session).length > 0;
}

export function clearPendingHostRuntimeReleases<T extends Stateful>(session: T): T {
  if (session.state?.[PENDING_HOST_RUNTIME_RELEASES_STATE_KEY] === undefined) return session;
  const state = { ...session.state };
  delete state[PENDING_HOST_RUNTIME_RELEASES_STATE_KEY];
  return { ...session, state: Object.keys(state).length === 0 ? undefined : state } as T;
}

function validatePendingHostRuntimeRelease(value: unknown): PendingHostRuntimeRelease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Corrupt host runtime release outbox entry.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 4 ||
    !Object.hasOwn(record, "outcome") ||
    !Object.hasOwn(record, "parent") ||
    !Object.hasOwn(record, "reference") ||
    !Object.hasOwn(record, "sessionId")
  ) {
    throw new Error("Corrupt host runtime release outbox entry.");
  }
  const outcome = record.outcome;
  if (
    outcome !== "completed" &&
    outcome !== "failed" &&
    outcome !== "cancelled" &&
    outcome !== "start_failed"
  ) {
    throw new Error("Corrupt host runtime release outcome.");
  }
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) {
    throw new Error("Corrupt host runtime release session id.");
  }
  return {
    outcome,
    parent: validateHostRuntimeParentLineage(record.parent),
    reference: validateHostRuntimeReference(record.reference),
    sessionId: record.sessionId,
  };
}

function sameReleaseOwner(
  left: PendingHostRuntimeRelease,
  right: PendingHostRuntimeRelease,
): boolean {
  return (
    left.parent.rootSessionId === right.parent.rootSessionId &&
    left.parent.sessionId === right.parent.sessionId &&
    left.parent.turnId === right.parent.turnId &&
    left.parent.callId === right.parent.callId &&
    left.parent.subagentName === right.parent.subagentName
  );
}
