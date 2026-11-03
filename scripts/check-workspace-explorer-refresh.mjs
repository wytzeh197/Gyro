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
const same = (a, b) =>
  a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const hookFn = vm.runInNewContext(js, {
  mergeExplorerDirectories,
  sameListings,
  window: { setInterval: () => 1, clearInterval: () => {} },
  document: {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
  },
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
const render = (revision) => {
  slot = 0;
  const result = hookFn(files, load, (...args) => errors.push(args), revision);
  while (effects.length) effects.shift()();
  return result;
};
const flush = () => new Promise(setImmediate);
let result = render(0);
result.onExpandedDirectoriesChange([root.path]);
render(0);
await flush();
assert.equal(reads.length, 1);
render(1);
render(2);
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
result = render(2);
assert.ok(result.explorerFiles.some((file) => file.path === "/project/new.ts"));
assert.ok(
  !result.explorerFiles.some((file) => file.path === "/project/old.ts"),
);
render(3);
await flush();
assert.equal(
  reads.length,
  3,
  "A native change must refresh without a polling tick",
);
for (const entry of slots) entry?.cleanup?.();
reads[2].resolve([]);
await flush();
assert.deepEqual(errors, []);
console.log(
  "Explorer refresh checks passed: immediate invalidation, coalesced in-flight updates, latest listing and cleanup.",
);
