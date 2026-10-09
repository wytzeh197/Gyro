import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  createCoalescedReader,
  sameSessionEvents,
} from "../apps/desktop/src/responsiveness.ts";
import {
  compareSessionEventsForHistory,
  mergeSessionHistoryPages,
} from "../apps/desktop/src/session-event-order.ts";
import {
  limitSessionEventsForUi,
  mergePersistedAndOptimisticEvents,
  preserveDeliveredResponses,
  mergeProviderResponseEvents,
  MAX_CHAT_EVENT_HOLD_COUNT,
  MAX_CHAT_EVENT_RENDER_COUNT,
  orderProviderChatStreamEvent,
  nextProviderStreamGapDeadline,
  flushExpiredProviderStreamGaps,
} from "../apps/desktop/src/provider-stream-events.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));
let now = 0;
let calls = 0;
const pending = new Map();
const read = createCoalescedReader(
  (key) => {
    calls++;
    assert.ok(
      !pending.has(key),
      "one transcript read per chat may be in flight",
    );
    return new Promise((resolve, reject) =>
      pending.set(key, { resolve, reject }),
    );
  },
  50,
  () => now,
);
const settle = (key, failure) => {
  const request = pending.get(key);
  assert.ok(request);
  pending.delete(key);
  if (failure) request.reject(failure);
  else request.resolve();
};
const first = read("a");
assert.equal(read("a"), first);
await flush();
let trailing;
for (let i = 0; i < 100; i++) {
  now += 10;
  const request = read("a");
  if (now < 50) assert.equal(request, first);
  else {
    trailing ??= request;
    assert.equal(request, trailing, "late requests share one trailing read");
  }
}
const other = read("b");
await flush();
assert.equal(
  calls,
  2,
  "different chats read independently; bursts do not fan out",
);
settle("a");
await flush();
assert.equal(calls, 3, "a burst schedules exactly one fresh trailing read");
await first;
now += 100;
const nextRefresh = read("a");
settle("a");
settle("b");
await Promise.all([trailing, other]);
assert.ok(
  pending.has("a"),
  "earlier callers settle even while more refreshes keep arriving",
);
settle("a");
await nextRefresh;
assert.equal(pending.size, 0);
const failing = read("a");
const firstFailure = assert.rejects(failing, /disk unavailable/);
await flush();
now += 100;
const recovery = read("a");
settle("a", new Error("disk unavailable"));
await firstFailure;
await flush();
assert.ok(pending.has("a"), "a queued refresh survives a failed read");
settle("a");
await recovery;
const failure = read("a");
const rejected = assert.rejects(failure, /disk unavailable/);
await flush();
settle("a", new Error("disk unavailable"));
await rejected;
const afterFailure = read("a");
await flush();
settle("a");
await afterFailure;

