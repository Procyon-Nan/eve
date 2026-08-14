import { afterEach, describe, expect, it, vi } from "vitest";

import { FatalError, sleep } from "#internal/workflow-bundle/workflow-core-shim.js";

const WORKFLOW_SLEEP = Symbol.for("WORKFLOW_SLEEP");
const workflowGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
const originalSleep = workflowGlobal[WORKFLOW_SLEEP];

afterEach(() => {
  if (originalSleep === undefined) {
    delete workflowGlobal[WORKFLOW_SLEEP];
  } else {
    workflowGlobal[WORKFLOW_SLEEP] = originalSleep;
  }
});

describe("workflow core shim sleep", () => {
  it("forwards durable durations to the workflow VM implementation", async () => {
    const sleepImpl = vi.fn(async () => {});
    workflowGlobal[WORKFLOW_SLEEP] = sleepImpl;

    await expect(sleep(2_500)).resolves.toBeUndefined();
    expect(sleepImpl).toHaveBeenCalledExactlyOnceWith(2_500);
  });

  it("rejects use outside a workflow body", () => {
    delete workflowGlobal[WORKFLOW_SLEEP];

    expect(() => sleep(2_500)).toThrow("`sleep()` can only be called inside a workflow function");
  });
});

describe("workflow core shim FatalError", () => {
  it("matches the workflow errors fatal contract", () => {
    const error = new FatalError("x");

    expect(error.name).toBe("FatalError");
    expect(error.fatal).toBe(true);
    expect(FatalError.is(error)).toBe(true);
    expect(FatalError.is({ message: "x", name: "FatalError" })).toBe(true);
    expect(FatalError.is({ fatal: true, message: "x", name: "OtherError" })).toBe(true);
  });

  it.each([new Error("x"), { message: "x" }, { name: "FatalError" }, null, "FatalError"])(
    "rejects non-fatal values: %o",
    (value) => {
      expect(FatalError.is(value)).toBe(false);
    },
  );
});
