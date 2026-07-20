import assert from "node:assert/strict";

import {
  applyProviderChatStreamActivity,
  applyProviderChatStreamDeltas,
  mergePersistedAndOptimisticEvents,
  mergeProviderResponseEvents,
  orderProviderChatStreamEvent,
} from "../apps/desktop/src/provider-stream-events.ts";
import { structuredCommentaryBlocks } from "../packages/ui/src/chat-commentary.ts";
import {
  interleavedChatTimelineItems,
  orderedChatTimelineEvents,
} from "../packages/ui/src/chat-timeline.ts";

assert.deepEqual(
  structuredCommentaryBlocks(
    "I’ll inspect first.I’ll update it.The checks pass.Alpha 28.2 stays intact.",
  ),
  [
    "I’ll inspect first.",
    "I’ll update it.",
    "The checks pass.",
    "Alpha 28.2 stays intact.",
  ],
);
assert.deepEqual(structuredCommentaryBlocks("Use v0.1.0-alpha.28.2 here."), [
  "Use v0.1.0-alpha.28.2 here.",
]);

function streamEvent(sequence, phase = "delta", textDelta = `${sequence}`) {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    providerId: "openai",
    eventId: `event-${sequence}`,
    sequence,
    phase,
    textDelta,
  };
}

const orderState = new Map();
assert.deepEqual(
  orderProviderChatStreamEvent(orderState, streamEvent(0, "started", "")),
  [streamEvent(0, "started", "")],
);
assert.deepEqual(orderProviderChatStreamEvent(orderState, streamEvent(2)), []);
assert.deepEqual(orderProviderChatStreamEvent(orderState, streamEvent(1)), [
  streamEvent(1),
  streamEvent(2),
]);
assert.deepEqual(orderProviderChatStreamEvent(orderState, streamEvent(1)), []);
assert.deepEqual(
  orderProviderChatStreamEvent(orderState, streamEvent(3, "completed", "")),
  [streamEvent(3, "completed", "")],
);
assert.deepEqual(
  orderProviderChatStreamEvent(orderState, streamEvent(3, "completed", "")),
  [],
);
assert.deepEqual(orderProviderChatStreamEvent(orderState, streamEvent(4)), []);
assert.equal(orderState.size, 1);

assert.deepEqual(
  orderProviderChatStreamEvent(orderState, streamEvent(0, "started", "")),
  [streamEvent(0, "started", "")],
);
assert.deepEqual(orderProviderChatStreamEvent(orderState, streamEvent(1)), [
  streamEvent(1),
]);

const gappedOrderState = new Map();
assert.deepEqual(
  orderProviderChatStreamEvent(gappedOrderState, streamEvent(0, "started", "")),
  [streamEvent(0, "started", "")],
);
assert.deepEqual(
  orderProviderChatStreamEvent(gappedOrderState, streamEvent(2)),
  [],
);
assert.deepEqual(
  orderProviderChatStreamEvent(
    gappedOrderState,
    streamEvent(4, "cancelled", ""),
  ),
  [streamEvent(2), streamEvent(4, "cancelled", "")],
);

const optimisticEventsRef = { current: new Map([["session-1", []]]) };
let renderedEvents = [];
applyProviderChatStreamDeltas(
  optimisticEventsRef,
  (update) => {
    renderedEvents =
      typeof update === "function" ? update(renderedEvents) : update;
  },
  [streamEvent(1, "delta", "hello "), streamEvent(2, "delta", "world")],
);
assert.equal(
  optimisticEventsRef.current.get("session-1")[0]?.message,
  "hello world",
);

const otherSessionEvent = {
  id: "other-user-message",
  sessionId: "session-2",
  turnId: "turn-2",
  createdAt: "2026-07-14T10:00:00.000Z",
  kind: "user-message",
  message: "Keep this chat visible",
  payload: {},
};
renderedEvents = [otherSessionEvent];
applyProviderChatStreamDeltas(
  optimisticEventsRef,
  (update) => {
    renderedEvents =
      typeof update === "function" ? update(renderedEvents) : update;
  },
  [streamEvent(3, "delta", " in the background")],
);
assert.deepEqual(renderedEvents, [otherSessionEvent]);
const restoredBackgroundEvents = mergePersistedAndOptimisticEvents(
  [],
  optimisticEventsRef.current.get("session-1"),
);
assert.equal(
  restoredBackgroundEvents[0]?.message,
  "hello world in the background",
);

