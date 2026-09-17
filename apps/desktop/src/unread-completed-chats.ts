import { useCallback, useEffect, useRef, useState } from "react";

/** Outcome ids whose completed turn the user has already opened. */
export const ACKNOWLEDGED_COMPLETED_OUTCOMES_STORAGE_KEY =
  "gyro.acknowledged-completed-chat-outcomes";
export const MAX_ACKNOWLEDGED_COMPLETED_OUTCOMES = 200;
const MAX_STORED_ACKNOWLEDGED_OUTCOMES_CHARS = 32_000;

type CompletedChatEvent = {
  id: string;
  kind: string;
  createdAt: string;
  turnId?: string | null;
  payload?: unknown;
};

export type CompletedChatTracking = {
  unreadIds: string[];
  acknowledgedOutcomeIds: string[];
};

function payloadRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Identify a completed chat by its turn, not the status event id. Optimistic
 * and persisted "done" events for the same turn must share this id, otherwise
 * a later refresh would resurrect the unread blue dot after the chat was opened.
 */
export function completedChatOutcomeId(
  sessionId: string,
  event: { id: string; turnId?: string | null },
): string {
  return `chat:${sessionId}:${event.turnId || event.id}`;
}

export function latestCompletedChatOutcomeId(
  sessionId: string,
  events: readonly CompletedChatEvent[],
): string | undefined {
  let latest: { id: string; finishedAt: number } | undefined;
  for (const event of events) {
    if (event.kind !== "system-event") continue;
    const payload = payloadRecord(event.payload);
    if (payload?.kind !== "provider-status") continue;
    const status = payload.status;
    if (status !== "done" && status !== "failed" && status !== "cancelled") {
      continue;
    }
    const finishedAtValue =
      typeof payload.completedAt === "string"
        ? payload.completedAt
        : event.createdAt;
    const finishedAt = Date.parse(finishedAtValue);
    const id = completedChatOutcomeId(sessionId, event);
    if (
      !latest ||
      (Number.isFinite(finishedAt) && finishedAt > latest.finishedAt)
    ) {
      latest = {
        id,
        finishedAt: Number.isFinite(finishedAt) ? finishedAt : 0,
      };
    }
  }
  return latest?.id;
}

export function parseAcknowledgedCompletedOutcomeIds(
  stored: string | undefined,
): string[] {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed
          .filter((id): id is string => typeof id === "string" && id.length > 0)
          .slice(0, MAX_ACKNOWLEDGED_COMPLETED_OUTCOMES)
      : [];
  } catch {
    return [];
  }
}

export function rememberAcknowledgedCompletedOutcome(
  acknowledgedOutcomeIds: readonly string[],
  outcomeId: string,
): string[] {
  return [
    outcomeId,
    ...acknowledgedOutcomeIds.filter((id) => id !== outcomeId),
  ].slice(0, MAX_ACKNOWLEDGED_COMPLETED_OUTCOMES);
}

export function markUnreadCompletedChat(
  unreadIds: readonly string[],
  sessionId: string,
  options: {
    acknowledgedOutcomeIds: readonly string[];
    isViewing: boolean;
    outcomeId: string;
  },
): string[] {
  if (options.isViewing) {
    return unreadIds.includes(sessionId)
      ? unreadIds.filter((id) => id !== sessionId)
      : [...unreadIds];
  }
  if (options.acknowledgedOutcomeIds.includes(options.outcomeId)) {
    return unreadIds.includes(sessionId)
      ? unreadIds.filter((id) => id !== sessionId)
      : [...unreadIds];
  }
  return unreadIds.includes(sessionId)
    ? [...unreadIds]
    : [sessionId, ...unreadIds];
}

export function acknowledgeCompletedChat(
  unreadIds: readonly string[],
  acknowledgedOutcomeIds: readonly string[],
  sessionId: string,
  outcomeId?: string,
): CompletedChatTracking {
  return {
    unreadIds: unreadIds.filter((id) => id !== sessionId),
    acknowledgedOutcomeIds: outcomeId
      ? rememberAcknowledgedCompletedOutcome(acknowledgedOutcomeIds, outcomeId)
      : [...acknowledgedOutcomeIds],
  };
}

export function forgetCompletedChat(
  unreadIds: readonly string[],
  acknowledgedOutcomeIds: readonly string[],
  sessionId: string,
): CompletedChatTracking {
  const prefix = `chat:${sessionId}:`;
  return {
    unreadIds: unreadIds.filter((id) => id !== sessionId),
    acknowledgedOutcomeIds: acknowledgedOutcomeIds.filter(
      (id) => !id.startsWith(prefix),
    ),
  };
}

