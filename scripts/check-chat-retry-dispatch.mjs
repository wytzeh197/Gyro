import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  createChatRetryDispatcher,
  isChatRetryCurrent,
} from "../apps/desktop/src/chat-retry-dispatch.ts";

const user = {
  sessionId: "chat",
  id: "user",
  turnId: "original",
  kind: "user-message",
  message: "Finish the feature",
  createdAt: "2026-10-12T08:00:00Z",
  payload: {},
};
const failure = {
  ...user,
  id: "failed",
  kind: "system-event",
  message: "Model is temporarily busy",
  payload: { kind: "provider-status", status: "failed" },
};
assert.equal(isChatRetryCurrent([user, failure], failure), true);
assert.equal(
  isChatRetryCurrent(
    [user, { ...failure, payload: { ...failure.payload, status: "running" } }],
    failure,
  ),
  false,
);
assert.equal(
  isChatRetryCurrent(
    [user, failure, { ...user, id: "new-user", turnId: "new-turn" }],
    failure,
  ),
  false,
);
assert.equal(
  isChatRetryCurrent(
    [
      user,
      failure,
      {
        ...failure,
        id: "done",
        payload: { ...failure.payload, status: "done" },
      },
    ],
    failure,
  ),
  false,
);
assert.equal(
  isChatRetryCurrent([user, { ...failure, id: "stored-failure" }], failure),
  true,
  "optimistic and durable failure ids still name the same original turn",
);
const longTaskTail = [
  ...Array.from({ length: 399 }, (_, index) => ({
    ...failure,
    id: `tool-${index}`,
    payload: { kind: "provider-activity", status: "done" },
  })),
  failure,
];
assert.equal(longTaskTail.length, 400);
assert.equal(
  isChatRetryCurrent(longTaskTail, failure),
  true,
  "a 400-event tool tail can evict the original user without disabling Retry",
);
assert.equal(
  isChatRetryCurrent(
    [
      ...longTaskTail,
      {
        ...failure,
        id: "new-turn-status",
        turnId: "new-turn",
      },
    ],
    failure,
  ),
  false,
  "a newer turn without its visible user message supersedes an older failure",
);
assert.equal(
  isChatRetryCurrent(
    [
      ...longTaskTail,
      {
        ...failure,
        id: "new-turn-work",
        turnId: "new-turn",
        payload: { kind: "provider-activity", status: "running" },
      },
    ],
    failure,
  ),
  false,
  "newer work without a status also supersedes an older failure",
);
assert.equal(
  isChatRetryCurrent(
    longTaskTail.map((event) => ({
      ...event,
      turnId: undefined,
      payload: { ...event.payload, sourceTurnId: "original" },
    })),
    failure,
  ),
  true,
  "bounded history retains legacy sourceTurnId recovery",
);
let longTaskRetries = 0;
assert.equal(
  await createChatRetryDispatcher().dispatch("chat", "original", {
    isBusy: () => false,
    isCurrent: () => isChatRetryCurrent(longTaskTail, failure),
    send: async () => {
      longTaskRetries++;
      return true;
    },
  }),
  true,
);
assert.equal(
  longTaskRetries,
  1,
  "Retry actually dispatches after the original user leaves bounded history",
);

