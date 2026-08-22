import { FatalError } from "#compiled/@workflow/core/index.js";

import type { AlsContext } from "#context/container.js";
import { HostRuntimeContextKey, HostRuntimePreflightKey, SessionIdKey } from "#context/keys.js";
import {
  HostRuntimeError,
  isHostRuntimeError,
  sanitizeHostRuntimeProviderFailure,
} from "#runtime/host-runtime/errors.js";
import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";
import {
  validateHostRuntimeParentLineage,
  validateDurableHostRuntimeContext,
  validateResolvedHostRuntime,
} from "#runtime/host-runtime/validation.js";
import type { HostRuntimeResolveInput, ResolvedHostRuntime } from "#shared/host-runtime.js";

const pendingPreflights = new WeakMap<AlsContext, Promise<ResolvedHostRuntime>>();

/** Resolves and validates one complete host capability snapshot for this step. */
export async function prepareHostRuntimePreflight(
  ctx: AlsContext,
): Promise<ResolvedHostRuntime | undefined> {
  const existing = ctx.get(HostRuntimePreflightKey);
  if (existing !== undefined) return existing;

  const durable = ctx.get(HostRuntimeContextKey);
  if (durable === undefined) return undefined;
  const pending = pendingPreflights.get(ctx);
  if (pending !== undefined) return await pending;

  const preflight = resolveHostRuntimePreflight(ctx, durable);
  pendingPreflights.set(ctx, preflight);
  try {
    return await preflight;
  } finally {
    pendingPreflights.delete(ctx);
  }
}

async function resolveHostRuntimePreflight(
  ctx: AlsContext,
  durable: import("#shared/host-runtime.js").DurableHostRuntimeContext,
): Promise<ResolvedHostRuntime> {
  const validated = validateDurableHostRuntimeContext(durable);
  if (validated.releasedOutcome !== undefined) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  const reference = validated.reference;
  const provider = getActiveRuntimeSession().hostRuntimeProviders.get(reference.providerKind);
  if (provider === undefined) {
    throw new HostRuntimeError("HOST_RUNTIME_PROVIDER_NOT_REGISTERED");
  }

  const input: HostRuntimeResolveInput = {
    reference,
    sessionId: ctx.require(SessionIdKey),
  };
  if (validated.parent !== undefined) {
    Object.assign(input, { parent: validateHostRuntimeParentLineage(validated.parent) });
  }

  let result: unknown;
  try {
    result = await provider.resolve(input);
  } catch (error) {
    throw sanitizeHostRuntimeProviderFailure(error);
  }

  const resolved = validateResolvedHostRuntime(result, {
    specialist: validated.ownership === "specialist",
  });
  ctx.setVirtualContext(HostRuntimePreflightKey, resolved);
  return resolved;
}

export function throwHostRuntimeAtStepBoundary(error: unknown): never {
  if (!isHostRuntimeError(error)) throw error;
  throw new FatalError(error.code);
}
