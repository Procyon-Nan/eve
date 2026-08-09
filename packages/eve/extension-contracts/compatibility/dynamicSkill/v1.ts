import { defineDynamic, defineSkill } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineSkill({
        description: "Session-specific operating procedure",
        markdown: `Work within session ${ctx.session.id}.`,
      }),
  },
});