// Exercise the actual desktop callback so paging, the optimistic buffer and
// stale-read guards are checked together, including a real rejected RPC.
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
let initializer;
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(tree) === "readSessionEvents"
  )
    initializer = node.initializer;
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(initializer);
const callbackSource = ts.transpileModule(
  `const callback = ${initializer.getText(tree)}; callback;`,
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  },
).outputText;
const sessionId = "history-chat";
const event = (number) => ({
  id: `event-${number}`,
  sessionId,
  kind: number === 0 ? "session-created" : "system-event",
  message: `record ${number}`,
  payload: {},
  createdAt: new Date(number * 1000).toISOString(),
});
const expandedHistorySessionsRef = { current: new Set([sessionId]) };
const optimisticEventsRef = { current: new Map([[sessionId, [event(651)]]]) };
let rendered = Array.from({ length: 650 }, (_, i) => event(i));
let rpc = [];
const callback = runInNewContext(callbackSource, {
  useCallback: (fn) => fn,
  isTauriRuntime: () => true,
  sessionEventsRequestRef: { current: {} },
  expandedHistorySessionsRef,
  optimisticEventsRef,
  liveCapabilityResourceIdsRef: { current: new Set() },
  limitEventsForSession: (id, events) =>
    limitSessionEventsForUi(
      events,
      expandedHistorySessionsRef.current.has(id)
        ? MAX_CHAT_EVENT_HOLD_COUNT
        : MAX_CHAT_EVENT_RENDER_COUNT,
    ),
  replaceSessionContextEvents: () => {},
  setHasMoreBeforeBySession: () => {},
  setEventsForSession: (_id, update) => {
    rendered = typeof update === "function" ? update(rendered) : update;
  },
  mergePersistedAndOptimisticEvents,
  mergeSessionHistoryPages,
  compareSessionEventsForHistory,
  preserveDeliveredResponses,
  markInactiveCapabilityResources: (events) => events,
  sameSessionEvents,
  MAX_CHAT_EVENT_HOLD_COUNT,
  MAX_CHAT_EVENT_RENDER_COUNT,
  invoke: () => new Promise((resolve, reject) => rpc.push({ resolve, reject })),
});
const refresh = callback(sessionId);
rpc.shift().resolve({
  events: rendered.slice(-400),
  contextEvents: [],
  hasMoreBefore: true,
});
await refresh;
assert.equal(
  rendered.length,
  651,
  "refresh must keep loaded earlier pages and live activity",
);
assert.ok(expandedHistorySessionsRef.current.has(sessionId));
assert.equal(rendered[1].id, "event-1");
const failedRefresh = callback(sessionId);
rpc.shift().reject(new Error("temporary read failure"));
await failedRefresh;
assert.equal(
  rendered.length,
  651,
  "a failed refresh must not replace durable history with the optimistic tail",
);

const stale = callback(sessionId);
const latest = callback(sessionId);
rpc[1].resolve({
  events: [event(652)],
  contextEvents: [],
  hasMoreBefore: true,
});
await latest;
rpc[0].resolve({
  events: [event(999)],
  contextEvents: [],
  hasMoreBefore: false,
});
await stale;
assert.ok(rendered.some((item) => item.id === "event-652"));
assert.ok(
  !rendered.some((item) => item.id === "event-999"),
  "superseded reads cannot overwrite current history",
);

