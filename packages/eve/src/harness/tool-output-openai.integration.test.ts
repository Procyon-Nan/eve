import { createHash } from "node:crypto";

import { generateText, type ModelMessage, streamText } from "ai";
import { describe, expect, it } from "vitest";

import { createOpenAI } from "#compiled/@ai-sdk/openai/index.js";
import { projectToolOutputFilesForModel } from "#harness/tool-output-file-projection.js";

interface RecordedRequest {
  readonly body: Record<string, unknown>;
  readonly url: string;
}

function createRecordingFetch(requests: RecordedRequest[]): typeof fetch {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ body, url: input instanceof Request ? input.url : input.toString() });

    if (body.stream === true) {
      const chunks = [
        {
          choices: [{ delta: { content: "ok", role: "assistant" }, finish_reason: null, index: 0 }],
          created: 1,
          id: "chatcmpl-stream",
          model: "gpt-4o-mini",
          object: "chat.completion.chunk",
        },
        {
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          created: 1,
          id: "chatcmpl-stream",
          model: "gpt-4o-mini",
          object: "chat.completion.chunk",
          usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
        },
      ];
      const payload = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
      return new Response(payload, { headers: { "content-type": "text/event-stream" } });
    }

    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          logprobs: null,
          message: { content: "ok", role: "assistant" },
        },
      ],
      created: 1,
      id: "chatcmpl-generate",
      model: "gpt-4o-mini",
      object: "chat.completion",
      usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    });
  };
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function dataUrlBytes(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new TypeError("Expected an inline data URL.");
  }
  const comma = value.indexOf(",");
  if (!value.startsWith("data:") || comma === -1) {
    throw new TypeError("Expected an inline data URL.");
  }
  return Buffer.from(value.slice(comma + 1), "base64");
}

function openAIImageUrls(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.flatMap((message) => {
    if (message === null || typeof message !== "object") return [];
    const content = (message as { readonly content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      if (part === null || typeof part !== "object") return [];
      if ((part as { readonly type?: unknown }).type !== "image_url") return [];
      const imageUrl = (part as { readonly image_url?: unknown }).image_url;
      return imageUrl !== null &&
        typeof imageUrl === "object" &&
        typeof (imageUrl as { readonly url?: unknown }).url === "string"
        ? [(imageUrl as { readonly url: string }).url]
        : [];
    });
  });
}

describe("OpenAI Chat Completions multimodal request projection", () => {
  it.each(["generate", "stream"] as const)(
    "sends direct and tool-returned images as image_url parts in the %s branch",
    async (branch) => {
      const directBytes = Buffer.from("direct user image");
      const toolBytes = Buffer.from("image returned by tool");
      const toolBase64 = toolBytes.toString("base64");
      const durableMessages: ModelMessage[] = [
        {
          content: [
            { text: "Inspect this image.", type: "text" },
            {
              data: directBytes,
              filename: "direct.png",
              mediaType: "image/png",
              type: "file",
            },
          ],
          role: "user",
        },
        {
          content: [
            { input: {}, toolCallId: "call-render", toolName: "render", type: "tool-call" },
          ],
          role: "assistant",
        },
        {
          content: [
            {
              output: {
                type: "content",
                value: [
                  { text: "Rendered result.", type: "text" },
                  {
                    data: { data: toolBase64, type: "data" },
                    filename: "tool.png",
                    mediaType: "image/png",
                    type: "file",
                  },
                ],
              },
              toolCallId: "call-render",
              toolName: "render",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ];
      const snapshot = JSON.stringify(durableMessages);
      const messages = projectToolOutputFilesForModel(durableMessages);
      const requests: RecordedRequest[] = [];
      const model = createOpenAI({
        apiKey: "sk-test",
        baseURL: "https://openai.test/v1",
        fetch: createRecordingFetch(requests),
      }).chat("gpt-4o-mini");

      if (branch === "stream") {
        const result = streamText({ messages, model });
        await result.consumeStream();
      } else {
        await generateText({ messages, model });
      }

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://openai.test/v1/chat/completions");
      expect(requests[0]?.body.stream).toBe(branch === "stream" ? true : undefined);
      const wireMessages = Array.isArray(requests[0]?.body.messages)
        ? requests[0].body.messages
        : [];
      expect(
        wireMessages.map((message) =>
          message !== null && typeof message === "object"
            ? (message as { readonly role?: unknown }).role
            : undefined,
        ),
      ).toEqual(["user", "assistant", "tool", "user"]);
      expect(JSON.stringify(wireMessages[2])).not.toContain(toolBase64);

      const imageUrls = openAIImageUrls(requests[0]!.body);
      expect(imageUrls).toHaveLength(2);
      expect(sha256(dataUrlBytes(imageUrls[0]))).toBe(sha256(directBytes));
      expect(sha256(dataUrlBytes(imageUrls[1]))).toBe(sha256(toolBytes));
      expect(JSON.stringify(durableMessages)).toBe(snapshot);
    },
  );
});
