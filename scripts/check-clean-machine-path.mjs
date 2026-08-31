#!/usr/bin/env node
/**
 * Clean-machine activation path checks.
 *
 * Encodes ROADMAP launch blocker 3 / v0.2 provider-setup gates that can be
 * proven without an authenticated provider CLI:
 *   project required → provider required → send unlocked
 * plus mutation recovery and doctor remediation contracts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  preferredCleanMachineConnectProvider,
  resolveCleanMachinePath,
} from "../packages/ui/src/clean-machine-path.ts";
import { canSendChat } from "../packages/ui/src/workbench-state.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- Path state machine ----------------------------------------------------

const noProject = resolveCleanMachinePath({
  hasReadyProvider: false,
  workspacePath: undefined,
});
assert.equal(noProject.canSend, false);
assert.equal(noProject.hasProject, false);
assert.equal(noProject.steps[0]?.status, "active");
assert.equal(noProject.steps[0]?.action, "select-workspace");
assert.equal(noProject.nextAction, "select-workspace");
assert.match(noProject.readinessLabel, /project/i);
assert.match(noProject.placeholder, /project/i);

// Session-style auto workspaces must not count as a user project.
const autoWorkspace = resolveCleanMachinePath({
  hasReadyProvider: true,
  workspacePath: "/tmp/gyro-session-1783969000000",
});
assert.equal(autoWorkspace.canSend, false);
assert.equal(autoWorkspace.hasProject, false);
assert.equal(canSendChat(true, "/tmp/gyro-session-1783969000000"), false);

const projectOnly = resolveCleanMachinePath({
  hasReadyProvider: false,
  preferredProviderId: "openai",
  preferredProviderLabel: "OpenAI",
  workspacePath: "/Users/example/Project",
});
assert.equal(projectOnly.canSend, false);
assert.equal(projectOnly.hasProject, true);
assert.equal(projectOnly.steps[0]?.status, "done");
assert.equal(projectOnly.steps[1]?.status, "active");
assert.equal(projectOnly.steps[1]?.action, "connect-provider:openai");
assert.equal(projectOnly.nextAction, "connect-provider:openai");
assert.match(projectOnly.readinessLabel, /provider|Connect/i);

const blockedHealth = resolveCleanMachinePath({
  hasReadyProvider: false,
  preferredProviderId: "anthropic",
  preferredProviderLabel: "Anthropic",
  providerBlockMessage: "Claude Code is installed but not logged in.",
  workspacePath: "/Users/example/Project",
});
assert.equal(blockedHealth.canSend, false);
assert.match(blockedHealth.readinessLabel, /not logged in/i);
assert.equal(blockedHealth.nextAction, "connect-provider:anthropic");

const ready = resolveCleanMachinePath({
  hasReadyProvider: true,
  workspacePath: "/Users/example/Project",
});
assert.equal(ready.canSend, true);
assert.equal(
  ready.steps.every((step) => step.status === "done"),
  true,
);
assert.equal(ready.nextAction, undefined);
assert.equal(ready.readinessTone, "ready");
assert.equal(canSendChat(true, "/Users/example/Project"), true);

// Preferred connect order: Codex, then Claude, then first executable.
assert.deepEqual(
  preferredCleanMachineConnectProvider([
    { id: "kimi", label: "Kimi", executable: true },
    { id: "anthropic", label: "Anthropic", executable: true },
    { id: "openai", label: "OpenAI", executable: true },
  ]),
  { id: "openai", label: "OpenAI" },
);
assert.deepEqual(
  preferredCleanMachineConnectProvider([
    { id: "kimi", label: "Kimi", executable: true },
    { id: "anthropic", label: "Anthropic", executable: true },
  ]),
  { id: "anthropic", label: "Anthropic" },
);

// --- UI wiring: empty chat and composer expose real actions ----------------

const surfaces = readFileSync(
  resolve(root, "packages/ui/src/surfaces.tsx"),
  "utf8",
);
assert.match(
  surfaces,
  /connect-provider:\$\{provider\.id\}/,
  "disconnected providers must offer connect-provider, not a dead Unavailable row",
);
assert.doesNotMatch(
  surfaces,
  /gyro-composer-readiness|gyro-clean-machine-step/,
  "the composer readiness strip and activation checklist are retired chrome",
);
assert.match(
  surfaces,
  /resolveCleanMachinePath/,
  "composer blocked state must share the path helper",
);

// Desktop must still route connect-provider and select-workspace.
const app = readFileSync(resolve(root, "apps/desktop/src/App.tsx"), "utf8");
assert.match(app, /connect-provider:/);
assert.match(app, /case "select-workspace"/);

// --- Core contracts still present for the trusted first edit ---------------

const mutations = readFileSync(
  resolve(root, "crates/gyro-core/src/mutations.rs"),
  "utf8",
);
assert.match(mutations, /recover_provider_mutation_transactions/);
assert.match(mutations, /PROVIDER_MUTATION_JOURNAL_SCHEMA/);
assert.match(
  mutations,
  /begin_provider_mutation_transaction|apply_provider_mutation_transaction/,
);

const doctor = readFileSync(
  resolve(root, "crates/gyro-core/src/doctor.rs"),
  "utf8",
);
assert.match(doctor, /required:\s*true/);
assert.match(doctor, /next:/);

const cli = readFileSync(resolve(root, "crates/gyro-cli/src/main.rs"), "utf8");
assert.match(cli, /fn setup_command/);
assert.match(cli, /doctor/);

console.log("check-clean-machine-path: ok");
