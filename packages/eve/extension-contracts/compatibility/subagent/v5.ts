import { defineAgent, withHostRuntime } from "#public/index.js";

export const trustedAuth = withHostRuntime(
  {
    attributes: {},
    authenticator: "compatibility",
    principalId: "compatibility-host",
    principalType: "service",
  },
  {
    acceptanceKey: "compatibility-command",
    reference: { providerKind: "compatibility-host", value: "opaque-reference" },
  },
);

export default defineAgent({
  description: "Delegate trusted host work.",
  model: "anthropic/claude-sonnet-5",
});
