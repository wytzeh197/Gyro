import assert from "node:assert/strict";

import {
  acknowledgeCompletedChat,
  completedChatOutcomeId,
  forgetCompletedChat,
  latestCompletedChatOutcomeId,
  markUnreadCompletedChat,
  parseAcknowledgedCompletedOutcomeIds,
} from "../apps/desktop/src/unread-completed-chats.ts";

const sessionId = "session-1";
const turn = (id, turnId, status, completedAt) => ({
  id,
  kind: "system-event",
  createdAt: completedAt,
  turnId,
  payload: { kind: "provider-status", status, completedAt },
});

const firstDone = turn(
  "event-optimistic",
  "turn-1",
  "done",
  "2026-09-16T10:00:00.000Z",
);
const persistedDone = turn(
  "event-persisted",
  "turn-1",
  "done",
  "2026-09-16T10:00:01.000Z",
);
const nextTurnDone = turn(
  "event-next",
  "turn-2",
  "done",
  "2026-09-16T10:05:00.000Z",
);

assert.equal(
  completedChatOutcomeId(sessionId, firstDone),
  completedChatOutcomeId(sessionId, persistedDone),
  "optimistic and persisted done events for the same turn share an outcome id",
);
assert.notEqual(
  completedChatOutcomeId(sessionId, firstDone),
  completedChatOutcomeId(sessionId, nextTurnDone),
  "a later turn must be a new outcome",
);
assert.equal(
  latestCompletedChatOutcomeId(sessionId, [firstDone, persistedDone]),
  completedChatOutcomeId(sessionId, persistedDone),
);

const firstOutcomeId = completedChatOutcomeId(sessionId, firstDone);
let unread = markUnreadCompletedChat([], sessionId, {
  acknowledgedOutcomeIds: [],
  isViewing: false,
  outcomeId: firstOutcomeId,
});
assert.deepEqual(
  unread,
  [sessionId],
  "a background completion shows the blue dot",
);

unread = markUnreadCompletedChat(unread, sessionId, {
  acknowledgedOutcomeIds: [],
  isViewing: true,
  outcomeId: firstOutcomeId,
});
assert.deepEqual(
  unread,
  [],
  "opening the chat while it is focused clears the dot",
);

const opened = acknowledgeCompletedChat(
  [sessionId],
  [],
  sessionId,
  firstOutcomeId,
);
assert.deepEqual(opened.unreadIds, []);
assert.deepEqual(opened.acknowledgedOutcomeIds, [firstOutcomeId]);

unread = markUnreadCompletedChat(opened.unreadIds, sessionId, {
  acknowledgedOutcomeIds: opened.acknowledgedOutcomeIds,
  isViewing: false,
  outcomeId: completedChatOutcomeId(sessionId, persistedDone),
});
assert.deepEqual(
  unread,
  [],
  "a later persisted done event for the opened turn must not bring the dot back",
);

unread = markUnreadCompletedChat(unread, sessionId, {
  acknowledgedOutcomeIds: opened.acknowledgedOutcomeIds,
  isViewing: false,
  outcomeId: completedChatOutcomeId(sessionId, nextTurnDone),
});
assert.deepEqual(
  unread,
  [sessionId],
  "a new completed turn in the background may show the blue dot again",
);

const forgotten = forgetCompletedChat(
  [sessionId],
  opened.acknowledgedOutcomeIds,
  sessionId,
);
assert.deepEqual(forgotten.unreadIds, []);
assert.deepEqual(forgotten.acknowledgedOutcomeIds, []);

assert.deepEqual(parseAcknowledgedCompletedOutcomeIds(undefined), []);
assert.deepEqual(parseAcknowledgedCompletedOutcomeIds("{"), []);
assert.deepEqual(
  parseAcknowledgedCompletedOutcomeIds(JSON.stringify([firstOutcomeId, 3, ""])),
  [firstOutcomeId],
);

console.log(
  "Unread completed chat checks passed: opened chats keep the blue dot gone until a new turn finishes.",
);
