import { createHash } from "node:crypto";

// Pinned @workflow/world-local 5.0.0-beta.37 reader fix, applied before vendoring.
const streamGetSource = `            async get(_runId, name, startIndex = 0) {
                const chunksBaseDir = path.join(basedir, 'streams', 'chunks');
                let streamClosed = false;
                let pollInterval;
                let teardown = () => {};
                return new ReadableStream({
                    async start(controller) {
                        const deliveredChunkIds = new Set();
                        const bufferedEventChunks = new Map();
                        let isReadingFromDisk = true;
                        let pendingClose = false;

                        function finish() {
                            if (streamClosed) return;
                            streamClosed = true;
                            teardown();
                            controller.close();
                        }

                        function fail(error) {
                            if (streamClosed) return;
                            streamClosed = true;
                            teardown();
                            controller.error(error);
                        }

                        function deliver(chunkId, chunkData) {
                            if (streamClosed || deliveredChunkIds.has(chunkId)) return;
                            if (chunkData.byteLength > 0) {
                                controller.enqueue(Uint8Array.from(chunkData));
                            }
                            // A failed read/enqueue must never advance the delivery cursor.
                            deliveredChunkIds.add(chunkId);
                        }

                        function flushBufferedEvents() {
                            for (const chunkId of [...bufferedEventChunks.keys()].sort()) {
                                deliver(chunkId, bufferedEventChunks.get(chunkId));
                            }
                            bufferedEventChunks.clear();
                        }

                        const chunkListener = (event) => {
                            if (streamClosed || deliveredChunkIds.has(event.chunkId)) return;
                            try {
                                if (isReadingFromDisk) {
                                    bufferedEventChunks.set(event.chunkId, Uint8Array.from(event.chunkData));
                                } else {
                                    deliver(event.chunkId, event.chunkData);
                                }
                            } catch (error) {
                                fail(error);
                            }
                        };
                        const closeListener = () => {
                            if (streamClosed) return;
                            if (isReadingFromDisk) pendingClose = true;
                            else finish();
                        };
                        teardown = () => {
                            streamEmitter.off(\`chunk:\${name}\`, chunkListener);
                            streamEmitter.off(\`close:\${name}\`, closeListener);
                            if (pollInterval !== undefined) {
                                clearInterval(pollInterval);
                                pollInterval = undefined;
                            }
                            bufferedEventChunks.clear();
                        };

                        async function readChunks(files, extMap, dir) {
                            for (const chunkId of files) {
                                if (streamClosed) return false;
                                if (deliveredChunkIds.has(chunkId)) continue;
                                const ext = extMap.get(chunkId) ?? '.bin';
                                const chunk = deserializeChunk(await readBuffer(path.join(dir, \`\${chunkId}\${ext}\`)));
                                if (streamClosed) return false;
                                if (chunk.eof) return true;
                                deliver(chunkId, chunk.chunk);
                            }
                            return false;
                        }

                        async function poll() {
                            if (streamClosed || isReadingFromDisk) return;
                            isReadingFromDisk = true;
                            try {
                                const { files, extMap, dir } = await listChunkFilesForStream(chunksBaseDir, name, tag);
                                if (streamClosed) return;
                                const complete = await readChunks(files, extMap, dir);
                                if (streamClosed) return;
                                flushBufferedEvents();
                                if (complete || pendingClose) finish();
                            } catch (error) {
                                fail(error);
                            } finally {
                                isReadingFromDisk = false;
                            }
                        }

                        // Subscribe before listing so writes during initialization are retained.
                        streamEmitter.on(\`chunk:\${name}\`, chunkListener);
                        streamEmitter.on(\`close:\${name}\`, closeListener);
                        try {
                            const { files, extMap, dir } = await listChunkFilesForStream(chunksBaseDir, name, tag);
                            if (streamClosed) return;
                            let dataChunkCount = files.length;
                            if (startIndex < 0 && files.length > 0) {
                                const lastFile = files[files.length - 1];
                                const lastExt = extMap.get(lastFile) ?? '.bin';
                                const firstByte = await readFirstByte(path.join(dir, \`\${lastFile}\${lastExt}\`));
                                if (streamClosed) return;
                                if (isEofByte(firstByte)) dataChunkCount--;
                            }
                            const resolvedStartIndex = startIndex < 0
                                ? Math.max(0, dataChunkCount + startIndex)
                                : startIndex;
                            // Excluded history must also be excluded from concurrent event delivery.
                            for (let i = 0; i < resolvedStartIndex && i < files.length; i++) {
                                deliveredChunkIds.add(files[i]);
                            }
                            const complete = await readChunks(files.slice(resolvedStartIndex), extMap, dir);
                            if (streamClosed) return;
                            flushBufferedEvents();
                            if (complete || pendingClose) {
                                finish();
                                return;
                            }
                            isReadingFromDisk = false;
                            pollInterval = setInterval(poll, 100);
                        } catch (error) {
                            fail(error);
                        }
                    },
                    cancel() {
                        streamClosed = true;
                        teardown();
                    },
                });
            },`;

export function patchWorldLocalStreamLifecycle(version) {
  return {
    name: "eve:workflow-world-local-stream-lifecycle",
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/@workflow/world-local/dist/streamer.js")) return;
      if (version !== "5.0.0-beta.37") {
        throw new Error("The stream lifecycle patch requires @workflow/world-local 5.0.0-beta.37.");
      }
      const from = source.indexOf("            async get(_runId, name, startIndex = 0) {");
      const to = source.indexOf("\n        },\n    };\n}", from);
      if (
        from < 0 ||
        to < 0 ||
        createHash("sha256").update(source.slice(from, to)).digest("hex") !==
          "fec91c1b3c135dd81800ce17b1b9587b7ac0cfec4f7d25c558f874fdd6b7079c"
      ) {
        throw new Error(
          "Unsupported @workflow/world-local stream reader source; review the lifecycle patch.",
        );
      }
      return { code: source.slice(0, from) + streamGetSource + source.slice(to), map: null };
    },
  };
}
