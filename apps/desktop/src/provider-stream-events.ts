import type { ProviderChatStreamEvent, SessionEvent } from "@gyro-dev/ui";

export const MAX_CHAT_RESPONSE_CHARS = 64_000;
export const CHAT_RESPONSE_TRUNCATION_SUFFIX = "...";
/** Default open window — keeps the first paint cheap. */
export const MAX_CHAT_EVENT_RENDER_COUNT = 400;
/**
 * After the user loads earlier history, keep a larger in-memory window so the
 * 400-cap does not immediately drop the older page they just requested.
 */
export const MAX_CHAT_EVENT_HOLD_COUNT = 2_500;
/**
 * How many out-of-order events a turn may hold before the missing sequence is
 * treated as lost. The previous bound of 64 worked for dense token streams but
 * left tool-sparse turns frozen for a long time when a single IPC frame dropped
 * — the rail stopped while the backend kept working. A smaller bound recovers
 * mid-turn without waiting for the terminal event.
 */
const MAX_PENDING_STREAM_EVENTS_PER_TURN = 8;
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

export function limitSessionEventsForUi(
  events: SessionEvent[],
  maxEvents: number = MAX_CHAT_EVENT_RENDER_COUNT,
) {
  if (events.length <= maxEvents) {
    return events;
  }
  const sessionCreated = events.find(
    (event) => event.kind === "session-created",
  );
  const recentEvents = events.slice(Math.max(0, events.length - maxEvents));
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
      .map((event) => `${event.sessionId}:${event.turnId}`),
  );
  const merged = limitSessionEventsForUi(persistedEvents).filter(
    (event) =>
      !(
        event.turnId &&
        segmentedActivityTurnIds.has(`${event.sessionId}:${event.turnId}`) &&
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
    const scopedId = `${event.sessionId}:${event.id}`;
    const scopedTurn = `${event.sessionId}:${event.turnId}`;
    const scopedMessage = `${event.sessionId}:${event.message}`;
    seenEventIds.add(scopedId);
    if (event.kind === "user-message") {
      if (event.turnId) {
        userTurnIds.add(scopedTurn);
      }
      if (!event.turnId) {
        userMessages.add(scopedMessage);
      }
    } else if (isProviderStatusEvent(event) && event.turnId) {
      providerStatusTurnIds.add(scopedTurn);
    } else if (event.kind === "assistant-message" && event.turnId) {
      assistantTurnIds.add(scopedTurn);
    } else if (isProviderActivityEvent(event)) {
      providerActivityKeys.add(providerActivityKey(event));
    }
  }
  for (const event of optimisticEvents) {
    const scopedId = `${event.sessionId}:${event.id}`;
    const scopedTurn = `${event.sessionId}:${event.turnId}`;
    const scopedMessage = `${event.sessionId}:${event.message}`;
    const hasSameId = seenEventIds.has(scopedId);
    const hasSameTurnUser =
      event.kind === "user-message" &&
      (event.turnId
        ? userTurnIds.has(scopedTurn)
        : userMessages.has(scopedMessage));
    const hasSameTurnProviderStatus =
      isProviderStatusEvent(event) &&
      Boolean(event.turnId && providerStatusTurnIds.has(scopedTurn));
    const hasSameTurnAssistant =
      event.kind === "assistant-message" &&
      Boolean(event.turnId && assistantTurnIds.has(scopedTurn));
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
      seenEventIds.add(scopedId);
      if (event.kind === "user-message") {
        if (event.turnId) {
          userTurnIds.add(scopedTurn);
        }
        if (!event.turnId) {
          userMessages.add(scopedMessage);
        }
      } else if (isProviderStatusEvent(event) && event.turnId) {
        providerStatusTurnIds.add(scopedTurn);
      } else if (event.kind === "assistant-message" && event.turnId) {
        assistantTurnIds.add(scopedTurn);
      } else if (isProviderActivityEvent(event)) {
        providerActivityKeys.add(providerActivityKey(event));
      }
    }
  }
  const timelineIndex = buildTimelineIndex(optimisticEvents);
  const timeline = [...merged, ...optimisticEvents];
  return limitSessionEventsForUi(
    merged.map((event) => {
      const optimistic = findTimelineMatch(timelineIndex, event);
      return optimistic
        ? preserveFirstSeenTimelineMetadata(optimistic, event, timeline)
        : event;
    }),
  );
}

type TimelineMatch = { event: SessionEvent; index: number };

type TimelineIndex = {
  byId: Map<string, TimelineMatch>;
  assistantByTurn: Map<string, TimelineMatch>;
  activityByKey: Map<string, TimelineMatch>;
};

