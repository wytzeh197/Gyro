import assert from "node:assert/strict";
import {
  applyProviderChatStreamActivity,
  applyProviderChatStreamDeltas,
  buildTimelineIndex,
  findTimelineMatch,
  mergeLiveCapabilityEvent,
  mergePersistedAndOptimisticEvents,
  mergeProviderResponseEvents,
  preserveDeliveredResponses,
  sameTimelineEvent,
} from "../apps/desktop/src/provider-stream-events.ts";
import { buildRunModel, segmentRunSteps } from "../packages/ui/src/chat-run.ts";
import {
  expandAssistantMessageSegments,
  orderedChatTimelineEvents,
} from "../packages/ui/src/chat-timeline.ts";
import {
  finalAssistantResponseText,
  stripHiddenControlMarkers,
} from "../packages/ui/src/chat-commentary.ts";

const event = (id, kind, message, payload = {}, turnId = "turn-1") => ({
  id,
  kind,
  message,
  payload,
  turnId,
  sessionId: "session-1",
  createdAt: "2026-09-13T10:00:00.000Z",
});
const answer = event("answer", "assistant-message", "Fixed.", {
  kind: "provider-response",
  status: "done",
  timelineSequence: 2,
});
const tool = event("tool", "system-event", "Ran tests", {
  kind: "provider-activity",
  activityKind: "command",
  activityId: "tool",
  label: "Ran tests",
  status: "done",
  timelineSequence: 100,
});
const commentary = (turnId, sessionId = "session-1") => ({
  ...event(
    "comment-" + turnId + sessionId,
    "system-event",
    "Fixed.",
    {
      kind: "provider-activity",
      activityKind: "commentary",
      label: "Fixed.",
    },
    turnId,
  ),
  sessionId,
});

// Completion only deduplicates narration belonging to the same chat and turn.
const prior = commentary("turn-0");
const otherChat = commentary("turn-1", "session-2");
const merged = mergeProviderResponseEvents(
  [prior, otherChat, commentary("turn-1")],
  [answer],
);
assert.deepEqual(
  merged.map((e) => e.id),
  [prior.id, otherChat.id, answer.id],
);
const foreign = { ...answer, sessionId: "session-2" };
assert.equal(sameTimelineEvent(answer, foreign), false);
assert.equal(
  findTimelineMatch(buildTimelineIndex([answer]), foreign),
  undefined,
);
assert.equal(mergeProviderResponseEvents([foreign], [answer]).length, 2);
assert.equal(mergePersistedAndOptimisticEvents([foreign], [answer]).length, 2);
// A read begun before completion must not erase the answer delivered while it
// was in flight, including when the stale page still has a streaming preview.
const user = event("user", "user-message", "Question");
const stream = {
  ...answer,
  id: "stream",
  message: "Fix",
  payload: { kind: "provider-stream", streaming: true },
};
const refreshed = preserveDeliveredResponses([user, stream], [user, answer]);
assert.equal(
  refreshed.filter((item) => item.kind === "assistant-message").length,
  1,
);
assert.equal(buildRunModel(refreshed).response?.message, "Fixed.");
assert.deepEqual(preserveDeliveredResponses(refreshed, refreshed), refreshed);
assert.deepEqual(preserveDeliveredResponses([user], [foreign]), [user]);
assert.equal(
  stripHiddenControlMarkers("The GYRO_SESSION_TITLE: marker names a session."),
  "The GYRO_SESSION_TITLE: marker names a session.",
);
assert.equal(
  stripHiddenControlMarkers("GYRO_SESSION_TITLE: Fix chat\nThe answer."),
  "\nThe answer.",
);
const withoutTurn = { ...answer, turnId: undefined };
assert.equal(
  mergeProviderResponseEvents(
    [withoutTurn],
    [{ ...withoutTurn, id: "another" }],
  ).length,
  2,
);

