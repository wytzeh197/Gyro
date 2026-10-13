import assert from "node:assert/strict";
import { createTranscriptTurnCache } from "../packages/ui/src/chat-history-efficiency.ts";
import {
  mergeSessionHistoryPages,
  compareSessionEventsForHistory,
} from "../apps/desktop/src/session-event-order.ts";
const event = (i, payload = {}) => ({
  id: "event-" + i,
  sessionId: "history",
  turnId: "turn-" + i,
  kind: "assistant-message",
  message: "Reply " + i,
  createdAt: new Date(i * 1000).toISOString(),
  payload,
});
const reference = (current, page) => {
  const byId = new Map(current.map((row) => [row.id, row]));
  for (const row of page) byId.set(row.id, row);
  return Array.from(byId.values()).sort(compareSessionEventsForHistory);
};
const history = Array.from({ length: 20000 }, (_, i) => event(i));
const page = structuredClone(history.slice(-400));
assert.equal(
  mergeSessionHistoryPages(history, page),
  history,
  "unchanged pages retain the array and all row objects",
);
assert.equal(mergeSessionHistoryPages(history, []), history);
const changed = mergeSessionHistoryPages(history, [
  { ...event(19999), message: "corrected reply" },
  event(20000),
]);
assert.equal(changed.length, 20001);
assert.equal(
  changed[0],
  history[0],
  "older payloads are shared without copies",
);
assert.equal(changed.at(-2).message, "corrected reply");
for (let trial = 0; trial < 100; trial++) {
  const base = Array.from({ length: 70 }, (_, i) => event(i));
  const fresh = Array.from({ length: 25 }, (_, i) => ({
    ...event((i * 13 + trial) % 100),
    message: "updated " + trial,
    createdAt: new Date(((i + trial) % 100) * 500).toISOString(),
  }));
  if (trial % 2) base.reverse();
  if (trial % 3 === 0)
    fresh.push({ ...fresh[0], message: "last duplicate wins" });
  assert.deepEqual(
    mergeSessionHistoryPages(base, fresh),
    reference(base, fresh),
    "ordering and durable replacements match the prior complete-history contract",
  );
}
const imported = history
  .slice(0, 30)
  .map((row, i) => ({
    ...row,
    payload: { historical: true, timelineSequence: 29 - i },
  }));
assert.deepEqual(
  mergeSessionHistoryPages(imported, imported.slice(-4)),
  reference(imported, imported.slice(-4)),
  "imported source order survives",
);
let prepares = 0;
const cache = createTranscriptTurnCache();
const prepare = (turn) => {
  prepares++;
  return { ...turn, timelineEvents: turn.timelineEvents.slice() };
};
const turns = Array.from({ length: 1550 }, (_, i) => ({
  id: "turn-" + i,
  startedAt: event(i).createdAt,
  user: { ...event(i), kind: "user-message" },
  timelineEvents: [event(i)],
}));
const initial = cache.reconcile(turns, prepare);
prepares = 0;
const nextSource = turns.map((turn, i) => ({
  ...turn,
  timelineEvents:
    i === 1549
      ? [{ ...turn.timelineEvents[0], message: "streamed" }]
      : turn.timelineEvents.slice(),
}));
const next = cache.reconcile(nextSource, prepare);
assert.equal(prepares, 1, "only the live turn is regrouped");
assert.equal(next[0], initial[0]);
assert.notEqual(next.at(-1), initial.at(-1));
const approved = nextSource.map((turn, i) =>
  i === 0
    ? {
        ...turn,
        timelineEvents: [
          { ...turn.timelineEvents[0], payload: { status: "applied" } },
        ],
      }
    : turn,
);
prepares = 0;
const approvalResult = cache.reconcile(approved, prepare);
assert.equal(
  prepares,
  1,
  "late approvals invalidate their owning historical turn",
);
assert.equal(approvalResult[0].timelineEvents[0].payload.status, "applied");
const retry = approved.map((turn, i) =>
  i === 1549 ? { ...turn, runStatus: "waiting" } : turn,
);
prepares = 0;
cache.reconcile(retry, prepare);
assert.equal(prepares, 1, "retry metadata cannot be hidden by the cache");
cache.reconcile([], prepare);
prepares = 0;
cache.reconcile(turns.slice(0, 1), prepare);
assert.equal(prepares, 1, "retired rows are not retained in the cache");
const start = performance.now();
for (let i = 0; i < 30; i++)
  assert.equal(mergeSessionHistoryPages(history, page), history);
console.log(
  "History efficiency passed: 20,000-event unchanged identity, linear complete merges, randomized ordering, imported records, 1/1,550 rebuilt turns, late approvals, retry metadata and cache retirement.",
);
console.log(
  "30 unchanged history merges: " +
    (performance.now() - start).toFixed(1) +
    " ms (fixture measurement).",
);
