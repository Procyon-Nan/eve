import type { World } from "#compiled/@workflow/world/index.js";
import {
  hydrateStepReturnValue,
  hydrateWorkflowArguments,
} from "#compiled/@workflow/core/serialization.js";
import { cancelRun } from "#internal/workflow/runtime.js";
import { readRunPayloadKey } from "#internal/workflow/run-payload.js";
import contracts from "#internal/workflow/step-contracts.json" with { type: "json" };
import {
  sessionTimeoutWorkflowReference,
  taskRunWorkflowReference,
  turnWorkflowReference,
  workflowEntryReference,
} from "#execution/workflow-runtime.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";

type RunRecord = Awaited<ReturnType<World["runs"]["get"]>>;
export interface FailedSessionRelations {
  readonly runs: Map<string, RunRecord>;
  readonly children: Map<string, Set<string>>;
  readonly unresolved: Set<string>;
}

export interface FailedSessionCleanupResult {
  readonly sessionId: string;
  readonly scope: "local-workflow";
  readonly cancelledRunIds: string[];
  readonly closedStreams: { runId: string; name: string }[];
  readonly deferredRunIds: string[];
  readonly unresolvedRunIds: string[];
  readonly errors: { runId: string; code: string }[];
  complete: boolean;
}

function link(relations: FailedSessionRelations, parent: string, child: string) {
  let children = relations.children.get(parent);
  if (!children) relations.children.set(parent, (children = new Set()));
  children.add(child);
}