// A final reply with unchanged text still needs its own closing position when
// tools arrived after the text and there are no trustworthy block boundaries.
for (const merge of [
  (live, saved) => mergeProviderResponseEvents(live, saved),
  (live, saved) => mergePersistedAndOptimisticEvents(saved, live),
]) {
  for (const message of [
    "GYRO_SESSION_TITLE: Fix chat",
    "Fix",
    answer.message,
  ]) {
    const live = [
      {
        ...answer,
        message,
        payload: {
          kind: "provider-stream",
          streaming: true,
          timelineSequence: 1,
          segments: [{ start: 0, sequence: 1 }],
        },
      },
      tool,
    ];
    const saved = [
      answer,
      { ...tool, payload: { ...tool.payload, timelineSequence: 1 } },
    ];
    const first = merge(live, saved);
    const second = merge(first, saved);
    for (const events of [first, second]) {
      const run = buildRunModel(events);
      assert.equal(run.response?.message, answer.message);
      assert.equal(run.steps.filter((s) => s.kind === "say").length, 0);
    }
    assert.deepEqual(
      second,
      first,
      "repeated refresh must not move the reply again",
    );
  }
}

// Ignore the entire malformed segment list, not just its invalid tail.
const damaged = event(
  "damaged",
  "assistant-message",
  "First paragraph.\n\nSecond paragraph.",
  {
    segments: [
      { start: 0, sequence: 1 },
      { start: 3, sequence: 2 },
      { start: 999 },
    ],
  },
);
assert.deepEqual(
  expandAssistantMessageSegments([damaged]).map((e) => e.message.trim()),
  ["First paragraph.", "Second paragraph."],
);

// The stream noise filter must not erase legitimate final answers.
for (const message of ["A", "7", "✓", "👍"]) {
  assert.equal(finalAssistantResponseText(message), message);
  const run = buildRunModel([{ ...answer, message }]);
  assert.equal(
    run.response?.message,
    message,
    "preserve short final answer: " + message,
  );
}

console.log(
  "Chat hardening checks passed: turn isolation, final reply placement, idempotent refresh, corrupt segments, short replies.",
);

// A durable conclusion must survive later work, regardless of stream order.
for (const late of [
  tool,
  event("late-read", "system-event", "Read complete", {
    kind: "capability-call",
    capabilityId: "workspace-read",
    callId: "read",
    status: "done",
    timelineSequence: 101,
  }),
  commentary("turn-1"),
]) {
  for (const isRunning of [true, false]) {
    const final = { ...answer, message: "**Fixed.**\n\nTests passed." };
    const run = buildRunModel([final, late], { isRunning });
    assert.equal(
      run.response?.message,
      final.message,
      "late work must not hide the final reply",
    );
    assert.ok(
      !run.steps.some((s) => s.kind === "say" && s.text.includes("**Fixed.**")),
      "the final answer must not also appear inside the collapsed rail",
    );
  }
}
const previousAnswer = {
  ...answer,
  id: "previous",
  message: "Earlier attempt.",
  payload: {
    ...answer.payload,
    timelineSequence: 1,
  },
};
assert.equal(
  buildRunModel([previousAnswer, answer]).response?.message,
  answer.message,
  "a previous answer must not be concatenated into the latest conclusion",
);
const streamOnly = {
  ...answer,
  payload: { kind: "provider-stream", streaming: true, timelineSequence: 1 },
};
assert.equal(
  buildRunModel([streamOnly, tool], { isRunning: true }).response,
  undefined,
  "live commentary must not be promoted to a durable conclusion",
);
console.log("late-activity final-response regressions passed");

// A saved reply holds every text block of the turn. A block spoken before the
// tools must stay on the rail, not reappear above the answer once the turn
// settles — even when its wording escapes the preamble heuristics.
const midRunNote =
  "The context usage popover is clipped on its left side. It opens centred above the ring, but in a narrow pane it runs past the chat pane's left edge, so the model name and the \"Limits\" label get cut off. Next I'm finding its styles and markup.";
const closingAnswer =
  "I fixed the clipped usage popover.\n\n**The issue:** the popover was pinned to the ring.";
const readActivity = (id, timelineSequence) =>
  event(id, "system-event", "Read styles.css", {
    kind: "provider-activity",
    activityKind: "read",
    activityId: id,
    label: "Read styles.css",
    status: "done",
    timelineSequence,
  });
