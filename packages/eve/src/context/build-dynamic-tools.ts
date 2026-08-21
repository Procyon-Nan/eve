import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessToolMap } from "#harness/types.js";
import type { ContextReader } from "#context/key.js";
import {
  SessionDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
  LiveStepToolsKey,
} from "#context/keys.js";
import { replayDynamicTools } from "#context/dynamic-tool-replay.js";

/**
 * Builds live dynamic tool definitions. Narrower scopes appear first
 * so they win on name collision (the tool-loop uses `??=` for dedup).
 *
 * Step tools are live closures (re-resolved every step via
 * `LiveStepToolsKey`). Session and turn tools replay durable metadata.
 */
export function buildResponseAuthorizationTools(input: {
  readonly authoredTools: HarnessToolMap;
  readonly context?: ContextReader;
}): HarnessToolMap {
  const tools = new Map<string, HarnessToolDefinition>();
  for (const tool of input.context === undefined ? [] : buildDynamicTools(input.context)) {
    if (!tools.has(tool.name)) tools.set(tool.name, tool);
  }
  for (const [name, tool] of input.authoredTools) {
    if (!tools.has(name)) tools.set(name, tool);
  }
  return tools;
}

export function buildDynamicTools(ctx: ContextReader): readonly HarnessToolDefinition[] {
  const step = ctx.get(LiveStepToolsKey) ?? [];
  const turn = replayDynamicTools(ctx.get(TurnDynamicToolMetadataKey) ?? []);
  const session = replayDynamicTools(ctx.get(SessionDynamicToolMetadataKey) ?? []);
  return [...step, ...turn, ...session];
}
