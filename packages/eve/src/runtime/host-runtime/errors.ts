export const HOST_RUNTIME_ERROR_CODES = [
  "HOST_RUNTIME_ATTACHMENT_REFERENCE_INVALID",
  "HOST_RUNTIME_ATTACHMENT_RESOLVER_UNAVAILABLE",
  "HOST_RUNTIME_ATTACHMENT_UNAVAILABLE",
  "HOST_RUNTIME_ATTACHMENT_RESOLUTION_FAILED",
  "HOST_RUNTIME_PROVIDER_NOT_REGISTERED",
  "HOST_RUNTIME_REFERENCE_INVALID",
  "HOST_RUNTIME_VERSION_UNAVAILABLE",
  "HOST_RUNTIME_RESOLUTION_FAILED",
] as const;

export type HostRuntimeErrorCode = (typeof HOST_RUNTIME_ERROR_CODES)[number];

const HOST_RUNTIME_ERROR_BRAND = Symbol.for("eve.host-runtime-error");

/** Structured deterministic error safe to classify at workflow boundaries. */
export class HostRuntimeError extends Error {
  readonly code: HostRuntimeErrorCode;
  readonly [HOST_RUNTIME_ERROR_BRAND] = true;

  constructor(code: HostRuntimeErrorCode) {
    super(code);
    this.name = "HostRuntimeError";
    this.code = code;
  }
}

export function isHostRuntimeError(value: unknown): value is HostRuntimeError {
  if (!(value instanceof Error)) return false;

  const candidate = value as Error & {
    readonly code?: unknown;
    readonly [HOST_RUNTIME_ERROR_BRAND]?: unknown;
  };
  return (
    candidate[HOST_RUNTIME_ERROR_BRAND] === true &&
    HOST_RUNTIME_ERROR_CODES.includes(candidate.code as HostRuntimeErrorCode)
  );
}

/** Keeps an unclassified provider outage retryable without exposing provider text. */
export function sanitizeHostRuntimeProviderFailure(error: unknown): Error {
  return isHostRuntimeError(error) ? error : new Error("Host runtime provider operation failed.");
}
