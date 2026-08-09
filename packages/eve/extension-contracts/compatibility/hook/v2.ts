import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "subagent.called"(event, ctx) {
      console.info("subagent called", {
        callId: event.data.callId,
        childSessionId: event.data.childSessionId,
        parentSessionId: ctx.session.id,
      });
    },
  },
});
