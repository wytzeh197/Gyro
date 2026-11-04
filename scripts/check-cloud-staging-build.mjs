import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stagingBuildPins } from "./cloud-staging-configuration.mjs";

const read = (name) =>
  JSON.parse(
    readFileSync(new URL(`../config/${name}`, import.meta.url), "utf8"),
  );
const current = read("cloud-staging.json");
const pending = read("cloud-production.json");
const pins = stagingBuildPins(current, pending);
assert.equal(Object.keys(pins).length, 4);
assert.ok(
  Object.keys(pins).every((key) => key.startsWith("GYRO_CLOUD_V2_STAGING_")),
);
assert.equal(pins.GYRO_CLOUD_V2_STAGING_AUTH_PROJECT, current.authProject);

const replacement = {
  ...current,
  authProject: "zyxwvutsrqponmlkjihg",
  authPublishableKey: "sb_publishable_replacement_fixture_only",
};
const isolated = {
  ...pending,
  environmentIsolationVerified: true,
  stagingAuthProject: replacement.authProject,
};
assert.equal(
  stagingBuildPins(replacement, isolated).GYRO_CLOUD_V2_STAGING_AUTH_PROJECT,
  replacement.authProject,
);
assert.throws(
  () => stagingBuildPins(current, isolated),
  /isolated replacement/,
);
assert.throws(
  () =>
    stagingBuildPins(replacement, {
      ...isolated,
      authProject: replacement.authProject,
    }),
  /production Auth/,
);
assert.throws(
  () =>
    stagingBuildPins(current, {
      ...pending,
      stagingAuthProject: replacement.authProject,
    }),
  /isolated replacement/,
);
assert.throws(() =>
  stagingBuildPins(current, {
    ...pending,
    environmentIsolationVerified: "true",
  }),
);

for (const change of [
  { environment: "production" },
  { authProject: "short" },
  { authPublishableKey: "sb_secret_fixture_must_never_ship" },
  { accessToken: "fixture-only" },
  { apiOrigin: pending.apiOrigin },
  { shareOrigin: pending.apiOrigin },
  { apiOrigin: current.shareOrigin },
  ...[
    "http://localhost",
    "https://127.0.0.1",
    "https://api.invalid",
    "https://test.localhost",
    "https://test.local",
    "https://staging.example.com/path",
    "https://staging.example.com?token=fixture",
    "https://user:password@staging.example.com",
    "https://staging.example.com:8443",
  ].map((apiOrigin) => ({ apiOrigin })),
])
  assert.throws(() => stagingBuildPins({ ...current, ...change }, pending));

console.log(
  "Staging build pins passed: consistent public inputs, cutover isolation and production-origin/secret rejection.",
);
