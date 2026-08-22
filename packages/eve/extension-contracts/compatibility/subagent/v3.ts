import { defineAgent, defineDynamic } from "#public/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineAgent({
        description: `Research requests for session ${ctx.session.id}.`,
        model: "anthropic/claude-sonnet-5",
      }),
  },
});
