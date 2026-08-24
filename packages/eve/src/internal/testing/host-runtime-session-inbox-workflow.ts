import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import { recordHostRuntimeAcceptanceStep } from "#execution/record-host-runtime-acceptance-step.js";
import { createSessionCommandInbox } from "#execution/session-command-inbox.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import type { DurableHostRuntimeContext } from "#shared/host-runtime.js";

export async function hostRuntimeSessionInboxWorkflow(): Promise<
  DurableHostRuntimeContext | undefined
> {
  "use workflow";

  const inbox = createSessionCommandInbox();
  try {
    await inbox.claimStable(sessionCommandHookToken(getWorkflowMetadata().workflowRunId));
    const next = await inbox.next();
    inbox.consumeNext();
    if (next.done || next.value.kind !== "deliver") return undefined;
    if (next.value.hostRuntime?.acceptanceKey !== undefined) {
      await recordHostRuntimeAcceptanceStep(next.value.hostRuntime.acceptanceKey);
    }
    return next.value.hostRuntime;
  } finally {
    await inbox.dispose();
  }
}
