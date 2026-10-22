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
const output = "x".repeat(20_000);
const heavyHistory = Array.from({ length: 40 }, (_, i) =>
  event(i, { stdout: output, exitCode: 0, nested: { ok: true } }),
);
const reordered = heavyHistory.map((row) => ({
  payload: { nested: { ok: true }, exitCode: 0, stdout: output },
  createdAt: row.createdAt,
  message: row.message,
  sessionId: row.sessionId,
  kind: row.kind,
  id: row.id,
  turnId: row.turnId,
}));
assert.notEqual(
  JSON.stringify(heavyHistory[0]),
  JSON.stringify(reordered[0]),
  "fixture key order must differ, or the copy-avoidance check is vacuous",
);
assert.equal(
  mergeSessionHistoryPages(heavyHistory, reordered),
  heavyHistory,
  "key order alone does not copy a page of command output",
);
let stdoutReads = 0;
const sourcePayload = heavyHistory[39].payload;
const trackedPayload = {
  exitCode: sourcePayload.exitCode,
  nested: sourcePayload.nested,
};
Object.defineProperty(trackedPayload, "stdout", {
  enumerable: true,
  get() {
    stdoutReads += 1;
    return sourcePayload.stdout;
  },
});
const edited = {
  ...heavyHistory[39],
  message: "changed",
  payload: trackedPayload,
};
const editedPage = mergeSessionHistoryPages(heavyHistory, [edited]);
assert.equal(
  stdoutReads,
  0,
  "a message edit does not read the previous command output",
);
assert.equal(editedPage.at(-1).message, "changed");
assert.equal(editedPage[0], heavyHistory[0]);
const payloadEdited = {
  ...heavyHistory[10],
  payload: { stdout: output, exitCode: 1, nested: { ok: true } },
};
const replaced = mergeSessionHistoryPages(heavyHistory, [payloadEdited]);
assert.equal(replaced[10], payloadEdited);
assert.equal(replaced[9], heavyHistory[9]);
function nest(value, depth) {
  let node = value;
  for (let level = 0; level < depth; level += 1) node = { child: node };
  return node;
}
const deepSame = event(0, nest("same", 40));
const deepCopy = { ...deepSame, payload: nest("same", 40) };
assert.equal(mergeSessionHistoryPages([deepSame], [deepCopy])[0], deepSame);
const deepDifferent = { ...deepSame, payload: nest("different", 40) };
assert.equal(
  mergeSessionHistoryPages([deepSame], [deepDifferent])[0],
  deepDifferent,
);
const start = performance.now();
for (let i = 0; i < 30; i++)
  assert.equal(mergeSessionHistoryPages(history, page), history);
const smallMs = performance.now() - start;
const largeStarted = performance.now();
for (let i = 0; i < 10; i++)
  assert.equal(
    mergeSessionHistoryPages(heavyHistory, reordered),
    heavyHistory,
  );
const largeMs = performance.now() - largeStarted;
console.log(
  "History efficiency passed: 20,000-event unchanged identity, linear complete merges, randomized ordering, imported records, 1/1,550 rebuilt turns, late approvals, retry metadata, cache retirement, and in-place command-output compares.",
);
console.log(
  "30 unchanged history merges: " +
    smallMs.toFixed(1) +
    " ms (fixture measurement).",
);
console.log(
  "10 reordered 20 KB command-output page merges: " +
    largeMs.toFixed(1) +
    " ms (fixture measurement).",
);
