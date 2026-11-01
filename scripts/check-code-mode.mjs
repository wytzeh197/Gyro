import assert from "node:assert/strict";
import {
  groupWorkflowEvents,
  workflowState,
  workflowChildren,
} from "../packages/ui/src/code-mode.ts";
import { interleavedChatTimelineItems } from "../packages/ui/src/chat-timeline.ts";
const event = (id, payload, turnId = "turn") => ({
  id,
  sessionId: "session",
  turnId,
  kind: "system-event",
  createdAt: "2026-10-12T00:00:00Z",
  message: id,
  payload,
});
const parent = event("parent", {
  kind: "capability-call",
  capabilityId: "code-mode-execute",
  callId: "group",
  status: "running",
  codeMode: { label: "Inspect settings", source: "return 1" },
});
const child = (id, status, turn) =>
  event(
    id,
    {
      kind: "capability-call",
      capabilityId: "workspace-read",
      callId: id,
      groupId: "group",
      status,
      summary: "Read " + id,
    },
    turn,
  );
const approval = event("approval", {
  kind: "capability-approval",
  callId: "one",
  status: "waiting",
});
let grouped = groupWorkflowEvents([
  parent,
  child("one", "running"),
  approval,
  child("one", "completed"),
  child("two", "denied"),
]);
assert.equal(grouped.length, 2);
assert.equal(
  grouped[1].id,
  "approval",
  "approval must remain outside collapsed work",
);
assert.equal(
  workflowChildren(grouped[0]).length,
  2,
  "updates fold by child identity",
);
assert.equal(workflowState(grouped[0]).counts.completed, 1);
assert.equal(
  workflowChildren(groupWorkflowEvents(grouped)[0]).length,
  2,
  "grouping is idempotent",
);
const done = {
  ...parent,
  payload: {
    ...parent.payload,
    status: "completed",
    codeMode: {
      ...parent.payload.codeMode,
      outcome: {
        partial: true,
        outcome: {
          ok: false,
          error: { kind: "ToolFailure", message: "Denied" },
        },
      },
    },
  },
};
grouped = groupWorkflowEvents([
  parent,
  child("one", "completed"),
  done,
  child("two", "denied"),
]);
assert.equal(grouped.length, 1);
assert.equal(grouped[0].id, "parent");
assert.equal(workflowState(grouped[0]).label, "Partial");
assert.equal(groupWorkflowEvents([child("orphan", "completed")]).length, 1);
assert.equal(
  groupWorkflowEvents([parent, child("other", "completed", "other-turn")])
    .length,
  2,
  "membership never crosses turns",
);
assert.equal(
  workflowState(
    groupWorkflowEvents([parent, child("one", "running")], "cancelled")[0],
  ).label,
  "Interrupted",
);
const items = interleavedChatTimelineItems([
  done,
  child("one", "completed"),
  approval,
]);
assert.equal(items.length, 2);
assert.equal(workflowChildren(items[0].event).length, 1);
assert.equal(
  workflowState(
    groupWorkflowEvents([
      done,
      parent,
      child("one", "completed"),
      child("one", "running"),
    ])[0],
  ).counts.completed,
  1,
  "late stale events cannot reopen finished work",
);
const receiptParent = {
  ...done,
  payload: {
    ...done.payload,
    codeMode: {
      ...done.payload.codeMode,
      outcome: {
        partial: false,
        outcome: { ok: true, value: "saved" },
        calls: [
          {
            callId: "one",
            name: "gyro_workspace_read",
            status: "completed",
            summary: "Read one",
            durationMs: 25,
            resource: { id: "file-one", kind: "workspace", label: "one.txt" },
          },
        ],
      },
    },
  },
};
const restored = groupWorkflowEvents([receiptParent])[0];
assert.equal(
  workflowChildren(restored).length,
  1,
  "terminal receipts restore paged-out child actions",
);
assert.equal(workflowState(restored).counts.completed, 1);
assert.equal(
  workflowChildren(
    groupWorkflowEvents([receiptParent, child("one", "running")])[0],
  )[0].payload.status,
  "completed",
);
console.log(
  "Code Mode grouping, approvals, pagination, and recovery checks passed",
);
