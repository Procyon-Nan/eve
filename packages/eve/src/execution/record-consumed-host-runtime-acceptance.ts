import type { DeliverHookPayload } from "#channel/types.js";
import { recordHostRuntimeAcceptanceStep } from "#execution/record-host-runtime-acceptance-step.js";

export async function recordConsumedHostRuntimeAcceptance(
  delivery: DeliverHookPayload,
): Promise<void> {
  const acceptanceKey =
    delivery.hostRuntime?.ownership === "root" ? delivery.hostRuntime.acceptanceKey : undefined;
  if (acceptanceKey === undefined) return;

  await recordHostRuntimeAcceptanceStep(acceptanceKey);
}
