import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import {
  authSchema,
  callerSchema,
  deliverPayloadSchema,
  deliveryMetadataSchema,
} from "#execution/wire/session-inbox-wire.v1.js";
import {
  HOST_RUNTIME_PROVIDER_KIND_PATTERN,
  MAX_HOST_RUNTIME_ACCEPTANCE_KEY_LENGTH,
  MAX_HOST_RUNTIME_REFERENCE_VALUE_LENGTH,
} from "#runtime/host-runtime/validation.js";
import { formatValidationError } from "#runtime/validation.js";

const providerKindSchema = z.string().regex(HOST_RUNTIME_PROVIDER_KIND_PATTERN);
const acceptanceKeySchema = z
  .string()
  .min(1)
  .max(MAX_HOST_RUNTIME_ACCEPTANCE_KEY_LENGTH)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
      }),
    "Acceptance keys cannot contain control characters.",
  );
const nonEmptyLineageSchema = z.string().min(1);
const hostRuntimeReferenceSchema = z
  .object({
    providerKind: providerKindSchema,
    value: z.string().min(1).max(MAX_HOST_RUNTIME_REFERENCE_VALUE_LENGTH),
  })
  .strict();
const hostRuntimeParentSchema = z
  .object({
    callId: nonEmptyLineageSchema,
    rootSessionId: nonEmptyLineageSchema,
    sessionId: nonEmptyLineageSchema,
    subagentName: nonEmptyLineageSchema,
    turnId: nonEmptyLineageSchema,
  })
  .strict();
const hostRuntimeSchema = z
  .object({
    acceptanceKey: acceptanceKeySchema.optional(),
    ownership: z.enum(["root", "specialist", "inherited"]),
    parent: hostRuntimeParentSchema.optional(),
    reference: hostRuntimeReferenceSchema,
    releasedOutcome: z.enum(["completed", "failed", "cancelled", "start_failed"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ownership === "root" && value.acceptanceKey === undefined) {
      context.addIssue({
        code: "custom",
        message: "Root host-runtime contexts require an acceptance key.",
        path: ["acceptanceKey"],
      });
    }
    if (value.ownership === "specialist" && value.parent === undefined) {
      context.addIssue({
        code: "custom",
        message: "Specialist host-runtime contexts require parent lineage.",
        path: ["parent"],
      });
    }
  });

const VERSION = 2;
const version = z.literal(VERSION);

/** The complete schema for persisted session-inbox wire version 2. */
export const sessionInboxWireV2Schema = z.discriminatedUnion("kind", [
  z
    .object({
      auth: authSchema.nullable().optional(),
      caller: callerSchema.optional(),
      deliveryMetadata: z.array(deliveryMetadataSchema).optional(),
      hostRuntime: hostRuntimeSchema.optional(),
      kind: z.literal("deliver"),
      payload: deliverPayloadSchema.optional(),
      payloads: z.array(deliverPayloadSchema),
      requestId: z.string().optional(),
      taskDeliveryId: z.string().optional(),
      turnPolicy: z.enum(["queue", "steer"]).optional(),
      version,
    })
    .strict(),
  z.object({ kind: z.literal("session-timeout"), version }).strict(),
  z.object({ kind: z.literal("clear"), version }).strict(),
  z.object({ kind: z.literal("compact"), version }).strict(),
  z.object({ kind: z.literal("reset"), reason: z.string().optional(), version }).strict(),
  z
    .object({
      kind: z.literal("cancel"),
      taskId: z.string().optional(),
      turnId: z.string().optional(),
      version,
    })
    .strict(),
]);

export type SessionInboxWireV2 = z.infer<typeof sessionInboxWireV2Schema>;

/** Builds and validates one complete version-2 wire value. */
export function encodeSessionCommandV2(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV2 {
  const wire =
    command.kind === "send"
      ? {
          auth: command.auth,
          caller: command.caller,
          deliveryMetadata:
            command.delivery === undefined ? undefined : [{ ...command.delivery, payloadIndex: 0 }],
          hostRuntime: command.hostRuntime,
          kind: "deliver" as const,
          payload: command.payload,
          payloads: [command.payload],
          requestId: command.requestId,
          taskDeliveryId: command.taskDeliveryId,
          turnPolicy: command.turnPolicy,
          version: VERSION,
        }
      : command.kind === "deliver"
        ? {
            ...command,
            payload: coalesceDeliverPayloads(command.payloads),
            version: VERSION,
          }
        : { ...command, version: VERSION };
  const parsed = sessionInboxWireV2Schema.safeParse(wire);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version ${VERSION}: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}
