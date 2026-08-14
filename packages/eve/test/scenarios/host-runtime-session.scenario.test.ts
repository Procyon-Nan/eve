import { describe, expect, it } from "vitest";

import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { fetchAgentInfo, startEveDev, waitForCondition } from "./dev-server-harness.js";

const TEST_TIMEOUT_MS = 360_000;
const scenarioApp = useScenarioApp();

const HOST_RUNTIME_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": [
      'import { defineAgent, defineDynamic, hostRuntimeModel } from "eve";',
      "",
      "export default defineAgent({",
      "  model: defineDynamic({",
      '    fallback: "openai/gpt-5.4-mini",',
      "    events: {",
      '      "step.started": (_event, ctx) => {',
      "        const selection = hostRuntimeModel(ctx);",
      "        console.log(`SCENARIO_HOST_RUNTIME_MODEL:${selection.model.modelId}`);",
      "        return selection;",
      "      },",
      "    },",
      "  }),",
      "});",
      "",
    ].join("\n"),
    "agent/channels/eve.ts": [
      'import { eveChannel } from "eve/channels/eve";',
      'import { createHostRuntimeAuth } from "../lib/host-runtime";',
      "",
      "export default eveChannel({",
      "  auth: () => createHostRuntimeAuth(),",
      "});",
      "",
    ].join("\n"),
    "agent/instructions/host.ts": [
      'import { hostRuntimeInstructions } from "eve";',
      'import { defineDynamic, defineInstructions } from "eve/instructions";',
      "",
      "export default defineDynamic({",
      "  events: {",
      '    "turn.started": (_event, ctx) => {',
      "      const markdown = hostRuntimeInstructions(ctx);",
      "      console.log(`SCENARIO_HOST_RUNTIME_INSTRUCTIONS:${markdown}`);",
      "      return markdown === undefined ? null : defineInstructions({ markdown });",
      "    },",
      "  },",
      "});",
      "",
    ].join("\n"),
    "agent/lib/host-runtime.ts": [
      'import { MockLanguageModelV3 } from "ai/test";',
      'import { registerHostRuntimeProvider, withHostRuntime } from "eve";',
      'import { defineTool } from "eve/tools";',
      "",
      'const providerKind = "scenario-host";',
      'const rootReference = { providerKind, value: "root-reference" };',
      'const providerSymbol = Symbol.for("eve.scenario.host-runtime-provider");',
      "const providerGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;",
      "",
      "function createResult(kind, options) {",
      "  const delegated = options.prompt.some(",
      '    (message) => message.role === "tool" && JSON.stringify(message.content).includes("call_reviewer"),',
      "  );",
      '  const content = kind === "root" && !delegated',
      "    ? [{",
      '        input: JSON.stringify({ message: "Review the scenario contract." }),',
      '        toolCallId: "call_reviewer",',
      '        toolName: "reviewer",',
      '        type: "tool-call",',
      "      }]",
      '    : [{ text: kind === "root" ? "root-complete" : "reviewer-complete", type: "text" }];',
      '  const toolCall = content[0]?.type === "tool-call";',
      "  return {",
      "    content,",
      '    finishReason: { raw: undefined, unified: toolCall ? "tool-calls" : "stop" },',
      "    response: { id: `scenario-${kind}`, modelId: `${kind}-model`, timestamp: new Date(0) },",
      "    usage: {",
      "      inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },",
      "      outputTokens: { reasoning: 0, text: 1, total: 1 },",
      "    },",
      "    warnings: [],",
      "  };",
      "}",
      "",
      "function createStream(result) {",
      "  const parts = [",
      '    { type: "stream-start", warnings: result.warnings },',
      '    { ...result.response, type: "response-metadata" },',
      "  ];",
      "  for (const part of result.content) {",
      '    if (part.type === "tool-call") {',
      "      parts.push(part);",
      "    } else {",
      '      parts.push({ id: "text-0", type: "text-start" });',
      '      parts.push({ delta: part.text, id: "text-0", type: "text-delta" });',
      '      parts.push({ id: "text-0", type: "text-end" });',
      "    }",
      "  }",
      '  parts.push({ finishReason: result.finishReason, type: "finish", usage: result.usage });',
      "  return {",
      "    stream: new ReadableStream({",
      "      start(controller) {",
      "        for (const part of parts) controller.enqueue(part);",
      "        controller.close();",
      "      },",
      "    }),",
      "  };",
      "}",
      "",
      "function createModel(kind) {",
      "  return new MockLanguageModelV3({",
      "    modelId: `${kind}-model`,",
      '    provider: "scenario-host",',
      "    doGenerate: async (options) => createResult(kind, options),",
      "    doStream: async (options) => createStream(createResult(kind, options)),",
      "  });",
      "}",
      "",
      "if (providerGlobal[providerSymbol] === undefined) {",
      "  providerGlobal[providerSymbol] = registerHostRuntimeProvider({",
      "    providerKind,",
      "    async resolve({ reference }) {",
      '      const kind = reference.value.startsWith("reviewer:") ? "reviewer" : "root";',
      "      console.log(`SCENARIO_HOST_RUNTIME_RESOLVE:${kind}`);",
      "      return {",
      "        model: createModel(kind),",
      "        modelId: `${kind}-model`,",
      "        instructions: `${kind}-instructions`,",
      '        ...(kind === "root"',
      '          ? { delegatedSubagentNames: ["reviewer"], tools: {',
      "              host_probe: defineTool({",
      '                description: "Return the host runtime probe token.",',
      '                inputSchema: { additionalProperties: false, properties: {}, type: "object" },',
      '                execute: async () => ({ token: "host-probe" }),',
      "              }),",
      "            } }",
      "          : {}),",
      "      };",
      "    },",
      "    async createSpecialistReference(input) {",
      "      console.log(`SCENARIO_HOST_RUNTIME_CREATE:${input.subagentName}`);",
      "      return { providerKind, value: `reviewer:${input.callId}` };",
      "    },",
      "    async release({ outcome, reference }) {",
      "      console.log(`SCENARIO_HOST_RUNTIME_RELEASE:${reference.value}:${outcome}`);",
      "    },",
      "  });",
      "}",
      "",
      "export function createHostRuntimeAuth() {",
      "  return withHostRuntime(",
      "    {",
      "      attributes: {},",
      '      authenticator: "scenario",',
      '      principalId: "scenario-host",',
      '      principalType: "service",',
      "    },",
      '    { acceptanceKey: "scenario-acceptance", reference: rootReference },',
      "  );",
      "}",
      "",
    ].join("\n"),
    "agent/subagents/reviewer/agent.ts": [
      'import { defineAgent, defineDynamic, defineHostRuntime } from "eve";',
      "",
      'const runtime = defineHostRuntime({ providerKind: "scenario-host" });',
      "",
      "export default defineDynamic({",
      "  runtime,",
      "  events: {",
      '    "turn.started": () =>',
      "      defineAgent({",
      '        description: "Review the delegated scenario contract.",',
      "        runtime,",
      "      }),",
      "  },",
      "});",
      "",
    ].join("\n"),
    "agent/subagents/reviewer/instructions.md": "Return the review result directly.\n",
    "agent/tools/host.ts": [
      'import { hostRuntimeTools } from "eve";',
      'import { defineDynamic } from "eve/tools";',
      "",
      "export default defineDynamic({",
      "  events: {",
      '    "step.started": (_event, ctx) => {',
      "      const tools = hostRuntimeTools(ctx);",
      '      console.log(`SCENARIO_HOST_RUNTIME_TOOLS:${Object.keys(tools ?? {}).join(",")}`);',
      "      return tools ?? null;",
      "    },",
      "  },",
      "});",
      "",
    ].join("\n"),
  },
  installDependencies: true,
  name: "host-runtime-session",
};

