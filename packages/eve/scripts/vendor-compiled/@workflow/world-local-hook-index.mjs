// Pinned @workflow/world-local 5.0.0-beta.37 hook-index repair.
const preparationSource = `const preparedHookClaims = new Map();

export function resetHookTokenClaimsCache() {
    preparedHookClaims.clear();
}

export async function ensureHookTokenClaims(basedir, tag) {
    const key = JSON.stringify([path.resolve(basedir), tag ?? null]);
    let pending = preparedHookClaims.get(key);
    if (!pending) {
        pending = prepareHookTokenClaims(basedir, tag).catch((error) => {
            preparedHookClaims.delete(key);
            throw error;
        });
        preparedHookClaims.set(key, pending);
    }
    return pending;
}

async function isHookAvailable(basedir, hook, tag) {
    if (await isHookDisposalCommitted(basedir, hook.hookId, tag)) return false;
    if (hook.tokenRetentionUntil && hook.tokenRetentionUntil.getTime() > Date.now()) return true;
    return !(await isTerminalRunCache(basedir, hook.runId, tag));
}

async function prepareHookTokenClaims(basedir, tag) {
    await ensureHookIndexes(basedir);
    const files = await listJSONFiles(path.join(basedir, 'hooks'));
    const hookIds = new Set(files.filter((file) => isVisibleToTag(file, tag)).map(stripTag));
    for (const hookId of hookIds) {
        const hook = await readJSONWithFallback(basedir, 'hooks', hookId, HookSchema, tag);
        if (!hook) continue;
        await withHookTokenClaimLock(basedir, hook.token, async (signal) => {
            if (!(await isHookAvailable(basedir, hook, tag))) return;
            const claimPath = hookTokenClaimPath(basedir, hook.token);
            const claim = await readHookTokenClaim(claimPath);
            if (claim) {
                if (claim.runId !== hook.runId || (claim.hookId && claim.hookId !== hook.hookId)) {
                    throw new WorkflowWorldError('Conflicting Hook token claims during index preparation.');
                }
                if (claim.hookId) return;
            }
            // Legacy entities can lack an event; preserve the native claim format without inventing an eventId.
            const content = claim
                ? { ...claim, token: hook.token, hookId: hook.hookId }
                : { token: hook.token, hookId: hook.hookId, runId: hook.runId, tokenRetentionUntil: hook.tokenRetentionUntil };
            await writeHookByRunMarker(basedir, hook.runId, hook.hookId, tag);
            signal.throwIfAborted();
            if (claim) {
                await writeJSON(claimPath, content, { overwrite: true });
            } else if (!(await writeExclusive(claimPath, JSON.stringify(content)))) {
                throw new WorkflowWorldError('Could not restore a missing Hook token claim.');
            }
            // Disposal/run termination can begin while the claim lock is held.
            const available = await isHookAvailable(basedir, hook, tag);
            signal.throwIfAborted();
            if (!available) await deleteJSON(claimPath);
        });
    }
}

`;

function replaceOnce(source, before, after) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) {
    throw new Error("Unsupported @workflow/world-local hook source; review the index patch.");
  }
  return source.slice(0, at) + after + source.slice(at + before.length);
}

