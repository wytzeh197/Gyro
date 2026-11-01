import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const {
  eligibleChatAutoRetryFailure: eligible,
  createChatAutoRetryController,
} = await import(
  pathToFileURL(
    resolve(
      process.env.GYRO_VERIFY_WORKSPACE,
      "apps/desktop/src/chat-auto-retry.ts",
    ),
  )
);
const event = (id, kind, message, payload = {}) => ({
  id,
  sessionId: "session",
  turnId: "turn",
  kind,
  message,
  payload,
  createdAt: "2026-10-31T10:00:00.000Z",
});
const user = event("user", "user-message", "Repair the search results");
const failure = (recoveryKind, id = "failure") =>
  event(id, "system-event", "Connection reset; HTTP 503", {
    kind: "provider-status",
    status: "failed",
    recoveryKind,
  });
const empty = new Set();

for (const kind of [
  "no-progress",
  "tool-budget",
  "partial-answer",
  "authentication",
]) {
  test(`terminal ${kind} overrides transient-looking error text`, () => {
    assert.equal(eligible([user, failure(kind)]), undefined);
  });
}
test("transient pre-work failures remain eligible", () => {
  for (const kind of ["network", "model-capacity", "server", "rate-limit"]) {
    const status = failure(kind);
    assert.equal(eligible([user, status]), status);
  }
});
test("completed work and answers cannot be replayed", () => {
  const actions = [
    event("work", "system-event", "", { schema: "gyro.mutation.v1" }),
    event("answer", "assistant-message", "Implemented and verified the fix."),
  ];
  for (const action of actions)
    assert.equal(eligible([user, action, failure("network")]), undefined);
});
test("historical failures do not schedule a fresh retry", () => {
  const controller = createChatAutoRetryController();
  const events = { session: [user, failure("network")] };
  assert.deepEqual(controller.observe(events, 0, empty), {});
  assert.deepEqual(controller.takeDue(events, 90_000, empty), []);
});
test("one delayed retry survives duplicate frames without extending its deadline", () => {
  const controller = createChatAutoRetryController();
  controller.observe({ session: [user] }, 0, empty);
  const failed = failure("network");
  const events = { session: [user, failed] };
  assert.deepEqual(controller.observe(events, 100, empty), {
    failure: { retryAt: 30_100 },
  });
  const persisted = failure("network", "persisted");
  events.session.push(persisted);
  assert.deepEqual(controller.observe(events, 1_000, empty), {
    persisted: { retryAt: 30_100 },
  });
  assert.deepEqual(controller.takeDue(events, 30_099, empty), []);
  assert.deepEqual(
    controller.takeDue(events, 30_100, new Set(["session"])),
    [],
  );
  assert.deepEqual(controller.takeDue(events, 30_101, empty), [persisted]);
  events.session.push(failure("network", "again"));
  assert.deepEqual(controller.observe(events, 40_000, empty), {});
  assert.deepEqual(controller.takeDue(events, 90_000, empty), []);
});
test("a newly completed answer cancels a scheduled retry", () => {
  const controller = createChatAutoRetryController();
  controller.observe({ session: [user] }, 0, empty);
  const events = { session: [user, failure("network")] };
  controller.observe(events, 100, empty);
  events.session.push(
    event("answer", "assistant-message", "The fix is implemented."),
  );
  assert.deepEqual(controller.takeDue(events, 30_101, empty), []);
});
