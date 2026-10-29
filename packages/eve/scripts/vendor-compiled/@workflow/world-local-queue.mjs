import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const schedulerPath = fileURLToPath(
  new URL("../../../src/internal/workflow/local-queue-scheduler.ts", import.meta.url),
);
const queueSource = `    const queue = async (queueName, message, opts, recovery = false) => {
        closeSignal.throwIfAborted();
        const cleanup = [];
        if (opts?.idempotencyKey) {
            const existing = inflightMessages.get(opts.idempotencyKey);
            if (existing) {
                return { messageId: existing };
            }
        }
        const body = transport.serialize(message);
        const { prefix } = parseQueueName(queueName);
        const messageId = MessageId.parse(\`msg_\${generateId()}\`);
        // Extract identifiers from the message for structured logging.
        // Combined workflow messages carry \`runId\` and may include \`stepId\`.
        const msg = message;
        const runId = (msg.runId ?? undefined);
        const stepId = (msg.stepId ?? undefined);
        if (opts?.idempotencyKey) {
            const key = opts.idempotencyKey;
            inflightMessages.set(key, messageId);
            cleanup.push(() => {
                inflightMessages.delete(key);
            });
        }
        let delivery = 0;
        let loop = 0;
        scheduler.add({
            recovery,
            run: async () => {
                closeSignal.throwIfAborted();
                if (loop++ >= 256) {
                    console.error(\`[world-local] Queue message exhausted safety limit (256 attempts)\`, { queueName, messageId, runId, stepId });
                    return;
                }
                    const headers = {
                        ...opts?.headers,
                        'content-type': 'application/json',
                        'x-vqs-queue-name': queueName,
                        'x-vqs-message-id': messageId,
                        'x-vqs-message-attempt': String(delivery + 1),
                    };
                    const directHandler = directHandlers.get(prefix);
                    let response;
                    let text;
                    try {
                        if (directHandler) {
                            const req = new Request(createWorkflowUrl(resolveDirectBaseUrl(config), {
                                type: 'flow',
                            }), { method: 'POST', headers, body, signal: closeSignal });
                            response = await directHandler(req);
                        }
                        else {
                            const baseUrl = await resolveBaseUrl(config);
                            const url = createWorkflowUrl(baseUrl, { type: 'flow' });
                            response = nodeHttpAgents
                                ? await nodeHttpFetch(url, {
                                    method: 'POST',
                                    signal: closeSignal,
                                    headers: new Headers(headers),
                                    body,
                                    agents: nodeHttpAgents,
                                    headersTimeoutMs: agentOptions.headersTimeout,
                                    bodyTimeoutMs: agentOptions.bodyTimeout,
                                })
                                : // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici v7 dispatcher types don't match @types/node's RequestInit
                                    await fetch(url, {
                                        method: 'POST',
                                    signal: closeSignal,
                                        duplex: 'half',
                                        dispatcher: httpAgent,
                                        headers,
                                        body,
                                    });
                        }
                        delivery++;
                        text = await response.text();
                    }
                    catch (err) {
                        // A transport can fail before response headers or while consuming
                        // the body. Both are transient — back off and retry the same
                        // durable message rather than leaving its run stalled. Two
                        // failures are not retryable:
                        //  - shutdown: close() aborted the agent / the backoff sleep.
                        //  - a detached-ArrayBuffer proxy misconfig, which never succeeds —
                        //    rethrow so the outer catch surfaces the actionable guidance.
                        const name = err?.name;
                        if (closeSignal.aborted ||
                            name === 'AbortError' ||
                            name === 'ResponseAborted') {
                            return;
                        }
                        if (isDetachedArrayBufferQueueError(err))
                            throw err;
                        console.error(\`[world-local] Queue delivery failed at the transport (loop \${loop}), retrying\`, {
                            queueName,
                            messageId,
                            ...(runId && { runId }),
                            ...(stepId && { stepId }),
                            error: String(err),
                        });
                        return 5000;
                    }
                    if (response.ok) {
                        try {
                            const timeoutSeconds = Number(JSON.parse(text).timeoutSeconds);
                            if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
                                // Clamp to MAX_SAFE_TIMEOUT_MS to avoid Node.js setTimeout overflow warning.
                                // When this fires early, the handler recalculates remaining time from
                                // persistent state and returns another timeoutSeconds if needed.
                                return Math.min(timeoutSeconds * 1000, MAX_SAFE_TIMEOUT_MS);
                            }
                        }
                        catch { }
                        return;
                    }
                    console.error(\`[world-local] Queue message failed (attempt \${delivery}, HTTP \${response.status})\`, {
                        queueName,
                        messageId,
                        ...(runId && { runId }),
                        ...(stepId && { stepId }),
                        handlerError: text,
                    });
                    // 5s linear backoff to approximate VQS retry timing in local dev.
                    // VQS uses 5s linear for attempts 1–32, then exponential, but for
                    // local dev linear 5s is sufficient — the handler enforces the real
                    // cap at MAX_QUEUE_DELIVERIES (48) which keeps total time under ~4min.
                    return 5000;

            },
            fail: (err) => {
            // Silently ignore client disconnect errors (e.g., browser refresh during streaming)
            // These are expected and should not cause unhandled rejection warnings
            const isAbortError = err?.name === 'AbortError' || err?.name === 'ResponseAborted';
            if (!isAbortError) {
                if (isDetachedArrayBufferQueueError(err)) {
                    console.error(\`[local world] Queue operation failed: detected "\${DETACHED_ARRAYBUFFER_ERROR}". \` +
                        "This usually means a Next.js proxy/middleware consumed Workflow's internal " +
                        'request before the executor could read it. Exclude \`/.well-known/workflow/*\` ' +
                        \`from your matcher. See \${PROXY_HANDLER_DOCS_URL}\`, {
                        queueName,
                        messageId,
                        ...(runId && { runId }),
                        ...(stepId && { stepId }),
                        originalError: err,
                    });
                }
                else {
                    console.error('[local world] Queue operation failed:', err);
                }
            }

            },
            finish: () => { for (const fn of cleanup) fn(); },
        }, Math.min(Math.max(0, opts?.delaySeconds ?? 0) * 1000, MAX_SAFE_TIMEOUT_MS));
        return { messageId };
    };
`;

