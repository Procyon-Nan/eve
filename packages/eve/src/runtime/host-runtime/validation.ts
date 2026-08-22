import { HostRuntimeError } from "#runtime/host-runtime/errors.js";
import { isBrandedToolEntry, type DynamicToolSet } from "#shared/dynamic-tool-definition.js";
import {
  HOST_RUNTIME_DEFINITION_KIND,
  type DurableHostRuntimeContext,
  type HostRuntimeDefinition,
  type HostRuntimeParentLineage,
  type HostRuntimeReference,
  type ResolvedHostRuntime,
  type TrustedHostRuntimeInput,
} from "#shared/host-runtime.js";
import { isRuntimeLanguageModel } from "#shared/runtime-language-model.js";

export const HOST_RUNTIME_PROVIDER_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/;
export const MAX_HOST_RUNTIME_REFERENCE_VALUE_LENGTH = 512;
export const MAX_HOST_RUNTIME_ACCEPTANCE_KEY_LENGTH = 200;
const MAX_MODEL_ID_LENGTH = 255;
const MAX_MODEL_CALL_TIMEOUT_MS = 2_147_483_647;
const RESOLVED_RUNTIME_KEYS = new Set([
  "contextWindowTokens",
  "delegatedSubagentNames",
  "instructions",
  "model",
  "modelCallTimeoutMs",
  "modelId",
  "tools",
]);

export function validateProviderKind(providerKind: unknown): string {
  if (typeof providerKind !== "string" || !HOST_RUNTIME_PROVIDER_KIND_PATTERN.test(providerKind)) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return providerKind;
}

export function validateHostRuntimeReference(value: unknown): HostRuntimeReference {
  const record = expectStrictRecord(value, ["providerKind", "value"]);
  const providerKind = validateProviderKind(record.providerKind);
  if (
    typeof record.value !== "string" ||
    record.value.length === 0 ||
    record.value.length > MAX_HOST_RUNTIME_REFERENCE_VALUE_LENGTH
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return { providerKind, value: record.value };
}

export function validateHostRuntimeParentLineage(value: unknown): HostRuntimeParentLineage {
  const keys = ["rootSessionId", "sessionId", "turnId", "callId", "subagentName"] as const;
  const record = expectStrictRecord(value, keys);
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
  const record = expectStrictRecord(value, ["kind", "providerKind"]);
  if (record.kind !== HOST_RUNTIME_DEFINITION_KIND) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return {
    kind: HOST_RUNTIME_DEFINITION_KIND,
    providerKind: validateProviderKind(record.providerKind),
  };
}

export function validateTrustedHostRuntimeInput(value: unknown): TrustedHostRuntimeInput {
  const record = expectStrictRecord(value, ["acceptanceKey", "reference"]);
  return {
    acceptanceKey: validateHostRuntimeAcceptanceKey(record.acceptanceKey),
    reference: validateHostRuntimeReference(record.reference),
  };
}

export function validateDurableHostRuntimeContext(value: unknown): DurableHostRuntimeContext {
  const record = expectAllowedRecord(value, [
    "acceptanceKey",
    "ownership",
    "parent",
    "reference",
    "releasedOutcome",
  ]);
  const ownership = record.ownership;
  if (ownership !== "root" && ownership !== "specialist" && ownership !== "inherited") {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  if (ownership === "root" && record.acceptanceKey === undefined) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  if (ownership === "specialist" && record.parent === undefined) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  const releasedOutcome = record.releasedOutcome;
  if (
    releasedOutcome !== undefined &&
    releasedOutcome !== "completed" &&
    releasedOutcome !== "failed" &&
    releasedOutcome !== "cancelled" &&
    releasedOutcome !== "start_failed"
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }

  const result: { -readonly [K in keyof DurableHostRuntimeContext]: DurableHostRuntimeContext[K] } =
    {
      ownership,
      reference: validateHostRuntimeReference(record.reference),
    };
  if (record.acceptanceKey !== undefined) {
    result.acceptanceKey = validateHostRuntimeAcceptanceKey(record.acceptanceKey);
  }
  if (record.parent !== undefined) {
    result.parent = validateHostRuntimeParentLineage(record.parent);
  }
  if (releasedOutcome !== undefined) result.releasedOutcome = releasedOutcome;
  return result;
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
  if (!isRecord(value) || Object.keys(value).some((key) => !RESOLVED_RUNTIME_KEYS.has(key))) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
  if (!Object.hasOwn(value, "model") || !Object.hasOwn(value, "modelId")) {
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
  validateOptionalPositiveInteger(resolved.modelCallTimeoutMs, MAX_MODEL_CALL_TIMEOUT_MS);
  if (resolved.instructions !== undefined && typeof resolved.instructions !== "string") {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
  if (resolved.tools !== undefined) validateToolSet(resolved.tools);

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
  if (resolved.instructions !== undefined) {
    Object.assign(result, { instructions: resolved.instructions });
  }
  if (resolved.tools !== undefined) Object.assign(result, { tools: resolved.tools });
  if (delegatedSubagentNames.length > 0) Object.assign(result, { delegatedSubagentNames });
  return result;
}

function expectStrictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return value;
}

function expectAllowedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new HostRuntimeError("HOST_RUNTIME_REFERENCE_INVALID");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOptionalPositiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum)
  ) {
    throw new HostRuntimeError("HOST_RUNTIME_RESOLUTION_FAILED");
  }
}

function validateToolSet(value: unknown): asserts value is DynamicToolSet {
  if (!isRecord(value)) {
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
