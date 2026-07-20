import type { ProviderChatStreamEvent, SessionEvent } from "@gyro-dev/ui";

export const MAX_CHAT_RESPONSE_CHARS = 64_000;
export const CHAT_RESPONSE_TRUNCATION_SUFFIX = "...";
export const MAX_CHAT_EVENT_RENDER_COUNT = 400;
const MAX_PENDING_STREAM_EVENTS_PER_TURN = 64;
const MAX_STREAM_TURN_ORDER_STATES = 256;

type ProviderStreamSequence = {
  nextSequence: number;
  pending: Map<number, ProviderChatStreamEvent>;
  terminal: boolean;
};

export type ProviderStreamOrderState = Map<string, ProviderStreamSequence>;

export function orderProviderChatStreamEvent(
  state: ProviderStreamOrderState,
  event: ProviderChatStreamEvent,
) {
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
    return [event];
  }
  const key = `${event.sessionId}:${event.turnId ?? "turn"}`;
  let sequence = state.get(key);
  if (sequence?.terminal && event.phase === "started" && event.sequence === 0) {
    state.delete(key);
    sequence = undefined;
  }
  if (!sequence) {
    if (state.size >= MAX_STREAM_TURN_ORDER_STATES) {
      const oldestKey = state.keys().next().value;
      if (oldestKey) {
        state.delete(oldestKey);
      }
    }
    sequence = {
      nextSequence: event.phase === "started" ? 0 : event.sequence,
      pending: new Map(),
      terminal: false,
    };
    state.set(key, sequence);
  }
  if (sequence.terminal) {
    return [];
  }
  if (event.sequence < sequence.nextSequence) {
    return [];
  }
  if (!sequence.pending.has(event.sequence)) {
    sequence.pending.set(event.sequence, event);
  }
  const receivedTerminalEvent =
    event.phase === "completed" ||
    event.phase === "failed" ||
    event.phase === "cancelled";
  const recoverFromTerminalGap =
    receivedTerminalEvent && event.sequence > sequence.nextSequence;
  if (
    sequence.pending.size > MAX_PENDING_STREAM_EVENTS_PER_TURN &&
    !recoverFromTerminalGap
  ) {
    // Keep a permanently missing sequence from growing this buffer without
    // bound during a long-running provider turn.
    sequence.nextSequence = Math.min(...sequence.pending.keys());
  }

  const ordered: ProviderChatStreamEvent[] = [];
  if (recoverFromTerminalGap) {
    // A terminal event is the last chance to drain a turn. If an IPC message
    // was lost, preserve every event that did arrive and advance past gaps
    // instead of leaving the UI permanently stuck in a running state.
    const availableSequences = Array.from(sequence.pending.keys()).sort(
      (first, second) => first - second,
    );
    for (const availableSequence of availableSequences) {
      const next = sequence.pending.get(availableSequence);
      sequence.pending.delete(availableSequence);
      sequence.nextSequence = availableSequence + 1;
      if (next) {
        ordered.push(next);
      }
    }
  } else {
    while (sequence.pending.has(sequence.nextSequence)) {
      const next = sequence.pending.get(sequence.nextSequence);
      sequence.pending.delete(sequence.nextSequence);
      sequence.nextSequence += 1;
      if (next) {
        ordered.push(next);
      }
    }
  }
  if (
    ordered.some(
      (item) =>
        item.phase === "completed" ||
        item.phase === "failed" ||
        item.phase === "cancelled",
    )
  ) {
    sequence.pending.clear();
    sequence.terminal = true;
  }
  return ordered;
}

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
  const segmentedActivityTurnIds = new Set(
    optimisticEvents
      .filter((event) => {
        const payload = recordFromUnknown(event.payload);
        return (
          isProviderActivityEvent(event) &&
          payload?.activityKind === "commentary" &&
          typeof payload.activityId === "string" &&
          payload.activityId.includes("::continuation::") &&
          Boolean(event.turnId)
        );
      })
      .map((event) => event.turnId as string),
  );
  const merged = limitSessionEventsForUi(persistedEvents).filter(
    (event) =>
      !(
        event.turnId &&
        segmentedActivityTurnIds.has(event.turnId) &&
        isProviderActivityEvent(event)
      ),
  );
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
      if (!event.turnId) {
        userMessages.add(event.message);
      }
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
      (event.turnId
        ? userTurnIds.has(event.turnId)
        : userMessages.has(event.message));
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
        if (!event.turnId) {
          userMessages.add(event.message);
        }
      } else if (isProviderStatusEvent(event) && event.turnId) {
        providerStatusTurnIds.add(event.turnId);
      } else if (event.kind === "assistant-message" && event.turnId) {
        assistantTurnIds.add(event.turnId);
      } else if (isProviderActivityEvent(event)) {
        providerActivityKeys.add(providerActivityKey(event));
      }
    }
  }
  return limitSessionEventsForUi(
    merged.map((event) => {
      const optimistic = optimisticEvents.find((candidate) =>
        sameTimelineEvent(candidate, event),
      );
      return optimistic
        ? preserveFirstSeenTimelineMetadata(optimistic, event)
        : event;
    }),
  );
}

