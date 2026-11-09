import assert from "node:assert/strict";
import { isProviderQuotaError, providerQuotaNotice, PROVIDER_QUOTA_RECOVERY } from "../packages/ui/src/provider-quota.ts";
import { buildRunModel } from "../packages/ui/src/chat-run.ts";
import { eligibleChatAutoRetryFailure } from "../apps/desktop/src/chat-auto-retry.ts";

const event = (id, status, error, providerId = "openai", recoveryKind = "retry") => ({
  id, sessionId: "quota-fixture", turnId: "turn", kind: "system-event",
  createdAt: `2026-11-08T14:44:${id.padStart(2, "0")}Z`, message: "",
  payload: { kind: "provider-status", providerId, status, error, recoveryKind,
    recoveryMessage: "Retry the message. Gyro will preserve the conversation context." },
});
const quota = event("01", "failed", "Quota exceeded. Check your plan and billing details.");
const user = { ...quota, id: "user", kind: "user-message", message: "Continue", payload: {} };
for (const message of [quota.payload.error, "usage_limit_exceeded", 'Request rejected [Codex error: "usageLimitExceeded"]']) {
  assert.equal(isProviderQuotaError(message), true);
  const failed = { ...quota, payload: { ...quota.payload, error: message } };
  const model = buildRunModel([failed], { status: { status: "failed", ...failed.payload } });
  assert.equal(model.phase.name, "failed");
  assert.equal(model.phase.recoveryKind, "quota-exceeded", "saved generic retry failures are corrected on read");
  assert.equal(model.phase.recoveryMessage, PROVIDER_QUOTA_RECOVERY);
  assert.equal(eligibleChatAutoRetryFailure([user, failed]), undefined);
  assert.equal(eligibleChatAutoRetryFailure([user, { ...failed, payload: { ...failed.payload, error: `${message}; HTTP 503` } }]), undefined);
}
assert.equal(isProviderQuotaError("HTTP 429: too many requests"), false);
assert.equal(isProviderQuotaError("Context window exceeded"), false);
assert.match(providerQuotaNotice([quota], "openai"), /plan windows may not include/);
assert.equal(providerQuotaNotice([quota], "anthropic"), undefined);
assert.equal(providerQuotaNotice([quota], undefined), undefined);
for (const status of ["running", "completed", "cancelled"]) {
  const later = event("02", status);
  assert.equal(providerQuotaNotice([quota, later], "openai"), undefined);
  assert.equal(providerQuotaNotice([later, quota], "openai"), undefined, "timestamps outrank array order");
}
assert.match(providerQuotaNotice([quota, event("02", "completed", undefined, "anthropic")], "openai"), /provider quota/);
assert.equal(providerQuotaNotice([quota, event("02", "failed", "Network disconnected")], "openai"), undefined);
assert.equal(eligibleChatAutoRetryFailure([user, event("02", "failed", "HTTP 503", "openai", "quota-exceeded")]), undefined);
assert.ok(eligibleChatAutoRetryFailure([user, event("02", "failed", "HTTP 503")]), "ordinary server errors remain eligible");
console.log("Provider quota recovery: saved failures, structured codes, provider isolation, and notice lifecycle passed.");
