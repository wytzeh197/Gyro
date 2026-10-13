import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createAppearanceSaveTracker } from "../apps/desktop/src/use-appearance-save-feedback.ts";
import { safeSetLocalStorage } from "../apps/desktop/src/ui-storage.ts";

const initial = {
  theme: "system",
  interfaceSize: "default",
  density: "comfortable",
  motionSpeed: "default",
  mainColor: "#0874df",
  secondaryColor: "#8b6fcb",
};
const tracker = createAppearanceSaveTracker(initial);
assert.equal(tracker.changed({ ...initial }), undefined);
assert.equal(
  tracker.persisted(initial, true),
  undefined,
  "Opening Settings does not announce a save",
);
const dark = { ...initial, theme: "dark" };
const larger = { ...dark, interfaceSize: "large" };
assert.equal(tracker.changed(dark), "saving");
assert.equal(tracker.changed(larger), "saving");
assert.equal(
  tracker.persisted(dark, true),
  undefined,
  "An older write cannot acknowledge a newer choice",
);
assert.equal(
  tracker.persisted(larger, false),
  "error",
  "A failed write never reports Saved",
);
assert.equal(
  tracker.persisted(larger, true),
  "saved",
  "A successful retry acknowledges the requested values",
);
assert.equal(
  tracker.persisted(larger, false),
  undefined,
  "Unrelated later writes do not change an acknowledged choice",
);
assert.equal(
  tracker.changed({ ...larger, secondaryColor: "#123456" }),
  "saving",
  "Both accents are included",
);

const writes = new Map();
globalThis.window = {
  localStorage: { setItem: (key, value) => writes.set(key, value) },
};
assert.equal(safeSetLocalStorage("appearance", JSON.stringify(larger)), true);
assert.deepEqual(
  JSON.parse(writes.get("appearance")),
  larger,
  "The stored choice survives reloading",
);
window.localStorage.setItem = () => {
  throw new Error("Quota exceeded");
};
assert.equal(safeSetLocalStorage("appearance", "next"), false);
assert.deepEqual(
  JSON.parse(writes.get("appearance")),
  larger,
  "A failed write preserves the last saved values",
);
// Exercise the real app's debounced flush, including the latest queued values.
const appSource = readFileSync(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "App.tsx",
  appSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const names = new Set([
  "flushPersistedWorkbenchState",
  "schedulePersistedWorkbenchStateFlush",
]);
const methods = ast.statements.filter(
  (node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text),
);
assert.equal(methods.length, names.size);
let idleCallback;
window.localStorage.setItem = (key, value) => writes.set(key, value);
window.requestIdleCallback = (callback) => {
  idleCallback = callback;
  return 1;
};
const context = {
  window,
  safeSetLocalStorage,
  WORKBENCH_STORAGE_KEY: "workbench",
  WORKBENCH_PERSIST_IDLE_TIMEOUT_MS: 100,
};
vm.runInNewContext(
  ts.transpileModule(methods.map((node) => node.getText(ast)).join("\n"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText,
  context,
);
const pending = { current: { preferences: dark } };
const idle = {};
const receipts = [];
const acknowledge = (preferences, saved) =>
  receipts.push({ preferences, saved });
context.schedulePersistedWorkbenchStateFlush(pending, idle, acknowledge);
pending.current = { preferences: larger };
idleCallback();
assert.equal(pending.current, undefined);
assert.equal(idle.current, undefined);
assert.deepEqual(receipts, [{ preferences: larger, saved: true }]);
assert.deepEqual(JSON.parse(writes.get("workbench")).preferences, larger);
window.localStorage.setItem = () => {
  throw new Error("Quota exceeded");
};
pending.current = { preferences: dark };
context.flushPersistedWorkbenchState(pending, acknowledge);
assert.deepEqual(receipts.at(-1), { preferences: dark, saved: false });
assert.deepEqual(JSON.parse(writes.get("workbench")).preferences, larger);
// WebKit can use the timer fallback when requestIdleCallback is unavailable.
window.localStorage.setItem = (key, value) => writes.set(key, value);
delete window.requestIdleCallback;
let fallbackCallback;
window.setTimeout = (callback) => {
  fallbackCallback = callback;
  return 2;
};
pending.current = { preferences: initial };
context.schedulePersistedWorkbenchStateFlush(pending, idle, acknowledge);
fallbackCallback();
assert.equal(idle.current, undefined);
assert.deepEqual(receipts.at(-1), { preferences: initial, saved: true });
assert.deepEqual(JSON.parse(writes.get("workbench")).preferences, initial);
delete globalThis.window;
console.log("Appearance persistence checks passed.");
