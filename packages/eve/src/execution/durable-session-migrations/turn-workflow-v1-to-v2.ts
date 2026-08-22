import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import { isObject } from "#shared/guards.js";

function migrateTurnWorkflowInputV1(prior: unknown): Record<string, unknown> & {
  readonly version: 2;
} {
  if (!isObject(prior) || prior.version !== 1) {
    throw new Error("turn workflow input v1 value is malformed.");
  }
  return { ...prior, version: 2 };
}

export const turnWorkflowInputV1ToV2: VersionMigration = {
  from: 1,
  migrate: migrateTurnWorkflowInputV1,
  to: 2,
};
