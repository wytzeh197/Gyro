import assert from "node:assert/strict";
import { providerCatalog } from "../packages/ui/src/provider-catalog.ts";
import { buildRunModel, groupRunSteps } from "../packages/ui/src/chat-run.ts";

import {
  applyProviderChatStreamActivity,
  applyProviderChatStreamDeltas,
  buildTimelineIndex,
  findTimelineMatch,
  mergePersistedAndOptimisticEvents,
  mergeLiveCapabilityEvent,
  mergeProviderResponseEvents,
  orderProviderChatStreamEvent,
  sameTimelineEvent,
  endsStreamedTextBlock,
  separateStreamedTextBlock,
} from "../apps/desktop/src/provider-stream-events.ts";
import { structuredCommentaryBlocks } from "../packages/ui/src/chat-commentary.ts";
import {
  interleavedChatTimelineItems,
  orderedChatTimelineEvents,
} from "../packages/ui/src/chat-timeline.ts";

// Every catalog model (plus dynamically configured models) gets the same
// ordering contract. This exercises normalized stream formats, not remote APIs.
const timelineModels = [
  ...providerCatalog.flatMap((provider) =>
    (provider.models.length ? provider.models : [{ id: "dynamic-model" }]).map(
      (model) => ({ providerId: provider.id, modelId: model.id }),
    ),
  ),
  { providerId: "custom:timeline-test", modelId: "user-defined-model" },
];
for (const identity of timelineModels) {
  const ref = { current: new Map() };
  const sessionId = "model-ordering";
  const turnId = "model-turn";
  const frame = (sequence, extra) => ({
    ...identity,
    sessionId,
    turnId,
    sequence,
    eventId: `frame-${sequence}`,
    ...extra,
  });
  const activity = (sequence, id, kind, label, status = "running") =>
    applyProviderChatStreamActivity(
      ref,
      () => {},
      frame(sequence, {
        phase: "activity",
        activityId: id,
        activityKind: kind,
        activitySequence: 0,
        activityLabel: label,
        activityStatus: status,
      }),
    );
  const delta = (sequence, textDelta) =>
    applyProviderChatStreamDeltas(ref, () => {}, [
      frame(sequence, { phase: "delta", textDelta }),
    ]);
  const messages = () =>
    interleavedChatTimelineItems(ref.current.get(sessionId)).flatMap((item) =>
      item.kind === "event"
        ? [item.event.message.trim()]
        : item.events.map((event) => event.message.trim()),
    );
  const check = (expected, reason) =>
    assert.deepEqual(
      messages(),
      expected,
      `${identity.providerId}/${identity.modelId}: ${reason}`,
    );

  // Snapshot-style commentary reuses an id and includes all previous words.
  activity(10, "narration", "commentary", "I'll inspect.");
  activity(20, "command", "command", "Inspect files");
  activity(30, "narration", "commentary", "I'll inspect.I'll verify");
  activity(31, "narration", "commentary", "I'll inspect.I'll verify now.");
  activity(
    32,
    "narration",
    "commentary",
    "I'll inspect.I'll verify now.",
    "done",
  );
  check(
    ["I'll inspect.", "Inspect files", "I'll verify now."],
    "cumulative commentary must grow after the command without duplication",
  );
  activity(40, "command", "command", "Inspect files", "done");
  check(
    ["I'll inspect.", "Inspect files", "I'll verify now."],
    "command completion must keep its starting position",
  );
  const run = buildRunModel(ref.current.get(sessionId), { isRunning: true });
  assert.deepEqual(
    run.steps
      .filter((step) => step.kind === "say" || step.kind === "work")
      .map((step) => step.kind),
    ["say", "work", "say"],
    "visible work groups must not cross narration",
  );

  // Delta-style providers can explicitly open a new paragraph without ending
  // the preceding block in punctuation. A word split remains a continuation.
  ref.current.set(sessionId, []);
  delta(10, "Inspecting files");
  activity(20, "reasoning", "reasoning", "Checking the result");
  activity(21, "command", "command", "Run checks");
  delta(30, "\n\nChecks complete.");
  check(
    [
      "Inspecting files",
      "Checking the result",
      "Run checks",
      "Checks complete.",
    ],
    "explicit text boundaries preserve reasoning and command order",
  );

  // Capability-channel calls have no provider sequence and can arrive between
  // deltas; updates and refreshes must retain their first-seen placement.
  ref.current.set(sessionId, []);
  delta(10, "I'll inspect.");
  const capability = {
    id: "capability-start",
    sessionId,
    turnId,
    kind: "system-event",
    createdAt: "2026-09-20T10:00:00.000Z",
    message: "Read workspace",
    payload: {
      kind: "capability-call",
      callId: "call-1",
      capabilityId: "workspace-read",
      status: "running",
    },
  };
  ref.current.set(
    sessionId,
    mergeLiveCapabilityEvent(ref.current.get(sessionId), capability),
  );
  delta(20, "I'll verify.");
  activity(30, "verify", "command", "Run checks");
  const expected = [
    "I'll inspect.",
    "Read workspace",
    "I'll verify.",
    "Run checks",
  ];
  check(expected, "capability and provider tools must share chronology");
  const live = ref.current.get(sessionId);
  ref.current.set(sessionId, mergePersistedAndOptimisticEvents(live, live));
  check(expected, "refresh must be idempotent");
}
console.log(
  `Shared chronology contract passed for ${timelineModels.length} catalog/custom model entries.`,
);

