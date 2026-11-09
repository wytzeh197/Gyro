import assert from "node:assert/strict";
import { reconcileCapabilityCalls } from "../packages/ui/src/capability-call-lifecycle.ts";
import {
  buildRunModel,
  partitionSegmentCalls,
  runCallText,
  workItemFromEvent,
} from "../packages/ui/src/chat-run.ts";

const event = (id, callId, status, second, extra = {}) => ({
  id,
  sessionId: "chat",
  turnId: "turn",
  kind: "system-event",
  createdAt: new Date(1700000000000 + second * 1000).toISOString(),
  message: status,
  payload: {
    kind: "capability-call",
    schema: "gyro.capability.v1",
    capabilityId: "workspace-read",
    callId,
    status,
    inspection: { path: "src/one.ts" },
    timelineOrder: second,
    ...extra,
  },
});
const note = {
  id: "note",
  sessionId: "chat",
  turnId: "turn",
  kind: "assistant-message",
  createdAt: new Date(1700000001500).toISOString(),
  message: "Checking the next file.",
  payload: { kind: "provider-commentary", timelineOrder: 1.5 },
};
const input = [
  event("a-request", "a", "requested", 1),
  note,
  event("b-request", "b", "requested", 2, {
    inspection: { path: "src/two.ts" },
  }),
  event("a-running", "a", "running", 3),
  event("b-running", "b", "running", 4, { inspection: { path: "src/two.ts" } }),
  event("a-done", "a", "completed", 5),
  event("b-done", "b", "completed", 6, { inspection: { path: "src/two.ts" } }),
];
const original = structuredClone(input);
const rows = reconcileCapabilityCalls(input);
assert.deepEqual(
  input,
  original,
  "projection must not change raw durable history",
);
assert.equal(rows.length, 3);
assert.equal(rows[0].id, "a-request");
assert.equal(rows[0].createdAt, input[0].createdAt);
assert.equal(rows[0].payload.timelineOrder, 1);
assert.equal(rows[0].payload.status, "completed");
assert.equal(rows[1].id, "note", "narration keeps its place between calls");
assert.equal(rows[2].payload.status, "completed");

for (const status of ["completed", "failed", "denied", "cancelled"]) {
  const projected = reconcileCapabilityCalls([
    event("done", "a", status, 3),
    event("stale-request", "a", "requested", 1),
    event("stale-running", "a", "running", 4),
  ]);
  assert.equal(projected.length, 1);
  assert.equal(
    projected[0].payload.status,
    status,
    "a delayed start never reopens a finished call",
  );
  assert.equal(projected[0].createdAt, event("x", "a", "", 1).createdAt);
}
assert.equal(
  reconcileCapabilityCalls([
    event("a1", "a", "completed", 1),
    event("a2", "b", "completed", 2),
  ]).length,
  2,
  "separate calls reading the same path remain separate",
);
assert.equal(
  reconcileCapabilityCalls([
    event("a1", "a", "completed", 1),
    { ...event("a2", "a", "running", 2), turnId: "other-turn" },
    { ...event("a3", "a", "running", 3), sessionId: "other-chat" },
  ]).length,
  3,
  "call identifiers are scoped to their chat and turn",
);
assert.equal(
  reconcileCapabilityCalls([
    event("legacy1", undefined, "running", 1),
    event("legacy2", undefined, "completed", 2),
  ]).length,
  2,
  "legacy events without a call id are not guessed together",
);

const model = buildRunModel(input, { isRunning: true });
const work = model.steps.filter((step) => step.kind === "work");
assert.equal(work.length, 2);
assert.ok(work.every((step) => step.item.status === "done"));
assert.equal(
  partitionSegmentCalls(work).visible.length,
  0,
  "finished calls fold while the parent turn is active",
);
const active = buildRunModel(input.slice(0, -1), {
  isRunning: true,
}).steps.filter((step) => step.kind === "work");
assert.equal(
  active.filter((step) => step.item.status === "running").length,
  1,
  "only unfinished calls spin",
);

const missing = event("missing", "search", "failed", 7, {
  capabilityId: "workspace-search",
  inspection: {
    errorCode: "invalid-search-scope",
    path: "src/missing.ts",
    query: "UsageOrigin::|origin.*match",
  },
  summary: "The search path does not exist. Correct the path before retrying.",
});
const item = workItemFromEvent(missing);
assert.equal(item.query, "UsageOrigin::|origin.*match");
assert.equal(item.error, missing.payload.summary);
assert.deepEqual(
  runCallText({ kind: "work", id: missing.id, at: missing.createdAt, item }),
  {
    label: "Search path not found",
    description: "src/missing.ts",
  },
);
console.log(
  "Capability lifecycle checks passed: interleaving, replay, terminal states, isolation, original chronology, grouping, and missing-path errors.",
);
