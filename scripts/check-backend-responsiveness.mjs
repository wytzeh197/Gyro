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
  limitOptimisticSessionEvents,
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
const completeHistorySessionsRef = { current: new Set() };
const historyRevisionsRef = { current: {} };
const optimisticEventsRef = { current: new Map() };
const sessionEventsByIdRef = { current: {} };
let rendered = [];
const rpc = [];
let hasMoreBefore;
let contextUpdates = 0;
const callback = runInNewContext(callbackSource, {
  useCallback: (fn) => fn,
  isTauriRuntime: () => true,
  sessionEventsRequestRef: { current: {} },
  completeHistorySessionsRef,
  historyRevisionsRef,
  sessionEventsByIdRef,
  optimisticEventsRef,
  liveCapabilityResourceIdsRef: { current: new Set() },
  replaceSessionContextEvents: () => { contextUpdates++; },
  setHasMoreBeforeBySession: (update) => {
    hasMoreBefore = update({})[sessionId];
  },
  setEventsForSession: (_id, update) => {
    rendered = typeof update === "function" ? update(rendered) : update;
    sessionEventsByIdRef.current[sessionId] = rendered;
  },
  mergePersistedAndOptimisticEvents,
  mergeSessionHistoryPages,
  preserveDeliveredResponses,
  markInactiveCapabilityResources: (events) => events,
  sameSessionEvents,
  notify: () => {},
  MAX_CHAT_EVENT_RENDER_COUNT,
  invoke: (_command, args) =>
    new Promise((resolve, reject) => rpc.push({ resolve, reject, args })),
});
const reopen = callback(sessionId);
assert.equal(rpc[0].args.fullHistory, true, "opening requests every event");
rpc.shift().resolve({
  events: Array.from({ length: 3101 }, (_, i) => event(i)),
  contextEvents: [],
  hasMoreBefore: false,
  revision: "revision-1",
});
// A stream frame arriving during disk IO must survive the initial load.
optimisticEventsRef.current.set(sessionId, [event(3101)]);
await reopen;
assert.equal(rendered.length, 3102);
assert.equal(rendered[1].id, "event-1");
assert.equal(rendered.at(-1).id, "event-3101");
assert.equal(hasMoreBefore, false);
assert.ok(completeHistorySessionsRef.current.has(sessionId));

const unchangedRead = callback(sessionId);
assert.equal(rpc[0].args.knownRevision, "revision-1");
rpc
  .shift()
  .resolve({
    events: [],
    contextEvents: [],
    hasMoreBefore: false,
    revision: "revision-1",
    unchanged: true,
  });
await unchangedRead;
assert.equal(contextUpdates, 1, "metadata-only reads cannot erase goal and plan context");
assert.equal(
  rendered.length,
  3102,
  "metadata-only refresh preserves the complete transcript",
);

const refresh = callback(sessionId);
assert.equal(rpc[0].args.fullHistory, false, "ordinary refresh stays cheap");
rpc.shift().resolve({
  events: Array.from({ length: 400 }, (_, i) => event(i + 2703)),
  contextEvents: [],
  hasMoreBefore: true,
});
await refresh;
assert.equal(
  rendered.length,
  3103,
  "refresh keeps history beyond both old caps",
);
assert.equal(rendered[1].id, "event-1");
assert.equal(
  hasMoreBefore,
  false,
  "the tail cannot make complete history partial",
);

const failedRefresh = callback(sessionId);
rpc.shift().reject(new Error("temporary read failure"));
await failedRefresh;
assert.equal(rendered.length, 3103, "failure preserves the transcript");

// Hundreds of events can accumulate while the computer sleeps. A disjoint
// tail must trigger a full recovery so the middle of the chat remains visible.
const sleepRecovery = callback(sessionId);
rpc.shift().resolve({
  events: [event(0), ...Array.from({ length: 400 }, (_, i) => event(i + 4000))],
  contextEvents: [],
  hasMoreBefore: true,
});
await flush();
assert.equal(rpc[0].args.fullHistory, true, "session-created is not overlap");
rpc.shift().resolve({
  events: Array.from({ length: 4400 }, (_, i) => event(i)),
  contextEvents: [],
  hasMoreBefore: false,
});
await sleepRecovery;
assert.equal(rendered.length, 4400);
assert.equal(rendered[3500].id, "event-3500", "background gap recovered");

const stale = callback(sessionId);
const latest = callback(sessionId);
rpc[1].resolve({
  events: [event(4399), event(4400)],
  contextEvents: [],
  hasMoreBefore: true,
});
await latest;
rpc[0].resolve({
  events: [event(9999)],
  contextEvents: [],
  hasMoreBefore: false,
});
await stale;
rpc.length = 0;
assert.ok(rendered.some((item) => item.id === "event-4400"));
assert.ok(
  !rendered.some((item) => item.id === "event-9999"),
  "superseded reads cannot overwrite current history",
);

// A frontend hot reload can precede the native upgrade. An older runtime's
// bounded response must still automatically produce the entire conversation.
completeHistorySessionsRef.current.delete(sessionId);
optimisticEventsRef.current.clear();
rendered = [];
sessionEventsByIdRef.current[sessionId] = [];
const legacyOpen = callback(sessionId);
rpc.shift().resolve({
  events: Array.from({ length: 400 }, (_, i) => event(401 + i)),
  contextEvents: [],
  hasMoreBefore: true,
});
await flush();
assert.equal(rpc[0].args.beforeEventId, "event-401");
rpc.shift().resolve({
  events: Array.from({ length: 401 }, (_, i) => event(i)),
  hasMoreBefore: false,
});
await legacyOpen;
assert.equal(rendered.length, 801, "old runtimes automatically load all pages");
assert.equal(rendered[1].id, "event-1");
assert.equal(hasMoreBefore, false);

// A metadata revision is useful only while its corresponding full transcript
// is still in memory; an evicted/reopened chat must fetch all data again.
rendered = [];
sessionEventsByIdRef.current[sessionId] = [];
historyRevisionsRef.current[sessionId] = "cached-revision";
const evictedOpen = callback(sessionId);
assert.equal(rpc[0].args.fullHistory, true);
assert.equal(rpc[0].args.knownRevision, undefined);
rpc.shift().resolve({events:Array.from({length:801},(_,i)=>event(i)),contextEvents:[],hasMoreBefore:false,revision:"fresh-revision"});
await evictedOpen;
assert.equal(rendered.length,801);

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
      rendered = update(rendered);
    },
    mergeProviderResponseEvents,
    limitSessionEventsForUi,
    limitOptimisticSessionEvents,
  },
);
const historyBeforeCompletion = rendered.length;
responseCallback(sessionId, {
  assistantEvent: {
    ...event(4401),
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
  "Backend responsiveness passed: bounded/coalesced RPCs, independent chats, trailing recovery, retained history, failed and superseded reads, complete reopening and background gap recovery.",
);
console.log(
  "Stream gap recovery passed: sparse timed recovery, reordering grace, no replay after gaps or completion, one timer, cleanup.",
);
