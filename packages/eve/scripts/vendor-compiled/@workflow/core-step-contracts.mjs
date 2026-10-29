import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const contracts = JSON.parse(
  readFileSync(
    new URL("../../../src/internal/workflow/step-contracts.json", import.meta.url),
    "utf8",
  ),
);
const aliases = contracts.flatMap(({ id, legacyIds }) => legacyIds.map((legacy) => [legacy, id]));
const canonicalizer = `
const eveStepContracts = new Map(${JSON.stringify(aliases)});
export function canonicalEveStepId(stepId) {
    return eveStepContracts.get(stepId) ?? stepId;
}
`;

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) {
    throw new Error(
      "Unsupported @workflow/core step contract source; review the compatibility patch.",
    );
  }
  return source.replace(before, after);
}

export function patchCoreStepContracts() {
  return {
    name: "eve:workflow-core-step-contracts",
    transform(source, id) {
      const normalized = id.replaceAll("\\", "/");
      if (!/\/@workflow\/core\/dist\/(private|step)\.js$/.test(normalized)) return;
      const manifest = JSON.parse(readFileSync(join(dirname(id), "../package.json"), "utf8"));
      if (manifest.version !== "5.0.0-beta.43") {
        throw new Error("The step contract patch requires @workflow/core 5.0.0-beta.43.");
      }
      if (normalized.endsWith("/private.js")) {
        source = canonicalizer + source;
        source = replaceOnce(
          source,
          "export function registerStepFunction(stepId, stepFn) {",
          "export function registerStepFunction(stepId, stepFn) {\n    stepId = canonicalEveStepId(stepId);",
        );
        source = replaceOnce(
          source,
          "export function getStepFunction(stepId) {",
          "export function getStepFunction(stepId) {\n    stepId = canonicalEveStepId(stepId);",
        );
      } else {
        source = "import { canonicalEveStepId } from './private.js';\n" + source;
        source = replaceOnce(
          source,
          "return function useStep(stepName, closureVarsFn) {",
          "return function useStep(stepName, closureVarsFn) {\n        stepName = canonicalEveStepId(stepName);",
        );
        source = replaceOnce(
          source,
          "typeof eventStepName === 'string' && eventStepName !== stepName",
          "typeof eventStepName === 'string' && canonicalEveStepId(eventStepName) !== stepName",
        );
      }
      return { code: source, map: null };
    },
  };
}
