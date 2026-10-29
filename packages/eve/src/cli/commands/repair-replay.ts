import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { World } from "#compiled/@workflow/world/index.js";
import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { hydrateRunError } from "#compiled/@workflow/core/serialization.js";
import { readRunPayloadKey } from "#internal/workflow/run-payload.js";
import { walkCauseChain } from "#shared/errors.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import {
  cleanupFailedSession,
  inspectFailedSessionRelations,
  readFailedSessionRelations,
} from "#execution/failed-session-cleanup.js";
import { eveStepContracts as contracts } from "#internal/workflow/step-contracts.js";

const FORMAT = "eve-failed-session-repair-v1";
interface Candidate {
  sessionId: string;
  finishedAt: string;
  errorCode: "CORRUPTED_EVENT_LOG";
  recordedVersion: "0.40.0-baigong.2";
  replayVersion: "0.40.0-baigong.3";
}

/** Matches the reviewed .2-to-.3 identity change, not arbitrary log corruption. */
export function isBaigongStepIdentityFailure(error: unknown): boolean {
  for (const cause of walkCauseChain(error)) {
    if (typeof cause !== "object" || cause === null || !("name" in cause) || !("message" in cause))
      continue;
    if (cause.name !== "ReplayDivergenceError" && cause.name !== "CorruptedEventLogError") continue;
    if (typeof cause.message !== "string") continue;
    const match = /belongs to "([^"]+)", but the current step consumer is "([^"]+)"/.exec(
      cause.message,
    );
    if (!match) continue;
    if (
      contracts.some(
        (entry) =>
          match[1] === `step//eve@0.40.0-baigong.2//${entry.functionName}` &&
          match[2] === `step//eve@0.40.0-baigong.3//${entry.functionName}` &&
          entry.legacyIds.includes(match[1]) &&
          entry.legacyIds.includes(match[2]),
      )
    )
      return true;
  }
  return false;
}

async function readCandidate(world: World, sessionId: string): Promise<Candidate | undefined> {
  const run = await world.runs.get(sessionId, { resolveData: "all" });
  if (
    run.status !== "failed" ||
    run.workflowName !== workflowEntryReference.workflowId ||
    run.errorCode !== "CORRUPTED_EVENT_LOG"
  )
    return undefined;
  const error = await hydrateRunError(run.error, run.runId, await readRunPayloadKey(world, run));
  if (!isBaigongStepIdentityFailure(error)) return undefined;
  return {
    sessionId,
    finishedAt: run.completedAt.toISOString(),
    errorCode: "CORRUPTED_EVENT_LOG",
    recordedVersion: "0.40.0-baigong.2",
    replayVersion: "0.40.0-baigong.3",
  };
}

