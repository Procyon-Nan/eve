import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import {
  clearPendingHostRuntimeReleases,
  readPendingHostRuntimeReleases,
} from "#harness/host-runtime-releases.js";
import { releaseHostRuntimeReference } from "#runtime/host-runtime/preflight.js";

/** Delivers parent-owned specialist terminal notices after core handle settlement commits. */
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
      session: clearPendingHostRuntimeReleases(session),
      version: input.sessionState.version,
    },
  };
}
