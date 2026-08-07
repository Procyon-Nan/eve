import type { FilePart, ModelMessage, TextPart, UserModelMessage } from "ai";

const FILE_ONLY_TOOL_RESULT_PLACEHOLDER =
  "The tool returned file content attached in the following user message.";

/**
 * Projects durable tool content-output files into transient user file parts so
 * providers whose tool role is text-only receive genuine multimodal input.
 */
export function projectToolOutputFilesForModel(messages: readonly ModelMessage[]): ModelMessage[] {
  let projectedMessages: ModelMessage[] | undefined;
  let pendingAttachmentContent: Array<TextPart | FilePart> | undefined;
  let projectedToolResultCount = 0;

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      if (projectedMessages !== undefined) {
        appendPendingAttachmentMessage(projectedMessages, pendingAttachmentContent);
        pendingAttachmentContent = undefined;
        projectedToolResultCount = 0;
        projectedMessages.push(message);
      }
      continue;
    }

    let projectedContent: typeof message.content | undefined;
    const attachmentContent: Array<TextPart | FilePart> = [];

    for (const [partIndex, part] of message.content.entries()) {
      if (part.type !== "tool-result" || !isContentToolOutput(part.output)) {
        continue;
      }

      const files = part.output.value.filter(isToolOutputFilePart);
      if (files.length === 0) {
        continue;
      }

      projectedContent ??= [...message.content];
      const text = part.output.value
        .filter(isToolOutputTextPart)
        .map((outputPart) => outputPart.text)
        .join("\n");
      projectedContent[partIndex] = {
        ...part,
        output: {
          type: "text",
          value: text.length > 0 ? text : FILE_ONLY_TOOL_RESULT_PLACEHOLDER,
        },
      };

      projectedToolResultCount += 1;
      attachmentContent.push({
        text: `Files returned by prior tool result #${projectedToolResultCount}:`,
        type: "text",
      });
      for (const outputPart of part.output.value) {
        if (isToolOutputTextPart(outputPart)) {
          attachmentContent.push({ text: outputPart.text, type: "text" });
        } else if (isToolOutputFilePart(outputPart)) {
          attachmentContent.push({
            data: Buffer.from(outputPart.data.data, "base64"),
            filename: outputPart.filename,
            mediaType: outputPart.mediaType,
            type: "file",
          });
        }
      }
    }

    if (projectedContent === undefined) {
      projectedMessages?.push(message);
      continue;
    }

    projectedMessages ??= messages.slice(0, messageIndex);
    projectedMessages.push({ ...message, content: projectedContent });
    pendingAttachmentContent ??= [];
    pendingAttachmentContent.push(...attachmentContent);
  }

  if (projectedMessages !== undefined) {
    appendPendingAttachmentMessage(projectedMessages, pendingAttachmentContent);
  }

  return projectedMessages ?? (messages as ModelMessage[]);
}

function appendPendingAttachmentMessage(
  messages: ModelMessage[],
  content: Array<TextPart | FilePart> | undefined,
): void {
  if (content === undefined) return;
  messages.push({ content, role: "user" } satisfies UserModelMessage);
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

function isToolOutputTextPart(
  value: unknown,
): value is { readonly text: string; readonly type: "text" } {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly type?: unknown }).type === "text" &&
    typeof (value as { readonly text?: unknown }).text === "string"
  );
}

function isToolOutputFilePart(value: unknown): value is {
  readonly data: { readonly data: string; readonly type: "data" };
  readonly filename?: string;
  readonly mediaType: string;
  readonly type: "file";
} {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { readonly type?: unknown }).type !== "file" ||
    typeof (value as { readonly mediaType?: unknown }).mediaType !== "string"
  ) {
    return false;
  }
  const data = (value as { readonly data?: unknown }).data;
  return (
    data !== null &&
    typeof data === "object" &&
    (data as { readonly type?: unknown }).type === "data" &&
    typeof (data as { readonly data?: unknown }).data === "string"
  );
}
