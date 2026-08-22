import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Keep session ${ctx.session.id} grounded in verified evidence.`,
      }),
  },
});
