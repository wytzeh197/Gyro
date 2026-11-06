import assert from "node:assert/strict";
import {
  cloudDeviceId,
  cloudSourceReference,
  contextReview,
  managedTaskAvailability,
  memoryDraftState,
  reportLinkState,
  sourceMessageExcerpt,
  sourceRangeLabel,
} from "../packages/ui/src/cloud-services-state.ts";

const enabled = { allowed: true, reason: "included" };
assert.equal(
  managedTaskAvailability("plus", "failure-explanation", enabled, "active")
    .allowed,
  true,
);
assert.equal(
  managedTaskAvailability("plus", "change-review", enabled, "active").allowed,
  false,
);
assert.equal(
  managedTaskAvailability("premium", "change-review", enabled, "active")
    .allowed,
  true,
);
assert.equal(
  managedTaskAvailability(
    "premium",
    "change-review",
    enabled,
    "cancellation-scheduled",
  ).allowed,
  true,
);
for (const state of [
  "offline",
  "exhausted",
  "expired",
  "disputed",
  "checking",
  undefined,
])
  assert.equal(
    managedTaskAvailability("premium", "failure-explanation", enabled, state)
      .allowed,
    false,
  );
assert.equal(
  managedTaskAvailability(
    "premium",
    "failure-explanation",
    { allowed: false, reason: "exhausted" },
    "active",
  ).allowed,
  false,
);
assert.equal(
  managedTaskAvailability("lite", "memory-update", enabled, "active").allowed,
  false,
);
assert.equal(
  managedTaskAvailability("premium", "unknown-task", enabled, "active").allowed,
  false,
);

// Bound UTF-8 and serialized quoting, never an optimistic characters/token guess.
assert.equal(contextReview("a".repeat(3904), "plus").allowed, true);
assert.equal(contextReview("a".repeat(3905), "plus").allowed, false);
assert.equal(contextReview("a".repeat(27904), "premium").allowed, true);
assert.equal(contextReview("a".repeat(27905), "premium").allowed, false);
assert.equal(contextReview("😀".repeat(977), "plus").allowed, false);
assert.equal(contextReview("\n".repeat(2000), "plus").allowed, false);
assert.equal(contextReview('"'.repeat(2000), "plus").allowed, false);
assert.equal(contextReview('"'.repeat(1000), "plus").allowed, false);
assert.equal(contextReview("\n".repeat(1302), "plus").allowed, false);
assert.equal(contextReview("\u0000".repeat(558), "plus").allowed, false);
assert.equal(contextReview("\u0000".repeat(651), "plus").allowed, false);
assert.equal(contextReview("  ", "premium").allowed, false);
assert.equal(contextReview("Context", undefined).allowed, false);

const now = Date.parse("2026-11-02T12:00:00Z");
const link = { expiresAt: "2026-11-03T12:00:00Z", revokedAt: null };
assert.equal(reportLinkState(link, "active", now).label, "Active");
assert.equal(reportLinkState(link, "exhausted", now).label, "Active");
assert.equal(
  reportLinkState({ ...link, paused: true }, "active", now).label,
  "Paused by plan limit",
);
assert.equal(
  reportLinkState(
    { ...link, expiresAt: "2026-11-01T12:00:00Z", paused: true },
    "active",
    now,
  ).label,
  "Expired",
);
assert.equal(
  reportLinkState({ ...link, revokedAt: "2026-11-02T11:00:00Z" }, "active", now)
    .revocable,
  false,
);
assert.equal(reportLinkState(link, "offline", now).label, "Status unverified");
assert.match(reportLinkState(link, "expired", now).label, /Paused/);
assert.equal(
  reportLinkState({ expiresAt: "invalid" }, "active", now).label,
  "Status unavailable",
);

assert.equal(memoryDraftState({ status: "proposal" }).readable, true);
for (const status of ["prepared", "conflict", "failed", undefined])
  assert.equal(memoryDraftState({ status }).readable, false);

const objectId = "00000000-0000-4000-8000-000000000001";
const revisionId = "00000000-0000-4000-8000-000000000002";
const source = {
  objectId,
  revisionId,
  sha256: "a".repeat(64),
  messageRange: {
    startMessage: 0,
    startOffset: 2,
    endMessage: 1,
    endOffset: 3,
  },
};
assert.deepEqual(cloudSourceReference(source), source);
assert.equal(
  cloudSourceReference({ ...source, revisionId: "https://untrusted.example" }),
  null,
);
assert.equal(cloudSourceReference({ ...source, sha256: "invalid" }), null);
assert.equal(
  cloudSourceReference({
    ...source,
    messageRange: {
      startMessage: 2,
      startOffset: 0,
      endMessage: 1,
      endOffset: 0,
    },
  }),
  null,
);
assert.equal(
  cloudSourceReference({
    ...source,
    messageRange: {
      startMessage: 0,
      startOffset: -1,
      endMessage: 1,
      endOffset: 0,
    },
  }),
  null,
);
assert.equal(cloudSourceReference({ ...source, messageRange: null }), null);
const messages = [
  { role: "user", text: "😀first" },
  { role: "assistant", text: "second" },
];
assert.deepEqual(
  sourceMessageExcerpt(messages, source.messageRange).map(
    (message) => message.text,
  ),
  ["first", "sec"],
);
assert.equal(
  sourceRangeLabel({
    startMessage: 0,
    startOffset: 0,
    endMessage: 2,
    endOffset: 0,
  }),
  "Messages 1–2 · complete text",
);
assert.equal(
  sourceMessageExcerpt(messages, {
    startMessage: 0,
    startOffset: 0,
    endMessage: 3,
    endOffset: 0,
  }),
  null,
);
assert.equal(
  sourceMessageExcerpt(messages, {
    startMessage: 0,
    startOffset: 50,
    endMessage: 1,
    endOffset: 0,
  }),
  null,
);

// Canonical production rows use id; the older fixture's deviceId remains readable.
assert.equal(cloudDeviceId({ id: objectId }), objectId);
assert.equal(cloudDeviceId({ deviceId: objectId }), objectId);
assert.equal(cloudDeviceId({ id: "invalid", deviceId: objectId }), null);
console.log(
  "Cloud state checks passed: plan/freshness gates, UTF-8 and escaped context bounds, link states, draft states, exact source ranges and canonical device identity. Local helper evidence only.",
);
