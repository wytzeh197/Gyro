import type { SessionEvent } from "@gyro-dev/ui";
import {
  buildTimelineIndex,
  findTimelineMatch,
  mergePersistedAndOptimisticEvents,
  mergeProviderResponseEvents,
} from "../provider-stream-events.ts";
import { sameSessionEvents } from "../responsiveness.ts";

/** Saved history and the live buffer stay separate. The rendered transcript
 * keeps first-seen identities so a host refresh cannot remount command rows. */
export function reconcileRemoteHistory(
  previous: SessionEvent[],
  persisted: SessionEvent[],
  optimistic?: SessionEvent[],
): SessionEvent[] {
  const next = mergePersistedAndOptimisticEvents(persisted, optimistic);
  const index = buildTimelineIndex(previous);
  const stable = next.map((event) => {
    const existing = findTimelineMatch(index, event);
    if (!existing) return event;
    const updated = mergeProviderResponseEvents([existing], [event])[0]!;
    return updated.id === existing.id
      ? updated
      : { ...updated, id: existing.id };
  });
  return sameSessionEvents(previous, stable) ? previous : stable;
}
