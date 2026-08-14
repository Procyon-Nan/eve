import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import { sendCommandToDelivery } from "#execution/session-command-wire.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { readActiveRootHostRuntime } from "#execution/host-runtime-context.js";
import { installTurnHostRuntimeStep } from "#execution/host-runtime-context-step.js";

type NextSessionAction =
  | { readonly kind: "clear" }
  | { readonly kind: "compact" }
  | { readonly kind: "expired" }
  | { readonly kind: "reset" }
  | {
      readonly delivery: DeliverHookPayload | null;
      readonly kind: "delivery";
    };

/** What the parked driver should do with the next session activity. */
export type NextTurnInstruction =
  | { readonly kind: "clear"; readonly serializedContext: Record<string, unknown> }
  | { readonly kind: "compact"; readonly serializedContext: Record<string, unknown> }
  | { readonly kind: "expired"; readonly serializedContext: Record<string, unknown> }
  | { readonly kind: "reset"; readonly serializedContext: Record<string, unknown> }
  | { readonly kind: "closed"; readonly serializedContext: Record<string, unknown> }
  | { readonly kind: "cancel-turn"; readonly serializedContext: Record<string, unknown> }
  | {
      readonly kind: "turn";
      readonly deliver: DeliverHookPayload;
      readonly remainder: DeliverPayload;
      readonly serializedContext: Record<string, unknown>;
    };

/**
 * Awaits the next delivery that requires driver action while the session
 * is parked. Deliveries fully routed to a descendant leave the parent with
 * no turn to run, so this keeps waiting until a delivery produces a parent
 * turn, a cancellation, expiry, or hook closure. The wait is unbounded by
 * design: a parked session lives until something addresses it.
 */
export async function nextTurnDelivery(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly commandInbox: SessionCommandInbox;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly onSerializedContextChange: (serializedContext: Record<string, unknown>) => void;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<NextTurnInstruction> {
  let serializedContext = input.serializedContext;
  while (true) {
    const nextAction = await waitForNextSessionAction({
      bufferedDeliveries: input.bufferedDeliveries,
      bufferedSessionControls: input.bufferedSessionControls,
      commandInbox: input.commandInbox,
    });

    if (nextAction.kind !== "delivery") {
      return { kind: nextAction.kind, serializedContext };
    }

    const deliver = nextAction.delivery;
    if (deliver === null) {
      return { kind: "closed", serializedContext };
    }

    if (deliver.hostRuntime !== undefined || ownsTurnHostRuntime(serializedContext)) {
      serializedContext = await installTurnHostRuntimeStep({
        hostRuntime: deliver.hostRuntime,
        serializedContext,
      });
      input.onSerializedContextChange(serializedContext);
    }

    const routed = await routeDeliverToChildren({
      auth: deliver.auth,
      hostRuntime: readActiveRootHostRuntime(serializedContext),
      parentWritable: input.driverWritable,
      payloads: deliver.payloads,
      sessionState: input.sessionState,
    });

    if (routed.kind === "cancel-turn") {
      return { kind: "cancel-turn", serializedContext };
    }

    if (routed.remainder === undefined) {
      // Fully routed to a descendant; keep waiting.
      continue;
    }

    return { deliver, kind: "turn", remainder: routed.remainder, serializedContext };
  }
}

function ownsTurnHostRuntime(serializedContext: Record<string, unknown>): boolean {
  const hostRuntime = serializedContext["eve.hostRuntime"] as
    | { readonly ownership?: unknown }
    | undefined;
  return hostRuntime?.ownership === "root" || hostRuntime?.ownership === "inherited";
}

async function waitForNextSessionAction(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly commandInbox: SessionCommandInbox;
}): Promise<NextSessionAction> {
  const pendingSessionControl = input.bufferedSessionControls.shift();
  if (pendingSessionControl !== undefined) {
    return { kind: pendingSessionControl };
  }

  if (input.bufferedDeliveries.length > 0) {
    return {
      delivery: takeBufferedTurnDelivery(input.bufferedDeliveries),
      kind: "delivery",
    };
  }

  while (true) {
    const first = await input.commandInbox.next();
    input.commandInbox.consumeNext();

    if (first.done) {
      return { delivery: null, kind: "delivery" };
    }

    if (first.value.kind === "session-timeout") {
      return { kind: "expired" };
    }

    if (
      first.value.kind === "clear" ||
      first.value.kind === "compact" ||
      first.value.kind === "reset"
    ) {
      return { kind: first.value.kind };
    }

    if (first.value.kind === "cancel") {
      continue;
    }

    if (first.value.kind === "deliver") {
      return { delivery: first.value, kind: "delivery" };
    }

    return { delivery: sendCommandToDelivery(first.value), kind: "delivery" };
  }
}

function takeBufferedTurnDelivery(bufferedDeliveries: DeliverHookPayload[]): DeliverHookPayload {
  const first = bufferedDeliveries.shift();
  if (first === undefined) {
    throw new Error("Cannot take a turn delivery from an empty buffer.");
  }

  const turnDeliveries = [first];
  let caller = first.caller;
  while (bufferedDeliveries.length > 0) {
    const next = bufferedDeliveries[0];
    if (
      next === undefined ||
      (caller !== undefined && next.caller !== undefined) ||
      first.hostRuntime !== undefined ||
      next.hostRuntime !== undefined
    ) {
      break;
    }

    const delivery = bufferedDeliveries.shift();
    if (delivery === undefined) {
      throw new Error("Buffered turn delivery disappeared while partitioning.");
    }
    turnDeliveries.push(delivery);
    caller ??= delivery.caller;
  }

  return coalesceDeliveries(turnDeliveries);
}
