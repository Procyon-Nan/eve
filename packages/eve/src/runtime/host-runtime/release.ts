import { createErrorId, createLogger } from "#internal/logging.js";
import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";
import {
  validateHostRuntimeParentLineage,
  validateHostRuntimeReference,
} from "#runtime/host-runtime/validation.js";
import type { HostRuntimeProvider, HostRuntimeReleaseInput } from "#shared/host-runtime.js";

const log = createLogger("runtime.host-runtime.release");

/** Sends one idempotent final notification without exposing provider-controlled errors. */
export async function releaseHostRuntimeReference(
  input: HostRuntimeReleaseInput,
  providerOverride?: HostRuntimeProvider,
): Promise<void> {
  const reference = validateHostRuntimeReference(input.reference);
  const parent =
    input.parent === undefined ? undefined : validateHostRuntimeParentLineage(input.parent);
  const provider =
    providerOverride ?? getActiveRuntimeSession().hostRuntimeProviders.get(reference.providerKind);
  if (provider?.release === undefined) return;

  try {
    const releaseInput: HostRuntimeReleaseInput = {
      outcome: input.outcome,
      reference,
      sessionId: input.sessionId,
    };
    if (parent !== undefined) Object.assign(releaseInput, { parent });
    await provider.release(releaseInput);
  } catch {
    log.warn("host runtime release callback failed", {
      errorId: createErrorId(),
      outcome: input.outcome,
      providerKind: provider.providerKind,
      sessionId: input.sessionId,
    });
  }
}
