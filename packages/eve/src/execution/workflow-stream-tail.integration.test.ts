import { describe, expect, it, vi } from "vitest";

import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { getWorkflowRunStreamId } from "#compiled/@workflow/core/util.js";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";

const QUERY_COUNT = 20;
const QUERY_TIMEOUT_MS = 2_000;

describe("workflow stream tail metadata integration", () => {
  it("repeats parked-session tail queries without opening a stream and then continues", async () => {
    const testRuntime = createTestRuntime({ agent: { name: "workflow-stream-tail" } });
    const continuationToken = "http:workflow-stream-tail";

    await testRuntime.run(async () => {
      const world = await getWorld();
      const runsBefore = await world.runs.list({ pagination: { limit: 1000 } });
      const sessionRunCountBefore = runsBefore.data.filter(
        (candidate) => candidate.workflowName?.includes("workflowEntry") === true,
      ).length;
      const run = await start(workflowEntry, [
        {
          input: { message: "first turn" },
          serializedContext: {
            "eve.auth": null,
            "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
            "eve.channel": { kind: "http", state: {} },
            "eve.continuationToken": continuationToken,
            "eve.mode": "conversation",
          },
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const firstTurn = await stream.nextTurn();
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");

        const runtime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        const firstTail = await expectMetadataOnlyQueries(runtime, run.runId);

        await resumeHook(sessionCommandHookToken(run.runId), {
          kind: "send",
          payload: { message: "second turn" },
        });
        const secondTurn = await stream.nextTurn();

        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
        expect(secondTurn.some((event) => event.type === "session.failed")).toBe(false);

        const secondTail = await expectMetadataOnlyQueries(runtime, run.runId);
        expect(secondTail).toBeGreaterThan(firstTail);

        const eventIds = [...firstTurn, ...secondTurn].map((event) => event.meta.id);
        expect(new Set(eventIds).size).toBe(eventIds.length);

        const runs = await world.runs.list({ pagination: { limit: 1000 } });
        expect(
          runs.data.filter(
            (candidate) => candidate.workflowName?.includes("workflowEntry") === true,
          ),
        ).toHaveLength(sessionRunCountBefore + 1);
      } finally {
        stream.dispose();
        const status = await run.status;
        if (status === "pending" || status === "running") await run.cancel();
      }
    });
  }, 180_000);
});

async function expectMetadataOnlyQueries(
  runtime: ReturnType<typeof createWorkflowRuntime>,
  runId: string,
): Promise<number> {
  const world = await getWorld();
  const streamName = getWorkflowRunStreamId(runId);
  const expectedTailIndex = (await world.streams.getInfo(runId, streamName)).tailIndex;
  const getSpy = vi.spyOn(world.streams, "get");
  const getInfoSpy = vi.spyOn(world.streams, "getInfo");

  try {
    const indexes: number[] = [];
    for (let index = 0; index < QUERY_COUNT; index += 1) {
      indexes.push(
        await withTimeout(
          runtime.getStreamTailIndex(runId),
          `tail metadata query ${String(index + 1)}`,
        ),
      );
    }

    expect(indexes).toEqual(Array.from({ length: QUERY_COUNT }, () => expectedTailIndex));
    expect(getSpy).not.toHaveBeenCalled();
    expect(getInfoSpy).toHaveBeenCalledTimes(QUERY_COUNT);
    expect(getInfoSpy).toHaveBeenCalledWith(runId, streamName);
    return expectedTailIndex;
  } finally {
    getInfoSpy.mockRestore();
    getSpy.mockRestore();
  }
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          QUERY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
