import { hostRuntimeAcceptanceWorkflowReference } from "#execution/workflow-references.js";
import { startWorkflowPreferLatest } from "#execution/workflow-start.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { getActiveRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { validateHostRuntimeAcceptanceKey } from "#runtime/host-runtime/validation.js";
import {
  HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE,
  HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE,
  type HostRuntimeAcceptanceStatus,
} from "#shared/host-runtime.js";

export { HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE };

export class HostRuntimeAcceptanceIndeterminateError extends Error {
  constructor() {
    super("Host runtime acceptance state is temporarily unavailable.");
    this.name = "HostRuntimeAcceptanceIndeterminateError";
  }
}

export function beginHostRuntimeAcceptance(acceptanceKey: string): void {
  getActiveRuntimeSession().hostRuntimeAcceptance.set(
    validateHostRuntimeAcceptanceKey(acceptanceKey),
    "INDETERMINATE",
  );
}

/** Persists a final receipt before an HTTP path reports a definite decision. */
export async function recordHostRuntimeAcceptance(
  acceptanceKey: string,
  status: HostRuntimeAcceptanceStatus,
): Promise<void> {
  const key = validateHostRuntimeAcceptanceKey(acceptanceKey);
  await startWorkflowPreferLatest(
    hostRuntimeAcceptanceWorkflowReference,
    [{ acceptanceKey: key, status }],
    {
      allowReservedAttributes: true,
      attributes: {
        [HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE]: key,
        [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: status,
        "$eve.type": "host-runtime-acceptance",
      },
    },
  );
  getActiveRuntimeSession().hostRuntimeAcceptance.set(key, status);
}

/** Queries the process receipt first, then durable Workflow attributes after cold start. */
export async function queryHostRuntimeAcceptance(
  acceptanceKey: string,
): Promise<HostRuntimeAcceptanceStatus> {
  const key = validateHostRuntimeAcceptanceKey(acceptanceKey);
  const session = getActiveRuntimeSession();
  const fast = session.hostRuntimeAcceptance.get(key);
  if (fast === "ACCEPTED" || fast === "NOT_ACCEPTED") return fast;

  const world = await getWorld();
  let cursor: string | undefined;
  const durableStatuses = new Set<HostRuntimeAcceptanceStatus>();
  do {
    const page = await world.runs.list({
      pagination: { cursor, limit: 1_000 },
      resolveData: "none",
    });
    for (const run of page.data) {
      if (run.attributes[HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE] !== key) continue;
      const status = run.attributes[HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE];
      if (status === "ACCEPTED" || status === "NOT_ACCEPTED") {
        durableStatuses.add(status);
      } else {
        // Session/turn attributes are themselves durable proof of acceptance.
        durableStatuses.add("ACCEPTED");
      }
    }
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor !== undefined);

  if (durableStatuses.size === 1) {
    const status = [...durableStatuses][0];
    if (status !== undefined) {
      session.hostRuntimeAcceptance.set(key, status);
      return status;
    }
  }

  // Absence or conflicting receipts cannot prove a final ownership decision.
  throw new HostRuntimeAcceptanceIndeterminateError();
}
