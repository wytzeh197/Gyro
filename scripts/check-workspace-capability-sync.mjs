import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the production hooks without a Tauri window. Re-rendering with new
// sessions must keep both capability subscriptions alive, and changing the
// workspace root must send a snapshot belonging to that exact root.
const source = readFileSync(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
const tree = ts.createSourceFile(
  "App.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const effects = [];
function visit(node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(tree) === "useEffect"
  ) {
    effects.push(node);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
const capabilityEffect = effects.find((node) =>
  node.arguments[0]
    .getText(tree)
    .includes('"gyro://provider-capability-resource"'),
);
assert.ok(capabilityEffect);
const contextStart = source.indexOf(
  "  const workspaceContextSnapshot = useMemo<",
);
const contextEnd = source.indexOf(
  "  const refreshTerminalSourceControl = useCallback(",
  contextStart,
);
assert.ok(contextStart >= 0 && contextEnd > contextStart);

function hooks() {
  let cursor = 0;
  const values = [];
  const changed = (previous, next) =>
    !previous ||
    next.some((value, index) => !Object.is(value, previous[index]));
  return {
    render() {
      cursor = 0;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      if (!changed(values[index]?.dependencies, dependencies)) return;
      values[index]?.cleanup?.();
      values[index] = { dependencies, cleanup: effect() };
    },
    useMemo(create, dependencies) {
      const index = cursor++;
      if (changed(values[index]?.dependencies, dependencies)) {
        values[index] = { dependencies, value: create() };
      }
      return values[index].value;
    },
  };
}
function compile(code, dependencies) {
  const js = ts.transpile(code, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(dependencies), js);
}

const listenerHooks = hooks();
const registrations = [];
let unsubscriptions = 0;
let browserResources = {};
const sessionsRef = {
  current: [{ id: "chat", workspacePath: "/project/original" }],
};
const listeners = {
  useEffect: listenerHooks.useEffect,
  isTauriRuntime: () => true,
  listen: async (name, callback) => {
    registrations.push({ name, callback });
    return () => {
      unsubscriptions++;
    };
  },
  flushProviderStreamBatches: () => {},
  setEventsForSession: () => {},
  sessions: sessionsRef.current,
  sessionsRef,
  liveCapabilityResourceIdsRef: { current: new Set() },
  setCapabilityResourceDataByCallId: () => {},
  activeSessionIdRef: { current: "chat" },
  modelFollowRef: { current: "peek" },
  dispatchWorkbench: () => {},
  recordFromUnknown: (value) => value,
  stringFromRecord: (record, key) =>
    typeof record?.[key] === "string" ? record[key] : undefined,
  setBrowserResourcesBySessionId: (update) => {
    browserResources = update(browserResources);
  },
};
const renderListeners = compile(capabilityEffect.getText(tree), listeners);
listenerHooks.render();
renderListeners(...Object.values(listeners));
await Promise.resolve();
assert.equal(registrations.length, 2);
sessionsRef.current = [{ id: "chat", workspacePath: "/project/current" }];
listeners.sessions = sessionsRef.current;
listenerHooks.render();
renderListeners(...Object.values(listeners));
await Promise.resolve();
assert.equal(
  registrations.length,
  2,
  "session updates must not tear down capability listeners and lose events",
);
assert.equal(unsubscriptions, 0);
registrations
  .find((item) => item.name === "gyro://provider-capability-resource")
  .callback({
    payload: {
      sessionId: "chat",
      callId: "browse",
      resource: { kind: "browser", id: "browser", label: "Preview" },
      data: { url: "http://localhost:3000" },
    },
  });
assert.equal(
  browserResources.chat.projectPath,
  "/project/current",
  "a stable listener must use current session workspace data",
);

const contextHooks = hooks();
const requests = [];
const contextDependencies = {
  useEffect: contextHooks.useEffect,
  useMemo: contextHooks.useMemo,
  selectedFile: undefined,
  workspaceRoots: ["/project/a", "/project/b"],
  workspaceActionRoot: "/project/a",
  activeWorkspaceRoot: "/project/a",
  workspaceRootForPath: (roots, path) =>
    path && roots.find((root) => path === root || path.startsWith(`${root}/`)),
  workspaceContextRelativePath: (path, root) => path.replace(`${root}/`, ""),
  workspaceFailedTests: () => [],
  workbench: {
    ide: {
      activeOutputChannelId: undefined,
      outputChannels: [],
      diagnostics: [
        { path: "/project/a/main.ts", message: "Project A" },
        { path: "/project/b/main.ts", message: "Project B" },
      ],
      testTree: [],
    },
  },
  isTauriRuntime: () => true,
  invoke: async (command, payload) => {
    requests.push({ command, ...payload });
  },
};
const renderContext = compile(
  source.slice(contextStart, contextEnd),
  contextDependencies,
);
contextHooks.render();
renderContext(...Object.values(contextDependencies));
assert.equal(requests.at(-1).request.workspacePath, "/project/a");
contextDependencies.workspaceActionRoot = "/project/b";
contextHooks.render();
renderContext(...Object.values(contextDependencies));
assert.equal(requests.at(-1).request.workspacePath, "/project/b");
assert.equal(requests.at(-1).request.context.workspaceKey, "/project/b");
assert.deepEqual(
  requests.at(-1).request.diagnostics.map((item) => item.message),
  ["Project B"],
);
assert.deepEqual(
  requests.at(-1).request.context.buffers,
  [],
  "background signal sync must not attach editor buffers implicitly",
);
contextHooks.render();
renderContext(...Object.values(contextDependencies));
assert.equal(
  requests.length,
  2,
  "unchanged workspace evidence should not issue another IPC update",
);
// A disconnected bridge may reject a background refresh. It must stay handled
// until an explicit send can retry and surface a persistent failure.
contextDependencies.workspaceActionRoot = undefined;
contextDependencies.activeWorkspaceRoot = "/project/fallback";
contextDependencies.invoke = async () => {
  throw new Error("bridge disconnected");
};
contextHooks.render();
renderContext(...Object.values(contextDependencies));
await new Promise(resolve => setImmediate(resolve));
console.log("workspace capability sync checks passed");
