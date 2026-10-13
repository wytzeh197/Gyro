import type { SessionEvent } from "./types";

type HistoryTurn = { id: string; timelineEvents: SessionEvent[] };
function sameRecord(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
}
function sameEvent(a: SessionEvent | undefined, b: SessionEvent | undefined) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.sessionId === b.sessionId &&
    a.turnId === b.turnId &&
    a.kind === b.kind &&
    a.createdAt === b.createdAt &&
    a.message === b.message &&
    sameRecord(a.payload, b.payload)
  );
}
function sameTurn<T extends HistoryTurn>(a: T, b: T) {
  const keys = Object.keys(a) as Array<keyof T>;
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    if (key === "timelineEvents")
      return (
        a.timelineEvents.length === b.timelineEvents.length &&
        a.timelineEvents.every((event, index) =>
          sameEvent(event, b.timelineEvents[index]),
        )
      );
    if (key === "user" || key === "statusEvent")
      return sameEvent(
        a[key] as SessionEvent | undefined,
        b[key] as SessionEvent | undefined,
      );
    // These projected accounting objects contain counts, labels and small costs.
    if (key === "turnTokens")
      return (
        a[key] === b[key] || JSON.stringify(a[key]) === JSON.stringify(b[key])
      );
    return a[key] === b[key] && Object.hasOwn(b, key);
  });
}

/** Retain only the current chat's projections. Immutable source events let
 * streaming rebuild the changed turn without regrouping finished history. */
export function createTranscriptTurnCache<T extends HistoryTurn>() {
  let previous = new Map<string, { source: T; prepared: T }>();
  return {
    reconcile(turns: T[], prepare: (turn: T) => T) {
      const next = new Map<string, { source: T; prepared: T }>();
      const result = turns.map((source) => {
        const cached = previous.get(source.id);
        const entry =
          cached && sameTurn(cached.source, source)
            ? cached
            : { source, prepared: prepare(source) };
        next.set(source.id, entry);
        return entry.prepared;
      });
      previous = next;
      return result;
    },
  };
}
