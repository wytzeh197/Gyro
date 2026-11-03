// Public contract verification. Optional private-export comparison is explicit;
// ordinary public builds and these shape checks need no private checkout.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
const file = new URL(
  "../docs/contracts/gyro-cloud-v2.openapi.json",
  import.meta.url,
);
const contract = JSON.parse(readFileSync(file, "utf8"));
if (
  process.argv[2] &&
  !isDeepStrictEqual(
    contract,
    JSON.parse(readFileSync(process.argv[2], "utf8")),
  )
)
  throw new Error("Public contract differs from the generated backend export");
const required = {
  "/v2/account": "get",
  "/v2/accounts": "post",
  "/v2/devices": "post",
  "/v2/sessions/revoke": "post",
  "/v2/billing/checkout": "post",
  "/v2/billing/portal": "post",
  "/v2/sync/changes": "get",
  "/v2/sync/uploads": "post",
  "/v2/sync/uploads/{uploadId}/chunks/{index}": "put",
  "/v2/sync/uploads/{uploadId}/commit": "post",
  "/v2/sync/objects/{objectId}/versions": "get",
  "/v2/sync/objects/{objectId}/restore": "post",
  "/v2/shares": "post",
  "/v2/ai/jobs": "post",
  "/v2/ai/jobs/by-key": "get",
  "/v2/memory/{projectId}": "put",
  "/v2/memory/{projectId}/extract": "post",
  "/v2/memory/{projectId}/proposals/{extractionId}": "post",
  "/v2/account/export": "get",
  "/v2/account/export/objects/{objectId}": "get",
  "/v2/account/export/objects/{objectId}/chunks/{index}": "get",
  "/v2/account/export/memory/{entryId}": "get",
  "/v2/account/deletion": "post",
};
for (const [path, method] of Object.entries(required))
  assert.ok(
    contract.paths[path]?.[method],
    `Missing ${method.toUpperCase()} ${path}`,
  );
const snapshot = contract.components.schemas.AccountSnapshot;
assert.ok(snapshot.properties.environment.enum.includes("production"));
assert.ok(snapshot.properties.environment.enum.includes("staging"));
assert.equal(snapshot.additionalProperties, false);
assert.equal(
  snapshot.properties.usage.properties.managedAi.properties.unit.const,
  "percent",
);
assert.deepEqual(
  snapshot.required.slice().sort(),
  [
    "contractVersion",
    "environment",
    "verifiedAt",
    "expiresAt",
    "account",
    "session",
    "subscription",
    "capabilities",
    "limits",
    "usage",
  ].sort(),
);
const checkout =
  contract.paths["/v2/billing/checkout"].post.requestBody.content[
    "application/json"
  ].schema;
assert.equal(checkout.additionalProperties, false);
assert.deepEqual(Object.keys(checkout.properties).sort(), [
  "planId",
  "requestId",
]);
const text = JSON.stringify(snapshot);
for (const secret of [
  "accessToken",
  "refreshToken",
  "providerKey",
  "providerCostCap",
  "grantedMicros",
])
  assert.ok(!text.includes(secret), `Public snapshot exposes ${secret}`);
console.log(
  `${Object.keys(required).length} public v2 route contracts and snapshot/billing boundaries passed${process.argv[2] ? "; generated backend export matches" : ""}. Schema evidence, not hosted acceptance.`,
);