// Compaction starts without an activity ordinal, while commentary and commands
// carry small durable ordinals. They must all use the same live stream clock.
{
  const ref = { current: new Map() };
  let live = [];
  const apply = (
    sequence,
    activityId,
    activityKind,
    activitySequence,
    status = "done",
  ) => {
    applyProviderChatStreamActivity(ref, () => {}, {
      sessionId: "ordering-session",
      turnId: "ordering-turn",
      providerId: "openai",
      eventId: `frame-${sequence}`,
      phase: "activity",
      sequence,
      activityId,
      activityKind,
      activitySequence,
      activityStatus: status,
      activityLabel:
        activityKind === "commentary"
          ? "I'll update the review panel."
          : activityId,
    });
    live = ref.current.get("ordering-session");
  };
  const ids = (events) =>
    buildRunModel(events, { isRunning: true })
      .steps.filter((step) => step.kind === "say" || step.kind === "work")
      .map((step) => step.id);
  apply(100, "read", "read", 0);
  apply(110, "compaction", "context", undefined, "running");
  apply(120, "commentary", "commentary", 2);
  apply(130, "command", "command", 3, "running");
  const expected = live.map((event) => event.id);
  assert.deepEqual(
    ids(live),
    expected,
    "post-compaction work must stay below compaction",
  );
  assert.deepEqual(
    groupRunSteps(buildRunModel(live, { isRunning: true }).steps)
      .filter((step) => ["work-group", "work", "say"].includes(step.kind))
      .map((step) => (step.kind === "work" ? step.item.kind : step.kind)),
    ["work-group", "context", "say", "work-group"],
    "the visible grouped rail must keep compaction before the later narration and commands",
  );
  apply(140, "compaction", "context", 1);
  apply(150, "command", "command", 3);
  assert.deepEqual(
    ids(live),
    expected,
    "status updates must not move existing rows",
  );

  const persisted = live.map((event, index) => ({
    ...event,
    id: `saved-${index}`,
    payload: {
      ...event.payload,
      providerSequence: undefined,
      timelineSequence: index,
    },
  }));
  for (const merged of [
    mergeProviderResponseEvents(live, persisted),
    mergePersistedAndOptimisticEvents(persisted, live),
  ]) {
    assert.deepEqual(
      ids(merged),
      persisted.map((event) => event.id),
      "durable reconciliation must preserve the observed chronology",
    );
  }
  assert.deepEqual(
    ids(persisted),
    persisted.map((event) => event.id),
    "a cold reload must retain durable activity order",
  );

  // Other providers stream assistant text separately from activity frames.
  // Small activity ordinals must not hoist a tool above the text introducing it.
  applyProviderChatStreamDeltas(ref, () => {}, [
    {
      sessionId: "ordering-session",
      turnId: "ordering-turn",
      providerId: "anthropic",
      eventId: "text-160",
      phase: "delta",
      sequence: 160,
      textDelta: "I'll run the final checks.",
    },
  ]);
  apply(170, "final-check", "command", 4);
  const withText = ref.current.get("ordering-session");
  assert.deepEqual(
    ids(withText),
    withText.map((event) => event.id),
    "assistant deltas and activities must share the same clock",
  );
}

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
// Bolded answer blocks still split at the glued boundary (is.**Gyro…).
assert.deepEqual(
  structuredCommentaryBlocks(
    "matches what Gyro actually is.**Gyro is a local-first workspace.**",
  ),
  ["matches what Gyro actually is.", "**Gyro is a local-first workspace.**"],
);

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

