import {
  assistantMessageBlockStarts,
  isOrphanAssistantFragment,
  peelAssistantPreambleBlocks,
  structuredCommentaryBlocks,
} from "./chat-commentary.ts";
import type { SessionEvent } from "./types.ts";

export type InterleavedChatTimelineItem =
  | { kind: "event"; event: SessionEvent }
  | { kind: "file-summary"; id: string; events: SessionEvent[] }
  | {
      kind: "activity-group";
      id: string;
      activityKind: "command" | "read" | "search" | "tool";
      events: SessionEvent[];
    };

/**
 * Sorts a turn into the order the provider produced it.
 *
 * Only some events carry a provider sequence; approvals and capability calls
 * do not. Sorting just the sequenced ones and dealing them back into the slots
 * they used to occupy shuffled the unsequenced events into other events' time
 * positions, which is why the run gutter used to count backwards. Instead an
 * unsequenced event inherits the sequence of the event it followed, so it stays
 * pinned behind its cause while everything sorts as one list.
 */
export function orderedChatTimelineEvents(events: SessionEvent[]) {
  let inheritedSequence: number | undefined;
  return events
    .map((event, index) => {
      const sequence = timelineSequence(event);
      if (sequence !== undefined) {
        inheritedSequence = sequence;
      }
      return { event, index, sequence: sequence ?? inheritedSequence };
    })
    .sort((first, second) => {
      if (first.sequence === second.sequence) {
        return first.index - second.index;
      }
      if (first.sequence === undefined) {
        return -1;
      }
      if (second.sequence === undefined) {
        return 1;
      }
      return first.sequence - second.sequence;
    })
    .map((item) => item.event);
}

export type ChatTurnTimelineSections = {
  /** Narration and activity, in the order they happened. */
  work: Exclude<InterleavedChatTimelineItem, { kind: "file-summary" }>[];
  /** The closing assistant message — the only one that is an answer. */
  response?: SessionEvent;
  files: Extract<InterleavedChatTimelineItem, { kind: "file-summary" }>[];
};

export type AssistantMessageSegment = {
  start: number;
  sequence?: number;
  createdAt?: string;
};

const ASSISTANT_SEGMENT_ID_SEPARATOR = "#segment-";

/**
 * A provider streams every text block of a turn into one assistant event, so
 * the preamble it spoke before running tools and the answer it ended with share
 * a single bubble. The stream layer records where each block started; this
 * reads those marks back so each block can take its own place on the timeline.
 *
 * When marks are missing (no tools between blocks, or a persisted reply that
 * never recorded them), fall back to the unmistakable glued-stream boundary so
 * a finished turn still splits "I'll check…" from "Gyro is…" instead of
 * meshing both into the final answer.
 */
function assistantMessageSegments(
  event: SessionEvent,
): AssistantMessageSegment[] | undefined {
  const raw = eventPayload(event)?.segments;
  if (Array.isArray(raw) && raw.length >= 2) {
    const segments: AssistantMessageSegment[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        // Fall through to glue recovery rather than keeping a half-parsed mark
        // list that would slice at the wrong characters.
        break;
      }
      const { start, sequence, createdAt } = entry as Record<string, unknown>;
      const previous = segments.at(-1);
      if (
        typeof start !== "number" ||
        !Number.isSafeInteger(start) ||
        start < 0 ||
        start > event.message.length ||
        (previous !== undefined && start <= previous.start)
      ) {
        break;
      }
      segments.push({
        start,
        sequence:
          typeof sequence === "number" && Number.isSafeInteger(sequence)
            ? sequence
            : undefined,
        createdAt: typeof createdAt === "string" ? createdAt : undefined,
      });
    }
    if (segments.length >= 2 && segments[0]?.start === 0) {
      return segments;
    }
  }
  return recoveredAssistantMessageSegments(event.message);
}

/**
 * Recover block starts when the stream left no marks: glued joins
 * (`edits.Now…`) and blank-line paragraphs (plan line vs answer).
 */
function recoveredAssistantMessageSegments(
  message: string,
): AssistantMessageSegment[] | undefined {
  const starts = assistantMessageBlockStarts(message);
  if (starts.length < 2) {
    return undefined;
  }
  return starts.map((start) => ({ start }));
}

/**
 * Splits multi-block assistant messages into one event per block so the blocks
 * can interleave with the tools that ran between them.
 */