/// Index optimistic events by each rule `sameTimelineEvent` matches on.
///
/// It replaces a linear scan run once per persisted event, with payload parsing
/// inside the comparison — quadratic in the render window, on the path every
/// session open takes. A full window against a full set of optimistic events
/// was on the order of a hundred thousand comparisons to place a handful of
/// matches.
///
/// Each map keeps the earliest candidate and the lookup takes the earliest
/// across all three, so the match is still the one `find` would have returned.
export function buildTimelineIndex(events: SessionEvent[]): TimelineIndex {
  const byId = new Map<string, TimelineMatch>();
  const assistantByTurn = new Map<string, TimelineMatch>();
  const activityByKey = new Map<string, TimelineMatch>();
  events.forEach((event, index) => {
    const match = { event, index };
    const scopedId = `${event.sessionId}:${event.id}`;
    const scopedTurn = `${event.sessionId}:${event.turnId}`;
    if (!byId.has(scopedId)) {
      byId.set(scopedId, match);
    }
    // `sameTimelineEvent` requires the candidate's own turn id before it will
    // match on anything but the event id.
    if (!event.turnId) {
      return;
    }
    if (event.kind === "assistant-message") {
      if (!assistantByTurn.has(scopedTurn)) {
        assistantByTurn.set(scopedTurn, match);
      }
    } else if (isProviderActivityEvent(event)) {
      const key = providerActivityKey(event);
      if (!activityByKey.has(key)) {
        activityByKey.set(key, match);
      }
    }
  });
  return { byId, assistantByTurn, activityByKey };
}

