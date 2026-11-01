import assert from "node:assert/strict";

import {
  CHAT_AUTO_RETRY_DELAY_MS,
  createChatAutoRetryController,
  eligibleChatAutoRetryFailure,
} from "../apps/desktop/src/chat-auto-retry.ts";

const busy = new Set();
const at = (time) => new Date(time).toISOString();
const event = (kind, id, payload = {}, extra = {}) => ({
  id,
  sessionId: "chat",
  turnId: "turn",
  kind,
  message: "",
  createdAt: at(0),
  payload,
  ...extra,
});
const user = event("user-message", "user", {}, { message: "Polish the app" });
const running = event("system-event", "status", {
  kind: "provider-status",
  status: "running",
});
const failure = event("system-event", "status", {
  kind: "provider-status",
  status: "failed",
  recoveryKind: "retry",
  error: "Selected model is at capacity. Please try a different model.",
});
const seeded = () => {
  const controller = createChatAutoRetryController();
  assert.deepEqual(controller.observe({ chat: [user, running] }, 0, busy), {});
  return controller;
};

assert.equal(CHAT_AUTO_RETRY_DELAY_MS, 30_000);
assert.equal(
  eligibleChatAutoRetryFailure([
    user,
    event("system-event", "workspace", {
      kind: "workspace-context",
      snapshot: {},
    }),
    event("system-event", "diagnostics", {
      kind: "provider-diagnostics",
      status: "failed",
    }),
    failure,
  ])?.id,
  failure.id,
  "the real host's workspace and diagnostic metadata are not completed work",
);
assert.equal(
  eligibleChatAutoRetryFailure([
    user,
    {
      ...failure,
      payload: { ...failure.payload, recoveryKind: "model-capacity-exhausted" },
    },
  ]),
  undefined,
  "exhausted native recovery cannot start a second host retry ladder",
);
assert.equal(
  eligibleChatAutoRetryFailure([
    user,
    {
      ...failure,
      payload: {
        ...failure.payload,
        error:
          "The model is still busy after three automatic attempts. Selected model is at capacity.",
      },
    },
  ]),
  undefined,
  "an exhausted error also stops the host ladder before its recovery kind arrives",
);
assert.equal(
  eligibleChatAutoRetryFailure([
    event(
      "goal-updated",
      "input-goal",
      { action: "set", text: "Polish the app" },
      {
        turnId: undefined,
      },
    ),
    event(
      "plan-updated",
      "input-plan",
      { action: "replace", items: [] },
      {
        turnId: undefined,
      },
    ),
    user,
    event("chat-mode-changed", "user-mode", { mode: "normal" }),
    failure,
  ]),
  failure,
  "the host's user-selected mode event must not be mistaken for executed work",
);
assert.equal(
  eligibleChatAutoRetryFailure([
    { ...user, turnId: undefined, payload: { turnId: "turn" } },
    {
      ...failure,
      turnId: undefined,
      payload: { ...failure.payload, turnId: "turn" },
    },
  ])?.id,
  failure.id,
  "legacy payload turn identities must retain safe retry behavior",
);
const controller = seeded();
assert.deepEqual(controller.observe({ chat: [user, failure] }, 100, busy), {
  status: { retryAt: 30_100 },
});
assert.deepEqual(controller.observe({ chat: [user, failure] }, 200, busy), {
  status: { retryAt: 30_100 },
});
assert.deepEqual(
  controller.takeDue({ chat: [user, failure] }, 30_099, busy),
  [],
);
assert.deepEqual(controller.takeDue({ chat: [user, failure] }, 30_100, busy), [
  failure,
]);
assert.deepEqual(
  controller.takeDue({ chat: [user, failure] }, 60_100, busy),
  [],
);
assert.deepEqual(
  controller.observe({ chat: [user, failure] }, 70_100, busy),
  {},
);
const secondFailure = { ...failure, id: "persisted-second-attempt" };
assert.deepEqual(
  controller.observe({ chat: [user, secondFailure] }, 70_200, busy),
  {},
  "another failure from the same turn must not start a spend loop",
);

const history = createChatAutoRetryController();
assert.deepEqual(history.observe({ chat: [user, failure] }, 100, busy), {});
assert.deepEqual(
  history.observe(
    {
      chat: [user, failure],
      lazy: [
        { ...user, sessionId: "lazy" },
        { ...failure, sessionId: "lazy" },
      ],
    },
    200,
    busy,
  ),
  {},
  "opening historical sessions must not resend old messages",
);

const cancelled = seeded();
cancelled.observe({ chat: [user, failure] }, 0, busy);
const durable = { ...failure, id: "durable-status" };
assert.deepEqual(
  cancelled.observe({ chat: [user, durable] }, 50, busy),
  {
    "durable-status": { retryAt: 30_000 },
  },
  "persisted failure identity keeps the original deadline",
);
cancelled.cancel(failure.id);
assert.deepEqual(
  cancelled.observe({ chat: [user, durable] }, 100, busy),
  {},
  "cancelling the optimistic status also cancels the persisted status",
);
assert.deepEqual(
  cancelled.takeDue({ chat: [user, durable] }, 40_000, busy),
  [],
);

const bySession = seeded();
bySession.observe({ chat: [user, failure] }, 0, busy);
bySession.cancelSession("chat");
assert.deepEqual(
  bySession.takeDue({ chat: [user, failure] }, 30_000, busy),
  [],
);

const deferred = seeded();
deferred.observe({ chat: [user, failure] }, 0, new Set(["chat"]));
assert.deepEqual(
  deferred.takeDue({ chat: [user, failure] }, 30_000, new Set(["chat"])),
  [],
);
assert.deepEqual(
  deferred.takeDue({ chat: [user, failure] }, 30_001, busy),
  [failure],
  "a terminal frame can arrive while its send is settling; retry waits for idle",
);

