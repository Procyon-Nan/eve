import { describe, expect, it } from "vitest";

import { sessionInboxWire as sessionInboxWireEncoder } from "#execution/wire/session-inbox-encoder.js";
import {
  sessionInboxWire as sessionInboxWireDecoder,
  SessionInboxWireError,
} from "#execution/wire/session-inbox-wire.js";
import { sessionInboxWireV2Schema } from "#execution/wire/session-inbox-wire.v2.js";

describe("session inbox wire v2", () => {
  it("durably round-trips the host-runtime command unit", () => {
    const hostRuntime = {
      acceptanceKey: "command-1",
      ownership: "root" as const,
      reference: { providerKind: "baigong-agent", value: "opaque-reference" },
    };
    const wire = sessionInboxWireEncoder.encode(
      { hostRuntime, kind: "send", payload: { message: "hello" } },
      { version: 2 },
    );

    expect(sessionInboxWireV2Schema.parse(JSON.parse(JSON.stringify(wire)))).toEqual(wire);
    expect(sessionInboxWireDecoder.decode(wire)).toEqual({
      auth: undefined,
      caller: undefined,
      hostRuntime,
      kind: "deliver",
      payloads: [{ message: "hello" }],
      requestId: undefined,
    });
  });

  it("fails closed instead of dropping a host-runtime handoff for older consumers", () => {
    const command = {
      hostRuntime: {
        acceptanceKey: "command-1",
        ownership: "root" as const,
        reference: { providerKind: "baigong-agent", value: "opaque-reference" },
      },
      kind: "send" as const,
      payload: { message: "hello" },
    };

    expect(() => sessionInboxWireEncoder.encode(command, { version: 1 })).toThrow(
      SessionInboxWireError,
    );
    expect(() => sessionInboxWireEncoder.encode(command, { variant: "send", version: 0 })).toThrow(
      SessionInboxWireError,
    );
  });

  it.each([
    ["provider kind", { providerKind: "UPPERCASE", value: "opaque" }],
    ["empty reference", { providerKind: "baigong-agent", value: "" }],
    ["oversized reference", { providerKind: "baigong-agent", value: "x".repeat(513) }],
  ])("rejects a persisted host-runtime context with an invalid %s", (_name, reference) => {
    expect(() =>
      sessionInboxWireDecoder.decode({
        hostRuntime: {
          acceptanceKey: "command-1",
          ownership: "root",
          reference,
        },
        kind: "deliver",
        payloads: [{ message: "hello" }],
        version: 2,
      }),
    ).toThrow(SessionInboxWireError);
  });

  it("requires root acceptance keys and specialist lineage in persisted data", () => {
    const reference = { providerKind: "baigong-agent", value: "opaque" };
    for (const hostRuntime of [
      { ownership: "root", reference },
      { ownership: "specialist", reference },
    ]) {
      expect(() =>
        sessionInboxWireDecoder.decode({
          hostRuntime,
          kind: "deliver",
          payloads: [{ message: "hello" }],
          version: 2,
        }),
      ).toThrow(SessionInboxWireError);
    }
  });
});