export function resetStreamingAssistantForRetry(
  events: SessionEvent[],
  turnId: string,
) {
  return events.filter((event) => {
    if (event.kind !== "assistant-message" || event.turnId !== turnId) {
      return true;
    }
    return recordFromUnknown(event.payload)?.streaming !== true;
  });
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
    if (isProviderActivityEvent(responseEvent)) {
      const responsePayload = recordFromUnknown(responseEvent.payload);
      const responseActivityId = responsePayload?.activityId;
      const responseLabel = responsePayload?.label;
      if (
        responsePayload?.activityKind === "commentary" &&
        typeof responseActivityId === "string" &&
        typeof responseLabel === "string"
      ) {
        const commentarySegments = merged.filter((event) => {
          const payload = recordFromUnknown(event.payload);
          return (
            event.turnId === responseEvent.turnId &&
            isProviderActivityEvent(event) &&
            payload?.activityKind === "commentary" &&
            typeof payload.activityId === "string" &&
            (payload.activityId === responseActivityId ||
              payload.activityId.startsWith(
                `${responseActivityId}::continuation::`,
              ))
          );
        });
        const segmentedLabel = commentarySegments
          .map((event) => {
            const payload = recordFromUnknown(event.payload);
            return typeof payload?.label === "string"
              ? payload.label
              : event.message;
          })
          .join("");
        if (commentarySegments.length > 1 && segmentedLabel === responseLabel) {
          continue;
        }
      }
    }
    const findMatchingEvent = (event: SessionEvent) => {
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
    };
    const existingIndex = isProviderStatusEvent(responseEvent)
      ? merged.findLastIndex(findMatchingEvent)
      : merged.findIndex(findMatchingEvent);
    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      if (!existing) {
        continue;
      }
      if (existing === responseEvent) {
        continue;
      }
      const next = merged.slice();
      next[existingIndex] =
        isProviderStatusEvent(existing) && isProviderStatusEvent(responseEvent)
          ? mergeProviderStatusAttemptTiming(existing, responseEvent)
          : preserveFirstSeenTimelineMetadata(existing, responseEvent);
      merged = next;
      continue;
    }
    merged = [...merged, responseEvent];
  }
  return merged;
}

