import {
  start,
  type Run,
  type StartOptionsWithoutDeploymentId,
  type WorkflowFunction,
  type WorkflowMetadata,
} from "#internal/workflow/runtime.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";

export const LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE =
  "deploymentId 'latest' requires a World that implements resolveLatestDeploymentId()";

/**
 * Starts a workflow on the latest deployment when latest routing applies,
 * while preserving local/dev worlds that do not implement latest routing.
 */
export async function startWorkflowPreferLatest<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  options?: StartOptionsWithoutDeploymentId,
): Promise<Run<unknown> | Run<TResult>> {
  if (!shouldRouteToLatestDeployment()) {
    return options === undefined
      ? await start(workflow, args)
      : await start(workflow, args, options);
  }

  try {
    return await start(workflow, args, { ...options, deploymentId: "latest" });
  } catch (error) {
    if (!isLatestDeploymentUnsupportedError(error)) {
      throw error;
    }

    return options === undefined
      ? await start(workflow, args)
      : await start(workflow, args, options);
  }
}

/**
 * Local development resolves "latest" to the active promoted generation.
 * Vercel resolves it only for production deployments; previews and CLI
 * deployments have no branch reference and remain pinned to themselves.
 */
function shouldRouteToLatestDeployment(): boolean {
  return process.env.VERCEL_ENV === "production" || isEveDevEnvironment();
}

function isLatestDeploymentUnsupportedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(LATEST_DEPLOYMENT_UNSUPPORTED_MESSAGE);
}
