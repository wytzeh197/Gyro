import type { SessionEvent } from "@gyro-dev/ui";

function payload(event: SessionEvent) {
  return event.payload !== null &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : undefined;
}

function turnId(event: SessionEvent) {
  const value = payload(event);
  return event.turnId ?? value?.turnId ?? value?.sourceTurnId;
}

/** An old failure cannot replay a message after this chat has moved on. */
export function isChatRetryCurrent(
  events: readonly SessionEvent[],
  failure: SessionEvent,
) {
  const sourceTurn = turnId(failure);
  const user = events.findLast((event) => event.kind === "user-message");
  if (sourceTurn && user && (turnId(user) ?? user.id) !== sourceTurn) {
    return false;
  }
  const status = events.findLast((event) => {
    const value = payload(event);
    return event.kind === "system-event" && value?.kind === "provider-status";
  });
  if (
    !status ||
    (sourceTurn ? turnId(status) !== sourceTurn : status.id !== failure.id)
  ) {
    return false;
  }
  // The UI keeps a bounded tail. Hundreds of tool records can evict the
  // original user message while the latest failure still identifies its turn.
  // A later turn's work is evidence that an older failure has been superseded,
  // including the interval before that new turn's first status arrives.
  if (
    sourceTurn &&
    !user &&
    events.slice(events.indexOf(status) + 1).some((event) => {
      const eventTurn = turnId(event);
      return eventTurn && eventTurn !== sourceTurn;
    })
  )
    return false;
  return Boolean(
    status &&
    ["failed", "blocked", "cancelled"].includes(
      String(payload(status)?.status),
    ) &&
    (sourceTurn || !user || events.indexOf(user) < events.indexOf(status)),
  );
}

type RetryDispatchOptions = {
  isBusy: () => boolean;
  isCurrent: () => boolean;
  send: (isOwned: () => boolean) => Promise<boolean>;
  wait?: () => Promise<void>;
};

/** Reserve before awaiting, so a second click cannot clear a live sender. */
export function createChatRetryDispatcher() {
  const pending = new Map<string, { turnId: string | undefined }>();
  return {
    async dispatch(
      sessionId: string,
      retryTurnId: string | undefined,
      options: RetryDispatchOptions,
    ) {
      if (pending.has(sessionId)) return false;
      const ticket = { turnId: retryTurnId };
      pending.set(sessionId, ticket);
      const isOwned = () => pending.get(sessionId) === ticket;
      const wait =
        options.wait ??
        (() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
      try {
        // A failed stream frame can precede the original invoke's cleanup.
        // Wait for it rather than turn Retry into a queued, new user message.
        while (isOwned() && options.isCurrent() && options.isBusy()) {
          await wait();
        }
        if (!isOwned() || !options.isCurrent() || options.isBusy())
          return false;
        return await options.send(isOwned);
      } finally {
        if (isOwned()) pending.delete(sessionId);
      }
    },
    cancelSession(sessionId: string) {
      pending.delete(sessionId);
    },
    cancelAll() {
      pending.clear();
    },
  };
}
