import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { createWorld } from "#compiled/@workflow/world-local/index.js";
import {
  dehydrateRunError,
  dehydrateWorkflowArguments,
} from "#compiled/@workflow/core/serialization.js";
import { runRepairReplay } from "#cli/commands/repair-replay.js";
import {
  cleanupFailedSession,
  readFailedSessionRelations,
} from "#execution/failed-session-cleanup.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import {
  workflowEntryReference,
  turnWorkflowReference,
  sessionTimeoutWorkflowReference,
} from "#execution/workflow-runtime.js";

const roots: string[] = [];
const worlds: ReturnType<typeof createWorld>[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close?.();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "eve-failed-cleanup-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const world = createWorld({ dataDir, recoverActiveRuns: false });
  worlds.push(world);
  async function run(workflowName: string, args: unknown[] = [], attributes = {}) {
    const result = await world.events.create(null, {
      eventType: "run_created",
      specVersion: 2,
      eventData: {
        deploymentId: "cleanup-test",
        workflowName,
        input: await dehydrateWorkflowArguments(args, "unencrypted", undefined),
        attributes,
        allowReservedAttributes: true,
      },
    });
    return result.run!.runId;
  }
  const sessionId = await run(workflowEntryReference.workflowId);
  const turnId = await run(turnWorkflowReference.workflowId, [], { "$eve.parent": sessionId });
  const timerId = await run(sessionTimeoutWorkflowReference.workflowId, [
    {
      token: sessionCommandHookToken(sessionId),
      deadline: new Date(Date.now() + 60_000),
    },
  ]);
  await world.streams.write(sessionId, "messages", "retained history");
  const error = new Error(
    'Replay divergence: step event step_started for step_1 belongs to "step//eve@0.40.0-baigong.2//createSessionStep", but the current step consumer is "step//eve@0.40.0-baigong.3//createSessionStep"',
  );
  error.name = "ReplayDivergenceError";
  await world.events.create(sessionId, {
    eventType: "run_failed",
    specVersion: 2,
    eventData: {
      error: await dehydrateRunError(error, sessionId, undefined),
      errorCode: "CORRUPTED_EVENT_LOG",
    },
  });
  return { root, dataDir, world, sessionId, turnId, timerId };
}

async function storageDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(dir: string) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      hash.update(path.slice(root.length));
      if (entry.isDirectory()) await visit(path);
      else hash.update(await fs.readFile(path));
    }
  }
  await visit(root);
  return hash.digest("hex");
}

it("keeps the online stream open while a turn exists, but cancels its timer", async () => {
  const { world, sessionId, turnId, timerId } = await fixture();
  const result = await cleanupFailedSession({
    world,
    sessionId,
    relations: await readFailedSessionRelations(world),
    mode: "online",
  });
  expect(result.complete).toBe(false);
  expect(result.deferredRunIds).toEqual([turnId]);
  expect(result.cancelledRunIds).toEqual([timerId]);
  expect((await world.streams.getInfo(sessionId, "messages")).done).toBe(false);
  expect((await world.runs.get(sessionId)).status).toBe("failed");
});

it("inspects without writes and applies EOF idempotently while retaining failed history", async () => {
  const { root, dataDir, world, sessionId, turnId, timerId } = await fixture();
  const manifest = join(root, "inspect.json");
  const before = await storageDigest(dataDir);
  expect(await runRepairReplay({ mode: "inspect", dataDir, output: manifest })).toBe(true);
  expect(await storageDigest(dataDir)).toBe(before);
  const inspection = JSON.parse(await fs.readFile(manifest, "utf8"));
  expect(inspection.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([sessionId]);
  expect(JSON.stringify(inspection)).not.toContain("retained history");
  const output = join(root, "apply.json");
  const options = { mode: "apply" as const, dataDir, manifest, writersStopped: true, output };
  expect(await runRepairReplay(options)).toBe(true);
  for (const id of [turnId, timerId]) expect((await world.runs.get(id)).status).toBe("cancelled");
  expect((await world.runs.get(sessionId)).status).toBe("failed");
  expect(await world.streams.getInfo(sessionId, "messages")).toMatchObject({
    done: true,
    tailIndex: 0,
  });
  const after = await storageDigest(dataDir);
  expect(await runRepairReplay(options)).toBe(true);
  expect(await storageDigest(dataDir)).toBe(after);
  expect(JSON.parse(await fs.readFile(output, "utf8")).results[0]).toMatchObject({
    complete: true,
    closedStreamCount: 0,
    cancelledRunIds: [],
  });
});
