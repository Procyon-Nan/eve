import { createHash } from "node:crypto";

import {
  type LanguageModel,
  type ModelMessage,
  simulateReadableStream,
  type UserContent,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 4_000,
    total: 4_000,
  },
  outputTokens: {
    reasoning: undefined,
    text: 2,
    total: 2,
  },
};

function createModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ text: "ok", type: "text" }],
      finishReason: { raw: undefined, unified: "stop" },
      usage,
      warnings: [],
    },
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { id: "answer", type: "text-start" },
          { delta: "ok", id: "answer", type: "text-delta" },
          { id: "answer", type: "text-end" },
          { finishReason: { raw: undefined, unified: "stop" }, type: "finish", usage },
        ],
      }),
    },
    modelId: "multimodal-test-model",
    provider: "eve-integration-mock",
  });
}

function createSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "multimodal-test-model" },
      system: "Inspect supplied files.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 256_000 * 0.9 },
    continuationToken: "http:multimodal-test-session",
    history: [],
    sessionId: "multimodal-test-session",
  };
}

function createConfig(
  model: LanguageModel,
  events: UnstampedMessageStreamEvent[],
): ToolLoopHarnessConfig {
  return {
    handleEvent: async (event) => {
      events.push(event);
    },
    mode: "conversation",
    resolveModel: async () => model,
    tools: new Map(),
  };
}

function disabledSandboxContext(get: () => Promise<null>): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SandboxKey, {
    captureState: async () => ({ initialized: false, session: null }),
    get,
  });
  return ctx;
}

function fileParts(prompt: readonly ModelMessage[]): Array<{
  readonly data: unknown;
  readonly mediaType: string;
}> {
  return prompt.flatMap((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return [];
    return message.content.flatMap((part) =>
      part.type === "file" ? [{ data: part.data, mediaType: part.mediaType }] : [],
    );
  });
}

function sha256(data: unknown): string {
  if (typeof data === "string") {
    return createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
  }
  if (data instanceof Uint8Array) {
    return createHash("sha256").update(data).digest("hex");
  }
  if (data !== null && typeof data === "object" && "data" in data) {
    return sha256((data as { readonly data: unknown }).data);
  }
  throw new TypeError(`Unsupported model file data: ${Object.prototype.toString.call(data)}`);
}

describe("tool loop multimodal inputs (real AI SDK)", () => {
  it("sends a roughly 3 MiB disabled-sandbox image on the first stream call without compaction", async () => {
    const bytes = Buffer.alloc(2_927_949, 0xa5);
    const content: UserContent = [
      { text: "Describe this image.", type: "text" },
      { data: bytes, filename: "scene.png", mediaType: "image/png", type: "file" },
    ];
    const model = createModel();
    const events: UnstampedMessageStreamEvent[] = [];
    const get = vi.fn(async () => null);

    const result = await contextStorage.run(disabledSandboxContext(get), () =>
      createToolLoopHarness(createConfig(model, events))(createSession(), { message: content }),
    );

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(events.some((event) => event.type === "compaction.requested")).toBe(false);
    expect(events.some((event) => event.type === "compaction.completed")).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
    const files = fileParts((model.doStreamCalls[0]?.prompt ?? []) as ModelMessage[]);
    expect(files).toHaveLength(1);
    expect(files[0]?.mediaType).toBe("image/png");
    expect(sha256(files[0]?.data)).toBe(sha256(bytes));
    expect(result.session.history[0]?.content).toBe(content);
  });
});