/** One shared scan per maintenance batch, not one scan per failed session. */
export async function readFailedSessionRelations(world: World): Promise<FailedSessionRelations> {
  const relations: FailedSessionRelations = {
    runs: new Map(),
    children: new Map(),
    unresolved: new Set(),
  };
  const sessionByToken = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await world.runs.list({ resolveData: "none", pagination: { cursor } });
    for (const run of page.data) {
      if (
        ![
          workflowEntryReference.workflowId,
          turnWorkflowReference.workflowId,
          sessionTimeoutWorkflowReference.workflowId,
          taskRunWorkflowReference.workflowId,
        ].includes(run.workflowName)
      )
        continue;
      relations.runs.set(run.runId, run);
      if (run.workflowName === workflowEntryReference.workflowId) {
        sessionByToken.set(sessionCommandHookToken(run.runId), run.runId);
      }
      const parent = run.attributes["$eve.parent"];
      if (parent) link(relations, parent, run.runId);
      else if (run.workflowName === turnWorkflowReference.workflowId && run.status !== "completed")
        relations.unresolved.add(run.runId);
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  for (const record of relations.runs.values()) {
    const timer = record.workflowName === sessionTimeoutWorkflowReference.workflowId;
    if (!timer && record.workflowName !== taskRunWorkflowReference.workflowId) continue;
    if (record.status === "completed") continue;
    const run = await world.runs.get(record.runId, { resolveData: "all" });
    const args: unknown = await hydrateWorkflowArguments(
      run.input,
      run.runId,
      await readRunPayloadKey(world, run),
    );
    const input = Array.isArray(args) ? args[0] : undefined;
    const token: unknown = input?.[timer ? "token" : "parentContinuationToken"];
    const parent = typeof token === "string" ? sessionByToken.get(token) : undefined;
    if (parent) link(relations, parent, run.runId);
    else relations.unresolved.add(run.runId);
    if (!timer && input?.initialView?.metadata?.mode === "remote")
      relations.unresolved.add(run.runId);
  }
  return relations;
}

const childStepIds = new Set(
  contracts
    .filter(
      (entry) =>
        entry.functionName === "startSessionTimeoutStep" ||
        entry.functionName === "dispatchTurnStep",
    )
    .flatMap((entry) => [entry.id, ...entry.legacyIds]),
);

/** Collects recorded child handles without re-running their durable steps. */
async function readRecordedChildren(
  world: World,
  sessionId: string,
  relations: FailedSessionRelations,
): Promise<boolean> {
  let hasUnfinishedSteps = false;
  let cursor: string | undefined;
  const run = await world.runs.get(sessionId, { resolveData: "all" });
  const key = await readRunPayloadKey(world, run);
  do {
    const page = await world.steps.list({
      runId: sessionId,
      resolveData: "all",
      pagination: { cursor },
    });
    for (const step of page.data) {
      if (step.status === "running" || step.status === "pending") hasUnfinishedSteps = true;
      if (step.status !== "completed" || !childStepIds.has(step.stepName)) continue;
      const output: unknown = await hydrateStepReturnValue(step.output, sessionId, key);
      if (
        typeof output !== "object" ||
        output === null ||
        !("runId" in output) ||
        typeof output.runId !== "string"
      ) {
        throw new Error("Invalid recorded child workflow handle.");
      }
      const child = await world.runs.get(output.runId, { resolveData: "none" });
      if (
        child.workflowName !== sessionTimeoutWorkflowReference.workflowId &&
        child.workflowName !== turnWorkflowReference.workflowId
      ) {
        throw new Error("Recorded child handle refers to an unexpected workflow.");
      }
      relations.runs.set(child.runId, child);
      relations.unresolved.delete(child.runId);
      link(relations, sessionId, child.runId);
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return hasUnfinishedSteps;
}

/** Offline mode requires all application writers to have been stopped by the operator. */
export async function cleanupFailedSession(input: {
  world: World;
  sessionId: string;
  relations: FailedSessionRelations;
  mode: "online" | "offline";
}): Promise<FailedSessionCleanupResult> {
  const { world, sessionId, relations } = input;
  const root = await world.runs.get(sessionId, { resolveData: "none" });
  if (root.status !== "failed" || root.workflowName !== workflowEntryReference.workflowId) {
    throw new Error("Cleanup requires a failed eve session workflow.");
  }
  const unfinished = await readRecordedChildren(world, sessionId, relations);
  const result: FailedSessionCleanupResult = {
    sessionId,
    scope: "local-workflow",
    cancelledRunIds: [],
    closedStreams: [],
    deferredRunIds: [],
    unresolvedRunIds: [...relations.unresolved],
    errors: [],
    complete: false,
  };
  const descendants = new Set<string>();
  function visit(parent: string) {
    for (const id of relations.children.get(parent) ?? []) {
      if (id === sessionId || descendants.has(id)) continue;
      descendants.add(id);
      visit(id);
    }
  }
  visit(sessionId);
  if (input.mode === "online" && unfinished) result.deferredRunIds.push(sessionId);
  const streamsToClose = new Set([sessionId]);
  for (const id of descendants) {
    if (relations.unresolved.has(id)) continue;
    try {
      const run = await world.runs.get(id, { resolveData: "none" });
      if (run.status === "completed") continue;
      if (
        input.mode === "online" &&
        run.workflowName !== sessionTimeoutWorkflowReference.workflowId
      ) {
        result.deferredRunIds.push(id);
        continue;
      }
      if (run.status === "pending" || run.status === "running") {
        try {
          await cancelRun(world, id, { cancelReason: "Owning eve session failed" });
          result.cancelledRunIds.push(id);
        } catch (error) {
          const current = await world.runs.get(id, { resolveData: "none" });
          if (current.status === "pending" || current.status === "running") throw error;
          if (current.status === "completed") continue;
        }
      }
      streamsToClose.add(id);
    } catch {
      result.errors.push({ runId: id, code: "RELATED_RUN_CLEANUP_FAILED" });
    }
  }
  if (
    result.deferredRunIds.length === 0 &&
    result.unresolvedRunIds.length === 0 &&
    result.errors.length === 0
  ) {
    for (const runId of streamsToClose) {
      try {
        for (const name of await world.streams.list(runId)) {
          if ((await world.streams.getInfo(runId, name)).done) continue;
          await world.streams.close(runId, name);
          result.closedStreams.push({ runId, name });
        }
      } catch {
        result.errors.push({ runId, code: "STREAM_CLOSE_FAILED" });
      }
    }
  }
  result.complete =
    result.errors.length === 0 &&
    result.deferredRunIds.length === 0 &&
    result.unresolvedRunIds.length === 0;
  return result;
}
