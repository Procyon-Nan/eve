import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Pinned @workflow/core 5.0.0-beta.43 reader fixes, applied before vendoring.
const readerSource = `// Both stream wrappers own the reader until cancellation, including a late connection.
function createWorkflowStreamReader(runId, name) {
    let reader;
    let connection;
    let cleanup = Promise.resolve();
    let stopped = false;
    let cancelReason;

    function release(cancel, reason) {
        const current = reader;
        reader = undefined;
        if (current) {
            cleanup = (async () => {
                try {
                    if (cancel) await current.cancel(reason);
                } finally {
                    current.releaseLock();
                }
            })();
        }
        return cleanup;
    }

    return {
        get reader() { return reader; },
        get stopped() { return stopped; },
        connect(startIndex) {
            connection = (async () => {
                if (stopped) return;
                const world = await getWorldLazy();
                if (stopped) return;
                const started = Date.now();
                const stream = await world.streams.get(runId, name, startIndex);
                const duration = Date.now() - started;
                reader = stream.getReader();
                if (stopped) await release(true, cancelReason);
                return duration;
            })();
            return connection;
        },
        release,
        async cancel(reason) {
            stopped = true;
            cancelReason = reason;
            const currentCleanup = release(true, reason);
            // A failed connection has no reader; a late successful connection cleans itself up.
            await Promise.all([currentCleanup, connection?.catch(() => {})]);
            await cleanup;
        },
    };
}
`;

const bytesSource = `export class WorkflowServerReadableStream extends ReadableStream {
    constructor(runId, name, startIndex) {
        if (typeof name !== 'string' || name.length === 0) {
            throw new WorkflowRuntimeError(\`"name" is required, got "\${name}"\`);
        }
        const source = createWorkflowStreamReader(runId, name);
        let readStart;
        let firstChunkReported = false;
        let connectMs;
        let chunksDelivered = 0;
        let bytesDelivered = 0;
        super({
            type: 'bytes',
            pull: async (controller) => {
                try {
                    if (source.stopped) return;
                    if (!source.reader) {
                        if (readStart === undefined) readStart = Date.now();
                        connectMs = await source.connect(startIndex);
                    }
                    if (source.stopped) return;
                    const result = await source.reader.read();
                    if (source.stopped) return;
                    if (result.done) {
                        await source.release(false);
                        if (source.stopped) return;
                        recordStreamReadComplete(readStart, runId, name, chunksDelivered, bytesDelivered);
                        controller.close();
                        return;
                    }
                    if (!firstChunkReported && result.value.byteLength > 0) {
                        firstChunkReported = true;
                        recordReadTimeToFirstChunk(readStart, runId, name, startIndex, connectMs);
                    }
                    chunksDelivered++;
                    bytesDelivered += result.value.byteLength;
                    controller.enqueue(result.value);
                } catch (error) {
                    if (source.stopped) return;
                    const cleanup = source.cancel(error);
                    controller.error(error);
                    // Keep the read failure as the consumer-visible error.
                    await cleanup.catch(() => {});
                }
            },
            cancel: (reason) => source.cancel(reason),
        });
    }
}`;

