import { describe, expect, it } from "vitest";

import { createDevelopmentWorkflowWorld } from "#internal/workflow/development-world-client.js";

describe("createDevelopmentWorkflowWorld", () => {
  it("declares the capabilities of the parent-owned local World", () => {
    expect(createDevelopmentWorkflowWorld().capabilities).toEqual({
      hookRetention: { active: true },
      hookResumeDedup: true,
    });
  });
});
