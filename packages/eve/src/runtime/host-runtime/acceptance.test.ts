import { beforeEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import { startWorkflowPreferLatest } from "#execution/workflow-runtime.js";
import { getHookByToken, getRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import {
  HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE,
  HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE,
} from "#shared/host-runtime.js";
import {
  HostRuntimeAcceptanceIndeterminateError,
  beginHostRuntimeAcceptance,
  queryHostRuntimeAcceptance,
  recordHostRuntimeAcceptance,
} from "#runtime/host-runtime/acceptance.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";

vi.mock("#execution/workflow-runtime.js", () => ({
  hostRuntimeAcceptanceWorkflowReference: {
    workflowId: "workflow//eve//hostRuntimeAcceptanceWorkflow",
  },
  startWorkflowPreferLatest: vi.fn(async () => ({ runId: "receipt-run" })),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getHookByToken: vi.fn(async () => ({
    runId: "receipt-run",
    token: "eve:host-runtime-acceptance:command-1",
  })),
  getRun: vi.fn(() => ({ returnValue: Promise.resolve("ACCEPTED") })),
  getWorld: vi.fn(),
  resumeHook: vi.fn(async () => ({ runId: "receipt-run" })),
}));

describe("host runtime acceptance receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorld).mockResolvedValue({
      runs: {
        get: vi.fn(async () => ({
          attributes: { [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: "INDETERMINATE" },
        })),
      },
    } as never);
  });

  it("reserves a key once and persists a final receipt before publishing it", async () => {
    vi.mocked(getHookByToken).mockRejectedValueOnce(new HookNotFoundError("command-1"));
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        attributes: { [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: "INDETERMINATE" },
      })
      .mockResolvedValue({
        attributes: { [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: "ACCEPTED" },
      });
    vi.mocked(getWorld).mockResolvedValue({ runs: { get } } as never);

    await withRuntimeSession(createRuntimeSession("acceptance-record"), async () => {
      await expect(beginHostRuntimeAcceptance("command-1")).resolves.toBeUndefined();

      await recordHostRuntimeAcceptance("command-1", "ACCEPTED");

      expect(startWorkflowPreferLatest).toHaveBeenCalledWith(
        { workflowId: "workflow//eve//hostRuntimeAcceptanceWorkflow" },
        [{ acceptanceKey: "command-1" }],
        expect.objectContaining({
          allowReservedAttributes: true,
          attributes: expect.objectContaining({
            [HOST_RUNTIME_ACCEPTANCE_ATTRIBUTE]: "command-1",
            [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: "INDETERMINATE",
          }),
        }),
      );
      expect(resumeHook).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "receipt-run" }),
        "ACCEPTED",
      );
      expect(getRun).toHaveBeenCalledWith("receipt-run");
      await expect(queryHostRuntimeAcceptance("command-1")).resolves.toBe("ACCEPTED");
      expect(getWorld).toHaveBeenCalledTimes(2);
    });
  });

  it("rejects a cross-process duplicate after the durable hook owner wins", async () => {
    vi.mocked(getHookByToken).mockResolvedValueOnce({ runId: "owner-run" } as never);
    vi.mocked(getWorld).mockResolvedValueOnce({
      runs: {
        get: vi.fn(async () => ({
          attributes: { [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: "ACCEPTED" },
        })),
      },
    } as never);

    await withRuntimeSession(createRuntimeSession("duplicate"), async () => {
      await expect(beginHostRuntimeAcceptance("duplicate-key")).resolves.toBe("ACCEPTED");
    });
    expect(startWorkflowPreferLatest).not.toHaveBeenCalled();
  });

  it.each(["ACCEPTED", "NOT_ACCEPTED"] as const)(
    "recovers an explicit %s receipt after cold start",
    async (status) => {
      vi.mocked(getWorld).mockResolvedValue({
        runs: {
          get: vi.fn(async () => ({
            attributes: { [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: status },
          })),
        },
      } as never);

      await withRuntimeSession(createRuntimeSession(`cold-${status}`), async () => {
        await expect(queryHostRuntimeAcceptance(`cold-${status}`)).resolves.toBe(status);
      });
    },
  );

  it("keeps an undecided receipt indeterminate after cold start", async () => {
    vi.mocked(getWorld).mockResolvedValue({
      runs: {
        get: vi.fn(async () => ({
          attributes: { [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: "INDETERMINATE" },
        })),
      },
    } as never);

    await withRuntimeSession(createRuntimeSession("unclaimed"), async () => {
      await expect(queryHostRuntimeAcceptance("unclaimed")).rejects.toBeInstanceOf(
        HostRuntimeAcceptanceIndeterminateError,
      );
    });
  });

  it("makes accepted recording replay-safe after the durable receipt is final", async () => {
    vi.mocked(getWorld).mockResolvedValue({
      runs: {
        get: vi.fn(async () => ({
          attributes: { [HOST_RUNTIME_ACCEPTANCE_STATUS_ATTRIBUTE]: "ACCEPTED" },
        })),
      },
    } as never);

    await withRuntimeSession(createRuntimeSession("replayed-step"), async () => {
      await expect(
        recordHostRuntimeAcceptance("replayed-step", "ACCEPTED"),
      ).resolves.toBeUndefined();
    });
    expect(resumeHook).not.toHaveBeenCalled();
  });

  it("never infers rejection from an unreadable durable receipt", async () => {
    vi.mocked(getWorld).mockRejectedValue(new Error("durable store unavailable"));

    await withRuntimeSession(createRuntimeSession("indeterminate"), async () => {
      await expect(queryHostRuntimeAcceptance("missing")).rejects.toBeInstanceOf(
        HostRuntimeAcceptanceIndeterminateError,
      );
    });
  });
});
