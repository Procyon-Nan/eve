import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  AuthKey,
  HostRuntimeContextKey,
  HostRuntimePreflightKey,
  InitiatorAuthKey,
  SessionIdKey,
} from "#context/keys.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import { defineHostRuntime } from "#public/definitions/agent.js";
import { HostRuntimeError, isHostRuntimeError } from "#runtime/host-runtime/errors.js";
import {
  getEffectiveDelegatedSubagentNames,
  prepareHostRuntimePreflight,
  prepareHostRuntimePreflightAtStepBoundary,
} from "#runtime/host-runtime/preflight.js";
import { registerHostRuntimeProvider } from "#runtime/host-runtime/provider.js";
import {
  hostRuntimeInstructions,
  hostRuntimeModel,
  hostRuntimeTools,
} from "#runtime/host-runtime/resolve-context.js";
import { withHostRuntime } from "#runtime/host-runtime/trusted-auth.js";
import {
  validateHostRuntimeReference,
  validateResolvedHostRuntime,
} from "#runtime/host-runtime/validation.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { HostRuntimeResolveInput } from "#shared/host-runtime.js";

const reference = { providerKind: "baigong-agent", value: "opaque-reference" } as const;

function createModel(modelId = "host-model"): MockLanguageModelV3 {
  return new MockLanguageModelV3({ modelId, provider: "host" });
}

describe("host runtime public contracts", () => {
  it("validates exact durable references and declarations", () => {
    expect(validateHostRuntimeReference(reference)).toEqual(reference);
    expect(defineHostRuntime({ providerKind: "baigong-agent" })).toEqual({
      kind: "eve.host-runtime",
      providerKind: "baigong-agent",
    });
    expect(() => validateHostRuntimeReference({ ...reference, apiKey: "secret" })).toThrowError(
      HostRuntimeError,
    );
    expect(() => defineHostRuntime({ providerKind: "OpenAI" })).toThrowError(HostRuntimeError);
  });

  it("classifies only branded host runtime errors", () => {
    const owned = new HostRuntimeError("HOST_RUNTIME_VERSION_UNAVAILABLE");
    const sameName = Object.assign(new Error(owned.code), {
      code: owned.code,
      name: owned.name,
    });

    expect(isHostRuntimeError(owned)).toBe(true);
    expect(isHostRuntimeError(sameName)).toBe(false);
  });

  it("rejects malformed resolved capabilities and specialist delegation grants", () => {
    const model = createModel();
    expect(() =>
      validateResolvedHostRuntime(
        { model, modelId: "host-model", modelCallTimeoutMs: 0 },
        {
          specialist: false,
        },
      ),
    ).toThrowError(HostRuntimeError);
    expect(() =>
      validateResolvedHostRuntime(
        { delegatedSubagentNames: ["nested"], model, modelId: "host-model" },
        { specialist: true },
      ),
    ).toThrowError(HostRuntimeError);
  });

  it("keeps the trusted reference non-enumerable and out of JSON", () => {
    const branded = withHostRuntime(
      {
        attributes: { role: "service" },
        authenticator: "jwt",
        principalId: "service-1",
        principalType: "service",
      },
      { acceptanceKey: "command-1", reference },
    );

    expect(Object.keys(branded)).not.toContain("trustedRuntime");
    expect(JSON.stringify(branded)).not.toContain(reference.value);
    expect(branded.attributes).toEqual({ role: "service" });
  });

  it("rejects control characters in trusted acceptance keys", () => {
    expect(() =>
      withHostRuntime(
        {
          attributes: {},
          authenticator: "jwt",
          principalId: "service-1",
          principalType: "service",
        },
        { acceptanceKey: "command-1\nforged", reference },
      ),
    ).toThrowError(HostRuntimeError);
  });
});

