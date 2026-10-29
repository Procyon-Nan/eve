import { describe, expect, it } from "vitest";

import { transformWorkflowDirectives } from "./workflow-transformer.js";

describe("eve durable step contracts", () => {
  const source = 'export async function createSessionStep() { "use step"; return {}; }';

  it.each(["workflow", "step", "client"] as const)(
    "uses one contract across release numbers in %s mode",
    async (mode) => {
      const ids = [];
      for (const version of ["0.40.0-baigong.3", "0.40.0-baigong.4"]) {
        const filename = "node_modules/eve/dist/src/execution/create-session-step.js";
        const result = await transformWorkflowDirectives({
          filename,
          moduleSpecifier: `eve@${version}`,
          stableModuleSpecifier: "eve",
          source,
          mode,
        });
        ids.push(result.workflowManifest.steps?.[filename]?.createSessionStep?.stepId);
        expect(result.code).toContain('"step//eve-contract-v1//createSessionStep"');
        expect(result.code).not.toContain(`step//eve@${version}`);
      }
      expect(ids).toEqual([
        "step//eve-contract-v1//createSessionStep",
        "step//eve-contract-v1//createSessionStep",
      ]);
    },
  );

  it.each([
    { filename: "src/execution/create-session-step.ts", owner: "another-package" },
    { filename: "src/other/create-session-step.ts", owner: "eve" },
  ])(
    "does not adopt a same-named function from $filename ($owner)",
    async ({ filename, owner }) => {
      const result = await transformWorkflowDirectives({
        filename,
        moduleSpecifier: `${owner}@1.0.0`,
        stableModuleSpecifier: owner,
        source,
        mode: "workflow",
      });
      expect(result.workflowManifest.steps?.[filename]?.createSessionStep?.stepId).toBe(
        `step//${owner}@1.0.0//createSessionStep`,
      );
    },
  );
});
