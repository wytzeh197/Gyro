import assert from "node:assert/strict";

import { chatTurnTimelineSections } from "../packages/ui/src/chat-timeline.ts";

let sequence = 0;
const event = (kind, message, payload = {}, minutes = 0) => {
  sequence += 1;
  return {
    id: `evt_${sequence}`,
    sessionId: "ses_1",
    turnId: "turn_1",
    createdAt: new Date(
      Date.parse("2026-07-27T09:00:00.000Z") + minutes * 60_000,
    ).toISOString(),
    kind,
    message,
    payload,
  };
};
const activity = (activityKind, label, minutes) =>
  event(
    "system-event",
    label,
    { kind: "provider-activity", activityKind, label, status: "done" },
    minutes,
  );

const events = [
  event("assistant-message", "I'll start by reading the palette code.", {}, 0),
  activity("tool", "Read surfaces.tsx", 1),
  activity("tool", "Read styles.css", 1),
  event("assistant-message", "Now let me implement the ranker.", {}, 2),
  activity("tool", "Edit global-search.ts", 3),
  activity("tool", "Edit surfaces.tsx", 3),
  activity("tool", "Edit styles.css", 3),
  activity("file", "Edited src/sync.js", 4),
  event("assistant-message", "   ", {}, 4),
  event("assistant-message", "Done — the palette now ranks fuzzily.", {}, 5),
];

const sections = chatTurnTimelineSections(events);

// The closing message is the answer; everything before it stays in the run.
assert.equal(
  sections.response?.message,
  "Done — the palette now ranks fuzzily.",
  "the last spoken message should be the response",
);

// Narration keeps the position it was spoken in, ahead of the tools it
// introduced — the bug was that every message was hoisted below the activity.
assert.deepEqual(
  sections.work.map((item) =>
    item.kind === "activity-group"
      ? `group:${item.activityKind}:${item.events.length}`
      : `say:${item.event.message}`,
  ),
  [
    "say:I'll start by reading the palette code.",
    "group:tool:2",
    "say:Now let me implement the ranker.",
    "group:tool:3",
  ],
  "work should interleave narration and activity in order",
);

// Blank streaming fragments never become a beat or an answer.
assert.ok(
  sections.work.every(
    (item) => item.kind === "activity-group" || item.event.message.trim(),
  ),
  "blank assistant messages should be dropped",
);

// File edits stay in the change summary rather than the work stream.
assert.equal(sections.files.length, 1, "file activity should be summarised");
assert.equal(
  sections.files[0].events.length,
  1,
  "the summary should carry its file events",
);

// A turn that only ran tools has work but no answer yet.
const running = chatTurnTimelineSections([
  activity("command", "npm test", 0),
  activity("command", "npm run build", 0),
]);
assert.equal(running.response, undefined, "no message means no response");
assert.deepEqual(
  running.work.map((item) =>
    item.kind === "activity-group" ? item.events.length : "say",
  ),
  [2],
  "consecutive commands should collapse into one group",
);

// Interleaving is what splits groups, so two batches of the same kind separated
// by narration stay separate.
const split = chatTurnTimelineSections([
  activity("tool", "Read one", 0),
  event("assistant-message", "Now the second batch.", {}, 1),
  activity("tool", "Read two", 2),
  activity("tool", "Read three", 2),
  event("assistant-message", "All set.", {}, 3),
]);
assert.deepEqual(
  split.work.map((item) =>
    item.kind === "activity-group" ? `group:${item.events.length}` : "say",
  ),
  ["group:1", "say", "group:2"],
  "narration should break activity groups",
);

// A provider streams every block of a turn into one assistant event. The marks
// recorded by the stream layer split it back up so the preamble sits beside the
// work it introduced and only the closing block reads as the answer.
const segmented = chatTurnTimelineSections([
  {
    ...event("assistant-message", "", {}, 0),
    message: "I'll read the palette first.Done — it ranks fuzzily now.",
    payload: {
      segments: [
        { start: 0, sequence: 0, createdAt: "2026-07-27T09:00:00.000Z" },
        { start: 28, sequence: 2, createdAt: "2026-07-27T09:00:20.000Z" },
      ],
    },
  },
  {
    ...activity("tool", "Read surfaces.tsx", 0),
    payload: {
      kind: "provider-activity",
      activityKind: "tool",
      label: "Read surfaces.tsx",
      status: "done",
      timelineSequence: 1,
    },
  },
]);
assert.equal(
  segmented.response?.message,
  "Done — it ranks fuzzily now.",
  "only the closing block should be the answer",
);
assert.deepEqual(
  segmented.work.map((item) =>
    item.kind === "activity-group"
      ? `group:${item.events.length}`
      : `say:${item.event.message}`,
  ),
  ["say:I'll read the palette first.", "group:1"],
  "the opening block should stay above the tool it introduced",
);

// Marks that no longer fit the message are ignored rather than slicing it at
// the wrong characters.
const mismatched = chatTurnTimelineSections([
  {
    ...event("assistant-message", "Short answer.", {}, 0),
    payload: { segments: [{ start: 0 }, { start: 900 }] },
  },
]);
assert.equal(
  mismatched.response?.message,
  "Short answer.",
  "an unusable split should leave the message whole",
);

// While a run is going the opening line is a preamble to work that has not
// started yet, so it stays in the run instead of posing as an answer.
const opening = [event("assistant-message", "Let me look at that.", {}, 0)];
assert.equal(
  chatTurnTimelineSections(opening, { isRunning: true }).response,
  undefined,
  "a running turn should not answer with its first line",
);
assert.equal(
  chatTurnTimelineSections(opening).response?.message,
  "Let me look at that.",
  "a finished turn keeps its only message as the answer",
);
assert.equal(
  chatTurnTimelineSections([activity("tool", "Read one", 0), ...opening], {
    isRunning: true,
  }).response?.message,
  "Let me look at that.",
  "once work precedes it, the closing line is the answer",
);

// Narration that trails a tool is a preamble to the next batch, not an answer.
assert.equal(
  chatTurnTimelineSections([
    event("assistant-message", "Now I'll run the tests.", {}, 0),
    activity("command", "npm test", 1),
  ]).response,
  undefined,
  "a message followed by work should stay in the run",
);

// No stream marks, but the provider glued the preamble to the answer. Recover
// the boundary so collapse keeps only the answer and expand shows the preamble
// as muted work — not one meshed final bubble.
const glued = chatTurnTimelineSections([
  event(
    "assistant-message",
    "I'll check the project context and docs so the one-sentence answer matches what Gyro actually is.Gyro is a local-first macOS workspace that unifies agent chat in one place.",
    {},
    0,
  ),
]);
assert.equal(
  glued.response?.message,
  "Gyro is a local-first macOS workspace that unifies agent chat in one place.",
  "glued closing sentence should be the only final answer",
);
assert.deepEqual(
  glued.work.map((item) =>
    item.kind === "event" ? item.event.message : item.kind,
  ),
  [
    "I'll check the project context and docs so the one-sentence answer matches what Gyro actually is.",
  ],
  "glued preamble should stay in the work stream",
);

// Markdown-bolded answer after a glued boundary still splits.
const gluedBold = chatTurnTimelineSections([
  event(
    "assistant-message",
    "I'll inspect the stream first.**Gyro is a local-first macOS workspace.**",
    {},
    0,
  ),
]);
assert.equal(
  gluedBold.response?.message,
  "**Gyro is a local-first macOS workspace.**",
  "bolded glued answer should still be the final response",
);
assert.equal(
  gluedBold.work.length,
  1,
  "bolded glued preamble should stay in work",
);

console.log("chat timeline checks passed");
