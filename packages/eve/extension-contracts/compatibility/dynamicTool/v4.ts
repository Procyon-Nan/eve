import { defineDynamic, defineTool, toolOutput, toolOutputPart } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => ({
      inspect_session: defineTool({
        description: "Inspect the current session",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ sessionId: ctx.session.id }),
        toModelOutput(output) {
          return toolOutput.content([
            toolOutputPart.text(`Session: ${(output as { sessionId: string }).sessionId}`),
          ]);
        },
      }),
    }),
  },
});
