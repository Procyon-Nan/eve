import { FatalError } from "#compiled/@workflow/core/index.js";

import type { AlsContext } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import {
  HostRuntimeContextKey,
  HostRuntimePreflightKey,
  ParentSessionKey,
  SessionIdKey,
  SubagentDepthKey,
} from "#context/keys.js";
import { createLogger, createErrorId } from "#internal/logging.js";
import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";
import {
  HostRuntimeError,
  isHostRuntimeError,
  sanitizeHostRuntimeProviderFailure,
} from "#runtime/host-runtime/errors.js";
import {
  validateHostRuntimeParentLineage,
  validateHostRuntimeReference,
  validateResolvedHostRuntime,
} from "#runtime/host-runtime/validation.js";
import type {
  HostRuntimeParentLineage,
  HostRuntimeReference,
  HostRuntimeReleaseOutcome,
  HostRuntimeReleaseInput,
  HostRuntimeResolveInput,
  ResolvedHostRuntime,
} from "#shared/host-runtime.js";

const log = createLogger("host-runtime");

/** Resolves and validates one complete host capability snapshot for this step. */
export async function prepareHostRuntimePreflight(
  ctx: AlsContext,
): Promise<ResolvedHostRuntime | undefined> {
  const existing = ctx.get(HostRuntimePreflightKey);
  if (existing !== undefined) return existing;

  const durable = ctx.get(HostRuntimeContextKey);
  if (durable === undefined) return undefined;
  const reference = validateHostRuntimeReference(durable.reference);
  const provider = getActiveRuntimeSession().hostRuntimeProviders.get(reference.providerKind);
  if (provider === undefined) {
    throw new HostRuntimeError("HOST_RUNTIME_PROVIDER_NOT_REGISTERED");
  }

  const parent =
    durable.parent === undefined ? undefined : validateHostRuntimeParentLineage(durable.parent);
  let providerResult: unknown;
  try {
    const resolveInput: HostRuntimeResolveInput = {
      reference,
      sessionId: ctx.require(SessionIdKey),
    };
    if (parent !== undefined) {
      Object.assign(resolveInput, { parent });
    }
    providerResult = await provider.resolve(resolveInput);
  } catch (error) {
    throw sanitizeHostRuntimeProviderFailure(error);
  }
  const resolved = validateResolvedHostRuntime(providerResult, {
    specialist: durable.ownership === "specialist",
  });
  ctx.setVirtualContext(HostRuntimePreflightKey, resolved);
  return resolved;
}

export async function releaseHostRuntimeReference(input: {
  readonly reference: HostRuntimeReference;
  readonly sessionId: string;
  readonly parent?: HostRuntimeParentLineage;
  readonly outcome: HostRuntimeReleaseOutcome;
}): Promise<void> {
  const provider = getActiveRuntimeSession().hostRuntimeProviders.get(input.reference.providerKind);
  if (provider?.release === undefined) return;
  try {
    await provider.release(input);
  } catch {
    log.warn("host runtime release callback failed", {
      errorId: createErrorId(),
      outcome: input.outcome,
      providerKind: input.reference.providerKind,
      sessionId: input.sessionId,
    });
  }
}

/** Turns only eve's deterministic host errors into non-retryable workflow errors. */
export async function prepareHostRuntimePreflightAtStepBoundary(
  ctx: AlsContext,
): Promise<ResolvedHostRuntime | undefined> {
  try {
    return await prepareHostRuntimePreflight(ctx);
  } catch (error) {
    if (!isHostRuntimeError(error)) throw error;
    throw new FatalError(error.code);
  }
}

export function throwHostRuntimeAtStepBoundary(error: unknown): never {
  if (!isHostRuntimeError(error)) throw error;
  throw new FatalError(error.code);
}

export function getPreparedHostRuntime(ctx: ContextReader): ResolvedHostRuntime | undefined {
  return ctx.get(HostRuntimePreflightKey);
}

export function isTopLevelHostRuntimeSession(ctx: ContextReader): boolean {
  const parent = ctx.get(ParentSessionKey);
  const rawDepth = ctx.get(SubagentDepthKey);
  if (rawDepth !== undefined && (!Number.isSafeInteger(rawDepth) || rawDepth < 0)) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return parent === undefined && (rawDepth ?? 0) === 0;
}

export function getEffectiveDelegatedSubagentNames(ctx: ContextReader): ReadonlySet<string> {
  if (ctx.get(HostRuntimeContextKey) === undefined || !isTopLevelHostRuntimeSession(ctx)) {
    return new Set();
  }
  return new Set(ctx.get(HostRuntimePreflightKey)?.delegatedSubagentNames ?? []);
}

/** Best-effort final lifecycle notification; provider failures never roll back core state. */
export async function releaseHostRuntimeContext(
  ctx: AlsContext,
  outcome: HostRuntimeReleaseOutcome,
  ownership: "root" | "specialist",
): Promise<void> {
  const durable = ctx.get(HostRuntimeContextKey);
  if (
    durable === undefined ||
    durable.ownership !== ownership ||
    durable.releasedOutcome !== undefined
  ) {
    return;
  }

  const next = { ...durable, releasedOutcome: outcome } as const;
  ctx.set(HostRuntimeContextKey, next);
  const provider = getActiveRuntimeSession().hostRuntimeProviders.get(
    durable.reference.providerKind,
  );
  if (provider?.release === undefined) return;

  try {
    const releaseInput: HostRuntimeReleaseInput = {
      outcome,
      reference: durable.reference,
      sessionId: ctx.require(SessionIdKey),
    };
    if (durable.parent !== undefined) {
      Object.assign(releaseInput, { parent: validateHostRuntimeParentLineage(durable.parent) });
    }
    await provider.release(releaseInput);
  } catch {
    log.warn("host runtime release callback failed", {
      errorId: createErrorId(),
      outcome,
      providerKind: durable.reference.providerKind,
      sessionId: ctx.get(SessionIdKey),
    });
  }
}
