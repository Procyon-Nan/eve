import { describe, expect, it } from "vitest";

import {
  enqueueHostRuntimeRelease,
  PENDING_HOST_RUNTIME_RELEASES_STATE_KEY,
  readPendingHostRuntimeReleases,
} from "#harness/host-runtime-releases.js";

const release = {
  outcome: "completed",
  parent: {
    callId: "call-1",
    rootSessionId: "root-session",
    sessionId: "parent-session",
    subagentName: "reviewer",
    turnId: "turn-1",
  },
  reference: { providerKind: "baigong-agent", value: "opaque-reference" },
  sessionId: "child-session",
} as const;

describe("host runtime release outbox", () => {
  it("deduplicates replayed settlement and rejects a changed terminal outcome", () => {
    const first = enqueueHostRuntimeRelease({}, release);
    expect(enqueueHostRuntimeRelease(first, release)).toBe(first);
    expect(() => enqueueHostRuntimeRelease(first, { ...release, outcome: "failed" })).toThrow(
      "cannot change",
    );
    expect(() =>
      enqueueHostRuntimeRelease(first, {
        ...release,
        reference: { ...release.reference, value: "different-reference" },
      }),
    ).toThrow("cannot change");
  });

  it("rejects corrupt durable entries instead of treating them as absent", () => {
    expect(() =>
      readPendingHostRuntimeReleases({
        state: { [PENDING_HOST_RUNTIME_RELEASES_STATE_KEY]: [{ ...release, secret: true }] },
      }),
    ).toThrow("Corrupt host runtime release outbox entry");
  });
});