for (const [label, prefix] of [
  ["plain", ""],
  ["title marker", "GYRO_SESSION_TITLE: Fix clipped popover\n"],
]) {
  const note = `${prefix}${midRunNote}`;
  const saved = event(
    "saved-reply",
    "assistant-message",
    `${note}\n\n${closingAnswer}`,
    {
      kind: "provider-response",
      status: "done",
      timelineSequence: 2,
      segments: [
        { start: 0, sequence: 0, afterActivityId: null },
        { start: note.length + 2, sequence: 2, afterActivityId: "read-2" },
      ],
    },
  );
  for (const events of [
    [readActivity("read-1", 0), readActivity("read-2", 1), saved],
    [saved, readActivity("read-1", 0), readActivity("read-2", 1)],
  ]) {
    const run = buildRunModel(events);
    assert.equal(
      run.response?.message,
      closingAnswer,
      `${label}: the final reply is only the closing block`,
    );
    const notes = run.steps.filter(
      (step) =>
        step.kind === "say" && step.text.includes("clipped on its left"),
    );
    assert.equal(
      notes.length,
      1,
      `${label}: the mid-run note stays on the rail once`,
    );
    assert.ok(
      !notes[0].text.includes("GYRO_SESSION_TITLE"),
      `${label}: the rail note never shows the control marker`,
    );
  }
}
// Without block marks the wording backstop still keeps the note out.
const unmarked = buildRunModel([
  readActivity("read-1", 0),
  event(
    "unmarked-reply",
    "assistant-message",
    `${midRunNote}\n\n${closingAnswer}`,
    {
      kind: "provider-response",
      status: "done",
      timelineSequence: 1,
    },
  ),
]);
assert.ok(
  !unmarked.response?.message.includes("clipped on its left"),
  "an unmarked saved reply must still peel progress narration",
);
console.log("mid-run narration regressions passed");

// A later turn that repeats the title line keeps its narration on the rail;
// only the marker is removed, and a marker-only note still disappears.
const commentaryNote = (id, label) =>
  event(id, "system-event", label, {
    kind: "provider-activity",
    activityKind: "commentary",
    activityId: id,
    label,
    status: "done",
    timelineSequence: 0,
  });
const titledNote = buildRunModel(
  [
    commentaryNote(
      "titled-note",
      "GYRO_SESSION_TITLE: Fix popover\nI'm checking the popover styles.",
    ),
    readActivity("read-after-note", 1),
  ],
  { isRunning: true },
);
assert.deepEqual(
  titledNote.steps
    .filter((step) => step.kind === "say")
    .map((step) => step.text),
  ["I'm checking the popover styles."],
  "a stray title line must not hide the note it sits above",
);
const markerOnlyNote = buildRunModel(
  [
    commentaryNote("marker-only", "GYRO_SESSION_TITLE: Fix popover"),
    readActivity("read-after-marker", 1),
  ],
  { isRunning: true },
);
assert.equal(
  markerOnlyNote.steps.filter((step) => step.kind === "say").length,
  0,
  "a note that is only a title marker stays hidden",
);
console.log("stray title marker regressions passed");

