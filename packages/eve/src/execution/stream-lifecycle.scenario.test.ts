import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { getRun, setWorld } from "#internal/workflow/runtime.js";

const roots: string[] = [];
const worlds: ReturnType<typeof createWorld>[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function localWorld() {
  const dataDir = await fs.mkdtemp(join(tmpdir(), "eve-stream-repair-"));
  roots.push(dataDir);
  const world = createWorld({ dataDir, recoverActiveRuns: false });
  worlds.push(world);
  return { world, dataDir };
}

afterEach(async () => {
  vi.restoreAllMocks();
  setWorld(undefined);
  for (const world of worlds.splice(0)) await world.close?.();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("compiled local stream lifecycle", () => {
  it.each(["workflow", "world"] as const)(
    "releases %s readers after 20 non-EOF cancellations",
    async (mode) => {
      const { world } = await localWorld();
      setWorld(world);
      const intervals = new Set<ReturnType<typeof setInterval>>();
      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;
      vi.spyOn(globalThis, "setInterval").mockImplementation(((
        ...args: Parameters<typeof setInterval>
      ) => {
        const timer = originalSetInterval(...args);
        intervals.add(timer);
        return timer;
      }) as typeof setInterval);
      vi.spyOn(globalThis, "clearInterval").mockImplementation((timer) => {
        intervals.delete(timer as ReturnType<typeof setInterval>);
        originalClearInterval(timer);
      });
      const subscriptions = vi.spyOn(EventEmitter.prototype, "on");
      const get = vi.spyOn(world.streams, "get");
      const readdir = vi.spyOn(fs, "readdir");
      try {
        for (let index = 0; index < 20; index++) {
          const stream =
            mode === "workflow"
              ? getRun("wrun_audit").getReadable({ namespace: `stream-${index}`, startIndex: 0 })
              : await world.streams.get("wrun_audit", `stream-${index}`, 0);
          const reader = stream.getReader();
          const pending = reader.read();
          try {
            await vi.waitFor(() => {
              expect(get).toHaveBeenCalledTimes(index + 1);
              const name = get.mock.calls[index]![1];
              expect(subscriptions.mock.calls.some(([event]) => event === `close:${name}`)).toBe(
                true,
              );
              expect(intervals.size).toBeGreaterThan(0);
            });
            const name = get.mock.calls[index]![1];
            const registered = subscriptions.mock.calls.findIndex(
              ([event]) => event === `chunk:${name}`,
            );
            const emitter = subscriptions.mock.contexts[registered] as EventEmitter;
            expect(emitter.listenerCount(`chunk:${name}`)).toBe(1);
            expect(emitter.listenerCount(`close:${name}`)).toBe(1);
            await reader.cancel("consumer disconnected");
            await expect(pending).resolves.toMatchObject({ done: true });
            await vi.waitFor(() => expect(intervals.size).toBe(0));
            expect(emitter.listenerCount(`chunk:${name}`)).toBe(0);
            expect(emitter.listenerCount(`close:${name}`)).toBe(0);
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
        }
        const reads = readdir.mock.calls.length;
        await sleep(250);
        expect(readdir).toHaveBeenCalledTimes(reads);
        expect(get).toHaveBeenCalledTimes(20);
        for (const result of get.mock.results) {
          expect((await result.value).locked).toBe(false);
        }
      } finally {
        for (const timer of intervals) originalClearInterval(timer);
      }
    },
  );

  it.each(["initial", "reconnect"] as const)(
    "cleans a late %s connection after cancellation",
    async (phase) => {
      const { world } = await localWorld();
      setWorld(world);
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const rawGet = world.streams.get.bind(world.streams);
      let late: ReadableStream<Uint8Array> | undefined;
      let attempts = 0;
      vi.spyOn(world.streams, "getInfo").mockResolvedValue({ done: false, tailIndex: -1 });
      const get = vi.spyOn(world.streams, "get").mockImplementation(async (...args) => {
        attempts++;
        if (phase === "reconnect" && attempts === 1) {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          });
        }
        entered.resolve();
        await gate.promise;
        late = await rawGet(...args);
        return late;
      });
      const reader = getRun("wrun_audit").getReadable().getReader();
      const pending = reader.read();
      await entered.promise;
      const cancelled = reader.cancel();
      gate.resolve();
      await cancelled;
      await expect(pending).resolves.toMatchObject({ done: true });
      reader.releaseLock();
      await vi.waitFor(() => {
        expect(late).toBeDefined();
        expect(late!.locked).toBe(false);
      });
      const reads = vi.spyOn(fs, "readdir");
      await sleep(250);
      expect(reads).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledTimes(phase === "initial" ? 1 : 2);
    },
  );

  it("does not reconnect after cancellation while EOF metadata is pending", async () => {
    const { world } = await localWorld();
    setWorld(world);
    const entered = Promise.withResolvers<void>();
    const metadata = Promise.withResolvers<{ done: boolean; tailIndex: number }>();
    const get = vi.spyOn(world.streams, "get").mockImplementation(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    );
    vi.spyOn(world.streams, "getInfo").mockImplementation(() => {
      entered.resolve();
      return metadata.promise;
    });
    const reader = getRun("wrun_audit").getReadable().getReader();
    const pending = reader.read();
    await entered.promise;
    const cancellation = reader.cancel();
    metadata.resolve({ done: false, tailIndex: -1 });
    await cancellation;
    await expect(pending).resolves.toMatchObject({ done: true });
    reader.releaseLock();
    await sleep(250);
    expect(get).toHaveBeenCalledTimes(1);
    expect((await get.mock.results[0]!.value).locked).toBe(false);
  });

  it.each([undefined, "EIO", "EACCES"])(
    "handles cross-process polling with read failure %s",
    async (code) => {
      const { world, dataDir } = await localWorld();
      const setInterval = vi.spyOn(globalThis, "setInterval");
      const clearInterval = vi.spyOn(globalThis, "clearInterval");
      const readdir = vi.spyOn(fs, "readdir");
      const reader = (await world.streams.get("wrun_audit", "external-writer", 0)).getReader();
      const first = reader.read().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await vi.waitFor(() => expect(setInterval).toHaveBeenCalled());
        const poller = setInterval.mock.results[0]!.value;
        if (code) {
          const original = fs.readFile.bind(fs);
          vi.spyOn(fs, "readFile").mockImplementation((...args) => {
            if (String(args[0]).endsWith(".bin")) {
              return Promise.reject(
                Object.assign(new Error("injected poll read failure"), { code }),
              );
            }
            return original(...args);
          });
        }
        const compiledWorld = new URL(
          "../../.generated/compiled/@workflow/world-local/index.js",
          import.meta.url,
        ).href;
        await promisify(execFile)(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `
        const { createWorld } = await import(process.argv[1]);
        const world = createWorld({ dataDir: process.argv[2], recoverActiveRuns: false });
        try {
          await world.streams.write('wrun_audit', 'external-writer', 'first');
          await world.streams.write('wrun_audit', 'external-writer', 'second');
          await world.streams.close('wrun_audit', 'external-writer');
        } finally { await world.close(); }
      `,
            compiledWorld,
            dataDir,
          ],
          { timeout: 15_000 },
        );
        const result = await first;
        if (code) {
          expect(result).toMatchObject({ error: { code } });
        } else {
          if (!("value" in result)) throw result.error;
          const values = [new TextDecoder().decode(result.value.value)];
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            values.push(new TextDecoder().decode(next.value));
          }
          expect(values).toEqual(["first", "second"]);
        }
        expect(clearInterval).toHaveBeenCalledWith(poller);
        const scans = readdir.mock.calls.length;
        await sleep(250);
        expect(readdir).toHaveBeenCalledTimes(scans);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  );

  it("delivers concurrent local and external writes once and preserves each writer's order", async () => {
    const { world, dataDir } = await localWorld();
    const reader = (await world.streams.get("wrun_audit", "multi-writer", 0)).getReader();
    const values: string[] = [];
    const reading = (async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        values.push(new TextDecoder().decode(next.value));
      }
    })();
    const compiledWorld = new URL(
      "../../.generated/compiled/@workflow/world-local/index.js",
      import.meta.url,
    ).href;
    const external = promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          const { createWorld } = await import(process.argv[1]);
          const world = createWorld({ dataDir: process.argv[2], recoverActiveRuns: false });
          try {
            await world.streams.write('wrun_audit', 'multi-writer', 'external-0');
            console.log('ready');
            for (let i = 1; i < 20; i++) {
              await world.streams.write('wrun_audit', 'multi-writer', 'external-' + i);
            }
          } finally { await world.close(); }
        `,
        compiledWorld,
        dataDir,
      ],
      { timeout: 15_000 },
    );
    const local = (async () => {
      await new Promise<void>((resolve, reject) => {
        external.child.stdout!.once("data", () => resolve());
        external.then(() => reject(new Error("Writer exited before readiness")), reject);
      });
      for (let i = 0; i < 20; i++) {
        await world.streams.write("wrun_audit", "multi-writer", `local-${i}`);
      }
    })();
    try {
      const writers = await Promise.allSettled([external, local]);
      for (const result of writers) {
        if (result.status === "rejected") throw result.reason;
      }
      await world.streams.close("wrun_audit", "multi-writer");
      await reading;
      expect(values).toHaveLength(40);
      for (const writer of ["local", "external"]) {
        expect(values.filter((value) => value.startsWith(writer))).toEqual(
          Array.from({ length: 20 }, (_, index) => `${writer}-${index}`),
        );
      }
    } finally {
      await reader.cancel().catch(() => {});
      await reading.catch(() => {});
      reader.releaseLock();
    }
  });

  it("delivers persisted chunks in order and reaches real EOF", async () => {
    const { world } = await localWorld();
    await world.streams.write("wrun_audit", "complete", "first");
    await world.streams.write("wrun_audit", "complete", "second");
    await world.streams.close("wrun_audit", "complete");
    const reader = (await world.streams.get("wrun_audit", "complete", 0)).getReader();
    const values: string[] = [];
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        values.push(new TextDecoder().decode(result.value));
      }
      expect(values).toEqual(["first", "second"]);
    } finally {
      reader.releaseLock();
    }
  });

  it("merges live writes with a paused disk read without duplicates or reordering", async () => {
    const { world } = await localWorld();
    await world.streams.write("wrun_audit", "interleaved", "first");
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const original = fs.readFile.bind(fs);
    let held = false;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (!held && String(args[0]).endsWith(".bin")) {
        held = true;
        entered.resolve();
        await gate.promise;
      }
      return original(...args);
    });
    const reader = (await world.streams.get("wrun_audit", "interleaved", 0)).getReader();
    const first = reader.read();
    await entered.promise;
    try {
      await world.streams.write("wrun_audit", "interleaved", "second");
      await world.streams.close("wrun_audit", "interleaved");
      gate.resolve();
      expect(new TextDecoder().decode((await first).value)).toBe("first");
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("second");
      await expect(reader.read()).resolves.toMatchObject({ done: true });
    } finally {
      gate.resolve();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  });

  it.each(["EIO", "EACCES"])("reports %s instead of skipping an unreadable chunk", async (code) => {
    const { world } = await localWorld();
    await world.streams.write("wrun_audit", "broken-stream", "first");
    await world.streams.write("wrun_audit", "broken-stream", "second");
    await world.streams.close("wrun_audit", "broken-stream");
    const original = fs.readFile.bind(fs);
    const failure = Object.assign(new Error("injected read failure"), { code });
    vi.spyOn(fs, "readFile").mockImplementation((...args) => {
      if (String(args[0]).endsWith(".bin")) return Promise.reject(failure);
      return original(...args);
    });
    const reader = (await world.streams.get("wrun_audit", "broken-stream", 0)).getReader();
    try {
      await expect(reader.read()).rejects.toMatchObject({ code });
    } finally {
      reader.releaseLock();
    }
  });

  it.each([100, 1000])(
    "prepares %s legacy hooks once and avoids entity reads on online misses",
    async (count) => {
      const { world, dataDir } = await localWorld();
      await fs.mkdir(join(dataDir, "hooks"), { recursive: true });
      await Promise.all(
        Array.from({ length: count }, (_, index) =>
          fs.writeFile(
            join(dataDir, "hooks", `hook_${index}.json`),
            JSON.stringify({
              runId: "wrun_audit",
              hookId: `hook_${index}`,
              token: `legacy-${index}`,
              createdAt: new Date().toISOString(),
              ownerId: "local-owner",
              projectId: "local-project",
              environment: "local",
              specVersion: 6,
              isWebhook: false,
              isSystem: false,
            }),
          ),
        ),
      );
      await world.start?.();
      await expect(world.hooks.getByToken("legacy-0")).resolves.toMatchObject({ hookId: "hook_0" });
      const reads = vi.spyOn(fs, "readFile");
      for (let index = 0; index < 2; index++) {
        await expect(world.hooks.getByToken("missing-token")).rejects.toMatchObject({
          name: "HookNotFoundError",
        });
      }
      expect(reads.mock.calls.filter(([file]) => /\/hooks\/hook_/.test(String(file)))).toHaveLength(
        0,
      );
    },
  );
});
