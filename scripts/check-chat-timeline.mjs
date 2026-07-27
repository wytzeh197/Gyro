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

console.log("chat timeline checks passed");
