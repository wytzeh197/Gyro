import assert from "node:assert/strict";
import { preserveDeliveredResponses } from "../apps/desktop/src/provider-stream-events.ts";
import { compareSessionEventsForHistory } from "../apps/desktop/src/session-event-order.ts";
import { orderedChatTimelineEvents } from "../packages/ui/src/chat-timeline.ts";

const event = (id, turnId, sequence, extra = {}) => ({
  id,
  sessionId: "imported-chat",
  turnId,
  createdAt: "2026-01-01T00:00:00Z",
  kind: "assistant-message",
  message: id,
  payload: { historical: true, timelineSequence: sequence },
  ...extra,
});
const firstUser = event("z-user-1", "turn-1", 1, { kind: "user-message" });
const firstReply = event("a-reply-1", "turn-1", 2);
const secondUser = event("b-user-2", "turn-2", 3, { kind: "user-message" });
const secondReply = event("c-reply-2", "turn-2", 4, {
  createdAt: "2025-12-31T23:59:00Z",
});
const live = event("live", "live-turn", undefined, {
  payload: {},
  createdAt: "2026-01-01T00:00:10Z",
});
const sorted = [secondReply, live, secondUser, firstReply, firstUser].sort(
  compareSessionEventsForHistory,
);
assert.deepEqual(
  sorted.map((item) => item.id),
  [firstUser.id, firstReply.id, secondUser.id, secondReply.id, live.id],
);
assert.deepEqual(
  orderedChatTimelineEvents(sorted).map((item) => item.id),
  sorted.map((item) => item.id),
);

// Ordinary provider sequences belong to their original clock and do not
// participate in the import ordering policy.
const normal = [
  event("z", "turn", 0, {
    payload: { timelineSequence: 0 },
    createdAt: "2026-01-01T00:00:01Z",
  }),
  event("b", "turn", 3, { payload: { timelineSequence: 3 } }),
  event("a", "turn", 9, { payload: { timelineSequence: 9 } }),
].sort(compareSessionEventsForHistory);
assert.deepEqual(
  normal.map((item) => item.id),
  ["a", "b", "z"],
);
// A refreshed durable import may contain multiple assistant records in one
// native turn. Live-response preservation must not replace the first record
// with the final reply and display that final reply twice.
const importedTurn = [firstUser, firstReply, event("final", "turn-1", 3)].map(
  (item) => ({
    ...item,
    payload: { ...item.payload, kind: "provider-response", historical: true },
  }),
);
const refreshed = importedTurn.map((item) => ({
  ...item,
  payload: { ...item.payload },
}));
assert.deepEqual(
  preserveDeliveredResponses(refreshed, importedTurn),
  refreshed,
);
assert.deepEqual(
  preserveDeliveredResponses(
    refreshed,
    preserveDeliveredResponses(refreshed, importedTurn),
  ),
  refreshed,
);
console.log("Imported session ordering checks passed.");