// Tool calls are written immediately while provider commentary can be batched
// until completion. Disk order and provider-only counters are not chronology.
{
  const opening = "I'll check every model's event path.";
  const progress = "The saved events reveal the ordering gap.";
  const finalText = "Chronology is preserved after reopening the chat.";
  const at = (second) =>
    `2026-09-20T10:00:${String(second).padStart(2, "0")}.000Z`;
  const activity = (id, activityKind, label, timelineOrder, timelineSequence) =>
    event(id, "system-event", label, {
      kind: "provider-activity",
      activityId: id,
      activityKind,
      label,
      status: "done",
      timelineOrder,
      timelineCreatedAt: at(timelineOrder),
      timelineSequence,
    });
  const capability = (id, capabilityId, timelineOrder) =>
    event(id, "system-event", id, {
      kind: "capability-call",
      callId: id,
      capabilityId,
      status: "done",
      timelineOrder,
      timelineCreatedAt: at(timelineOrder),
    });
  const firstNote = activity("opening-note", "commentary", opening, 0, 0);
  const firstCall = capability("search-call", "workspace-search", 1);
  const secondNote = activity("progress-note", "commentary", progress, 2, 1);
  const secondCall = capability("read-call", "workspace-read", 3);
  const thinking = activity(
    "thinking",
    "reasoning",
    "Checking chronology",
    4,
    2,
  );
  const conclusion = event("canonical-final", "assistant-message", finalText, {
    kind: "provider-response",
    status: "done",
    timelineOrder: 5,
    timelineCreatedAt: at(5),
    timelineSequence: 3,
  });
  const chronological = [
    firstNote,
    firstCall,
    secondNote,
    secondCall,
    thinking,
    conclusion,
  ];
  const persisted = [
    firstCall,
    secondCall,
    conclusion,
    firstNote,
    secondNote,
    thinking,
  ];
  const assertChronology = (events, label) => {
    assert.deepEqual(
      orderedChatTimelineEvents(events).map((item) => item.id),
      chronological.map((item) => item.id),
      `${label}: all event channels must share their original chronology`,
    );
    const run = buildRunModel(events, { isRunning: true });
    assert.equal(
      run.response?.message,
      finalText,
      `${label}: final answer closes`,
    );
    assert.deepEqual(
      segmentRunSteps(run.steps).map((segment) =>
        segment.kind === "say" ? segment.step.text : segment.kind,
      ),
      [opening, "work", progress, "work"],
      `${label}: each work summary stays below the commentary preceding it`,
    );
  };
  assertChronology(
    JSON.parse(JSON.stringify(persisted)),
    "cold reload without optimistic state",
  );

  // A frontend-only sequence from before the refresh may be much larger than
  // a durable activity index. Neither may override the shared canonical clock.
  const staleOptimistic = chronological.map((item, index) => {
    const { timelineOrder, timelineCreatedAt, ...payload } = item.payload;
    return {
      ...item,
      payload: { ...payload, timelineSequence: 100 - index * 10 },
    };
  });
  const refreshed = mergePersistedAndOptimisticEvents(
    persisted,
    staleOptimistic,
  );
  assertChronology(refreshed, "persisted-first refresh");
  const refreshedAgain = mergePersistedAndOptimisticEvents(
    persisted,
    refreshed,
  );
  assertChronology(refreshedAgain, "repeated persisted-first refresh");
  assert.deepEqual(
    refreshedAgain,
    refreshed,
    "canonical refresh is idempotent",
  );

  // The broker emits several records for one call. Its completion belongs at
  // the call's starting position even if a later frame carries a newer clock.
  const started = {
    ...firstCall,
    id: "search-start",
    payload: { ...firstCall.payload, status: "running" },
  };
  let live = mergeLiveCapabilityEvent([firstNote], started);
  live.push(secondNote);
  live = mergeLiveCapabilityEvent(live, {
    ...firstCall,
    id: "search-done",
    payload: {
      ...firstCall.payload,
      timelineOrder: 8,
      timelineCreatedAt: at(8),
    },
  });
  const completion = live.find((item) => item.id === "search-done");
  assert.equal(
    completion.payload.timelineOrder,
    1,
    "call completion keeps its start order",
  );
  assert.equal(
    completion.payload.timelineCreatedAt,
    at(1),
    "call completion keeps its start timestamp",
  );
  assert.deepEqual(
    orderedChatTimelineEvents(live).map((item) => item.id),
    [firstNote.id, "search-start", "search-done", secondNote.id],
    "late call updates never jump across newer commentary",
  );

  // Ordering counters reset at turn boundaries and are scoped to each chat.
  const earlierTurn = [
    event(
      "old-last",
      "system-event",
      "Old last",
      { timelineOrder: 81 },
      "turn-0",
    ),
    event(
      "old-first",
      "system-event",
      "Old first",
      { timelineOrder: 80 },
      "turn-0",
    ),
  ];
  const otherSession = {
    ...event("other-session", "system-event", "Other session", {
      timelineOrder: 0,
    }),
    sessionId: "session-2",
  };
  assert.deepEqual(
    orderedChatTimelineEvents([...earlierTurn, ...persisted, otherSession]).map(
      (item) => item.id,
    ),
    [
      "old-first",
      "old-last",
      ...chronological.map((item) => item.id),
      otherSession.id,
    ],
    "sorting a new turn or chat must not move it above an older one",
  );
}