export function expandAssistantMessageSegments(events: SessionEvent[]) {
  return events.flatMap((event) => {
    if (event.kind !== "assistant-message") {
      return [event];
    }
    const segments = assistantMessageSegments(event);
    if (!segments) {
      const trimmed = event.message.trim();
      if (!trimmed || isOrphanAssistantFragment(trimmed)) {
        return [];
      }
      return [event];
    }
    const payload = eventPayload(event) ?? {};
    return segments
      .map((segment, index) => {
        const end = segments[index + 1]?.start ?? event.message.length;
        const { segments: _segments, ...rest } = payload;
        return {
          ...event,
          id: `${event.id}${ASSISTANT_SEGMENT_ID_SEPARATOR}${index}`,
          createdAt: segment.createdAt ?? event.createdAt,
          message: event.message.slice(segment.start, end),
          payload:
            segment.sequence === undefined
              ? rest
              : { ...rest, timelineSequence: segment.sequence },
        };
      })
      .filter((segment) => {
        const trimmed = segment.message.trim();
        return trimmed.length > 0 && !isOrphanAssistantFragment(trimmed);
      });
  });
}

function isNarrationEvent(
  item: InterleavedChatTimelineItem,
): item is Extract<InterleavedChatTimelineItem, { kind: "event" }> {
  return item.kind === "event" && item.event.kind === "assistant-message";
}

/**
 * Splits a turn into the work that happened and the answer it ended with.
 *
 * Assistant messages emitted mid-run are preambles to the tools that follow
 * them, so they stay in the work stream at the position they were spoken;
 * pulling every one of them out left the transcript reading out of order.
 *
 * A closing message only reads as an answer once it is the last thing in the
 * turn. While a run is still going the opening line is a preamble to work that
 * has not started yet, so it stays above the divider until some work precedes
 * it — otherwise the first thing a run showed was an "answer" below the line.
 */
export function chatTurnTimelineSections(
  events: SessionEvent[],
  options?: { isRunning?: boolean },
): ChatTurnTimelineSections {
  const items = interleavedChatTimelineItems(events);
  const sequenced: InterleavedChatTimelineItem[] = items.filter(
    (item) => item.kind !== "file-summary",
  );

  // Skip trailing file summaries already removed; walk back over trailing
  // narration to form the answer (and peel plan lines when work preceded it).
  let end = sequenced.length;
  const trailing: Extract<InterleavedChatTimelineItem, { kind: "event" }>[] = [];
  while (end > 0) {
    const item = sequenced[end - 1]!;
    if (!isNarrationEvent(item) || isBlankMessage(item)) {
      break;
    }
    trailing.unshift(item);
    end -= 1;
  }

  const before = sequenced.slice(0, end);
  const followsWork = before.some((item) => !isNarrationEvent(item));
  const closesTurn = trailing.length > 0;
  let responseEvent: SessionEvent | undefined;
  const preambleIds = new Set<string>();

  if (closesTurn && (followsWork || !options?.isRunning)) {
    const blocks = trailing.map((item) => item.event.message.trim());
    // Peel plan/status lines even on pure Q&A when the stream glued a preamble
    // to the answer (`I'll check….Gyro is…`). Real multi-paragraph answers
    // that do not match preamble patterns stay whole.
    const peeled = peelAssistantPreambleBlocks(blocks);
    for (let index = 0; index < peeled.preambles.length; index += 1) {
      preambleIds.add(trailing[index]!.event.id);
    }
    const answerItems = trailing.slice(peeled.preambles.length);
    if (answerItems.length === 1) {
      const only = answerItems[0]!.event;
      const parts = structuredCommentaryBlocks(only.message);
      if (parts.length > 1) {
        const inner = peelAssistantPreambleBlocks(parts);
        responseEvent = {
          ...only,
          message: inner.answer.join("\n\n"),
        };
      } else {
        responseEvent = only;
      }
    } else if (answerItems.length > 1) {
      const first = answerItems[0]!.event;
      responseEvent = {
        ...first,
        message: answerItems
          .map((item) => item.event.message.trim())
          .filter(Boolean)
          .join("\n\n"),
      };
    } else {
      responseEvent = trailing.at(-1)?.event;
    }
  }

  const responseSourceIds = new Set(
    responseEvent
      ? trailing
          .filter((item) => !preambleIds.has(item.event.id))
          .map((item) => item.event.id)
      : [],
  );

  const work = items.filter(
    (
      item,
    ): item is Exclude<InterleavedChatTimelineItem, { kind: "file-summary" }> =>
      item.kind !== "file-summary" &&
      !(isNarrationEvent(item) && isBlankMessage(item)) &&
      !(item.kind === "event" && responseSourceIds.has(item.event.id)),
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
  for (const event of orderedChatTimelineEvents(
    expandAssistantMessageSegments(events),
  )) {
    const activityKind = providerActivityKind(event);
    if (activityKind === "file") {
      fileEvents.push(event);
      continue;
    }
    const groupedKind =
      activityKind === "command" ||
      activityKind === "read" ||
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
