import assert from "node:assert/strict";

import {
  COUNCIL_COMING_SOON,
  defaultCouncilConfig,
  normalizedCouncilConfig,
} from "../packages/ui/src/council.ts";

// Council is built but not released. These checks assert the freeze holds at
// the config layer, which is what every entry point reads before it can start a
// run. They test behavior rather than matching source text, so refactoring the
// surfaces cannot make them pass or fail for the wrong reason.

if (COUNCIL_COMING_SOON) {
  // A fresh install has no reachable council run.
  assert.equal(
    defaultCouncilConfig().enabled,
    false,
    "a frozen Council must default to disabled",
  );

  // The freeze outranks persisted config. An install that turned Council on
  // before it was frozen must not stay on after upgrading.
  assert.equal(
    normalizedCouncilConfig({ enabled: true }).enabled,
    false,
    "a persisted enabled:true must not survive the freeze",
  );

  // Absent and explicitly disabled configs agree with the freeze.
  assert.equal(normalizedCouncilConfig(undefined).enabled, false);
  assert.equal(normalizedCouncilConfig({ enabled: false }).enabled, false);

  // Freezing must not discard the presets, so unfreezing restores the feature
  // rather than rebuilding it.
  assert.ok(
    defaultCouncilConfig().presets.length > 0,
    "the freeze should preserve presets",
  );
} else {
  // Unfrozen, Council honors what the user configured.
  assert.equal(normalizedCouncilConfig({ enabled: true }).enabled, true);
  assert.equal(normalizedCouncilConfig({ enabled: false }).enabled, false);
  assert.equal(
    normalizedCouncilConfig(undefined).enabled,
    true,
    "an unfrozen Council defaults to enabled",
  );
}

console.log(
  `council freeze checks passed (frozen: ${String(COUNCIL_COMING_SOON)})`,
);