for (const replacement of [
  [...[user, failure], { ...user, id: "new-user", turnId: "next-turn" }],
  [user, failure, { ...running, id: "resumed" }],
  [user, failure, event("command-requested", "late-command")],
  [],
]) {
  const stale = seeded();
  stale.observe({ chat: [user, failure] }, 0, busy);
  assert.deepEqual(
    stale.takeDue({ chat: replacement }, 30_000, busy),
    [],
    "recheck the current turn, status and tools immediately before dispatch",
  );
}

const concurrent = createChatAutoRetryController();
const otherUser = { ...user, id: "other-user", sessionId: "other" };
const otherRunning = { ...running, id: "other-status", sessionId: "other" };
const otherFailure = { ...failure, id: "other-status", sessionId: "other" };
concurrent.observe(
  { chat: [user, running], other: [otherUser, otherRunning] },
  0,
  busy,
);
concurrent.observe(
  { chat: [user, failure], other: [otherUser, otherFailure] },
  0,
  busy,
);
assert.deepEqual(
  concurrent.takeDue(
    { chat: [user, failure], other: [otherUser, otherFailure] },
    30_000,
    new Set(["chat"]),
  ),
  [otherFailure],
);
assert.deepEqual(
  concurrent.takeDue(
    { chat: [user, failure], other: [otherUser, otherFailure] },
    30_001,
    busy,
  ),
  [failure],
  "one occupied chat must not block another",
);

for (const [kind, error] of [
  ["model-capacity", "The model is busy"],
  ["rate-limit", "Too many requests"],
  ["offline", "Network is unreachable"],
  ["retry", "Internal error: HTTP 503"],
  ["retry", "Connection reset by peer"],
  ["retry", "The model is overloaded"],
  ["retry", "The model is temporarily at capacity"],
  ["retry", 'Internal error: {"http_status":503,"message":"unavailable"}'],
  ["retry", "Internal server error"],
]) {
  const transient = {
    ...failure,
    payload: { ...failure.payload, recoveryKind: kind, error },
  };
  assert.equal(
    eligibleChatAutoRetryFailure([user, transient]),
    transient,
    error,
  );
}
for (const [kind, error] of [
  ["authentication", "Try again"],
  ["login-expired", "Try again"],
  ["plan-exhausted", "Try again"],
  ["provider-config", "Try again"],
  ["cli-contract", "Try again"],
  ["capacity", "Try again"],
  ["spend-ceiling", "Try again"],
  ["partial-answer", "Try again"],
  ["retry", "HTTP 401, temporarily unavailable"],
  [
    "retry",
    'Internal error: {"http_status":402,"message":"model is at capacity"}',
  ],
  ["retry", "insufficient_quota; model is at capacity"],
  ["retry", "usage limit reached; rate limit"],
  ["retry", "ACP run timed out"],
  ["retry", "Unknown provider crashed"],
]) {
  assert.equal(
    eligibleChatAutoRetryFailure([
      user,
      {
        ...failure,
        payload: { ...failure.payload, recoveryKind: kind, error },
      },
    ]),
    undefined,
    error,
  );
}

for (const work of [
  event("command-requested", "command"),
  event("command-output", "output"),
  event("file-edit-proposed", "proposal"),
  event("approval-requested", "approval"),
  event(
    "plan-updated",
    "model-plan",
    { sourceTurnId: "turn" },
    { turnId: undefined },
  ),
  event(
    "goal-updated",
    "model-goal",
    { sourceTurnId: "turn" },
    { turnId: undefined },
  ),
  event(
    "command-output",
    "payload-command",
    { turnId: "turn" },
    { turnId: undefined },
  ),
  event("system-event", "capability", {
    kind: "capability-call",
    status: "failed",
  }),
  event("system-event", "mutation", {
    schema: "gyro.mutation.v1",
    status: "applied",
  }),
  event("system-event", "provider-approval", {
    schema: "gyro.provider-approval.v1",
  }),
  event("system-event", "tool", {
    kind: "provider-activity",
    activityKind: "tool",
  }),
  event(
    "assistant-message",
    "partial",
    { streaming: true },
    { message: "The implementation should use a scheduler." },
  ),
  event(
    "assistant-message",
    "final",
    { kind: "provider-response" },
    { message: "I'll check that next." },
  ),
  event(
    "assistant-message",
    "mixed",
    { streaming: true },
    { message: "I'll check that. The answer is 42." },
  ),
]) {
  assert.equal(
    eligibleChatAutoRetryFailure([user, work, failure]),
    undefined,
    `${work.id} must prevent automatic replay`,
  );
}
for (const commentary of [
  event(
    "system-event",
    "commentary",
    { kind: "provider-activity", activityKind: "commentary" },
    { message: "I'll inspect the app." },
  ),
  event(
    "assistant-message",
    "preamble",
    { kind: "provider-stream", streaming: true },
    {
      message:
        "I’ll make an app-wide motion pass, focusing on quick, smooth panel transitions, overlays, and the AI browser cursor. I’ll inspect the existing components, implement consistent motion, and verify them in a standalone preview.",
    },
  ),
]) {
  assert.equal(
    eligibleChatAutoRetryFailure([user, commentary, failure]),
    failure,
    "a harmless preamble before a capacity refusal should still retry",
  );
}
assert.equal(
  eligibleChatAutoRetryFailure([{ ...user, turnId: undefined }, failure]),
  undefined,
);
assert.equal(
  eligibleChatAutoRetryFailure([
    user,
    { ...failure, payload: { ...failure.payload, status: "cancelled" } },
  ]),
  undefined,
);

console.log("chat auto retry checks passed");
