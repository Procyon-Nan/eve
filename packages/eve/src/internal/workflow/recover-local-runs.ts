import type { ValidQueueName, World } from "#compiled/@workflow/world/index.js";

/** Admission is awaited before advancing the persisted recovery scan. */
export async function recoverLocalRuns(input: {
  runs: World["runs"];
  enqueue: World["queue"];
  prefix: string;
  signal: AbortSignal;
  include?: (run: Awaited<ReturnType<World["runs"]["list"]>>["data"][number]) => boolean;
}): Promise<number> {
  let admitted = 0;
  for (const status of ["pending", "running"] as const) {
    let cursor: string | undefined;
    do {
      input.signal.throwIfAborted();
      const page = await input.runs.list({
        status,
        resolveData: "none",
        pagination: { cursor },
      });
      for (const run of page.data) {
        input.signal.throwIfAborted();
        if (input.include && !input.include(run)) continue;
        await input.enqueue(`${input.prefix}${run.workflowName}` as ValidQueueName, {
          runId: run.runId,
        });
        admitted++;
      }
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }
  return admitted;
}
