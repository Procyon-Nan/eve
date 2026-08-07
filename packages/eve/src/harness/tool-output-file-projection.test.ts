import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { projectToolOutputFilesForModel } from "#harness/tool-output-file-projection.js";

function toolMessage(
  results: Array<{
    readonly output: unknown;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly type: "tool-result";
  }>,
): ModelMessage {
  return { content: results, role: "tool" } as ModelMessage;
}

function contentResult(input: {
  readonly files: ReadonlyArray<{
    readonly base64: string;
    readonly filename?: string;
    readonly mediaType: string;
  }>;
  readonly id?: string;
  readonly name?: string;
  readonly text?: string;
}) {
  return {
    output: {
      type: "content",
      value: [
        ...(input.text === undefined ? [] : [{ text: input.text, type: "text" as const }]),
        ...input.files.map((file) => ({
          data: { data: file.base64, type: "data" as const },
          filename: file.filename,
          mediaType: file.mediaType,
          type: "file" as const,
        })),
      ],
    },
    toolCallId: input.id ?? "call-1",
    toolName: input.name ?? "render",
    type: "tool-result" as const,
  };
}

describe("projectToolOutputFilesForModel", () => {
  it("returns the original messages when tool outputs contain no files", () => {
    const messages: ModelMessage[] = [
      toolMessage([
        {
          output: { type: "json", value: { ok: true } },
          toolCallId: "call-1",
          toolName: "query",
          type: "tool-result",
        },
        {
          output: { type: "text", value: "done" },
          toolCallId: "call-2",
          toolName: "status",
          type: "tool-result",
        },
      ]),
    ];

    expect(projectToolOutputFilesForModel(messages)).toBe(messages);
  });

  it("moves a content-output image into a following transient user message", () => {
    const bytes = Buffer.from("image bytes");
    const messages = [
      toolMessage([
        contentResult({
          files: [
            { base64: bytes.toString("base64"), filename: "chart.png", mediaType: "image/png" },
          ],
          text: "Chart rendered.",
        }),
      ]),
    ];

    const result = projectToolOutputFilesForModel(messages);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(
      toolMessage([
        {
          output: { type: "text", value: "Chart rendered." },
          toolCallId: "call-1",
          toolName: "render",
          type: "tool-result",
        },
      ]),
    );
    const userContent = result[1]?.content;
    expect(result[1]?.role).toBe("user");
    expect(Array.isArray(userContent) ? userContent.map((part) => part.type) : []).toEqual([
      "text",
      "text",
      "file",
    ]);
    expect(Array.isArray(userContent) ? userContent[0] : undefined).toEqual({
      text: "Files returned by prior tool result #1:",
      type: "text",
    });
    expect(JSON.stringify(Array.isArray(userContent) ? userContent[0] : undefined)).not.toContain(
      "render",
    );
    expect(JSON.stringify(Array.isArray(userContent) ? userContent[0] : undefined)).not.toContain(
      "call-1",
    );
    const file = Array.isArray(userContent) ? userContent[2] : undefined;
    expect(file?.type).toBe("file");
    if (file?.type === "file") {
      expect(Buffer.from(file.data as Uint8Array)).toEqual(bytes);
      expect(file.filename).toBe("chart.png");
      expect(file.mediaType).toBe("image/png");
    }
  });

  it("keeps a non-empty paired tool result for file-only output", () => {
    const messages = [
      toolMessage([
        contentResult({
          files: [{ base64: "cGRm", filename: "report.pdf", mediaType: "application/pdf" }],
        }),
      ]),
    ];

    const result = projectToolOutputFilesForModel(messages);
    const toolContent = result[0]?.content;
    const part = Array.isArray(toolContent) ? toolContent[0] : undefined;
    expect(part?.type).toBe("tool-result");
    if (part?.type === "tool-result") {
      expect(part.output).toEqual({
        type: "text",
        value: "The tool returned file content attached in the following user message.",
      });
    }
  });

  it("preserves multiple file order, names, and media types", () => {
    const messages = [
      toolMessage([
        contentResult({
          files: [
            { base64: "b25l", filename: "one.png", mediaType: "image/png" },
            { base64: "dHdv", filename: "two.pdf", mediaType: "application/pdf" },
          ],
        }),
      ]),
    ];

    const result = projectToolOutputFilesForModel(messages);
    const userContent = result[1]?.content;
    const files = Array.isArray(userContent)
      ? userContent.filter((part) => part.type === "file")
      : [];
    expect(files.map((file) => [file.filename, file.mediaType])).toEqual([
      ["one.png", "image/png"],
      ["two.pdf", "application/pdf"],
    ]);
  });

  it("places every parallel tool result before the combined user message", () => {
    const messages = [
      toolMessage([
        contentResult({
          files: [{ base64: "b25l", mediaType: "image/png" }],
          id: "call-1",
          name: "first",
        }),
        {
          output: { type: "json", value: { ok: true } },
          toolCallId: "call-2",
          toolName: "second",
          type: "tool-result",
        },
        contentResult({
          files: [{ base64: "dHdv", mediaType: "application/pdf" }],
          id: "call-3",
          name: "third",
        }),
      ]),
    ];

    const result = projectToolOutputFilesForModel(messages);

    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("tool");
    expect(Array.isArray(result[0]?.content) ? result[0].content : []).toHaveLength(3);
    expect(result[1]?.role).toBe("user");
  });

  it("waits for consecutive tool messages before appending projected files", () => {
    const messages = [
      toolMessage([
        contentResult({
          files: [{ base64: "b25l", mediaType: "image/png" }],
          id: "call-1",
          name: "first",
        }),
      ]),
      toolMessage([
        {
          output: { type: "text", value: "second result" },
          toolCallId: "call-2",
          toolName: "second",
          type: "tool-result",
        },
      ]),
    ];

    const result = projectToolOutputFilesForModel(messages);

    expect(result.map((message) => message.role)).toEqual(["tool", "tool", "user"]);
  });

  it("restarts file-result ordinals after a non-tool message boundary", () => {
    const messages = [
      toolMessage([
        contentResult({
          files: [{ base64: "b25l", mediaType: "image/png" }],
          id: "call-1",
          name: "first",
        }),
      ]),
      { content: "next step", role: "assistant" as const },
      toolMessage([
        contentResult({
          files: [{ base64: "dHdv", mediaType: "image/png" }],
          id: "call-2",
          name: "second",
        }),
      ]),
    ];

    const result = projectToolOutputFilesForModel(messages);
    const labels = result.flatMap((message) =>
      message.role === "user" && Array.isArray(message.content)
        ? message.content.flatMap((part) =>
            part.type === "text" && part.text.startsWith("Files returned by prior")
              ? [part.text]
              : [],
          )
        : [],
    );

    expect(labels).toEqual([
      "Files returned by prior tool result #1:",
      "Files returned by prior tool result #1:",
    ]);
  });

  it("does not mutate durable history", () => {
    const messages = [
      { content: "before", role: "user" as const },
      toolMessage([
        contentResult({
          files: [{ base64: "aW1hZ2U=", filename: "image.png", mediaType: "image/png" }],
        }),
      ]),
      { content: "after", role: "assistant" as const },
    ];
    const snapshot = JSON.stringify(messages);

    const result = projectToolOutputFilesForModel(messages);

    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(result.at(-1)).toBe(messages.at(-1));
    expect(result).not.toBe(messages);
  });
});
