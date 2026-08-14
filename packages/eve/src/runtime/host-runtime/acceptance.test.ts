import { beforeEach, describe, expect, it, vi } from "vitest";

import { startWorkflowPreferLatest } from "#execution/workflow-start.js";
import { getWorld } from "#internal/workflow/runtime.js";
import {
  HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE,
  HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE,
} from "#shared/host-runtime.js";
import {
  HostRuntimeAcceptanceIndeterminateError,
  queryHostRuntimeAcceptance,
  recordHostRuntimeAcceptance,
} from "#runtime/host-runtime/acceptance.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";

vi.mock("#execution/workflow-references.js", () => ({
  hostRuntimeAcceptanceWorkflowReference: { workflowId: "workflow//eve//acceptance" },
}));

vi.mock("#execution/workflow-start.js", () => ({
  startWorkflowPreferLatest: vi.fn(async () => ({ runId: "receipt-run" })),
}));

vi.mock("#internal/workflow/runtime.js", () => ({
  getWorld: vi.fn(),
}));

describe("host runtime acceptance receipts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists a final receipt before publishing the fast-path status", async () => {
    const runtime = createRuntimeSession("acceptance-record");
    await withRuntimeSession(runtime, async () => {
      await recordHostRuntimeAcceptance("command-1", "ACCEPTED");

      expect(startWorkflowPreferLatest).toHaveBeenCalledWith(
        { workflowId: "workflow//eve//acceptance" },
        [{ acceptanceKey: "command-1", status: "ACCEPTED" }],
        expect.objectContaining({
          allowReservedAttributes: true,
          attributes: expect.objectContaining({
            [HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE]: "command-1",
            [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: "ACCEPTED",
          }),
        }),
      );
      await expect(queryHostRuntimeAcceptance("command-1")).resolves.toBe("ACCEPTED");
      expect(getWorld).not.toHaveBeenCalled();
    });
  });

  it("recovers accepted session attributes and rejected marker attributes after cold start", async () => {
    const pages = [
      [
        { attributes: { [HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE]: "accepted" } },
        {
          attributes: {
            [HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE]: "rejected",
            [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: "NOT_ACCEPTED",
          },
        },
      ],
    ];
    vi.mocked(getWorld).mockResolvedValue({
      runs: {
        list: vi.fn(async () => ({ cursor: undefined, data: pages[0], hasMore: false })),
      },
    } as never);

    await withRuntimeSession(createRuntimeSession("cold"), async () => {
      await expect(queryHostRuntimeAcceptance("accepted")).resolves.toBe("ACCEPTED");
      await expect(queryHostRuntimeAcceptance("rejected")).resolves.toBe("NOT_ACCEPTED");
    });
  });

  it("never infers rejection from an absent or conflicting durable receipt", async () => {
    vi.mocked(getWorld).mockResolvedValue({
      runs: {
        list: vi.fn(async () => ({
          cursor: undefined,
          data: [
            {
              attributes: {
                [HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE]: "conflict",
                [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: "ACCEPTED",
              },
            },
            {
              attributes: {
                [HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE]: "conflict",
                [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: "NOT_ACCEPTED",
              },
            },
          ],
          hasMore: false,
        })),
      },
    } as never);

    await withRuntimeSession(createRuntimeSession("indeterminate"), async () => {
      await expect(queryHostRuntimeAcceptance("missing")).rejects.toBeInstanceOf(
        HostRuntimeAcceptanceIndeterminateError,
      );
      await expect(queryHostRuntimeAcceptance("conflict")).rejects.toBeInstanceOf(
        HostRuntimeAcceptanceIndeterminateError,
      );
    });
  });
});
