import { defineAgent, defineDynamic, defineHostRuntime } from "#public/index.js";

export default defineDynamic({
  runtime: defineHostRuntime({ providerKind: "compatibility-host" }),
  events: {
    "turn.started": () =>
      defineAgent({
        description: "Review delegated work with the locked host runtime.",
        runtime: defineHostRuntime({ providerKind: "compatibility-host" }),
      }),
  },
});
