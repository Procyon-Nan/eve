import {
  createFrameworkSandboxDefinition,
  type RuntimeSandboxRegistry,
} from "#runtime/sandbox/registry.js";

/**
 * Stub registry for tests that exercise harness/execution paths that do
 * not touch the sandbox itself.
 *
 * Production code constructs registries via
 * `createRuntimeSandboxRegistry` from the resolved authored graph;
 * Tests that need an enabled registry but never call into the sandbox use
 * this helper.
 */
export function createStubSandboxRegistry(): RuntimeSandboxRegistry {
  return {
    sandbox: {
      definition: createFrameworkSandboxDefinition(),
      workspaceResourceRoot: {
        logicalPath: "test:stub-sandbox/workspace",
        rootEntries: [],
      },
    },
  };
}