// A single lost mid-turn sequence used to freeze the rail until the terminal
// event (or 64 later frames). Sparse tool streams never hit that bound, so
// recover once a handful of later events are waiting (size > 8).
const midTurnGapState = new Map();
assert.deepEqual(
  orderProviderChatStreamEvent(midTurnGapState, streamEvent(0, "started", "")),
  [streamEvent(0, "started", "")],
);
// Hole at 1: stack 2..9 without releasing, then the 9th pending unblocks them.
for (let sequence = 2; sequence <= 9; sequence += 1) {
  assert.deepEqual(
    orderProviderChatStreamEvent(midTurnGapState, streamEvent(sequence)),
    [],
    `sequence ${sequence} should wait on the missing frame`,
  );
}
assert.deepEqual(
  orderProviderChatStreamEvent(midTurnGapState, streamEvent(10)),
  [2, 3, 4, 5, 6, 7, 8, 9, 10].map((sequence) => streamEvent(sequence)),
  "a small mid-turn gap must recover without waiting for completed/cancelled",
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

assert.equal(
  optimisticEventsRef.current.get("session-1")[0].payload.timelineSequence,
  1,
  "a buffered text block keeps its first token's position",
);

// Capability-only tools must separate streamed narration too, and keep their
// positions when the aggregate assistant event moves or call statuses update.
{
  const ref = { current: new Map() };
  const delta = (sequence, text) =>
    applyProviderChatStreamDeltas(ref, () => {}, [
      streamEvent(sequence, "delta", text),
    ]);
  const call = (id, status = "running") => {
    const events = ref.current.get("session-1");
    ref.current.set(
      "session-1",
      mergeLiveCapabilityEvent(events, {
        id,
        sessionId: "session-1",
        turnId: "turn-1",
        createdAt: "2026-09-20T10:00:00.000Z",
        kind: "system-event",
        message: id,
        payload: {
          kind: "capability-call",
          callId: id,
          capabilityId: "terminal-open",
          status,
        },
      }),
    );
  };
  const order = () =>
    interleavedChatTimelineItems(ref.current.get("session-1")).map((item) =>
      item.kind === "event" ? item.event.message : item.kind,
    );
  delta(10, "I'll inspect the files.");
  call("first-command");
  delta(20, "I'll run the checks.");
  call("second-command");
  delta(30, "The checks passed.");
  const expected = [
    "I'll inspect the files.",
    "first-command",
    "\n\nI'll run the checks.",
    "second-command",
    "\n\nThe checks passed.",
  ];
  assert.deepEqual(
    order(),
    expected,
    "capability commands stay between text blocks",
  );
  call("first-command", "done");
  assert.deepEqual(order(), expected, "late completion cannot reorder a call");
  const live = ref.current.get("session-1");
  const firstCall = live.find((event) => event.id === "first-command");
  const completed = mergeLiveCapabilityEvent(live, {
    ...firstCall,
    id: "first-command-completed",
    payload: {
      ...firstCall.payload,
      timelineSequence: undefined,
      status: "done",
    },
  }).at(-1);
  assert.equal(
    completed.payload.timelineSequence,
    firstCall.payload.timelineSequence,
    "distinct lifecycle records for one call retain its first position",
  );
  const saved = live.map((event) => ({
    ...event,
    payload: { ...event.payload, timelineSequence: undefined },
  }));
  ref.current.set("session-1", mergePersistedAndOptimisticEvents(saved, live));
  assert.deepEqual(order(), expected, "refresh retains capability positions");
}

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
  activitySequence,
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
      activitySequence,
      phase: "activity",
      activityId,
      activityKind,
      activityLabel,
      activityStatus,
      activityDetail,
    },
  );