function mergeProviderStatusAttemptTiming(
  current: SessionEvent,
  response: SessionEvent,
) {
  const currentPayload = recordFromUnknown(current.payload) ?? {};
  const responsePayload = recordFromUnknown(response.payload) ?? {};
  const startedAt =
    typeof responsePayload.startedAt === "string"
      ? responsePayload.startedAt
      : typeof currentPayload.startedAt === "string"
        ? currentPayload.startedAt
        : current.createdAt;
  const completedAt =
    typeof responsePayload.completedAt === "string"
      ? responsePayload.completedAt
      : response.createdAt;
  const startedAtMs = Date.parse(startedAt);
  const completedAtMs = Date.parse(completedAt);
  const durationMs =
    typeof responsePayload.durationMs === "number"
      ? responsePayload.durationMs
      : typeof currentPayload.durationMs === "number"
        ? currentPayload.durationMs
        : Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
          ? Math.max(0, completedAtMs - startedAtMs)
          : undefined;
  return {
    ...response,
    payload: {
      ...responsePayload,
      completedAt,
      durationMs,
      startedAt,
    },
  };
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

function sameTimelineEvent(first: SessionEvent, second: SessionEvent) {
  if (first.id === second.id) {
    return true;
  }
  if (!first.turnId || first.turnId !== second.turnId) {
    return false;
  }
  if (
    first.kind === "assistant-message" &&
    second.kind === "assistant-message"
  ) {
    return true;
  }
  return (
    isProviderActivityEvent(first) &&
    isProviderActivityEvent(second) &&
    providerActivityKey(first) === providerActivityKey(second)
  );
}

function preserveFirstSeenTimelineMetadata(
  firstSeen: SessionEvent,
  updated: SessionEvent,
): SessionEvent {
  const firstPayload = recordFromUnknown(firstSeen.payload) ?? {};
  const updatedPayload = recordFromUnknown(updated.payload) ?? {};
  const timelineSequence =
    typeof firstPayload.timelineSequence === "number"
      ? firstPayload.timelineSequence
      : typeof firstPayload.providerSequence === "number"
        ? firstPayload.providerSequence
        : undefined;
  return {
    ...updated,
    createdAt: firstSeen.createdAt,
    payload: {
      ...updatedPayload,
      ...(timelineSequence === undefined ? {} : { timelineSequence }),
    },
  };
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
    const createEvent = (
      id: string,
      nextActivityId: string,
      nextLabel: string,
    ): SessionEvent => ({
      id,
      sessionId: streamEvent.sessionId,
      turnId,
      createdAt: new Date().toISOString(),
      kind: "system-event",
      message: nextLabel,
      payload: {
        kind: "provider-activity",
        activityId: nextActivityId,
        activityKind: streamEvent.activityKind ?? "tool",
        label: nextLabel,
        detail: streamEvent.activityDetail,
        status: streamEvent.activityStatus ?? "done",
        providerId: streamEvent.providerId,
        modelId: streamEvent.modelId,
        providerSequence: streamEvent.sequence,
        timelineSequence: streamEvent.activitySequence ?? streamEvent.sequence,
        turnId,
      },
    });
    const nextEvent = createEvent(eventId, activityId, label);
    const existingIndex = items.findIndex((event) => event.id === eventId);
    if (existingIndex < 0) {
      return [...items, nextEvent];
    }
    if (streamEvent.activityKind === "commentary") {
      const continuationPrefix = `${eventId}-continuation-`;
      const segmentIndices = items.reduce<number[]>((indices, event, index) => {
        if (event.id === eventId || event.id.startsWith(continuationPrefix)) {
          indices.push(index);
        }
        return indices;
      }, []);
      const previousText = segmentIndices
        .map((index) => {
          const event = items[index];
          const payload = event ? recordFromUnknown(event.payload) : undefined;
          return typeof payload?.label === "string"
            ? payload.label
            : (event?.message ?? "");
        })
        .join("");
      const suffix = label.startsWith(previousText)
        ? label.slice(previousText.length)
        : "";
      const lastSegmentIndex = segmentIndices.at(-1) ?? existingIndex;
      const hasInterveningActivity = items
        .slice(lastSegmentIndex + 1)
        .some(
          (event) => event.turnId === turnId && isProviderActivityEvent(event),
        );
      if (suffix && hasInterveningActivity) {
        const continuationId = `${eventId}-continuation-${streamEvent.sequence}`;
        if (items.some((event) => event.id === continuationId)) {
          return items;
        }
        return [
          ...items,
          createEvent(
            continuationId,
            `${activityId}::continuation::${streamEvent.sequence}`,
            suffix,
          ),
        ];
      }
    }
    const next = items.slice();
    const existing = items[existingIndex];
    next[existingIndex] = existing
      ? preserveFirstSeenTimelineMetadata(existing, nextEvent)
      : nextEvent;
    return next;
  };
  optimisticEventsRef.current.set(
    streamEvent.sessionId,
    limitSessionEventsForUi(
      updateEvents(
        optimisticEventsRef.current.get(streamEvent.sessionId) ?? [],
      ),
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
        timelineSequence: streamEvent.sequence,
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
