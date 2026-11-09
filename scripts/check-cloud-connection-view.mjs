import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cloudBillingView,
  disconnectedCloudView,
  isV2CloudView,
} from "../apps/desktop/src/cloud-connection-view.ts";
const { snapshots } = JSON.parse(
  readFileSync(
    new URL(
      "../docs/contracts/fixtures/cloud-connection-mock.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
let checks = 0;
assert.equal(cloudBillingView(disconnectedCloudView).status, "unavailable");
checks++;
for (const [scene, status] of [
  ["pending", "checkout-pending"],
  ["active", "active"],
  ["cancelled", "cancellation-scheduled"],
  ["expired", "expired"],
]) {
  const view = cloudBillingView({
    state: "connected",
    lastVerified: snapshots[scene].verifiedAt,
    revocationPending: false,
    snapshot: snapshots[scene],
  });
  assert.equal(view.status, status);
  assert.equal(view.simulation, true);
  checks++;
}
const exhausted = structuredClone(snapshots.exhausted);
exhausted.subscription.state = "active";
assert.equal(
  cloudBillingView({ state: "connected", snapshot: exhausted }).status,
  "exhausted",
);
checks++;
// A cached active or funded snapshot must never make an offline/expired view active.
for (const [state, status] of [
  ["offline", "offline"],
  ["expired", "signed-out"],
  ["verifying", "checking"],
]) {
  const view = cloudBillingView({
    state,
    lastVerified: snapshots.active.verifiedAt,
    revocationPending: false,
    snapshot: snapshots.active,
  });
  assert.equal(view.status, status);
  assert.equal(view.fetchedAt, snapshots.active.verifiedAt);
  checks++;
}
const signedOut = cloudBillingView({
  state: "signed-out",
  snapshot: null,
  lastVerified: null,
  revocationPending: true,
});
assert.equal(signedOut.accountLabel, undefined);
assert.match(signedOut.error, /revocation is not confirmed/);
checks++;
// A failed old-session revocation can survive a later Restore. The warning
// must not claim that the newly connected account is signed out.
for (const state of ["connected", "offline", "verifying"]) {
  const restored = cloudBillingView({
    state,
    snapshot: snapshots.active,
    lastVerified: snapshots.active.verifiedAt,
    revocationPending: true,
  });
  assert.doesNotMatch(restored.error, /signed out locally/i);
  assert.match(restored.error, /earlier Cloud session/);
  assert.match(restored.error, /not confirmed/);
  checks++;
}
// Current native decisions, not historical wallets or plan labels, drive display.
const paused = structuredClone(snapshots.active);
paused.capabilities.managedAi = { allowed: false, reason: "service-paused" };
assert.equal(
  cloudBillingView({ state: "connected", snapshot: paused }).status,
  "active",
);
checks++;
console.log(
  `${checks} Cloud display-state checks passed; fixture evidence, not native UI acceptance.`,
);
// v2 exposes server percentage/storage state, never the old USD test wallet.
const production = {
  state: "connected",
  environment: "production",
  contractVersion: "2.0.0",
  lastVerified: "2026-11-02T12:00:00Z",
  revocationPending: false,
  snapshot: {
    account: {
      id: "00000000-0000-4000-8000-000000000001",
      emailVerified: true,
      status: "enabled",
    },
    subscription: {
      state: "active",
      planId: "premium",
      paidThrough: "2026-12-02T12:00:00Z",
    },
    capabilities: { managedAi: { allowed: true, reason: "entitled" } },
    limits: {
      devices: 5,
      storageBytes: 20000000000,
      historyDays: 90,
      activeLinks: 100,
      concurrentJobs: 2,
    },
    usage: {
      managedAi: {
        unit: "percent",
        used: 12,
        held: 3,
        remaining: 85,
        resetAt: "2026-12-02T12:00:00Z",
      },
      storage: { usedBytes: 1234, reservedBytes: 0, limitBytes: 20000000000 },
    },
  },
};
const current = cloudBillingView(production);
assert.equal(current.productionCloud, true);
assert.equal(current.simulation, false);
assert.equal(current.plan, "premium");
assert.equal(current.cloudUsage.managedAi.remaining, 85);
assert.equal(current.usage, undefined);
assert.deepEqual(current.cloudCapabilities.managedAi, {
  allowed: true,
  reason: "entitled",
});
assert.equal(current.accountLabel, "Signed in to Gyro Cloud");
assert.equal(current.cloudV2, true);
// The verified address names the account only while a snapshot is shown.
assert.equal(current.accountEmail, undefined);
const named = { ...production, accountEmail: "ada@example.com" };
assert.equal(cloudBillingView(named).accountEmail, "ada@example.com");
assert.equal(
  cloudBillingView({ ...named, state: "expired" }).accountEmail,
  undefined,
);
assert.equal(
  cloudBillingView({ ...named, contractVersion: undefined }).accountEmail,
  undefined,
);
const hostedStaging = structuredClone(production);
hostedStaging.environment = "staging";
hostedStaging.snapshot.capabilities.managedAi = {
  allowed: false,
  reason: "staging-ai-disabled",
};
const stageView = cloudBillingView(hostedStaging);
assert.equal(isV2CloudView(hostedStaging), true);
assert.equal(stageView.cloudV2, true);
assert.equal(stageView.productionCloud, false);
assert.equal(stageView.staging, true);
assert.equal(stageView.simulation, false);
assert.equal(stageView.cloudUsage.managedAi.remaining, 85);
assert.equal(stageView.usage, undefined);
assert.deepEqual(stageView.cloudCapabilities.managedAi, {
  allowed: false,
  reason: "staging-ai-disabled",
});
assert.equal(stageView.accountLabel, "Signed in to Gyro Cloud staging");
const legacyStaging = { ...hostedStaging, contractVersion: undefined };
assert.equal(isV2CloudView(legacyStaging), false);
assert.equal(cloudBillingView(legacyStaging).cloudV2, false);
assert.equal(cloudBillingView(legacyStaging).cloudUsage, undefined);
assert.equal(isV2CloudView({ ...hostedStaging, environment: "local" }), false);
production.snapshot.subscription.state = "disputed";
assert.equal(cloudBillingView(production).status, "disputed");
production.state = "offline";
assert.equal(cloudBillingView(production).status, "offline");
console.log(
  "9 production v2 percentage, provenance and stale-state assertions passed; display fixture evidence only.",
);
console.log(
  "15 hosted v2 staging classification/isolation assertions passed; no native, mail or hosted acceptance implied.",
);
