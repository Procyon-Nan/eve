import type { CompiledDynamicSubagentDefinition } from "#compiler/remote-agent-node.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
} from "#internal/authored-module.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedDynamicSubagentDefinition } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ModuleSourceRef } from "#shared/source-ref.js";
import { validateHostRuntimeDefinition } from "#runtime/host-runtime/validation.js";

type DynamicSubagentSource = ModuleSourceRef & CompiledDynamicSubagentDefinition;

export async function resolveDynamicSubagentDefinition(input: {
  readonly definition: DynamicSubagentSource;
  readonly moduleMap: CompiledModuleMap;
  readonly nodeId: string;
}): Promise<ResolvedDynamicSubagentDefinition> {
  try {
    const value = await loadResolvedModuleExport({
      definition: input.definition,
      kindLabel: "dynamic subagent",
      moduleMap: input.moduleMap,
      nodeId: input.nodeId,
    });

    return normalizeResolvedDynamicSubagentDefinition(input.definition, value);
  } catch (error) {
    if (error instanceof ResolveAgentError) {
      throw error;
    }
    throw new ResolveAgentError(
      `Failed to resolve dynamic subagent from "${input.definition.logicalPath}": ${toErrorMessage(error)}`,
      {
        logicalPath: input.definition.logicalPath,
        sourceId: input.definition.sourceId,
      },
    );
  }
}

export function normalizeResolvedDynamicSubagentDefinition(
  definition: DynamicSubagentSource,
  value: unknown,
): ResolvedDynamicSubagentDefinition {
  const message = `Expected the dynamic subagent export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" to provide defineDynamic({ events }).`;
  const record = expectObjectRecord(value, message);
  expectOnlyKnownKeys(record, ["build", "events", "kind", "runtime"], message);

  if (record.kind !== "eve:dynamic") {
    throw new Error(message);
  }

  const eventMap = expectObjectRecord(record.events, message);
  const runtime =
    record.runtime === undefined ? undefined : validateHostRuntimeDefinition(record.runtime);
  if (runtime !== undefined && definition.eventNames.some((name) => name !== "turn.started")) {
    throw new Error(`${message} Host-runtime subagents may only handle turn.started.`);
  }
  const events: Record<string, Function> = {};
  for (const eventName of definition.eventNames) {
    events[eventName] = expectFunction(eventMap[eventName], message);
  }

  const result: ResolvedDynamicSubagentDefinition = {
    eventNames: [...definition.eventNames],
    events: events as ResolvedDynamicSubagentDefinition["events"],
    exportName: definition.exportName,
    logicalPath: definition.logicalPath,
    sourceId: definition.sourceId,
    sourceKind: "module",
  };
  if (runtime !== undefined) Object.assign(result, { runtime });
  return result;
}
