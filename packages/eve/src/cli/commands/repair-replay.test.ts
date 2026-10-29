import { describe, expect, it } from "vitest";
import { isBaigongStepIdentityFailure } from "./repair-replay.js";

function divergence(from: string, to: string) {
  return Object.assign(
    new Error(
      `Replay divergence: step event step_started for step_1 belongs to "${from}", but the current step consumer is "${to}"`,
    ),
    { name: "ReplayDivergenceError" },
  );
}

describe("failed replay maintenance allowlist", () => {
  it("recognizes a reviewed .2-to-.3 contract through an error cause", () => {
    const cause = divergence(
      "step//eve@0.40.0-baigong.2//createSessionStep",
      "step//eve@0.40.0-baigong.3//createSessionStep",
    );
    expect(isBaigongStepIdentityFailure(new Error("outer", { cause }))).toBe(true);
  });

  it.each([
    [
      "step//eve@0.40.0-baigong.2//createSessionStep",
      "step//eve@0.40.0-baigong.3//dispatchTurnStep",
    ],
    [
      "step//eve@0.40.0-baigong.1//createSessionStep",
      "step//eve@0.40.0-baigong.3//createSessionStep",
    ],
    ["step//eve@0.40.0-baigong.2//unreviewed", "step//eve@0.40.0-baigong.3//unreviewed"],
  ])("excludes unrelated divergence", (from, to) => {
    expect(isBaigongStepIdentityFailure(divergence(from, to))).toBe(false);
  });

  it("does not treat an event log gap as step identity incompatibility", () => {
    expect(
      isBaigongStepIdentityFailure(
        Object.assign(new Error("Event log has a hole at slot 12"), {
          name: "CorruptedEventLogError",
        }),
      ),
    ).toBe(false);
  });
});
