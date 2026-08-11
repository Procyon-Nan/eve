import type { Optional } from "#shared/optional.js";
import type {
  SandboxDefinitionWithBootstrap as SharedSandboxDefinitionWithBootstrap,
  SandboxDefinitionWithoutBootstrap as SharedSandboxDefinitionWithoutBootstrap,
} from "#shared/sandbox-definition.js";

export type {
  SandboxCommandResult,
  SandboxProcess,
  SandboxReadBinaryFileOptions,
  SandboxReadFileOptions,
  SandboxRemovePathOptions,
  SandboxReadTextFileOptions,
  SandboxRunOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxWriteBinaryFileOptions,
  SandboxWriteFileOptions,
  SandboxWriteTextFileOptions,
} from "#shared/sandbox-session.js";
export type {
  SandboxBootstrapUseFn,
  SandboxRevalidationKeyFn,
  SandboxSessionUseFn,
  SandboxBootstrapContext,
  SandboxSessionContext,
} from "#shared/sandbox-definition.js";

/**
 * Stable discriminator carried by {@link DisabledSandboxSentinel}.
 */
const DISABLED_SANDBOX_SENTINEL_KIND = "eve:disabled-sandbox";

/**
 * Marker returned by {@link disableSandbox}. Export it from an agent's
 * `sandbox.ts` module to opt that agent node out of sandbox provisioning.
 */
export interface DisabledSandboxSentinel {
  readonly kind: typeof DISABLED_SANDBOX_SENTINEL_KIND;
}

/**
 * Explicitly disables sandbox provisioning for the agent node that exports
 * this sentinel from `agent/sandbox.ts` (or the corresponding subagent path).
 */
export function disableSandbox(): DisabledSandboxSentinel {
  return { kind: DISABLED_SANDBOX_SENTINEL_KIND };
}

/**
 * Returns whether `value` is the exact sentinel shape produced by
 * {@link disableSandbox}.
 */
export function isDisabledSandboxSentinel(value: unknown): value is DisabledSandboxSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    (value as { readonly kind?: unknown }).kind === DISABLED_SANDBOX_SENTINEL_KIND
  );
}

/**
 * The shape passed to {@link defineSandbox}: a discriminated union over
 * whether a `bootstrap` hook is present. `backend` is optional here (it is
 * required on the shared base): when omitted, eve substitutes
 * `defaultBackend()` at runtime. `BO`/`SO` type the options for the
 * bootstrap-use and session-use functions respectively.
 */
export type SandboxDefinition<BO = Record<string, never>, SO = Record<string, never>> =
  | Optional<SharedSandboxDefinitionWithBootstrap<BO, SO>, "backend">
  | Optional<SharedSandboxDefinitionWithoutBootstrap<BO, SO>, "backend">;

/**
 * Defines the sandbox an agent (or subagent) runs in. Authored at the
 * path-derived location `agent/sandbox.ts` (or `agent/sandbox/sandbox.ts`
 * when paired with a `workspace/` folder); subagents use
 * `subagents/<name>/sandbox.ts`.
 *
 * Returns the definition unchanged: this is an identity helper that only
 * attaches types. `backend` is optional and defaults to `defaultBackend()`
 * at runtime. The `BO`/`SO` generics type the options accepted by the
 * `use()` calls inside `bootstrap` and `onSession` respectively.
 */
export function defineSandbox<BO = Record<string, never>, SO = Record<string, never>>(
  definition: SandboxDefinition<BO, SO>,
): SandboxDefinition<BO, SO> {
  return definition;
}
