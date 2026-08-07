import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { DurableDynamicToolMetadata } from "#context/keys.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { createLogger } from "#internal/logging.js";
import type { ApprovalContext, ApprovalStatus } from "#public/definitions/approval.js";
import { toInputSchema, toOutputSchema } from "#shared/tool-schema.js";

const log = createLogger("dynamic-tools");
const STEP_REGISTRY_KEY = Symbol.for("@workflow/core//registeredSteps");

type RegisteredStepFunction = (...args: unknown[]) => unknown;

function getStepRegistry(): Map<string, RegisteredStepFunction> {
  const globalRegistry = globalThis as Record<
    symbol,
    Map<string, RegisteredStepFunction> | undefined
  >;
  let registry = globalRegistry[STEP_REGISTRY_KEY];
  if (registry === undefined) {
    registry = new Map();
    globalRegistry[STEP_REGISTRY_KEY] = registry;
  }
  return registry;
}

function lookupStepFunction(stepId: string): RegisteredStepFunction | null {
  try {
    return getStepRegistry().get(stepId) ?? null;
  } catch {
    return null;
  }
}

/** Registers one process-local fallback used to replay a runtime-created dynamic tool function. */
export function registerDynamicToolStepFunction(stepId: string, fn: RegisteredStepFunction): void {
  getStepRegistry().set(stepId, fn);
}

function buildReplayedApproval(
  metadata: DurableDynamicToolMetadata,
): HarnessToolDefinition["approval"] | undefined {
  if (metadata.approvalStepFnName === undefined) {
    return undefined;
  }

  const approvalStepFn = lookupStepFunction(metadata.approvalStepFnName);
  if (approvalStepFn === null) {
    log.warn("dynamic tool approval function is not registered; requiring approval", {
      functionId: metadata.approvalStepFnName,
      toolName: metadata.name,
    });
    return () => "user-approval";
  }

  return async (approvalCtx: ApprovalContext) =>
    (await approvalStepFn(metadata.closureVars ?? {}, approvalCtx)) as ApprovalStatus;
}

function buildReplayedModelOutput(
  metadata: DurableDynamicToolMetadata,
): HarnessToolDefinition["toModelOutput"] | null | undefined {
  if (metadata.toModelOutputStepFnName === undefined) {
    return undefined;
  }

  if (metadata.toModelOutputClosureVars === undefined) {
    log.warn("dynamic tool model-output mapper has no closure snapshot; omitting tool", {
      functionId: metadata.toModelOutputStepFnName,
      toolName: metadata.name,
    });
    return null;
  }

  const mapperStepFn = lookupStepFunction(metadata.toModelOutputStepFnName);
  if (mapperStepFn === null) {
    log.warn("dynamic tool model-output mapper is not registered; omitting tool", {
      functionId: metadata.toModelOutputStepFnName,
      toolName: metadata.name,
    });
    return null;
  }

  return (output: unknown) => mapperStepFn(metadata.toModelOutputClosureVars, output);
}

/** Reconstructs session- or turn-scoped tools from durable metadata. */
export function replayDynamicTools(
  metadata: readonly DurableDynamicToolMetadata[],
): readonly HarnessToolDefinition[] {
  const tools: HarnessToolDefinition[] = [];

  for (const entry of metadata) {
    if (entry.executeStepFnName === undefined || entry.closureVars === undefined) {
      log.warn("dynamic tool has no executable replay metadata; omitting tool", {
        toolName: entry.name,
      });
      continue;
    }

    const executeStepFn = lookupStepFunction(entry.executeStepFnName);
    if (executeStepFn === null) {
      log.warn("dynamic tool execute function is not registered; omitting tool", {
        functionId: entry.executeStepFnName,
        toolName: entry.name,
      });
      continue;
    }

    const toModelOutput = buildReplayedModelOutput(entry);
    if (toModelOutput === null) {
      continue;
    }

    tools.push({
      description: entry.description,
      execute: createToolExecuteWithAuth({
        scope: entry.name,
        execute: (input, ctx) => executeStepFn(entry.closureVars, input, ctx),
      }),
      inputSchema: toInputSchema(entry.inputSchema),
      name: entry.name,
      approval: buildReplayedApproval(entry),
      outputSchema: toOutputSchema(entry.outputSchema),
      toModelOutput,
    });
  }

  return tools;
}
