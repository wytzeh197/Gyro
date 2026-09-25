import assert from "node:assert/strict";

import {
  normalizeProjectPath,
  visibleSessionsForProjects,
} from "../apps/desktop/src/session-listing.ts";

const chat = (id, workspacePath = "/Users/dev/Gyro", extra = {}) => ({
  id,
  title: `chat ${id}`,
  workspacePath,
  origin: "desktop",
  createdAt: "2026-09-24T09:00:00.000Z",
  updatedAt: "2026-09-24T09:00:00.000Z",
  eventsPath: `/tmp/${id}.jsonl`,
  ...extra,
});

const listed = (sessions, removedProjectPaths = []) =>
  visibleSessionsForProjects(sessions, removedProjectPaths).map(
    (session) => session.id,
  );

const sessions = [
  chat("mine"),
  chat("spawned", "/Users/dev/Gyro", { parentSessionId: "mine" }),
  chat("other-project", "/Users/dev/Other"),
  chat("removed-project", "/Users/dev/Gone"),
];

// A research sub-agent keeps its transcript in a session of its own, but that
// session belongs to the turn that started it: the chat list leaves it out and
// the call card is what opens it.
assert.deepEqual(
  listed(sessions),
  ["mine", "other-project", "removed-project"],
  "a session another chat's turn started must not list as a chat",
);

// A removed project drops its chats whatever the spelling of the path.
assert.deepEqual(
  listed(sessions, ["/Users/dev/Gone/"]),
  ["mine", "other-project"],
  "removed projects must not list any of their chats",
);
assert.equal(normalizeProjectPath("/Users/dev/Gyro///"), "/Users/dev/Gyro");
assert.deepEqual(
  listed([chat("draft", "/Users/dev/Gyro/")], ["/Users/dev/Gyro"]),
  [],
  "a trailing slash must not split one project into two",
);

// Nothing else about a session keeps it off the list.
assert.deepEqual(
  listed([
    chat("plain"),
    chat("worktree", "/Users/dev/Gyro", { workspaceMode: "worktree" }),
  ]),
  ["plain", "worktree"],
  "ordinary chats stay listed",
);

console.log("Session listing checks passed.");