export function findTimelineMatch(index: TimelineIndex, event: SessionEvent) {
  let earliest = index.byId.get(`${event.sessionId}:${event.id}`);
  if (event.turnId) {
    const keyed =
      event.kind === "assistant-message"
        ? index.assistantByTurn.get(`${event.sessionId}:${event.turnId}`)
        : isProviderActivityEvent(event)
          ? index.activityByKey.get(providerActivityKey(event))
          : undefined;
    if (keyed && (!earliest || keyed.index < earliest.index)) {
      earliest = keyed;
    }
  }
  return earliest?.event;
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
      .map((event) =>
        JSON.stringify([event.sessionId, event.turnId, event.message.trim()]),
      ),
  );
  let merged = currentEvents.filter((event) => {
    if (!isProviderActivityEvent(event)) {
      return true;
    }
    const payload = recordFromUnknown(event.payload);
    return !(
      payload?.activityKind === "commentary" &&
      completedAssistantMessages.has(
        JSON.stringify([event.sessionId, event.turnId, event.message.trim()]),
      )
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
            event.sessionId === responseEvent.sessionId &&
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
      if (event.sessionId !== responseEvent.sessionId) {
        return false;
      }
      if (event.id === responseEvent.id) {
        return true;
      }
      if (!event.turnId || event.turnId !== responseEvent.turnId) {
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
          : preserveFirstSeenTimelineMetadata(existing, responseEvent, merged);
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
  return `${event.sessionId}:${event.turnId ?? "turn"}:${String(payload?.activityId ?? payload?.label ?? event.id)}`;
}

/// The match rule `buildTimelineIndex` encodes.
///
/// Kept as the readable statement of the rule, and exported so the index can be
/// checked against it directly rather than against a description of it.
export function sameTimelineEvent(first: SessionEvent, second: SessionEvent) {
  if (first.sessionId !== second.sessionId) {
    return false;
  }
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
  timeline: SessionEvent[],
): SessionEvent {
  const firstPayload = recordFromUnknown(firstSeen.payload) ?? {};
  const updatedPayload = recordFromUnknown(updated.payload) ?? {};
  // A durable final reply can replace a title, partial stream, or preamble.
  // Its text is different, so neither the old offsets nor its early position
  // describe this answer. Live and durable sequences also use different
  // counters: place the replacement after this turn's observed work.
  if (
    updated.kind === "assistant-message" &&
    updatedPayload.kind === "provider-response" &&
    (firstSeen.message !== updated.message ||
      (!Array.isArray(updatedPayload.segments) &&
        (!Array.isArray(firstPayload.segments) ||
          firstPayload.segments.length < 2)))
  ) {
    let lastSequence = 0;
    for (const event of timeline) {
      if (
        event.sessionId !== updated.sessionId ||
        event.turnId !== updated.turnId ||
        event.kind === "assistant-message"
      ) {
        continue;
      }
      const payload = recordFromUnknown(event.payload);
      for (const sequence of [
        payload?.timelineSequence,
        payload?.providerSequence,
      ]) {
        if (typeof sequence === "number" && Number.isSafeInteger(sequence)) {
          lastSequence = Math.max(lastSequence, sequence);
        }
      }
    }
    return {
      ...updated,
      payload: {
        ...updatedPayload,
        timelineSequence: Math.max(
          lastSequence + 1,
          typeof updatedPayload.timelineSequence === "number"
            ? updatedPayload.timelineSequence
            : 0,
        ),
      },
    };
  }
  const timelineSequence =
    typeof firstPayload.timelineSequence === "number"
      ? firstPayload.timelineSequence
      : typeof firstPayload.providerSequence === "number"
        ? firstPayload.providerSequence
        : undefined;
  // Only the stream saw where each block of a turn's text began. The durable
  // response is that same text concatenated, so the marks stay valid and the
  // preambles keep their place instead of collapsing back into the answer.
  const segments =
    updated.kind === "assistant-message" &&
    !Array.isArray(updatedPayload.segments) &&
    Array.isArray(firstPayload.segments)
      ? firstPayload.segments
      : undefined;
  return {
    ...updated,
    createdAt: firstSeen.createdAt,
    payload: {
      ...updatedPayload,
      ...(timelineSequence === undefined ? {} : { timelineSequence }),
      ...(segments === undefined ? {} : { segments }),
    },
  };
}

/**
 * When a turn settles (completed / failed / cancelled), close any optimistic
 * activities still marked running. Providers often never send a final status
 * frame for in-flight tools; without this the rail keeps breathing after the
 * turn is done for every runner that streams activities.
 */
export function settleOpenProviderActivitiesForTurn(
  optimisticEventsRef: { current: Map<string, SessionEvent[]> },
  setEvents: SessionEventsSetter,
  sessionId: string,
  turnId: string,
) {
  const updateEvents = (items: SessionEvent[]) => {
    let changed = false;
    const next = items.map((event) => {
      if (event.sessionId !== sessionId || event.turnId !== turnId) {
        return event;
      }
      if (!isProviderActivityEvent(event)) {
        return event;
      }
      const payload = recordFromUnknown(event.payload);
      const status = payload?.status;
      if (status !== "running" && status !== "queued") {
        return event;
      }
      changed = true;
      return {
        ...event,
        payload: {
          ...payload,
          status: "done",
        },
      };
    });
    return changed ? next : items;
  };

  const currentOptimistic = optimisticEventsRef.current.get(sessionId);
  if (currentOptimistic) {
    const nextOptimistic = updateEvents(currentOptimistic);
    if (nextOptimistic !== currentOptimistic) {
      optimisticEventsRef.current.set(
        sessionId,
        limitSessionEventsForUi(nextOptimistic),
      );
    }
  }
  setEvents((current) => {
    if (!current.some((event) => event.sessionId === sessionId)) {
      return current;
    }
    return updateEvents(current);
  });
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
        note: streamEvent.activityNote,
        status: streamEvent.activityStatus ?? "done",
        providerId: streamEvent.providerId,
        modelId: streamEvent.modelId,
        providerSequence: streamEvent.sequence,
        // activitySequence is an index into the durable activity list, not the
        // stream clock. Mixing it with text/compaction frame sequences puts
        // later work before compaction. Updates retain this first-seen position.
        timelineSequence: streamEvent.sequence,
        turnId,
      },
    });
    const nextEvent = createEvent(eventId, activityId, label);
    // Same reasoning as the assistant upsert: a live activity is at the end of
    // the timeline, so scanning from the front walks the whole window to reach
    // it on every frame the provider sends.
    const existingIndex = items.findLastIndex((event) => event.id === eventId);
    if (existingIndex < 0) {
      return [...items, nextEvent];
    }
    if (streamEvent.activityKind === "commentary") {
      const continuationPrefix = `${eventId}-continuation-`;
      let previousText = "";
      let lastSegmentIndex = existingIndex;
      for (let index = 0; index < items.length; index += 1) {
        const event = items[index];
        if (
          !event ||
          (event.id !== eventId && !event.id.startsWith(continuationPrefix))
        ) {
          continue;
        }
        const payload = recordFromUnknown(event.payload);
        previousText +=
          typeof payload?.label === "string" ? payload.label : event.message;
        lastSegmentIndex = index;
      }
      const suffix = label.startsWith(previousText)
        ? label.slice(previousText.length)
        : "";
      const hasInterveningActivity = hasActivityAfter(
        items,
        lastSegmentIndex,
        turnId,
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
      ? preserveFirstSeenTimelineMetadata(existing, nextEvent, items)
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
    // Leave windowing to the app store so expanded history (load-earlier)
    // is not snapped back to the default open cap on every activity update.
    return updateEvents(current);
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
    // Windowing is applied by the app session store (default open cap or the
    // larger hold cap after load-earlier), not here.
    return next;
  });
}