const runningStatus = {
  id: "status-running",
  sessionId: "session-1",
  turnId: "turn-retry",
  createdAt: "2026-07-13T09:45:00.000Z",
  kind: "system-event",
  message: "OpenAI is working",
  payload: {
    kind: "provider-status",
    status: "running",
    startedAt: "2026-07-13T09:45:23.000Z",
  },
};
const historicalStatus = {
  ...runningStatus,
  id: "status-historical",
  createdAt: "2026-07-13T09:40:00.000Z",
  message: "OpenAI was cancelled",
  payload: {
    kind: "provider-status",
    status: "cancelled",
    startedAt: "2026-07-13T09:39:50.000Z",
    completedAt: "2026-07-13T09:40:00.000Z",
    durationMs: 10_000,
  },
};
const completedStatus = {
  ...runningStatus,
  id: "status-completed",
  createdAt: "2026-07-13T09:45:45.500Z",
  message: "OpenAI answered",
  payload: { kind: "provider-status", status: "done" },
};
const mergedStatus = mergeProviderResponseEvents(
  [historicalStatus, runningStatus],
  [completedStatus],
);
assert.equal(mergedStatus[0]?.payload?.status, "cancelled");
assert.equal(mergedStatus[0]?.payload?.durationMs, 10_000);
const latestMergedStatus = mergedStatus[1];
assert.equal(
  latestMergedStatus?.payload?.startedAt,
  "2026-07-13T09:45:23.000Z",
);
assert.equal(
  latestMergedStatus?.payload?.completedAt,
  "2026-07-13T09:45:45.500Z",
);
assert.equal(latestMergedStatus?.payload?.durationMs, 22_500);

const openingCommentary = {
  id: "optimistic-commentary",
  sessionId: "session-1",
  turnId: "turn-ordered-activity",
  createdAt: "2026-07-13T09:46:00.000Z",
  kind: "system-event",
  message: "I’ll inspect the menu first.",
  payload: {
    kind: "provider-activity",
    activityId: "commentary-1",
    activityKind: "commentary",
    label: "I’ll inspect the menu first.",
    status: "done",
  },
};
const completedCommentary = {
  ...openingCommentary,
  id: "persisted-commentary",
  createdAt: "2026-07-13T09:46:30.000Z",
};
const laterCommand = {
  id: "optimistic-command",
  sessionId: "session-1",
  turnId: "turn-ordered-activity",
  createdAt: "2026-07-13T09:46:05.000Z",
  kind: "system-event",
  message: "Ran command",
  payload: {
    kind: "provider-activity",
    activityId: "command-1",
    activityKind: "command",
    label: "Ran command",
    status: "done",
  },
};
const mergedActivities = mergeProviderResponseEvents(
  [openingCommentary, laterCommand],
  [completedCommentary],
);
assert.equal(mergedActivities[0]?.message, "I’ll inspect the menu first.");
assert.equal(mergedActivities[0]?.createdAt, "2026-07-13T09:46:00.000Z");
assert.equal(mergedActivities[1]?.message, "Ran command");

const activityEventsRef = { current: new Map([["session-1", []]]) };
let renderedActivityEvents = [
  {
    id: "activity-user-message",
    sessionId: "session-1",
    turnId: "turn-natural-order",
    createdAt: "2026-07-13T09:47:00.000Z",
    kind: "user-message",
    message: "Make the timeline natural",
    payload: {},
  },
];
const applyActivity = (
  sequence,
  activityId,
  activityKind,
  activityLabel,
  activityStatus = "done",
  activityDetail,
) =>
  applyProviderChatStreamActivity(
    activityEventsRef,
    (update) => {
      renderedActivityEvents =
        typeof update === "function" ? update(renderedActivityEvents) : update;
    },
    {
      sessionId: "session-1",
      turnId: "turn-natural-order",
      providerId: "openai",
      eventId: `activity-${sequence}`,
      sequence,
      phase: "activity",
      activityId,
      activityKind,
      activityLabel,
      activityStatus,
      activityDetail,
    },
  );

applyActivity(1, "commentary-1", "commentary", "I’ll inspect first.");
applyActivity(2, "command-1", "command", "Searched project");
applyActivity(
  3,
  "commentary-1",
  "commentary",
  "I’ll inspect first.Now I’ll update it.",
);
assert.deepEqual(
  renderedActivityEvents.slice(1).map((event) => event.message),
  ["I’ll inspect first.", "Searched project", "Now I’ll update it."],
);
const persistedCumulativeCommentary = {
  ...openingCommentary,
  id: "persisted-cumulative-commentary",
  turnId: "turn-natural-order",
  message: "I’ll inspect first.Now I’ll update it.",
  payload: {
    ...openingCommentary.payload,
    label: "I’ll inspect first.Now I’ll update it.",
  },
};
const persistedNaturalOrderCommand = {
  ...laterCommand,
  id: "persisted-natural-order-command",
  turnId: "turn-natural-order",
  message: "Searched project",
  payload: {
    ...laterCommand.payload,
    label: "Searched project",
  },
};
const completedActivityEvents = mergeProviderResponseEvents(
  renderedActivityEvents,
  [persistedCumulativeCommentary, persistedNaturalOrderCommand],
);
assert.deepEqual(
  completedActivityEvents.slice(1).map((event) => event.message),
  ["I’ll inspect first.", "Searched project", "Now I’ll update it."],
);
const refreshedActivityEvents = mergePersistedAndOptimisticEvents(
  [
    renderedActivityEvents[0],
    persistedCumulativeCommentary,
    persistedNaturalOrderCommand,
  ],
  renderedActivityEvents,
);
assert.deepEqual(
  refreshedActivityEvents.slice(1).map((event) => event.message),
  ["I’ll inspect first.", "Searched project", "Now I’ll update it."],
);

