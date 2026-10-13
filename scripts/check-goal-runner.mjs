import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../apps/desktop/src/session-context-events.ts", import.meta.url),
  "utf8",
);
const module = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText,
  { exports: module.exports, module },
);
const derive = module.exports.deriveSessionGoal;
let sequence = 0;
const event = (kind, payload) => ({
  id: String(++sequence),
  sessionId: "chat",
  kind,
  message: "",
  createdAt: new Date(1760000000000 + sequence * 1000).toISOString(),
  payload,
});
const start = event("goal-updated", {
  action: "set",
  text: "Finish verification",
  status: "active",
  run: {
    id: "run",
    status: "running",
    checkpoint: "Code ready",
    nextAction: "Run checks",
  },
});
const waiting = event("approval-requested", {
  kind: "capability-approval",
  approvalId: "approval",
  status: "waiting",
});
const resolved = event("system-event", {
  kind: "capability-approval",
  approvalId: "approval",
  status: "approved",
});
assert.equal(derive([start], "chat").run.status, "running");
assert.equal(derive([start, waiting], "chat").run.status, "waiting-approval");
assert.equal(derive([start, waiting, resolved], "chat").run.status, "running");
const blocked = event("goal-updated", {
  text: "Finish verification",
  status: "active",
  run: {
    id: "run",
    status: "blocked",
    reason: "Live validation is prohibited",
  },
});
assert.equal(derive([start, waiting, blocked], "chat").run.status, "blocked");
assert.equal(
  derive([start, blocked], "chat").run.reason,
  "Live validation is prohibited",
);
const edited = event("goal-updated", {
  text: "Different outcome",
  status: "active",
});
assert.equal(derive([start, blocked, edited], "chat").run, undefined);
assert.equal(
  derive([start, event("goal-updated", { action: "clear" })], "chat"),
  undefined,
);

const initialGoal = event("goal-updated", {
  text: "Original",
  status: "active",
});
const lateRun = event("goal-updated", {
  text: "Original",
  status: "active",
  source: "goal-runner",
  goalVersion: initialGoal.id,
  run: { id: "stale", status: "queued" },
});
const clearedGoal = event("goal-updated", { action: "clear" });
assert.equal(
  derive([initialGoal, clearedGoal, lateRun], "chat"),
  undefined,
  "a late checkpoint cannot revive a cleared goal",
);
const reopenedGoal = event("goal-updated", {
  text: "Original",
  status: "active",
});
const lateCompletion = event("goal-updated", {
  text: "Original",
  status: "complete",
  source: "model",
  goalVersion: initialGoal.id,
});
assert.equal(
  derive([initialGoal, reopenedGoal, lateCompletion], "chat").status,
  "active",
  "an old completion cannot finish a reopened goal",
);

const app = readFileSync(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "App.tsx",
  app,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let effect;
let changeGoal;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "changeGoal")
    changeGoal = node.initializer.arguments[0].getText(ast);
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === "useEffect" &&
    node.arguments[0]?.getText(ast).includes('"gyro://goal-run-event"')
  )
    effect = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(effect);
assert.ok(changeGoal);
const stopped = new Set();
const busy = new Set(["chat"]);
const pauses = [];
const resumes = [];
let stops = 0;
const goalContext = {
  activeSessionGoal: { text: "Finish verification", status: "active" },
  activeSessionId: "chat",
  isTauriRuntime: () => true,
  stoppedChatSessionsRef: { current: stopped },
  sendingSessionIdsRef: { current: busy },
  stopChatSession: () => {
    stops++;
  },
  appendGoalEvent: (payload) => {
    pauses.push(payload);
    return true;
  },
  sendDraftRef: {
    current: (message) => {
      resumes.push(message);
      return true;
    },
  },
};
vm.runInNewContext(
  ts.transpileModule("globalThis.change = " + changeGoal, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText,
  goalContext,
);
await goalContext.change("pause");
assert.ok(
  stopped.has("chat"),
  "Pause must hold the queued messages before cancellation",
);
assert.equal(
  stops,
  1,
  "Pause must reuse the existing cancellation and retry controls",
);
busy.clear();
await goalContext.change("pause");
assert.equal(
  pauses.at(-1).action,
  "pause",
  "an idle goal still persists its paused state",
);
await goalContext.change("resume");
assert.ok(resumes.at(-1).includes("saved checkpoint"));

let listener;
const sending = [];
const sendingIds = new Set();
const delivered = [];
const histories = new Map();
const context = {
  isTauriRuntime: () => true,
  listen: (_name, callback) => {
    listener = callback;
    return Promise.resolve(() => {});
  },
  sendingSessionIdsRef: { current: sendingIds },
  setSessionSending: (id, busy) => {
    if (busy) sendingIds.add(id);
    else sendingIds.delete(id);
    sending.push([id, busy]);
  },
  recordFromUnknown: (value) =>
    value && typeof value === "object" ? value : undefined,
  flushProviderStreamBatches: () => {},
  applyProviderChatResponse: (id, response) => delivered.push([id, response]),
  limitSessionEventsForUi: (events) => events,
  limitOptimisticSessionEvents: (events) => events,
  mergePersistedAndOptimisticEvents: (current, additions) => {
    const merged = new Map(current.map((item) => [item.id, item]));
    for (const item of additions) merged.set(item.id, item);
    return [...merged.values()];
  },
  optimisticEventsRef: { current: new Map() },
  setEventsForSession: (id, update) =>
    histories.set(id, update(histories.get(id) ?? [])),
};
const js = ts.transpileModule("globalThis.install = " + effect, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  },
}).outputText;
vm.runInNewContext(js, context);
const cleanup = context.install();
listener({ payload: { sessionId: "chat", owner: "a", event: start } });
listener({
  payload: {
    sessionId: "chat",
    owner: "a",
    response: { assistantEvent: { id: "answer-a" } },
  },
});
assert.equal(
  sending.filter(([, busy]) => !busy).length,
  0,
  "an intermediate answer must not release the goal's queue",
);
assert.equal(delivered.length, 1);
listener({
  payload: {
    sessionId: "chat",
    owner: "b",
    event: { ...start, id: "new-owner" },
  },
});
listener({ payload: { sessionId: "chat", owner: "a", finished: true } });
assert.equal(
  sending.filter(([, busy]) => !busy).length,
  0,
  "an old completion must not release a newer owner",
);
listener({
  payload: {
    sessionId: "chat",
    owner: "a",
    response: { assistantEvent: { id: "stale-answer" } },
  },
});
assert.equal(
  delivered.length,
  1,
  "a stale response must not overwrite a newer goal",
);
listener({ payload: { sessionId: "chat", owner: "b", finished: true } });
assert.equal(
  sending.at(-1)[1],
  true,
  "composer-owned invokes clear their own flag after applying the answer",
);
context.setSessionSending("chat", false);
listener({
  payload: {
    sessionId: "chat",
    owner: "recovered",
    event: { ...start, id: "recovered" },
  },
});
listener({
  payload: { sessionId: "chat", owner: "recovered", finished: true },
});
assert.equal(
  sending.at(-1)[1],
  false,
  "a recovered background goal releases its own flag",
);
cleanup();
listener({ payload: { sessionId: "chat", owner: "c", event: start } });
assert.equal(
  sending.at(-1)[1],
  false,
  "unmounted listeners must not change state",
);
console.log(
  "Goal runner UI checks passed: approvals, blockers, edited goals, checkpoint delivery, queue ownership, and stale events.",
);
