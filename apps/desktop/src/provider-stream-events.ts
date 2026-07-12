import type { ProviderChatStreamEvent, SessionEvent } from "@gyro-dev/ui";

export const MAX_CHAT_RESPONSE_CHARS = 64_000;
export const CHAT_RESPONSE_TRUNCATION_SUFFIX = "...";
export const MAX_CHAT_EVENT_RENDER_COUNT = 400;

type SessionEventsSetter = (
  value: SessionEvent[] | ((current: SessionEvent[]) => SessionEvent[]),
) => void;

type StreamDeltaEvent = {
  streamEvent: ProviderChatStreamEvent;
  textDelta: string;
  turnId: string;
};

type PendingStreamDeltaEvent = {
  chunks: string[];
  streamEvent: ProviderChatStreamEvent;
  turnId: string;
};

export function limitSessionEventsForUi(events: SessionEvent[]) {
  if (events.length <= MAX_CHAT_EVENT_RENDER_COUNT) {
    return events;
  }
  const sessionCreated = events.find(
    (event) => event.kind === "session-created",
  );
  const recentEvents = events.slice(
    Math.max(0, events.length - MAX_CHAT_EVENT_RENDER_COUNT),
  );
  if (
    sessionCreated &&
    !recentEvents.some((event) => event.id === sessionCreated.id)
  ) {
    return [sessionCreated, ...recentEvents.slice(1)];
  }
  return recentEvents;
}

export function mergePersistedAndOptimisticEvents(
  persistedEvents: SessionEvent[],
  optimisticEvents?: SessionEvent[],
) {
  if (!optimisticEvents || optimisticEvents.length === 0) {
    return persistedEvents;
  }
  const merged = limitSessionEventsForUi(persistedEvents);
  const seenEventIds = new Set<string>();
  const userTurnIds = new Set<string>();
  const userMessages = new Set<string>();
  const providerStatusTurnIds = new Set<string>();
  const assistantTurnIds = new Set<string>();
  const providerActivityKeys = new Set<string>();
  for (const event of merged) {
    seenEventIds.add(event.id);
    if (event.kind === "user-message") {
      if (event.turnId) {
        userTurnIds.add(event.turnId);
      }
      userMessages.add(event.message);
    } else if (isProviderStatusEvent(event) && event.turnId) {
      providerStatusTurnIds.add(event.turnId);
    } else if (event.kind === "assistant-message" && event.turnId) {
      assistantTurnIds.add(event.turnId);
    } else if (isProviderActivityEvent(event)) {
      providerActivityKeys.add(providerActivityKey(event));
    }
  }
  for (const event of optimisticEvents) {
    const hasSameId = seenEventIds.has(event.id);
    const hasSameTurnUser =
      event.kind === "user-message" &&
      ((event.turnId ? userTurnIds.has(event.turnId) : false) ||
        userMessages.has(event.message));
    const hasSameTurnProviderStatus =
      isProviderStatusEvent(event) &&
      Boolean(event.turnId && providerStatusTurnIds.has(event.turnId));
    const hasSameTurnAssistant =
      event.kind === "assistant-message" &&
      Boolean(event.turnId && assistantTurnIds.has(event.turnId));
    const hasSameProviderActivity =
      isProviderActivityEvent(event) &&
      providerActivityKeys.has(providerActivityKey(event));
    if (
      !hasSameId &&
      !hasSameTurnUser &&
      !hasSameTurnProviderStatus &&
      !hasSameTurnAssistant &&
      !hasSameProviderActivity
    ) {
      merged.push(event);
      seenEventIds.add(event.id);
      if (event.kind === "user-message") {
        if (event.turnId) {
          userTurnIds.add(event.turnId);
        }
        userMessages.add(event.message);
      } else if (isProviderStatusEvent(event) && event.turnId) {
        providerStatusTurnIds.add(event.turnId);
      } else if (event.kind === "assistant-message" && event.turnId) {
        assistantTurnIds.add(event.turnId);
      } else if (isProviderActivityEvent(event)) {
        providerActivityKeys.add(providerActivityKey(event));
      }
    }
  }
  return limitSessionEventsForUi(merged);
}

