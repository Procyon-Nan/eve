import { deserializeContext, serializeContext } from "#context/serialize.js";
import { HostRuntimeContextKey } from "#context/keys.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";
import {
  validateHostRuntimeAcceptanceKey,
  validateHostRuntimeParentLineage,
  validateHostRuntimeReference,
} from "#runtime/host-runtime/validation.js";
import type { DurableHostRuntimeContext } from "#shared/host-runtime.js";

/** Replaces the root or inherited runtime owned by the next logical turn. */
export async function installTurnHostRuntimeStep(input: {
  readonly hostRuntime?: DurableHostRuntimeContext;
  readonly serializedContext: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  if (input.hostRuntime === undefined) {
    ctx.delete(HostRuntimeContextKey);
    return serializeContext(ctx);
  }
  if (
    (input.hostRuntime.ownership !== "root" && input.hostRuntime.ownership !== "inherited") ||
    (input.hostRuntime.ownership === "root" && input.hostRuntime.parent !== undefined) ||
    (input.hostRuntime.ownership === "inherited" && input.hostRuntime.parent === undefined)
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  const next: DurableHostRuntimeContext = {
    ownership: input.hostRuntime.ownership,
    reference: validateHostRuntimeReference(input.hostRuntime.reference),
  };
  if (input.hostRuntime.ownership === "root") {
    Object.assign(next, {
      acceptanceKey: validateHostRuntimeAcceptanceKey(input.hostRuntime.acceptanceKey),
    });
  } else {
    Object.assign(next, { parent: validateHostRuntimeParentLineage(input.hostRuntime.parent) });
  }
  ctx.set(HostRuntimeContextKey, next);
  return serializeContext(ctx);
}
