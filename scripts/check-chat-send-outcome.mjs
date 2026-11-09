import assert from "node:assert/strict";
import {
  chatSendAccepted,
  queuedDeliveryDisposition,
} from "../apps/desktop/src/chat-send-outcome.ts";
import { eligibleChatAutoRetryFailure } from "../apps/desktop/src/chat-auto-retry.ts";

assert.equal(
  queuedDeliveryDisposition({ kind: "failed", persisted: true }),
  "settled",
  "a saved failure belongs to backend recovery, never another queued copy",
);
assert.equal(
  queuedDeliveryDisposition({
    kind: "not-started",
    persisted: false,
    reason: "busy",
  }),
  "waiting",
);
assert.equal(
  queuedDeliveryDisposition({
    kind: "not-started",
    persisted: false,
    reason: "precondition",
  }),
  "failed",
);
assert.equal(
  queuedDeliveryDisposition({ kind: "cancelled", persisted: false }),
  "settled",
);
assert.equal(chatSendAccepted({ kind: "failed", persisted: true }), false);
assert.equal(chatSendAccepted({ kind: "queued", persisted: false }), true);
const user = {
  id: "user",
  sessionId: "chat",
  turnId: "turn",
  kind: "user-message",
  message: "edit and verify",
  createdAt: new Date(0).toISOString(),
  payload: {},
};
const failure = {
  ...user,
  id: "failed",
  kind: "system-event",
  message: "rate limit reached",
  payload: {
    kind: "provider-status",
    status: "failed",
    recoveryKind: "rate-limit",
    recoveryOwner: "backend",
  },
};
assert.equal(
  eligibleChatAutoRetryFailure([user, failure]),
  undefined,
  "terminal native failures cannot start a second frontend ladder",
);
console.log(
  "Chat send outcomes: persisted failure, busy/precondition, cancellation, and backend retry ownership pass.",
);
