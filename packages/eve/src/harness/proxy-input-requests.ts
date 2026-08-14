import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { InputRequestKind } from "#runtime/input/types.js";
import type { HostRuntimeParentLineage } from "#shared/host-runtime.js";

const PROXY_INPUT_REQUESTS_KEY = "eve.runtime.proxyInputRequests";

const PROXY_INPUT_REQUEST_KINDS = {
  question: true,
  "session-limit": true,
  "tool-approval": true,
} satisfies Readonly<Record<InputRequestKind, true>>;

/** Routing and control metadata for one descendant-owned input request. */
export interface ProxyInputRequest {
  readonly childContinuationToken: string;
  readonly inheritedHostRuntimeParent?: HostRuntimeParentLineage;
  readonly kind: InputRequestKind;
}

/** `requestId → route` map stored on the parent session. */
type ProxyInputRequestMap = Readonly<Record<string, ProxyInputRequest>>;

/**
 * Returns the proxy-routing map as a fresh `Map`. Never returns a live
 * reference so accidental mutation cannot corrupt session state.
 */
export function getProxyInputRequests(
  state: SessionStateMap | undefined,
): ReadonlyMap<string, ProxyInputRequest> {
  return new Map(Object.entries(readMap(state)));
}

/**
 * Returns true when the session is currently proxying one or more
 * HITL requests on behalf of a descendant subagent.
 */
export function hasProxyInputRequests(state: SessionStateMap | undefined): boolean {
  for (const _ of Object.keys(readMap(state))) {
    return true;
  }
  return false;
}

/**
 * Replaces prior entries for `forChildContinuationToken` with the
 * provided ones. A child raising a fresh batch overwrites its prior
 * batch — the parent never keeps stale request metadata.
 */
export function upsertProxyInputRequests(input: {
  readonly entries: readonly (readonly [requestId: string, route: ProxyInputRequest])[];
  readonly forChildContinuationToken: string;
  readonly session: HarnessSession;
}): HarnessSession {
  const next: Record<string, ProxyInputRequest> = {};

  for (const [requestId, route] of Object.entries(readMap(input.session.state))) {
    if (route.childContinuationToken !== input.forChildContinuationToken) {
      next[requestId] = route;
    }
  }

  for (const [requestId, route] of input.entries) {
    next[requestId] = route;
  }

  return writeMap(input.session, next);
}

/**
 * Removes every entry for `childContinuationToken`. Called when a
 * child subagent finishes so stale clicks no longer route to it.
 */
export function clearProxyInputRequestsForChild(
  session: HarnessSession,
  childContinuationToken: string,
): HarnessSession {
  const current = readMap(session.state);
  const next: Record<string, ProxyInputRequest> = {};
  let changed = false;

  for (const [requestId, route] of Object.entries(current)) {
    if (route.childContinuationToken === childContinuationToken) {
      changed = true;
      continue;
    }
    next[requestId] = route;
  }

  if (!changed) {
    return session;
  }

  return writeMap(session, next);
}

/**
 * Removes every proxy entry. Called when a cancelled turn orphans its
 * descendants so stale HITL responses no longer route to them.
 */
export function clearAllProxyInputRequests(session: HarnessSession): HarnessSession {
  if (!hasProxyInputRequests(session.state)) {
    return session;
  }
  return writeMap(session, {});
}

/**
 * Projects a {@link SubagentInputRequestHookPayload} into the
 * `(requestId, route)` tuples the session stores.
 */
export function toProxyInputRequestEntries(
  payload: SubagentInputRequestHookPayload,
): readonly (readonly [requestId: string, route: ProxyInputRequest])[] {
  return payload.event.requests.map((request) => {
    const route: ProxyInputRequest = {
      childContinuationToken: payload.childContinuationToken,
      kind: request.kind,
    };
    if (payload.inheritedHostRuntimeParent !== undefined) {
      Object.assign(route, { inheritedHostRuntimeParent: payload.inheritedHostRuntimeParent });
    }
    return [request.requestId, route] as const;
  });
}

function readMap(state: SessionStateMap | undefined): ProxyInputRequestMap {
  const raw = state?.[PROXY_INPUT_REQUESTS_KEY];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const result: Record<string, ProxyInputRequest> = {};
  for (const [key, value] of Object.entries(raw)) {
    const request = parseProxyInputRequest(value);
    if (request !== undefined) {
      result[key] = request;
    }
  }
  return result;
}

function writeMap(
  session: HarnessSession,
  entries: Record<string, ProxyInputRequest>,
): HarnessSession {
  const state = { ...session.state };

  if (Object.keys(entries).length === 0) {
    delete state[PROXY_INPUT_REQUESTS_KEY];
    return {
      ...session,
      state: Object.keys(state).length > 0 ? state : undefined,
    };
  }

  state[PROXY_INPUT_REQUESTS_KEY] = entries;
  return { ...session, state };
}

function parseProxyInputRequest(value: unknown): ProxyInputRequest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (!("childContinuationToken" in value) || !("kind" in value)) {
    return undefined;
  }
  if (typeof value.childContinuationToken !== "string" || !isInputRequestKind(value.kind)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const inheritedHostRuntimeParent = parseHostRuntimeParentLineage(
    record.inheritedHostRuntimeParent,
  );
  if (record.inheritedHostRuntimeParent !== undefined && inheritedHostRuntimeParent === undefined) {
    return undefined;
  }
  const result: ProxyInputRequest = {
    childContinuationToken: value.childContinuationToken,
    kind: value.kind,
  };
  if (inheritedHostRuntimeParent !== undefined) {
    Object.assign(result, { inheritedHostRuntimeParent });
  }
  return result;
}

function parseHostRuntimeParentLineage(value: unknown): HostRuntimeParentLineage | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parent = value as Partial<HostRuntimeParentLineage>;
  if (
    !isNonEmptyString(parent.rootSessionId) ||
    !isNonEmptyString(parent.sessionId) ||
    !isNonEmptyString(parent.turnId) ||
    !isNonEmptyString(parent.callId) ||
    !isNonEmptyString(parent.subagentName)
  ) {
    return undefined;
  }
  return {
    callId: parent.callId,
    rootSessionId: parent.rootSessionId,
    sessionId: parent.sessionId,
    subagentName: parent.subagentName,
    turnId: parent.turnId,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isInputRequestKind(value: unknown): value is InputRequestKind {
  return typeof value === "string" && Object.hasOwn(PROXY_INPUT_REQUEST_KINDS, value);
}
