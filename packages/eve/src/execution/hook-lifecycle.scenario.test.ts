import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorld } from "#compiled/@workflow/world-local/index.js";

const execute = promisify(execFile);
const roots: string[] = [];
const worlds: ReturnType<typeof createWorld>[] = [];
const compiledWorldUrl = new URL(
  "../../.generated/compiled/@workflow/world-local/index.js",
  import.meta.url,
).href;

async function dataDirectory() {
  const dir = await fs.mkdtemp(join(tmpdir(), "eve-hook-lifecycle-"));
  roots.push(dir);
  return dir;
}

function worldFor(dataDir: string, tag?: string) {
  const world = createWorld({ dataDir, tag, recoverActiveRuns: false });
  worlds.push(world);
  return world;
}

async function writeJson(dataDir: string, directory: string, name: string, value: unknown) {
  await fs.mkdir(join(dataDir, directory), { recursive: true });
  await fs.writeFile(join(dataDir, directory, `${name}.json`), JSON.stringify(value));
}

async function legacyHook(
  dataDir: string,
  options: {
    hookId?: string;
    token?: string;
    runId?: string;
    tag?: string;
    status?: "running" | "cancelled";
    tokenRetentionUntil?: Date;
  } = {},
) {
  const {
    hookId = "hook_legacy",
    token = "legacy-token",
    runId = "wrun_legacy",
    tag,
    status = "running",
    tokenRetentionUntil,
  } = options;
  const suffix = tag ? `.${tag}` : "";
  const now = new Date();
  await writeJson(dataDir, "runs", runId + suffix, {
    runId,
    status,
    deploymentId: "test",
    workflowName: "hook-test",
    specVersion: 6,
    createdAt: now,
    updatedAt: now,
    completedAt: status === "cancelled" ? now : undefined,
  });
  await writeJson(dataDir, "hooks", hookId + suffix, {
    runId,
    hookId,
    token,
    createdAt: now,
    ownerId: "local-owner",
    projectId: "local-project",
    environment: "local",
    specVersion: 6,
    isWebhook: false,
    isSystem: false,
    tokenRetentionUntil,
  });
}

