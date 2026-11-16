import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateV3Result,
  verifiedV3Client,
  signOutAndRefresh,
  SETTINGS_CONTRACT,
  SETTINGS_POLICY,
} from "../apps/desktop/src/cloud-v3-client.ts";
const command = (operation) => ({
  operation: "service",
  command: { operation },
});
const wallet = {
  currency: "USD",
  includedMicros: 5e6,
  availableMicros: 4e6,
  spentMicros: 8e5,
  heldMicros: 2e5,
  qualified: false,
  usable: false,
  checkAllowed: false,
  topUpsAvailable: false,
  model: "gpt-6-luna",
  resetAt: null,
};
test("catalog validates all three server offers and accepts a zero Cloud AI pool", () => {
  const c = JSON.parse(
    readFileSync(
      new URL("../docs/contracts/gyro-cloud-v3.json", import.meta.url),
    ),
  );
  const value = {
    policyVersion: c.policyVersion,
    plans: c.plans,
    proposed: true,
  };
  assert.equal(validateV3Result(command("policy"), value), value);
  assert.deepEqual(
    Object.values(value.plans).map((p) => p.aiMicros),
    [0, 5e6, 15e6],
  );
  for (const patch of [
    { priceMinor: 19.5 },
    { currency: "EUR" },
    { aiMicros: -1 },
    { operationsPerPeriod: 0 },
    { taxAdded: false },
  ]) {
    assert.throws(() =>
      validateV3Result(command("policy"), {
        ...value,
        plans: { ...value.plans, cloud: { ...value.plans.cloud, ...patch } },
      }),
    );
  }
  assert.throws(() =>
    validateV3Result(command("policy"), { ...value, policyVersion: "unknown" }),
  );
  assert.equal(
    validateV3Result(command("wallet"), {
      ...wallet,
      includedMicros: 0,
      availableMicros: 0,
      spentMicros: 0,
      heldMicros: 0,
    }).includedMicros,
    0,
  );
});
test("settings use the same contract and policy as the native service", () => {
  const contract = JSON.parse(
    readFileSync(
      new URL("../docs/contracts/gyro-cloud-v3.json", import.meta.url),
    ),
  );
  assert.equal(SETTINGS_CONTRACT, contract.contractVersion);
  assert.equal(SETTINGS_POLICY, contract.policyVersion);
});
test("wallet keeps explicit included USD microunits and rejects ambiguous or malformed money", () => {
  assert.equal(validateV3Result(command("wallet"), wallet).includedMicros, 5e6);
  for (const patch of [
    { currency: "EUR" },
    { includedMicros: undefined },
    { availableMicros: 5e6 },
    { spentMicros: -1 },
    { heldMicros: 0.5 },
    { includedMicros: Number.MAX_SAFE_INTEGER + 1 },
    { topUpsAvailable: true },
  ])
    assert.throws(() =>
      validateV3Result(command("wallet"), { ...wallet, ...patch }),
    );
});
test("malformed status and foreign contract versions cannot reach the page", async () => {
  const view = {
    configured: false,
    connected: false,
    accountId: null,
    contractVersion: SETTINGS_CONTRACT,
    policyVersion: SETTINGS_POLICY,
  };
  assert.equal(validateV3Result({ operation: "view" }, view), view);
  assert.throws(() =>
    validateV3Result(
      { operation: "view" },
      { ...view, contractVersion: "2.0.0" },
    ),
  );
  await assert.rejects(
    verifiedV3Client(async () => ({ items: null, nextCursor: null }))(
      command("versions"),
    ),
    /unsupported response/,
  );
  assert.throws(() =>
    validateV3Result(command("devices"), {
      items: [
        {
          id: "other-account-path",
          label: "Mac",
          lastSeenAt: null,
          revokedAt: null,
        },
      ],
    }),
  );
});
test("sign-out refreshes native truth and navigation even if remote logout fails", async () => {
  let localConnected = true;
  const calls = [];
  await assert.rejects(
    signOutAndRefresh(
      async () => {
        localConnected = false;
        calls.push("sign-out");
        throw new Error("remote unavailable");
      },
      async () => {
        calls.push("refresh");
        assert.equal(localConnected, false);
      },
      () => calls.push("notify"),
    ),
    /could not be fully confirmed/,
  );
  assert.deepEqual(calls, ["sign-out", "notify", "refresh"]);
});
test("successful sign-out refreshes once without swallowing a refresh failure", async () => {
  const calls = [];
  await signOutAndRefresh(
    async (r) => {
      calls.push(r.operation);
      return {};
    },
    async () => {
      calls.push("refresh");
    },
    () => calls.push("notify"),
  );
  assert.deepEqual(calls, ["sign-out", "notify", "refresh"]);
  await assert.rejects(
    signOutAndRefresh(
      async () => ({}),
      async () => {
        throw new Error("status unavailable");
      },
      () => {},
    ),
    /status unavailable/,
  );
});
test(
  "actual PostgreSQL/API settings responses pass the app's production decoder",
  {
    skip:
      !process.env.GYRO_SETTINGS_WIRE_RECEIPT &&
      "Run with the local backend wire receipt",
  },
  () => {
    const receipt = JSON.parse(
      readFileSync(process.env.GYRO_SETTINGS_WIRE_RECEIPT),
    );
    assert.equal(receipt.evidence, "real-local-postgresql-production-api");
    assert.ok(receipt.responses.length >= 10);
    for (const { request, result } of receipt.responses)
      validateV3Result(request, result);
  },
);
