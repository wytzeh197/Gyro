import type { ProviderChatStreamEvent, SessionEvent } from "@gyro-dev/ui";

function payload(event: SessionEvent): Record<string, unknown> {
  return event.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

/** Project native recovery onto its existing turn, without creating a send. */
export function applyNativeProviderRetryStatus(
  events: SessionEvent[],
  stream: ProviderChatStreamEvent,
): SessionEvent[] {
  if (!stream.turnId || !["retry-wait", "retry-started"].includes(stream.phase))
    return events;
  const waiting = stream.phase === "retry-wait";
  if (
    waiting &&
    (!stream.retryAt || !Number.isFinite(Date.parse(stream.retryAt)))
  )
    return events;
  let index = events.findLastIndex((event) => {
    const data = payload(event);
    return (
      event.sessionId === stream.sessionId &&
      (event.turnId ?? data.turnId) === stream.turnId &&
      event.kind === "system-event" &&
      data.kind === "provider-status"
    );
  });
  const next = events.slice();
  if (index < 0) {
    if (!waiting) return events;
    // Retry of a persisted turn may have an empty optimistic buffer. Retain a
    // status there so a disk refresh cannot erase the in-flight wait notice.
    index = next.length;
    next.push({
      id: `${stream.sessionId}-${stream.turnId}-native-recovery`,
      sessionId: stream.sessionId,
      turnId: stream.turnId,
      kind: "system-event",
      createdAt: stream.timelineCreatedAt ?? new Date().toISOString(),
      message: "Waiting to continue the saved work",
      payload: {
        kind: "provider-status",
        providerId: stream.providerId,
        modelId: stream.modelId,
      },
    });
  }
  const previous = next[index]!;
  next[index] = {
    ...previous,
    message:
      stream.message ??
      (waiting
        ? "Waiting to continue the saved work"
        : "Continuing the saved work"),
    payload: {
      ...payload(previous),
      status: waiting ? "waiting" : "running",
      completedAt: undefined,
      nativeRetry: waiting || undefined,
      retryAt: waiting ? stream.retryAt : undefined,
      retryAttempt: waiting ? stream.retryAttempt : undefined,
      retryMaxAttempts: waiting ? stream.retryMaxAttempts : undefined,
      recoveryKind: waiting ? stream.recoveryKind : undefined,
      recoveryMessage: undefined,
      error: waiting ? stream.error : undefined,
    },
  };
  return next;
}
