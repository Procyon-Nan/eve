import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

describe("sandbox compilation", () => {
  const scenarioApp = useScenarioApp();

  it("preserves zero-argument sandbox definition factories", async () => {
    const app = await scenarioApp({
      files: {
        "agent/sandbox.ts": "export default () => ({ description: 'factory sandbox' });\n",
      },
      name: "sandbox-definition-factory",
    });

    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const manifest = await compileAgentManifest(discovered.manifest);

    expect(manifest.sandbox).toMatchObject({
      description: "factory sandbox",
      inheritsParent: undefined,
    });
  });

  it("compiles managed child resources alongside the parent selector for runtime rejection", async () => {
    const app = await scenarioApp({
      files: {
        "agent/subagents/foo/agent.ts":
          "export default { description: 'foo', model: 'openai/gpt-5.4' };\n",
        "agent/subagents/foo/description.md": "foo\n",
        "agent/subagents/foo/sandbox/sandbox.ts": [
          'import { defineSandbox } from "eve/sandbox";',
          "export default defineSandbox((...args) => args[0].parent.sandbox);",
          "",
        ].join("\n"),
        "agent/subagents/foo/sandbox/workspace/bar.txt": "child seed\n",
      },
      installDependencies: true,
      name: "inherited-sandbox-child-resources",
    });

    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const manifest = await compileAgentManifest(discovered.manifest);
    expect(manifest.subagents[0]?.agent).toMatchObject({
      sandbox: { inheritsParent: true },
      workspaceResourceRoot: { rootEntries: ["bar.txt"] },
    });
  });

  it("preserves an explicit opt-out alongside a plain static Markdown skill", async () => {
    const app = await scenarioApp({
      files: {
        "agent/sandbox.ts": [
          'import { disableSandbox } from "eve/sandbox";',
          "export default disableSandbox();",
          "",
        ].join("\n"),
        "agent/skills/review.md": [
          "---",
          "description: Review a response.",
          "---",
          "Review the response without reading supporting files.",
          "",
        ].join("\n"),
        "agent/skills/triage/SKILL.md": [
          "---",
          "name: triage",
          "description: Triage a response.",
          "---",
          "Triage the response without reading supporting files.",
          "",
        ].join("\n"),
      },
      installDependencies: true,
      name: "disabled-sandbox-static-skill",
    });

    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const manifest = await compileAgentManifest(discovered.manifest);

    expect(manifest.sandbox).toEqual({
      exportName: undefined,
      kind: "eve:disabled-sandbox",
      logicalPath: "sandbox.ts",
      sourceId: "sandbox.ts",
      sourceKind: "module",
    });
    expect(manifest.skills).toMatchObject([
      { logicalPath: "skills/review.md", name: "review", sourceKind: "markdown" },
      {
        logicalPath: "skills/triage/SKILL.md",
        name: "triage",
        sourceKind: "skill-package",
      },
    ]);
  });

  it("rejects sandbox-backed workspace and skill files alongside an explicit opt-out", async () => {
    const app = await scenarioApp({
      files: {
        "agent/sandbox/sandbox.ts": [
          'import { disableSandbox } from "eve/sandbox";',
          "export default disableSandbox();",
          "",
        ].join("\n"),
        "agent/sandbox/workspace/seed.txt": "seed\n",
        "agent/skills/review/SKILL.md": [
          "---",
          "name: review",
          "description: Review a response.",
          "---",
          "Review the response.",
          "",
        ].join("\n"),
        "agent/skills/review/references/checklist.md": "Review checklist.\n",
      },
      installDependencies: true,
      name: "disabled-sandbox-conflicts",
    });

    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });

    await expect(compileAgentManifest(discovered.manifest)).rejects.toThrow(
      /disabled-sandbox-conflicts.*disableSandbox.*sandbox workspace "sandbox\/workspace".*static skill files "skills\/review\/SKILL\.md"/s,
    );
  });

  it("rejects dynamic skill resolvers alongside an explicit opt-out", async () => {
    const app = await scenarioApp({
      files: {
        "agent/sandbox.ts": [
          'import { disableSandbox } from "eve/sandbox";',
          "export default disableSandbox();",
          "",
        ].join("\n"),
        "agent/skills/runtime.ts": [
          'import { defineDynamic } from "eve/skills";',
          "export default defineDynamic({ events: { 'step.started': async () => ({}) } });",
          "",
        ].join("\n"),
      },
      installDependencies: true,
      name: "disabled-sandbox-dynamic-skill",
    });

    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });

    await expect(compileAgentManifest(discovered.manifest)).rejects.toThrow(
      /disableSandbox.*dynamic skill resolver "skills\/runtime\.ts"/s,
    );
  });

  it("rejects defineSkill files alongside an explicit opt-out", async () => {
    const app = await scenarioApp({
      files: {
        "agent/sandbox.ts": [
          'import { disableSandbox } from "eve/sandbox";',
          "export default disableSandbox();",
          "",
        ].join("\n"),
        "agent/skills/review.ts": [
          'import { defineSkill } from "eve/skills";',
          "export default defineSkill({",
          '  description: "Review a response.",',
          '  markdown: "Review the response.",',
          '  files: { "references/checklist.md": "Review checklist." },',
          "});",
          "",
        ].join("\n"),
      },
      installDependencies: true,
      name: "disabled-sandbox-module-skill-files",
    });

    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });

    await expect(compileAgentManifest(discovered.manifest)).rejects.toThrow(
      /disableSandbox.*static skill files "skills\/review\.ts"/s,
    );
  });
});
