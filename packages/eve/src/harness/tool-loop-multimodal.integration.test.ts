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
import { SandboxKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import { createTurnStartedEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import { defineTool } from "#public/definitions/tool.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";

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
  events?: UnstampedMessageStreamEvent[],
): ToolLoopHarnessConfig {
  return {
    handleEvent:
      events === undefined
        ? undefined
        : async (event) => {
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
    if (!Array.isArray(message.content)) return [];
    return message.content.flatMap((part) => {
      if (part.type === "file") {
        return [{ data: part.data, mediaType: part.mediaType }];
      }
      if (
        part.type !== "tool-result" ||
        part.output.type !== "content" ||
        !Array.isArray(part.output.value)
      ) {
        return [];
      }
      return part.output.value.flatMap((outputPart) =>
        outputPart.type === "file"
          ? [{ data: outputPart.data, mediaType: outputPart.mediaType }]
          : [],
      );
    });
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

  it.each(["generate", "stream"] as const)(
    "preserves a turn-scoped runtime mapper for a 2.93 MiB image on the $branch path",
    async (branch) => {
      const bytes = Buffer.alloc(2_927_949, 0xa5);
      const base64 = bytes.toString("base64");
      const execute = vi.fn(async () => ({
        base64,
        filename: "conversation-image.png",
        mediaType: "image/png",
      }));
      const get = vi.fn(async () => null);
      const ctx = disabledSandboxContext(get);
      ctx.set(SessionIdKey, "dynamic-attachment-session");
      ctx.set(SessionKey, {
        auth: { current: null, initiator: null },
        sessionId: "dynamic-attachment-session",
        turn: { id: "dynamic-attachment-turn", sequence: 0 },
      });
      const finalContent = [{ text: "I inspected the attachment.", type: "text" as const }];
      const firstGenerateResult = {
        content: [
          {
            input: "{}",
            toolCallId: "call-read-attachment",
            toolName: "read_conversation_attachment",
            type: "tool-call" as const,
          },
        ],
        finishReason: { raw: undefined, unified: "tool-calls" as const },
        usage,
        warnings: [],
      };
      const secondGenerateResult = {
        content: finalContent,
        finishReason: { raw: undefined, unified: "stop" as const },
        usage,
        warnings: [],
      };
      const model = contextStorage.run(
        ctx,
        () =>
          new MockLanguageModelV4({
            doGenerate: [firstGenerateResult, secondGenerateResult],
            doStream: [
              {
                stream: simulateReadableStream({
                  chunks: [
                    { type: "stream-start", warnings: [] },
                    {
                      input: "{}",
                      toolCallId: "call-read-attachment",
                      toolName: "read_conversation_attachment",
                      type: "tool-call",
                    },
                    {
                      finishReason: { raw: undefined, unified: "tool-calls" },
                      type: "finish",
                      usage,
                    },
                  ],
                }),
              },
              {
                stream: simulateReadableStream({
                  chunks: [
                    { type: "stream-start", warnings: [] },
                    { id: "answer", type: "text-start" },
                    { delta: "I inspected the attachment.", id: "answer", type: "text-delta" },
                    { id: "answer", type: "text-end" },
                    {
                      finishReason: { raw: undefined, unified: "stop" },
                      type: "finish",
                      usage,
                    },
                  ],
                }),
              },
            ],
            modelId: `dynamic-tool-${branch}-model`,
            provider: "eve-integration-mock",
          }),
      );
      const resolver: ResolvedDynamicToolResolver = {
        eventNames: ["turn.started"],
        events: {
          "turn.started": () => ({
            read_conversation_attachment: defineTool({
              description: "Read a conversation attachment.",
              inputSchema: { additionalProperties: false, type: "object" },
              execute,
              toModelOutput: (output) => {
                const attachment = output as {
                  readonly base64: string;
                  readonly filename: string;
                  readonly mediaType: string;
                };
                return {
                  type: "content" as const,
                  value: [
                    { text: "Conversation attachment.", type: "text" as const },
                    {
                      data: { data: attachment.base64, type: "data" as const },
                      filename: attachment.filename,
                      mediaType: attachment.mediaType,
                      type: "file" as const,
                    },
                  ],
                };
              },
            }),
          }),
        },
        logicalPath: "agent/tools/capabilities.ts",
        slug: "capabilities",
        sourceId: "integration:dynamic-attachment",
        sourceKind: "module",
      };
      const events: UnstampedMessageStreamEvent[] | undefined =
        branch === "stream" ? [] : undefined;
      await dispatchDynamicToolEvent({
        ctx,
        resolvers: [resolver],
        event: createTurnStartedEvent({ sequence: 0, turnId: "dynamic-attachment-turn" }),
        messages: [],
      });
      ctx.clearVirtualContext();
      const baseSession = createSession();
      const session: HarnessSession = {
        ...baseSession,
        agent: {
          ...baseSession.agent,
          modelReference: { id: `dynamic-tool-${branch}-model` },
        },
      };
      const runStep = createToolLoopHarness(createConfig(model, events));

      const second = await contextStorage.run(ctx, async () => {
        const first = await runStep(session, { message: "Inspect the saved attachment." });
        expect(typeof first.next).toBe("function");
        if (typeof first.next !== "function") {
          throw new TypeError("Expected the dynamic tool call to continue the tool loop.");
        }
        return await first.next(first.session);
      });

      expect(execute).toHaveBeenCalledTimes(1);
      const calls = branch === "stream" ? model.doStreamCalls : model.doGenerateCalls;
      expect(calls).toHaveLength(2);
      expect(branch === "stream" ? model.doGenerateCalls : model.doStreamCalls).toHaveLength(0);
      const secondPrompt = (calls[1]?.prompt ?? []) as ModelMessage[];
      const projectedFiles = fileParts(secondPrompt);
      expect(projectedFiles).toHaveLength(1);
      expect(projectedFiles[0]?.mediaType).toBe("image/png");
      expect(sha256(projectedFiles[0]?.data)).toBe(sha256(bytes));
      expect(secondPrompt.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
        "tool",
      ]);
      expect(second.session.history.filter((message) => message.role === "user")).toHaveLength(1);
      expect(JSON.stringify(second.session.history)).toContain(base64);
      expect(get).not.toHaveBeenCalled();
      if (events !== undefined) {
        expect(events.filter((event) => event.type === "message.received")).toHaveLength(1);
      }
    },
  );
});
