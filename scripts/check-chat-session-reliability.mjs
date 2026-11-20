import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  createChatSendLifecycle,
  waitForChatConfigSave,
} from "../apps/desktop/src/chat-send-lifecycle.ts";
import {
  mergeCompletedChatSession,
  retainChatResourcePayload,
  forgetChatResourcePayloads,
  forgetChatSessionResources,
  readChatSessionList,
} from "../apps/desktop/src/chat-session-updates.ts";
import {
  buildRunModel,
  runRowText,
  runCallText,
} from "../packages/ui/src/chat-run.ts";
const source = fs.readFileSync(
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
function declaration(name) {
  let found;
  function visit(n) {
    if (ts.isVariableDeclaration(n) && n.name.getText(tree) === name) found = n;
    ts.forEachChild(n, visit);
  }
  visit(tree);
  assert.ok(found, name);
  return found.initializer.arguments[0];
}
function callbackJs(name) {
  return ts.transpileModule(`(${declaration(name).getText(tree)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
let sequence = 0;
const noop = () => {};
function harness() {
  const modelSave = deferred(),
    paint = deferred(),
    backend = deferred();
  let backendActive = false;
  const appended = [],
    calls = [],
    notices = [],
    sending = new Set();
  const context = {
    targetSessionId: "chat",
    overrideContext: undefined,
    isRetry: false,
    message: "Run the tests",
    selectedProvider: { id: "openai" },
    turnAttachments: [],
    sessionModel: { providerId: "openai" },
    sessionsRef: { current: [{ id: "chat", providerId: "openai" }] },
    saveSessionModel: () => modelSave.promise,
    pendingModelSave: () => modelSave.promise,
    configSaveQueueRef: { current: Promise.resolve() },
    sendingSessionIdsRef: { current: sending },
    optimisticEventsRef: { current: new Map() },
    stoppedChatSessionsRef: { current: new Set() },
    steeringChatSessionsRef: { current: new Set() },
    persistedChatTurnIdsRef: { current: new Set() },
    visibleChatSessionIdsRef: { current: new Set(["chat"]) },
    setSessionSending: (id, on) => {
      on ? sending.add(id) : sending.delete(id);
    },
    createOptimisticTurnEvents: () => [],
    limitOptimisticSessionEvents: (x) => x,
    limitSessionEventsForUi: (x) => x,
    mergePersistedAndOptimisticEvents: (a, b) => [...a, ...(b ?? [])],
    setEventsForSession: noop,
    consumeSelectedMode: false,
    isBackgroundSend: false,
    dispatchWorkbench: noop,
    resetChatDraft: noop,
    isTauriRuntime: () => true,
    waitForNextPaint: () => paint.promise,
    chatModeEventMessage: () => "",
    turnMode: "normal",
    invoke: async (command, args) => {
      calls.push(command);
      if (command === "append_user_message") appended.push(args.turnId);
      return {};
    },
    liveEditorEvidence: undefined,
    liveEditorEvidenceRef: { current: undefined },
    chatWorkspacePath: "/tmp/fixture",
    turnWorkspaceContext: undefined,
    isCouncilTurn: false,
    councilResolution: null,
    config: { selectedProviderId: "openai" },
    requireCommandApproval: true,
    requireFileEditApproval: true,
    fullAccess: false,
    turnGoal: undefined,
    turnPlan: { items: [] },
    shouldSuggestTitle: false,
    turnTiming: {
      invokeTimedProviderChat: async () => {
        calls.push("run_provider_chat");
        if (backendActive)
          throw new Error("A provider turn is already running");
        backendActive = true;
        return backend.promise;
      },
    },
    applyProviderChatResponse: noop,
    recordCompletedModelChoice: noop,
    providerSupportsUsage: () => false,
    refreshProviderLedger: noop,
    restoreUnsentMode: noop,
    isProviderStop: (message) => message.includes("chat cancelled by"),
    shouldPauseQueueAfterSendError: () => true,
    providerFailureBlocksReadiness: () => false,
    updateOptimisticProviderStatus: noop,
    refreshEvents: async () => {},
    providerFailureNotice: () => ({ title: "failed", detail: "" }),
    isPreviewSessionId: () => false,
    hasChatFullAccess: () => false,
    setStoppingSessionIds: noop,
    notify: (...x) => notices.push(x),
  };
  Object.assign(context, {
    chatSendLifecycleRef: { current: createChatSendLifecycle() },
    waitForChatConfigSave,
    persistConfig: async () => true,
    configRef: { current: {} },
    isShellOptimizing: false,
    activeDraftKey: "chat",
    activeSessionId: "chat",
    activeChatDraft: "Run the tests",
    activeChatAttachments: [],
    chatDraftModeRevisionsRef: { current: {} },
    chatDraftModesRef: { current: {} },
    normalizeChatMessage: (x) => x?.trim() ?? "",
    MAX_CHAT_MESSAGE_CHARS: 24000,
    chatAutoRetry: { cancelSession: noop },
    retryDispatchRef: { current: { cancelSession: noop } },
    activeSessionGoal: undefined,
    activeSessionPlan: { items: [] },
    sessions: context.sessionsRef.current,
    sessionEventsById: { chat: [{ kind: "user-message" }] },
    activeSessionHasTranscriptEvents: true,
    chatDraftModels: {},
    selectedSessionModelFromConfig: () => context.sessionModel,
    sessionModelSelectionFromSession: () => context.sessionModel,
    providersForConfig: () => [context.selectedProvider],
    workspacePath: "/tmp/fixture",
    workspaceContextSnapshot: undefined,
    activeChatPane: undefined,
    isBranchLoading: false,
    chatMessageLength: (x) => x.length,
    isStartingFirstTurn: false,
    checkProviderReadiness: () => true,
    createTurnId: () => `turn-${++sequence}`,
    shouldSuggestSessionTitle: () => false,
    setTurnSourceControlBaselines: noop,
    scopedIde: { sourceControl: { detailsLoaded: false } },
    chatMessageQueues: {},
    consumeDraftMode: noop,
    pendingSteerStopsRef: { current: new Set() },
    setQueueRetryTick: noop,
    MAX_QUEUED_CHAT_MESSAGES_PER_SESSION: 8,
    MAX_QUEUED_CHAT_MESSAGES_TOTAL: 40,
    setChatMessageQueues: (update) =>
      (context.chatMessageQueues = update(context.chatMessageQueues)),
    mergeCompletedChatSession,
  });
  context.turnTiming.beginTurnTiming = noop;
  return {
    context,
    send: vm.runInNewContext(callbackJs("sendDraft"), context),
    modelSave,
    paint,
    backend,
    appended,
    calls,
    notices,
    sending,
    get backendActive() {
      return backendActive;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const duplicate = harness();
const first = duplicate.send("Run the tests");
assert.equal((await duplicate.send("Run the tests")).reason, "busy");
duplicate.modelSave.resolve();
duplicate.paint.resolve();
await tick();
assert.equal(duplicate.appended.length, 1, JSON.stringify(duplicate.notices));
assert.equal(duplicate.sending.has("chat"), true);
assert.equal((await duplicate.send("Next instruction")).kind, "queued");
assert.equal(duplicate.context.chatMessageQueues.chat.length, 1);
duplicate.backend.resolve({});
assert.equal((await first).kind, "completed");
assert.equal(duplicate.sending.has("chat"), false);

const stopping = harness();
const pending = stopping.send("Run the tests");
stopping.modelSave.resolve();
await tick();
vm.runInNewContext(callbackJs("stopChatSession"), stopping.context)("chat");
stopping.paint.resolve();
const stopped = await pending;
assert.equal(stopped.kind, "cancelled", JSON.stringify(stopping.notices));
assert.equal(
  stopping.backendActive,
  false,
  "Stop before backend admission cannot launch work",
);
assert.equal(stopping.appended.length, 0);
assert.equal(stopping.sending.has("chat"), false);

// Stop while append is in flight must prevent the subsequent provider invocation.
const writing = harness();
const writeGate = deferred();
const invokeBeforeWrite = writing.context.invoke;
writing.context.invoke = async (command, args) => {
  const result = await invokeBeforeWrite(command, args);
  if (command === "append_user_message") await writeGate.promise;
  return result;
};
writing.modelSave.resolve();
writing.paint.resolve();
const writingSend = writing.send("Run the tests");
await tick();
assert.equal(writing.appended.length, 1);
vm.runInNewContext(callbackJs("stopChatSession"), writing.context)("chat");
writeGate.resolve();
assert.equal((await writingSend).kind, "cancelled");
assert.equal(writing.backendActive, false);
assert.equal(writing.sending.size, 0);

// Exercise the real first-send branch while native session creation is pending.
const fresh = harness();
const creation = deferred();
let creationStarted = false;
Object.assign(fresh.context, {
  activeSessionId: undefined,
  activeDraftKey: "new-draft",
  activeSessionHasTranscriptEvents: false,
  activeWorkspaceLayoutRef: { current: "thread" },
  workbench: { workspaceMode: "local", providerStatuses: [] },
  isProviderRuntimeUsable: () => true,
  getProviderModel: () => ({ id: "model" }),
  setIsStartingFirstTurn: noop,
  createPreviewSession: () => ({
    id: "preview",
    workspacePath: "/tmp/fixture",
  }),
  suppressSessionAutoSelectRef: { current: false },
  setWorkspacePath: noop,
  setFiles: noop,
  workspaceFilesForRoot: () => [],
  previewFiles: [],
  setSessions: noop,
  dispatchChatGrid: noop,
  draftWorkspaceModes: { current: {} },
  setChatDraftModels: noop,
  activeSessionIdRef: { current: undefined },
  setActiveSessionId: noop,
  createTauriThreadSession: () => {
    creationStarted = true;
    return creation.promise;
  },
  rekeySessionEvents: (events) => events,
  setSessionEventsById: noop,
  replaceSendingSessionId: (from, to) => {
    fresh.sending.delete(from);
    fresh.sending.add(to);
  },
});
fresh.context.selectedProvider.enabled = true;
fresh.paint.resolve();
const firstMessage = fresh.send("Start a chat");
await tick();
assert.equal(creationStarted, true, JSON.stringify(fresh.notices));
assert.equal((await fresh.send("Start a chat")).reason, "busy");
vm.runInNewContext(callbackJs("stopChatSession"), fresh.context)("preview");
creation.resolve({ id: "persisted", workspacePath: "/tmp/fixture" });
assert.equal(
  (await firstMessage).kind,
  "cancelled",
  JSON.stringify(fresh.notices),
);
assert.equal(fresh.appended.length, 0);
assert.equal(fresh.backendActive, false);
assert.equal(fresh.sending.size, 0);

// New chats change identity during persistence; Stop must follow all aliases.
const lifecycle = createChatSendLifecycle();
const draftAttempt = lifecycle.reserve("draft:new");
draftAttempt.bind("preview");
assert.equal(lifecycle.reserve("preview"), undefined);
assert.equal(lifecycle.cancel("preview"), true);
draftAttempt.bind("persisted");
assert.throws(() => draftAttempt.start(), /chat cancelled by/);
draftAttempt.release();
const activeAttempt = lifecycle.reserve("persisted");
activeAttempt.start();
const queuedAttempt = lifecycle.reserve("persisted");
activeAttempt.release();
assert.equal(
  lifecycle.reserve("persisted"),
  undefined,
  "old cleanup cannot release a newer preparation",
);
queuedAttempt.start();
assert.equal(
  lifecycle.cancel("persisted"),
  false,
  "native runs still require native cancellation",
);
queuedAttempt.release();
assert.ok(lifecycle.reserve("another-chat"));

const poisoned = harness();
const failed = Promise.reject(new Error("disk full"));
failed.catch(() => {});
poisoned.context.configSaveQueueRef.current = failed;
let retries = 0;
poisoned.context.persistConfig = async () => {
  retries++;
  return false;
};
poisoned.modelSave.resolve();
poisoned.paint.resolve();
for (let i = 0; i < 2; i++)
  assert.equal((await poisoned.send("retry")).kind, "not-started");
assert.equal(retries, 2);
assert.equal(poisoned.appended.length, 0);
assert.equal(
  poisoned.notices.filter((x) => x[1] === "Message not sent").length,
  2,
);
poisoned.context.persistConfig = async () => true;
const recovered = poisoned.send("retry");
await tick();
assert.equal(poisoned.appended.length, 1);
poisoned.backend.resolve({});
assert.equal((await recovered).kind, "completed");

let sessions = [{ id: "chat", providerId: "anthropic", modelId: "new" }];
vm.runInNewContext(callbackJs("applyProviderChatResponse"), {
  mergeCompletedChatSession,
  setSessions: (update) => (sessions = update(sessions)),
})("chat", { session: { id: "chat", providerId: "openai", modelId: "old" } });
assert.equal(sessions[0].modelId, "new");
assert.equal(sessions[0].providerId, "anthropic");

const planSave = deferred();
let active = "B";
const events = { A: [], B: [] };
const plan = vm.runInNewContext(callbackJs("appendPlanEvent"), {
  activeSessionId: "A",
  isTauriRuntime: () => true,
  createPlanSessionEvent: (sessionId, message, payload) => ({
    sessionId,
    message,
    payload,
  }),
  invoke: async () => {
    await planSave.promise;
    throw new Error("disk full");
  },
  setEventsForSession: (id, update) => (events[id] = update(events[id])),
  setEvents: () => assert.fail("unscoped event update"),
  refreshEvents: async () => {},
  notify: noop,
});
const pendingPlan = plan({ title: "A plan" });
planSave.resolve();
await pendingPlan;
assert.equal(events.A.length, 1);
assert.equal(events.B.length, 0);

let attempts = 0;
assert.deepEqual(
  await readChatSessionList(
    async () => {
      if (++attempts < 3) throw new Error("locked");
      return ["chat"];
    },
    async () => {},
  ),
  ["chat"],
);
let loaded = { current: false },
  notices = [];
await vm.runInNewContext(callbackJs("refreshSessions"), {
  isTauriRuntime: () => true,
  readChatSessionList: (read) => readChatSessionList(read, async () => {}),
  invoke: async () => {
    throw new Error("unavailable");
  },
  sessionsLoadedRef: loaded,
  notify: (...x) => notices.push(x),
})();
assert.equal(
  loaded.current,
  false,
  "A failed load must not prune restored chat panes",
);
assert.equal(notices[0][1], "Could not load chats");

let cache = {};
for (let i = 0; i < 300; i++)
  cache = retainChatResourcePayload(cache, String(i), i % 2 ? "A" : "B", {
    value: i,
  });
assert.equal(Object.keys(cache).length, 256);
cache = forgetChatResourcePayloads(cache, new Set(["299"]));
assert.equal(cache["299"], undefined);
cache = forgetChatSessionResources(cache, "A");
assert.ok(Object.values(cache).every((value) => value.sessionId === "B"));
assert.equal(Object.keys(cache).length, 128);

const reply = (message) => ({
  id: "reply",
  sessionId: "s",
  turnId: "t",
  createdAt: "2026-11-17T10:00:00Z",
  kind: "assistant-message",
  message,
  payload: { kind: "provider-response" },
});
for (const message of [
  "Use `System.Text.Json` to parse it.",
  "```python\ndef answer():\n\n    return 7\n```",
  "The result is:\n\n7\n\nThat is the count.",
  "7\n\nThat is the count.",
  "~~~python\ndef answer():\n\n    return 7\n~~~",
  "Use [API](https://Example.Com/Foo.Bar).",
]) {
  assert.equal(
    buildRunModel([reply(message)], { status: { status: "done" } }).response
      ?.message,
    message,
  );
}
for (const message of [
  "```python\ndef answer():\n\n    return 7",
  Array.from({ length: 1000 }, () => "`System.Text.Json` keeps its dots.").join(
    "\n\n",
  ),
  "```python\n" + "def answer():\n\n    return 7\n\n".repeat(1000) + "```",
]) {
  assert.equal(
    buildRunModel([reply(message)], { status: { status: "done" } }).response
      ?.message,
    message,
  );
}
for (const status of ["cancelled", "failed", "running"]) {
  const event = {
    ...reply("Running tests"),
    kind: "system-event",
    payload: {
      kind: "provider-activity",
      activityKind: "command",
      activityId: "cmd",
      status: "running",
      command: "npm test",
    },
  };
  const run = buildRunModel([event], { status: { status }, isRunning: false });
  assert.equal(run.steps[0].item.status, "interrupted");
  assert.equal(runRowText(run.steps[0]).label, "Interrupted");
  assert.equal(runCallText(run.steps[0]).label, "Interrupted");
}
console.log(
  "Chat session reliability: real send/stop callbacks, queue admission, failed-save recovery, model snapshots, scoped fallbacks, list failures, resource eviction and answer fidelity passed.",
);