function claimPath(dataDir: string, token = "legacy-token") {
  return join(
    dataDir,
    "hooks",
    "tokens",
    `${createHash("sha256").update(token).digest("hex")}.json`,
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const world of worlds.splice(0)) await world.close?.();
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("compiled legacy hook preparation", () => {
  it("preserves tag visibility and untagged fallback", async () => {
    const dir = await dataDirectory();
    await legacyHook(dir);
    await legacyHook(dir, {
      tag: "alpha",
      hookId: "hook_alpha",
      token: "alpha-token",
      runId: "wrun_alpha",
    });
    await legacyHook(dir, {
      tag: "beta",
      hookId: "hook_beta",
      token: "beta-token",
      runId: "wrun_beta",
    });
    const alpha = worldFor(dir, "alpha");
    await alpha.start?.();
    await expect(alpha.hooks.getByToken("legacy-token")).resolves.toMatchObject({
      hookId: "hook_legacy",
    });
    await expect(alpha.hooks.getByToken("alpha-token")).resolves.toMatchObject({
      hookId: "hook_alpha",
    });
    const beta = worldFor(dir, "beta");
    await beta.start?.();
    await expect(beta.hooks.getByToken("beta-token")).resolves.toMatchObject({
      hookId: "hook_beta",
    });
    await expect(alpha.hooks.getByToken("beta-token")).rejects.toMatchObject({
      name: "HookNotFoundError",
    });
    const untagged = worldFor(dir);
    await untagged.start?.();
    await expect(untagged.hooks.getByToken("alpha-token")).rejects.toMatchObject({
      name: "HookNotFoundError",
    });
  });

  it.each([
    { status: "running", future: false, available: true },
    { status: "cancelled", future: true, available: true },
    { status: "cancelled", future: false, available: false },
  ] as const)(
    "respects $status retention (future=$future)",
    async ({ status, future, available }) => {
      const dir = await dataDirectory();
      await legacyHook(dir, {
        status,
        tokenRetentionUntil: new Date(Date.now() + (future ? 60_000 : -60_000)),
      });
      const world = worldFor(dir);
      await world.start?.();
      if (available) {
        await expect(world.hooks.getByToken("legacy-token")).resolves.toMatchObject({
          hookId: "hook_legacy",
        });
      } else {
        await expect(world.hooks.getByToken("legacy-token")).rejects.toMatchObject({
          name: "HookNotFoundError",
        });
        await expect(fs.access(claimPath(dir))).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("does not restore a disposed hook even within retention", async () => {
    const dir = await dataDirectory();
    await legacyHook(dir, { tokenRetentionUntil: new Date(Date.now() + 60_000) });
    await fs.mkdir(join(dir, ".locks", "hooks"), { recursive: true });
    await fs.writeFile(join(dir, ".locks", "hooks", "hook_legacy.disposed"), "");
    const world = worldFor(dir);
    await world.start?.();
    await expect(world.hooks.getByToken("legacy-token")).rejects.toMatchObject({
      name: "HookNotFoundError",
    });
    await expect(fs.access(claimPath(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails preparation without overwriting a different owner's claim", async () => {
    const dir = await dataDirectory();
    await legacyHook(dir);
    await fs.mkdir(join(dir, "hooks", "tokens"), { recursive: true });
    const existing = JSON.stringify({ runId: "wrun_other", hookId: "hook_other" });
    await fs.writeFile(claimPath(dir), existing);
    const world = worldFor(dir);
    await expect(world.start?.()).rejects.toThrow("Conflicting Hook token claims");
    expect(await fs.readFile(claimPath(dir), "utf8")).toBe(existing);
    // A failed preparation must not be cached as ready.
    await fs.unlink(claimPath(dir));
    await world.start?.();
    await expect(world.hooks.getByToken("legacy-token")).resolves.toMatchObject({
      hookId: "hook_legacy",
    });
  });

  it("upgrades a same-owner legacy claim without inventing an event id", async () => {
    const dir = await dataDirectory();
    await legacyHook(dir);
    await fs.mkdir(join(dir, "hooks", "tokens"), { recursive: true });
    await fs.writeFile(claimPath(dir), JSON.stringify({ runId: "wrun_legacy" }));
    await worldFor(dir).start?.();
    expect(JSON.parse(await fs.readFile(claimPath(dir), "utf8"))).toEqual({
      runId: "wrun_legacy",
      hookId: "hook_legacy",
      token: "legacy-token",
    });
  });

  it("shares token ownership across concurrent processes and a fresh restart", async () => {
    const dir = await dataDirectory();
    await legacyHook(dir);
    const script = `
      const { createWorld } = await import(process.argv[1]);
      const world = createWorld({ dataDir: process.argv[2], recoverActiveRuns: false });
      try {
        await world.start();
        const hook = await world.hooks.getByToken('legacy-token');
        console.log(JSON.stringify({ runId: hook.runId, hookId: hook.hookId }));
      } finally { await world.close(); }
    `;
    const run = () =>
      execute(process.execPath, ["--input-type=module", "--eval", script, compiledWorldUrl, dir], {
        timeout: 15_000,
      });
    const results = await Promise.all([run(), run()]);
    results.push(await run());
    for (const result of results) {
      expect(JSON.parse(result.stdout)).toEqual({ runId: "wrun_legacy", hookId: "hook_legacy" });
    }
  });
  it("holds direct hook creation behind legacy claim preparation", async () => {
    const dir = await dataDirectory();
    await legacyHook(dir);
    await legacyHook(dir, {
      runId: "wrun_competitor",
      hookId: "hook_existing",
      token: "other-token",
    });
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const original = fs.readFile.bind(fs);
    let held = false;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (!held && String(args[0]) === join(dir, "hooks", "hook_legacy.json")) {
        held = true;
        entered.resolve();
        await gate.promise;
      }
      return original(...args);
    });
    const world = worldFor(dir);
    const preparing = world.start?.();
    await entered.promise;
    const creating = world.events.create("wrun_competitor", {
      eventType: "hook_created",
      correlationId: "hook_competitor",
      eventData: { token: "legacy-token" },
    });
    gate.resolve();
    const [, result] = await Promise.all([preparing, creating]);
    expect(result.event).toMatchObject({
      eventType: "hook_conflict",
      eventData: { conflictingRunId: "wrun_legacy" },
    });
    await expect(world.hooks.getByToken("legacy-token")).resolves.toMatchObject({
      runId: "wrun_legacy",
      hookId: "hook_legacy",
    });
  });

  it("recovers a missing entity and claim from the token event index", async () => {
    const dir = await dataDirectory();
    await legacyHook(dir);
    const world = worldFor(dir);
    await world.start?.();
    await world.events.create("wrun_legacy", {
      eventType: "hook_created",
      correlationId: "hook_event",
      eventData: { token: "event-token" },
    });
    await fs.unlink(join(dir, "hooks", "hook_event.json"));
    await fs.unlink(claimPath(dir, "event-token"));
    await expect(world.hooks.getByToken("event-token")).resolves.toMatchObject({
      hookId: "hook_event",
    });
    await world.events.create("wrun_legacy", {
      eventType: "hook_disposed",
      correlationId: "hook_event",
      eventData: { token: "event-token" },
    });
    await expect(world.hooks.getByToken("event-token")).rejects.toMatchObject({
      name: "HookNotFoundError",
    });
    await expect(fs.access(claimPath(dir, "event-token"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not return a cached hook after its run becomes terminal", async () => {
    const dir = await dataDirectory();
    await legacyHook(dir);
    const world = worldFor(dir);
    await world.start?.();
    await expect(world.hooks.getByToken("legacy-token")).resolves.toMatchObject({
      hookId: "hook_legacy",
    });
    await world.events.create("wrun_legacy", { eventType: "run_cancelled" });
    await expect(world.hooks.getByToken("legacy-token")).rejects.toMatchObject({
      name: "HookNotFoundError",
    });
  });
});
