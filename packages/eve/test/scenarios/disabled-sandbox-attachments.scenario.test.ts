import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { UserContent } from "ai";
import { describe, expect, it } from "vitest";

import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { fetchAgentInfo, hasKnownDevServerFailure, startEveDev } from "./dev-server-harness.js";

const TEST_TIMEOUT_MS = 360_000;
const scenarioApp = useScenarioApp();

const DISABLED_SANDBOX_DESCRIPTOR: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
    "agent/instructions.md": "Inspect inline attachments with the authored tool.\n",
    "agent/sandbox.ts": [
      'import { disableSandbox } from "eve/sandbox";',
      "export default disableSandbox();",
      "",
    ].join("\n"),
    "agent/subagents/researcher/agent.ts": [
      "export default {",
      '  description: "Research one focused question.",',
      '  model: "openai/gpt-5.4",',
      "};",
      "",
    ].join("\n"),
    "agent/subagents/researcher/instructions.md": "Answer the delegated question directly.\n",
    "agent/tools/inspect_attachments.ts": [
      'import { defineDynamic, defineTool } from "eve/tools";',
      "",
      "export default defineDynamic({",
      "  events: {",
      '    "step.started": async (_event, ctx) => {',
      "      const files = ctx.messages.flatMap((message) =>",
      "        Array.isArray(message.content)",
      '          ? message.content.filter((part) => part.type === "file")',
      "          : [],",
      "      );",
      "      return defineTool({",
      '        description: "Report the inline file parts visible to this turn.",',
      '        inputSchema: { type: "object", properties: {}, additionalProperties: false },',
      "        async execute() {",
      "          return {",
      "            files: files.map((part) => ({",
      "              data:",
      '                typeof part.data === "string"',
      '                  ? part.data.slice(0, part.data.indexOf(",") + 1)',
      "                  : part.data instanceof URL",
      "                    ? part.data.protocol",
      '                    : "bytes",',
      "              mediaType: part.mediaType,",
      "            })),",
      "          };",
      "        },",
      "      });",
      "    },",
      "  },",
      "});",
      "",
    ].join("\n"),
  },
  installDependencies: true,
  name: "disabled-sandbox-attachments",
};

describe("disabled sandbox attachment runtime", () => {
  it(
    "passes image and PDF parts to the model loop without provisioning a sandbox",
    async () => {
      const app = await scenarioApp(DISABLED_SANDBOX_DESCRIPTOR);
      const packageJsonPath = join(app.appRoot, "package.json");
      const lockfilePath = join(app.appRoot, "pnpm-lock.yaml");
      const [packageJsonBefore, lockfileBefore] = await Promise.all([
        readFile(packageJsonPath, "utf8"),
        readFile(lockfilePath, "utf8"),
      ]);
      const server = await startEveDev(app.appRoot);

      try {
        const info = await fetchAgentInfo(server.url);
        expect(info.sandbox).toMatchObject({
          logicalPath: "sandbox.ts",
          status: "disabled",
        });
        expect(info.subagents.total).toBe(1);
        expect(info.tools.dynamic.map((tool) => tool.slug)).toContain("inspect_attachments");
        expect(info.tools.available.map((tool) => tool.name)).toContain("ask_question");
        expect(info.tools.available.map((tool) => tool.name)).toContain("agent");
        expect(info.tools.available.map((tool) => tool.name)).not.toContain("bash");
        expect(info.tools.framework.find((tool) => tool.name === "bash")).toMatchObject({
          disabledBySandbox: true,
          status: "unavailable",
        });

        const message: UserContent = [
          { type: "text", text: "Call inspect_attachments and report the result." },
          {
            data: "data:image/png;base64,iVBORw0KGgo=",
            filename: "image.png",
            mediaType: "image/png",
            type: "file",
          },
          {
            data: "data:application/pdf;base64,JVBERi0xLjc=",
            filename: "document.pdf",
            mediaType: "application/pdf",
            type: "file",
          },
        ];
        const result = await sendDevelopmentMessage({
          message,
          serverUrl: server.url,
          session: createDevelopmentSessionState(),
        });
        const completed = readCompletedMessages(result.events);

        expect(completed).toContain("inspect_attachments");
        expect(completed).toContain("data:image/png;base64,");
        expect(completed).toContain("data:application/pdf;base64,");
        expect(completed).not.toContain("eve-sandbox:");
        expect(result.events.some((event) => event.type === "session.waiting")).toBe(true);

        const delegationResult = await sendDevelopmentMessage({
          message: "Delegate to a subagent: Reply with the exact token no-sandbox-child.",
          serverUrl: server.url,
          session: createDevelopmentSessionState(),
        });
        expect(delegationResult.events.some((event) => event.type === "subagent.called")).toBe(
          true,
        );
        expect(delegationResult.events.some((event) => event.type === "subagent.completed")).toBe(
          true,
        );
        expect(delegationResult.events.some((event) => event.type === "session.waiting")).toBe(
          true,
        );

        const [packageJsonAfter, lockfileAfter] = await Promise.all([
          readFile(packageJsonPath, "utf8"),
          readFile(lockfilePath, "utf8"),
        ]);
        expect(packageJsonAfter).toBe(packageJsonBefore);
        expect(lockfileAfter).toBe(lockfileBefore);

        const output = `${server.stdout()}\n${server.stderr()}`;
        expect(output).not.toMatch(/opening sandbox|initializing sandbox|microsandbox|just-bash/iu);
        expect(hasKnownDevServerFailure(output)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

function readCompletedMessages(
  events: readonly { readonly data?: unknown; readonly type: string }[],
): string {
  return events
    .flatMap((event) => {
      if (event.type !== "message.completed" || !isRecord(event.data)) {
        return [];
      }
      return typeof event.data.message === "string" ? [event.data.message] : [];
    })
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
