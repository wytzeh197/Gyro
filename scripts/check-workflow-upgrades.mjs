import assert from "node:assert/strict";
import { restoreCompanionPanes } from "../packages/ui/src/chat-companion.ts";
import { turnReviewPatches } from "../packages/ui/src/file-review.ts";
import { chatTaskFromSession } from "../packages/ui/src/chat-tasks.ts";
const restored = restoreCompanionPanes(
  JSON.stringify({
    solo: {
      openTabs: ["files", "side-chat", "review", "files", "invalid"],
      activeTab: "side-chat",
      sideChatSessionId: "secret",
      isOpen: true,
    },
  }),
);
assert.deepEqual(restored.solo, {
  openTabs: ["files", "review"],
  activeTab: "files",
  isOpen: true,
});
assert.deepEqual(restoreCompanionPanes("broken"), {});
const event = {
  id: "e1",
  sessionId: "s1",
  turnId: "t1",
  kind: "system-event",
  createdAt: "2026-09-24T09:00:00Z",
  message: "Applied",
  payload: {
    schema: "gyro.mutation.v1",
    status: "applied",
    proposalId: "p1",
    fileChanges: [{ path: "a.ts", patch: "@@ -1 +1 @@\n-old\n+new" }],
  },
};
assert.equal(turnReviewPatches([event, event], "a.ts").length, 1);
assert.deepEqual(
  turnReviewPatches(
    [{ ...event, payload: { ...event.payload, status: "pending" } }],
    "a.ts",
  ),
  [],
);
assert.deepEqual(
  turnReviewPatches(
    [{ ...event, payload: { ...event.payload, schema: "unrelated" } }],
    "a.ts",
  ),
  [],
);
assert.deepEqual(turnReviewPatches([event], "other.ts"), []);
const task = {
  id: "s1",
  sessionId: "s1",
  status: "todo",
  prompt: "Real instructions",
  title: "Task",
};
const session = {
  id: "s1",
  title: "Real chat",
  workspacePath: "/tmp/project",
  providerId: "codex",
};
assert.equal(chatTaskFromSession(task, session, [], false).status, "todo");
assert.equal(
  chatTaskFromSession(task, session, [], true).status,
  "in-progress",
);
const user = {
  ...event,
  id: "u",
  kind: "user-message",
  createdAt: "2026-09-24T09:01:00Z",
  payload: {},
};
assert.equal(
  chatTaskFromSession(task, session, [user], false).status,
  "in-review",
);
assert.equal(
  chatTaskFromSession(
    { ...task, status: "complete", completedAt: "2026-09-24T09:02:00Z" },
    session,
    [user],
    false,
  ).status,
  "complete",
);
assert.equal(
  chatTaskFromSession(
    { ...task, status: "complete", completedAt: "2026-09-24T09:00:00Z" },
    session,
    [user],
    false,
  ).status,
  "in-review",
);
const legacy = { id: "legacy", status: "todo", title: "Placeholder" };
assert.equal(chatTaskFromSession(legacy, undefined, [], false), legacy);
console.log(
  "Workflow upgrades: receipt attribution, dock restore, legacy tasks and explicit completion passed",
);