describe("host runtime session workflow", () => {
  it(
    "runs a root turn with a discoverable dynamic specialist through the workflow bundle",
    async () => {
      const app = await scenarioApp(HOST_RUNTIME_DESCRIPTOR);
      const server = await startEveDev(app.appRoot, {
        env: { NODE_ENV: "development" },
      });

      try {
        const info = await fetchAgentInfo(server.url);
        expect(info.subagents.local.map((subagent) => subagent.name)).toContain("reviewer");

        const result = await sendDevelopmentMessage({
          message: "Complete the root host runtime turn.",
          serverUrl: server.url,
          session: createDevelopmentSessionState(),
        });
        const eventTypes = result.events.map((event) => event.type);
        const serverOutput = `${server.stdout()}\n${server.stderr()}`;
        const failureContext = `${JSON.stringify(result.events, null, 2)}\n${serverOutput}`;

        expect(eventTypes, failureContext).toContain("message.completed");
        expect(eventTypes, failureContext).toContain("step.completed");
        expect(eventTypes.at(-1)).toBe("session.waiting");
        expect(eventTypes).not.toContain("session.failed");

        const acceptanceResponse = await fetch(
          new URL("/eve/v1/host-runtime/acceptance/scenario-acceptance", server.url),
        );
        expect(acceptanceResponse.status).toBe(200);
        await expect(acceptanceResponse.json()).resolves.toEqual({
          ok: true,
          status: "ACCEPTED",
        });

        await waitForCondition(
          () => server.stdout().includes("SCENARIO_HOST_RUNTIME_RELEASE:root-reference:completed"),
          () =>
            `Timed out waiting for root host runtime release.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
          10_000,
        );
        const output = `${server.stdout()}\n${server.stderr()}`;
        expect(failureContext).toContain("reviewer-complete");
        expect(output).toContain("SCENARIO_HOST_RUNTIME_RESOLVE:root");
        expect(output).toContain("SCENARIO_HOST_RUNTIME_MODEL:root-model");
        expect(output).toContain("SCENARIO_HOST_RUNTIME_INSTRUCTIONS:root-instructions");
        expect(output).toContain("SCENARIO_HOST_RUNTIME_TOOLS:host_probe");
        expect(output).toContain("SCENARIO_HOST_RUNTIME_CREATE:reviewer");
        expect(output).toContain("SCENARIO_HOST_RUNTIME_RESOLVE:reviewer");
        expect(output).toContain("SCENARIO_HOST_RUNTIME_RELEASE:reviewer:call_reviewer:completed");
        expect(output).toContain("SCENARIO_HOST_RUNTIME_RELEASE:root-reference:completed");
        expect(output).not.toContain("FatalError.is is not a function");
      } finally {
        await server.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