// The real RPC completion must commit at the same priority as clearing the
// sending flag. A delayed transition otherwise exposes a stale running status
// as Interrupted and offers Retry for an already completed provider request.
let responseInitializer;
function findResponse(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(tree) === "applyProviderChatResponse"
  ) {
    responseInitializer = node.initializer;
  }
  ts.forEachChild(node, findResponse);
}
findResponse(tree);
assert.ok(responseInitializer);
const responseCallback = runInNewContext(
  ts.transpileModule(
    `const callback = ${responseInitializer.getText(tree)}; callback;`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText,
  {
    useCallback: (fn) => fn,
    startTransition: () =>
      assert.fail("completed provider replies must not wait for a transition"),
    optimisticEventsRef,
    setSessions: () => {},
    setEventsForSession: (_id, update) => {
      rendered = limitSessionEventsForUi(
        update(rendered),
        MAX_CHAT_EVENT_HOLD_COUNT,
      );
    },
    mergeProviderResponseEvents,
    limitSessionEventsForUi,
  },
);
const historyBeforeCompletion = rendered.length;
responseCallback(sessionId, {
  assistantEvent: {
    ...event(653),
    kind: "assistant-message",
    turnId: "completed",
    payload: { kind: "provider-response", status: "done" },
  },
});
assert.equal(
  rendered.length,
  historyBeforeCompletion + 1,
  "completion retains expanded history",
);
assert.equal(
  rendered.at(-1).payload.kind,
  "provider-response",
  "durable reply commits before sending cleanup",
);

const large = Array.from({ length: 3000 }, (_, i) => event(i));
const bounded = mergePersistedAndOptimisticEvents(
  large,
  [event(3001)],
  MAX_CHAT_EVENT_HOLD_COUNT,
);
assert.equal(bounded.length, MAX_CHAT_EVENT_HOLD_COUNT);
assert.equal(bounded[0].kind, "session-created");
assert.equal(bounded.at(-1).id, "event-3001");

const dispatcherExports = {};
runInNewContext(
  ts.transpileModule(
    readFileSync(
      new URL(
        "../apps/desktop/src/provider-stream-dispatcher.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText,
  {
    exports: dispatcherExports,
    require: () => ({
      orderProviderChatStreamEvent,
      nextProviderStreamGapDeadline,
      flushExpiredProviderStreamGaps,
    }),
  },
);
let streamNow = 0;
let nextTimer = 0;
const timers = new Map();
const accepted = [];
const dispatcher = dispatcherExports.createProviderStreamDispatcher(
  new Map(),
  (event) => accepted.push(event),
  {
    now: () => streamNow,
    setTimer: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, at: streamNow + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  },
);
const advance = (time) => {
  streamNow = time;
  for (const [id, timer] of timers) {
    if (timer.at <= time) {
      timers.delete(id);
      timer.callback();
    }
  }
};
const frame = (sequence, phase = "delta", sessionId = "stream-a") => ({
  sessionId,
  turnId: "turn",
  providerId: "openai",
  sequence,
  eventId: `frame-${sequence}`,
  phase,
  textDelta: `${sequence}`,
});
dispatcher.push(frame(0, "started"));
dispatcher.push(frame(2));
dispatcher.push(frame(4));
assert.equal(timers.size, 1, "gap recovery uses one timer, not one per frame");
advance(499);
assert.equal(accepted.length, 1, "normal IPC reordering has a grace period");
advance(500);
assert.deepEqual(
  accepted.map((event) => event.sequence),
  [0, 2, 4],
  "a sparse stream recovers without another event",
);
assert.equal(timers.size, 0, "ordered streams leave no polling timer");
dispatcher.push(frame(1));
assert.equal(accepted.length, 3, "a late skipped frame cannot replay text");
dispatcher.push(frame(8));
dispatcher.push(frame(6, "completed"));
assert.equal(accepted.at(-1).sequence, 6);
assert.ok(
  !accepted.some((event) => event.sequence === 8),
  "frames beyond completion must never paint",
);
advance(1000);
assert.equal(timers.size, 0);

accepted.length = 0;
dispatcher.push(frame(0, "started", "stream-b"));
dispatcher.push(frame(2, "delta", "stream-b"));
advance(1100);
dispatcher.push(frame(1, "delta", "stream-b"));
assert.deepEqual(
  accepted.map((event) => event.sequence),
  [0, 1, 2],
  "frames arriving within the grace period keep their full order",
);
dispatcher.push(frame(5, "delta", "stream-b"));
assert.equal(timers.size, 1);
dispatcher.dispose();
assert.equal(timers.size, 0, "unmount clears pending recovery timers");
advance(2000);
assert.equal(accepted.length, 3);

const busyState = new Map();
orderProviderChatStreamEvent(busyState, frame(0, "started", "long-running"), 0);
orderProviderChatStreamEvent(busyState, frame(1, "delta", "long-running"), 0);
for (let i = 0; i < 300; i++) {
  orderProviderChatStreamEvent(
    busyState,
    frame(0, "started", `completed-${i}`),
    0,
  );
  orderProviderChatStreamEvent(
    busyState,
    frame(1, "completed", `completed-${i}`),
    0,
  );
}
assert.equal(busyState.size, 256);
assert.equal(
  orderProviderChatStreamEvent(busyState, frame(1, "delta", "long-running"), 0)
    .length,
  0,
  "completed history must not evict duplicate protection on a live background turn",
);
console.log(
  "Backend responsiveness passed: bounded/coalesced RPCs, independent chats, trailing recovery, retained history, failed and superseded reads, bounded expanded window.",
);
console.log(
  "Stream gap recovery passed: sparse timed recovery, reordering grace, no replay after gaps or completion, one timer, cleanup.",
);
