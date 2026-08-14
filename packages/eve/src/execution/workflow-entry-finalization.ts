import { FatalError } from "#compiled/@workflow/core/index.js";
import type { TurnCaller } from "#channel/types.js";
import {
  notifyDelegatedParentStep,
  notifyTurnCallerStep,
} from "#execution/delegated-parent-notification.js";
import {
  createDelegatedSubagentErrorResult,
  createDelegatedSubagentSuccessResult,
} from "#execution/delegated-parent-result.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { fireSessionCallbackStep } from "#execution/session-callback-step.js";
import { settleHostRuntimeReleasesStep } from "#execution/settle-host-runtime-releases-step.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import type { TurnDriverAction } from "#execution/turn-control-receiver.js";
import { PENDING_HOST_RUNTIME_RELEASES_STATE_KEY } from "#harness/host-runtime-releases.js";
import {
  HOST_RUNTIME_ERROR_CODES,
  type HostRuntimeErrorCode,
} from "#runtime/host-runtime/errors.js";
import type { HostRuntimeReleaseOutcome } from "#shared/host-runtime.js";
import type { RunMode } from "#shared/run-mode.js";
import type { TokenUsage } from "#shared/token-usage.js";

export async function finalizeExpiredSession(input: {
  readonly caller: TurnCaller | undefined;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly mode: RunMode;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly output: unknown }> {
  const terminatedSessionState = await terminateChildSessionsAndSettleHostRuntime(
    input.sessionState,
  );
  await emitTerminalSessionCompletionStep({
    parentWritable: input.driverWritable,
    serializedContext: input.serializedContext,
  });

  if (input.mode === "task") {
    await fireSessionCallbackStep({
      output: "",
      serializedContext: input.serializedContext,
      status: "completed",
    });
    await notifyDelegatedParentStep({
      result: createDelegatedSubagentSuccessResult(input.serializedContext, ""),
      serializedContext: input.serializedContext,
    });
  } else {
    await notifyTurnCallerStep({
      caller: input.caller,
      lifecycle: "terminal",
      sessionId: terminatedSessionState.sessionId,
      settled: { output: "" },
    });
  }
  return { output: "" };
}

export async function finalizeDone(input: {
  readonly action: NextDriverAction & { readonly kind: "done" };
  readonly caller: TurnCaller | undefined;
  readonly mode: RunMode;
}): Promise<{ readonly output: unknown }> {
  const { output, serializedContext } = input.action;
  const failed = input.action.isError === true;

  await terminateChildSessionsAndSettleHostRuntime(input.action.sessionState);
  if (input.mode === "task") {
    await fireSessionCallbackStep({
      error: failed ? output : undefined,
      output: failed ? undefined : output,
      serializedContext,
      status: failed ? "failed" : "completed",
      usage: failed ? undefined : input.action.usage,
    });
    await notifyDelegatedParentStep({
      result: failed
        ? createDelegatedSubagentErrorResult(serializedContext, output)
        : createDelegatedSubagentSuccessResult(serializedContext, output),
      serializedContext,
      usage: failed ? undefined : input.action.usage,
    });
  } else {
    const settled: {
      isError?: boolean;
      output: unknown;
      usage?: TokenUsage;
    } = { output, usage: input.action.usageDelta };
    if (failed) {
      settled.isError = true;
    }
    await notifyTurnCallerStep({
      caller: input.caller,
      lifecycle: "terminal",
      sessionId: input.action.sessionState.sessionId,
      settled,
    });
  }
  return { output };
}

export function rootTurnReleaseOutcome(
  action: TurnDriverAction,
): HostRuntimeReleaseOutcome | undefined {
  if (action.kind === "done") {
    return action.isError === true ? "failed" : "completed";
  }
  if (action.kind !== "park") return undefined;
  if (action.cancelled === true) return undefined;
  if (action.settled === undefined) return undefined;
  return action.settled.isError === true ? "failed" : "completed";
}

export function ownsSpecialistHostRuntime(serializedContext: Record<string, unknown>): boolean {
  const hostRuntime = serializedContext["eve.hostRuntime"] as
    | { readonly ownership?: unknown }
    | undefined;
  return hostRuntime?.ownership === "specialist";
}

export function ownsRootHostRuntime(serializedContext: Record<string, unknown>): boolean {
  const hostRuntime = serializedContext["eve.hostRuntime"] as
    | { readonly ownership?: unknown }
    | undefined;
  return hostRuntime?.ownership === "root";
}

export function readFatalHostRuntimeErrorCode(error: unknown): HostRuntimeErrorCode | undefined {
  if (!FatalError.is(error)) return undefined;
  return HOST_RUNTIME_ERROR_CODES.find((code) => error.message === code);
}

export function hasPendingHostRuntimeReleases(sessionState: DurableSessionState): boolean {
  const pending = sessionState.snapshot?.session.state?.[PENDING_HOST_RUNTIME_RELEASES_STATE_KEY];
  return Array.isArray(pending) && pending.length > 0;
}

export async function terminateChildSessionsAndSettleHostRuntime(
  sessionState: DurableSessionState,
): Promise<DurableSessionState> {
  const terminated = await terminateChildSessionsStep({ sessionState });
  return hasPendingHostRuntimeReleases(terminated)
    ? await settleHostRuntimeReleasesStep({ sessionState: terminated })
    : terminated;
}
