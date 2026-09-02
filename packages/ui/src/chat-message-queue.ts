/** A queued turn's delivery state, shared by the desktop scheduler and tests. */
export type QueuedMessageDelivery = {
  retryAt?: number;
  status: "failed" | "waiting" | "sending";
};

export type QueuedDeliverySelection<T extends QueuedMessageDelivery> =
  | {
      kind: "ready";
      message: T;
      sessionId: string;
    }
  | {
      kind: "waiting";
      retryAt: number;
    };

/**
 * Select a queue head without tying delivery to the currently visible chat.
 * A failed head intentionally keeps later messages in the same chat in order.
 */
export function selectQueuedMessageDelivery<T extends QueuedMessageDelivery>(
  queues: Record<string, T[]>,
  options: {
    dispatchingSessionIds: ReadonlySet<string>;
    now: number;
    sendingSessionIds: ReadonlySet<string>;
  },
): QueuedDeliverySelection<T> | undefined {
  const candidates = Object.entries(queues)
    .map(([sessionId, messages]) => ({
      sessionId,
      message: messages.find((message) => message.status !== "failed"),
    }))
    .filter(
      (candidate): candidate is { sessionId: string; message: T } =>
        Boolean(candidate.message) &&
        !options.sendingSessionIds.has(candidate.sessionId) &&
        !options.dispatchingSessionIds.has(candidate.sessionId),
    );
  const ready = candidates.find(
    ({ message }) => (message.retryAt ?? 0) <= options.now,
  );
  if (ready) return { kind: "ready", ...ready };
  if (candidates.length === 0) return undefined;
  return {
    kind: "waiting",
    retryAt: Math.min(
      ...candidates.map(({ message }) => message.retryAt ?? options.now),
    ),
  };
}