const framedSource = `export function createReconnectingFramedStream(runId, name, startIndex) {
    const reconnectSupported = startIndex === undefined || startIndex >= 0;
    const source = createWorkflowStreamReader(runId, name);
    let currentStartIndex = startIndex ?? 0;
    let consumedFrames = 0;
    let reconnectCount = 0;
    let totalReconnectCount = 0;
    let buffer = new Uint8Array(0);
    let readStart;
    let connectMs;
    let firstChunkReported = false;
    let chunksDelivered = 0;
    let bytesDelivered = 0;

    async function connect() {
        const duration = await source.connect(reconnectSupported
            ? currentStartIndex + consumedFrames
            : startIndex);
        if (connectMs === undefined) connectMs = duration;
    }

    async function isVerifiedComplete() {
        try {
            const world = await getWorldLazy();
            if (source.stopped) return true;
            const info = await world.streams.getInfo(runId, name);
            return info.done && currentStartIndex + consumedFrames > info.tailIndex;
        } catch {
            // Preserve upstream's metadata-failure EOF policy.
            return true;
        }
    }

    async function reconnect() {
        await source.release(true).catch(() => {});
        if (source.stopped) return;
        // Only complete frames advance the cursor; replay any partial frame.
        currentStartIndex += consumedFrames;
        consumedFrames = 0;
        buffer = new Uint8Array(0);
        const maxReconnects = getFramedStreamMaxReconnects();
        const maxTotalReconnects = getFramedStreamMaxTotalReconnects();
        while (!source.stopped) {
            reconnectCount++;
            totalReconnectCount++;
            if (reconnectCount > maxReconnects) {
                throw new Error(\`Stream "\${name}" exceeded maximum reconnection attempts (\${maxReconnects})\`);
            }
            if (totalReconnectCount > maxTotalReconnects) {
                throw new Error(\`Stream "\${name}" exceeded maximum total reconnection attempts (\${maxTotalReconnects})\`);
            }
            try {
                await connect();
                return;
            } catch (error) {
                if (source.stopped) return;
                if (StreamExpiredError.is(error)) throw error;
            }
        }
    }

    return new ReadableStream({
        pull: async (controller) => {
            if (readStart === undefined) readStart = Date.now();
            try {
                while (!source.stopped) {
                    if (!source.reader) await connect();
                    if (source.stopped) return;
                    let result;
                    try {
                        result = await source.reader.read();
                    } catch (error) {
                        if (source.stopped) return;
                        if (!reconnectSupported) throw error;
                        await reconnect();
                        continue;
                    }
                    if (source.stopped) return;
                    if (result.done || !result.value) {
                        await source.release(!result.done);
                        if (source.stopped) return;
                        const complete = !reconnectSupported || await isVerifiedComplete();
                        if (source.stopped) return;
                        if (!complete) {
                            await reconnect();
                            continue;
                        }
                        recordStreamReadComplete(readStart, runId, name, chunksDelivered, bytesDelivered, totalReconnectCount);
                        controller.close();
                        return;
                    }
                    const incoming = result.value;
                    if (incoming.length > 0) {
                        const combined = new Uint8Array(buffer.length + incoming.length);
                        combined.set(buffer, 0);
                        combined.set(incoming, buffer.length);
                        buffer = combined;
                    }
                    let emitted = false;
                    while (buffer.length >= FRAME_HEADER_SIZE) {
                        const frameLength = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0, false);
                        const total = FRAME_HEADER_SIZE + frameLength;
                        if (buffer.length < total) break;
                        controller.enqueue(buffer.slice(0, total));
                        buffer = buffer.slice(total);
                        consumedFrames++;
                        chunksDelivered++;
                        bytesDelivered += total;
                        if (!firstChunkReported) {
                            firstChunkReported = true;
                            recordReadTimeToFirstChunk(readStart, runId, name, startIndex, connectMs);
                        }
                        emitted = true;
                    }
                    if (emitted) {
                        reconnectCount = 0;
                        return;
                    }
                }
            } catch (error) {
                if (source.stopped) return;
                const cleanup = source.cancel(error);
                controller.error(error);
                // Keep the connection/read failure as the consumer-visible error.
                await cleanup.catch(() => {});
            }
        },
        cancel: (reason) => source.cancel(reason),
    });
}`;

function replaceReader(source, start, end, expectedHash, replacement) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (
    from < 0 ||
    to < 0 ||
    createHash("sha256").update(source.slice(from, to)).digest("hex") !== expectedHash
  ) {
    throw new Error("Unsupported @workflow/core stream reader source; review the lifecycle patch.");
  }
  return source.slice(0, from) + replacement + source.slice(to);
}

export function patchCoreStreamLifecycle() {
  return {
    name: "eve:workflow-core-stream-lifecycle",
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/@workflow/core/dist/serialization.js")) return;
      const manifest = JSON.parse(readFileSync(join(dirname(id), "../package.json"), "utf8"));
      if (manifest.version !== "5.0.0-beta.43") {
        throw new Error("The stream lifecycle patch requires @workflow/core 5.0.0-beta.43.");
      }
      source = replaceReader(
        source,
        "export class WorkflowServerReadableStream extends ReadableStream {",
        "\n/**\n * Maximum consecutive reconnect attempts",
        "bce8b582cae13e4ad411672c4a8452123774954076ce3d74e699a5b6b9b96cf7",
        readerSource + bytesSource,
      );
      source = replaceReader(
        source,
        "export function createReconnectingFramedStream(runId, name, startIndex) {",
        "\n/**\n * Default group-commit window",
        "aa4e4581745e3bf57925e624a1c641bc8292bf40986c1fa0f739ff0daeb98195",
        framedSource,
      );
      return { code: source, map: null };
    },
  };
}