export function patchWorldLocalQueue() {
  return {
    name: "eve:world-local-queue-scheduling",
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/@workflow/world-local/dist/queue.js")) return;
      const start = source.indexOf("    const queue = async (queueName, message, opts) => {");
      const end = source.indexOf("    const HeaderParser =", start);
      if (
        start < 0 ||
        end < 0 ||
        createHash("sha256").update(source.slice(start, end)).digest("hex") !==
          "df33e18fa2a6b13648e176c752b3b167a79fd08b378f4f8e676ec7862e385918"
      ) {
        throw new Error("Unsupported world-local queue source; review the scheduling patch.");
      }
      source = source.slice(0, start) + queueSource + source.slice(end);
      source = source
        .replace("import { Sema } from 'async-sema';", "")
        .replace("import { setTimeout } from 'node:timers/promises';", "");
      source =
        `import { createLocalQueueScheduler, readLocalQueueLimit } from ${JSON.stringify(schedulerPath)};\n` +
        source;
      source = source.replace(
        "const DEFAULT_CONCURRENCY_LIMIT = 1000;",
        "const DEFAULT_CONCURRENCY_LIMIT = 16;",
      );
      source = source.replace(
        "const WORKFLOW_LOCAL_QUEUE_CONCURRENCY = parseInt(process.env.WORKFLOW_LOCAL_QUEUE_CONCURRENCY ?? '0', 10) ||\n    DEFAULT_CONCURRENCY_LIMIT;",
        "const WORKFLOW_LOCAL_QUEUE_CONCURRENCY = readLocalQueueLimit('WORKFLOW_LOCAL_QUEUE_CONCURRENCY', DEFAULT_CONCURRENCY_LIMIT);",
      );
      source = source.replace(
        "    const semaphore = new Sema(WORKFLOW_LOCAL_QUEUE_CONCURRENCY);",
        "",
      );
      source = source.replace(
        "    const closeSignal = closeController.signal;",
        `    const closeSignal = closeController.signal;
    const scheduler = createLocalQueueScheduler({ concurrency: WORKFLOW_LOCAL_QUEUE_CONCURRENCY, recoveryBuffer: readLocalQueueLimit('WORKFLOW_LOCAL_RECOVERY_BUFFER', WORKFLOW_LOCAL_QUEUE_CONCURRENCY), signal: closeSignal });`,
      );
      source = source.replace(
        "        queue,\n",
        `        queue,
        async queueRecovery(queueName, message, opts) {
            return scheduler.admitRecovery(() => queue(queueName, message, opts, true));
        },
        pauseQueue() { scheduler.pause(); },
        resumeQueue() { scheduler.resume(); },
`,
      );
      source = source.replace(
        "            await httpAgent?.close();",
        "            await httpAgent?.close();\n            await scheduler.drain();",
      );
      return { code: source, map: null };
    },
  };
}
