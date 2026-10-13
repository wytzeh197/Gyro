import type { SessionEvent } from "@gyro-dev/ui";

// Weak keys retain no closed transcript and never copy event payloads.
const historyIndexes = new WeakMap<
  SessionEvent[],
  { byId: Map<string, SessionEvent>; sorted: boolean }
>();
function indexHistory(events: SessionEvent[]) {
  const cached = historyIndexes.get(events);
  if (cached) return cached;
  const byId = new Map(events.map((event) => [event.id, event]));
  const sorted =
    byId.size === events.length &&
    events.every(
      (event, index) =>
        index === 0 ||
        compareSessionEventsForHistory(events[index - 1]!, event) <= 0,
    );
  const entry = { byId, sorted };
  historyIndexes.set(events, entry);
  return entry;
}

/** Replace durable records and retain every older event. Sort the small incoming
 * page and merge it with ordered history, instead of sorting the entire chat. */
export function mergeSessionHistoryPages(
  current: SessionEvent[],
  page: SessionEvent[],
) {
  if (page.length === 0) return current;
  const index = indexHistory(current);
  const updates = new Map<string, SessionEvent>();
  let changed = !index.sorted;
  for (const event of page) {
    const existing = index.byId.get(event.id);
    const same =
      existing === event ||
      (existing && JSON.stringify(existing) === JSON.stringify(event));
    updates.set(event.id, same ? existing! : event);
    if (!same) changed = true;
  }
  if (!changed) return current;
  const retained = Array.from(index.byId.values()).filter(
    (event) => !updates.has(event.id),
  );
  if (!index.sorted) retained.sort(compareSessionEventsForHistory);
  const incoming = Array.from(updates.values()).sort(
    compareSessionEventsForHistory,
  );
  const merged: SessionEvent[] = [];
  let a = 0,
    b = 0;
  while (a < retained.length && b < incoming.length) {
    if (compareSessionEventsForHistory(retained[a]!, incoming[b]!) <= 0)
      merged.push(retained[a++]!);
    else merged.push(incoming[b++]!);
  }
  for (; a < retained.length; a++) merged.push(retained[a]!);
  for (; b < incoming.length; b++) merged.push(incoming[b]!);
  historyIndexes.set(merged, {
    byId: new Map(merged.map((event) => [event.id, event])),
    sorted: true,
  });
  return merged;
}

function importSequence(event: SessionEvent): number | undefined {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const record = payload as Record<string, unknown>;
  if (record.historical !== true) return;
  if (event.kind === "session-created" && record.projectImportVersion === 1)
    return 0;
  const sequence = record.timelineSequence;
  return typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
    ? sequence
    : undefined;
}

/** Merge pages from one chat without sorting imported records by random IDs or
 * provider clock changes. Live provider events retain their existing ordering. */
export function compareSessionEventsForHistory(
  first: SessionEvent,
  second: SessionEvent,
): number {
  if (first.sessionId === second.sessionId) {
    const firstSequence = importSequence(first);
    const secondSequence = importSequence(second);
    if (firstSequence !== undefined && secondSequence !== undefined)
      return firstSequence - secondSequence;
    if (firstSequence !== undefined) return -1;
    if (secondSequence !== undefined) return 1;
  }
  return (
    new Date(first.createdAt).getTime() -
      new Date(second.createdAt).getTime() || first.id.localeCompare(second.id)
  );
}
