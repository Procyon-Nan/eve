import { isBrandedToolEntry, type DynamicToolSet } from "#shared/dynamic-tool-definition.js";
import {
  HOST_RUNTIME_DEFINITION_KIND,
  type HostRuntimeDefinition,
  type HostRuntimeParentLineage,
  type HostRuntimeReference,
  type ResolvedHostRuntime,
  type TrustedHostRuntimeInput,
} from "#shared/host-runtime.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";

const PROVIDER_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/;
const MAX_REFERENCE_VALUE_LENGTH = 512;
export const MAX_HOST_RUNTIME_ACCEPTANCE_KEY_LENGTH = 200;
const MAX_MODEL_ID_LENGTH = 255;

export function validateProviderKind(providerKind: unknown): string {
  if (typeof providerKind !== "string" || !PROVIDER_KIND_PATTERN.test(providerKind)) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return providerKind;
}

export function validateHostRuntimeReference(value: unknown): HostRuntimeReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "providerKind") ||
    !Object.hasOwn(record, "value")
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  const providerKind = validateProviderKind(record.providerKind);
  if (
    typeof record.value !== "string" ||
    record.value.length === 0 ||
    record.value.length > MAX_REFERENCE_VALUE_LENGTH
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return { providerKind, value: record.value };
}

export function validateHostRuntimeParentLineage(value: unknown): HostRuntimeParentLineage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  const record = value as Record<string, unknown>;
  const keys = ["rootSessionId", "sessionId", "turnId", "callId", "subagentName"] as const;
  if (Object.keys(record).length !== keys.length) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  for (const key of keys) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
    }
  }
  return {
    callId: record.callId as string,
    rootSessionId: record.rootSessionId as string,
    sessionId: record.sessionId as string,
    subagentName: record.subagentName as string,
    turnId: record.turnId as string,
  };
}

export function validateHostRuntimeDefinition(value: unknown): HostRuntimeDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    record.kind !== HOST_RUNTIME_DEFINITION_KIND ||
    !Object.hasOwn(record, "providerKind")
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return {
    kind: HOST_RUNTIME_DEFINITION_KIND,
    providerKind: validateProviderKind(record.providerKind),
  };
}

export function validateTrustedHostRuntimeInput(value: unknown): TrustedHostRuntimeInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return {
    acceptanceKey: validateHostRuntimeAcceptanceKey(record.acceptanceKey),
    reference: validateHostRuntimeReference(record.reference),
  };
}

export function validateHostRuntimeAcceptanceKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_HOST_RUNTIME_ACCEPTANCE_KEY_LENGTH ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return value;
}

export function validateResolvedHostRuntime(
  value: unknown,
  input: { readonly specialist: boolean },
): ResolvedHostRuntime {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
  const resolved = value as Partial<ResolvedHostRuntime>;
  if (!isRuntimeLanguageModel(resolved.model)) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
  if (
    typeof resolved.modelId !== "string" ||
    resolved.modelId.length === 0 ||
    resolved.modelId.length > MAX_MODEL_ID_LENGTH
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
  validateOptionalPositiveInteger(resolved.contextWindowTokens);
  validateOptionalPositiveInteger(resolved.modelCallTimeoutMs);
  if (resolved.instructions !== undefined && typeof resolved.instructions !== "string") {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
  if (resolved.tools !== undefined) {
    validateToolSet(resolved.tools);
  }
  const delegatedSubagentNames = validateDelegatedSubagentNames(resolved.delegatedSubagentNames);
  if (input.specialist && delegatedSubagentNames.length > 0) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }

  const result: ResolvedHostRuntime = {
    model: resolved.model,
    modelId: resolved.modelId,
  };
  if (resolved.contextWindowTokens !== undefined) {
    Object.assign(result, { contextWindowTokens: resolved.contextWindowTokens });
  }
  if (resolved.modelCallTimeoutMs !== undefined) {
    Object.assign(result, { modelCallTimeoutMs: resolved.modelCallTimeoutMs });
  }
  if (resolved.instructions !== undefined)
    Object.assign(result, { instructions: resolved.instructions });
  if (resolved.tools !== undefined) Object.assign(result, { tools: resolved.tools });
  if (delegatedSubagentNames.length > 0) Object.assign(result, { delegatedSubagentNames });
  return result;
}

function isRuntimeLanguageModel(value: unknown): value is ResolvedHostRuntime["model"] {
  if (typeof value !== "object" || value === null) return false;
  const model = value as {
    readonly specificationVersion?: unknown;
    readonly provider?: unknown;
    readonly modelId?: unknown;
    readonly doGenerate?: unknown;
    readonly doStream?: unknown;
  };
  return (
    (model.specificationVersion === "v2" ||
      model.specificationVersion === "v3" ||
      model.specificationVersion === "v4") &&
    typeof model.provider === "string" &&
    typeof model.modelId === "string" &&
    typeof model.doGenerate === "function" &&
    typeof model.doStream === "function"
  );
}

function validateOptionalPositiveInteger(value: unknown): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) <= 0)) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
}

function validateToolSet(value: unknown): asserts value is DynamicToolSet {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
  for (const [name, entry] of Object.entries(value)) {
    if (name.length === 0 || !isBrandedToolEntry(entry)) {
      throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
    }
  }
}

function validateDelegatedSubagentNames(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
  const names = value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 255) {
      throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
    }
    return entry;
  });
  if (new Set(names).size !== names.length) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
  return names;
}