export function patchWorldLocalHookIndex(version) {
  return {
    name: "eve:workflow-world-local-hook-index",
    transform(source, id) {
      const normalized = id.replaceAll("\\", "/");
      const prefix = "/@workflow/world-local/dist/";
      const at = normalized.lastIndexOf(prefix);
      if (at < 0) return;
      const file = normalized.slice(at + prefix.length);
      if (
        ![
          "storage/hooks-storage.js",
          "storage/events-storage.js",
          "storage/hook-index.js",
          "index.js",
        ].includes(file)
      )
        return;
      if (version !== "5.0.0-beta.37") {
        throw new Error("The hook index patch requires @workflow/world-local 5.0.0-beta.37.");
      }
      if (file === "storage/hooks-storage.js") {
        source = replaceOnce(
          source,
          `import { HookNotFoundError } from '@workflow/errors';`,
          `import { HookNotFoundError, WorkflowWorldError } from '@workflow/errors';`,
        );
        source = replaceOnce(
          source,
          `import { filterHookData } from './filters.js';`,
          `import { stripTag, writeJSON } from '../fs.js';
import { withHookTokenClaimLock } from './helpers.js';
import { isVisibleToTag } from './hook-index.js';
import { filterHookData } from './filters.js';`,
        );
        source = replaceOnce(
          source,
          `    async function isHookAvailable(hook) {
        if (await isHookDisposalCommitted(basedir, hook.hookId, tag)) {
            return false;
        }
        if (hook.tokenRetentionUntil &&
            hook.tokenRetentionUntil.getTime() > Date.now()) {
            return true;
        }
        return !(await isTerminalRunCache(basedir, hook.runId, tag));
    }
`,
          ``,
        );
        source = replaceOnce(
          source,
          `        // Slow path for legacy states (e.g. a lost claim file while the
        // entity is still on disk).
        const hooksDir = path.join(basedir, 'hooks');
        const files = await listJSONFiles(hooksDir);
        for (const file of files) {
            const hookPath = path.join(hooksDir, \`\${file}.json\`);
            const hook = await readJSON(hookPath, HookSchema);
            if (hook?.token === token) {
                if (!(await isHookAvailable(hook))) {
                    throw new HookNotFoundError(token);
                }
                return { ...hook, isWebhook: hook.isWebhook ?? true };
            }
        }
`,
          ``,
        );
        source = replaceOnce(
          source,
          `/**
 * Creates a hooks storage implementation using the filesystem.`,
          preparationSource +
            `/**
 * Creates a hooks storage implementation using the filesystem.`,
        );
        source = replaceOnce(
          source,
          `if (!(await isHookAvailable(hook))) {
                        throw new HookNotFoundError(token);`,
          `if (!(await isHookAvailable(basedir, hook, tag))) {
                        throw new HookNotFoundError(token);`,
        );
        source = replaceOnce(
          source,
          `if (stored && !(await isHookAvailable(stored))) {`,
          `if (stored && !(await isHookAvailable(basedir, stored, tag))) {`,
        );
        source = replaceOnce(
          source,
          `return isHookAvailable(hook);`,
          `return isHookAvailable(basedir, hook, tag);`,
        );
        source = replaceOnce(
          source,
          `    async function getByToken(token) {`,
          `    async function getByToken(token) {
        await ensureHookTokenClaims(basedir, tag);`,
        );
      }
      if (file === "storage/hook-index.js") {
        source = replaceOnce(
          source,
          `import { hashToken } from './helpers.js';`,
          `import { UnsafeEntityIdError } from '../fs.js';
import { hashToken } from './helpers.js';`,
        );
        source = replaceOnce(
          source,
          `    catch {
        // Marker absent — backfill below.
    }`,
          `    catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }`,
        );
        for (const operation of [
          "writeHookCreatedIndexEntries(basedir, token, event.runId, event.correlationId, event.eventId, tagOf(fileId))",
          "writeHookByRunMarker(basedir, hook.runId, hook.hookId, tagOf(fileId))",
        ]) {
          source = replaceOnce(
            source,
            `            await ${operation};
        }
        catch {
            // Unsafe ids cannot have been written by this storage layer; skip.
        }`,
            `            await ${operation};
        }
        catch (error) {
            if (!UnsafeEntityIdError.is(error)) throw error;
        }`,
          );
        }
      }
      if (file === "index.js") {
        source = replaceOnce(
          source,
          `import { resetHookIndexEnsureCache } from './storage/hook-index.js';`,
          `import { resetHookIndexEnsureCache } from './storage/hook-index.js';
import { ensureHookTokenClaims, resetHookTokenClaimsCache } from './storage/hooks-storage.js';`,
        );
        source = replaceOnce(
          source,
          `            await initDataDir(mergedConfig.dataDir);
            if (!recoverActiveRuns)`,
          `            await initDataDir(mergedConfig.dataDir);
            await ensureHookTokenClaims(mergedConfig.dataDir, tag);
            if (!recoverActiveRuns)`,
        );
        source = replaceOnce(
          source,
          `        async clear() {
            clearStorageCache();`,
          `        async clear() {
            clearStorageCache();
            resetHookTokenClaimsCache();`,
        );
      }
      if (file === "storage/events-storage.js") {
        source = replaceOnce(
          source,
          `import { handleLegacyEvent } from './legacy.js';`,
          `import { ensureHookTokenClaims } from './hooks-storage.js';
import { handleLegacyEvent } from './legacy.js';`,
        );
        source = replaceOnce(
          source,
          `            // Step lifecycle events are serialized per-step via an in-process mutex`,
          `            if (data.eventType === 'hook_created') {
                await ensureHookTokenClaims(basedir, tag);
            }
            // Step lifecycle events are serialized per-step via an in-process mutex`,
        );
      }
      return { code: source, map: null };
    },
  };
}
