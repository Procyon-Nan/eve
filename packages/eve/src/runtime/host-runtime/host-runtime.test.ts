import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { defineHostRuntime } from "#public/definitions/agent.js";
import { HostRuntimeError, isHostRuntimeError } from "#runtime/host-runtime/errors.js";
import { registerHostRuntimeProvider } from "#runtime/host-runtime/provider.js";
import {
  validateHostRuntimeAcceptanceKey,
  validateHostRuntimeDefinition,
  validateHostRuntimeParentLineage,
  validateHostRuntimeReference,
  validateResolvedHostRuntime,
  validateTrustedHostRuntimeInput,
} from "#runtime/host-runtime/validation.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";

const reference = { providerKind: "baigong-agent", value: "opaque-reference" } as const;
const lineage = {
  callId: "call-1",
  rootSessionId: "root-1",
  sessionId: "parent-1",
  subagentName: "reviewer",
  turnId: "turn-1",
} as const;

function createModel(modelId = "host-model"): MockLanguageModelV3 {
  return new MockLanguageModelV3({ modelId, provider: "host" });
}

describe("host runtime contracts", () => {
  it("validates exact references, declarations, lineage, and trusted input", () => {
    const definition = defineHostRuntime({ providerKind: reference.providerKind });

    expect(validateHostRuntimeReference(reference)).toEqual(reference);
    expect(validateHostRuntimeDefinition(definition)).toEqual(definition);
    expect(validateHostRuntimeParentLineage(lineage)).toEqual(lineage);
    expect(validateTrustedHostRuntimeInput({ acceptanceKey: "command-1", reference })).toEqual({
      acceptanceKey: "command-1",
      reference,
    });

    expect(() => validateHostRuntimeReference({ ...reference, apiKey: "secret" })).toThrowError(
      HostRuntimeError,
    );
    expect(() => validateHostRuntimeDefinition({ ...definition, extra: true })).toThrowError(
      HostRuntimeError,
    );
    expect(() => validateHostRuntimeParentLineage({ ...lineage, extra: true })).toThrowError(
      HostRuntimeError,
    );
    expect(() =>
      validateTrustedHostRuntimeInput({ acceptanceKey: "command-1", extra: true, reference }),
    ).toThrowError(HostRuntimeError);
  });

  it("enforces reference, provider, acceptance-key, and lineage value bounds", () => {
    expect(() => defineHostRuntime({ providerKind: "OpenAI" })).toThrowError(HostRuntimeError);
    expect(() => validateHostRuntimeReference({ ...reference, value: "" })).toThrowError(
      HostRuntimeError,
    );
    expect(() =>
      validateHostRuntimeReference({ ...reference, value: "x".repeat(513) }),
    ).toThrowError(HostRuntimeError);
    expect(() => validateHostRuntimeAcceptanceKey("command-1\nforged")).toThrowError(
      HostRuntimeError,
    );
    expect(() => validateHostRuntimeParentLineage({ ...lineage, turnId: "" })).toThrowError(
      HostRuntimeError,
    );
  });

  it("accepts exact resolved capabilities and rejects malformed snapshots", () => {
    const model = createModel();
    const resolved = {
      contextWindowTokens: 200_000,
      delegatedSubagentNames: ["reviewer"],
      instructions: "Use the locked policy.",
      model,
      modelCallTimeoutMs: 30_000,
      modelId: "host-model",
    } as const;

    expect(validateResolvedHostRuntime(resolved, { specialist: false })).toEqual(resolved);
    expect(() =>
      validateResolvedHostRuntime({ ...resolved, credential: "secret" }, { specialist: false }),
    ).toThrowError(HostRuntimeError);
    expect(() =>
      validateResolvedHostRuntime({ ...resolved, modelCallTimeoutMs: 0 }, { specialist: false }),
    ).toThrowError(HostRuntimeError);
    expect(() => validateResolvedHostRuntime(resolved, { specialist: true })).toThrowError(
      HostRuntimeError,
    );
    expect(() =>
      validateResolvedHostRuntime(
        { model, modelId: "host-model", tools: { invalid: {} } },
        { specialist: false },
      ),
    ).toThrowError(HostRuntimeError);
  });

  it("recognizes only branded structured errors", () => {
    const owned = new HostRuntimeError("HOST_RUNTIME_VERSION_UNAVAILABLE");
    const sameShape = Object.assign(new Error(owned.code), {
      code: owned.code,
      name: owned.name,
    });

    expect(isHostRuntimeError(owned)).toBe(true);
    expect(isHostRuntimeError(sameShape)).toBe(false);
  });
});

describe("host runtime registration", () => {
  it("isolates providers by RuntimeSession and disposes only its own registration", async () => {
    const first = createRuntimeSession("first");
    const second = createRuntimeSession("second");
    const provider = {
      providerKind: reference.providerKind,
      resolve: vi.fn(async () => ({ model: createModel(), modelId: "host-model" })),
    };

    await withRuntimeSession(first, async () => {
      const unregister = registerHostRuntimeProvider(provider);
      expect(() => registerHostRuntimeProvider(provider)).toThrowError(/already registered/);
      expect(first.hostRuntimeProviders.get(reference.providerKind)).toBe(provider);
      unregister();
      unregister();
      expect(first.hostRuntimeProviders.size).toBe(0);
    });

    await withRuntimeSession(second, async () => {
      expect(second.hostRuntimeProviders.size).toBe(0);
    });
  });

  it("does not remove a replacement it does not own", async () => {
    const session = createRuntimeSession("replacement");
    const original = {
      providerKind: reference.providerKind,
      resolve: vi.fn(async () => ({ model: createModel(), modelId: "host-model" })),
    };
    const replacement = { ...original };

    await withRuntimeSession(session, async () => {
      const unregister = registerHostRuntimeProvider(original);
      session.hostRuntimeProviders.set(reference.providerKind, replacement);
      unregister();
      expect(session.hostRuntimeProviders.get(reference.providerKind)).toBe(replacement);
    });
  });
});
