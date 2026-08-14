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

export function enqueueHostRuntimeRelease<
  T extends { readonly state?: Readonly<Record<string, unknown>> },
>(session: T, release: PendingHostRuntimeRelease): T {
  const pending = readPendingHostRuntimeReleases(session);
  return {
    ...session,
    state: {
      ...session.state,
      [PENDING_HOST_RUNTIME_RELEASES_STATE_KEY]: [...pending, release],
    },
  } as T;
}

export function readPendingHostRuntimeReleases(session: {
  readonly state?: Readonly<Record<string, unknown>>;
}): readonly PendingHostRuntimeRelease[] {
  const value = session.state?.[PENDING_HOST_RUNTIME_RELEASES_STATE_KEY];
  return Array.isArray(value) ? (value as readonly PendingHostRuntimeRelease[]) : [];
}

export function clearPendingHostRuntimeReleases<
  T extends { readonly state?: Readonly<Record<string, unknown>> },
>(session: T): T {
  if (session.state?.[PENDING_HOST_RUNTIME_RELEASES_STATE_KEY] === undefined) return session;
  const state = { ...session.state };
  delete state[PENDING_HOST_RUNTIME_RELEASES_STATE_KEY];
  return { ...session, state: Object.keys(state).length === 0 ? undefined : state } as T;
}
