#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLI_LAUNCH_PRESET_MAX_PANES,
  createInitialWorkbenchState,
  createTerminalPane,
  defaultCliLaunchPreset,
  defaultCommandProfiles,
  normalizeCliLaunchPreset,
  parseProviderHealthOutput,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";
import { providerCatalog } from "../packages/ui/src/provider-catalog.ts";

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
const indexSource = readRepoFile("packages/ui/src/index.ts");
const packageSource = readRepoFile("package.json");
const readmeSource = readRepoFile("README.md");
const launchDocsSource = readRepoFile("docs/launch.md");
const surfaceSource = readRepoFile("packages/ui/src/surfaces.tsx");
const styleSource = readRepoFile("packages/ui/src/styles.css");
const typeSource = readRepoFile("packages/ui/src/types.ts");
const reducerSource = readRepoFile("packages/ui/src/workbench-state.ts");
const coreSessionsSource = readRepoFile("crates/gyro-core/src/sessions.rs");
const tauriSource = readRepoFile("apps/desktop/src-tauri/src/lib.rs");
const tauriConfigSource = readRepoFile(
  "apps/desktop/src-tauri/tauri.conf.json",
);

const profiles = defaultCommandProfiles();
expect(
  providerCatalog.map((provider) => provider.id).join(",") ===
    "openai,anthropic,xai,gemini",
  "Composer provider picker should show OpenAI, Anthropic, xAI, and Gemini only.",
);
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
  initialState.providerStatuses.length === 4 &&
    initialState.providerStatuses.some((provider) => provider.id === "xai"),
  "Initial workbench state should include OpenAI, Anthropic, xAI, and Gemini provider statuses.",
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
  JSON.stringify(initialState.preferences.cliLaunchPreset) ===
    JSON.stringify(defaultCliLaunchPreset()),
  "Initial workbench state should include a default CLI launch preset.",
);
const missingProfilePreset = normalizeCliLaunchPreset(
  {
    entries: [{ profileId: "missing-profile", count: 3 }],
    focus: "last",
  },
  profiles,
);
expect(
  missingProfilePreset.entries.length === 1 &&
    missingProfilePreset.entries[0]?.profileId === "shell" &&
    missingProfilePreset.entries[0]?.count === 1 &&
    missingProfilePreset.focus === "first",
  "CLI launch preset should fall back to one Shell pane when stored profiles are missing.",
);
const cappedPreset = normalizeCliLaunchPreset(
  {
    entries: [{ profileId: "codex", count: CLI_LAUNCH_PRESET_MAX_PANES + 4 }],
    focus: "last",
  },
  profiles,
);
expect(
  cappedPreset.entries[0]?.profileId === "codex" &&
    cappedPreset.entries[0]?.count === CLI_LAUNCH_PRESET_MAX_PANES &&
    cappedPreset.focus === "last",
  "CLI launch preset should cap launched panes and preserve valid focus.",
);
expect(
  initialState.onboarding.activeStep === "account",
  "Onboarding should start with local device access.",
);
expect(
  initialState.preferences.sidebarChatsCollapsed === false,
  "Sidebar chats should start expanded.",
);
expect(
  initialState.preferences.chatEnvironmentRailOpen === false,
  "Chat environment rail should start closed for standard chat layout.",
);
expect(
  initialState.preferences.activeChatPanel === undefined,
  "Chat side panel should not default to the environment rail.",
);
expect(
  initialState.activeDestination === "workspace" &&
    initialState.activeWorkspaceLayout === "thread" &&
    initialState.isToolPanelOpen === false,
  "Initial workbench state should start on the thread workspace with the tool panel closed.",
);
expect(
  appSource.includes('activeWorkspaceLayout === "thread"') &&
    appSource.includes("isToolPanelOpen = false"),
  "Persisted chat/thread restore should force the shared tool panel closed.",
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
  message: "OpenAI is not connected yet",
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
  state.preferences.chatEnvironmentRailOpen === true &&
    state.preferences.activeChatPanel === "environment" &&
    state.isToolPanelOpen === false,
  "Chat environment rail toggle should open only the right-side panel.",
);
state = workbenchReducer(state, { type: "toggle-chat-environment-rail" });
expect(
  state.preferences.chatEnvironmentRailOpen === false &&
    state.preferences.activeChatPanel === undefined &&
    state.isToolPanelOpen === false,
  "Chat environment rail toggle should close only the right-side panel.",
);
state = workbenchReducer(state, {
  type: "set-chat-environment-rail",
  open: false,
});
expect(
  state.preferences.chatEnvironmentRailOpen === false &&
    state.preferences.activeChatPanel === undefined &&
    state.isToolPanelOpen === false,
  "Chat environment rail setter should close only the right-side panel.",
);
state = workbenchReducer(state, { type: "toggle-chat-plan" });
expect(
  state.preferences.activeChatPanel === "plan" &&
    state.preferences.chatEnvironmentRailOpen === false &&
    state.isToolPanelOpen === false,
  "Chat plan toggle should open the checklist without opening the bottom drawer.",
);
state = workbenchReducer(
  { ...state, activeWorkspaceLayout: "thread", isToolPanelOpen: true },
  { type: "set-workbench-mode", mode: "worktree" },
);
expect(
  state.workspaceMode === "worktree" && state.isToolPanelOpen === false,
  "Workspace mode changes from chat should keep the shared tool panel closed.",
);
state = workbenchReducer(state, {
  type: "select-workspace-layout",
  layout: "terminal-grid",
});
expect(
  state.activeDestination === "workspace" &&
    state.activeWorkspaceLayout === "terminal-grid" &&
    state.isToolPanelOpen === true,
  "Terminal Grid layout should activate the workspace and shared terminal panel.",
);
state = workbenchReducer(state, {
  type: "select-workspace-layout",
  layout: "thread",
});
expect(
  state.activeDestination === "workspace" &&
    state.activeWorkspaceLayout === "thread" &&
    state.isToolPanelOpen === false,
  "Chat layout should activate the composer without opening the shared tool panel.",
);
state = workbenchReducer(state, {
  type: "select-workspace-layout",
  layout: "code",
});
expect(
  state.activeDestination === "workspace" &&
    state.activeWorkspaceLayout === "code",
  "Code layout should activate the persistent workspace shell.",
);
state = workbenchReducer(state, { type: "open-tool-panel", tab: "browser" });
expect(
  state.activeDestination === "workspace" &&
    state.activePaneTab === "browser" &&
    state.isToolPanelOpen === true,
  "Opening a tool panel tab should route through the workspace shell.",
);
state = workbenchReducer(state, { type: "close-tool-panel" });
expect(state.isToolPanelOpen === false, "Tool panel close action failed.");
state = workbenchReducer(state, { type: "select-surface", surface: "cli" });
expect(
  state.activeDestination === "workspace" &&
    state.activeWorkspaceLayout === "terminal-grid",
  "Legacy CLI surface selection should migrate to Terminal Grid.",
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
  const hiddenRestoredPane = createTerminalPane(
    "pane-restored-hidden",
    codexProfile,
    "restored",
  );
  let restoredChatState = createInitialWorkbenchState({
    activePaneTab: "browser",
    activeWorkspaceLayout: "thread",
    isToolPanelOpen: false,
    selectedTerminalPaneId: hiddenRestoredPane.id,
    terminalPanes: [hiddenRestoredPane],
  });
  restoredChatState = workbenchReducer(restoredChatState, {
    type: "set-terminal-pane-status",
    paneId: hiddenRestoredPane.id,
    status: "failed",
    event: "restored shell failed",
  });
  expect(
    restoredChatState.activePaneTab === "browser" &&
      restoredChatState.isToolPanelOpen === false,
    "Passive restored terminal failures should not open the chat tool panel.",
  );
  restoredChatState = workbenchReducer(restoredChatState, {
    type: "sync-terminal-pane-snapshot",
    paneId: hiddenRestoredPane.id,
    status: "running",
    event: "restored shell running",
    command: "zsh",
    output: "restored",
  });
  expect(
    restoredChatState.activePaneTab === "browser" &&
      restoredChatState.isToolPanelOpen === false,
    "Passive restored terminal snapshots should stay hidden in chat.",
  );
  restoredChatState = workbenchReducer(restoredChatState, {
    type: "upsert-restored-terminal-pane",
    pane: createTerminalPane("pane-restored-hidden-2", codexProfile, "running"),
  });
  expect(
    restoredChatState.isToolPanelOpen === false,
    "Restored terminal panes should be preserved without revealing the panel.",
  );
  const reorderState = workbenchReducer(
    workbenchReducer(
      workbenchReducer(createInitialWorkbenchState(), {
        type: "add-terminal-pane",
        pane: createTerminalPane("pane-a", codexProfile, "running"),
      }),
      {
        type: "add-terminal-pane",
        pane: createTerminalPane("pane-b", codexProfile, "running"),
      },
    ),
    {
      type: "move-terminal-pane",
      sourcePaneId: "pane-a",
      targetPaneId: "pane-b",
    },
  );
  expect(
    reorderState.terminalPanes.map((pane) => pane.id).join(",") ===
      "pane-b,pane-a" && reorderState.selectedTerminalPaneId === "pane-a",
    "Terminal pane move action should reorder panes and keep the moved pane selected.",
  );
  const presetState = workbenchReducer(reorderState, {
    type: "set-cli-launch-preset",
    preset: {
      entries: [{ profileId: "codex", count: 3 }],
      focus: "last",
    },
  });
  expect(
    presetState.preferences.cliLaunchPreset.entries[0]?.profileId === "codex" &&
      presetState.preferences.cliLaunchPreset.entries[0]?.count === 3 &&
      presetState.preferences.cliLaunchPreset.focus === "last",
    "CLI launch preset reducer action should persist profile counts and focus.",
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
const parsedClaudeJsonProvider = parseProviderHealthOutput(
  "anthropic",
  '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}',
);
expect(
  parsedClaudeJsonProvider.connectionStatus === "connected",
  "Provider health parser should accept Claude auth JSON.",
);
expect(
  parsedClaudeJsonProvider.healthDetails.subscriptionLabel === "max",
  "Provider health parser should surface subscription metadata as context.",
);
const parsedMissingProvider = parseProviderHealthOutput(
  "anthropic",
  "claude auth status: not authenticated",
);
expect(
  parsedMissingProvider.connectionStatus === "not-configured",
  "Provider health parser should prioritize missing auth over auth keywords.",
);
const parsedMissingCliProvider = parseProviderHealthOutput(
  "cursor",
  "cursor-agent not installed or unavailable: No such file or directory",
);
expect(
  parsedMissingCliProvider.runtimeStatus === "not-installed",
  "Provider health parser should distinguish missing CLIs.",
);
const parsedGeminiEnvProvider = parseProviderHealthOutput(
  "gemini",
  "gemini provider-env auth available; GEMINI_API_KEY is set; value not read by Gyro.",
);
expect(
  parsedGeminiEnvProvider.connectionStatus === "connected" &&
    parsedGeminiEnvProvider.authOwner === "provider-env",
  "Provider health parser should support env-owned provider readiness.",
);
const parsedXaiEnvProvider = parseProviderHealthOutput(
  "xai",
  "xai provider-env auth available; XAI_API_KEY is set; value not read by Gyro.",
);
expect(
  parsedXaiEnvProvider.connectionStatus === "connected" &&
    parsedXaiEnvProvider.authOwner === "provider-env",
  "Provider health parser should support xAI env-owned readiness.",
);
state = workbenchReducer(state, {
  type: "record-provider-health",
  providerId: "openai",
  status: parsedConnectedProvider.connectionStatus,
  summary: parsedConnectedProvider.healthSummary,
  details: parsedConnectedProvider.healthDetails,
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
    fromLabel: "OpenAI",
    toProviderId: "anthropic",
    toLabel: "Anthropic",
    status: "queued",
    sessionTitle: "Smoke session",
    contextSummary: "Carry current thread context.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  session: {
    id: "provider-session-smoke",
    providerId: "anthropic",
    displayName: "Anthropic",
    status: "queued",
    model: "Claude Sonnet 5",
    sessionTitle: "Smoke session",
    workspaceMode: "local",
    branch: "main",
    lastEvent: "handoff queued from OpenAI",
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
  step: "account",
});
expect(
  state.onboarding.completedSteps.includes("account"),
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
state = workbenchReducer(state, {
  type: "ide-open-tab",
  tab: {
    path: "packages/ui/src/surfaces.tsx",
    title: "surfaces.tsx",
    dirty: false,
  },
});
state = workbenchReducer(state, {
  type: "ide-upsert-buffer",
  buffer: {
    path: "packages/ui/src/surfaces.tsx",
    content: "export const value = 1;\n",
    savedContent: "export const value = 1;\n",
    contentHash: "hash-1",
    sizeBytes: 24,
    truncated: false,
    status: "ready",
    updatedAt: new Date().toISOString(),
  },
});
state = workbenchReducer(state, {
  type: "ide-update-buffer",
  path: "packages/ui/src/surfaces.tsx",
  content: "export const value = 2;\n",
});
expect(
  state.ide.activePath === "packages/ui/src/surfaces.tsx" &&
    state.ide.buffers["packages/ui/src/surfaces.tsx"]?.status === "dirty" &&
    state.ide.tabs[0]?.dirty === true,
  "IDE buffer dirty transition failed.",
);
state = workbenchReducer(state, {
  type: "ide-set-selection",
  selection: {
    path: "packages/ui/src/surfaces.tsx",
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 7,
    text: "export",
  },
});
state = workbenchReducer(state, {
  type: "ide-record-assistant-request",
  request: {
    id: "ide-ai-smoke",
    action: "explain-selection",
    instruction: "Explain selection",
    path: "packages/ui/src/surfaces.tsx",
    selection: state.ide.selection,
    visibleTabs: state.ide.tabs.map((tab) => tab.path),
    providerId: "openai",
    model: "gpt-5.5",
    createdAt: new Date().toISOString(),
  },
});
state = workbenchReducer(state, {
  type: "ide-mark-buffer-saved",
  path: "packages/ui/src/surfaces.tsx",
  content: "export const value = 2;\n",
  contentHash: "hash-2",
  sizeBytes: 24,
});
expect(
  state.ide.buffers["packages/ui/src/surfaces.tsx"]?.status === "saved" &&
    state.ide.tabs[0]?.dirty === false &&
    state.ide.lastAssistantRequest?.action === "explain-selection",
  "IDE save, selection, and assistant request transitions failed.",
);

for (const typeName of [
  "WorkbenchState",
  "WorkbenchTurn",
  "SessionPlan",
  "SessionPlanItem",
  "SessionPlanItemStatus",
  "Automation",
  "TerminalPane",
  "DiffReview",
  "BrowserPreview",
  "ProviderStatus",
  "ProviderSession",
  "ProviderHandoff",
  "OnboardingState",
  "EditorTab",
  "EditorBuffer",
  "EditorSelection",
  "IdeAssistantRequest",
  "IdeState",
  "WorkspaceFileContent",
  "WorkspaceFileStat",
]) {
  expect(
    typeSource.includes(`type ${typeName}`),
    `${typeName} type is missing.`,
  );
}

for (const commandName of [
  "list_sessions",
  "create_desktop_session",
  "set_session_model",
  "rename_session",
  "delete_session",
  "read_session_events",
  "append_user_message",
  "append_plan_event",
  "append_editor_event",
  "load_config",
  "save_config",
  "list_workspace_files",
  "list_workspace_tree",
  "read_workspace_file",
  "read_workspace_file_full",
  "stat_workspace_file",
  "write_workspace_file",
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
  appSource.includes("createOptimisticTurnEvents") &&
    appSource.includes("optimisticEventsRef") &&
    appSource.includes("mergePersistedAndOptimisticEvents") &&
    appSource.includes("updateOptimisticProviderStatus") &&
    appSource.includes("setIsStartingFirstTurn") &&
    appSource.includes('kind: "provider-status"') &&
    !appSource.includes("I can keep this local. Connect a provider") &&
    !appSource.includes("shouldPreviewToolActivity"),
  "First send should create an optimistic thread with provider status instead of fake assistant/tool previews.",
);
expect(
  typeSource.includes("providerId?: ProviderId") &&
    typeSource.includes("modelId?: string") &&
    surfaceSource.includes("providerIdForSession") &&
    surfaceSource.includes("gyro-sidebar-model-logo") &&
    surfaceSource.includes("<ProviderLogo providerId={sessionProviderId} />") &&
    styleSource.includes(".gyro-sidebar-thread-main.has-model-logo") &&
    appSource.includes("selectedSessionModelFromConfig") &&
    appSource.includes("saveSessionModel") &&
    appSource.includes('invoke<Session>("set_session_model"') &&
    appSource.includes("activeSession.modelId") &&
    coreSessionsSource.includes("provider_id text") &&
    coreSessionsSource.includes("model_id text") &&
    coreSessionsSource.includes("update_session_model") &&
    tauriSource.includes("fn set_session_model") &&
    tauriSource.includes("provider_id: Option<String>") &&
    tauriSource.includes("model_id: Option<String>"),
  "Chats should persist and restore their selected provider/model locally until deleted.",
);
expect(
  !appSource.includes("enabled: true") &&
    !surfaceSource.includes("enabled: true"),
  "Fallback provider configs should not start enabled before setup.",
);
expect(
  !surfaceSource.includes("mock-polish") &&
    !surfaceSource.includes("mock-shell") &&
    surfaceSource.includes("No panes. Press + to start."),
  "CLI empty state should not render fake tasks or fake running sessions.",
);
expect(
  appSource.includes("TerminalPaneSnapshot[]") &&
    appSource.includes("TerminalPaneSnapshot") &&
    appSource.includes("LiveTerminalPaneBody") &&
    appSource.includes("launchCliPreset") &&
    appSource.includes("launchTerminalPane") &&
    appSource.includes("@xterm/xterm") &&
    appSource.includes("@xterm/addon-fit") &&
    appSource.includes("restore_terminal_panes") &&
    appSource.includes("write_terminal_input") &&
    appSource.includes("resize_terminal_pane") &&
    surfaceSource.includes("renderTerminalPaneBody") &&
    surfaceSource.includes("gyro-terminal-drag-handle") &&
    reducerSource.includes("upsert-restored-terminal-pane"),
  "Terminal restore and stdin wiring are missing.",
);
expect(
  appSource.includes("initialTerminalRestoreModeRef") &&
    appSource.includes(
      "terminalPaneFromSnapshot(\n              snapshot,\n              initialTerminalRestoreModeRef.current",
    ) &&
    !appSource.includes("}, [syncTerminalSnapshot, workbench.workspaceMode]"),
  "Changing Work locally or Use worktree should not rerun passive terminal restore.",
);
expect(
  typeSource.includes("type CliLaunchPreset") &&
    reducerSource.includes("set-cli-launch-preset") &&
    surfaceSource.includes("gyro-terminal-preset-button") &&
    surfaceSource.includes("CliLaunchPresetEditor") &&
    surfaceSource.includes("Launch preset") &&
    styleSource.includes(".gyro-cli-launch-preset") &&
    styleSource.includes(".gyro-terminal-preset-button"),
  "CLI preferred launcher UI and state wiring are missing.",
);
expect(
  tauriSource.includes("portable_pty") &&
    tauriSource.includes("native_pty_system") &&
    tauriSource.includes("PtySize") &&
    tauriSource.includes('"TERM", "xterm-256color"') &&
    tauriSource.includes('"COLORTERM", "truecolor"') &&
    tauriSource.includes('"TERM_PROGRAM", "Gyro"') &&
    !tauriSource.includes("Stdio::piped"),
  "Desktop terminal backend should use PTYs instead of piped stdio.",
);
expect(
  appSource.includes("Restart to reconnect") &&
    appSource.includes("macOptionIsMeta") &&
    appSource.includes("rightClickSelectsWord"),
  "Live terminal panes should expose real-terminal behavior and a restored-pane reconnect path.",
);
expect(
  typeSource.includes("GyroAccountSession") &&
    typeSource.includes("GyroAccountStatus") &&
    typeSource.includes("GyroAccountOidcConfig") &&
    reducerSource.includes('"account"') &&
    surfaceSource.includes("Allow this device") &&
    surfaceSource.includes("Gyro local access stays separate") &&
    appSource.includes("GyroAccountGate") &&
    appSource.includes("Use this device") &&
    appSource.includes("refresh_account_session") &&
    appSource.includes("start_account_login") &&
    appSource.includes("logout_account") &&
    tauriSource.includes("get_account_session") &&
    tauriSource.includes("start_account_login") &&
    tauriSource.includes("refresh_account_session") &&
    tauriSource.includes("logout_account"),
  "Gyro local access gate and Tauri commands are missing.",
);
expect(
  readRepoFile("crates/gyro-core/src/account.rs").includes(
    "is_local_device_access",
  ) &&
    readRepoFile("crates/gyro-core/src/account.rs").includes(
      "local-device://gyro",
    ),
  "Local device Gyro access path is missing.",
);
expect(
  surfaceSource.includes("gyro-sidebar-windowbar") &&
    surfaceSource.includes('aria-label="Window navigation"') &&
    surfaceSource.includes('aria-label="Hide sidebar"') &&
    surfaceSource.includes('aria-label="Show sidebar"') &&
    surfaceSource.includes("isSidebarHidden") &&
    surfaceSource.includes("gyro-sidebar-restore-button") &&
    surfaceSource.includes("gyro-sidebar-titlebar-drag-region") &&
    surfaceSource.includes("gyro-main-titlebar-drag-region") &&
    surfaceSource.includes("gyro-chat-empty-drag-region") &&
    surfaceSource.includes('className="gyro-topbar" data-tauri-drag-region') &&
    surfaceSource.includes(
      'className="gyro-chat-utility-bar" data-tauri-drag-region',
    ) &&
    surfaceSource.includes("data-tauri-drag-region") &&
    !surfaceSource.includes("gyro-sidebar-traffic-lights") &&
    tauriConfigSource.includes('"titleBarStyle": "Overlay"') &&
    tauriConfigSource.includes('"hiddenTitle": true') &&
    tauriConfigSource.includes('"trafficLightPosition"') &&
    surfaceSource.includes("New chat") &&
    surfaceSource.includes('aria-label="Workspace modes"') &&
    surfaceSource.includes('label="Chat"') &&
    surfaceSource.includes('label="CLI"') &&
    surfaceSource.includes('label="IDE"') &&
    surfaceSource.indexOf('aria-label="Workspace modes"') <
      surfaceSource.indexOf('className="gyro-sidebar-actions"') &&
    surfaceSource.includes("gyro-sidebar-project-chat-list") &&
    surfaceSource.includes("gyro-sidebar-small-title") &&
    surfaceSource.includes("collapsedProjectIds") &&
    surfaceSource.includes("expandedProjectIds") &&
    surfaceSource.includes("sidebarProjectGroups") &&
    surfaceSource.includes("toggleProjectMore") &&
    surfaceSource.includes("aria-expanded={isCollapsed") &&
    styleSource.includes(".gyro-sidebar-collapse-icon") &&
    styleSource.includes(".gyro-sidebar-more-button") &&
    surfaceSource.includes("projectSidebarName") &&
    surfaceSource.includes("SessionSidebarRow") &&
    surfaceSource.includes('title="Terminal panes"') &&
    surfaceSource.includes('title="CLI Profiles"') &&
    surfaceSource.includes('title="Workspace files"') &&
    surfaceSource.includes('title="Code tools"') &&
    surfaceSource.includes("Run terminal") &&
    surfaceSource.includes("Split pane") &&
    surfaceSource.includes("Diff review") &&
    surfaceSource.includes("Browser preview") &&
    !surfaceSource.includes('title="Chats"') &&
    !surfaceSource.includes("primarySidebarActionForLayout") &&
    !surfaceSource.includes('<SidebarSection title="Layouts">'),
  "Mode-specific sidebar should keep overlay chrome while giving Chat, CLI, and IDE distinct content.",
);
const chatSidebarSource = surfaceSource.slice(
  surfaceSource.indexOf("{!isCliSidebar && !isIdeSidebar ? ("),
  surfaceSource.indexOf("function SidebarSection"),
);
expect(
  chatSidebarSource.includes("New chat") &&
    chatSidebarSource.includes("Search") &&
    chatSidebarSource.includes("gyro-sidebar-project-chat-list") &&
    chatSidebarSource.includes("Pinned") &&
    chatSidebarSource.includes("Projects") &&
    chatSidebarSource.includes("pinnedSessions.map(renderSessionRow)") &&
    chatSidebarSource.includes("projectGroups.map") &&
    chatSidebarSource.includes("project.sessions.slice(0, 3)") &&
    chatSidebarSource.includes("toggleProject(project.key)") &&
    chatSidebarSource.includes("toggleProjectMore(project.key)") &&
    chatSidebarSource.includes("gyro-sidebar-more-button") &&
    chatSidebarSource.includes("No recent chats") &&
    !chatSidebarSource.includes("<small>Start one</small>") &&
    !chatSidebarSource.includes("onClick={onOpenWorkspace}") &&
    !chatSidebarSource.includes("Scheduled") &&
    !chatSidebarSource.includes("Plugins") &&
    !chatSidebarSource.includes('title="Projects"') &&
    !chatSidebarSource.includes("activeSession.worktreeName") &&
    !chatSidebarSource.includes('onSelectDestination("automations")'),
  "Chat sidebar should show clean project and recent chat rows, without Scheduled.",
);
expect(
  typeSource.includes('| "tools"') &&
    appSource.includes('activeDestination === "tools"') &&
    surfaceSource.includes("ToolsSurface") &&
    surfaceSource.includes("<h1>Tools</h1>") &&
    surfaceSource.includes('onSelectDestination("tasks")') &&
    surfaceSource.includes('onSelectDestination("automations")') &&
    surfaceSource.includes('onSelectDestination("providers")'),
  "Tools destination should route to a hub for tasks, automations, and providers.",
);
expect(
  surfaceSource.includes("function SettingsSidebarContent") &&
    surfaceSource.includes("settingsSidebarItems") &&
    surfaceSource.includes('aria-label="Settings navigation"') &&
    surfaceSource.includes('aria-label="Back from settings"') &&
    surfaceSource.includes("gyro-settings-back-button") &&
    surfaceSource.includes('onOpenSettingsSection("general")') &&
    surfaceSource.includes('activeDestination !== "settings"') &&
    surfaceSource.includes("General") &&
    surfaceSource.includes("Appearance") &&
    surfaceSource.includes("Usage Limits") &&
    surfaceSource.includes("Providers") &&
    surfaceSource.includes("CLI Profiles") &&
    surfaceSource.includes("Permissions") &&
    surfaceSource.includes("Updates") &&
    surfaceSource.includes("Keyboard") &&
    surfaceSource.includes("Advanced") &&
    surfaceSource.includes("Help") &&
    surfaceSource.includes('activeSection === "general"') &&
    surfaceSource.includes('activeSection === "providers"') &&
    !surfaceSource.includes("isAccountMenuOpen") &&
    !surfaceSource.includes("gyro-account-menu") &&
    !surfaceSource.includes('<nav className="gyro-settings-nav"') &&
    styleSource.includes("grid-template-columns: minmax(0, 1fr);") &&
    styleSource.includes(".gyro-settings-back-button") &&
    appSource.includes("lastNonSettingsDestinationRef") &&
    appSource.includes("returnFromSettings"),
  "Settings should move section navigation to the sidebar and keep exactly one active subpage in content.",
);
expect(
  appSource.includes("WorkspaceToolPanelPeek") &&
    appSource.includes("toolPanelHeight") &&
    appSource.includes("DEFAULT_TOOL_PANEL_HEIGHT = 280") &&
    surfaceSource.includes("TOOL_PANEL_DEFAULT_HEIGHT = 280") &&
    surfaceSource.includes("data-active-tab={activePaneTab}") &&
    surfaceSource.includes("terminalTitle={activeTerminalPane?.title}") &&
    surfaceSource.includes("gyro-tool-panel-resize-handle") &&
    surfaceSource.includes("gyro-tool-panel-reveal") &&
    surfaceSource.includes("TOOL_PANEL_COLLAPSE_HEIGHT") &&
    styleSource.includes(".gyro-workspace-tool-panel.is-resizable") &&
    styleSource.includes(".gyro-tool-panel-reveal-button") &&
    styleSource.includes('[data-active-tab="terminal"]') &&
    styleSource.includes(".gyro-terminal-toolbar {\n  display: none;") &&
    styleSource.includes("button:not(.gyro-pane-add):not(.is-active)"),
  "Bottom workspace tool panel should support a compact chat tray, drag resizing, drag-to-collapse, and a reveal handle.",
);
expect(
  typeSource.includes('| "plan-updated"') &&
    typeSource.includes("type SessionPlan") &&
    tauriSource.includes("append_plan_event") &&
    tauriSource.includes("SessionEventKind::PlanUpdated") &&
    appSource.includes("deriveSessionPlan") &&
    appSource.includes("appendPlanEvent") &&
    surfaceSource.includes("ChatSurfaceControls") &&
    surfaceSource.includes("ChatSidePanel") &&
    surfaceSource.includes("gyro-plan-rail"),
  "AI model checklist plan events should be typed, persisted, derived, and visible in chat.",
);
expect(
  surfaceSource.includes('activeRailPanel ? "has-environment" : ""') &&
    surfaceSource.includes("<strong>Environment</strong>") &&
    surfaceSource.includes(
      '<div className="gyro-rail-heading">Changes</div>',
    ) &&
    surfaceSource.includes('<div className="gyro-rail-heading">Local</div>') &&
    surfaceSource.includes('<div className="gyro-rail-heading">Branch</div>') &&
    surfaceSource.includes(
      '<div className="gyro-rail-heading">Commit or push</div>',
    ) &&
    surfaceSource.includes('<div className="gyro-rail-heading">Tasks</div>') &&
    surfaceSource.includes(
      '<div className="gyro-rail-heading">Sources</div>',
    ) &&
    surfaceSource.includes("No sources yet") &&
    appSource.includes('dispatchWorkbench({ type: "set-chat-panel" })') &&
    surfaceSource.includes('onComposerAction?.("show-project-context")') &&
    surfaceSource.includes('onComposerAction?.("select-workspace-mode")') &&
    surfaceSource.includes('onComposerAction?.("select-branch")') &&
    surfaceSource.includes("gyro-provider-status-row") &&
    styleSource.includes(".gyro-thread-topbar-actions") &&
    styleSource.includes(".gyro-chat-composer-dock .gyro-composer-shell") &&
    styleSource.includes("max-width: 668px") &&
    styleSource.includes("border-radius: 21px") &&
    styleSource.includes("color: #ff8a3d") &&
    styleSource.includes(
      ".gyro-chat-start .gyro-composer-shell:focus-within .gyro-composer-bar",
    ) &&
    styleSource.includes("border-color: #45474d") &&
    styleSource.includes(
      "grid-template-columns: minmax(0, 1fr) minmax(288px, 316px)",
    ) &&
    surfaceSource.includes("{isUser ? null : ("),
  "First chat should default to a clean Codex-style thread with topbar pills, provider status recovery, and matching docked composer.",
);
expect(
  reducerSource.includes("activeChatPanel: panel") &&
    reducerSource.includes('chatEnvironmentRailOpen: panel === "environment"') &&
    appSource.includes('dispatchWorkbench({ type: "set-chat-panel" });') &&
    !appSource.includes(
      'panel: "environment" });\n        dispatchWorkbench({\n          type: "select-workspace-layout"',
    ),
  "Opening or selecting a chat should use the standard clean thread layout, not the Environment panel.",
);
expect(
  packageSource.includes('"desktop:bundle"') &&
    packageSource.includes('"desktop:install-local"') &&
    readmeSource.includes("target/debug/gyro-desktop") &&
    launchDocsSource.includes("open target/release/bundle/macos/Gyro.app") &&
    launchDocsSource.includes("~/Applications/Gyro.app") &&
    launchDocsSource.includes("generic `exec` Dock icon"),
  "Local app launch docs and scripts should steer users to Gyro.app instead of the raw debug executable.",
);
expect(
  appSource.includes("const handleComposerAction") &&
    appSource.includes('case "select-model"') &&
    appSource.includes('destination: "providers"') &&
    appSource.includes('openSettingsSection("permissions")') &&
    appSource.includes("const setComposerWorkspaceMode") &&
    appSource.includes("const selectContextFile") &&
    appSource.includes('title: "Select file"') &&
    appSource.includes("relativeFilePath") &&
    appSource.includes('"Worktree chats need a repo or folder') &&
    appSource.includes("void openWorkspace();") &&
    appSource.includes("void selectContextFile();") &&
    appSource.includes('case "select-workspace-mode"') &&
    appSource.includes('type: "set-workbench-mode"') &&
    appSource.includes('type: "close-tool-panel"') &&
    surfaceSource.includes("workspaceModeLabel") &&
    surfaceSource.includes("projectLabel") &&
    surfaceSource.includes("composerProjectLabel") &&
    surfaceSource.includes("isGeneratedGyroWorkspace") &&
    surfaceSource.includes("hasStartWorkspace") &&
    surfaceSource.includes(
      "What should we build in ${workspaceName(workspacePath)}?",
    ) &&
    surfaceSource.includes("Choose folder") &&
    surfaceSource.includes("branchLabel") &&
    surfaceSource.includes('action: "select-file"') &&
    surfaceSource.includes('action: "select-folder"') &&
    surfaceSource.includes('"set-workspace-mode:worktree"') &&
    surfaceSource.includes("New worktree branch") &&
    surfaceSource.includes("Select folder") &&
    surfaceSource.includes("Change folder"),
  "Composer controls should route to real workspace, provider, permission, branch, and workspace-mode actions.",
);
expect(
  styleSource.includes(".gyro-composer-context-row") &&
    styleSource.includes("flex-wrap: wrap") &&
    styleSource.includes("overflow: visible") &&
    !styleSource.includes(
      ".gyro-composer-context-row {\n  align-items: center;\n  background: #16181b;\n  border-top: 1px solid #262a30;\n  display: flex;\n  gap: 5px;\n  min-height: 34px;\n  overflow-x: auto;",
    ),
  "Start composer context row should wrap without rendering a horizontal scrollbar.",
);
expect(
  appSource.includes("function providerLoginProfile") &&
    appSource.includes('args: ["login", "--device-auth"]') &&
    appSource.includes('args: ["auth", "login"]') &&
    appSource.includes('command: "cursor-agent"') &&
    appSource.includes('command: "opencode"') &&
    appSource.includes('"check_provider_health"') &&
    appSource.includes("providerHealthRequest(provider, providerId)") &&
    appSource.includes("PROVIDER_AUTH_POLL_ATTEMPTS") &&
    appSource.includes("Gyro will connect automatically.") &&
    appSource.includes(
      'provider.authStatus === "connected" || provider.enabled',
    ) &&
    appSource.includes('provider?.authStatus === "connected"') &&
    appSource.includes('layout: "terminal-grid"') &&
    appSource.includes('tab: "terminal"') &&
    tauriSource.includes("struct ProviderHealthService") &&
    tauriSource.includes('"codex",\n            &["login", "status"]') &&
    tauriSource.includes('"claude",\n                &["auth", "status"]') &&
    tauriSource.includes('"xai"') &&
    tauriSource.includes('"XAI_API_KEY"') &&
    tauriSource.includes("should_skip_codex_login_for_external_env") &&
    tauriSource.includes("gyro_core::security::redact_secrets") &&
    tauriSource.includes("fn augmented_gui_path") &&
    tauriSource.includes("command_with_gui_path(") &&
    surfaceSource.includes("Gyro local access stays separate") &&
    surfaceSource.includes("Provider event logs are sensitive and opt-in") &&
    surfaceSource.includes("Claude Code login and claude auth status") &&
    surfaceSource.includes("Codex sign-in with ChatGPT") &&
    surfaceSource.includes("XAI_API_KEY") &&
    surfaceSource.includes('provider.authStatus === "connected"') &&
    surfaceSource.includes("onToggleProvider?.(provider.id)") &&
    surfaceSource.includes("onTestProvider?.(provider.id)") &&
    surfaceSource.includes("gyro-settings-provider-actions") &&
    surfaceSource.includes("providerAuthOwnershipDetail(provider.id)") &&
    appSource.includes("onTestProvider={testProvider}") &&
    styleSource.includes(".gyro-settings-provider-actions") &&
    !surfaceSource.includes(
      "Model-provider OAuth is not wired for this provider yet.",
    ),
  "Provider Connect should launch local CLI auth, poll real provider status, and avoid fake settings toggles.",
);
expect(
  surfaceSource.includes('providerReadiness?.status === "blocked"') &&
    surfaceSource.includes("Provider needs attention") &&
    !surfaceSource.includes(
      "gyro-composer-readiness is-${providerReadiness.status}",
    ) &&
    styleSource.includes(".gyro-composer-menu-item.is-warning"),
  "Provider readiness should stay quiet when ready and show blocked errors inside the provider picker.",
);
expect(
  surfaceSource.includes("gyro-provider-picker") &&
    surfaceSource.includes("gyro-provider-model-flyout") &&
    surfaceSource.includes('modelPickerProvider ? "has-flyout" : ""') &&
    surfaceSource.includes("onItemPreview") &&
    surfaceSource.includes("const providerModelItems: ComposerPopoverItem[]") &&
    !surfaceSource.includes(
      "refresh-provider-models:${modelPickerProvider.id}",
    ) &&
    !surfaceSource.includes('action: "select-model"') &&
    styleSource.includes(".gyro-provider-picker.has-flyout") &&
    styleSource.includes("grid-template-columns: 156px 190px"),
  "Provider picker should keep provider rows compact and show models in a hover flyout without Refresh or Settings rows.",
);
expect(
  surfaceSource.includes("<ProviderLogo providerId={selectedProvider.id} />") &&
    surfaceSource.includes(
      'const modelChipLabel = selectedProvider ? providerModelLabel : "Choose model"',
    ) &&
    surfaceSource.includes("{modelChipLabel}") &&
    surfaceSource.includes('title="Provider"') &&
    !surfaceSource.includes("`${providerLabel} · ${providerModelLabel}`") &&
    styleSource.includes(".gyro-model-chip .gyro-provider-logo"),
  "Composer model chip should show the provider logo and model name only.",
);
expect(
  indexSource.includes("ModelStandardPromptOverlay") &&
    surfaceSource.includes("export function ModelStandardPromptOverlay") &&
    surfaceSource.includes("You use {modelLabel} a lot.") &&
    surfaceSource.includes("Yes, make standard") &&
    surfaceSource.includes("No, not now") &&
    styleSource.includes(".gyro-model-standard-overlay") &&
    appSource.includes("MODEL_STANDARD_PROMPT_THRESHOLD = 3") &&
    appSource.includes("MODEL_USAGE_STORAGE_KEY") &&
    appSource.includes("recordModelSelection") &&
    appSource.includes("acceptModelStandardPrompt") &&
    appSource.includes("dismissModelStandardPrompt") &&
    appSource.includes("<ModelStandardPromptOverlay"),
  "Repeated model selections should trigger a polished standard-model confirmation overlay.",
);
expect(
  surfaceSource.includes("function useOutsidePointerDismiss") &&
    surfaceSource.includes('document.addEventListener("pointerdown"') &&
    surfaceSource.includes("event.composedPath().includes(current)") &&
    surfaceSource.includes("const menuRef = useOutsidePointerDismiss") &&
    surfaceSource.includes("ref={popoverScopeRef}") &&
    surfaceSource.includes("event.target === event.currentTarget") &&
    surfaceSource.includes("ref={detailRef}"),
  "Menus, popovers, command palette, and detail panels should dismiss on outside pointer clicks.",
);
expect(
  surfaceSource.includes("const contextItems: ComposerPopoverItem[]") &&
    surfaceSource.includes('label: "Photos"') &&
    surfaceSource.includes('label: "Spreadsheet"') &&
    surfaceSource.includes('label: "Slides"') &&
    surfaceSource.includes('label: "Plan"') &&
    surfaceSource.includes('title="Add"') &&
    !surfaceSource.includes("Attach a folder or file") &&
    !surfaceSource.includes("Find commands and files") &&
    appSource.includes('case "add-photos":') &&
    appSource.includes('case "add-plan":') &&
    appSource.includes('type: "set-chat-panel", panel: "plan"') &&
    styleSource.includes("min-height: 32px"),
  "Composer add popover should stay compact and include richer context types.",
);
expect(
  surfaceSource.includes("OpenAI permissions") &&
    surfaceSource.includes("Anthropic permissions") &&
    surfaceSource.includes("Codex settings") &&
    surfaceSource.includes("Claude settings") &&
    surfaceSource.includes("Command policy") &&
    surfaceSource.includes("File edit policy") &&
    appSource.includes("approvalNotificationCopy"),
  "Permission controls should adapt labels to the selected OpenAI or Anthropic provider and backend approval settings.",
);
expect(
  styleSource.includes(".gyro-tool-panel-reveal") &&
    styleSource.includes("min-height: 10px") &&
    styleSource.includes(".gyro-sidebar-footer") &&
    styleSource.includes(".gyro-sidebar-windowbar") &&
    styleSource.includes(".gyro-sidebar-restore-button") &&
    styleSource.includes(".gyro-app-shell.is-sidebar-hidden") &&
    styleSource.includes(".gyro-sidebar-titlebar-drag-region") &&
    styleSource.includes(".gyro-main-titlebar-drag-region") &&
    styleSource.includes(".gyro-chat-empty-drag-region") &&
    styleSource.includes(".gyro-sidebar-mode-group") &&
    styleSource.includes("padding: 0 9px 0") &&
    styleSource.includes("height: 58px") &&
    styleSource.includes("height: 50px") &&
    styleSource.includes("padding: 9px 5px 6px 84px") &&
    styleSource.includes("padding: 6px 8px 4px") &&
    styleSource.includes("text-align: left") &&
    styleSource.includes("margin: auto -9px 0"),
  "Collapsed panel handle should be minimal and the unified sidebar should keep compact chrome, aligned section labels, mode switcher, and bottom settings.",
);
expect(
  !appSource.includes("workspacePath ?? (await open") &&
    appSource.includes('const workspace = workspacePath ?? "";'),
  "Backed session creation should not open the workspace picker.",
);
expect(
  appSource.includes("const startNewChat") &&
    appSource.includes("suppressSessionAutoSelectRef.current = true") &&
    appSource.includes("setActiveSessionId(undefined)") &&
    appSource.includes("onCreateSession={startNewChat}") &&
    surfaceSource.includes("const transcriptEvents = events.filter") &&
    surfaceSource.includes("if (transcriptEvents.length === 0)") &&
    surfaceSource.includes('aria-label="New thread"'),
  "New chat should clear the active session and render the start screen from transcript events.",
);
expect(
  !surfaceSource.includes("pane-shell") &&
    !surfaceSource.includes("VITE ready") &&
    !surfaceSource.includes("3 changed") &&
    surfaceSource.includes("No panes. Press + to start.") &&
    surfaceSource.includes("No file selected") &&
    surfaceSource.includes("Loading file preview") &&
    appSource.includes(
      'invoke<WorkspaceFileContent>("read_workspace_file_full"',
    ) &&
    tauriSource.includes("write_workspace_file") &&
    appSource.includes("<MonacoEditorPane") &&
    surfaceSource.includes("renderEditor") &&
    surfaceSource.includes("gyro-editor-ai-bar"),
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
  "IdeSurface",
  "SettingsSurface",
  "TaskBoardSurface",
  "AutomationsSurface",
  "ProvidersSurface",
  "ToolsSurface",
  "WorkspaceToolPanel",
]) {
  expect(appSource.includes(`<${surface}`), `Surface not routed: ${surface}`);
}

for (const surface of [
  "CliWorkspaceSurface",
  "DiffReviewSurface",
  "BrowserPreviewSurface",
]) {
  expect(
    !appSource.includes(`<${surface}`),
    `Standalone surface should not be routed: ${surface}`,
  );
}

for (const className of [
  "gyro-terminal-pane",
  "gyro-terminal-toolbar",
  "gyro-terminal-drag-handle",
  "gyro-terminal-live-body",
  "gyro-xterm-frame",
  "gyro-xterm-host",
  "gyro-terminal-reconnect",
  "gyro-task-transition-row",
  "gyro-automation-layout",
  "gyro-provider-actions",
  "gyro-provider-health",
  "gyro-empty-action-row",
  "gyro-terminal-empty",
  "gyro-code-empty",
  "gyro-browser-console-pill",
  "gyro-account-button",
  "gyro-account-gate",
  "gyro-account-panel",
  "gyro-sidebar-windowbar",
  "gyro-sidebar-mode-group",
  "gyro-diff-tree-directory",
  "gyro-git-action-strip",
  "gyro-composer-readiness",
  "gyro-sidebar-section-toggle",
  "gyro-sidebar-more-button",
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
  "gyro-provider-status-row",
  "gyro-provider-status-actions",
  "gyro-chat-surface-controls",
  "gyro-plan-rail",
  "gyro-ide-activitybar",
  "gyro-ide-editor-stack",
  "gyro-workspace-route",
  "gyro-workspace-tool-panel",
  "gyro-workspace-tool-panel-head",
  "gyro-tools-surface",
  "gyro-tools-card",
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
  appSource.includes('activeWorkspaceLayout === "terminal-grid"') &&
    appSource.includes("renderWorkspaceToolPanel(true)") &&
    surfaceSource.includes('aria-label="Workspace tools"'),
  "Terminal Grid should route through the shared workspace tool panel.",
);
expect(
  surfaceSource.includes("showEmbeddedPanel = true") &&
    appSource.includes("showEmbeddedPanel={false}") &&
    surfaceSource.includes('"is-workspace-shell"') &&
    surfaceSource.includes('"is-editor-only"') &&
    surfaceSource.includes("onOpenWorkspaceFile?.(file.path)") &&
    appSource.includes("onOpenWorkspaceFile={openEditorFile}") &&
    !surfaceSource.includes(
      '.filter((file) => file.kind === "file")\n          .slice(0, 3)',
    ) &&
    styleSource.includes(".gyro-ide-surface.is-workspace-shell") &&
    styleSource.includes(".gyro-ide-editor-stack.is-editor-only"),
  "Code layout should preserve the IDE editor while using the shared tool panel.",
);

expect(
  surfaceSource.includes('aria-label="Chat options"') &&
    />\s*Rename\s*</.test(surfaceSource) &&
    />\s*Delete\s*</.test(surfaceSource) &&
    surfaceSource.includes("fill={isPinned ?"),
  "Sidebar chat rows should expose hover pin/options controls with rename/delete actions.",
);

expect(
  appSource.includes('type: "close-tool-panel"'),
  "First send should explicitly keep the shared tool panel closed.",
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
