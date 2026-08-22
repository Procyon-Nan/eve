import { describe, expect, it } from "vitest";

import { hostRuntimeAcceptanceHookToken } from "#execution/host-runtime-acceptance-workflow.js";
import {
  HostRuntimeAcceptanceIndeterminateError,
  beginHostRuntimeAcceptance,
  queryHostRuntimeAcceptance,
  recordHostRuntimeAcceptance,
} from "#runtime/host-runtime/acceptance.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { getHookByToken } from "#internal/workflow/runtime.js";

describe("host runtime acceptance integration", () => {
  it("allows exactly one durable owner for concurrent reservations", async () => {
    const acceptanceKey = "integration-concurrent-reservation";
    const first = createRuntimeSession("acceptance-first");
    const second = createRuntimeSession("acceptance-second");

    const results = await Promise.all([
      withRuntimeSession(first, async () => await beginHostRuntimeAcceptance(acceptanceKey)),
      withRuntimeSession(second, async () => await beginHostRuntimeAcceptance(acceptanceKey)),
    ]);

    expect(results.filter((status) => status === undefined)).toHaveLength(1);
    expect(results.filter((status) => status === "INDETERMINATE")).toHaveLength(1);

    const owner = (await getHookByToken(hostRuntimeAcceptanceHookToken(acceptanceKey))).runId;
    const ownerSession = results[0] === undefined ? first : second;
    await withRuntimeSession(ownerSession, async () => {
      await recordHostRuntimeAcceptance(acceptanceKey, "ACCEPTED");
    });

    await withRuntimeSession(createRuntimeSession("acceptance-cold"), async () => {
      await expect(queryHostRuntimeAcceptance(acceptanceKey)).resolves.toBe("ACCEPTED");
    });
    expect(owner).toMatch(/^wrun_/);
  });

  it("keeps an undecided durable reservation indeterminate after a cold start", async () => {
    const acceptanceKey = "integration-undecided-reservation";
    await withRuntimeSession(createRuntimeSession("acceptance-owner"), async () => {
      await expect(beginHostRuntimeAcceptance(acceptanceKey)).resolves.toBeUndefined();
    });

    await withRuntimeSession(createRuntimeSession("acceptance-probe"), async () => {
      await expect(queryHostRuntimeAcceptance(acceptanceKey)).rejects.toBeInstanceOf(
        HostRuntimeAcceptanceIndeterminateError,
      );
    });
  });
});
