import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import { hostRuntimeAcceptanceHookToken } from "#execution/host-runtime-acceptance-workflow.js";
import {
  hostRuntimeAcceptanceWorkflowReference,
  startWorkflowPreferLatest,
} from "#execution/workflow-runtime.js";
import { getHookByToken, getRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { validateHostRuntimeAcceptanceKey } from "#runtime/host-runtime/validation.js";
import {
  HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE,
  HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE,
  type HostRuntimeAcceptanceStatus,
} from "#shared/host-runtime.js";

export class HostRuntimeAcceptanceIndeterminateError extends Error {
  constructor(options?: ErrorOptions) {
    super("Host runtime acceptance state is temporarily unavailable.", options);
    this.name = "HostRuntimeAcceptanceIndeterminateError";
  }
}

const ACCEPTANCE_HOOK_READY_TIMEOUT_MS = 30_000;
const ACCEPTANCE_RECEIPT_TIMEOUT_MS = 30_000;
type HostRuntimeAcceptanceState = HostRuntimeAcceptanceStatus | "INDETERMINATE";

/**
 * Marks one key as being decided by the current request.
 * A returned state means the key was already observed and must not dispatch again.
 */
export async function beginHostRuntimeAcceptance(
  acceptanceKey: string,
): Promise<HostRuntimeAcceptanceState | undefined> {
  const key = validateHostRuntimeAcceptanceKey(acceptanceKey);
  const token = hostRuntimeAcceptanceHookToken(key);

  try {
    const owner = await getHookByToken(token);
    return await readAcceptanceRunStatus(owner.runId);
  } catch (error) {
    if (!HookNotFoundError.is(error)) {
      if (error instanceof HostRuntimeAcceptanceIndeterminateError) throw error;
      throw new HostRuntimeAcceptanceIndeterminateError({ cause: error });
    }
  }

  try {
    const run = await startWorkflowPreferLatest(
      hostRuntimeAcceptanceWorkflowReference,
      [{ acceptanceKey: key }],
      {
        allowReservedAttributes: true,
        attributes: {
          [HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE]: key,
          [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: "INDETERMINATE",
          "$eve.type": "host-runtime-acceptance",
        },
      },
    );
    const owner = await waitForAcceptanceHook(key);
    if (owner.runId === run.runId) return undefined;

    return await readAcceptanceRunStatus(owner.runId);
  } catch (error) {
    if (error instanceof HostRuntimeAcceptanceIndeterminateError) throw error;
    throw new HostRuntimeAcceptanceIndeterminateError({ cause: error });
  }
}

/** Persists a final receipt before an HTTP path reports a definite decision. */
export async function recordHostRuntimeAcceptance(
  acceptanceKey: string,
  status: HostRuntimeAcceptanceStatus,
): Promise<void> {
  const key = validateHostRuntimeAcceptanceKey(acceptanceKey);

  try {
    const hook = await getHookByToken(hostRuntimeAcceptanceHookToken(key));
    const durable = await readAcceptanceRunStatus(hook.runId);
    if (durable === status) {
      return;
    }
    if (durable === "ACCEPTED" || durable === "NOT_ACCEPTED") {
      throw new HostRuntimeAcceptanceIndeterminateError();
    }
    await resumeHook(hook, status);
    const recorded = await withTimeout(
      getRun<HostRuntimeAcceptanceStatus>(hook.runId).returnValue,
      ACCEPTANCE_RECEIPT_TIMEOUT_MS,
    );
    if (recorded !== status) throw new HostRuntimeAcceptanceIndeterminateError();
  } catch (error) {
    try {
      const recorded = await waitForDurableAcceptanceStatus(key);
      if (recorded === status) {
        return;
      }
    } catch {
      // The original write failure remains indeterminate when no matching receipt is readable.
    }
    throw new HostRuntimeAcceptanceIndeterminateError({ cause: error });
  }
}

/** Records acceptance from the durable session driver after it consumes a command. */
export async function recordHostRuntimeAcceptanceStep(acceptanceKey: string): Promise<void> {
  "use step";

  await recordHostRuntimeAcceptance(acceptanceKey, "ACCEPTED");
}

/** Reads the final decision from the retained durable receipt. */
export async function queryHostRuntimeAcceptance(
  acceptanceKey: string,
): Promise<HostRuntimeAcceptanceStatus> {
  const key = validateHostRuntimeAcceptanceKey(acceptanceKey);

  try {
    return await queryDurableHostRuntimeAcceptance(key);
  } catch (error) {
    if (error instanceof HostRuntimeAcceptanceIndeterminateError) throw error;
    throw new HostRuntimeAcceptanceIndeterminateError({ cause: error });
  }
}

async function waitForAcceptanceHook(acceptanceKey: string): Promise<{ readonly runId: string }> {
  const token = hostRuntimeAcceptanceHookToken(acceptanceKey);
  const deadline = Date.now() + ACCEPTANCE_HOOK_READY_TIMEOUT_MS;
  while (true) {
    try {
      return await getHookByToken(token);
    } catch (error) {
      if (!HookNotFoundError.is(error) || Date.now() >= deadline) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function readAcceptanceRunStatus(runId: string): Promise<HostRuntimeAcceptanceState> {
  try {
    const run = await (await getWorld()).runs.get(runId, { resolveData: "none" });
    const status = run.attributes[HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE];
    return status === "ACCEPTED" || status === "NOT_ACCEPTED" ? status : "INDETERMINATE";
  } catch (error) {
    throw new HostRuntimeAcceptanceIndeterminateError({ cause: error });
  }
}

async function queryDurableHostRuntimeAcceptance(
  acceptanceKey: string,
): Promise<HostRuntimeAcceptanceStatus> {
  const hook = await getHookByToken(hostRuntimeAcceptanceHookToken(acceptanceKey));
  const status = await readAcceptanceRunStatus(hook.runId);
  if (status === "ACCEPTED" || status === "NOT_ACCEPTED") return status;
  throw new HostRuntimeAcceptanceIndeterminateError();
}

async function waitForDurableAcceptanceStatus(
  acceptanceKey: string,
): Promise<HostRuntimeAcceptanceStatus> {
  const deadline = Date.now() + ACCEPTANCE_RECEIPT_TIMEOUT_MS;
  while (true) {
    try {
      return await queryDurableHostRuntimeAcceptance(acceptanceKey);
    } catch (error) {
      if (!(error instanceof HostRuntimeAcceptanceIndeterminateError) || Date.now() >= deadline) {
        throw error;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new HostRuntimeAcceptanceIndeterminateError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
