import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { estimateModelMessageTokens, estimateTokens } from "#harness/token-estimate.js";

function userFile(data: unknown, filename = "image.png"): ModelMessage {
  return {
    content: [{ data, filename, mediaType: "image/png", type: "file" }],
    role: "user",
  } as ModelMessage;
}

describe("estimateModelMessageTokens", () => {
  it("preserves the serialized estimate for messages without files", () => {
    const messages: ModelMessage[] = [
      { content: "plain text", role: "user" },
      {
        content: [
          {
            output: { type: "json", value: { rows: [1, 2, 3] } },
            toolCallId: "call-1",
            toolName: "query",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    expect(estimateModelMessageTokens(messages)).toBe(estimateTokens(messages));
  });

  it("uses comparable soft reserves for supported inline data forms", () => {
    const bytes = Buffer.alloc(2_927_949, 0x61);
    const base64 = bytes.toString("base64");
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const estimates = [
      bytes,
      new Uint8Array(bytes),
      arrayBuffer,
      `data:image/png;base64,${base64}`,
      base64,
    ].map((data) => estimateModelMessageTokens([userFile(data)]));

    expect(Math.max(...estimates) - Math.min(...estimates)).toBeLessThan(20);
    expect(Math.max(...estimates)).toBeLessThan(4_000);
  });

  it("does not push a roughly 3 MiB image near a 256K context threshold", () => {
    const message = userFile(Buffer.alloc(2_927_949));

    expect(estimateModelMessageTokens([message])).toBeLessThan(256_000 * 0.9);
  });

  it("does not count tool content-output file base64 as text", () => {
    const base64 = Buffer.alloc(2_927_949).toString("base64");
    const messages: ModelMessage[] = [
      {
        content: [
          {
            output: {
              type: "content",
              value: [
                { text: "Rendered image", type: "text" },
                {
                  data: { data: base64, type: "data" },
                  mediaType: "image/png",
                  type: "file",
                },
              ],
            },
            toolCallId: "call-1",
            toolName: "render",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];

    expect(estimateModelMessageTokens(messages)).toBeLessThan(4_000);
    expect(estimateTokens(messages)).toBeGreaterThan(900_000);
  });

  it("uses a deterministic minimum reserve for remote and unknown file data", () => {
    const remote = userFile(new URL("https://example.com/image.png"));
    const unknown = userFile({ source: "provider-owned" });

    expect(estimateModelMessageTokens([remote])).toBe(estimateModelMessageTokens([remote]));
    expect(estimateModelMessageTokens([unknown])).toBeGreaterThanOrEqual(1_024);
    expect(estimateModelMessageTokens([remote])).toBeGreaterThanOrEqual(1_024);
  });

  it("accumulates one bounded reserve per file", () => {
    const huge = Buffer.alloc(40 * 1024 * 1024);
    const one = estimateModelMessageTokens([userFile(huge, "one.png")]);
    const two = estimateModelMessageTokens([
      {
        content: [
          { data: huge, filename: "one.png", mediaType: "image/png", type: "file" },
          { data: huge, filename: "two.png", mediaType: "image/png", type: "file" },
        ],
        role: "user",
      },
    ]);

    expect(one).toBeGreaterThanOrEqual(32_768);
    expect(one).toBeLessThan(33_000);
    expect(two).toBeGreaterThanOrEqual(65_536);
    expect(two).toBeLessThan(66_000);
  });
});
