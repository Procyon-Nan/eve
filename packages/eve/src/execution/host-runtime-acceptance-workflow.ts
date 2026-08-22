import { createHook, setAttributes } from "#compiled/@workflow/core/index.js";

import {
  HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE,
  type HostRuntimeAcceptanceStatus,
} from "#shared/host-runtime.js";

const ACCEPTANCE_RETENTION = "30d";

export function hostRuntimeAcceptanceHookToken(acceptanceKey: string): string {
  return `eve:host-runtime-acceptance:${acceptanceKey}`;
}

type HostRuntimeAcceptanceWorkflowResult = HostRuntimeAcceptanceStatus | "CONFLICT";

/** Durable receipt whose run creation records one final command-acceptance decision. */
export async function hostRuntimeAcceptanceWorkflow(input: {
  readonly acceptanceKey: string;
}): Promise<HostRuntimeAcceptanceWorkflowResult> {
  "use workflow";

  const decision = createHook<HostRuntimeAcceptanceStatus>({
    experimental_minRetention: ACCEPTANCE_RETENTION,
    token: hostRuntimeAcceptanceHookToken(input.acceptanceKey),
  });
  const conflict = await decision.getConflict();
  if (conflict !== null) return "CONFLICT";

  const status = await decision;
  await setAttributes(
    { [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: status },
    { allowReservedAttributes: true },
  );
  return status;
}
