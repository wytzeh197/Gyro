import type { SessionEvent } from "./types";

export type InterleavedChatTimelineItem =
  | { kind: "event"; event: SessionEvent }
  | { kind: "file-summary"; id: string; events: SessionEvent[] }
  | {
      kind: "activity-group";
      id: string;
      activityKind: "command" | "search" | "tool";
      events: SessionEvent[];
    };

export function orderedChatTimelineEvents(events: SessionEvent[]) {
  const ordered = events.slice();
  const sequenced = events
    .map((event, index) => ({
      event,
      index,
      sequence: timelineSequence(event),
    }))
    .filter(
      (
        item,
      ): item is { event: SessionEvent; index: number; sequence: number } =>
        item.sequence !== undefined,
    );
  const sortedEvents = sequenced
    .slice()
    .sort(
      (first, second) =>
        first.sequence - second.sequence || first.index - second.index,
    )
    .map((item) => item.event);
  sequenced.forEach((item, index) => {
    ordered[item.index] = sortedEvents[index] as SessionEvent;
  });
  return ordered;
}

export type ChatTurnTimelineSections = {
  /** Narration and activity, in the order they happened. */
  work: Exclude<InterleavedChatTimelineItem, { kind: "file-summary" }>[];
  /** The closing assistant message — the only one that is an answer. */
  response?: SessionEvent;
  files: Extract<InterleavedChatTimelineItem, { kind: "file-summary" }>[];
};

function isNarrationEvent(item: InterleavedChatTimelineItem) {
  return item.kind === "event" && item.event.kind === "assistant-message";
}

/**
 * Splits a turn into the work that happened and the answer it ended with.
 *
 * Assistant messages emitted mid-run are preambles to the tools that follow
 * them, so they stay in the work stream at the position they were spoken;
 * pulling every one of them out left the transcript reading out of order.
 */
export function chatTurnTimelineSections(
  events: SessionEvent[],
): ChatTurnTimelineSections {
  const items = interleavedChatTimelineItems(events);
  const spoken = items.filter(
    (item) => isNarrationEvent(item) && !isBlankMessage(item),
  );
  const response = spoken.at(-1);
  const responseEvent = response?.kind === "event" ? response.event : undefined;
  const work = items.filter(
    (
      item,
    ): item is Exclude<InterleavedChatTimelineItem, { kind: "file-summary" }> =>
      item.kind !== "file-summary" &&
      !(isNarrationEvent(item) && isBlankMessage(item)) &&
      item !== response,
  );
  const files = items.filter(
    (
      item,
    ): item is Extract<InterleavedChatTimelineItem, { kind: "file-summary" }> =>
      item.kind === "file-summary",
  );
  return { work, response: responseEvent, files };
}

function isBlankMessage(item: InterleavedChatTimelineItem) {
  return item.kind === "event" && item.event.message.trim().length === 0;
}

export function interleavedChatTimelineItems(events: SessionEvent[]) {
  const items: InterleavedChatTimelineItem[] = [];
  const fileEvents: SessionEvent[] = [];
  for (const event of orderedChatTimelineEvents(events)) {
    const activityKind = providerActivityKind(event);
    if (activityKind === "file") {
      fileEvents.push(event);
      continue;
    }
    const groupedKind =
      activityKind === "command" ||
      activityKind === "search" ||
      activityKind === "tool"
        ? activityKind
        : undefined;
    const previous = items.at(-1);
    if (
      groupedKind &&
      previous?.kind === "activity-group" &&
      previous.activityKind === groupedKind
    ) {
      previous.events.push(event);
    } else if (groupedKind) {
      items.push({
        kind: "activity-group",
        id: `activity-group-${event.id}`,
        activityKind: groupedKind,
        events: [event],
      });
    } else {
      items.push({ kind: "event", event });
    }
  }
  const firstFileEvent = fileEvents[0];
  if (firstFileEvent) {
    items.push({
      kind: "file-summary",
      id: `file-summary-${firstFileEvent.id}`,
      events: fileEvents,
    });
  }
  return items;
}

function timelineSequence(event: SessionEvent) {
  const payload = eventPayload(event);
  const sequence = payload?.timelineSequence;
  if (typeof sequence === "number" && Number.isSafeInteger(sequence)) {
    return sequence;
  }
  const providerSequence = payload?.providerSequence;
  return typeof providerSequence === "number" &&
    Number.isSafeInteger(providerSequence)
    ? providerSequence
    : undefined;
}

function providerActivityKind(event: SessionEvent) {
  const payload = eventPayload(event);
  return event.kind === "system-event" && payload?.kind === "provider-activity"
    ? payload.activityKind
    : undefined;
}

function eventPayload(event: SessionEvent) {
  return event.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : undefined;
}
