import { describe, expect, it } from "vitest";

import {
  HOST_RUNTIME_ATTACHMENT_REFERENCE_KEY,
  createHostRuntimeFilePart,
  parseHostRuntimeFilePart,
} from "#internal/attachments/host-runtime-refs.js";
import { HostRuntimeError } from "#runtime/host-runtime/errors.js";

const attachment = {
  filename: "diagram.png",
  mediaType: "image/png",
  size: 4,
  value: "file_123",
} as const;

describe("host runtime attachment references", () => {
  it("round-trips through JSON without storing file bytes", () => {
    const part = createHostRuntimeFilePart(attachment);
    const roundTripped = JSON.parse(JSON.stringify(part));

    expect(parseHostRuntimeFilePart(roundTripped)).toEqual(attachment);
    expect(JSON.stringify(roundTripped)).toContain("eve-attachment:");
    expect(JSON.stringify(roundTripped)).not.toContain("iVBOR");
  });

  it.each([
    { ...attachment, size: -1 },
    { ...attachment, size: 1.5 },
    { ...attachment, value: "" },
    { ...attachment, mediaType: "" },
    { ...attachment, filename: "" },
    { ...attachment, credential: "secret" },
  ])("rejects invalid public metadata %#", (input) => {
    expect(() => createHostRuntimeFilePart(input as typeof attachment)).toThrow(HostRuntimeError);
  });

  it("rejects malformed reserved references", () => {
    const part = createHostRuntimeFilePart(attachment);
    expect(() =>
      parseHostRuntimeFilePart({
        ...part,
        credentials: "must-not-survive",
      }),
    ).toThrowError(expect.objectContaining({ code: "HOST_RUNTIME_ATTACHMENT_REFERENCE_INVALID" }));
    expect(() =>
      parseHostRuntimeFilePart({
        ...part,
        data: {
          ...part.data,
          reference: {
            ...part.data.reference,
            extra: "provider-file-id",
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "HOST_RUNTIME_ATTACHMENT_REFERENCE_INVALID" }));
    expect(() =>
      parseHostRuntimeFilePart({
        ...part,
        data: {
          type: "reference",
          reference: { [HOST_RUNTIME_ATTACHMENT_REFERENCE_KEY]: "eve-attachment:?v=2&p=e30" },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "HOST_RUNTIME_ATTACHMENT_REFERENCE_INVALID" }));

    const encoded = new URL(part.data.reference[HOST_RUNTIME_ATTACHMENT_REFERENCE_KEY]);
    const payload = JSON.parse(
      Buffer.from(encoded.searchParams.get("p")!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    encoded.searchParams.set(
      "p",
      Buffer.from(JSON.stringify({ ...payload, credentials: "must-not-survive" }), "utf8").toString(
        "base64url",
      ),
    );
    expect(() =>
      parseHostRuntimeFilePart({
        ...part,
        data: {
          type: "reference",
          reference: { [HOST_RUNTIME_ATTACHMENT_REFERENCE_KEY]: encoded.href },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "HOST_RUNTIME_ATTACHMENT_REFERENCE_INVALID" }));
  });
});