function deferred() {
  let resolve;
  const promise = new Promise((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

const preparing = createChatRetryDispatcher();
const configSave = deferred();
let preparationSends = 0;
const sendOptions = {
  isBusy: () => false,
  isCurrent: () => true,
  send: async (isOwned) => {
    await configSave.promise;
    if (!isOwned()) return false;
    preparationSends++;
    return true;
  },
};
const firstClick = preparing.dispatch("chat", "original", sendOptions);
assert.equal(await preparing.dispatch("chat", "original", sendOptions), false);
configSave.resolve();
assert.equal(await firstClick, true);
assert.equal(
  preparationSends,
  1,
  "two Retry clicks during model/config preparation launch one invoke",
);

const finishing = createChatRetryDispatcher();
const oldCleanup = deferred();
let busy = true,
  replayCount = 0;
const pendingReplay = finishing.dispatch("chat", "original", {
  isBusy: () => busy,
  isCurrent: () => true,
  wait: () => oldCleanup.promise,
  send: async () => {
    replayCount++;
    return true;
  },
});
assert.equal(
  replayCount,
  0,
  "a failed stream frame cannot replay before invoke cleanup",
);
assert.equal(await finishing.dispatch("chat", "original", sendOptions), false);
busy = false;
oldCleanup.resolve();
assert.equal(await pendingReplay, true);
assert.equal(
  replayCount,
  1,
  "the accepted click dispatches after cleanup with its original turn",
);

for (const cancellation of ["stop", "new-message", "unmount", "newer-turn"]) {
  const controller = createChatRetryDispatcher();
  const wait = deferred();
  let current = true,
    calls = 0,
    active = true;
  const replay = controller.dispatch("chat", "original", {
    isBusy: () => active,
    isCurrent: () => current,
    wait: () => wait.promise,
    send: async () => {
      calls++;
      return true;
    },
  });
  if (cancellation === "newer-turn") current = false;
  else if (cancellation === "unmount") controller.cancelAll();
  else controller.cancelSession("chat");
  active = false;
  wait.resolve();
  assert.equal(await replay, false);
  assert.equal(calls, 0, `${cancellation} cancels deferred recovery`);
}

const cancelledPreparation = createChatRetryDispatcher();
const preparingGate = deferred();
let staleCalls = 0;
const stale = cancelledPreparation.dispatch("chat", "original", {
  ...sendOptions,
  send: async (isOwned) => {
    await preparingGate.promise;
    if (!isOwned()) return false;
    staleCalls++;
    return true;
  },
});
cancelledPreparation.cancelSession("chat");
const replacementGate = deferred();
const replacement = cancelledPreparation.dispatch("chat", "new-turn", {
  ...sendOptions,
  send: async () => {
    await replacementGate.promise;
    return true;
  },
});
preparingGate.resolve();
assert.equal(await stale, false);
assert.equal(
  staleCalls,
  0,
  "Stop or a new message during awaited preparation prevents native dispatch",
);
assert.equal(
  await cancelledPreparation.dispatch("chat", "new-turn", sendOptions),
  false,
  "old finally cleanup cannot release a newer reservation",
);
replacementGate.resolve();
assert.equal(await replacement, true);

const parallel = createChatRetryDispatcher();
const independent = deferred();
const background = parallel.dispatch("background", "original", {
  ...sendOptions,
  send: async () => {
    await independent.promise;
    return true;
  },
});
assert.equal(
  await parallel.dispatch("focused", "other", {
    ...sendOptions,
    send: async () => true,
  }),
  true,
);
independent.resolve();
assert.equal(
  await background,
  true,
  "independent chats keep independent retry ownership",
);

// Run the actual sendDraft busy branch: a recovery must not become a new turn
// even when the original failed invoke has not released its sending flag yet.
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
let busyBranch;
function find(node) {
  if (
    ts.isIfStatement(node) &&
    node.expression
      .getText(tree)
      .includes("sendingSessionIdsRef.current.has(targetSessionId)") &&
    node.thenStatement
      .getText(tree)
      .includes("const queuedMessage: QueuedChatMessage")
  )
    busyBranch = node;
  ts.forEachChild(node, find);
}
find(tree);
assert.ok(busyBranch);
const branch = ts.transpileModule(
  `(async () => { ${busyBranch.getText(tree)} return "not-busy"; })()`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText;
for (const overrideContext of [
  { retryTurnId: "original" },
  { retryDispatchGuard: () => true },
]) {
  assert.equal(
    await vm.runInNewContext(branch, {
      targetSessionId: "chat",
      sendingSessionIdsRef: { current: new Set(["chat"]) },
      overrideContext,
      setChatMessageQueues: () =>
        assert.fail("Retry cannot append a fresh queued user-message"),
    }),
    false,
  );
}

// Exercise the production replay wiring as a background failure settles.
// The queue reinsert happens after the click, before the old dispatch finishes.
let replayDeclaration;
function findReplay(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(tree) === "replayFailedTurn"
  ) {
    replayDeclaration = node;
  }
  ts.forEachChild(node, findReplay);
}
findReplay(tree);
assert.ok(replayDeclaration);
const replayJs = ts.transpileModule(
  `const ${replayDeclaration.getText(tree)}; replayFailedTurn();`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  },
).outputText;
const replayController = createChatRetryDispatcher();
const queueCleanup = deferred();
const sending = new Set(["chat"]),
  queueDispatches = new Set(["chat"]);
const replayCalls = [];
let queuedState = {},
  replayPromise;
const backgroundContext = vm.createContext({
  userMessage: user.message,
  turnId: user.turnId,
  event: failure,
  userEvent: user,
  payload: failure.payload,
  recordFromUnknown: (value) =>
    value && typeof value === "object" ? value : undefined,
  stringFromRecord: (value, key) =>
    typeof value?.[key] === "string" ? value[key] : undefined,
  sendingSessionIdsRef: { current: sending },
  queuedChatDispatchesRef: { current: queueDispatches },
  sessionEventsByIdRef: { current: { chat: [user, failure] } },
  isChatRetryCurrent,
  retryDispatchRef: {
    current: {
      dispatch: (...args) =>
        (replayPromise = replayController.dispatch(args[0], args[1], {
          ...args[2],
          wait: () => queueCleanup.promise,
        })),
    },
  },
  sendDraftRef: {
    current: async (message, context) => {
      replayCalls.push({ message, context });
      return true;
    },
  },
  setChatMessageQueues: (update) => {
    queuedState = update(queuedState);
  },
  notify: (...args) => assert.fail(`Unexpected retry error: ${args}`),
});
vm.runInContext(replayJs, backgroundContext);
assert.equal(replayCalls.length, 0);
const originalReplay = replayPromise;
vm.runInContext("replayFailedTurn();", backgroundContext);
assert.equal(
  await replayPromise,
  false,
  "actual Retry handler suppresses duplicate clicks",
);
queuedState = {
  chat: [
    { id: "reinserted", context: { retryTurnId: "original" } },
    { id: "next", context: { turnId: "next-turn" } },
  ],
};
sending.clear();
queueDispatches.clear();
queueCleanup.resolve();
assert.equal(await originalReplay, true);
assert.equal(replayCalls.length, 1);
assert.equal(replayCalls[0].message, user.message);
assert.equal(replayCalls[0].context.retryTurnId, user.turnId);
assert.equal(replayCalls[0].context.sessionId, "chat");
assert.equal(replayCalls[0].context.preserveDraft, true);
assert.deepEqual(
  queuedState.chat.map((item) => item.id),
  ["next"],
  "Retry removes a failed queued replay after old cleanup and preserves other messages",
);
console.log(
  "Chat retry dispatch: duplicate-click protection, original invoke cleanup, cancellation, newer turns, background independence and actual busy send guard pass.",
);
