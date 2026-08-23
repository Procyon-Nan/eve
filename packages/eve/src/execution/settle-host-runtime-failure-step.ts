import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler } from "#channel/adapter.js";
import type { DeliverHookPayload } from "#channel/types.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { HostRuntimeContextKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import {
  emitRecoverableFailedTurn,
  emitTurnPreamble,
  getHarnessEmissionState,
  isHarnessBetweenTurns,
  setHarnessEmissionState,
} from "#harness/emission.js";
import type { HarnessEmitFn, StepInput } from "#harness/types.js";
import {
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { HostRuntimeErrorCode } from "#runtime/host-runtime/errors.js";
import { validateDurableHostRuntimeContext } from "#runtime/host-runtime/validation.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const SAFE_HOST_RUNTIME_FAILURE_MESSAGE =
  "The host runtime configuration for this turn is unavailable.";

/** Settles a deterministic root preflight failure while keeping the conversation available. */
export async function settleHostRuntimeFailureStep(input: {
  readonly code: HostRuntimeErrorCode;
  readonly delivery: DeliverHookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  const hostRuntime = validateDurableHostRuntimeContext(input.delivery.hostRuntime);
  if (hostRuntime.ownership !== "root" || hostRuntime.releasedOutcome !== undefined) {
    throw new Error("Recoverable host runtime failure is missing root turn ownership.");
  }
  ctx.set(HostRuntimeContextKey, hostRuntime);
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const adapter = ctx.require(ChannelKey);
  const adapterCtx = buildAdapterContext(adapter, ctx);
  let session = hydrateDurableSession({
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
    durable: durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  let emissionState = getHarnessEmissionState(session.state);
  const writer = input.parentWritable.getWriter();

  try {
    const scoped = await withContextScope(ctx, session, async (enrichedSession) => {
      const emit: HarnessEmitFn = async (event: UnstampedMessageStreamEvent) => {
        const transformed = await callAdapterEventHandler(adapter, event, adapterCtx);
        setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
        const stamped = stampMessageStreamEvent(transformed);
        await writer.write(encodeMessageStreamEvent(stamped));
        await dispatchStreamEventHooks({ ctx, event: stamped, registry: bundle.hookRegistry });
      };

      if (isHarnessBetweenTurns(enrichedSession)) {
        emissionState = await emitTurnPreamble(
          emit,
          coalesceDeliverPayloads(input.delivery.payloads) as StepInput,
          emissionState,
        );
      }
      emissionState = await emitRecoverableFailedTurn(emit, emissionState, {
        code: input.code,
        continuationToken: enrichedSession.continuationToken,
        message: SAFE_HOST_RUNTIME_FAILURE_MESSAGE,
      });
      return {
        result: undefined,
        session: setHarnessEmissionState(enrichedSession, emissionState),
      };
    });
    session = scoped.session;
  } finally {
    writer.releaseLock();
  }

  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session }),
  };
}
