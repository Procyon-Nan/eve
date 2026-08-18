import { describe, expect, it, vi } from "vitest";

import type { RouteHandlerArgs } from "#channel/routes.js";
import { createSession } from "#channel/session.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { getWorld, start } from "#internal/workflow/runtime.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { Client } from "#client/client.js";
import { none } from "#public/channels/auth.js";
import { eveChannel } from "#public/channels/eve.js";
import type { MessageStreamEvent } from "#protocol/message.js";

const SNAPSHOT_COUNT = 20;
const OPERATION_TIMEOUT_MS = 2_000;

describe("ClientSession finite snapshot lifecycle", () => {
  it("repeats full parked-session snapshots, cancels a replay, and continues the session", async () => {
    const testRuntime = createTestRuntime({ agent: { name: "session-snapshot-lifecycle" } });

    await testRuntime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "first turn" },
          serializedContext: {
            "eve.auth": null,
            "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
            "eve.channel": { kind: "http", state: {} },
            "eve.continuationToken": "http:session-snapshot-lifecycle",
            "eve.mode": "conversation",
          },
        },
      ]);
      const workflowEvents = captureTurnEvents(run);
      let streamReads: ReturnType<typeof trackWorldStreamReads> | undefined;

      try {
        const firstTurn = await workflowEvents.nextTurn();
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");

        const runtime = createWorkflowRuntime({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        });
        streamReads = trackWorldStreamReads(await getWorld());
        const fetchRoute = createEveSessionRouteFetch(runtime);
        const finiteResponse = await fetchRoute(
          new Request(
            `https://eve.test/eve/v1/session/${encodeURIComponent(run.runId)}/stream?includeTailIndex=1`,
          ),
        );
        const finiteEvents = await readResponseEvents(finiteResponse, "finite route response");
        expect(finiteEvents.map((event) => event.meta.id)).toEqual(
          firstTurn.map((event) => event.meta.id),
        );
        streamReads.expectReleased("finite route response");

        vi.stubGlobal("fetch", fetchRoute);

        const session = new Client({ host: "https://eve.test" }).sessions.attach(run.runId);
        const snapshots = [];
        for (let index = 0; index < SNAPSHOT_COUNT; index += 1) {
          snapshots.push(
            await withTimeout(session.snapshot(), `finite snapshot ${String(index + 1)}`),
          );
          streamReads.expectReleased(`finite snapshot ${String(index + 1)}`);
        }

        const expectedIds = firstTurn.map((event) => event.meta.id);
        for (const snapshot of snapshots) {
          expect(snapshot.events.map((event) => event.meta.id)).toEqual(expectedIds);
          expect(snapshot.session).toEqual({
            sessionId: run.runId,
            streamIndex: firstTurn.length,
          });
        }

        const replayed: MessageStreamEvent[] = [];
        for await (const event of session.stream({ startIndex: 0 })) {
          replayed.push(event);
          if (event.type === "session.waiting") break;
        }
        expect(replayed.map((event) => event.meta.id)).toEqual(expectedIds);
        streamReads.expectReleased("cancelled replay stream");

        const afterReplay = await withTimeout(
          session.snapshot(),
          "finite snapshot after replay cancellation",
        );
        expect(afterReplay.events.map((event) => event.meta.id)).toEqual(expectedIds);
        streamReads.expectReleased("snapshot after replay cancellation");

        const response = await session.send("second turn");
        const secondTurn = await withTimeout(response.result(), "second turn after snapshots");
        expect(secondTurn.events.at(-1)?.type).toBe("session.waiting");
        expect(secondTurn.events.some((event) => event.type === "session.failed")).toBe(false);
        streamReads.expectReleased("second turn stream");

        const finalSnapshot = await withTimeout(session.snapshot(), "snapshot after second turn");
        const allIds = [...expectedIds, ...secondTurn.events.map((event) => event.meta.id)];
        expect(finalSnapshot.events.map((event) => event.meta.id)).toEqual(allIds);
        expect(new Set(allIds).size).toBe(allIds.length);
        streamReads.expectReleased("snapshot after second turn");
        expect(streamReads.createdCount).toBeGreaterThanOrEqual(SNAPSHOT_COUNT + 5);
      } finally {
        vi.unstubAllGlobals();
        streamReads?.restore();
        workflowEvents.dispose();
        const status = await run.status;
        if (status === "pending" || status === "running") await run.cancel();
      }
    });
  }, 180_000);
});

function createEveSessionRouteFetch(
  runtime: ReturnType<typeof createWorkflowRuntime>,
): typeof fetch {
  const channel = eveChannel({ auth: none() });
  const streamRoute = channel.routes.find(
    (route) => route.method === "GET" && route.path === "/eve/v1/session/:sessionId/stream",
  );
  const sendRoute = channel.routes.find(
    (route) => route.method === "POST" && route.path === "/eve/v1/session/:sessionId",
  );
  if (streamRoute === undefined || sendRoute === undefined) {
    throw new Error("Expected eve session stream and continuation routes.");
  }

  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const match = /^\/eve\/v1\/session\/([^/]+)(\/stream)?$/.exec(url.pathname);
    if (match === null)
      throw new Error(`Unexpected test request: ${request.method} ${url.pathname}`);
    const sessionId = decodeURIComponent(match[1]!);
    const args = {
      ...mockChannelContext(() => {
        throw new Error("session route must not send through a channel address");
      }),
      attachSession: (id: string) => createSession(id, runtime),
      params: { sessionId },
      requestIp: "127.0.0.1",
      to: () => {
        throw new Error("session route must not send to another channel");
      },
      waitUntil: () => undefined,
    } satisfies RouteHandlerArgs;

    if (request.method === "GET" && match[2] === "/stream") {
      const response = await streamRoute.handler(request, args);
      if (!(response instanceof Response)) throw new Error("Expected an HTTP stream response.");
      return response;
    }
    if (request.method === "POST" && match[2] === undefined) {
      const response = await sendRoute.handler(request, args);
      if (!(response instanceof Response)) throw new Error("Expected an HTTP send response.");
      return response;
    }
    throw new Error(`Unexpected test request: ${request.method} ${url.pathname}`);
  };
}

function trackWorldStreamReads(world: Awaited<ReturnType<typeof getWorld>>): {
  readonly createdCount: number;
  expectReleased(label: string): void;
  restore(): void;
} {
  const originalGet = world.streams.get.bind(world.streams);
  let activeCount = 0;
  let createdCount = 0;
  const getSpy = vi
    .spyOn(world.streams, "get")
    .mockImplementation(async (runId, name, startIndex) => {
      const source = await originalGet(runId, name, startIndex);
      const reader = source.getReader();
      let released = false;
      activeCount += 1;
      createdCount += 1;

      const release = () => {
        if (released) return;
        released = true;
        activeCount -= 1;
        reader.releaseLock();
      };

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              release();
              controller.close();
            } else {
              controller.enqueue(result.value);
            }
          } catch (error) {
            release();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            release();
          }
        },
      });
    });

  return {
    get createdCount() {
      return createdCount;
    },
    expectReleased(label) {
      if (activeCount !== 0) {
        throw new Error(`${label} left ${String(activeCount)} world stream reader(s) active.`);
      }
    },
    restore() {
      getSpy.mockRestore();
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          OPERATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function readResponseEvents(
  response: Response,
  label: string,
): Promise<MessageStreamEvent[]> {
  if (response.body === null) throw new Error(`${label} did not return a body.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Timed out waiting for ${label}.`)),
            OPERATION_TIMEOUT_MS,
          );
        }),
      ]);
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MessageStreamEvent);
}
