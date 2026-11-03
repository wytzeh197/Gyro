import assert from "node:assert/strict";
import { runWorkspaceSearchRoots } from "../apps/desktop/src/workspace-search-run.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const first = deferred();
const second = deferred();
const published = [];
const running = runWorkspaceSearchRoots(
  ["first", "second"],
  (root) => (root === "first" ? first.promise : second.promise),
  (results) => published.push(results),
  () => true,
  3,
);
second.resolve(["b", "c"]);
await new Promise(setImmediate);
assert.deepEqual(
  published,
  [["b", "c"]],
  "A fast root must publish before a slow root completes",
);
first.resolve(["a", "a2"]);
await running;
assert.deepEqual(
  published.at(-1),
  ["a", "a2", "b"],
  "Workspace order and global cap must hold",
);

const slow = deferred();
let current = true;
const stale = [];
const obsolete = runWorkspaceSearchRoots(
  ["root"],
  () => slow.promise,
  (results) => stale.push(results),
  () => current,
  10,
);
current = false;
slow.resolve(["obsolete"]);
await obsolete;
assert.deepEqual(stale, [], "Superseded queries must not publish");

const partial = [];
await assert.rejects(
  runWorkspaceSearchRoots(
    ["good", "bad"],
    async (root) => {
      if (root === "bad") throw new Error("permission denied");
      return ["kept"];
    },
    (results) => partial.push(results),
    () => true,
    10,
  ),
  /Search incomplete.*permission denied/,
);
assert.deepEqual(
  partial.at(-1),
  ["kept"],
  "A failed root must not erase successful roots",
);
console.log("Workspace search orchestration checks passed.");
