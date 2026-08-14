import { deserializeContext, serializeContext } from "#context/serialize.js";
import { releaseHostRuntimeContext } from "#runtime/host-runtime/preflight.js";
import type { HostRuntimeReleaseOutcome } from "#shared/host-runtime.js";

/** Delivers one idempotent host release after the prior core step has committed. */
export async function releaseHostRuntimeStep(input: {
  readonly outcome: HostRuntimeReleaseOutcome;
  readonly ownership: "root" | "specialist";
  readonly serializedContext: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  await releaseHostRuntimeContext(ctx, input.outcome, input.ownership);
  return serializeContext(ctx);
}
