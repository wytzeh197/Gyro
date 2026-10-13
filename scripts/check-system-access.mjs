import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  parseSystemAccessSnapshot,
  SYSTEM_ACCESS_STATUS_STORAGE_KEY,
} from "../apps/desktop/src/system-access-state.ts";
import {
  readBoundedLocalStorage,
  safeSetLocalStorage,
} from "../apps/desktop/src/ui-storage.ts";

const source = readFileSync(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "App.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let probe;
let boot;
const automaticChecks = [];
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(ast) === "checkSystemAccess"
  ) {
    probe = node.initializer.arguments[0].getText(ast);
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === "useEffect"
  ) {
    const callback = node.arguments[0]?.getText(ast) ?? "";
    if (callback.includes("systemAccessBootstrapRef.current")) boot = callback;
    if (callback.includes("checkSystemAccess()"))
      automaticChecks.push(callback);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(probe && boot, "Exercise the real app callbacks");
assert.equal(
  automaticChecks.length,
  1,
  "Only the first-launch effect may probe automatically",
);
assert.ok(
  !automaticChecks[0].includes("lastSettingsSection"),
  "Opening Permissions never probes folders",
);

const promptedKey = "gyro.system-access-prompted-v1";
let storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  },
};
function launch(native = true) {
  const requests = [];
  const notices = [];
  const busy = [];
  const context = vm.createContext({
    isTauriRuntime: () => native,
    systemAccessCheckRef: { current: null },
    systemAccessBootstrapRef: { current: false },
    SYSTEM_ACCESS_PROMPTED_STORAGE_KEY: promptedKey,
    SYSTEM_ACCESS_STATUS_STORAGE_KEY,
    readBoundedLocalStorage,
    safeSetLocalStorage,
    setSystemAccess: () => {},
    setIsCheckingSystemAccess: (value) => busy.push(value),
    notify: (...args) => notices.push(args),
    dispatchWorkbench: () => {},
    invoke: (command) => {
      assert.equal(command, "check_system_access");
      return new Promise((resolve, reject) =>
        requests.push({ resolve, reject }),
      );
    },
  });
  vm.runInContext(
    ts.transpileModule(
      `globalThis.checkSystemAccess = ${probe}; globalThis.boot = ${boot};`,
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.None,
        },
      },
    ).outputText,
    context,
  );
  return { context, requests, notices, busy };
}
const denied = [
  {
    id: "downloads",
    label: "Downloads folder",
    reason: "Open downloaded projects.",
    status: "denied",
    canPrompt: true,
    settingsUrl: "x-apple.systempreferences:privacy",
  },
];
const first = launch();
first.context.boot();
assert.equal(
  storage.get(promptedKey),
  "true",
  "Remember the attempt before the native sheet resolves",
);
assert.equal(first.requests.length, 1);
const pending = first.context.systemAccessCheckRef.current;
assert.equal(
  first.context.checkSystemAccess(),
  pending,
  "Concurrent checks share the pending request",
);
assert.equal(first.context.checkSystemAccess(), pending);
assert.equal(first.requests.length, 1);
const duringPrompt = launch();
duringPrompt.context.boot();
assert.equal(
  duringPrompt.requests.length,
  0,
  "A reload during the sheet does not request again",
);
first.requests[0].resolve(denied);
await pending;
assert.deepEqual(
  parseSystemAccessSnapshot(storage.get(SYSTEM_ACCESS_STATUS_STORAGE_KEY)),
  denied,
);
assert.equal(first.context.systemAccessCheckRef.current, null);
assert.equal(first.busy.at(-1), false);

const restarted = launch();
restarted.context.boot();
assert.equal(
  restarted.requests.length,
  0,
  "A previous denial is not automatically requested again",
);
const manual = restarted.context.checkSystemAccess();
assert.equal(
  restarted.requests.length,
  1,
  "An explicit recheck remains available",
);
const granted = denied.map((scope) => ({ ...scope, status: "granted" }));
restarted.requests[0].resolve(granted);
await manual;
assert.deepEqual(
  parseSystemAccessSnapshot(storage.get(SYSTEM_ACCESS_STATUS_STORAGE_KEY)),
  granted,
);

storage = new Map();
const failure = launch();
failure.context.boot();
const failedCheck = failure.context.systemAccessCheckRef.current;
failure.requests[0].reject(new Error("Native request interrupted"));
await failedCheck;
assert.equal(failure.notices.length, 1);
assert.equal(failure.busy.at(-1), false);
const afterFailure = launch();
afterFailure.context.boot();
assert.equal(
  afterFailure.requests.length,
  0,
  "An interrupted request does not become a startup loop",
);
const explicitRetry = afterFailure.context.checkSystemAccess();
afterFailure.requests[0].resolve(granted);
await explicitRetry;

storage = new Map();
const browser = launch(false);
browser.context.boot();
assert.equal(browser.requests.length, 0);
assert.equal(
  storage.size,
  0,
  "A browser preview never records a native permission attempt",
);
for (const invalid of [
  undefined,
  "{",
  "null",
  "{}",
  "[null]",
  JSON.stringify([...denied, ...denied]),
  JSON.stringify([{ ...denied[0], status: "unknown" }]),
]) {
  assert.deepEqual(
    parseSystemAccessSnapshot(invalid),
    [],
    "Malformed snapshots never invent grants",
  );
}
console.log(
  "check-system-access: restart, denial, interruption, explicit retry, and concurrent request checks passed",
);
