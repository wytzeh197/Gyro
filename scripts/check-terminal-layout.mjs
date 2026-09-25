import assert from "node:assert/strict";
import {
  listedTerminalPanes,
  placeTerminalTab,
} from "../packages/ui/src/terminal-layout.ts";
const empty = { ids: [], axis: "horizontal" };
assert.deepEqual(placeTerminalTab(empty, "a", "b", "right"), { ids: ["a", "b"], axis: "horizontal" });
assert.deepEqual(placeTerminalTab(empty, "a", "b", "top"), { ids: ["b", "a"], axis: "vertical" });
assert.deepEqual(placeTerminalTab(empty, "a", "a", "left").ids, ["a"]);
const split = { ids: ["a", "b", "c"], axis: "horizontal" };
assert.deepEqual(placeTerminalTab(split, "a", "b", "left").ids, ["b", "a", "c"]);
assert.deepEqual(placeTerminalTab(split, "a", "d", "bottom").ids, ["a", "b", "c", "d"]);
const full = { ids: ["a", "b", "c", "d"], axis: "horizontal" };
assert.deepEqual(placeTerminalTab(full, "a", "e", "right"), full);
assert.deepEqual(placeTerminalTab(split, "new", "a", "right").ids, ["new", "a"]);

// A chat's model-owned terminal is not one of the terminals the user manages.
// It may only be listed while it is the pane being shown on purpose.
const userShell = { id: "pane-1", owner: { kind: "user" } };
const taskPane = { id: "workspace-task-catalog%3Averify" };
const modelPane = {
  id: "model:session-a",
  owner: { kind: "model", sessionId: "session-a" },
};
const otherModelPane = {
  id: "model:session-b",
  owner: { kind: "model", sessionId: "session-b" },
};
const allPanes = [modelPane, userShell, otherModelPane, taskPane];
assert.deepEqual(
  listedTerminalPanes(allPanes, undefined).map((pane) => pane.id),
  ["pane-1", "workspace-task-catalog%3Averify"],
  "model-owned panes must not join a terminal list on their own",
);
assert.deepEqual(
  listedTerminalPanes(allPanes, "workspace-task-catalog%3Averify").map(
    (pane) => pane.id,
  ),
  ["pane-1", "workspace-task-catalog%3Averify"],
  "selecting a user pane must not surface any model pane",
);
assert.deepEqual(
  listedTerminalPanes(allPanes, "model:session-a").map((pane) => pane.id),
  ["model:session-a", "pane-1", "workspace-task-catalog%3Averify"],
  "an explicitly shown model pane must stay visible in its place",
);
assert.deepEqual(
  listedTerminalPanes(undefined, "model:session-a"),
  [],
  "an empty terminal list stays empty",
);
console.log("Terminal split placement checks passed");
