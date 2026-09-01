import { loadContext } from "#context/container.js";
import { HostRuntimeContextKey, SessionIdKey } from "#context/keys.js";
import {
  isHostRuntimeAttachmentFilePart,
  parseHostRuntimeFilePart,
} from "#internal/attachments/host-runtime-refs.js";
import {
  HostRuntimeError,
  isHostRuntimeError,
  sanitizeHostRuntimeProviderFailure,
} from "#runtime/host-runtime/errors.js";
import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";
import {
  validateDurableHostRuntimeContext,
  validateHostRuntimeParentLineage,
} from "#runtime/host-runtime/validation.js";
import type { HostRuntimeAttachmentResolveInput } from "#shared/host-runtime.js";

/** Resolves one host-owned attachment for the current model call only. */
export async function resolveHostRuntimeAttachment(
  part: unknown,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const attachment = parseHostRuntimeFilePart(part);
  const ctx = loadContext();
  const durableValue = ctx.get(HostRuntimeContextKey);
  if (durableValue === undefined) {
    throw new HostRuntimeError("HOST_RUNTIME_ATTACHMENT_RESOLVER_UNAVAILABLE");
  }
  const durable = validateDurableHostRuntimeContext(durableValue);
  if (durable.releasedOutcome !== undefined) {
    throw new HostRuntimeError("HOST_RUNTIME_ATTACHMENT_RESOLVER_UNAVAILABLE");
  }
  const provider = getActiveRuntimeSession().hostRuntimeProviders.get(
    durable.reference.providerKind,
  );
  if (provider === undefined) {
    throw new HostRuntimeError("HOST_RUNTIME_PROVIDER_NOT_REGISTERED");
  }
  if (provider.resolveAttachment === undefined) {
    throw new HostRuntimeError("HOST_RUNTIME_ATTACHMENT_RESOLVER_UNAVAILABLE");
  }

  const input: HostRuntimeAttachmentResolveInput = {
    mediaType: attachment.mediaType,
    reference: durable.reference,
    sessionId: ctx.require(SessionIdKey),
    signal,
    size: attachment.size,
    value: attachment.value,
  };
  if (attachment.filename !== undefined) {
    Object.assign(input, { filename: attachment.filename });
  }
  if (durable.parent !== undefined) {
    Object.assign(input, { parent: validateHostRuntimeParentLineage(durable.parent) });
  }

  let bytes: unknown;
  try {
    bytes = await provider.resolveAttachment(input);
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason ?? error;
    }
    if (isAbortError(error)) throw error;
    throw sanitizeHostRuntimeProviderFailure(error);
  }

  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== attachment.size) {
    throw new HostRuntimeError("HOST_RUNTIME_ATTACHMENT_RESOLUTION_FAILED");
  }
  return bytes;
}

/** Hydrates Host Runtime Tool file parts into transient AI SDK data parts. */
export async function hydrateHostRuntimeToolOutputParts(
  parts: readonly unknown[],
  signal: AbortSignal,
): Promise<unknown[]> {
  let changed = false;
  const hydrated = await Promise.all(
    parts.map(async (part) => {
      if (!isHostRuntimeAttachmentFilePart(part)) return part;
      changed = true;
      const attachment = parseHostRuntimeFilePart(part);
      const bytes = await resolveHostRuntimeAttachment(part, signal);
      return {
        ...part,
        data: { data: Buffer.from(bytes).toString("base64"), type: "data" as const },
        mediaType: attachment.mediaType,
      };
    }),
  );
  return changed ? hydrated : (parts as unknown[]);
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError" && !isHostRuntimeError(value);
}