export function mergeProviderResponseEvents(
  currentEvents: SessionEvent[],
  responseEvents: SessionEvent[],
) {
  const completedAssistantMessages = new Set(
    responseEvents
      .filter((event) => event.kind === "assistant-message")
      .map((event) => event.message.trim()),
  );
  let merged = currentEvents.filter((event) => {
    if (!isProviderActivityEvent(event)) {
      return true;
    }
    const payload = recordFromUnknown(event.payload);
    return !(
      payload?.activityKind === "commentary" &&
      completedAssistantMessages.has(event.message.trim())
    );
  });
  for (const responseEvent of responseEvents) {
    const existingIndex = merged.findIndex((event) => {
      if (event.id === responseEvent.id) {
        return true;
      }
      if (event.turnId !== responseEvent.turnId) {
        return false;
      }
      if (isProviderStatusEvent(responseEvent)) {
        return isProviderStatusEvent(event);
      }
      if (responseEvent.kind === "assistant-message") {
        return event.kind === "assistant-message";
      }
      if (isProviderActivityEvent(responseEvent)) {
        return (
          isProviderActivityEvent(event) &&
          providerActivityKey(event) === providerActivityKey(responseEvent)
        );
      }
      return false;
    });
    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      if (existing === responseEvent) {
        continue;
      }
      const next = merged.slice();
      next[existingIndex] = responseEvent;
      merged = next;
      continue;
    }
    merged = [...merged, responseEvent];
  }
  return merged;
}

export function isProviderStatusEvent(event: SessionEvent) {
  const payload = recordFromUnknown(event.payload);
  return event.kind === "system-event" && payload?.kind === "provider-status";
}

export function isProviderActivityEvent(event: SessionEvent) {
  const payload = recordFromUnknown(event.payload);
  return event.kind === "system-event" && payload?.kind === "provider-activity";
}

function providerActivityKey(event: SessionEvent) {
  const payload = recordFromUnknown(event.payload);
  return `${event.turnId ?? "turn"}:${String(payload?.activityId ?? payload?.label ?? event.id)}`;
}

export function applyProviderChatStreamActivity(
  optimisticEventsRef: { current: Map<string, SessionEvent[]> },
  setEvents: SessionEventsSetter,
  streamEvent: ProviderChatStreamEvent,
) {
  const turnId = streamEvent.turnId ?? undefined;
  const label = streamEvent.activityLabel?.trim();
  if (!streamEvent.sessionId || !turnId || !label) {
    return;
  }
  const activityId = streamEvent.activityId ?? streamEvent.eventId;
  const eventId = `${streamEvent.sessionId}-activity-${turnId}-${activityId}`;
  const updateEvents = (items: SessionEvent[]) => {
    const nextEvent: SessionEvent = {
      id: eventId,
      sessionId: streamEvent.sessionId,
      turnId,
      createdAt: new Date().toISOString(),
      kind: "system-event",
      message: label,
      payload: {
        kind: "provider-activity",
        activityId,
        activityKind: streamEvent.activityKind ?? "tool",
        label,
        detail: streamEvent.activityDetail,
        status: streamEvent.activityStatus ?? "done",
        providerId: streamEvent.providerId,
        modelId: streamEvent.modelId,
        turnId,
      },
    };
    const existingIndex = items.findIndex((event) => event.id === eventId);
    if (existingIndex < 0) {
      return [...items, nextEvent];
    }
    const next = items.slice();
    next[existingIndex] = {
      ...nextEvent,
      createdAt: items[existingIndex]?.createdAt ?? nextEvent.createdAt,
    };
    return next;
  };
  optimisticEventsRef.current.set(
    streamEvent.sessionId,
    limitSessionEventsForUi(
      updateEvents(optimisticEventsRef.current.get(streamEvent.sessionId) ?? []),
    ),
  );
  setEvents((current) => {
    if (!current.some((event) => event.sessionId === streamEvent.sessionId)) {
      return current;
    }
    return limitSessionEventsForUi(updateEvents(current));
  });
}

