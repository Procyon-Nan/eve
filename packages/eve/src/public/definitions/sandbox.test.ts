import { describe, expect, expectTypeOf, it } from "vitest";

import {
  disableSandbox,
  isDisabledSandboxSentinel,
  type DisabledSandboxSentinel,
} from "#public/definitions/sandbox.js";

describe("disableSandbox", () => {
  it("returns the stable disabled sandbox sentinel", () => {
    const sentinel = disableSandbox();

    expect(sentinel).toEqual({ kind: "eve:disabled-sandbox" });
    expectTypeOf(sentinel).toEqualTypeOf<DisabledSandboxSentinel>();
  });

  it("recognizes only the exact sentinel shape", () => {
    expect(isDisabledSandboxSentinel(disableSandbox())).toBe(true);
    expect(isDisabledSandboxSentinel({ kind: "eve:disabled-sandbox", extra: true })).toBe(false);
    expect(isDisabledSandboxSentinel({ kind: "eve:disabled-tool" })).toBe(false);
    expect(isDisabledSandboxSentinel(null)).toBe(false);
  });
});