describe("host runtime registration and preflight", () => {
  it("isolates providers per RuntimeSession and unregisters only its own entry", async () => {
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

  it("rejects malformed durable lineage before invoking the provider", async () => {
    const runtime = createRuntimeSession("invalid-lineage");
    const resolve = vi.fn(async () => ({ model: createModel(), modelId: "host-model" }));

    await withRuntimeSession(runtime, async () => {
      registerHostRuntimeProvider({ providerKind: reference.providerKind, resolve });
      const ctx = new ContextContainer();
      ctx.set(SessionIdKey, "session-1");
      ctx.set(HostRuntimeContextKey, {
        ownership: "specialist",
        parent: {
          callId: "call-1",
          rootSessionId: "root-1",
          sessionId: "parent-1",
          subagentName: "reviewer",
          turnId: "",
        },
        reference,
      });

      await expect(prepareHostRuntimePreflightAtStepBoundary(ctx)).rejects.toMatchObject({
        fatal: true,
        message: "HOST_RUNTIME_REFERENCE_INVALID",
      });
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  it("resolves one validated snapshot per preflight scope", async () => {
    const runtime = createRuntimeSession("preflight");
    const resolved = {
      delegatedSubagentNames: ["reviewer"],
      instructions: "Use the locked business policy.",
      model: createModel(),
      modelCallTimeoutMs: 30_000,
      modelId: "host-model",
    } as const;
    const resolve = vi.fn(async () => resolved);

    await withRuntimeSession(runtime, async () => {
      registerHostRuntimeProvider({ providerKind: reference.providerKind, resolve });
      const ctx = new ContextContainer();
      ctx.set(SessionIdKey, "session-1");
      ctx.set(HostRuntimeContextKey, { ownership: "root", reference });

      const first = await prepareHostRuntimePreflight(ctx);
      expect(first).toStrictEqual(resolved);
      expect(await prepareHostRuntimePreflight(ctx)).toBe(first);
      expect(resolve).toHaveBeenCalledOnce();
      expect(ctx.get(HostRuntimePreflightKey)).toBe(first);
      expect(getEffectiveDelegatedSubagentNames(ctx)).toEqual(new Set(["reviewer"]));
    });
  });

  it("can resolve a new turn reference after the previous reference failed deterministically", async () => {
    const runtime = createRuntimeSession("next-turn-after-failure");
    const nextReference = { ...reference, value: "next-turn-reference" };
    const resolve = vi.fn(async ({ reference: current }: HostRuntimeResolveInput) => {
      if (current.value === reference.value) {
        throw new HostRuntimeError("HOST_RUNTIME_VERSION_UNAVAILABLE");
      }
      return { model: createModel("next-model"), modelId: "next-model" };
    });

    await withRuntimeSession(runtime, async () => {
      registerHostRuntimeProvider({ providerKind: reference.providerKind, resolve });
      const ctx = new ContextContainer();
      ctx.set(SessionIdKey, "session-1");
      ctx.set(HostRuntimeContextKey, { ownership: "root", reference });

      await expect(prepareHostRuntimePreflight(ctx)).rejects.toMatchObject({
        code: "HOST_RUNTIME_VERSION_UNAVAILABLE",
      });
      ctx.set(HostRuntimeContextKey, { ownership: "root", reference: nextReference });

      await expect(prepareHostRuntimePreflight(ctx)).resolves.toMatchObject({
        modelId: "next-model",
      });
      expect(resolve).toHaveBeenCalledTimes(2);
    });
  });

  it("only converts eve-owned deterministic errors into FatalError", async () => {
    const deterministic = createRuntimeSession("deterministic");
    await withRuntimeSession(deterministic, async () => {
      const ctx = new ContextContainer();
      ctx.set(SessionIdKey, "session-1");
      ctx.set(HostRuntimeContextKey, { ownership: "root", reference });
      await expect(prepareHostRuntimePreflightAtStepBoundary(ctx)).rejects.toMatchObject({
        fatal: true,
        message: "HOST_RUNTIME_PROVIDER_NOT_REGISTERED",
      });
    });

    const transient = new Error("database unavailable");
    const runtime = createRuntimeSession("transient");
    await withRuntimeSession(runtime, async () => {
      registerHostRuntimeProvider({
        providerKind: reference.providerKind,
        resolve: vi.fn(async () => {
          throw transient;
        }),
      });
      const ctx = new ContextContainer();
      ctx.set(SessionIdKey, "session-1");
      ctx.set(HostRuntimeContextKey, { ownership: "root", reference });
      await expect(prepareHostRuntimePreflightAtStepBoundary(ctx)).rejects.toMatchObject({
        message: "Host runtime provider operation failed.",
      });
    });
  });
});

describe("host runtime authored helpers", () => {
  it("exposes scoped capabilities without an enumerable reference", async () => {
    const runtime = createRuntimeSession("helpers");
    const model = createModel();
    await withRuntimeSession(runtime, async () => {
      registerHostRuntimeProvider({
        providerKind: reference.providerKind,
        resolve: async () => ({
          instructions: "Business instructions",
          model,
          modelId: "host-model",
        }),
      });
      const ctx = new ContextContainer();
      ctx.set(SessionIdKey, "session-1");
      ctx.set(AuthKey, null);
      ctx.set(InitiatorAuthKey, null);
      ctx.set(ChannelKey, { kind: "eve" });
      ctx.set(HostRuntimeContextKey, { ownership: "root", reference });
      await prepareHostRuntimePreflight(ctx);
      const authored = buildResolveContext(ctx, []);

      expect(hostRuntimeInstructions(authored)).toBe("Business instructions");
      expect(hostRuntimeModel(authored).model).toBe(model);
      expect(hostRuntimeTools(authored)).toBeUndefined();
      expect(Object.keys(authored)).toEqual(["session", "channel", "messages"]);
      expect(Object.getOwnPropertySymbols(authored)).toEqual([]);
      expect(JSON.stringify(authored)).not.toContain(reference.value);
    });
  });
});