export async function runRepairReplay(input: {
  mode: "inspect" | "apply";
  dataDir: string;
  output: string;
  manifest?: string;
  writersStopped?: boolean;
}): Promise<boolean> {
  if (input.mode === "apply" && (!input.manifest || !input.writersStopped)) {
    throw new Error(
      "apply requires --manifest and --writers-stopped after stopping all writers and backing up current data.",
    );
  }
  const dataDir = await realpath(input.dataDir);
  if (!(await stat(dataDir)).isDirectory())
    throw new Error("--data-dir must be an existing Workflow data directory.");
  if (!(await stat(resolve(dataDir, "runs"))).isDirectory())
    throw new Error("Workflow runs directory not found.");
  const output = resolve(input.output);
  if (output === dataDir || output.startsWith(`${dataDir}/`)) {
    throw new Error("Write the maintenance report outside the Workflow data directory.");
  }
  // No start(), bootstrap, or handler registration: inspect must not write storage.
  const world = createWorld({ dataDir, recoverActiveRuns: false });
  try {
    const errors: { sessionId: string; code: string }[] = [];
    const sessions: Candidate[] = [];
    if (input.mode === "inspect") {
      let cursor: string | undefined;
      do {
        const page = await world.runs.list({
          workflowName: workflowEntryReference.workflowId,
          status: "failed",
          resolveData: "none",
          pagination: { cursor },
        });
        for (const run of page.data) {
          try {
            const candidate = await readCandidate(world, run.runId);
            if (candidate) sessions.push(candidate);
          } catch {
            errors.push({ sessionId: run.runId, code: "FAILURE_READ_FAILED" });
          }
        }
        cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
      } while (cursor !== undefined);
    } else {
      const manifest: unknown = JSON.parse(await readFile(input.manifest!, "utf8"));
      if (
        typeof manifest !== "object" ||
        manifest === null ||
        !("format" in manifest) ||
        manifest.format !== FORMAT ||
        !("sessions" in manifest) ||
        !Array.isArray(manifest.sessions)
      ) {
        throw new Error("Invalid inspect manifest.");
      }
      for (const row of manifest.sessions) {
        if (
          typeof row !== "object" ||
          row === null ||
          typeof row.sessionId !== "string" ||
          typeof row.finishedAt !== "string"
        ) {
          throw new Error("Invalid session entry in inspect manifest.");
        }
        try {
          const candidate = await readCandidate(world, row.sessionId);
          if (!candidate || candidate.finishedAt !== row.finishedAt) {
            errors.push({ sessionId: row.sessionId, code: "FAILURE_NO_LONGER_MATCHES" });
          } else sessions.push(candidate);
        } catch {
          errors.push({ sessionId: row.sessionId, code: "FAILURE_READ_FAILED" });
        }
      }
    }
    let relations: Awaited<ReturnType<typeof readFailedSessionRelations>> | undefined;
    if (sessions.length > 0) {
      try {
        relations = await readFailedSessionRelations(world);
      } catch {
        for (const session of sessions)
          errors.push({ sessionId: session.sessionId, code: "RELATION_SCAN_FAILED" });
      }
    }
    const results: unknown[] = [];
    for (const session of sessions) {
      if (!relations) continue;
      try {
        if (input.mode === "apply") {
          const result = await cleanupFailedSession({
            world,
            sessionId: session.sessionId,
            relations,
            mode: "offline",
          });
          results.push({
            sessionId: session.sessionId,
            scope: result.scope,
            complete: result.complete,
            cancelledRunIds: result.cancelledRunIds,
            closedStreamCount: result.closedStreams.length,
            deferredRunIds: result.deferredRunIds,
            unresolvedRunIds: result.unresolvedRunIds,
            errors: result.errors,
          });
          if (!result.complete)
            errors.push({ sessionId: session.sessionId, code: "CLEANUP_INCOMPLETE" });
        } else {
          const { descendants: relatedRunIds } = await inspectFailedSessionRelations(
            world,
            session.sessionId,
            relations,
          );
          const streams = [];
          for (const runId of [session.sessionId, ...relatedRunIds]) {
            let total = 0;
            let closed = 0;
            for (const name of await world.streams.list(runId)) {
              total++;
              if ((await world.streams.getInfo(runId, name)).done) closed++;
            }
            streams.push({ runId, total, closed });
          }
          results.push({
            sessionId: session.sessionId,
            relatedRunIds: [...relatedRunIds],
            streams,
          });
        }
      } catch {
        errors.push({ sessionId: session.sessionId, code: "INSPECTION_OR_CLEANUP_FAILED" });
      }
    }
    await writeFile(
      output,
      JSON.stringify(
        {
          format: FORMAT,
          mode: input.mode,
          scope: "local-workflow",
          sessions,
          results,
          unresolvedRunIds: [...(relations?.unresolved ?? [])],
          errors,
        },
        null,
        2,
      ) + "\n",
    );
    return errors.length === 0 && (relations?.unresolved.size ?? 0) === 0;
  } finally {
    await world.close?.();
  }
}
