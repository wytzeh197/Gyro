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

export function interleavedChatTimelineItems(events: SessionEvent[]) {
  const items: InterleavedChatTimelineItem[] = [];
  let fileSummary: Extract<
    InterleavedChatTimelineItem,
    { kind: "file-summary" }
  > | null = null;
  for (const event of orderedChatTimelineEvents(events)) {
    const activityKind = providerActivityKind(event);
    if (activityKind === "file") {
      if (fileSummary) {
        fileSummary.events.push(event);
      } else {
        fileSummary = {
          kind: "file-summary",
          id: `file-summary-${event.id}`,
          events: [event],
        };
        items.push(fileSummary);
      }
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
