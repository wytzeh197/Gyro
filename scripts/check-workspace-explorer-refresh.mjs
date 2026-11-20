import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  mergeExplorerDirectories,
  sameListings,
} from "../apps/desktop/src/workspace-explorer.ts";

const source = readFileSync(
  new URL("../apps/desktop/src/workspace-explorer.ts", import.meta.url),
  "utf8",
);
const tree = ts.createSourceFile(
  "explorer.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const hook = tree.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "useWorkspaceExplorerFiles",
);
const js = ts.transpileModule(
  hook.getText(tree).replace(/^export\s+/, "") + "\nuseWorkspaceExplorerFiles;",
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText;
const slots = [],
  effects = [];
let slot = 0;
let timerId = 0;
const timers = new Map();
const listeners = new Map();
let focused = true;
const document = {
  visibilityState: "visible",
  hasFocus: () => focused,
  addEventListener: (name, fn) => listeners.set(name, fn),
  removeEventListener: (name) => listeners.delete(name),
};
const same = (a, b) =>
  a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const hookFn = vm.runInNewContext(js, {
  mergeExplorerDirectories,
  sameListings,
  window: {
    setInterval: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearInterval: id => timers.delete(id),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  },
  document,
  useCallback: (fn) => fn,
  useRef: (initial) => {
    const id = slot++;
    return (slots[id] ??= { current: initial });
  },
  useState: (initial) => {
    const id = slot++;
    slots[id] ??= { value: initial };
    return [
      slots[id].value,
      (update) => {
        slots[id].value =
          typeof update === "function" ? update(slots[id].value) : update;
      },
    ];
  },
  useMemo: (fn, deps) => {
    const id = slot++;
    if (!same(slots[id]?.deps, deps)) slots[id] = { value: fn(), deps };
    return slots[id].value;
  },
  useEffect: (fn, deps) => {
    const id = slot++;
    if (!same(slots[id]?.deps, deps)) {
      effects.push(() => {
        slots[id]?.cleanup?.();
        slots[id] = { deps, cleanup: fn() };
      });
    }
  },
});
const root = { path: "/project", kind: "directory", isWorkspaceRoot: true };
const files = [root];
const reads = [];
const errors = [];
const load = (path) => new Promise((resolve) => reads.push({ path, resolve }));
const render = () => {
  slot = 0;
  const result = hookFn(files, load, (...args) => errors.push(args), "event");
  while (effects.length) effects.shift()();
  return result;
};
const flush = () => new Promise(setImmediate);
let result = render();
assert.equal(timers.size, 0, "No expanded folders means no polling timer");
result.onExpandedDirectoriesChange([root.path]);
result = render();
assert.equal(timers.size, 1);
assert.equal(timers.values().next().value.delay, 15_000);
await flush();
assert.equal(reads.length, 1);
result.refreshChangedDirectories(root.path, ["/project/new.ts"]);
result.refreshChangedDirectories(root.path, ["/project/other.ts"]);
await flush();
assert.equal(
  reads.length,
  1,
  "Changes during a pending read must not launch concurrent reads",
);
reads[0].resolve([{ path: "/project/old.ts", kind: "file" }]);
await flush();
assert.equal(
  reads.length,
  2,
  "Changes during a pending read must queue a follow-up",
);
reads[1].resolve([{ path: "/project/new.ts", kind: "file" }]);
await flush();
result = render();
assert.ok(result.explorerFiles.some((file) => file.path === "/project/new.ts"));
assert.ok(
  !result.explorerFiles.some((file) => file.path === "/project/old.ts"),
);
result.refreshChangedDirectories(root.path, ["/project/nested/deeper/file.ts"]);
await flush();
assert.equal(reads.length, 2, "An unrelated child directory leaves the expanded root listing alone");
result.refreshChangedDirectories(root.path, ["/project/new.ts"]);
await flush();
assert.equal(
  reads.length,
  3,
  "A native change must refresh without a polling tick",
);
reads[2].resolve([]);
await flush();
focused = false;
result.refreshChangedDirectories(root.path, ["/project/new.ts"]);
for (const { fn } of timers.values()) fn();
await flush();
assert.equal(reads.length, 3, "An unfocused window skips even while it is visible");
focused = true;
listeners.get("focus")();
await flush();
assert.equal(reads.length, 4, "Focusing the window reconciles skipped changes");
reads[3].resolve([]);
await flush();
document.visibilityState = "hidden";
result.refreshChangedDirectories(root.path, ["/project/new.ts"]);
for (const { fn } of timers.values()) fn();
await flush();
assert.equal(reads.length, 4, "Native changes and timer ticks must not read hidden folders");
document.visibilityState = "visible";
listeners.get("visibilitychange")();
await flush();
assert.equal(reads.length, 5, "Returning to the window catches up without waiting for a tick");
result = render();
result.onExpandedDirectoriesChange([]);
render();
assert.equal(timers.size, 0, "Collapsing the last folder retires its polling timer");
assert.equal(listeners.size, 0);
for (const entry of slots) entry?.cleanup?.();
reads[4].resolve([]);
await flush();
assert.deepEqual(errors, []);
console.log(
  "Explorer refresh checks passed: immediate invalidation, coalesced in-flight updates, latest listing and cleanup.",
);