applyActivity(
  1,
  "commentary-1",
  "commentary",
  "I’ll inspect first.",
  "done",
  undefined,
  0,
);
applyActivity(
  2,
  "command-1",
  "command",
  "Searched project",
  "done",
  undefined,
  1,
);
applyActivity(
  3,
  "commentary-1",
  "commentary",
  "I’ll inspect first.Now I’ll update it.",
  "done",
  undefined,
  0,
);
assert.deepEqual(
  renderedActivityEvents.slice(1).map((event) => event.message),
  ["I’ll inspect first.", "Searched project", "Now I’ll update it."],
);
assert.deepEqual(
  renderedActivityEvents
    .slice(1)
    .map((event) => event.payload.timelineSequence),
  [1, 2, 3],
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
  ["event", "activity-group", "event", "file-summary"],
);
assert.deepEqual(
  interleavedTimeline[3].events.map((event) => event.id),
  ["src/a.ts", "src/b.ts"],
);

const groupedChronology = interleavedChatTimelineItems([
  timelineActivity("opening-update", "commentary", 0),
  timelineActivity("command-a", "command", 1),
  timelineActivity("command-b", "command", 2),
  timelineActivity("middle-update", "commentary", 3),
  timelineActivity("command-c", "command", 4),
  timelineActivity("command-d", "command", 5),
]);
assert.deepEqual(
  groupedChronology.map((item) => item.kind),
  ["event", "activity-group", "event", "activity-group"],
);
assert.deepEqual(
  groupedChronology
    .filter((item) => item.kind === "activity-group")
    .map((item) => item.events.map((event) => event.id)),
  [
    ["command-a", "command-b"],
    ["command-c", "command-d"],
  ],
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

const liveFinalCommentary = {
  ...timelineActivity("live-final-commentary", "commentary", 6),
  message: "The timeline is fixed.",
  payload: {
    ...timelineActivity("live-final-commentary", "commentary", 6).payload,
    label: "The timeline is fixed.",
  },
};
const completedFinalResponse = {
  id: "completed-final-response",
  sessionId: "session-1",
  turnId: "turn-stable-timeline",
  createdAt: "2026-07-13T09:50:00.000Z",
  kind: "assistant-message",
  message: "The timeline is fixed.",
  payload: { kind: "provider-response", timelineSequence: 6 },
};
const finalResponseMergedTimeline = mergeProviderResponseEvents(
  [firstCommentary, timelineCommand, liveFinalCommentary],
  [completedFinalResponse],
);
assert.deepEqual(
  finalResponseMergedTimeline.map((event) => event.id),
  ["commentary-before", "command-after-edit", "completed-final-response"],
);

// Text that resumes after a tool ran opens a new block, so the timeline can
// tell a preamble from the answer inside one streamed assistant message.
const blockEventsRef = { current: new Map([["session-1", []]]) };
let blockEvents = [];
const setBlockEvents = (update) => {
  blockEvents = typeof update === "function" ? update(blockEvents) : update;
};
const streamBlockDelta = (sequence, textDelta) =>
  applyProviderChatStreamDeltas(blockEventsRef, setBlockEvents, [
    {
      sessionId: "session-1",
      turnId: "turn-blocks",
      providerId: "anthropic",
      eventId: `block-${sequence}`,
      sequence,
      phase: "delta",
      textDelta,
    },
  ]);
blockEvents = [];
blockEventsRef.current.set("session-1", []);
streamBlockDelta(1, "I'll look. ");
streamBlockDelta(2, "at the code.");
applyProviderChatStreamActivity(blockEventsRef, setBlockEvents, {
  sessionId: "session-1",
  turnId: "turn-blocks",
  providerId: "anthropic",
  eventId: "block-activity",
  sequence: 3,
  activitySequence: 3,
  phase: "activity",
  activityId: "read-1",
  activityKind: "tool",
  activityLabel: "Read surfaces.tsx",
  activityStatus: "done",
});
streamBlockDelta(4, "Here is the answer.");
const streamedAssistant = blockEventsRef.current
  .get("session-1")
  .find((event) => event.kind === "assistant-message");
assert.equal(
  streamedAssistant.message,
  "I'll look. at the code.\n\nHere is the answer.",
  "text that resumes after a tool must not glue onto the previous sentence",
);
assert.deepEqual(
  streamedAssistant.payload.segments.map((segment) => segment.start),
  [0, 23],
  "a block should open where text resumed after the tool",
);
assert.equal(
  streamedAssistant.message.slice(23),
  "\n\nHere is the answer.",
  "the block mark should land on the paragraph break before the resumed text",
);
assert.equal(
  separateStreamedTextBlock("Now the edits.", "Now the handler:"),
  "\n\nNow the handler:",
);
assert.equal(
  separateStreamedTextBlock("Already ends.\n", "Next block"),
  "Next block",
  "do not double-separate when a break is already present",
);

// The durable response is the same text concatenated, so the marks survive it
// and the preamble does not collapse back into the answer.
const persistedBlockResponse = {
  id: "persisted-block-response",
  sessionId: "session-1",
  turnId: "turn-blocks",
  createdAt: "2026-07-13T09:52:00.000Z",
  kind: "assistant-message",
  message: streamedAssistant.message,
  payload: { kind: "provider-response" },
};
const blockMerged = mergeProviderResponseEvents(
  blockEventsRef.current.get("session-1"),
  [persistedBlockResponse],
);
assert.deepEqual(
  blockMerged
    .find((event) => event.kind === "assistant-message")
    .payload.segments.map((segment) => segment.start),
  [0, 23],
  "completion should keep the block marks the stream recorded",
);

// An activity frame can land between two deltas of the same word. Opening a
// block there wrote the separator into the middle of "pad|ding" and marked a
// segment at the seam, so the rail drew half a sentence and the answer body
// opened on the other half.
assert.equal(endsStreamedTextBlock("the literal old pad"), false);
assert.equal(endsStreamedTextBlock("(it's"), false);
assert.equal(endsStreamedTextBlock("Fixed."), true);
assert.equal(endsStreamedTextBlock("**Fixed.**"), true);
assert.equal(endsStreamedTextBlock("Running the UI smoke checks:"), true);
assert.equal(endsStreamedTextBlock("A list:\n"), true);

blockEvents = [];
blockEventsRef.current.set("session-1", []);
streamBlockDelta(
  1,
  "That failure is the smoke suite pinning the literal old pad",
);
applyProviderChatStreamActivity(blockEventsRef, setBlockEvents, {
  sessionId: "session-1",
  turnId: "turn-blocks",
  providerId: "anthropic",
  eventId: "midword-activity",
  sequence: 2,
  activitySequence: 2,
  phase: "activity",
  activityId: "read-2",
  activityKind: "tool",
  activityLabel: "Read styles.css",
  activityStatus: "done",
});
streamBlockDelta(3, "ding value. ");
streamBlockDelta(4, "Updating the assertion to match the new one:");
const midWordAssistant = blockEventsRef.current
  .get("session-1")
  .find((event) => event.kind === "assistant-message");
assert.equal(
  midWordAssistant.message,
  "That failure is the smoke suite pinning the literal old padding value. " +
    "Updating the assertion to match the new one:",
  "a tool landing mid-word must not break the word in the durable message",
);
assert.deepEqual(
  midWordAssistant.payload.segments.map((segment) => segment.start),
  [0, 71],
  "the block should wait for the sentence to close rather than open at the seam",
);
assert.equal(
  midWordAssistant.message.slice(71),
  "Updating the assertion to match the new one:",
  "the deferred mark should land on a whole block, not half a word",
);

// An unsequenced event stays behind the event it followed instead of being
// dealt into another event's time slot.
const unsequencedApproval = {
  id: "approval-after-command",
  sessionId: "session-1",
  turnId: "turn-stable-timeline",
  createdAt: "2026-07-13T09:48:09.000Z",
  kind: "system-event",
  message: "Approve command",
  payload: { kind: "provider-approval" },
};
assert.deepEqual(
  orderedChatTimelineEvents([
    laterCommentary,
    timelineCommand,
    unsequencedApproval,
    firstCommentary,
  ]).map((event) => event.id),
  [
    "commentary-before",
    "command-after-edit",
    "approval-after-command",
    "commentary-after",
  ],
  "an unsequenced event should follow the event it arrived behind",
);

// The timeline index replaced a linear `find(sameTimelineEvent)` per persisted
// event. It has to answer identically for every event, including the ordering
// rule that made the original correct: the earliest matching candidate wins,
// whichever of the three rules it matched on.
const timelineCandidates = [
  {
    id: "optimistic-activity",
    sessionId: "session-1",
    turnId: "turn-index",
    createdAt: "2026-08-02T09:00:00.000Z",
    kind: "system-event",
    message: "Read config.toml",
    payload: { kind: "provider-activity", activityId: "act-1" },
  },
  {
    id: "optimistic-assistant",
    sessionId: "session-1",
    turnId: "turn-index",
    createdAt: "2026-08-02T09:00:01.000Z",
    kind: "assistant-message",
    message: "streaming answer",
    payload: { kind: "provider-stream" },
  },
  {
    id: "shared-id",
    sessionId: "session-1",
    turnId: "turn-other",
    createdAt: "2026-08-02T09:00:02.000Z",
    kind: "system-event",
    message: "Approve command",
    payload: { kind: "provider-approval" },
  },
  // Later than the activity above but matching the same key, so it must lose to
  // it — this is the case a per-rule lookup gets wrong.
  {
    id: "optimistic-activity-duplicate",
    sessionId: "session-1",
    turnId: "turn-index",
    createdAt: "2026-08-02T09:00:03.000Z",
    kind: "system-event",
    message: "Read config.toml",
    payload: { kind: "provider-activity", activityId: "act-1" },
  },
];
const timelineProbes = [
  ...timelineCandidates,
  // Same turn and kind, different id: matches the assistant rule only.
  {
    id: "persisted-assistant",
    sessionId: "session-1",
    turnId: "turn-index",
    createdAt: "2026-08-02T09:01:00.000Z",
    kind: "assistant-message",
    message: "durable answer",
    payload: {},
  },
  // Same activity key, different id: matches the activity rule only.
  {
    id: "persisted-activity",
    sessionId: "session-1",
    turnId: "turn-index",
    createdAt: "2026-08-02T09:01:01.000Z",
    kind: "system-event",
    message: "Read config.toml",
    payload: { kind: "provider-activity", activityId: "act-1" },
  },
  // No turn id at all, and an id nothing carries: matches nothing.
  {
    id: "unmatched",
    sessionId: "session-1",
    createdAt: "2026-08-02T09:01:02.000Z",
    kind: "user-message",
    message: "hello",
    payload: {},
  },
];
const timelineIndex = buildTimelineIndex(timelineCandidates);
for (const probe of timelineProbes) {
  assert.equal(
    findTimelineMatch(timelineIndex, probe)?.id,
    timelineCandidates.find((candidate) => sameTimelineEvent(candidate, probe))
      ?.id,
    `the timeline index should match ${probe.id} the way a linear scan does`,
  );
}

console.log(
  "Provider stream ordering checks passed (reorder, dedupe, completion, coalescing, background continuation, retry timing, stable activity chronology, aggregate edits, streamed text blocks, timeline index equivalence).",
);
// A title/preamble can be the only live text before the durable final reply.
// The final text must not inherit its early position or offsets, even when the
// live sequence numbers are much larger than the durable activity indices.
const earlyText = {
  ...persistedBlockResponse,
  id: "early-text",
  message: "GYRO_SESSION_TITLE: Fix warning",
  payload: {
    kind: "provider-stream",
    streaming: true,
    timelineSequence: 1,
    segments: [{ start: 0, sequence: 1 }],
  },
};
const lateTool = {
  ...timelineActivity("late-tool", "command", 200),
  turnId: earlyText.turnId,
};
const finalText = {
  ...persistedBlockResponse,
  message: "The warning is fixed.\n\nThe checks pass.",
  payload: { kind: "provider-response", status: "done", timelineSequence: 2 },
};
for (const merge of [
  (live, saved) => mergeProviderResponseEvents(live, saved),
  (live, saved) => mergePersistedAndOptimisticEvents(saved, live),
]) {
  const repaired = merge(
    [earlyText, lateTool],
    [
      finalText,
      { ...lateTool, payload: { ...lateTool.payload, timelineSequence: 1 } },
    ],
  );
  const run = buildRunModel(repaired);
  assert.equal(
    run.response?.message,
    finalText.message,
    "a durable final reply must appear below streamed tools",
  );
  assert.equal(
    run.steps.filter((step) => step.kind === "say").length,
    0,
    "the final reply must not also appear as activity narration",
  );
  const response = repaired.find((event) => event.kind === "assistant-message");
  assert.equal(
    response.payload.segments,
    undefined,
    "offsets into replaced text must be discarded",
  );
  assert.equal(response.createdAt, finalText.createdAt);
}

// Measured patch counts survive the live stream adapter and reach the badge model.
{
  const ref = { current: new Map([["counts-session", []]]) };
  applyProviderChatStreamActivity(ref, () => {}, {
    sessionId: "counts-session",
    turnId: "counts-turn",
    providerId: "openai",
    eventId: "counts-frame",
    sequence: 1,
    phase: "activity",
    activityId: "counts-file",
    activityKind: "file",
    activityLabel: "Updated src/a.ts",
    activityDetail: "src/a.ts",
    activityStatus: "done",
    additions: 7,
    deletions: 2,
  });
  const model = buildRunModel(ref.current.get("counts-session"));
  assert.equal(model.files[0].additions, 7);
  assert.equal(model.files[0].deletions, 2);
}

// Concurrent chats can report the same path and activity id without sharing totals.
{
  const ref = {
    current: new Map([
      ["chat-a", []],
      ["chat-b", []],
    ]),
  };
  let foreground = [
    {
      id: "user-a",
      sessionId: "chat-a",
      kind: "user-message",
      message: "edit",
      createdAt: "2026-09-19T10:00:00Z",
    },
  ];
  const apply = (sessionId, additions, sequence) =>
    applyProviderChatStreamActivity(
      ref,
      (update) => {
        foreground = update(foreground);
      },
      {
        sessionId,
        turnId: "turn",
        providerId: "openai",
        eventId: `frame-${sequence}`,
        sequence,
        phase: "activity",
        activityId: "same-tool-id",
        activityKind: "file",
        activityLabel: "Updated shared.css",
        activityDetail: "shared.css",
        activityStatus: "done",
        additions,
        deletions: 1,
      },
    );
  apply("chat-a", 3, 1);
  apply("chat-b", 8, 2);
  apply("chat-b", 12, 3);
  assert.equal(buildRunModel(ref.current.get("chat-a")).files[0].additions, 3);
  assert.equal(buildRunModel(ref.current.get("chat-b")).files[0].additions, 12);
  assert.equal(buildRunModel(foreground).files[0].additions, 3);
  assert.ok(foreground.every((event) => event.sessionId === "chat-a"));
}
