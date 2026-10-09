import type { SessionEvent } from "@gyro-dev/ui";

/** A refresh replaces matching durable records while retaining earlier pages
 * the user already loaded. Session logs are append-only. */
export function mergeSessionHistoryPages(current: SessionEvent[], page: SessionEvent[]) {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of page) byId.set(event.id, event);
  return Array.from(byId.values()).sort(compareSessionEventsForHistory);
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
