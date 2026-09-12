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
/**
 * Move `messageId` to the head of the queue so Steer/Retry send it next.
 * Returns undefined when the id is not in this chat's queue.
 */
export function promoteQueuedMessage<T extends { id: string }>(
  messages: readonly T[],
  messageId: string,
): T[] | undefined {
  const index = messages.findIndex((item) => item.id === messageId);
  if (index < 0) return undefined;
  const selected = messages[index];
  if (!selected) return undefined;
  if (index === 0) return [...messages];
  return [selected, ...messages.slice(0, index), ...messages.slice(index + 1)];
}

export function selectQueuedMessageDelivery<T extends QueuedMessageDelivery>(
  queues: Record<string, T[]>,
  options: {
    dispatchingSessionIds: ReadonlySet<string>;
    now: number;
    pausedSessionIds?: ReadonlySet<string>;
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
        !options.pausedSessionIds?.has(candidate.sessionId) &&
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
