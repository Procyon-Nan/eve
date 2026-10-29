import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { join } from "node:path";
const [mode, base, dataDir, version] = process.argv.slice(2);
const { createWorld } = await import(`${base}/@workflow/world-local/index.js`);
const { start, setWorld, workflowEntrypoint, resumeHook, getRun } = await import(
  `${base}/@workflow/core/runtime.js`
);
const { registerStepFunction } = await import(`${base}/@workflow/core/private.js`);
const firstId =
  mode === "record"
    ? `step//eve@${version}//createSessionStep`
    : "step//eve-contract-v1//createSessionStep";
const secondId =
  mode === "record"
    ? `step//eve@${version}//dispatchTurnStep`
    : "step//eve-contract-v1//dispatchTurnStep";
let firstCalls = 0,
  secondCalls = 0;
registerStepFunction(firstId, async () => {
  firstCalls++;
  if (mode !== "record") throw new Error("Completed historical step was rerun");
  return { retained: "historical-output" };
});
registerStepFunction(secondId, async (value) => {
  secondCalls++;
  return value;
});
const workflowId = "workflow//eve-replay-probe//main";
const token = "eve-cross-version-replay-probe";
const code = `globalThis.__private_workflows ??= new Map();
const first = globalThis[Symbol.for('WORKFLOW_USE_STEP')](${JSON.stringify(firstId)});
const second = globalThis[Symbol.for('WORKFLOW_USE_STEP')](${JSON.stringify(secondId)});
globalThis.__private_workflows.set(${JSON.stringify(workflowId)}, async function main() {
 const saved=await first();
 const hook=globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')]({token:${JSON.stringify(token)}});
 const resumed=await hook;
 return await second({saved,resumed});
});`;
const world = createWorld({ dataDir, recoverActiveRuns: false });
world.registerHandler("__wkf_workflow_", workflowEntrypoint(code));
setWorld(world);
await world.start();
try {
  if (mode === "record") {
    const ref = Object.assign(async () => {}, { workflowId });
    const run = await start(ref, []);
    const deadline = Date.now() + 15000;
    while (true) {
      try {
        await world.hooks.getByToken(token);
        break;
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 0);
    await fs.writeFile(
      join(dataDir, "probe-manifest.json"),
      JSON.stringify({ runId: run.runId, version }),
    );
    console.log(JSON.stringify({ mode, version, runId: run.runId, firstCalls, secondCalls }));
  } else {
    const { runId } = JSON.parse(await fs.readFile(join(dataDir, "probe-manifest.json"), "utf8"));
    await resumeHook(token, "continued-after-upgrade");
    const value = await Promise.race([
      getRun(runId).returnValue,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("replay timeout")), 15000).unref();
      }),
    ]);
    assert.deepEqual(value, {
      saved: { retained: "historical-output" },
      resumed: "continued-after-upgrade",
    });
    assert.equal(firstCalls, 0);
    assert.equal(secondCalls, 1);
    console.log(
      JSON.stringify({
        mode,
        version,
        runId,
        firstCalls,
        secondCalls,
        value,
        status: (await world.runs.get(runId)).status,
      }),
    );
  }
} finally {
  await world.close();
  setWorld(undefined);
}
