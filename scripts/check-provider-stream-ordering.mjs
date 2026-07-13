import assert from "node:assert/strict";

import {
  applyProviderChatStreamDeltas,
  mergeProviderResponseEvents,
  orderProviderChatStreamEvent,
} from "../apps/desktop/src/provider-stream-events.ts";

function streamEvent(sequence, phase = "delta", textDelta = `${sequence}`) {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    providerId: "openai",
    eventId: `event-${sequence}`,
    sequence,
    phase,
    textDelta,
  };
}

const orderState = new Map();
assert.deepEqual(
  orderProviderChatStreamEvent(orderState, streamEvent(0, "started", "")),
  [streamEvent(0, "started", "")],
);
assert.deepEqual(orderProviderChatStreamEvent(orderState, streamEvent(2)), []);
assert.deepEqual(orderProviderChatStreamEvent(orderState, streamEvent(1)), [
  streamEvent(1),
  streamEvent(2),
]);
assert.deepEqual(orderProviderChatStreamEvent(orderState, streamEvent(1)), []);
assert.deepEqual(
  orderProviderChatStreamEvent(orderState, streamEvent(3, "completed", "")),
  [streamEvent(3, "completed", "")],
);
assert.deepEqual(
  orderProviderChatStreamEvent(orderState, streamEvent(3, "completed", "")),
  [],
);
assert.deepEqual(orderProviderChatStreamEvent(orderState, streamEvent(4)), []);
assert.equal(orderState.size, 1);

const optimisticEventsRef = { current: new Map([["session-1", []]]) };
let renderedEvents = [];
applyProviderChatStreamDeltas(
  optimisticEventsRef,
  (update) => {
    renderedEvents =
      typeof update === "function" ? update(renderedEvents) : update;
  },
  [streamEvent(1, "delta", "hello "), streamEvent(2, "delta", "world")],
);
assert.equal(
  optimisticEventsRef.current.get("session-1")[0]?.message,
  "hello world",
);

const runningStatus = {
  id: "status-running",
  sessionId: "session-1",
  turnId: "turn-retry",
  createdAt: "2026-07-13T09:45:00.000Z",
  kind: "system-event",
  message: "OpenAI is working",
  payload: {
    kind: "provider-status",
    status: "running",
    startedAt: "2026-07-13T09:45:23.000Z",
  },
};
const historicalStatus = {
  ...runningStatus,
  id: "status-historical",
  createdAt: "2026-07-13T09:40:00.000Z",
  message: "OpenAI was cancelled",
  payload: {
    kind: "provider-status",
    status: "cancelled",
    startedAt: "2026-07-13T09:39:50.000Z",
    completedAt: "2026-07-13T09:40:00.000Z",
    durationMs: 10_000,
  },
};
const completedStatus = {
  ...runningStatus,
  id: "status-completed",
  createdAt: "2026-07-13T09:45:45.500Z",
  message: "OpenAI answered",
  payload: { kind: "provider-status", status: "done" },
};
const mergedStatus = mergeProviderResponseEvents(
  [historicalStatus, runningStatus],
  [completedStatus],
);
assert.equal(mergedStatus[0]?.payload?.status, "cancelled");
assert.equal(mergedStatus[0]?.payload?.durationMs, 10_000);
const latestMergedStatus = mergedStatus[1];
assert.equal(
  latestMergedStatus?.payload?.startedAt,
  "2026-07-13T09:45:23.000Z",
);
assert.equal(
  latestMergedStatus?.payload?.completedAt,
  "2026-07-13T09:45:45.500Z",
);
assert.equal(latestMergedStatus?.payload?.durationMs, 22_500);

console.log(
  "Provider stream ordering checks passed (reorder, dedupe, completion, coalescing, retry timing).",
);
