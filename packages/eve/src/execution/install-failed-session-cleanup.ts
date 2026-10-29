import type { World } from "#compiled/@workflow/world/index.js";
import {
  cleanupFailedSession,
  readFailedSessionRelations,
} from "#execution/failed-session-cleanup.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";

/** Observe committed failures outside workflow replay and outside storage locks. */
export function installFailedSessionCleanup(world: World): void {
  const createEvent = world.events.create.bind(world.events);
  const close = world.close?.bind(world);
  const pending = new Set<string>();
  let cleanup: Promise<void> | undefined;

  async function drain() {
    while (pending.size > 0) {
      const sessionIds = [...pending];
      pending.clear();
      try {
        const relations = await readFailedSessionRelations(world);
        for (const sessionId of sessionIds) {
          try {
            const result = await cleanupFailedSession({
              world,
              sessionId,
              relations,
              mode: "online",
            });
            if (!result.complete)
              console.error("[eve] Failed session cleanup incomplete:", {
                sessionId,
                deferredRunIds: result.deferredRunIds,
                unresolvedRunIds: result.unresolvedRunIds,
                errors: result.errors,
              });
          } catch {
            console.error("[eve] Failed session cleanup failed:", { sessionId });
          }
        }
      } catch {
        console.error("[eve] Failed to read session cleanup relationships:", { sessionIds });
      }
    }
  }

  function schedule() {
    cleanup ??= Promise.resolve()
      .then(drain)
      .finally(() => {
        cleanup = undefined;
        if (pending.size > 0) schedule();
      });
  }

  world.events.create = async (...args) => {
    const result = await createEvent(...args);
    if (
      args[1].eventType === "run_failed" &&
      result.run?.workflowName === workflowEntryReference.workflowId
    ) {
      pending.add(result.run.runId);
      schedule();
    }
    return result;
  };
  world.close = async () => {
    await close?.();
    while (cleanup) await cleanup;
  };
}
