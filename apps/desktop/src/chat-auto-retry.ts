import type { SessionEvent } from "@gyro-dev/ui";

export const CHAT_AUTO_RETRY_DELAY_MS = 30_000;

export type AutoRetrySchedule = { retryAt: number };
export type ChatEventsBySession = Readonly<
  Record<string, readonly SessionEvent[]>
>;

const TRANSIENT_RECOVERY_KINDS = new Set([
  "model-capacity",
  "overloaded",
  "rate-limit",
  "server",
  "network",
  "offline",
  "temporarily-unavailable",
]);
const PERMANENT_RECOVERY_KINDS = new Set([
  "authentication",
  "login-expired",
  "plan-exhausted",
  "model-capacity-exhausted",
  "provider-config",
  "cli-contract",
  "capacity", // An output/tool budget, distinct from unavailable model capacity.
  "spend-ceiling",
  "tool-budget",
  "partial-answer",
  "cancelled",
  "stopped",
  "interrupted",
  "stalled",
]);
const PERMANENT_ERROR =
  /\b(?:unauthori[sz]ed|authentication|authentication_failed|credential|invalid api key|not logged in|login required|quota|insufficient_quota|credit|balance|billing|payment|budget|usage limit|token ceiling|per-call ceiling|tool.call limit|output exceeded|size limit|missing environment variable|subscription access|cancelled|canceled|stopped|interrupted|acp run timed out|acp run became inactive)\b|\bhttp\s+(?:400|401|402|403)\b|["']?(?:http_status|error_status|status)["']?\s*:\s*(?:400|401|402|403)\b/i;
const TRANSIENT_ERROR =
  /\b(?:selected model is at capacity|model (?:is (?:temporarily )?|temporarily )?at capacity|overloaded|overloaded_error|temporarily unavailable|internal server error|service unavailable|rate limit|too many requests|connection (?:reset|refused|failed)|broken pipe|network is unreachable|could not resolve host|dns|unexpected eof|eof while|timed out|timeout)\b|\bhttp\s+(?:408|429|500|502|503|504|529)\b|["']?(?:http_status|error_status|status)["']?\s*:\s*(?:408|429|500|502|503|504|529)\b/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(payload: Record<string, unknown> | undefined, key: string) {
  return typeof payload?.[key] === "string" ? payload[key] : undefined;
}

function eventTurnId(event: SessionEvent) {
  const payload = record(event.payload);
  return (
    event.turnId ?? text(payload, "turnId") ?? text(payload, "sourceTurnId")
  );
}

function isFailedStatus(event: SessionEvent) {
  const payload = record(event.payload);
  return (
    event.kind === "system-event" &&
    payload?.kind === "provider-status" &&
    payload.status === "failed"
  );
}

/** A short promise of upcoming work is safe to repeat; an answer is not. */
function isOnlyPreamble(event: SessionEvent) {
  const payload = record(event.payload);
  if (payload?.kind === "provider-response") return false;
  const message = event.message.trim();
  if (!message) return true;
  if (payload?.channel === "commentary") return true;
  if (
    message.length > 600 ||
    /```|\b(?:completed|finished|applied|changed|implemented|created|deleted|verified|found)\b/i.test(
      message,
    )
  ) {
    return false;
  }
  return message
    .split(/(?<=[.!?])\s+|\n\s*\n/)
    .filter(Boolean)
    .every((sentence) =>
      /^(?:I['’]ll\b|I will\b|I['’]m going to\b|Let me\b(?!\s+know))/i.test(
        sentence.trim(),
      ),
    );
}

function turnHasWorkOrAnswer(events: readonly SessionEvent[], turnId: string) {
  return events.some((event) => {
    if (eventTurnId(event) !== turnId || event.kind === "user-message") {
      return false;
    }
    // The host persists the user-selected mode before every ordinary send.
    // This is input context, not a model action or a partially delivered plan.
    if (event.kind === "chat-mode-changed") return false;
    if (event.kind === "assistant-message") return !isOnlyPreamble(event);
    if (event.kind !== "system-event") return true;
    const payload = record(event.payload);
    if (
      payload?.schema === "gyro.capability.v1" ||
      payload?.schema === "gyro.mutation.v1" ||
      payload?.schema === "gyro.provider-approval.v1"
    ) {
      return true;
    }
    if (payload?.kind === "provider-activity") {
      return !["commentary", "reasoning"].includes(
        text(payload, "activityKind") ?? "",
      );
    }
    return ![
      "provider-status",
      "provider-context-usage",
      "provider-turn-tokens",
      "workspace-context",
      "provider-diagnostics",
    ].includes(text(payload, "kind") ?? "");
  });
}

/** Only an unused, latest user turn can be resent without replaying its work. */
export function eligibleChatAutoRetryFailure(
  events: readonly SessionEvent[],
): SessionEvent | undefined {
  const user = events.findLast((event) => event.kind === "user-message");
  const turnId = user && eventTurnId(user);
  if (!user || !turnId || !user.message.trim()) return undefined;
  const status = events.findLast((event) => {
    const payload = record(event.payload);
    return (
      eventTurnId(event) === turnId &&
      event.kind === "system-event" &&
      payload?.kind === "provider-status"
    );
  });
  if (!status || !isFailedStatus(status)) return undefined;
  const payload = record(status.payload);
  const recoveryKind = text(payload, "recoveryKind");
  const error = `${text(payload, "error") ?? ""} ${status.message}`;
  if (
    /the model is still busy after (?:three|3) automatic attempts/i.test(
      error,
    ) ||
    (recoveryKind && PERMANENT_RECOVERY_KINDS.has(recoveryKind)) ||
    PERMANENT_ERROR.test(error) ||
    (!TRANSIENT_RECOVERY_KINDS.has(recoveryKind ?? "") &&
      !TRANSIENT_ERROR.test(error)) ||
    turnHasWorkOrAnswer(events, turnId)
  ) {
    return undefined;
  }
  return status;
}

/**
 * Observe failures, rather than infer retries from transcript age. A session's
 * initial history is seeded without action, and each turn gets at most one
 * automatic resend. No timers or dispatch live here, so the caller can recheck
 * the current transcript and busy sessions immediately before sending.
 */
export function createChatAutoRetryController() {
  const initializedSessions = new Set<string>();
  const seenFailures = new Set<string>();
  const failureTurns = new Map<string, string>();
  const usedTurns = new Set<string>();
  const pending = new Map<string, { event: SessionEvent; retryAt: number }>();
  const turnKey = (event: SessionEvent) =>
    `${event.sessionId}:${eventTurnId(event)}`;
  const failureKey = (event: SessionEvent) => `${event.sessionId}:${event.id}`;

  function prune(eventsBySessionId: ChatEventsBySession) {
    for (const [key, scheduled] of pending) {
      const current = eligibleChatAutoRetryFailure(
        eventsBySessionId[scheduled.event.sessionId] ?? [],
      );
      if (!current || turnKey(current) !== key) {
        pending.delete(key);
        usedTurns.add(key);
      } else {
        // Optimistic and persisted status events can have different ids. Keep
        // one deadline for their turn and point the UI at the current event.
        scheduled.event = current;
      }
    }
  }

  function schedules() {
    return Object.fromEntries(
      [...pending.values()].map(({ event, retryAt }) => [
        event.id,
        { retryAt },
      ]),
    );
  }

  return {
    observe(
      eventsBySessionId: ChatEventsBySession,
      now: number,
      _busySessionIds: ReadonlySet<string>,
    ): Record<string, AutoRetrySchedule> {
      prune(eventsBySessionId);
      for (const [sessionId, events] of Object.entries(eventsBySessionId)) {
        const initialHistory = !initializedSessions.has(sessionId);
        initializedSessions.add(sessionId);
        const failure = eligibleChatAutoRetryFailure(events);
        const isNew = failure && !seenFailures.has(failureKey(failure));
        for (const event of events) {
          if (isFailedStatus(event)) {
            seenFailures.add(failureKey(event));
            failureTurns.set(event.id, turnKey(event));
          }
        }
        if (initialHistory || !failure || !isNew) continue;
        const key = turnKey(failure);
        if (usedTurns.has(key) || pending.has(key)) continue;
        pending.set(key, {
          event: failure,
          retryAt: now + CHAT_AUTO_RETRY_DELAY_MS,
        });
      }
      return schedules();
    },
    takeDue(
      eventsBySessionId: ChatEventsBySession,
      now: number,
      busySessionIds: ReadonlySet<string>,
    ): SessionEvent[] {
      prune(eventsBySessionId);
      const due: SessionEvent[] = [];
      for (const [key, scheduled] of pending) {
        if (
          scheduled.retryAt > now ||
          busySessionIds.has(scheduled.event.sessionId)
        ) {
          continue;
        }
        // Consume before dispatch: synchronous updates and duplicate terminal
        // frames cannot spend another automatic attempt for this turn.
        pending.delete(key);
        usedTurns.add(key);
        due.push(scheduled.event);
      }
      return due;
    },
    cancel(eventId: string) {
      const key = failureTurns.get(eventId);
      if (key) {
        pending.delete(key);
        usedTurns.add(key);
      }
    },
    cancelSession(sessionId: string) {
      for (const [key, scheduled] of pending) {
        if (scheduled.event.sessionId !== sessionId) continue;
        pending.delete(key);
        usedTurns.add(key);
      }
    },
  };
}
