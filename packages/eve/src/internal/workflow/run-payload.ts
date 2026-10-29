import type { World, WorkflowRun } from "#compiled/@workflow/world/index.js";
import { deriveRunPayloadKeys } from "#compiled/@workflow/core/serialization/encryption.js";

/** Uses the same per-run payload keys as Workflow's runtime readers. */
export async function readRunPayloadKey(world: World, run: WorkflowRun) {
  const raw = await world.getEncryptionKeyForRun?.(run);
  return raw ? await deriveRunPayloadKeys(raw) : undefined;
}
