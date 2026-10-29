import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalQueueScheduler } from "./local-queue-scheduler.js";

afterEach(() => vi.useRealTimers());

describe("local queue delivery scheduling", () => {
  it("releases a delivery slot while a durable workflow waits", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const scheduler = createLocalQueueScheduler({
      concurrency: 1,
      recoveryBuffer: 1,
      signal: controller.signal,
    });
    const recovery = vi
      .fn<() => Promise<number | undefined>>()
      .mockResolvedValueOnce(60_000)
      .mockResolvedValue(undefined);
    const normal = vi.fn(async () => undefined);
    const finish = vi.fn();
    const fail = vi.fn();
    scheduler.add({ recovery: true, run: recovery, finish, fail }, 0);
    scheduler.add({ recovery: false, run: normal, finish, fail }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(normal).toHaveBeenCalledTimes(1);
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recovery).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(fail).not.toHaveBeenCalled();
    controller.abort();
    await scheduler.drain();
  });

  it("bounds ready recovery admission and cancels a blocked producer on close", async () => {
    const controller = new AbortController();
    const scheduler = createLocalQueueScheduler({
      concurrency: 2,
      recoveryBuffer: 1,
      signal: controller.signal,
    });
    scheduler.pause();
    const run = vi.fn(async () => undefined);
    const finish = vi.fn();
    const fail = vi.fn();
    await scheduler.admitRecovery(() => scheduler.add({ recovery: true, run, finish, fail }, 0));
    const enqueue = vi.fn(() => scheduler.add({ recovery: true, run, finish, fail }, 0));
    const blocked = scheduler.admitRecovery(enqueue);
    await Promise.resolve();
    expect(enqueue).not.toHaveBeenCalled();
    controller.abort();
    await expect(blocked).rejects.toMatchObject({ name: "AbortError" });
    await scheduler.drain();
    expect(run).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledTimes(1);
  });
});
