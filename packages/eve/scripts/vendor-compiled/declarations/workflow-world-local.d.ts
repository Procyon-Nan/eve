import type { QueuePrefix, World } from "#compiled/@workflow/world/index.js";

export type LocalWorld = World & {
  clear(): Promise<void>;
  queueRecovery: World["queue"];
  startRecovery(): void;
  registerHandler(prefix: QueuePrefix, handler: (request: Request) => Promise<Response>): void;
};

export function createWorld(options?: {
  readonly baseUrl?: string;
  readonly dataDir?: string;
  readonly deferRecovery?: boolean;
  readonly recoverActiveRuns?: boolean;
  readonly streamFlushIntervalMs?: number;
  readonly tag?: string;
}): LocalWorld;

export function resolveRecoverActiveRuns(options: { recoverActiveRuns?: boolean }): boolean;
