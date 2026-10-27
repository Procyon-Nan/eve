import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { getRun, setWorld } from "#internal/workflow/runtime.js";

const roots: string[] = [];
const worlds: ReturnType<typeof createWorld>[] = [];

async function localWorld() {
  const dataDir = await fs.mkdtemp(join(tmpdir(), "eve-stream-recovery-"));
  roots.push(dataDir);
  const world = createWorld({ dataDir, recoverActiveRuns: false });
  worlds.push(world);
  setWorld(world);
  vi.spyOn(world.runs, "get").mockResolvedValue({
    runId: "wrun_recovery",
    status: "running",
  } as never);
  return world;
}

// The persisted wire format is a big-endian length followed by devl-prefixed devalue JSON.
function frame(value: string): Uint8Array {
  const payload = new TextEncoder().encode(`devl${JSON.stringify([value])}`);
  const bytes = new Uint8Array(payload.length + 4);
  new DataView(bytes.buffer).setUint32(0, payload.length, false);
  bytes.set(payload, 4);
  return bytes;
}

function connection(chunks: Uint8Array[], disconnect = false) {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]!);
        else if (disconnect) controller.error(new Error("transport disconnected"));
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

async function collect<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader();
  const values: T[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return values;
      values.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  setWorld(undefined);
  for (const world of worlds.splice(0)) await world.close?.();
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("compiled Workflow stream recovery", () => {
  it.each([2, 6])("replays a frame cut at byte %s without advancing the cursor", async (cut) => {
    const world = await localWorld();
    const first = connection([frame("first"), frame("second").slice(0, cut)], true);
    const second = connection([frame("second")]);
    const get = vi
      .spyOn(world.streams, "get")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    vi.spyOn(world.streams, "getInfo").mockResolvedValue({ done: true, tailIndex: 1 });
    await expect(collect(getRun("wrun_recovery").getReadable<string>())).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(get.mock.calls.map((call) => call[2])).toEqual([0, 1]);
    expect(first.locked).toBe(false);
    expect(second.locked).toBe(false);
  });

  it("preserves negative-index single-connection behavior", async () => {
    const world = await localWorld();
    const source = connection([frame("last")]);
    const get = vi.spyOn(world.streams, "get").mockResolvedValue(source);
    const info = vi.spyOn(world.streams, "getInfo");
    await expect(
      collect(getRun("wrun_recovery").getReadable<string>({ startIndex: -1 })),
    ).resolves.toEqual(["last"]);
    expect(get.mock.calls.map((call) => call[2])).toEqual([-1]);
    expect(info).not.toHaveBeenCalled();
    expect(source.locked).toBe(false);
  });

  it.each(["raw", "framed-v1"] as const)(
    "hydrates and cancels a returned %s byte stream during connection",
    async (framing) => {
      const world = await localWorld();
      // A real serialized Workflow return value, decoded through Run.returnValue.
      const output = new TextEncoder().encode(
        `devl${JSON.stringify([
          ["ReadableStream", 1],
          { name: 2, type: 3, framing: 4 },
          "byte-output",
          "bytes",
          framing,
        ])}`,
      );
      vi.mocked(world.runs.get).mockResolvedValue({
        runId: "wrun_recovery",
        status: "completed",
        output,
      } as never);
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const cancel = vi.fn();
      const source = new ReadableStream<Uint8Array>({ cancel });
      const get = vi.spyOn(world.streams, "get").mockImplementation(async () => {
        entered.resolve();
        await gate.promise;
        return source;
      });
      const stream = await getRun<ReadableStream<Uint8Array>>("wrun_recovery").returnValue;
      const reader = stream.getReader();
      const pending = reader.read();
      await entered.promise;
      const cancelled = reader.cancel("disconnected");
      gate.resolve();
      await cancelled;
      await expect(pending).resolves.toMatchObject({ done: true });
      reader.releaseLock();
      await vi.waitFor(() => {
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(source.locked).toBe(false);
      });
      expect(get).toHaveBeenCalledTimes(1);
    },
  );
});
