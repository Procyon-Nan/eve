/** Persisted execution state, independent of the session's message stream. */
export interface SessionExecutionStatus {
  readonly sessionId: string;
  readonly executionStatus: "pending" | "running" | "completed" | "failed" | "cancelled";
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
}
