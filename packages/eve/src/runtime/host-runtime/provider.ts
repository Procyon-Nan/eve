import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { validateProviderKind } from "#runtime/host-runtime/validation.js";
import type { HostRuntimeProvider } from "#shared/host-runtime.js";

/** Registers one host-runtime provider in the active RuntimeSession. */
export function registerHostRuntimeProvider(provider: HostRuntimeProvider): () => void {
  const providerKind = validateProviderKind(provider.providerKind);
  if (typeof provider.resolve !== "function") {
    throw new TypeError("Host runtime providers must define a resolve function.");
  }
  if (
    provider.resolveAttachment !== undefined &&
    typeof provider.resolveAttachment !== "function"
  ) {
    throw new TypeError(
      "Host runtime provider resolveAttachment must be a function when provided.",
    );
  }

  const session = getActiveRuntimeSession();
  if (session.hostRuntimeProviders.has(providerKind)) {
    throw new Error(`Host runtime provider "${providerKind}" is already registered.`);
  }
  session.hostRuntimeProviders.set(providerKind, provider);

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    if (session.hostRuntimeProviders.get(providerKind) === provider) {
      session.hostRuntimeProviders.delete(providerKind);
    }
  };
}
