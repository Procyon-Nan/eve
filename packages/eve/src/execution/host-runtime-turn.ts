import type { ContextContainer } from "#context/container.js";
import { HostRuntimeContextKey } from "#context/keys.js";
import {
  type EffectiveAgentRuntime,
  resolveEffectiveAgentRuntime,
} from "#execution/effective-agent-config.js";
import type { TurnStepInput } from "#execution/durable-session-migrations/turn-workflow.js";
import {
  prepareHostRuntimePreflight,
  throwHostRuntimeAtStepBoundary,
} from "#runtime/host-runtime/preflight.js";
import { validateDurableHostRuntimeContext } from "#runtime/host-runtime/validation.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedHostRuntime } from "#shared/host-runtime.js";

export async function prepareHostRuntimeTurnContext(
  ctx: ContextContainer,
  input: TurnStepInput["input"],
  bundle: Pick<CompiledBundle, "resolvedAgent" | "turnAgent">,
): Promise<{
  readonly effectiveAgent: EffectiveAgentRuntime;
  readonly hostRuntime: ResolvedHostRuntime | undefined;
}> {
  try {
    updateHostRuntimeContext(ctx, input);
    const hostRuntime = await prepareHostRuntimePreflight(ctx);
    return { effectiveAgent: resolveEffectiveAgentRuntime(bundle, ctx), hostRuntime };
  } catch (error) {
    throwHostRuntimeAtStepBoundary(error);
  }
}

function updateHostRuntimeContext(ctx: ContextContainer, input: TurnStepInput["input"]): void {
  if (input?.kind === "deliver" && input.hostRuntime !== undefined) {
    ctx.set(HostRuntimeContextKey, validateDurableHostRuntimeContext(input.hostRuntime));
    return;
  }
  if (input?.kind === "runtime-action-result" || input === undefined) return;
  if (ctx.get(HostRuntimeContextKey)?.ownership === "root") {
    ctx.delete(HostRuntimeContextKey);
  }
}
