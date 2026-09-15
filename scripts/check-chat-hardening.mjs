import assert from "node:assert/strict";
import {
  buildTimelineIndex,
  findTimelineMatch,
  mergePersistedAndOptimisticEvents,
  mergeProviderResponseEvents,
  sameTimelineEvent,
} from "../apps/desktop/src/provider-stream-events.ts";
import { buildRunModel } from "../packages/ui/src/chat-run.ts";
import { expandAssistantMessageSegments } from "../packages/ui/src/chat-timeline.ts";
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
      (step) => step.kind === "say" && step.text.includes("clipped on its left"),
    );
    assert.equal(notes.length, 1, `${label}: the mid-run note stays on the rail once`);
    assert.ok(
      !notes[0].text.includes("GYRO_SESSION_TITLE"),
      `${label}: the rail note never shows the control marker`,
    );
  }
}
// Without block marks the wording backstop still keeps the note out.
const unmarked = buildRunModel([
  readActivity("read-1", 0),
  event("unmarked-reply", "assistant-message", `${midRunNote}\n\n${closingAnswer}`, {
    kind: "provider-response",
    status: "done",
    timelineSequence: 1,
  }),
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
  titledNote.steps.filter((step) => step.kind === "say").map((step) => step.text),
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
