import type { SessionAuthContext } from "#channel/types.js";
import { validateTrustedHostRuntimeInput } from "#runtime/host-runtime/validation.js";
import type { TrustedHostRuntimeInput } from "#shared/host-runtime.js";

const TRUSTED_HOST_RUNTIME_STORE = Symbol.for("eve.trusted-host-runtime-store");

interface HostRuntimeGlobal {
  [TRUSTED_HOST_RUNTIME_STORE]?: WeakMap<object, TrustedHostRuntimeInput>;
}

const globalContainer = globalThis as typeof globalThis & HostRuntimeGlobal;
globalContainer[TRUSTED_HOST_RUNTIME_STORE] ??= new WeakMap();
const trustedHostRuntimeStore = globalContainer[TRUSTED_HOST_RUNTIME_STORE];

/**
 * Attaches a server-only host-runtime handoff to an authenticated principal.
 * The public principal shape and its enumerable authentication attributes stay unchanged.
 */
export function withHostRuntime(
  auth: SessionAuthContext,
  input: TrustedHostRuntimeInput,
): SessionAuthContext {
  const result: SessionAuthContext = { ...auth };
  trustedHostRuntimeStore.set(result, validateTrustedHostRuntimeInput(input));
  return result;
}

/** @internal Reads the trusted handoff without projecting it onto authored authentication state. */
export function readTrustedHostRuntime(
  auth: SessionAuthContext | null,
): TrustedHostRuntimeInput | undefined {
  return auth === null ? undefined : trustedHostRuntimeStore.get(auth);
}
