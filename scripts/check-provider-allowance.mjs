import assert from "node:assert/strict";
import { providerAllowance } from "../packages/ui/src/provider-allowance.ts";
import {
  createInitialWorkbenchState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

const now = Date.parse("2026-10-09T12:00:00Z");
const future = "2026-10-09T14:00:00Z";
const reading = (windows, extra = {}) => ({
  providerId: "openai",
  status: "available",
  windows,
  ...extra,
});
const window = (id, usedPercent, extra = {}) => ({
  id,
  label: id,
  usedPercent,
  resetsAt: future,
  ...extra,
});
const limited = providerAllowance(
  reading([window("5-hour", 32), window("Weekly", 98)]),
  now,
);
assert.equal(
  limited.remaining,
  2,
  "The weekly limit must win when it will stop work first",
);
assert.equal(limited.severity, "critical");
assert.match(limited.detail, /5-hour.*68% left/);
assert.match(limited.detail, /Weekly.*2% left/);
assert.equal(
  providerAllowance(reading([window("5-hour", undefined)]), now).remaining,
  undefined,
  "A reset time alone is not a measured allowance",
);
assert.equal(
  providerAllowance(
    reading([window("5-hour", undefined, { status: "exhausted" })]),
    now,
  ).remaining,
  0,
);
assert.equal(
  providerAllowance(
    reading([
      window("Old", 100, { resetsAt: "2026-10-09T11:00:00Z" }),
      window("Weekly", 32),
    ]),
    now,
  ).remaining,
  68,
  "Expired windows cannot keep an account looking exhausted",
);
assert.equal(
  providerAllowance(
    reading([window("Old", 32, { resetsAt: "2026-10-09T11:00:00Z" })]),
    now,
  ).label,
  "Awaiting reset",
);
assert.equal(
  providerAllowance(reading([window("Bad", NaN)]), now).remaining,
  undefined,
);
assert.equal(
  providerAllowance(reading([window("Bad", Infinity)]), now).remaining,
  undefined,
);
assert.equal(
  providerAllowance(reading([window("Over", 130)]), now).remaining,
  0,
);
assert.equal(
  providerAllowance(reading([window("Under", -10)]), now).remaining,
  100,
);
assert.equal(
  providerAllowance(reading([window("Near limit", 99.9)]), now).label,
  "<1% left",
);
assert.equal(
  providerAllowance(reading([window("Cached", 32)], { stale: true }), now)
    .stale,
  true,
);
assert.match(
  providerAllowance(reading([window("Cached", 32)], { status: "error" }), now)
    .detail,
  /Last reported/,
);
assert.equal(providerAllowance(undefined, now).label, "Usage unavailable");
assert.equal(
  providerAllowance(reading([], { status: "loading" }), now).label,
  "Loading usage",
);
const state = createInitialWorkbenchState();
const routed = workbenchReducer(state, {
  type: "select-destination",
  destination: "providers",
});
assert.equal(routed.activeDestination, "settings");
assert.equal(routed.preferences.lastSettingsSection, "providers");
assert.equal(
  workbenchReducer(routed, {
    type: "select-destination",
    destination: "workspace",
  }).activeDestination,
  "workspace",
);
console.log("Provider allowance and legacy route checks passed.");
