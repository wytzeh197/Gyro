import assert from "node:assert/strict";

import { selectQueuedMessageDelivery } from "../packages/ui/src/chat-message-queue.ts";

const message = (id, options = {}) => ({
  id,
  status: "waiting",
  ...options,
});

// A session can finish while the user is reading another chat. Its queue must
// continue without requiring focus to return to the finished session.
assert.deepEqual(
  selectQueuedMessageDelivery(
    {
      background: [message("background-next")],
      foreground: [message("foreground-next")],
    },
    {
      dispatchingSessionIds: new Set(),
      now: 100,
      sendingSessionIds: new Set(["foreground"]),
    },
  ),
  {
    kind: "ready",
    sessionId: "background",
    message: message("background-next"),
  },
  "an idle background chat should deliver its next queued message",
);

// A retry delay in one chat must not stall a ready message in another chat.
assert.deepEqual(
  selectQueuedMessageDelivery(
    {
      delayed: [message("retry", { retryAt: 500 })],
      ready: [message("go")],
    },
    {
      dispatchingSessionIds: new Set(),
      now: 100,
      sendingSessionIds: new Set(),
    },
  ),
  { kind: "ready", sessionId: "ready", message: message("go") },
  "a delayed retry should not block a different session's ready queue",
);

assert.deepEqual(
  selectQueuedMessageDelivery(
    { delayed: [message("retry", { retryAt: 500 })] },
    {
      dispatchingSessionIds: new Set(),
      now: 100,
      sendingSessionIds: new Set(),
    },
  ),
  { kind: "waiting", retryAt: 500 },
  "the scheduler should wake at the queue's next retry time",
);

console.log("chat message queue checks passed");
