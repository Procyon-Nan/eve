import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const base = process.argv[2];
const concurrency = Number(process.env.WORKFLOW_LOCAL_QUEUE_CONCURRENCY ?? 16);
const buffer = Number(process.env.WORKFLOW_LOCAL_RECOVERY_BUFFER ?? concurrency);
if (!base) throw new Error("Pass the absolute compiled directory as the first argument.");
const { createWorld } = await import(`${base}/@workflow/world-local/index.js`);

const root = await fs.mkdtemp(join(os.tmpdir(), "eve-recovery-scale-"));
const dataDir = join(root, "data");
let world = createWorld({ dataDir, recoverActiveRuns: false });
for (let i = 0; i < 574; i++)
  await world.events.create(null, {
    eventType: "run_created",
    specVersion: 2,
    eventData: {
      deploymentId: "scale-test",
      workflowName:
        i % 2 ? "workflow//eve//sessionTimeoutWorkflow" : "workflow//eve//workflowEntry",
      input: [],
    },
  });
await world.close();
const prefix = "__wkf_workflow_";
const reports = [];
try {
  for (let pass = 1; pass <= 2; pass++) {
    world = createWorld({ dataDir, deferRecovery: true, recoverActiveRuns: true });
    let active = 0,
      maxActive = 0,
      recovered = 0,
      normal = 0,
      normalAt;
    const seen = new Set();
    const start = performance.now(),
      cpu = process.cpuUsage(),
      usage = process.resourceUsage();
    world.registerHandler(prefix, async (request) => {
      const body = JSON.parse(await request.text());
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (body.runId === "wrun_normal") {
        normal++;
        normalAt = performance.now() - start;
        return Response.json({});
      }
      recovered++;
      seen.add(body.runId);
      return Response.json({ timeoutSeconds: 3600 });
    });
    await world.start();
    assert.equal(recovered, 0);
    world.startRecovery();
    await world.queue(`${prefix}workflow//eve//workflowEntry`, { runId: "wrun_normal" });
    const deadline = Date.now() + 30000;
    while (seen.size < 574 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(seen.size, 574);
    assert.equal(recovered, 574);
    assert.ok(maxActive <= Math.max(1, Math.floor(concurrency / 2)) + 1);
    assert.equal(normal, 1);
    const closeAt = performance.now();
    await world.close();
    assert.equal(active, 0);
    const c = process.cpuUsage(cpu),
      r = process.resourceUsage();
    reports.push({
      pass,
      C: concurrency,
      B: buffer,
      uniqueRuns: seen.size,
      deliveries: recovered,
      maxActive,
      normalMs: Math.round(normalAt),
      elapsedMs: Math.round(performance.now() - start),
      closeMs: Math.round(performance.now() - closeAt),
      cpuMs: Math.round((c.user + c.system) / 1000),
      rssMiB: Math.round(process.memoryUsage().rss / 1048576),
      fsRead: r.fsRead - usage.fsRead,
      fsWrite: r.fsWrite - usage.fsWrite,
    });
  }
  console.log(JSON.stringify(reports));
} finally {
  await world.close();
  await fs.rm(root, { recursive: true, force: true });
}