export function upsertStreamingAssistantEvent(
  events: SessionEvent[],
  streamEvent: ProviderChatStreamEvent,
  turnId: string,
  textDelta: string,
) {
  const eventId = `${streamEvent.sessionId}-assistant-${turnId}`;
  // Searched from the end: this runs on every flush of a live stream, and the
  // event being appended to is the turn in progress — the last assistant
  // message in the timeline, not the first.
  const existingIndex = events.findLastIndex(
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
    const existingPayload = recordFromUnknown(existing.payload) ?? {};
    // Text that resumes after a tool ran is a new block, not a continuation of
    // the sentence before it. Marking where it starts lets the timeline show
    // the preamble beside the work it introduced and keep the closing block as
    // the answer, instead of gluing an entire turn into one bubble.
    const startsBlock =
      existing.message.length > 0 &&
      endsStreamedTextBlock(existing.message) &&
      hasActivityAfter(events, existingIndex, turnId);
    // Mirror the Rust stream separator: a text block that resumes after tools
    // must not glue onto the previous sentence when the provider omits a
    // leading newline (`edits.` + `Now the…` → `edits.Now the…`).
    const blockDelta = startsBlock
      ? separateStreamedTextBlock(existing.message, textDelta)
      : textDelta;
    const segments = assistantMessageSegments(existingPayload);
    const next: SessionEvent = {
      ...existing,
      message: appendChatResponseDelta(existing.message, blockDelta),
      payload: {
        ...existingPayload,
        kind: "provider-stream",
        providerId: streamEvent.providerId,
        modelId: streamEvent.modelId,
        streaming: true,
        segments: startsBlock
          ? [
              ...segments,
              {
                start: existing.message.length,
                sequence: streamEvent.sequence,
                createdAt: new Date().toISOString(),
              },
            ]
          : segments,
      },
    };
    if (!startsBlock) {
      const nextEvents = events.slice();
      nextEvents[existingIndex] = next;
      return nextEvents;
    }
    // Move it behind the activity it now trails so the next delta is measured
    // against this block rather than reopening the one before it.
    return [
      ...events.slice(0, existingIndex),
      ...events.slice(existingIndex + 1),
      next,
    ];
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
        segments: [
          {
            start: 0,
            sequence: streamEvent.sequence,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    },
  ];
}

/// Whether the turn ran a tool after the event at `index`.
///
/// Written as a loop rather than `slice(index + 1).some(...)` because both this
/// and its callers sit on the streaming path: the slice copied the tail of the
/// timeline on every delta of every turn, purely to ask a yes/no question about
/// it. At a 400-event render window and a flush every 80ms that is a few
/// thousand discarded array slots per second of streaming.
function hasActivityAfter(
  events: SessionEvent[],
  index: number,
  turnId: string,
) {
  for (let cursor = index + 1; cursor < events.length; cursor += 1) {
    const event = events[cursor];
    if (event && event.turnId === turnId && isProviderActivityEvent(event)) {
      return true;
    }
  }
  return false;
}

function assistantMessageSegments(payload: Record<string, unknown>) {
  const segments = payload.segments;
  return Array.isArray(segments) ? segments : [];
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

/**
 * Where a new text block is allowed to open.
 *
 * A block used to open on the sole question of whether a tool had run since the
 * last delta. But an activity frame can land between two deltas of the same
 * word, and then that test says yes in the middle of "pad|ding": the separator
 * went into the durable message and a segment mark was recorded at the seam, so
 * the rail drew half a sentence and the answer body opened on the other half.
 *
 * A boundary is a break the provider already emitted, a fenced block just
 * closed, or sentence-ending punctuation — trailing quotes, brackets and
 * markdown emphasis included, since providers close those after the period.
 * Anything else is mid-thought, and the delta continues the block it is in.
 */
const TEXT_BLOCK_END = /(?:[.!?:]["\u2019\u201d')\]]*[*_]{0,2}|```|\n)[ \t]*$/;

export function endsStreamedTextBlock(value: string) {
  return value.length > 0 && TEXT_BLOCK_END.test(value);
}

/** Paragraph-separate a new text block when the provider omitted a leading break. */
export function separateStreamedTextBlock(existing: string, delta: string) {
  if (!existing || !delta) return delta;
  const existingEndsBreak = /\s$/.test(existing);
  const deltaStartsBreak = /^\s/.test(delta);
  if (existingEndsBreak || deltaStartsBreak) return delta;
  return `\n\n${delta}`;
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
