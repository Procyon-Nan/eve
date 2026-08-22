import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import { isObject } from "#shared/guards.js";

function migrateSessionInboxWireV1(prior: unknown): Record<string, unknown> & {
  readonly version: 2;
} {
  if (!isObject(prior) || prior.version !== 1) {
    throw new Error("session inbox wire v1 value is malformed.");
  }
  return { ...prior, version: 2 };
}

export const sessionInboxWireV1ToV2: VersionMigration = {
  from: 1,
  migrate: migrateSessionInboxWireV1,
  to: 2,
};
