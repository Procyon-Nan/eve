import type { FilePart } from "ai";

import { createHostRuntimeFilePart } from "#internal/attachments/host-runtime-refs.js";
import type { HostRuntimeAttachment } from "#shared/host-runtime.js";

export type { HostRuntimeAttachment } from "#shared/host-runtime.js";

/** Creates a durable host-owned attachment reference for a trusted eve request. */
export function hostRuntimeFile(input: HostRuntimeAttachment): FilePart {
  return createHostRuntimeFilePart(input);
}
