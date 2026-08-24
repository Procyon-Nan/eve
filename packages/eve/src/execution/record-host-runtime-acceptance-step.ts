import { recordHostRuntimeAcceptance } from "#runtime/host-runtime/acceptance.js";

/** Records acceptance from the durable session driver after it consumes a command. */
export async function recordHostRuntimeAcceptanceStep(acceptanceKey: string): Promise<void> {
  "use step";

  await recordHostRuntimeAcceptance(acceptanceKey, "ACCEPTED");
}
