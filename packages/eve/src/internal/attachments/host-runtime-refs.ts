import { encodeAttachmentRef, parseAttachmentRef } from "#internal/attachments/refs.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";
import {
  HOST_RUNTIME_ATTACHMENT_REFERENCE_KEY,
  type HostRuntimeAttachment,
  type HostRuntimeAttachmentFilePart,
} from "#shared/host-runtime.js";

export { HOST_RUNTIME_ATTACHMENT_REFERENCE_KEY } from "#shared/host-runtime.js";
const HOST_RUNTIME_ATTACHMENT_KIND = "host-runtime";
const MAX_HOST_RUNTIME_ATTACHMENT_VALUE_LENGTH = 512;

interface HostRuntimeAttachmentParams {
  readonly type: typeof HOST_RUNTIME_ATTACHMENT_KIND;
  readonly value: string;
}

/** Validates host-owned attachment metadata at every public and durable boundary. */
export function validateHostRuntimeAttachment(value: unknown): HostRuntimeAttachment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidReference();
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["filename", "mediaType", "size", "value"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw invalidReference();
  }
  if (
    typeof record.value !== "string" ||
    record.value.length === 0 ||
    record.value.length > MAX_HOST_RUNTIME_ATTACHMENT_VALUE_LENGTH ||
    typeof record.mediaType !== "string" ||
    record.mediaType.length === 0 ||
    !Number.isSafeInteger(record.size) ||
    (record.size as number) < 0 ||
    (record.filename !== undefined &&
      (typeof record.filename !== "string" || record.filename.length === 0))
  ) {
    throw invalidReference();
  }

  const result: HostRuntimeAttachment = {
    mediaType: record.mediaType,
    size: record.size as number,
    value: record.value,
  };
  if (record.filename !== undefined) {
    Object.assign(result, { filename: record.filename });
  }
  return result;
}

/** Constructs the one durable tagged-reference representation used by user and Tool files. */
export function createHostRuntimeFilePart(
  input: HostRuntimeAttachment,
): HostRuntimeAttachmentFilePart {
  const attachment = validateHostRuntimeAttachment(input);
  const encoded = encodeAttachmentRef<HostRuntimeAttachmentParams>({
    params: { type: HOST_RUNTIME_ATTACHMENT_KIND, value: attachment.value },
    size: attachment.size,
  }).href;
  const part: HostRuntimeAttachmentFilePart = {
    data: {
      reference: { [HOST_RUNTIME_ATTACHMENT_REFERENCE_KEY]: encoded },
      type: "reference",
    },
    mediaType: attachment.mediaType,
    type: "file",
  };
  if (attachment.filename !== undefined) {
    Object.assign(part, { filename: attachment.filename });
  }
  return part;
}

/** Returns true only for the reserved host-runtime tagged-reference shape. */
export function isHostRuntimeAttachmentFilePart(
  value: unknown,
): value is HostRuntimeAttachmentFilePart {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  if (part.type !== "file") return false;
  const data = part.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const tagged = data as Record<string, unknown>;
  if (tagged.type !== "reference") return false;
  const reference = tagged.reference;
  return (
    reference !== null &&
    typeof reference === "object" &&
    !Array.isArray(reference) &&
    Object.hasOwn(reference, HOST_RUNTIME_ATTACHMENT_REFERENCE_KEY)
  );
}

/** Strictly decodes the reserved tagged reference and its standard FilePart metadata. */
export function parseHostRuntimeFilePart(value: unknown): HostRuntimeAttachment {
  if (!isHostRuntimeAttachmentFilePart(value)) throw invalidReference();
  const partKeys = Object.keys(value);
  const dataKeys = Object.keys(value.data);
  const referenceKeys = Object.keys(value.data.reference);
  if (
    partKeys.some((key) => !["data", "filename", "mediaType", "type"].includes(key)) ||
    dataKeys.length !== 2 ||
    !dataKeys.includes("type") ||
    !dataKeys.includes("reference") ||
    referenceKeys.length !== 1 ||
    referenceKeys[0] !== HOST_RUNTIME_ATTACHMENT_REFERENCE_KEY
  ) {
    throw invalidReference();
  }

  const encoded = value.data.reference[HOST_RUNTIME_ATTACHMENT_REFERENCE_KEY];
  if (typeof encoded !== "string") throw invalidReference();

  let url: URL;
  let decoded;
  try {
    url = new URL(encoded);
    decoded = parseAttachmentRef<HostRuntimeAttachmentParams>(url);
  } catch {
    throw invalidReference();
  }
  if (
    decoded.size === undefined ||
    decoded.params === null ||
    typeof decoded.params !== "object" ||
    Array.isArray(decoded.params) ||
    Object.keys(decoded.params).length !== 2 ||
    decoded.params.type !== HOST_RUNTIME_ATTACHMENT_KIND
  ) {
    throw invalidReference();
  }

  const attachment = validateHostRuntimeAttachment({
    filename: value.filename,
    mediaType: value.mediaType,
    size: decoded.size,
    value: decoded.params.value,
  });
  const canonical = encodeAttachmentRef<HostRuntimeAttachmentParams>({
    params: { type: HOST_RUNTIME_ATTACHMENT_KIND, value: attachment.value },
    size: attachment.size,
  });
  if (url.href !== canonical.href) throw invalidReference();
  return attachment;
}

function invalidReference(): HostRuntimeError {
  return new HostRuntimeError("HOST_RUNTIME_ATTACHMENT_REFERENCE_INVALID");
}
