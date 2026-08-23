import { HostRuntimeContextKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";
import { validateDurableHostRuntimeContext } from "#runtime/host-runtime/validation.js";
import type { DurableHostRuntimeContext } from "#shared/host-runtime.js";

/** Replaces the reference owned by a newly accepted root logical turn. */
export async function installRootHostRuntimeStep(input: {
  readonly hostRuntime?: DurableHostRuntimeContext;
  readonly serializedContext: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  if (input.hostRuntime === undefined) {
    if (ctx.get(HostRuntimeContextKey)?.ownership === "root") {
      ctx.delete(HostRuntimeContextKey);
    }
    return serializeContext(ctx);
  }
  const validated = validateDurableHostRuntimeContext(input.hostRuntime);
  if (
    validated.ownership !== "root" ||
    validated.parent !== undefined ||
    validated.releasedOutcome !== undefined
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  ctx.set(HostRuntimeContextKey, validated);
  return serializeContext(ctx);
}
