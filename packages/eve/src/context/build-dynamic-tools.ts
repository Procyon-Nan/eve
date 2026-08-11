import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ContextKey } from "#context/key.js";
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
 * `LiveStepToolsKey`). Session/turn tools are replayed from durable
 * metadata via the bundler's registered step functions.
 */
export function buildDynamicTools(ctx: {
  get<T>(key: ContextKey<T>): T | undefined;
}): readonly HarnessToolDefinition[] {
  const step = ctx.get(LiveStepToolsKey) ?? [];
  const turn = replayDynamicTools(ctx.get(TurnDynamicToolMetadataKey) ?? []);
  const session = replayDynamicTools(ctx.get(SessionDynamicToolMetadataKey) ?? []);
  return [...step, ...turn, ...session];
}