const liveEditEventsRef = { current: new Map([["session-1", []]]) };
let liveEditEvents = [renderedActivityEvents[0]];
const applyLiveEditActivity = (
  sequence,
  activityId,
  activityKind,
  activityLabel,
  activityStatus,
  activityDetail,
) =>
  applyProviderChatStreamActivity(
    liveEditEventsRef,
    (update) => {
      liveEditEvents =
        typeof update === "function" ? update(liveEditEvents) : update;
    },
    {
      sessionId: "session-1",
      turnId: "turn-natural-order",
      providerId: "openai",
      eventId: `live-edit-${sequence}`,
      sequence,
      phase: "activity",
      activityId,
      activityKind,
      activityLabel,
      activityStatus,
      activityDetail,
    },
  );
applyLiveEditActivity(
  1,
  "edit-a",
  "file",
  "Updated src/a.ts",
  "running",
  "src/a.ts",
);
applyLiveEditActivity(
  2,
  "command-after-edit",
  "command",
  "Ran tests",
  "running",
);
applyLiveEditActivity(
  3,
  "edit-a",
  "file",
  "Updated src/a.ts",
  "done",
  "src/a.ts",
);
assert.deepEqual(
  liveEditEvents.slice(1).map((event) => event.payload.activityId),
  ["edit-a", "command-after-edit"],
);
assert.equal(liveEditEvents[1].payload.status, "done");
assert.equal(liveEditEvents[1].payload.timelineSequence, 1);

const timelineActivity = (id, kind, sequence, status = "done") => ({
  id,
  sessionId: "session-1",
  turnId: "turn-stable-timeline",
  createdAt: `2026-07-13T09:48:0${sequence}.000Z`,
  kind: "system-event",
  message: id,
  payload: {
    kind: "provider-activity",
    activityId: id,
    activityKind: kind,
    label: id,
    status,
    timelineSequence: sequence,
  },
});
const firstCommentary = timelineActivity("commentary-before", "commentary", 1);
const firstFile = timelineActivity("src/a.ts", "file", 2, "running");
const timelineCommand = timelineActivity("command-after-edit", "command", 3);
const secondFile = timelineActivity("src/b.ts", "file", 4);
const laterCommentary = timelineActivity("commentary-after", "commentary", 5);
const unorderedTimeline = [
  laterCommentary,
  secondFile,
  timelineCommand,
  firstFile,
  firstCommentary,
];
assert.deepEqual(
  orderedChatTimelineEvents(unorderedTimeline).map((event) => event.id),
  [
    "commentary-before",
    "src/a.ts",
    "command-after-edit",
    "src/b.ts",
    "commentary-after",
  ],
);
const interleavedTimeline = interleavedChatTimelineItems(unorderedTimeline);
assert.deepEqual(
  interleavedTimeline.map((item) => item.kind),
  ["event", "file-summary", "activity-group", "event"],
);
assert.deepEqual(
  interleavedTimeline[1].events.map((event) => event.id),
  ["src/a.ts", "src/b.ts"],
);

const completedFirstFile = {
  ...firstFile,
  createdAt: "2026-07-13T09:49:30.000Z",
  payload: {
    ...firstFile.payload,
    status: "done",
    timelineSequence: 0,
  },
};
const completionMergedTimeline = mergeProviderResponseEvents(
  [firstCommentary, firstFile, timelineCommand, laterCommentary],
  [laterCommentary, completedFirstFile],
);
assert.deepEqual(
  orderedChatTimelineEvents(completionMergedTimeline).map((event) => event.id),
  ["commentary-before", "src/a.ts", "command-after-edit", "commentary-after"],
);
assert.equal(completionMergedTimeline[1].payload.status, "done");
assert.equal(completionMergedTimeline[1].payload.timelineSequence, 2);
assert.equal(completionMergedTimeline[1].createdAt, "2026-07-13T09:48:02.000Z");

console.log(
  "Provider stream ordering checks passed (reorder, dedupe, completion, coalescing, background continuation, retry timing, stable activity chronology, aggregate edits).",
);
