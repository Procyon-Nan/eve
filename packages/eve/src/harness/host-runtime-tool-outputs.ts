import type { ModelMessage } from "ai";
import { isDeepStrictEqual } from "node:util";

import { isHostRuntimeAttachmentFilePart } from "#internal/attachments/host-runtime-refs.js";
import type { ToolModelOutputValue } from "#harness/tool-model-output.js";
import { hydrateHostRuntimeToolOutputParts } from "#runtime/host-runtime/attachments.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";

interface HydratedToolOutput {
  readonly hydrated: ToolModelOutputValue;
  readonly reference: ToolModelOutputValue;
  readonly toolName: string;
}

export interface HostRuntimeToolOutputState {
  readonly byCallId: Map<string, HydratedToolOutput>;
  readonly claimedCallIds: Set<string>;
}

export function createHostRuntimeToolOutputState(): HostRuntimeToolOutputState {
  return { byCallId: new Map(), claimedCallIds: new Set() };
}

/** Hydrates one Tool output and remembers its authoritative reference form by call ID. */
export async function hydrateHostRuntimeToolOutput(input: {
  readonly output: ToolModelOutputValue;
  readonly signal: AbortSignal;
  readonly state: HostRuntimeToolOutputState;
  readonly toolCallId?: string;
  readonly toolName: string;
}): Promise<ToolModelOutputValue> {
  if (
    input.output.type !== "content" ||
    !input.output.value.some(isHostRuntimeAttachmentFilePart)
  ) {
    return input.output;
  }
  if (input.toolCallId === undefined || input.state.claimedCallIds.has(input.toolCallId)) {
    throw resolutionFailed();
  }
  input.state.claimedCallIds.add(input.toolCallId);
  const value = await hydrateHostRuntimeToolOutputParts(input.output.value, input.signal);
  const hydrated = { type: "content" as const, value } as ToolModelOutputValue;
  input.state.byCallId.set(input.toolCallId, {
    hydrated,
    reference: input.output,
    toolName: input.toolName,
  });
  return hydrated;
}

/** Restores transient Tool bytes in AI SDK response messages to durable host references. */
export function restoreHostRuntimeToolOutputs<TMessage extends ModelMessage>(input: {
  readonly messages: readonly TMessage[];
  readonly requireAll: boolean;
  readonly state: HostRuntimeToolOutputState;
}): TMessage[] {
  if (input.state.byCallId.size === 0) return input.messages as TMessage[];

  const seen = new Set<string>();
  let changed = false;
  const messages = input.messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const expected = input.state.byCallId.get(part.toolCallId);
      if (expected === undefined) return part;
      if (
        seen.has(part.toolCallId) ||
        part.toolName !== expected.toolName ||
        !outputsEqual(part.output, expected.hydrated)
      ) {
        throw resolutionFailed();
      }
      seen.add(part.toolCallId);
      changed = true;
      messageChanged = true;
      return { ...part, output: expected.reference };
    });
    return messageChanged ? ({ ...message, content } as TMessage) : message;
  }) as TMessage[];

  if (input.requireAll && seen.size !== input.state.byCallId.size) {
    throw resolutionFailed();
  }
  return changed ? messages : (input.messages as TMessage[]);
}

function outputsEqual(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(actual, expected);
}

function resolutionFailed(): HostRuntimeError {
  return new HostRuntimeError("HOST_RUNTIME_ATTACHMENT_RESOLUTION_FAILED");
}
