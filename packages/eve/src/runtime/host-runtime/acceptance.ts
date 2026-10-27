import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import { hostRuntimeAcceptanceHookToken } from "#execution/host-runtime-acceptance-workflow.js";
import {
  hostRuntimeAcceptanceWorkflowReference,
  startWorkflowPreferLatest,
} from "#execution/workflow-runtime.js";
import { getHookByToken, getWorld, resumeHook } from "#internal/workflow/runtime.js";
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
  const deadline = Date.now() + ACCEPTANCE_RECEIPT_TIMEOUT_MS;
  let writeError: unknown;

  try {
    const hook = await getHookByToken(hostRuntimeAcceptanceHookToken(key));
    const durable = await readAcceptanceRunStatus(hook.runId);
    if (durable === status) {
      return;
    }
    if (durable === "ACCEPTED" || durable === "NOT_ACCEPTED") {
      throw new HostRuntimeAcceptanceIndeterminateError();
    }
    if (Date.now() >= deadline) throw new HostRuntimeAcceptanceIndeterminateError();
    await resumeHook(hook, status);
  } catch (error) {
    writeError = error;
  }

  // A failed resume may still have persisted; observe it within the same budget.
  try {
    const recorded = await waitForDurableAcceptanceStatus(key, deadline);
    if (recorded !== status) throw new HostRuntimeAcceptanceIndeterminateError();
  } catch (error) {
    throw new HostRuntimeAcceptanceIndeterminateError({ cause: writeError ?? error });
  }
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
  deadline: number,
): Promise<HostRuntimeAcceptanceStatus> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await queryDurableHostRuntimeAcceptance(acceptanceKey);
    } catch (error) {
      if (!(error instanceof HostRuntimeAcceptanceIndeterminateError)) throw error;
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, remaining)));
    }
  }
  throw new HostRuntimeAcceptanceIndeterminateError({ cause: lastError });
}
