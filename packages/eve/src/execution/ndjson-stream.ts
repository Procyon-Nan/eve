/**
 * Transforms a byte stream of newline-delimited JSON (NDJSON) into a
 * stream of parsed values.
 *
 * Opens the source when the parsed stream is created. Cancellation and
 * parsing failures cancel the source before releasing its reader lock:
 * releasing the lock alone would leave a waiting session's file poll alive.
 */
export function parseNdjsonStream<T>(
  createByteStream: () => ReadableStream<Uint8Array>,
): ReadableStream<T> {
  const decoder = new TextDecoder();
  let buffer = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  let sourceCancellation: Promise<void> | undefined;

  function cancelSource(reason: unknown): Promise<void> {
    return (sourceCancellation ??= reader?.cancel(reason) ?? Promise.resolve());
  }

  return new ReadableStream<T>({
    async start(controller) {
      let reachedEof = false;
      try {
        reader = createByteStream().getReader();
        while (true) {
          const { value, done } = await reader.read();

          if (cancelled) return;
          if (done) {
            reachedEof = true;
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          for (
            let newlineIndex = buffer.indexOf("\n");
            newlineIndex !== -1;
            newlineIndex = buffer.indexOf("\n")
          ) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (line.length > 0) {
              controller.enqueue(JSON.parse(line) as T);
            }
          }
        }

        buffer += decoder.decode();
        const trailing = buffer.trim();
        if (trailing.length > 0) {
          controller.enqueue(JSON.parse(trailing) as T);
        }
        controller.close();
      } catch (error) {
        if (!cancelled && !reachedEof && reader) {
          // Cleanup must not replace the parsing/read error.
          await cancelSource(error).catch(() => {});
        }
        if (!cancelled) controller.error(error);
      } finally {
        // A cancelled read can settle before the source's asynchronous cleanup.
        await sourceCancellation?.catch(() => {});
        reader?.releaseLock();
      }
    },
    cancel(reason) {
      cancelled = true;
      return cancelSource(reason);
    },
  });
}