function loadAcknowledgedCompletedOutcomeIds(): string[] {
  try {
    const stored = window.localStorage.getItem(
      ACKNOWLEDGED_COMPLETED_OUTCOMES_STORAGE_KEY,
    );
    if (!stored || stored.length > MAX_STORED_ACKNOWLEDGED_OUTCOMES_CHARS) {
      return [];
    }
    return parseAcknowledgedCompletedOutcomeIds(stored);
  } catch {
    return [];
  }
}

function persistAcknowledgedCompletedOutcomeIds(ids: string[]) {
  try {
    window.localStorage.setItem(
      ACKNOWLEDGED_COMPLETED_OUTCOMES_STORAGE_KEY,
      JSON.stringify(ids),
    );
  } catch {
    // Preview and restricted contexts can refuse localStorage.
  }
}

/**
 * Sidebar blue-dot state for chats that finished in the background.
 * Opening a chat remembers that completion so a later persisted "done" event
 * cannot bring the dot back; a newer turn can.
 */
export function useUnreadCompletedChats(
  sessionEventsById: Record<string, CompletedChatEvent[]>,
) {
  const [unreadCompletedSessionIds, setUnreadCompletedSessionIds] = useState<
    string[]
  >([]);
  const [acknowledgedOutcomeIds, setAcknowledgedOutcomeIds] = useState(
    loadAcknowledgedCompletedOutcomeIds,
  );
  const acknowledgedOutcomeIdsRef = useRef(acknowledgedOutcomeIds);
  acknowledgedOutcomeIdsRef.current = acknowledgedOutcomeIds;
  const sessionEventsByIdRef = useRef(sessionEventsById);
  sessionEventsByIdRef.current = sessionEventsById;

  useEffect(() => {
    persistAcknowledgedCompletedOutcomeIds(acknowledgedOutcomeIds);
  }, [acknowledgedOutcomeIds]);

  const markUnreadCompletedChatIfNeeded = useCallback(
    (sessionId: string, options: { isViewing: boolean; outcomeId: string }) => {
      if (options.isViewing) {
        const nextAcknowledged = rememberAcknowledgedCompletedOutcome(
          acknowledgedOutcomeIdsRef.current,
          options.outcomeId,
        );
        acknowledgedOutcomeIdsRef.current = nextAcknowledged;
        setAcknowledgedOutcomeIds(nextAcknowledged);
      }
      setUnreadCompletedSessionIds((current) =>
        markUnreadCompletedChat(current, sessionId, {
          acknowledgedOutcomeIds: acknowledgedOutcomeIdsRef.current,
          isViewing: options.isViewing,
          outcomeId: options.outcomeId,
        }),
      );
    },
    [],
  );

  const acknowledgeFinishedChat = useCallback((sessionId: string) => {
    const outcomeId = latestCompletedChatOutcomeId(
      sessionId,
      sessionEventsByIdRef.current[sessionId] ?? [],
    );
    const next = acknowledgeCompletedChat(
      [],
      acknowledgedOutcomeIdsRef.current,
      sessionId,
      outcomeId,
    );
    acknowledgedOutcomeIdsRef.current = next.acknowledgedOutcomeIds;
    setAcknowledgedOutcomeIds(next.acknowledgedOutcomeIds);
    setUnreadCompletedSessionIds((current) =>
      current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : current,
    );
  }, []);

  const forgetUnreadCompletedChat = useCallback((sessionId: string) => {
    const next = forgetCompletedChat(
      [],
      acknowledgedOutcomeIdsRef.current,
      sessionId,
    );
    acknowledgedOutcomeIdsRef.current = next.acknowledgedOutcomeIds;
    setAcknowledgedOutcomeIds(next.acknowledgedOutcomeIds);
    setUnreadCompletedSessionIds((current) =>
      current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : current,
    );
  }, []);

  const clearUnreadCompletedChat = useCallback((sessionId: string) => {
    setUnreadCompletedSessionIds((current) =>
      current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : current,
    );
  }, []);

  return {
    unreadCompletedSessionIds,
    acknowledgeFinishedChat,
    markUnreadCompletedChatIfNeeded,
    forgetUnreadCompletedChat,
    clearUnreadCompletedChat,
  };
}
