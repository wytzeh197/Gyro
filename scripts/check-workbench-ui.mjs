#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createInitialWorkbenchState,
  createTerminalPane,
  defaultCommandProfiles,
  parseProviderHealthOutput,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function expect(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function readRepoFile(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

const appSource = readRepoFile("apps/desktop/src/App.tsx");
const surfaceSource = readRepoFile("packages/ui/src/surfaces.tsx");
const styleSource = readRepoFile("packages/ui/src/styles.css");
const typeSource = readRepoFile("packages/ui/src/types.ts");
const reducerSource = readRepoFile("packages/ui/src/workbench-state.ts");
const tauriSource = readRepoFile("apps/desktop/src-tauri/src/lib.rs");

const profiles = defaultCommandProfiles();
const codexProfile = profiles.find((profile) => profile.id === "codex");
expect(Boolean(codexProfile), "Default Codex command profile is missing.");

const initialState = createInitialWorkbenchState();
expect(
  initialState.terminalPanes.length === 0,
  "Initial workbench state should start without demo terminal panes.",
);
expect(
  initialState.tasks.length === 0,
  "Initial workbench state should start without demo task board data.",
);
expect(
  initialState.automations.length === 0,
  "Initial workbench state should start without demo automations.",
);
expect(
  initialState.diffReview.files.length === 0,
  "Initial workbench state should start without demo diff review files.",
);
expect(
  initialState.providerStatuses.length >= 6,
  "Initial workbench state should include provider statuses.",
);
expect(
  initialState.browserPreview.status === "idle",
  "Initial browser preview should start idle.",
);
expect(
  initialState.providerStatuses.find((provider) => provider.id === "openai")
    ?.connectionStatus === "not-configured",
  "OpenAI provider should not look connected by default.",
);
expect(
  initialState.providerReadiness.status === "idle",
  "Provider readiness should start idle.",
);
expect(
  initialState.preferences.sidebarChatsCollapsed === false,
  "Sidebar chats should start expanded.",
);
expect(
  initialState.preferences.chatEnvironmentRailOpen === false,
  "Chat environment rail should start closed.",
);

let state = workbenchReducer(initialState, {
  type: "set-theme",
  theme: "light",
});
state = workbenchReducer(state, {
  type: "set-density",
  density: "comfortable",
});
state = workbenchReducer(state, {
  type: "record-command",
  commandId: "new-terminal",
});
expect(state.preferences.theme === "light", "Theme reducer did not update.");
expect(
  state.preferences.density === "comfortable",
  "Density reducer did not update.",
);
expect(
  state.preferences.commandPaletteRecents[0] === "new-terminal",
  "Command palette recents did not record the latest command.",
);
state = workbenchReducer(state, {
  type: "set-provider-readiness",
  status: "blocked",
  message: "OpenAI / Codex is not connected yet",
  providerId: "openai",
});
expect(
  state.providerReadiness.status === "blocked" &&
    state.providerReadiness.providerId === "openai",
  "Provider readiness reducer did not record blocked state.",
);
state = workbenchReducer(state, { type: "toggle-sidebar-chats" });
expect(
  state.preferences.sidebarChatsCollapsed === true,
  "Sidebar chats disclosure did not collapse.",
);
state = workbenchReducer(state, { type: "toggle-sidebar-chats" });
expect(
  state.preferences.sidebarChatsCollapsed === false,
  "Sidebar chats disclosure did not expand.",
);
state = workbenchReducer(state, { type: "toggle-chat-environment-rail" });
expect(
  state.preferences.chatEnvironmentRailOpen === true,
  "Chat environment rail did not open.",
);
state = workbenchReducer(state, {
  type: "set-chat-environment-rail",
  open: false,
});
expect(
  state.preferences.chatEnvironmentRailOpen === false,
  "Chat environment rail did not close.",
);

if (codexProfile) {
  const pane = createTerminalPane("pane-smoke", codexProfile, "restored");
  state = workbenchReducer(state, { type: "add-terminal-pane", pane });
  state = workbenchReducer(state, {
    type: "run-terminal-pane",
    paneId: pane.id,
    profileId: codexProfile.id,
    command: "codex --help",
    output: "waiting for approval",
  });
  state = workbenchReducer(state, {
    type: "set-terminal-pane-status",
    paneId: pane.id,
    status: "failed",
    event: "killed",
  });
  state = workbenchReducer(state, {
    type: "sync-terminal-pane-snapshot",
    paneId: pane.id,
    status: "done",
    event: "done (0)",
    command: "codex --help",
    output: "terminal output captured",
  });
  const updatedPane = state.terminalPanes.find((item) => item.id === pane.id);
  expect(
    updatedPane?.status === "done" &&
      updatedPane?.output === "terminal output captured",
    "Terminal pane lifecycle failed.",
  );
  const destinationBeforeRestore = state.activeDestination;
  state = workbenchReducer(state, {
    type: "upsert-restored-terminal-pane",
    pane: createTerminalPane("pane-restored", codexProfile, "running"),
  });
  expect(
    state.terminalPanes.some((item) => item.id === "pane-restored") &&
      state.activeDestination === destinationBeforeRestore,
    "Restored terminal panes should sync without forcing CLI navigation.",
  );
}

state = workbenchReducer(state, {
  type: "sync-diff-event",
  path: "packages/ui/src/workbench-state.ts",
  message: "file-edit-proposed smoke",
  source: "agent-generated",
});
state = workbenchReducer(state, {
  type: "sync-diff-event",
  path: "apps/desktop/src/App.tsx",
  message: "second file-edit-proposed smoke",
  source: "agent-generated",
});
state = workbenchReducer(state, {
  type: "toggle-diff-directory",
  directory: "packages",
});
expect(
  state.diffReview.collapsedDirectories.includes("packages"),
  "Diff review tree directory did not collapse.",
);
state = workbenchReducer(state, {
  type: "select-diff-file",
  path: "packages/ui/src/workbench-state.ts",
});
expect(
  !state.diffReview.collapsedDirectories.includes("packages"),
  "Selecting a diff file should expand collapsed parent directories.",
);
state = workbenchReducer(state, {
  type: "set-diff-file-state",
  path: state.diffReview.selectedPath,
  state: "accepted",
  action: "accepted in smoke",
});
expect(
  state.diffReview.files.find(
    (file) => file.path === state.diffReview.selectedPath,
  )?.state === "accepted",
  "Diff file accept transition failed.",
);
state = workbenchReducer(state, {
  type: "undo-diff-action",
  action: "reset in smoke",
});
expect(
  state.diffReview.approvalState === "pending",
  "Diff undo transition failed.",
);
expect(
  state.diffReview.selectedPath === "packages/ui/src/workbench-state.ts",
  "Session event did not sync into diff review.",
);
expect(
  state.diffReview.gitActions.find((action) => action.id === "commit")
    ?.status === "blocked",
  "Git commit action should stay blocked before approval.",
);
state = workbenchReducer(state, {
  type: "run-git-review-action",
  actionId: "create-branch",
});
expect(
  state.diffReview.gitActions.find((action) => action.id === "create-branch")
    ?.status === "done",
  "Git create-branch action did not complete locally.",
);
state = workbenchReducer(state, {
  type: "set-diff-review-state",
  state: "approved",
  action: "approved in smoke",
});
expect(
  state.diffReview.gitActions.find((action) => action.id === "commit")
    ?.status === "ready",
  "Git commit action should become ready after branch and approval.",
);
state = workbenchReducer(state, {
  type: "run-git-review-action",
  actionId: "commit",
});
expect(
  state.diffReview.gitActions.find((action) => action.id === "push")?.status ===
    "ready",
  "Git push action should become ready after commit.",
);
state = workbenchReducer(state, {
  type: "run-git-review-action",
  actionId: "push",
});
expect(
  state.diffReview.gitActions.find((action) => action.id === "open-pr")
    ?.status === "ready",
  "Git PR action should become ready after push.",
);

state = workbenchReducer(state, {
  type: "browser-navigate",
  url: "http://localhost:1421",
});
state = workbenchReducer(state, { type: "browser-device", device: "mobile" });
state = workbenchReducer(state, { type: "browser-screenshot" });
expect(
  state.browserPreview.device === "mobile" &&
    state.browserPreview.screenshotCount > 0,
  "Browser preview transitions failed.",
);

state = workbenchReducer(state, {
  type: "set-provider-status",
  providerId: "openai",
  status: "checking",
});
const parsedConnectedProvider = parseProviderHealthOutput(
  "openai",
  "codex auth status: authenticated; model probe ok",
);
expect(
  parsedConnectedProvider.connectionStatus === "connected",
  "Provider health parser should accept authenticated output.",
);
const parsedMissingProvider = parseProviderHealthOutput(
  "anthropic",
  "claude auth status: not authenticated",
);
expect(
  parsedMissingProvider.connectionStatus === "not-configured",
  "Provider health parser should prioritize missing auth over auth keywords.",
);
state = workbenchReducer(state, {
  type: "record-provider-health",
  providerId: "openai",
  status: parsedConnectedProvider.connectionStatus,
  summary: parsedConnectedProvider.healthSummary,
  output: "codex auth status: authenticated; model probe ok",
});
state = workbenchReducer(state, {
  type: "set-provider-model",
  providerId: "openai",
  model: "Smoke Model",
});
expect(
  state.providerStatuses.find((provider) => provider.id === "openai")
    ?.defaultModel === "Smoke Model",
  "Provider model transition failed.",
);
expect(
  state.providerStatuses.find((provider) => provider.id === "openai")
    ?.healthSummary === parsedConnectedProvider.healthSummary,
  "Provider health reducer did not store the parsed summary.",
);
state = workbenchReducer(state, {
  type: "queue-provider-handoff",
  handoff: {
    id: "handoff-smoke",
    fromProviderId: "openai",
    fromLabel: "OpenAI / Codex",
    toProviderId: "anthropic",
    toLabel: "Anthropic / Claude Code",
    status: "queued",
    sessionTitle: "Smoke session",
    contextSummary: "Carry current thread context.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  session: {
    id: "provider-session-smoke",
    providerId: "anthropic",
    displayName: "Anthropic / Claude Code",
    status: "queued",
    model: "Claude Sonnet",
    sessionTitle: "Smoke session",
    workspaceMode: "local",
    branch: "main",
    lastEvent: "handoff queued from OpenAI / Codex",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
});
expect(
  state.providerHandoffs[0]?.id === "handoff-smoke" &&
    state.providerSessions[0]?.id === "provider-session-smoke",
  "Provider handoff transition failed.",
);

state = workbenchReducer(state, {
  type: "complete-onboarding-step",
  step: "welcome",
});
expect(
  state.onboarding.completedSteps.includes("welcome"),
  "Onboarding completion transition failed.",
);

state = workbenchReducer(state, {
  type: "create-automation",
  automation: {
    id: "automation-smoke",
    title: "Smoke automation",
    prompt: "Run the workbench smoke check.",
    schedule: "manual",
    status: "current",
    triageState: "none",
    project: "Gyro",
    provider: "Codex",
    branch: "main",
    workspaceMode: "local",
    lastResult: "not run",
    unreadResults: 0,
    runHistory: [],
  },
});
state = workbenchReducer(state, {
  type: "run-automation",
  automationId: "automation-smoke",
  summary: "smoke automation passed",
});
state = workbenchReducer(state, {
  type: "set-automation-status",
  automationId: "automation-smoke",
  status: "paused",
});
state = workbenchReducer(state, {
  type: "triage-automation",
  automationId: "automation-smoke",
  triageState: "archived",
});
const smokeAutomation = state.automations.find(
  (automation) => automation.id === "automation-smoke",
);
expect(
  smokeAutomation?.status === "paused" &&
    smokeAutomation?.triageState === "archived" &&
    smokeAutomation?.runHistory.length === 1,
  "Automation lifecycle transitions failed.",
);

state = workbenchReducer(state, {
  type: "reconcile-active-turn",
  turn: {
    id: "turn-current",
    sessionId: "session-smoke",
    sessionTitle: "Smoke session",
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEvent: "running",
    changedFiles: 0,
    approvalsPending: 0,
  },
});
state = workbenchReducer(state, {
  type: "sync-diff-event",
  path: "stale.ts",
  message: "stale turn edit",
  turnId: "turn-old",
});
expect(
  !state.diffReview.files.some((file) => file.path === "stale.ts"),
  "Stale turn diff event should not update live diff review.",
);
state = workbenchReducer(state, {
  type: "sync-diff-event",
  path: "current.ts",
  message: "current turn edit",
  turnId: "turn-current",
});
expect(
  state.diffReview.activeTurnId === "turn-current" &&
    state.diffReview.files.some((file) => file.path === "current.ts"),
  "Active turn diff event transition failed.",
);
state = workbenchReducer(state, {
  type: "reconcile-active-turn-timeout",
  idleMs: 1,
  now: new Date(Date.now() + 1000).toISOString(),
});
expect(
  state.activeTurn?.status === "failed" &&
    state.activeTurn?.lastEvent === "Idle watchdog marked turn stale",
  "Active turn idle watchdog transition failed.",
);

for (const typeName of [
  "WorkbenchState",
  "WorkbenchTurn",
  "Automation",
  "TerminalPane",
  "DiffReview",
  "BrowserPreview",
  "ProviderStatus",
  "ProviderSession",
  "ProviderHandoff",
  "OnboardingState",
  "WorkspaceFileContent",
]) {
  expect(
    typeSource.includes(`type ${typeName}`),
    `${typeName} type is missing.`,
  );
}

for (const commandName of [
  "list_sessions",
  "create_desktop_session",
  "rename_session",
  "delete_session",
  "read_session_events",
  "append_user_message",
  "load_config",
  "save_config",
  "list_workspace_files",
  "read_workspace_file",
  "create_terminal_pane",
  "write_terminal_input",
  "read_terminal_output",
  "resize_terminal_pane",
  "stop_terminal_pane",
  "restart_terminal_pane",
  "restore_terminal_panes",
  "list_automations",
  "list_due_automations",
  "create_automation",
  "set_automation_status",
  "run_automation",
  "claim_due_automation",
  "complete_automation_lease",
  "recover_automation_leases",
  "triage_automation",
]) {
  expect(
    appSource.includes(commandName) || tauriSource.includes(commandName),
    `Desktop app no longer references stable Tauri command ${commandName}.`,
  );
}

for (const shortcut of [
  'event.key.toLowerCase() === "k"',
  'event.key.toLowerCase() === "n"',
  'event.key.toLowerCase() === "t"',
  'event.key === "\\\\"',
  'event.key === ","',
  'event.key === "1"',
  'event.key === "2"',
  'event.key === "3"',
]) {
  expect(
    appSource.includes(shortcut),
    `Keyboard shortcut missing: ${shortcut}`,
  );
}

for (const readinessCall of [
  'checkProviderReadiness("chat")',
  'checkProviderReadiness("task", "openai")',
  'checkProviderReadiness("handoff", toProviderId)',
]) {
  expect(
    appSource.includes(readinessCall),
    `Provider readiness call missing: ${readinessCall}`,
  );
}

expect(
  appSource.includes("shouldPreviewToolActivity") &&
    appSource.includes("if (!shouldPreviewToolActivity(message))"),
  "Local preview messages should stay calm unless tool activity is explicit.",
);
expect(
  !appSource.includes("enabled: true") &&
    !surfaceSource.includes("enabled: true"),
  "Fallback provider configs should not start enabled before setup.",
);
expect(
  !surfaceSource.includes("mock-polish") &&
    !surfaceSource.includes("mock-shell") &&
    surfaceSource.includes("Create first terminal"),
  "CLI empty state should not render fake tasks or fake running sessions.",
);
expect(
  appSource.includes("TerminalPaneSnapshot[]") &&
    appSource.includes("TerminalPaneSnapshot") &&
    appSource.includes("restore_terminal_panes") &&
    appSource.includes("write_terminal_input") &&
    appSource.includes("resize_terminal_pane") &&
    surfaceSource.includes('aria-label="Terminal input"') &&
    reducerSource.includes("upsert-restored-terminal-pane"),
  "Terminal restore and stdin wiring are missing.",
);
expect(
  !surfaceSource.includes("pane-shell") &&
    !surfaceSource.includes("VITE ready") &&
    !surfaceSource.includes("3 changed") &&
    surfaceSource.includes("No terminal panes yet") &&
    surfaceSource.includes("No file selected") &&
    surfaceSource.includes("Loading file preview") &&
    appSource.includes('invoke<WorkspaceFileContent>("read_workspace_file"'),
  "IDE and terminal panels should not seed fake activity or skip real file previews.",
);
expect(
  !surfaceSource.includes("Keychain ready") &&
    !surfaceSource.includes("Gyro v1 Launch Plan") &&
    surfaceSource.includes("No provider"),
  "Provider and rail labels should not imply configured state before setup.",
);

for (const surface of [
  "ChatSurface",
  "CliWorkspaceSurface",
  "IdeSurface",
  "SettingsSurface",
  "TaskBoardSurface",
  "AutomationsSurface",
  "ProvidersSurface",
  "DiffReviewSurface",
  "BrowserPreviewSurface",
]) {
  expect(appSource.includes(`<${surface}`), `Surface not routed: ${surface}`);
}

for (const className of [
  "gyro-terminal-pane is-active",
  "gyro-task-transition-row",
  "gyro-automation-layout",
  "gyro-provider-actions",
  "gyro-provider-health",
  "gyro-empty-action-row",
  "gyro-terminal-empty",
  "gyro-code-empty",
  "gyro-browser-console-pill",
  "gyro-account-menu",
  "gyro-account-button",
  "gyro-diff-tree-directory",
  "gyro-git-action-strip",
  "gyro-composer-readiness",
  "gyro-sidebar-section-toggle",
  "gyro-session-actions",
  "gyro-session-action is-more",
  "gyro-session-menu",
  "gyro-thread-pill-button",
  "gyro-tool-detail-panel",
  "gyro-tool-detail-trigger",
  "aria-expanded",
  "gyro-onboarding-steps",
  "gyro-chat-surface is-empty",
  "gyro-chat-start",
  "gyro-chat-thread-canvas",
  "gyro-chat-composer-dock",
  "gyro-composer-context-row",
  "gyro-ide-activitybar",
  "gyro-ide-editor-stack",
]) {
  expect(
    surfaceSource.includes(className) || styleSource.includes(className),
    `Workbench class missing: ${className}`,
  );
}

expect(
  !/green|is-green/i.test(surfaceSource) &&
    !/green|is-green/i.test(styleSource),
  "Gyro design surfaces should not use green palette names or green classes.",
);
expect(
  surfaceSource.includes('aria-label="CLI command rail"') &&
    surfaceSource.includes("Terminal grid") &&
    surfaceSource.includes("Panes") &&
    surfaceSource.includes("Grid templates"),
  "CLI surface should keep the BridgeSpace-style terminal grid command rail.",
);
expect(
  surfaceSource.includes('aria-label="IDE views"') &&
    surfaceSource.includes('aria-label="IDE panel"') &&
    surfaceSource.includes('className="gyro-ide-editor-stack"'),
  "IDE surface should keep the VS Code-style activity bar, editor stack, and bottom panel.",
);

expect(
  surfaceSource.includes('aria-label="Chat options"') &&
    />\s*Rename\s*</.test(surfaceSource) &&
    />\s*Delete\s*</.test(surfaceSource) &&
    surfaceSource.includes("fill={isPinned ?"),
  "Sidebar chat rows should expose hover pin/options controls with rename/delete actions.",
);

expect(
  appSource.includes('type: "set-chat-environment-rail", open: false'),
  "First send should explicitly keep the environment rail closed.",
);

for (const transcriptHelper of [
  "isInspectableEvent",
  "toolDetailTitle",
  "formatEventPayload",
]) {
  expect(
    surfaceSource.includes(`function ${transcriptHelper}`),
    `Transcript helper missing: ${transcriptHelper}`,
  );
}

const buttonMatches = surfaceSource.matchAll(/<button[\s\S]*?>/g);
for (const match of buttonMatches) {
  const tag = match[0];
  if (!tag.includes("onClick") && !tag.includes("disabled")) {
    failures.push(`Button has no deterministic action: ${tag}`);
  }
}

for (const secretPattern of [
  /sk-[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
]) {
  expect(
    !secretPattern.test(appSource) && !secretPattern.test(surfaceSource),
    `Potential raw secret found: ${secretPattern}`,
  );
}

const requiredViewports = ["1280x720", "1440x900", "2048x1180"];
console.log(`Workbench smoke viewports: ${requiredViewports.join(", ")}`);

if (failures.length > 0) {
  console.error("Gyro workbench smoke checks failed.\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Gyro workbench smoke checks passed.");
