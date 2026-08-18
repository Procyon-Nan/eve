import * as workflowRuntime from "#compiled/@workflow/core/runtime.js";
import { getWorkflowRunStreamId } from "#compiled/@workflow/core/util.js";

export * from "#compiled/@workflow/core/runtime.js";
export type {
  StartOptionsWithoutDeploymentId,
  WorkflowFunction,
  WorkflowMetadata,
} from "#compiled/@workflow/core/runtime/start.js";

/** Installs a World across source and vendored Workflow package identities. */
export function setWorld(world: unknown): void {
  workflowRuntime.setWorld(world as Parameters<typeof workflowRuntime.setWorld>[0]);
}

export async function getDefaultRunStreamTailIndex(runId: string): Promise<number> {
  const world = await workflowRuntime.getWorld();
  const streamName = getWorkflowRunStreamId(runId);
  const info = await world.streams.getInfo(runId, streamName);
  return info.tailIndex;
}