// Stream frames have a transport sequence and an independent shared order.
// Segmented assistant text must keep that shared order and its emission time.
{
  const ref = { current: new Map() };
  const sessionId = "canonical-stream";
  const turnId = "canonical-turn";
  const frame = (sequence, timelineOrder, timelineCreatedAt, extra) => ({
    providerId: "openai",
    sessionId,
    turnId,
    sequence,
    eventId: `canonical-frame-${sequence}`,
    timelineOrder,
    timelineCreatedAt,
    ...extra,
  });
  const firstAt = "2026-09-20T11:00:01.000Z";
  const callAt = "2026-09-20T11:00:02.000Z";
  const secondAt = "2026-09-20T11:00:03.000Z";
  applyProviderChatStreamDeltas(ref, () => {}, [
    frame(100, 0, firstAt, {
      phase: "delta",
      textDelta: "I'll inspect the files.",
    }),
  ]);
  const call = {
    ...event("canonical-stream-read", "system-event", "Read source", {
      kind: "capability-call",
      capabilityId: "workspace-read",
      callId: "canonical-stream-read",
      status: "done",
      timelineOrder: 1,
      timelineCreatedAt: callAt,
    }),
    sessionId,
    turnId,
  };
  ref.current.set(
    sessionId,
    mergeLiveCapabilityEvent(ref.current.get(sessionId), call),
  );
  applyProviderChatStreamDeltas(ref, () => {}, [
    frame(101, 2, secondAt, {
      phase: "delta",
      textDelta: "\n\nThe files confirm the issue.",
    }),
  ]);
  const events = ref.current.get(sessionId);
  const ordered = orderedChatTimelineEvents(
    expandAssistantMessageSegments(events),
  );
  assert.deepEqual(
    ordered.map((item) => item.message.trim()),
    ["I'll inspect the files.", "Read source", "The files confirm the issue."],
    "text blocks preserve capability calls between provider frames",
  );
  const textBlocks = ordered.filter(
    (item) => item.kind === "assistant-message",
  );
  assert.deepEqual(
    textBlocks.map((item) => item.payload.timelineOrder),
    [0, 2],
    "each text block retains its own canonical order",
  );
  assert.deepEqual(
    textBlocks.map((item) => item.createdAt),
    [firstAt, secondAt],
    "each text block displays its emission timestamp instead of flush time",
  );

  applyProviderChatStreamActivity(
    ref,
    () => {},
    frame(102, 3, secondAt, {
      phase: "activity",
      activityId: "canonical-status",
      activityKind: "command",
      activityLabel: "Run regression checks",
      activityStatus: "running",
    }),
  );
  applyProviderChatStreamActivity(
    ref,
    () => {},
    frame(103, 9, "2026-09-20T11:00:09.000Z", {
      phase: "activity",
      activityId: "canonical-status",
      activityKind: "command",
      activityLabel: "Run regression checks",
      activityStatus: "done",
    }),
  );
  const status = ref.current
    .get(sessionId)
    .find((item) => item.payload?.activityId === "canonical-status");
  assert.equal(
    status.payload.timelineOrder,
    3,
    "activity updates retain first emission order",
  );
  assert.equal(
    status.createdAt,
    secondAt,
    "activity updates retain first emission timestamp",
  );

  // Durable segment marks are sufficient on their own after optimistic state
  // is discarded. Legacy sequence marks must not override the shared order.
  const prefix = "I'll inspect the files.\n\n";
  const durable = {
    ...event(
      "canonical-saved-segments",
      "assistant-message",
      prefix + "The files confirm the issue.",
      {
        kind: "provider-response",
        status: "done",
        timelineOrder: 3,
        timelineSequence: 2,
        segments: [
          { start: 0, sequence: 100, timelineOrder: 0, createdAt: firstAt },
          {
            start: prefix.length,
            sequence: 101,
            timelineOrder: 2,
            createdAt: secondAt,
          },
        ],
      },
    ),
    sessionId,
    turnId,
  };
  const coldBlocks = orderedChatTimelineEvents(
    expandAssistantMessageSegments([call, durable]),
  );
  assert.deepEqual(
    coldBlocks.map((item) => item.message.trim()),
    ordered.map((item) => item.message.trim()),
  );
  assert.deepEqual(
    coldBlocks
      .filter((item) => item.kind === "assistant-message")
      .map((item) => item.createdAt),
    [firstAt, secondAt],
    "saved segment timestamps survive a cold replay",
  );
}
console.log(
  "Canonical chronology checks passed: cold replay, refresh, lifecycle updates, segments, turn isolation.",
);
