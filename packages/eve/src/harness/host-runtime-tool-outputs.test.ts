import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { contextStorage, ContextContainer } from "#context/container.js";
import { HostRuntimeContextKey, SessionIdKey } from "#context/keys.js";
import {
  createHostRuntimeToolOutputState,
  hydrateHostRuntimeToolOutput,
  restoreHostRuntimeToolOutputs,
} from "#harness/host-runtime-tool-outputs.js";
import { hostRuntimeFile } from "#public/attachments/index.js";
import { registerHostRuntimeProvider } from "#runtime/host-runtime/provider.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import type { ToolModelOutputValue } from "#harness/tool-model-output.js";

describe("host runtime Tool outputs", () => {
  it("hydrates by call ID and restores the authoritative reference before persistence", async () => {
    const reference = { providerKind: "baigong-agent", value: "runtime_1" } as const;
    const file = hostRuntimeFile({
      filename: "chart.png",
      mediaType: "image/png",
      size: 4,
      value: "file_123",
    });
    const output = { type: "content", value: [file] } as ToolModelOutputValue;
    const state = createHostRuntimeToolOutputState();
    const signal = new AbortController().signal;
    const resolveAttachment = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
    const runtimeSession = createRuntimeSession("tool-attachment");
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "session-1");
    ctx.set(HostRuntimeContextKey, {
      acceptanceKey: "command-1",
      ownership: "root",
      reference,
    });

    await withRuntimeSession(runtimeSession, async () => {
      registerHostRuntimeProvider({
        providerKind: reference.providerKind,
        resolve: vi.fn(async () => ({
          model: new MockLanguageModelV3({ modelId: "host", provider: "host" }),
          modelId: "host",
        })),
        resolveAttachment,
      });
      await contextStorage.run(ctx, async () => {
        const hydrated = await hydrateHostRuntimeToolOutput({
          output,
          signal,
          state,
          toolCallId: "call-1",
          toolName: "read_attachment",
        });
        expect(hydrated).toEqual({
          type: "content",
          value: [
            expect.objectContaining({
              data: { data: "AQIDBA==", type: "data" },
              type: "file",
            }),
          ],
        });

        const messages: ModelMessage[] = [
          {
            role: "tool",
            content: [
              {
                output: hydrated,
                toolCallId: "call-1",
                toolName: "read_attachment",
                type: "tool-result",
              },
            ],
          },
        ];
        expect(restoreHostRuntimeToolOutputs({ messages, requireAll: true, state })).toEqual([
          {
            role: "tool",
            content: [
              {
                output,
                toolCallId: "call-1",
                toolName: "read_attachment",
                type: "tool-result",
              },
            ],
          },
        ]);
      });
    });

    expect(resolveAttachment).toHaveBeenCalledOnce();
  });

  it("fails closed for a missing or inconsistent response message", () => {
    const state = createHostRuntimeToolOutputState();
    state.byCallId.set("call-1", {
      hydrated: { type: "text", value: "hydrated" },
      reference: { type: "text", value: "reference" },
      toolName: "read_attachment",
    });
    state.claimedCallIds.add("call-1");

    expect(() =>
      restoreHostRuntimeToolOutputs({ messages: [], requireAll: true, state }),
    ).toThrowError(expect.objectContaining({ code: "HOST_RUNTIME_ATTACHMENT_RESOLUTION_FAILED" }));
    expect(() =>
      restoreHostRuntimeToolOutputs({
        messages: [
          {
            role: "tool",
            content: [
              {
                output: { type: "text", value: "different" },
                toolCallId: "call-1",
                toolName: "read_attachment",
                type: "tool-result",
              },
            ],
          },
        ],
        requireAll: true,
        state,
      }),
    ).toThrowError(expect.objectContaining({ code: "HOST_RUNTIME_ATTACHMENT_RESOLUTION_FAILED" }));
  });

  it("claims a call ID before hydration so concurrent duplicates fail closed", async () => {
    const output = {
      type: "content",
      value: [
        hostRuntimeFile({
          mediaType: "image/png",
          size: 4,
          value: "file_123",
        }),
      ],
    } as ToolModelOutputValue;
    const state = createHostRuntimeToolOutputState();
    state.claimedCallIds.add("call-1");

    await expect(
      hydrateHostRuntimeToolOutput({
        output,
        signal: new AbortController().signal,
        state,
        toolCallId: "call-1",
        toolName: "read_attachment",
      }),
    ).rejects.toMatchObject({ code: "HOST_RUNTIME_ATTACHMENT_RESOLUTION_FAILED" });
  });
});
