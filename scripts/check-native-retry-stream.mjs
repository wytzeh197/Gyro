import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { applyNativeProviderRetryStatus } from "../apps/desktop/src/provider-retry-stream.ts";
import { createChatAutoRetryController } from "../apps/desktop/src/chat-auto-retry.ts";
import { orderProviderChatStreamEvent } from "../apps/desktop/src/provider-stream-events.ts";

const deadline = "2026-10-12T08:00:30Z";
const event = {
  id: "status",
  sessionId: "chat",
  turnId: "turn",
  kind: "system-event",
  createdAt: "2026-10-12T08:00:00Z",
  message: "Working",
  payload: {
    kind: "provider-status",
    status: "running",
    userMessage: "Polish this",
    startedAt: "2026-10-12T08:00:00Z",
  },
};
const user = {
  ...event,
  id: "user",
  kind: "user-message",
  message: "Polish this",
  payload: {},
};
const wait = {
  sessionId: "chat",
  turnId: "turn",
  eventId: "wait",
  providerId: "openai",
  sequence: 1,
  phase: "retry-wait",
  status: "waiting",
  recoveryKind: "model-capacity",
  retryAt: deadline,
  retryAttempt: 1,
  retryMaxAttempts: 3,
  timelineCreatedAt: "2026-10-12T08:00:00Z",
  error: "Selected model is at capacity.",
};
const waiting = applyNativeProviderRetryStatus([user, event], wait);
assert.equal(waiting[1].payload.status, "waiting");
assert.equal(waiting[1].payload.retryAt, deadline);
assert.equal(waiting[1].payload.nativeRetry, true);
assert.equal(waiting[1].payload.startedAt, event.payload.startedAt);
assert.equal(waiting[0], user);
assert.equal(
  event.payload.status,
  "running",
  "projection does not mutate history",
);
const controller = createChatAutoRetryController();
controller.observe({ chat: [user, event] }, 0, new Set(["chat"]));
assert.deepEqual(
  controller.observe({ chat: waiting }, 1, new Set(["chat"])),
  {},
  "native waiting never schedules a second host send",
);
const buffered = applyNativeProviderRetryStatus([], wait);
assert.equal(
  buffered.length,
  1,
  "waiting survives refresh even when a persisted turn has no optimistic status yet",
);
assert.equal(buffered[0].payload.nativeRetry, true);
assert.equal(
  applyNativeProviderRetryStatus(waiting, { ...wait, retryAt: "invalid" }),
  waiting,
);
assert.equal(
  applyNativeProviderRetryStatus(waiting, {
    ...wait,
    turnId: "missing",
    retryAt: "invalid",
  }),
  waiting,
);
const resumed = applyNativeProviderRetryStatus(waiting, {
  ...wait,
  phase: "retry-started",
  status: "running",
});
assert.equal(resumed[1].payload.status, "running");
assert.equal(resumed[1].payload.retryAt, undefined);
assert.equal(resumed[1].payload.nativeRetry, undefined);
assert.equal(resumed[1].payload.error, undefined);

const streamOrder = new Map();
assert.equal(
  orderProviderChatStreamEvent(streamOrder, {
    ...wait,
    phase: "started",
    sequence: 0,
  }).length,
  1,
);
assert.equal(orderProviderChatStreamEvent(streamOrder, wait).length, 1);
assert.equal(
  orderProviderChatStreamEvent(streamOrder, {
    ...wait,
    phase: "retry-started",
    sequence: 2,
  }).length,
  1,
);
assert.equal(
  orderProviderChatStreamEvent(streamOrder, {
    ...wait,
    phase: "delta",
    sequence: 3,
    textDelta: "Continuing",
  }).length,
  1,
  "recovery is not a terminal event in stream ordering",
);

// Exercise the actual host status updater, including a delayed heartbeat.
const app = readFileSync(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
const tree = ts.createSourceFile(
  "App.tsx",
  app,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const names = new Set([
  "updateOptimisticProviderStatus",
  "providerStatusMessage",
]);
const functions = tree.statements.filter(
  (node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text),
);
assert.equal(functions.length, 2);
const js = ts.transpileModule(
  functions.map((node) => node.getText(tree)).join("\n") +
    "\nupdateOptimisticProviderStatus;",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const update = vm.runInNewContext(js, {
  recordFromUnknown: (value) =>
    value && typeof value === "object" ? value : undefined,
  stringFromRecord: (data, key) =>
    typeof data?.[key] === "string" ? data[key] : undefined,
  isProviderStatusEvent: (item) =>
    item.kind === "system-event" && item.payload?.kind === "provider-status",
  limitSessionEventsForUi: (items) => items,
});
const optimistic = { current: new Map([["chat", waiting]]) };
let rendered = waiting;
const setEvents = (change) => {
  rendered = typeof change === "function" ? change(rendered) : change;
};
update(optimistic, setEvents, "chat", "turn", "running", undefined, true);
assert.equal(
  rendered[1].payload.nativeRetry,
  true,
  "a late heartbeat cannot remove the wait notice",
);
update(
  optimistic,
  setEvents,
  "chat",
  "turn",
  "failed",
  "Model remains busy",
  false,
  "model-capacity-exhausted",
);
assert.equal(
  rendered[1].payload.recoveryKind,
  "model-capacity-exhausted",
  "the final native recovery limit is preserved immediately, before a disk refresh",
);
assert.equal(rendered[1].payload.nativeRetry, undefined);
assert.equal(
  rendered[1].payload.retryAt,
  undefined,
  "terminal state removes the expired wait deadline",
);
console.log(
  "Native retry stream: real deadline, retained work/start time, buffer refresh, resumed state, stream ordering, heartbeat and terminal cleanup pass.",
);
