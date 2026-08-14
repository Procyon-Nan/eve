import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

const WORKFLOW_ENTRY_NAME = "workflowEntry";
const TURN_WORKFLOW_NAME = "turnWorkflow";
const SESSION_TIMEOUT_WORKFLOW_NAME = "sessionTimeoutWorkflow";
const HOST_RUNTIME_ACCEPTANCE_WORKFLOW_NAME = "hostRuntimeAcceptanceWorkflow";

export const STABLE_WORKFLOW_NAMES: ReadonlySet<string> = new Set([
  WORKFLOW_ENTRY_NAME,
  TURN_WORKFLOW_NAME,
  SESSION_TIMEOUT_WORKFLOW_NAME,
  HOST_RUNTIME_ACCEPTANCE_WORKFLOW_NAME,
]);

export const workflowEntryReference = {
  workflowId: `workflow//${EVE_PACKAGE_NAME}//${WORKFLOW_ENTRY_NAME}`,
};

export const turnWorkflowReference = {
  workflowId: `workflow//${EVE_PACKAGE_NAME}//${TURN_WORKFLOW_NAME}`,
};

export const sessionTimeoutWorkflowReference = {
  workflowId: `workflow//${EVE_PACKAGE_NAME}//${SESSION_TIMEOUT_WORKFLOW_NAME}`,
};

export const hostRuntimeAcceptanceWorkflowReference = {
  workflowId: `workflow//${EVE_PACKAGE_NAME}//${HOST_RUNTIME_ACCEPTANCE_WORKFLOW_NAME}`,
};
