import type { SessionAuthContext } from "#channel/types.js";
import type { TrustedHostRuntimeInput } from "#shared/host-runtime.js";
import { validateTrustedHostRuntimeInput } from "#runtime/host-runtime/validation.js";

const TRUSTED_HOST_RUNTIME_STORE = Symbol.for("eve.trusted-host-runtime-store");

interface HostRuntimeGlobal {
  [TRUSTED_HOST_RUNTIME_STORE]?: WeakMap<object, TrustedHostRuntimeInput>;
}

const globalContainer = globalThis as typeof globalThis & HostRuntimeGlobal;
globalContainer[TRUSTED_HOST_RUNTIME_STORE] ??= new WeakMap();
const trustedHostRuntimeStore = globalContainer[TRUSTED_HOST_RUNTIME_STORE];

/**
 * Attaches a non-enumerable host-runtime handoff to a verified route principal.
 * The handoff is consumed only by the built-in eve channel.
 */
export function withHostRuntime(
  auth: SessionAuthContext,
  input: TrustedHostRuntimeInput,
): SessionAuthContext {
  const result: SessionAuthContext = { ...auth };
  trustedHostRuntimeStore.set(result, validateTrustedHostRuntimeInput(input));
  return result;
}

export function readTrustedHostRuntime(
  auth: SessionAuthContext | null,
): TrustedHostRuntimeInput | undefined {
  return auth === null ? undefined : trustedHostRuntimeStore.get(auth);
}
