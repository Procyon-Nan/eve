import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { DurableDynamicToolMetadata } from "#context/keys.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { createLogger } from "#internal/logging.js";
import type {
  ApprovalContext,
  ApprovalResponseContext,
  ApprovalResponseDecision,
  ApprovalStatus,
} from "#public/definitions/approval.js";
import { toInputSchema, toOutputSchema } from "#shared/tool-schema.js";

const log = createLogger("dynamic-tools");
const STEP_REGISTRY_KEY = Symbol.for("@workflow/core//registeredSteps");

export type RegisteredDynamicToolStepFunction = (...args: unknown[]) => unknown;

export function getDynamicToolStepRegistry(): Map<string, RegisteredDynamicToolStepFunction> {
  const globalRegistry = globalThis as Record<
    symbol,
    Map<string, RegisteredDynamicToolStepFunction> | undefined
  >;
  let registry = globalRegistry[STEP_REGISTRY_KEY];
  if (registry === undefined) {
    registry = new Map();
    globalRegistry[STEP_REGISTRY_KEY] = registry;
  }
  return registry;
}

export function lookupDynamicToolStepFunction(
  stepId: string,
): RegisteredDynamicToolStepFunction | null {
  try {
    return getDynamicToolStepRegistry().get(stepId) ?? null;
  } catch {
    return null;
  }
}

function buildReplayedApproval(
  metadata: DurableDynamicToolMetadata,
): HarnessToolDefinition["approval"] | undefined {
  if (metadata.approvalStepFnName === undefined) {
    return undefined;
  }

  const approvalStepFn = lookupDynamicToolStepFunction(metadata.approvalStepFnName);
  if (approvalStepFn === null) {
    log.warn(
      `Dynamic tool "${metadata.name}" references approval function "${metadata.approvalStepFnName}" ` +
        "which is not registered — requiring approval by default.",
    );
    return () => "user-approval";
  }

  const request = async (approvalCtx: ApprovalContext) =>
    (await approvalStepFn(metadata.closureVars ?? {}, approvalCtx)) as ApprovalStatus;
  if (metadata.approvalResponseStepFnName === undefined) return request;

  const responseStepFn = lookupDynamicToolStepFunction(metadata.approvalResponseStepFnName);
  if (responseStepFn === null) {
    log.warn(
      `Dynamic tool "${metadata.name}" references response authorizer ` +
        `"${metadata.approvalResponseStepFnName}" which is not registered — rejecting responses.`,
    );
    return {
      request,
      response: async () => ({
        reason: "Approval response authorization is temporarily unavailable.",
        status: "rejected" as const,
      }),
    };
  }

  return {
    request,
    response: async (responseCtx: ApprovalResponseContext) =>
      (await responseStepFn(metadata.closureVars ?? {}, responseCtx)) as ApprovalResponseDecision,
  };
}

function buildReplayedModelOutput(
  metadata: DurableDynamicToolMetadata,
): HarnessToolDefinition["toModelOutput"] | null | undefined {
  if (metadata.toModelOutputStepFnName === undefined) {
    return undefined;
  }

  if (metadata.toModelOutputClosureVars === undefined) {
    log.warn("Dynamic tool model-output mapper has no closure snapshot — omitting tool.", {
      functionId: metadata.toModelOutputStepFnName,
      toolName: metadata.name,
    });
    return null;
  }

  const mapperStepFn = lookupDynamicToolStepFunction(metadata.toModelOutputStepFnName);
  if (mapperStepFn === null) {
    log.warn("Dynamic tool model-output mapper is not registered — omitting tool.", {
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
      log.warn("Dynamic tool has no executable replay metadata — omitting tool.", {
        toolName: entry.name,
      });
      continue;
    }

    const executeStepFn = lookupDynamicToolStepFunction(entry.executeStepFnName);
    if (executeStepFn === null) {
      log.warn("Dynamic tool execute function is not registered — omitting tool.", {
        functionId: entry.executeStepFnName,
        toolName: entry.name,
      });
      continue;
    }

    const toModelOutput = buildReplayedModelOutput(entry);
    if (toModelOutput === null) continue;

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