export function applyProviderChatStreamDeltas(
  optimisticEventsRef: { current: Map<string, SessionEvent[]> },
  setEvents: SessionEventsSetter,
  streamEvents: ProviderChatStreamEvent[],
) {
  const coalescedDeltaEvents = new Map<string, PendingStreamDeltaEvent>();
  for (const streamEvent of streamEvents) {
    const turnId = streamEvent.turnId ?? undefined;
    const textDelta = streamEvent.textDelta ?? "";
    if (
      streamEvent.phase !== "delta" ||
      !streamEvent.sessionId ||
      !turnId ||
      textDelta === ""
    ) {
      continue;
    }
    const key = `${streamEvent.sessionId}:${turnId}`;
    const existing = coalescedDeltaEvents.get(key);
    if (existing) {
      existing.chunks.push(textDelta);
      existing.streamEvent = streamEvent;
      continue;
    }
    coalescedDeltaEvents.set(key, {
      chunks: [textDelta],
      streamEvent,
      turnId,
    });
  }
  const deltaEvents: StreamDeltaEvent[] = Array.from(
    coalescedDeltaEvents.values(),
    ({ chunks, streamEvent, turnId }) => ({
      streamEvent,
      textDelta: chunks.join(""),
      turnId,
    }),
  );
  if (deltaEvents.length === 0) {
    return;
  }
  const updatedSessionIds = new Set<string>();
  for (const { streamEvent, textDelta, turnId } of deltaEvents) {
    updatedSessionIds.add(streamEvent.sessionId);
    optimisticEventsRef.current.set(
      streamEvent.sessionId,
      limitSessionEventsForUi(
        upsertStreamingAssistantEvent(
          optimisticEventsRef.current.get(streamEvent.sessionId) ?? [],
          streamEvent,
          turnId,
          textDelta,
        ),
      ),
    );
  }
  setEvents((current) => {
    if (!current.some((event) => updatedSessionIds.has(event.sessionId))) {
      return current;
    }
    let next = current;
    for (const { streamEvent, textDelta, turnId } of deltaEvents) {
      next = upsertStreamingAssistantEvent(
        next,
        streamEvent,
        turnId,
        textDelta,
      );
    }
    return limitSessionEventsForUi(next);
  });
}

export function upsertStreamingAssistantEvent(
  events: SessionEvent[],
  streamEvent: ProviderChatStreamEvent,
  turnId: string,
  textDelta: string,
) {
  const eventId = `${streamEvent.sessionId}-assistant-${turnId}`;
  const existingIndex = events.findIndex(
    (event) =>
      event.kind === "assistant-message" &&
      event.turnId === turnId &&
      event.id === eventId,
  );
  if (existingIndex >= 0) {
    const existing = events[existingIndex];
    if (!existing) {
      return events;
    }
    const nextEvents = events.slice();
    nextEvents[existingIndex] = {
      ...existing,
      message: appendChatResponseDelta(existing.message, textDelta),
      payload: {
        ...(recordFromUnknown(existing.payload) ?? {}),
        kind: "provider-stream",
        providerId: streamEvent.providerId,
        modelId: streamEvent.modelId,
        streaming: true,
      },
    };
    return nextEvents;
  }
  return [
    ...events,
    {
      id: eventId,
      sessionId: streamEvent.sessionId,
      turnId,
      createdAt: new Date().toISOString(),
      kind: "assistant-message" as const,
      message: truncateChatResponse(textDelta),
      payload: {
        kind: "provider-stream",
        providerId: streamEvent.providerId,
        modelId: streamEvent.modelId,
        streaming: true,
      },
    },
  ];
}

export function appendChatResponseDelta(message: string, textDelta: string) {
  if (
    message.endsWith(CHAT_RESPONSE_TRUNCATION_SUFFIX) &&
    message.length >= MAX_CHAT_RESPONSE_CHARS
  ) {
    return message;
  }
  return truncateChatResponse(`${message}${textDelta}`);
}

export function truncateChatResponse(value: string) {
  if (value.length <= MAX_CHAT_RESPONSE_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_CHAT_RESPONSE_CHARS)}${CHAT_RESPONSE_TRUNCATION_SUFFIX}`;
}

function recordFromUnknown(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
