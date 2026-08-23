import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  AuthKey,
  HostRuntimeContextKey,
  HostRuntimePreflightKey,
  InitiatorAuthKey,
  ParentSessionKey,
  SessionIdKey,
  SubagentDepthKey,
} from "#context/keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import { defineHostRuntime } from "#public/definitions/agent.js";
import { HostRuntimeError, isHostRuntimeError } from "#runtime/host-runtime/errors.js";
import {
  prepareHostRuntimePreflight,
  getEffectiveDelegatedSubagentNames,
  isTopLevelHostRuntimeRoot,
  throwHostRuntimeAtStepBoundary,
} from "#runtime/host-runtime/preflight.js";
import { registerHostRuntimeProvider } from "#runtime/host-runtime/provider.js";
import {
  hostRuntimeInstructions,
  hostRuntimeModel,
  hostRuntimeTools,
} from "#runtime/host-runtime/resolve-context.js";
import {
  validateDurableHostRuntimeContext,
  validateHostRuntimeAcceptanceKey,
  validateHostRuntimeDefinition,
  validateHostRuntimeParentLineage,
  validateHostRuntimeReference,
  validateResolvedHostRuntime,
  validateTrustedHostRuntimeInput,
} from "#runtime/host-runtime/validation.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

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
    expect(
      validateDurableHostRuntimeContext({
        acceptanceKey: "command-1",
        ownership: "root",
        reference,
      }),
    ).toEqual({ acceptanceKey: "command-1", ownership: "root", reference });

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
    expect(() => validateDurableHostRuntimeContext({ ownership: "root", reference })).toThrowError(
      HostRuntimeError,
    );
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
    expect(() =>
      validateResolvedHostRuntime(
        { ...resolved, modelCallTimeoutMs: 2_147_483_648 },
        { specialist: false },
      ),
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

describe("host runtime preflight", () => {
  function createContext(value = reference): ContextContainer {
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "session-1");
    ctx.set(HostRuntimeContextKey, {
      acceptanceKey: "command-1",
      ownership: "root",
      reference: value,
    });
    return ctx;
  }

  it("shares one validated provider resolution within a step", async () => {
    const session = createRuntimeSession("preflight-single-flight");
    const resolved = {
      instructions: "Use the locked policy.",
      model: createModel(),
      modelCallTimeoutMs: 5_000,
      modelId: "host-model",
    } as const;
    const resolve = vi.fn(async () => resolved);

    await withRuntimeSession(session, async () => {
      registerHostRuntimeProvider({ providerKind: reference.providerKind, resolve });
      const ctx = createContext();
      const [first, second] = await Promise.all([
        prepareHostRuntimePreflight(ctx),
        prepareHostRuntimePreflight(ctx),
      ]);

      expect(first).toStrictEqual(resolved);
      expect(second).toBe(first);
      expect(ctx.get(HostRuntimePreflightKey)).toBe(first);
      expect(resolve).toHaveBeenCalledOnce();
    });
  });

  it("rejects a released reference before provider resolution", async () => {
    const session = createRuntimeSession("preflight-released-reference");
    const resolve = vi.fn(async () => ({ model: createModel(), modelId: "host-model" }));

    await withRuntimeSession(session, async () => {
      registerHostRuntimeProvider({ providerKind: reference.providerKind, resolve });
      const ctx = createContext();
      ctx.set(HostRuntimeContextKey, {
        acceptanceKey: "command-1",
        ownership: "root",
        reference,
        releasedOutcome: "completed",
      });

      await expect(prepareHostRuntimePreflight(ctx)).rejects.toMatchObject({
        code: "HOST_RUNTIME_REFERENCE_INVALID",
      });
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  it("limits delegated specialist authorization to a strictly valid root owner", () => {
    const root = createContext();
    root.setVirtualContext(HostRuntimePreflightKey, {
      delegatedSubagentNames: ["reviewer"],
      model: createModel(),
      modelId: "host-model",
    });
    expect(isTopLevelHostRuntimeRoot(root)).toBe(true);
    expect([...getEffectiveDelegatedSubagentNames(root)]).toEqual(["reviewer"]);

    const nested = createContext();
    nested.set(ParentSessionKey, {
      callId: "call-1",
      rootSessionId: "root-1",
      sessionId: "parent-1",
      turn: { id: "turn-1", sequence: 0 },
    });
    expect(isTopLevelHostRuntimeRoot(nested)).toBe(false);

    const invalid = createContext();
    invalid.set(SubagentDepthKey, Number.NaN);
    expect(() => isTopLevelHostRuntimeRoot(invalid)).toThrow(HostRuntimeError);
  });

  it("resolves the durable reference again in a later step", async () => {
    const session = createRuntimeSession("preflight-multi-step");
    const resolve = vi.fn(async () => ({ model: createModel(), modelId: "host-model" }));

    await withRuntimeSession(session, async () => {
      registerHostRuntimeProvider({ providerKind: reference.providerKind, resolve });
      await prepareHostRuntimePreflight(createContext());
      await prepareHostRuntimePreflight(createContext());
      expect(resolve).toHaveBeenCalledTimes(2);
    });
  });

  it("fails invalid snapshots atomically while preserving transient provider failures", async () => {
    const invalidSession = createRuntimeSession("preflight-invalid");
    await withRuntimeSession(invalidSession, async () => {
      registerHostRuntimeProvider({
        providerKind: reference.providerKind,
        resolve: vi.fn(async () => ({ model: createModel(), modelId: "" })),
      });
      const failure = await prepareHostRuntimePreflight(createContext()).catch((error) => error);
      expect(() => throwHostRuntimeAtStepBoundary(failure)).toThrow(
        expect.objectContaining({ fatal: true, message: "HOST_RUNTIME_RESOLUTION_FAILED" }),
      );
    });

    const transientSession = createRuntimeSession("preflight-transient");
    await withRuntimeSession(transientSession, async () => {
      registerHostRuntimeProvider({
        providerKind: reference.providerKind,
        resolve: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      });
      const failure = await prepareHostRuntimePreflight(createContext()).catch((error) => error);
      expect(() => throwHostRuntimeAtStepBoundary(failure)).toThrow(failure);
    });
  });

  it("exposes only capability-specific helpers to authored resolver context", async () => {
    const session = createRuntimeSession("preflight-helpers");
    const model = createModel();
    await withRuntimeSession(session, async () => {
      registerHostRuntimeProvider({
        providerKind: reference.providerKind,
        resolve: async () => ({ instructions: "Business policy", model, modelId: "host-model" }),
      });
      const ctx = createContext();
      ctx.set(AuthKey, null);
      ctx.set(InitiatorAuthKey, null);
      ctx.set(ChannelKey, { kind: "eve" });
      await prepareHostRuntimePreflight(ctx);
      const turnContext = buildResolveContext(ctx, [], {
        capability: "instructions",
        eventType: "turn.started",
      });
      const turnToolContext = buildResolveContext(ctx, [], {
        capability: "tool",
        eventType: "turn.started",
      });
      const stepContext = buildResolveContext(ctx, [], {
        capability: "model",
        eventType: "step.started",
      });
      const stepToolContext = buildResolveContext(ctx, [], {
        capability: "tool",
        eventType: "step.started",
      });
      const sessionContext = buildResolveContext(ctx, [], {
        capability: "instructions",
        eventType: "session.started",
      });

      expect(hostRuntimeModel(stepContext).model).toBe(model);
      expect(hostRuntimeInstructions(turnContext)).toBe("Business policy");
      expect(hostRuntimeTools(turnToolContext)).toBeUndefined();
      expect(hostRuntimeTools(stepToolContext)).toBeUndefined();
      expect(() => hostRuntimeInstructions(sessionContext)).toThrow(HostRuntimeError);
      expect(() => hostRuntimeInstructions(turnToolContext)).toThrow(HostRuntimeError);
      expect(() => hostRuntimeModel(turnContext)).toThrow(HostRuntimeError);
      expect(Object.keys(turnContext)).toEqual(["session", "channel", "messages"]);
      expect(JSON.stringify(turnContext)).not.toContain(reference.value);
    });
  });
});
