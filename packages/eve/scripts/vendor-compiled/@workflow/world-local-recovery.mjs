import { fileURLToPath } from "node:url";

const recoveryPath = fileURLToPath(
  new URL("../../../src/internal/workflow/recover-local-runs.ts", import.meta.url),
);

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) {
    throw new Error("Unsupported world-local source; review the startup recovery patch.");
  }
  return source.replace(before, after);
}

export function patchWorldLocalRecovery() {
  return {
    name: "eve:world-local-startup-recovery",
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/@workflow/world-local/dist/index.js")) return;
      source = replaceOnce(
        source,
        "import { reenqueueActiveRuns, SPEC_VERSION_CURRENT } from '@workflow/world';",
        `import { getQueueTopicPrefix, resolveQueueNamespace, SPEC_VERSION_CURRENT } from '@workflow/world';
import { recoverLocalRuns } from ${JSON.stringify(recoveryPath)};
export { resolveRecoverActiveRuns } from "./config.js";`,
      );
      const recoveryStart = source.indexOf(
        "            // Scope recovery to this world's own files.",
      );
      const recoveryEndText =
        "            await reenqueueActiveRuns(recoveryRuns, queue.queue, 'world-local');";
      const recoveryEnd = source.indexOf(recoveryEndText, recoveryStart);
      if (recoveryStart < 0 || recoveryEnd < 0) {
        throw new Error("Unsupported world-local recovery body.");
      }
      const scopedRuns = source.slice(recoveryStart, recoveryEnd);
      source = source.slice(0, recoveryStart) + source.slice(recoveryEnd + recoveryEndText.length);
      source = replaceOnce(
        source,
        "            if (!recoverActiveRuns) {\n                return;\n            }",
        "            initialized = true;\n            if (!mergedConfig.deferRecovery) startRecovery();",
      );
      source = replaceOnce(
        source,
        "    const recoverActiveRuns = resolveRecoverActiveRuns(mergedConfig);",
        `    const recoverActiveRuns = resolveRecoverActiveRuns(mergedConfig);
    const recoveryController = new AbortController();
    let initialized = false;
    let recoveryTask;
    function startRecovery() {
        recoveryController.signal.throwIfAborted();
        if (!initialized) throw new Error('Local world must be initialized before recovery starts.');
        if (!recoverActiveRuns || recoveryTask) return;
        recoveryTask = (async () => {
${scopedRuns}
            const count = await recoverLocalRuns({
                runs: recoveryRuns,
                enqueue: queue.queueRecovery,
                prefix: getQueueTopicPrefix('workflow', resolveQueueNamespace()),
                signal: recoveryController.signal,
            });
            if (count > 0) console.log(\`[world-local] Re-enqueued \${count} active run(s) on startup\`);
        })().catch((error) => {
            if (!recoveryController.signal.aborted) console.error('[world-local] Startup recovery failed:', error);
        });
    }`,
      );
      source = replaceOnce(
        source,
        "        ...queue,",
        "        ...queue,\n        startRecovery,",
      );
      source = replaceOnce(
        source,
        "        async close() {\n            clearStorageCache();\n            await queue.close();\n        },",
        `        async close() {
            recoveryController.abort();
            await queue.close();
            await recoveryTask;
            clearStorageCache();
        },`,
      );
      return { code: source, map: null };
    },
  };
}
