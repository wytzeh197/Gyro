import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../packages/ui/src/surfaces.tsx", import.meta.url),
  "utf8",
);
const tree = ts.createSourceFile(
  "surfaces.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const functions = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name)
    functions.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(tree);
const hookSource = readFileSync(
  new URL("../packages/ui/src/use-network-online.ts", import.meta.url),
  "utf8",
);
const hookTree = ts.createSourceFile(
  "network.ts",
  hookSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const hook = hookTree.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "useNetworkOnline",
);
assert.ok(hook);
const js = ts.transpileModule(
  hook.getText(hookTree).replace(/^export\s+/, "") + "\nuseNetworkOnline;",
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText;

function mountSubscribers(count, changeDuringSubscribe = false) {
  const listeners = { online: new Set(), offline: new Set() },
    states = [],
    cleanups = [];
  let slot = 0,
    online = true;
  const navigator = {
    get onLine() {
      return online;
    },
  };
  const context = {
    navigator,
    useState: (initialize) => {
      const id = slot++;
      states[id] = initialize();
      return [
        states[id],
        (value) => {
          states[id] = value;
        },
      ];
    },
    useEffect: (callback) => cleanups.push(callback()),
    window: {
      addEventListener: (kind, callback) => {
        listeners[kind].add(callback);
        if (changeDuringSubscribe) online = false;
      },
      removeEventListener: (kind, callback) => listeners[kind].delete(callback),
    },
  };
  const useNetworkOnline = vm.runInNewContext(js, context);
  for (let i = 0; i < count; i++) useNetworkOnline();
  return {
    states,
    listenerCount: () => listeners.online.size + listeners.offline.size,
    change: (value) => {
      online = value;
      [...listeners[value ? "online" : "offline"]].forEach((callback) =>
        callback(),
      );
    },
    cleanup: () => cleanups.forEach((callback) => callback()),
  };
}
const previous = mountSubscribers(400),
  current = mountSubscribers(1);
assert.equal(previous.listenerCount(), 800);
assert.equal(current.listenerCount(), 2);
previous.change(false);
current.change(false);
assert.ok(previous.states.every((value) => value === false));
assert.deepEqual(current.states, [false]);
previous.change(true);
current.change(true);
assert.ok(previous.states.every((value) => value === true));
assert.deepEqual(current.states, [true]);
previous.cleanup();
current.cleanup();
assert.equal(previous.listenerCount(), 0);
assert.equal(current.listenerCount(), 0);
const missed = mountSubscribers(1, true);
assert.deepEqual(
  missed.states,
  [false],
  "subscription catches a change between initial read and listener installation",
);
missed.cleanup();

const parent = functions.get("ChatSurface").getText(tree),
  turn = functions.get("ChatTurn").getText(tree);
assert.equal((parent.match(/useNetworkOnline\(\)/g) ?? []).length, 1);
assert.ok(
  !turn.includes("useNetworkOnline("),
  "turns must not install their own listeners",
);
assert.match(parent, /<ChatTurn\s+isOnline=\{isOnline\}/);
assert.match(parent, /\[\s*subagents,\s*isOnline,/);
assert.match(turn, /isOnline: boolean/);
assert.match(turn, /retry: !isOnline/);
console.log(
  "Chat network: actual hook drops 400-turn DOM listeners 800 → 2; online/offline, mount race and cleanup preserved.",
);
