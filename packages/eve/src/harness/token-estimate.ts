import type { ModelMessage } from "ai";

import { getKnownByteLength } from "#internal/attachments/data.js";

const FILE_PAYLOAD_MIN_RESERVE_TOKENS = 1_024;
const FILE_PAYLOAD_MAX_RESERVE_TOKENS = 32_768;

/**
 * Rough token estimate: serialized JSON length / 4. Good enough for
 * deciding whether compaction is needed; the real token count comes back
 * from the model each step via `CompactionConfig.lastKnownInputTokens`.
 *
 * Accepts any JSON-serializable value so callers can apply the same heuristic
 * to whole message arrays or individual content parts on one consistent ruler.
 */
export function estimateTokens(value: unknown): number {
  return JSON.stringify(value).length / 4;
}

/**
 * Estimates model-message tokens without treating inline file bytes as text.
 * File payloads use a bounded soft reserve because provider-specific image and
 * PDF tokenization is not derivable from their encoded byte length.
 */
export function estimateModelMessageTokens(messages: readonly ModelMessage[]): number {
  let payloadReserve = 0;
  let changed = false;

  const projected = messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    if (message.role === "user") {
      let contentChanged = false;
      const content = message.content.map((part) => {
        if (part.type !== "file") {
          return part;
        }
        contentChanged = true;
        payloadReserve += reserveForFilePayload(part.data);
        return { ...part, data: "" };
      });
      if (!contentChanged) {
        return message;
      }
      changed = true;
      return { ...message, content };
    }

    if (message.role !== "tool") {
      return message;
    }

    let contentChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result" || !isContentToolOutput(part.output)) {
        return part;
      }

      let outputChanged = false;
      const value = part.output.value.map((outputPart) => {
        if (!isToolOutputFilePart(outputPart)) {
          return outputPart;
        }
        outputChanged = true;
        payloadReserve += reserveForFilePayload(outputPart.data.data);
        return { ...outputPart, data: { ...outputPart.data, data: "" } };
      });
      if (!outputChanged) {
        return part;
      }
      contentChanged = true;
      return { ...part, output: { ...part.output, value } };
    });
    if (!contentChanged) {
      return message;
    }
    changed = true;
    return { ...message, content };
  });

  return estimateTokens(changed ? projected : messages) + payloadReserve;
}

function reserveForFilePayload(data: unknown): number {
  const bytes = getKnownByteLength(data);
  if (bytes === null) {
    return FILE_PAYLOAD_MIN_RESERVE_TOKENS;
  }
  return Math.min(
    FILE_PAYLOAD_MAX_RESERVE_TOKENS,
    Math.max(FILE_PAYLOAD_MIN_RESERVE_TOKENS, Math.ceil(bytes / 1_024)),
  );
}

function isContentToolOutput(
  value: unknown,
): value is { readonly type: "content"; readonly value: readonly unknown[] } {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly type?: unknown }).type === "content" &&
    Array.isArray((value as { readonly value?: unknown }).value)
  );
}

function isToolOutputFilePart(value: unknown): value is {
  readonly data: { readonly data: unknown; readonly type: "data" };
  readonly type: "file";
} {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { readonly type?: unknown }).type !== "file"
  ) {
    return false;
  }
  const data = (value as { readonly data?: unknown }).data;
  return (
    data !== null &&
    typeof data === "object" &&
    (data as { readonly type?: unknown }).type === "data" &&
    "data" in data
  );
}
