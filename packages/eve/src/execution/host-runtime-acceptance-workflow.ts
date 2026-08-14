import type { HostRuntimeAcceptanceStatus } from "#shared/host-runtime.js";

/** Durable receipt whose run creation proves one final command-acceptance decision. */
export async function hostRuntimeAcceptanceWorkflow(input: {
  readonly acceptanceKey: string;
  readonly status: HostRuntimeAcceptanceStatus;
}): Promise<HostRuntimeAcceptanceStatus> {
  "use workflow";

  return input.status;
}
