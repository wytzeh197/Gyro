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
import {
  normalizedConfig,
  providerCatalog,
  providersForConfig,
} from "../packages/ui/src/provider-catalog.ts";
import {
  CHAT_RESPONSE_TRUNCATION_SUFFIX,
  MAX_CHAT_EVENT_RENDER_COUNT,
  MAX_CHAT_RESPONSE_CHARS,
  applyProviderChatStreamDeltas,
} from "../apps/desktop/src/provider-stream-events.ts";

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
const providerStreamSource = readRepoFile(
  "apps/desktop/src/provider-stream-events.ts",
);
const appAndStreamSource = `${appSource}\n${providerStreamSource}`;
const indexSource = readRepoFile("packages/ui/src/index.ts");
const packageSource = readRepoFile("package.json");
const readmeSource = readRepoFile("README.md");
const launchDocsSource = readRepoFile("docs/launch.md");
const roadmapSource = readRepoFile("ROADMAP.md");
const readinessAuditSource = readRepoFile("docs/product-readiness-audit.md");
const surfaceSource = readRepoFile("packages/ui/src/surfaces.tsx");
const styleSource = readRepoFile("packages/ui/src/styles.css");
const typeSource = readRepoFile("packages/ui/src/types.ts");
const reducerSource = readRepoFile("packages/ui/src/workbench-state.ts");
const coreHarnessSource = readRepoFile("crates/gyro-core/src/harness.rs");
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
const restoredEnabledConfig = normalizedConfig({
  updateChannel: "stable",
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
  modelProviders: [
    {
      id: "openai",
      displayName: "OpenAI",
      baseUrl: null,
      apiKeyRef: "provider:openai",
      enabled: true,
    },
  ],
  commandProfiles: [],
});
expect(
  providersForConfig(restoredEnabledConfig).find(
    (provider) => provider.id === "openai",
  )?.authStatus === "connected",
  "Saved enabled providers should rehydrate as connected when backend config omits authStatus.",
);

const streamRegressionEvents = [
  {
    id: "stream-session-created",
    sessionId: "stream-session",
    createdAt: "2026-07-09T00:00:00.000Z",
    kind: "session-created",
    message: "Stream session",
    payload: {},
  },
  ...Array.from({ length: MAX_CHAT_EVENT_RENDER_COUNT + 30 }, (_, index) => ({
    id: `stream-user-${index}`,
    sessionId: "stream-session",
    createdAt: "2026-07-09T00:00:00.000Z",
    turnId: `old-turn-${index}`,
    kind: "user-message",
    message: `older message ${index}`,
    payload: {},
  })),
];
const streamRegressionDeltas = Array.from({ length: 800 }, (_, index) => ({
  sessionId: "stream-session",
  turnId: "stream-turn",
  providerId: "openai",
  modelId: "gpt-5",
  eventId: `stream-delta-${index}`,
  phase: "delta",
  textDelta: `chunk-${index.toString().padStart(4, "0")}: ${"x".repeat(120)}\n`,
}));
const streamOptimisticEventsRef = { current: new Map() };
let streamRegressionState = streamRegressionEvents;
let streamRegressionSetCalls = 0;
applyProviderChatStreamDeltas(
  streamOptimisticEventsRef,
  (value) => {
    streamRegressionSetCalls += 1;
    streamRegressionState =
      typeof value === "function" ? value(streamRegressionState) : value;
  },
  streamRegressionDeltas,
);
const streamingAssistantEvents = streamRegressionState.filter(
  (event) =>
    event.kind === "assistant-message" && event.turnId === "stream-turn",
);
const [streamingAssistantEvent] = streamingAssistantEvents;
expect(
  streamRegressionSetCalls === 1,
  "Provider stream deltas should be applied in one state update per flushed batch.",
);
expect(
  streamRegressionState.length === MAX_CHAT_EVENT_RENDER_COUNT,
  "Provider stream delta batches should keep the rendered event list bounded.",
);
expect(
  streamRegressionState[0]?.kind === "session-created",
  "Provider stream event capping should keep the session-created event.",
);
expect(
  streamingAssistantEvents.length === 1,
  "Provider stream deltas should merge into one streaming assistant event.",
);
expect(
  streamingAssistantEvent?.message.length ===
    MAX_CHAT_RESPONSE_CHARS + CHAT_RESPONSE_TRUNCATION_SUFFIX.length &&
    streamingAssistantEvent?.message.endsWith(CHAT_RESPONSE_TRUNCATION_SUFFIX),
  "Provider stream deltas should truncate oversized assistant responses once.",
);
expect(
  streamOptimisticEventsRef.current.get("stream-session")?.length === 1,
  "Provider stream deltas should keep one optimistic streaming assistant event.",
);
const codexProfile = profiles.find((profile) => profile.id === "codex");
expect(Boolean(codexProfile), "Default Codex command profile is missing.");
const shellProfile = profiles.find((profile) => profile.id === "shell");
expect(
  shellProfile?.command === "zsh" && shellProfile.args.includes("-il"),
  "Default Shell profile should launch an interactive login zsh.",
);

const initialState = createInitialWorkbenchState();
const { languageServers: _legacyLanguageServers, ...legacyIdeState } =
  initialState.ide;
const migratedIdeState = createInitialWorkbenchState({
  ...initialState,
  ide: legacyIdeState,
});
expect(
  Array.isArray(migratedIdeState.ide.languageServers) &&
    migratedIdeState.ide.languageServers.length === 0,
  "Persisted IDE state from before language servers should hydrate safely.",
);
let editorGroupState = workbenchReducer(initialState, {
  type: "ide-open-tab",
  tab: { path: "src/main.ts", title: "main.ts", dirty: false },
});
editorGroupState = workbenchReducer(editorGroupState, {
  type: "ide-split-group",
  direction: "right",
});
const splitGroupId = editorGroupState.ide.layout.activeGroupId;
expect(
  editorGroupState.ide.layout.groups.length === 2 &&
    editorGroupState.ide.layout.groups.every(
      (group) => group.activePath === "src/main.ts",
    ),
  "Splitting the editor should create a second live group with the active file.",
);
editorGroupState = workbenchReducer(editorGroupState, {
  type: "ide-close-group",
  groupId: splitGroupId,
});
expect(
  editorGroupState.ide.layout.groups.length === 1,
  "Closing an editor group should preserve one usable editor group.",
);
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
  const pane = createTerminalPane("pane-smoke", codexProfile, "restored", {
    workingDirectory: "/tmp/gyro-worktree",
  });
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
    workingDirectory: "/tmp/gyro-worktree-resolved",
  });
  const updatedPane = state.terminalPanes.find((item) => item.id === pane.id);
  expect(
    updatedPane?.status === "done" &&
      updatedPane?.output === "terminal output captured" &&
      updatedPane?.workingDirectory === "/tmp/gyro-worktree-resolved" &&
      updatedPane?.attention === "failed",
    "Terminal pane lifecycle failed.",
  );
  state = workbenchReducer(state, {
    type: "set-terminal-pane-attention",
    paneId: pane.id,
    attention: "waiting",
  });
  state = workbenchReducer(state, {
    type: "select-terminal-pane",
    paneId: pane.id,
  });
  expect(
    state.terminalPanes.find((item) => item.id === pane.id)?.attention ===
      undefined,
    "Focusing a terminal should clear waiting attention.",
  );
  const unchangedTerminalState = workbenchReducer(state, {
    type: "sync-terminal-pane-snapshot",
    paneId: pane.id,
    status: "done",
    event: "done (0)",
    command: "codex --help",
    output: "terminal output captured",
  });
  expect(
    unchangedTerminalState === state,
    "Unchanged terminal snapshots should not create new workbench state.",
  );
  let terminalLayoutState = workbenchReducer(state, {
    type: "set-terminal-pane-layout",
    paneId: pane.id,
    layout: "wide",
  });
  terminalLayoutState = workbenchReducer(terminalLayoutState, {
    type: "upsert-restored-terminal-pane",
    pane: createTerminalPane(pane.id, codexProfile, "running"),
  });
  expect(
    terminalLayoutState.terminalPanes.find((item) => item.id === pane.id)
      ?.layout === "wide",
    "Terminal pane layout should persist across backend snapshot restores.",
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
  "run_provider_chat",
  "append_plan_event",
  "append_editor_event",
  "load_config",
  "get_account_session",
  "start_account_login",
  "refresh_account_session",
  "logout_account",
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

expect(
  !/#\[tauri::command\]\s*fn /.test(tauriSource),
  "Tauri command handlers should be async so command entrypoints do not run synchronous work on the UI-facing command path.",
);

for (const commandName of [
  "load_config",
  "get_account_session",
  "start_account_login",
  "refresh_account_session",
  "logout_account",
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
    tauriSource.includes(`async fn ${commandName}`) &&
      tauriSource.includes(`${commandName}_blocking`) &&
      tauriSource.includes("spawn_blocking"),
    `Tauri command ${commandName} should run through a blocking worker.`,
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
    appSource.includes('providerStatusMessage("running", provider)') &&
    appSource.includes("waitForNextPaint") &&
    appSource.includes("optimisticEventsRef") &&
    appSource.includes("mergePersistedAndOptimisticEvents") &&
    appAndStreamSource.includes(
      "const merged = limitSessionEventsForUi(persistedEvents)",
    ) &&
    appAndStreamSource.includes("const seenEventIds = new Set<string>()") &&
    appSource.includes(
      "limitSessionEventsForUi(optimisticEvents.map(updateEvent))",
    ) &&
    appSource.includes("updateOptimisticProviderStatus") &&
    appSource.includes("setIsStartingFirstTurn") &&
    appSource.includes("sendingSessionIdsRef") &&
    appSource.includes("setSessionSending") &&
    appSource.includes("const activeSessionHasTranscriptEvents = useMemo") &&
    appSource.includes("[activeSessionId, events.length]") &&
    appSource.includes(
      "shouldSuggestSessionTitle(\n        activeSession,\n        activeSessionHasTranscriptEvents",
    ) &&
    !appSource.includes(
      "shouldSuggestSessionTitle(\n        activeSession,\n        events",
    ) &&
    appSource.includes("draftResetToken") &&
    appSource.includes("resetChatDraft") &&
    !appSource.includes("const [draft, setDraft]") &&
    !appSource.includes("onDraftChange={setDraft}") &&
    appSource.includes("maxDraftLength={MAX_CHAT_MESSAGE_CHARS}") &&
    /invoke<ProviderChatResponse>\(\s*"run_provider_chat"/.test(appSource) &&
    appSource.includes("sessionTitleFromMessage") &&
    appSource.includes("shouldSuggestSessionTitle") &&
    appSource.includes("applyProviderChatResponse") &&
    appSource.includes("mergeProviderResponseEvents") &&
    appSource.includes("response?.statusEvent") &&
    appSource.includes("response?.assistantEvent") &&
    appSource.includes(
      "startTransition(() => {\n        setEvents((current) => {",
    ) &&
    appSource.includes("applyProviderChatResponse(activeSessionId") &&
    appSource.includes("applyProviderChatResponse(persistedSession.id") &&
    !/applyProviderChatResponse\(persistedSession\.id,\s*providerResponse\);\s*updateOptimisticProviderStatus/.test(
      appSource,
    ) &&
    !/applyProviderChatResponse\(activeSessionId,\s*providerResponse\);\s*updateOptimisticProviderStatus/.test(
      appSource,
    ) &&
    appSource.includes("ProviderChatStreamEvent") &&
    appSource.includes("ProviderResumeCursor") &&
    appSource.includes("gyro://provider-chat-event") &&
    appSource.includes("applyProviderChatStreamEvent") &&
    appSource.includes('streamEvent.phase === "started"') &&
    appSource.includes('streamEvent.phase === "completed"') &&
    appSource.includes("applyProviderChatStreamDeltas") &&
    appSource.includes("batches.map((batch) => ({") &&
    providerStreamSource.includes(
      "const coalescedDeltaEvents = new Map<string, PendingStreamDeltaEvent>()",
    ) &&
    providerStreamSource.includes("existing.chunks.push(textDelta)") &&
    providerStreamSource.includes('textDelta: chunks.join("")') &&
    providerStreamSource.includes(
      "const updatedSessionIds = new Set<string>()",
    ) &&
    appAndStreamSource.includes("upsertStreamingAssistantEvent") &&
    appSource.includes("PROVIDER_STREAM_FLUSH_MS") &&
    appSource.includes("providerStreamBatchRef") &&
    appSource.includes("flushProviderStreamBatches") &&
    appSource.includes("queueProviderChatStreamEvent") &&
    appSource.includes("startTransition") &&
    appSource.includes(
      "const deferredEventsForPlan = useDeferredValue(events)",
    ) &&
    appSource.includes(
      "deriveSessionPlan(deferredEventsForPlan, activeSessionId)",
    ) &&
    appSource.includes("const deferredEventsForTurn = deferredEventsForPlan") &&
    appSource.includes("const derivedActiveTurn = useMemo") &&
    appSource.includes(
      "deriveActiveTurn(deferredEventsForTurn, activeSession?.title)",
    ) &&
    appSource.includes("const nextTurn = derivedActiveTurn") &&
    appSource.includes(
      "const activeTurnId = workbench.activeTurn?.id ?? derivedActiveTurn?.id",
    ) &&
    appSource.includes("const freshEvents = deferredEventsForTurn.filter") &&
    appSource.includes("let latestUserIndex = -1") &&
    appSource.includes("index = Math.max(0, latestUserIndex)") &&
    appSource.includes('if (event.kind !== "plan-updated")') &&
    !appSource.includes(
      'events.filter((event) => event.kind === "plan-updated")',
    ) &&
    providerStreamSource.includes("appendChatResponseDelta") &&
    providerStreamSource.includes("events.findIndex") &&
    providerStreamSource.includes("CHAT_RESPONSE_TRUNCATION_SUFFIX") &&
    appSource.includes("isStreamingAssistantSessionEvent") &&
    !appSource.includes("[...events]\n    .reverse()") &&
    appSource.includes(
      "}, [workbench.preferences.density, workbench.preferences.theme]);",
    ) &&
    appSource.includes("WORKBENCH_PERSIST_DEBOUNCE_MS") &&
    appSource.includes("WORKBENCH_PERSIST_IDLE_TIMEOUT_MS") &&
    appSource.includes("persistableWorkbenchState") &&
    appSource.includes("flushPersistedWorkbenchState") &&
    appSource.includes("schedulePersistedWorkbenchStateFlush") &&
    appSource.includes("cancelPersistedWorkbenchStateFlush") &&
    appSource.includes("const persistableWorkbench = useMemo") &&
    appSource.includes(
      "pendingWorkbenchPersistRef.current = persistableWorkbench",
    ) &&
    appSource.includes("workbenchPersistIdleRef") &&
    appSource.includes("requestIdleCallback") &&
    appSource.includes("JSON.stringify(pending)") &&
    !appSource.includes("pendingWorkbenchPersistRef.current = workbench") &&
    !appSource.includes("JSON.stringify(persistableWorkbenchState(pending))") &&
    appSource.includes("MAX_PERSISTED_TERMINAL_OUTPUT_CHARS") &&
    appSource.includes("activeTurn: undefined") &&
    appSource.includes("areWorkbenchTurnsEqual") &&
    appSource.includes("const eventsRef = useRef<SessionEvent[]>([])") &&
    appSource.includes("eventsRef.current = events") &&
    appSource.includes("eventsRef.current.find(") &&
    !appSource.includes("[connectProvider, events, sendDraft]") &&
    providerStreamSource.includes('kind: "provider-stream"') &&
    providerStreamSource.includes("hasSameTurnAssistant") &&
    appSource.includes("suggestTitle: shouldSuggestTitle") &&
    appSource.includes('kind: "provider-status"') &&
    surfaceSource.includes("ChatThinkingIndicator") &&
    surfaceSource.includes("deriveTranscriptState") &&
    surfaceSource.includes("useDeferredValue") &&
    surfaceSource.includes("const deferredEvents = useDeferredValue(events)") &&
    surfaceSource.includes("const transcriptContent = useMemo") &&
    surfaceSource.includes(
      "const [localDraft, setLocalDraft] = useState(draft)",
    ) &&
    surfaceSource.includes("onSend(localDraft)") &&
    surfaceSource.includes("const ChatEvent = memo") &&
    surfaceSource.includes("const transcriptState = useMemo") &&
    surfaceSource.includes("const transcriptEvents: SessionEvent[] = []") &&
    surfaceSource.includes("hasAssistantForLatestTurn = false") &&
    surfaceSource.includes("isStreamingAssistantEvent") &&
    surfaceSource.includes("ASSISTANT_RESPONSE_RICH_PARSE_MAX_CHARS") &&
    surfaceSource.includes("const shouldUsePlainText") &&
    surfaceSource.includes(
      "event.message.length > ASSISTANT_RESPONSE_RICH_PARSE_MAX_CHARS",
    ) &&
    surfaceSource.includes("gyro-response-streaming-text") &&
    styleSource.includes(".gyro-response-streaming-text") &&
    surfaceSource.includes("gyro-chat-thinking-indicator") &&
    styleSource.includes("@keyframes gyro-chat-thinking-dot") &&
    styleSource.includes(".gyro-chat-transcript .gyro-message.is-thinking") &&
    surfaceSource.includes("isInternalTranscriptEvent") &&
    surfaceSource.includes('"provider-diagnostics"') &&
    styleSource.includes(
      ".gyro-chat-transcript .gyro-message.is-assistant:hover .gyro-response-actions",
    ) &&
    typeSource.includes("ProviderChatStreamEvent") &&
    typeSource.includes("ProviderResumeCursor") &&
    tauriSource.includes("SessionEventKind::AssistantMessage") &&
    tauriSource.includes("ProviderResumeCursor") &&
    tauriSource.includes("ProviderChatStreamEvent") &&
    tauriSource.includes("run_provider_chat_with_retry") &&
    tauriSource.includes("run_provider_chat_once") &&
    tauriSource.includes("TEXT_TRUNCATION_SUFFIX") &&
    tauriSource.includes("value.char_indices().nth(max_chars)") &&
    tauriSource.includes("assistant_text_truncated") &&
    tauriSource.includes("streaming_state_stops_emitting_after_response_cap") &&
    tauriSource.includes("run_anthropic_claude_chat") &&
    tauriSource.includes("codex_chat_args") &&
    tauriSource.includes("claude_chat_args") &&
    tauriSource.includes("extract_provider_session_id") &&
    tauriSource.includes("enum ProviderTextChunk") &&
    tauriSource.includes("ProviderTextChunk::Snapshot") &&
    tauriSource.includes("push_assistant_snapshot") &&
    tauriSource.includes("extract_provider_text_value") &&
    tauriSource.includes('Some("reasoning" | "reasoning_text")') &&
    tauriSource.includes("extract_provider_text_delta") &&
    tauriSource.includes("PROVIDER_CHAT_EVENT") &&
    tauriSource.includes("clear_provider_session_binding") &&
    tauriSource.includes("upsert_provider_session_binding") &&
    tauriSource.includes("validate_chat_message") &&
    tauriSource.includes("async fn run_provider_chat") &&
    /spawn_blocking\(move \|\| run_provider_chat_blocking\(app,\s*request\)\)/.test(
      tauriSource,
    ) &&
    tauriSource.includes("async fn save_config") &&
    tauriSource.includes("config save worker failed") &&
    tauriSource.includes("async fn create_desktop_session") &&
    tauriSource.includes("create_desktop_session_blocking") &&
    tauriSource.includes("desktop session worker failed") &&
    tauriSource.includes("async fn create_worktree_session") &&
    tauriSource.includes("create_worktree_session_blocking") &&
    tauriSource.includes("worktree session worker failed") &&
    tauriSource.includes("async fn append_user_message") &&
    tauriSource.includes("append_user_message_blocking") &&
    tauriSource.includes("user message worker failed") &&
    tauriSource.includes("async fn set_session_model") &&
    tauriSource.includes("session model worker failed") &&
    tauriSource.includes("async fn rename_session") &&
    tauriSource.includes("session rename worker failed") &&
    tauriSource.includes("extract_session_title_marker") &&
    tauriSource.includes("GYRO_SESSION_TITLE:") &&
    tauriSource.includes("run_streaming_command") &&
    tauriSource.includes("PROVIDER_STREAM_FLUSH_INTERVAL") &&
    tauriSource.includes("StreamingCommandState") &&
    tauriSource.includes("stdin(Stdio::null())") &&
    tauriSource.includes("sanitize_provider_text_delta") &&
    tauriSource.includes("extract_codex_agent_message_text") &&
    tauriSource.includes('"item.completed"') &&
    tauriSource.includes("CODEX_CHAT_TIMEOUT_SECS") &&
    tauriSource.includes("ProviderRunPayload::new") &&
    tauriSource.includes("Some(chat_message_preview(&request.message))") &&
    tauriSource.includes("async fn list_sessions") &&
    tauriSource.includes("list_sessions_blocking") &&
    tauriSource.includes("session list worker failed") &&
    tauriSource.includes("async fn delete_session") &&
    tauriSource.includes("delete_session_blocking") &&
    tauriSource.includes("session delete worker failed") &&
    tauriSource.includes("async fn append_plan_event") &&
    tauriSource.includes("append_plan_event_blocking") &&
    tauriSource.includes("plan event worker failed") &&
    tauriSource.includes("async fn append_editor_event") &&
    tauriSource.includes("append_editor_event_blocking") &&
    tauriSource.includes("editor event worker failed") &&
    tauriSource.includes("async fn list_workspace_files") &&
    tauriSource.includes("async fn list_workspace_tree") &&
    tauriSource.includes("list_workspace_tree_blocking") &&
    tauriSource.includes("workspace tree worker failed") &&
    tauriSource.includes("async fn read_workspace_file") &&
    tauriSource.includes("workspace file read worker failed") &&
    tauriSource.includes("async fn read_workspace_file_full") &&
    tauriSource.includes("full workspace file read worker failed") &&
    tauriSource.includes("async fn stat_workspace_file") &&
    tauriSource.includes("workspace file stat worker failed") &&
    tauriSource.includes("async fn write_workspace_file") &&
    tauriSource.includes("workspace file write worker failed") &&
    tauriSource.includes("async fn watch_workspace") &&
    tauriSource.includes("workspace watch worker failed") &&
    tauriSource.includes("async fn create_workspace_file") &&
    tauriSource.includes("workspace file create worker failed") &&
    tauriSource.includes("async fn rename_workspace_path") &&
    tauriSource.includes("workspace path rename worker failed") &&
    tauriSource.includes("async fn delete_workspace_path") &&
    tauriSource.includes("workspace path delete worker failed") &&
    tauriSource.includes("async fn search_workspace") &&
    tauriSource.includes("workspace search worker failed") &&
    tauriSource.includes("async fn git_status") &&
    tauriSource.includes("git status worker failed") &&
    tauriSource.includes("async fn git_diff") &&
    tauriSource.includes("git_diff_blocking") &&
    tauriSource.includes("git diff worker failed") &&
    tauriSource.includes("async fn git_stage") &&
    tauriSource.includes("git_stage_blocking") &&
    tauriSource.includes("git stage worker failed") &&
    tauriSource.includes("async fn git_unstage") &&
    tauriSource.includes("git_unstage_blocking") &&
    tauriSource.includes("git unstage worker failed") &&
    tauriSource.includes("async fn git_discard") &&
    tauriSource.includes("git_discard_blocking") &&
    tauriSource.includes("git discard worker failed") &&
    tauriSource.includes("async fn git_commit") &&
    tauriSource.includes("git_commit_blocking") &&
    tauriSource.includes("git commit worker failed") &&
    tauriSource.includes("async fn lsp_start") &&
    tauriSource.includes("struct LanguageServerManager") &&
    tauriSource.includes("receive_lsp_response") &&
    tauriSource.includes("write_lsp_message") &&
    tauriSource.includes("async fn task_discover") &&
    tauriSource.includes("task discover worker failed") &&
    tauriSource.includes("async fn task_run") &&
    tauriSource.includes("task_run_blocking") &&
    tauriSource.includes("task run worker failed") &&
    tauriSource.includes("async fn test_discover") &&
    tauriSource.includes("test discover worker failed") &&
    tauriSource.includes("async fn test_run") &&
    tauriSource.includes("test_run_blocking") &&
    tauriSource.includes("test run worker failed") &&
    tauriSource.includes("async fn debug_start") &&
    tauriSource.includes("struct DebugAdapterManager") &&
    tauriSource.includes("impl DebugAdapterManager") &&
    tauriSource.includes("fn start(&self, request: DebugStartRequest)") &&
    tauriSource.includes("manager.start(request).map_err(to_string)") &&
    tauriSource.includes("receive_dap_response") &&
    tauriSource.includes("handle_dap_adapter_request") &&
    tauriSource.includes("redact_json_strings") &&
    tauriSource.includes("async fn check_provider_health") &&
    tauriSource.includes("check_provider_health_blocking") &&
    tauriSource.includes("provider health worker failed") &&
    tauriSource.includes("async fn check_provider_auth") &&
    tauriSource.includes("provider auth worker failed") &&
    coreSessionsSource.includes("MAX_SESSION_EVENT_MESSAGE_CHARS") &&
    coreSessionsSource.includes("MAX_SESSION_EVENTS_READ") &&
    coreSessionsSource.includes("read_recent_events") &&
    coreSessionsSource.includes("VecDeque") &&
    tauriSource.includes("MAX_DESKTOP_SESSION_EVENTS_READ") &&
    tauriSource.includes("async fn read_session_events") &&
    tauriSource.includes("read_session_events_blocking") &&
    tauriSource.includes("session event read worker failed") &&
    coreSessionsSource.includes("ProviderSessionBinding") &&
    coreSessionsSource.includes("provider_session_bindings") &&
    coreSessionsSource.includes("get_provider_session_binding") &&
    coreHarnessSource.includes("MAX_HARNESS_RESUME_CURSOR_BYTES") &&
    coreHarnessSource.includes("validate_provider_resume_cursor_value") &&
    coreSessionsSource.includes("session_events_path") &&
    coreSessionsSource.includes(
      "set provider_id = ?1, provider_label = ?2, model_id = ?3, model_label = ?4",
    ) &&
    !coreSessionsSource.includes("model_label = ?4, updated_at") &&
    coreSessionsSource.includes(
      "update sessions set title = ?1 where id = ?2",
    ) &&
    !coreSessionsSource.includes(
      "update sessions set title = ?1, updated_at",
    ) &&
    !tauriSource.includes('"userMessage": request.message.as_str()') &&
    tauriSource.includes("codex") &&
    tauriSource.includes("exec") &&
    tauriSource.includes("claude") &&
    tauriSource.includes("stream-json") &&
    !appSource.includes("I can keep this local. Connect a provider") &&
    !appSource.includes("shouldPreviewToolActivity"),
  "First send should create an optimistic thread, call the real provider runner, and persist assistant responses instead of fake previews.",
);
expect(
  appSource.includes('"New chat"') &&
    appSource.includes("normalizeSessionTitleInput") &&
    appSource.includes(
      "updateSessionTitle(activeSessionId, provisionalTitle",
    ) &&
    styleSource.includes(".gyro-session-row.is-active .gyro-session-actions") &&
    styleSource.includes(
      ".gyro-session-row.is-active .gyro-sidebar-thread-main",
    ) &&
    surfaceSource.includes('aria-label="Chat options"') &&
    surfaceSource.includes("<MoreHorizontal size={15} />") &&
    surfaceSource.includes(
      '<button onClick={onRename} role="menuitem" type="button">',
    ) &&
    surfaceSource.includes("Rename"),
  "Chat sessions should get first-turn titles and expose rename from the active row three-dot menu.",
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
  providerCatalog.every((provider) => provider.enabled === false),
  "Fallback provider configs should not start enabled before setup.",
);
expect(
  !surfaceSource.includes("mock-polish") &&
    !surfaceSource.includes("mock-shell") &&
    surfaceSource.includes('aria-label="No terminal panes"') &&
    surfaceSource.includes('"gyro-terminal-workspace is-empty"') &&
    surfaceSource.includes("gyro-terminal-toolbar is-empty") &&
    surfaceSource.includes("AgentLauncherMenu") &&
    surfaceSource.includes('className="gyro-terminal-agent-button"') &&
    surfaceSource.includes(
      'hasPanes ? (\n          <div className="gyro-terminal-tools">',
    ) &&
    styleSource.includes(".gyro-terminal-toolbar.is-empty") &&
    styleSource.includes("align-self: center") &&
    styleSource.includes("justify-self: center") &&
    styleSource.includes("var(--gyro-premium-hairline-strong)") &&
    styleSource.includes(".gyro-terminal-preset-button > svg") &&
    styleSource.includes("flex: 0 0 auto") &&
    styleSource.includes("padding: 0 12px") &&
    surfaceSource.includes("<Plus size={14} />"),
  "CLI empty state should center only the two launch controls.",
);
expect(
  surfaceSource.includes("const canStopActivePane =") &&
    surfaceSource.includes('aria-label="Split terminal"') &&
    surfaceSource.includes('aria-label="Stop active terminal"') &&
    surfaceSource.includes("<Command size={15} />") &&
    surfaceSource.includes("<Columns2 size={15} />") &&
    surfaceSource.includes("<Square size={14} />"),
  "CLI toolbar icons should match commands, splitting, and stopping a live terminal.",
);
expect(
  styleSource.includes(
    ".gyro-workspace-tool-panel.is-primary .gyro-terminal-grid",
  ) &&
    styleSource.includes("grid-template-columns: repeat(2, minmax(0, 1fr))") &&
    styleSource.includes("overflow-x: hidden") &&
    styleSource.includes("overflow-y: auto") &&
    styleSource.includes(
      ".gyro-terminal-pane:nth-child(odd):last-child:not(",
    ) &&
    styleSource.includes(
      '.gyro-terminal-grid:not(:has(> .gyro-terminal-pane[data-layout="wide"]))',
    ) &&
    styleSource.includes("grid-column: 1 / -1"),
  "Odd primary terminal counts should expand the final pane across the full row.",
);
expect(
  typeSource.includes(
    'export type TerminalPaneLayout = "auto" | "wide" | "compact"',
  ) &&
    reducerSource.includes('case "set-terminal-pane-layout"') &&
    appSource.includes('type: "set-terminal-pane-layout"') &&
    surfaceSource.includes("Expand row") &&
    surfaceSource.includes("Fit to grid") &&
    surfaceSource.includes("Move first") &&
    surfaceSource.includes("Move last") &&
    surfaceSource.includes('data-layout={pane.layout ?? "auto"}') &&
    styleSource.includes('.gyro-terminal-pane[data-layout="wide"]') &&
    styleSource.includes('.gyro-terminal-pane[data-layout="compact"]'),
  "Terminal panes should support persisted structural layout and movement actions.",
);
expect(
  surfaceSource.includes("gyro-sidebar-terminal-close") &&
    surfaceSource.includes("gyro-terminal-pane-close") &&
    surfaceSource.includes("onCloseTerminalPane?.(pane.id)") &&
    appSource.includes("onCloseTerminalPane={requestCloseTerminalPane}") &&
    styleSource.includes(
      ".gyro-terminal-pane.is-active .gyro-terminal-pane-close",
    ) &&
    styleSource.includes(
      ".gyro-sidebar-terminal-row:hover .gyro-sidebar-terminal-close",
    ),
  "Terminal panes should expose minimal close controls in the grid and sidebar.",
);
expect(
  surfaceSource.includes("TerminalTerminateConfirmOverlay") &&
    surfaceSource.includes("Terminate terminal?") &&
    surfaceSource.includes('role="alertdialog"') &&
    appSource.includes('pane.status === "running"') &&
    appSource.includes('pane.status === "waiting"') &&
    appSource.includes("terminalTerminateCandidate") &&
    styleSource.includes(".gyro-terminal-terminate-card"),
  "Running terminal panes should confirm before their PTY is terminated.",
);
expect(
  typeSource.includes(
    'export type TerminalPaneAttention = "waiting" | "failed"',
  ) &&
    typeSource.includes("workingDirectory?: string") &&
    typeSource.includes("statsPartial: boolean") &&
    reducerSource.includes('case "set-terminal-pane-attention"') &&
    surfaceSource.includes("TerminalDiffControl") &&
    surfaceSource.includes("gyro-terminal-diff-popover") &&
    surfaceSource.includes("Review in IDE") &&
    surfaceSource.includes("gyro-terminal-attention is-waiting") &&
    surfaceSource.includes("gyro-terminal-attention is-failed") &&
    styleSource.includes(".gyro-terminal-awareness") &&
    styleSource.includes(".gyro-terminal-diff-stats") &&
    styleSource.includes(".gyro-terminal-pane.needs-waiting") &&
    appSource.includes("terminalSourceControlByPane") &&
    appSource.includes("terminalSourceControlRequestRef") &&
    appSource.includes("openSourceControlDiffForRoot") &&
    appSource.includes("terminal.onBell") &&
    tauriSource.includes("apply_git_diff_stats") &&
    tauriSource.includes("untracked_text_additions"),
  "The CLI awareness layer should show selected-pane Git changes and exceptional terminal attention.",
);
expect(
  appSource.includes("TerminalPaneSnapshot[]") &&
    appSource.includes("TerminalPaneSnapshot") &&
    appSource.includes("LiveTerminalPaneBody") &&
    appSource.includes("launchCliPreset") &&
    appSource.includes("launchTerminalPane") &&
    appSource.includes("@xterm/xterm") &&
    appSource.includes("@xterm/addon-fit") &&
    appSource.includes("selectedTerminalPaneIdRef") &&
    appSource.includes("TERMINAL_CHAT_BUSY_POLL_INTERVAL_MS") &&
    appSource.includes("const terminalPaneIdsToPoll = useMemo") &&
    appSource.includes("isActiveSessionSending") &&
    appSource.includes("liveTerminalPaneIds.includes(selectedPaneId)") &&
    appSource.includes("const pollInterval = isActiveSessionSending") &&
    appSource.includes("selectedPaneId === snapshot.paneId") &&
    appSource.includes("current === snapshot.output ? current") &&
    appSource.includes("restore_terminal_panes") &&
    appSource.includes("write_terminal_input") &&
    appSource.includes("resize_terminal_pane") &&
    tauriSource.includes(
      "#[derive(Clone, Default)]\nstruct TerminalProcessManager",
    ) &&
    tauriSource.includes("async fn create_terminal_pane") &&
    tauriSource.includes("terminal create worker failed") &&
    tauriSource.includes("async fn write_terminal_input") &&
    tauriSource.includes("terminal input worker failed") &&
    tauriSource.includes("async fn read_terminal_output") &&
    tauriSource.includes("terminal read worker failed") &&
    tauriSource.includes("async fn resize_terminal_pane") &&
    tauriSource.includes("terminal resize worker failed") &&
    tauriSource.includes("async fn stop_terminal_pane") &&
    tauriSource.includes("terminal stop worker failed") &&
    tauriSource.includes("async fn restart_terminal_pane") &&
    tauriSource.includes("terminal restart worker failed") &&
    tauriSource.includes("async fn restore_terminal_panes") &&
    tauriSource.includes("terminal restore worker failed") &&
    surfaceSource.includes("renderTerminalPaneBody") &&
    surfaceSource.includes("gyro-terminal-drag-handle") &&
    reducerSource.includes("upsert-restored-terminal-pane") &&
    reducerSource.includes("existingPane.command === nextCommand"),
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
const spawnTerminalSource = tauriSource.slice(
  tauriSource.indexOf("fn spawn_terminal_process"),
  tauriSource.indexOf("fn resolve_terminal_cwd"),
);
expect(
  tauriSource.includes("portable_pty") &&
    tauriSource.includes("native_pty_system") &&
    tauriSource.includes("PtySize") &&
    tauriSource.includes('"TERM", "xterm-256color"') &&
    tauriSource.includes('"COLORTERM", "truecolor"') &&
    tauriSource.includes('"TERM_PROGRAM", "Gyro"') &&
    tauriSource.includes('env_remove("NO_COLOR")') &&
    tauriSource.includes('"CLICOLOR_FORCE", "1"') &&
    tauriSource.includes('"FORCE_COLOR", "1"') &&
    tauriSource.includes("terminal_command_path") &&
    !spawnTerminalSource.includes("Stdio::piped"),
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
    appSource.includes("gyro-account-context") &&
    appSource.includes("Use this device") &&
    appSource.includes("refresh_account_session") &&
    appSource.includes("start_account_login") &&
    appSource.includes("logout_account") &&
    !appSource.includes("External Claude/OpenAI logins") &&
    !appSource.includes('className="gyro-account-provider"') &&
    styleSource.includes(".gyro-account-panel::before") &&
    styleSource.includes(".gyro-account-context") &&
    !styleSource.includes(".gyro-account-provider") &&
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
    !styleSource.includes(
      ".gyro-app-shell:has(.gyro-workspace-route.is-code) .gyro-sidebar {",
    ) &&
    !styleSource.includes(
      ".gyro-app-shell:has(.gyro-workspace-route.is-code) .gyro-sidebar-mode-group",
    ) &&
    tauriConfigSource.includes('"titleBarStyle": "Overlay"') &&
    tauriConfigSource.includes('"hiddenTitle": true') &&
    tauriConfigSource.includes('"trafficLightPosition"') &&
    surfaceSource.includes("New chat") &&
    surfaceSource.includes('aria-label="Workspace modes"') &&
    surfaceSource.includes("function restingSidebarWidth()") &&
    surfaceSource.includes("ideSidebarMinimumWidth * 2") &&
    surfaceSource.includes('aria-label="Resize IDE sidebar"') &&
    surfaceSource.includes('role="separator"') &&
    surfaceSource.includes("onDoubleClick") &&
    surfaceSource.includes("resizeIdeSidebarWithKeyboard") &&
    surfaceSource.includes("requestAnimationFrame") &&
    surfaceSource.includes("appShellRef.current?.style.setProperty") &&
    styleSource.includes(".gyro-ide-sidebar-resizer") &&
    styleSource.includes("grid-template-columns 180ms") &&
    styleSource.includes("will-change: grid-template-columns") &&
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
    !surfaceSource.includes("meta={String(commandProfiles.length)}") &&
    !surfaceSource.includes("visibleCommandProfiles") &&
    surfaceSource.includes('title="Explorer"') &&
    surfaceSource.includes('title="Code tools"') &&
    !surfaceSource.includes("Run terminal") &&
    !surfaceSource.includes("Split pane") &&
    !surfaceSource.includes("Command search") &&
    surfaceSource.includes("Diff review") &&
    surfaceSource.includes("Browser preview") &&
    !surfaceSource.includes('title="Chats"') &&
    !surfaceSource.includes("primarySidebarActionForLayout") &&
    !surfaceSource.includes('<SidebarSection title="Layouts">'),
  "Mode-specific sidebar should keep overlay chrome while giving Chat, CLI, and IDE distinct content.",
);

expect(
  surfaceSource.includes("function AgentLauncherMenu") &&
    surfaceSource.includes("function TerminalActionsMenu") &&
    surfaceSource.includes("onRunCommandProfile?.(profile.id)") &&
    surfaceSource.includes("<span>Quick Start</span>") &&
    surfaceSource.includes("cliProfileShortLabel") &&
    surfaceSource.includes("gyro-profile-readiness-dot") &&
    !surfaceSource.includes(
      'className="gyro-agent-launcher-heading">Start a terminal',
    ) &&
    surfaceSource.includes("Setup needed") &&
    surfaceSource.includes("New Terminal") &&
    surfaceSource.includes("Start Codex CLI") &&
    surfaceSource.includes("Start Claude Code") &&
    surfaceSource.includes("Set CLI launch preset") &&
    surfaceSource.includes("Refresh output") &&
    surfaceSource.includes("Close pane") &&
    !surfaceSource.includes('aria-label="Run selected command profile"') &&
    !surfaceSource.includes('className="gyro-terminal-add"') &&
    appSource.includes("const runCommandProfile = useCallback") &&
    appSource.includes("setActiveProfileId(profileId)") &&
    appSource.includes("void runProfile(profileId)") &&
    appSource.includes("onRunCommandProfile={runCommandProfile}") &&
    appSource.includes('case "configure-cli-launcher"') &&
    styleSource.includes(".gyro-agent-launcher-menu") &&
    styleSource.includes(".gyro-terminal-agent-button") &&
    styleSource.includes(".gyro-terminal-actions-menu"),
  "CLI toolbar agent launcher should start real command profiles while the sidebar stays pane-only.",
);

expect(
  appSource.includes('import { openUrl } from "@tauri-apps/plugin-opener"') &&
    appSource.includes("openBrowserPreviewExternal") &&
    surfaceSource.includes('title="Local browser preview"') &&
    surfaceSource.includes("normalizedBrowserPreviewUrl") &&
    surfaceSource.includes("<iframe") &&
    !surfaceSource.includes("gyro-browser-skeleton") &&
    !surfaceSource.includes("Screenshot {preview.screenshotCount}") &&
    reducerSource.includes('url: "http://localhost:3000"') &&
    tauriConfigSource.includes("frame-src http://localhost:*") &&
    tauriConfigSource.includes("http://127.0.0.1:*") &&
    styleSource.includes(".gyro-browser-page iframe"),
  "Browser preview should render a real local URL and open it externally without simulated screenshot chrome.",
);

expect(
  appSource.includes("const started = await launchTerminalPane") &&
    appSource.includes("agent failed to start") &&
    appSource.includes("task.terminalPaneId") &&
    appSource.includes("Automation running") &&
    surfaceSource.includes("Move to todo") &&
    surfaceSource.includes("Move to review") &&
    surfaceSource.includes('label: "Open providers"') &&
    !surfaceSource.includes('id: "dispatch-agent"') &&
    !surfaceSource.includes('aria-label="Dictate message"') &&
    !surfaceSource.includes("onClick={() => undefined}") &&
    !appSource.includes("Coming soon"),
  "Visible task, automation, provider, chat, and IDE controls should execute or be omitted instead of acting as placeholders.",
);

expect(
  roadmapSource.includes("Private Alpha Exit Gate") &&
    roadmapSource.includes("Partially implemented and still gated") &&
    readinessAuditSource.includes("Functional Readiness Matrix") &&
    readinessAuditSource.includes("Highest-Risk Gaps"),
  "The roadmap should distinguish implemented foundations from private-alpha blockers.",
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
  styleSource.includes(".gyro-sidebar-mode-row:focus-visible") &&
    styleSource.includes(
      ".gyro-app-shell.is-chat-shell .gyro-sidebar-mode-row:focus-visible",
    ) &&
    styleSource.includes(
      "box-shadow: inset 0 0 0 0.5px var(--gyro-premium-hairline-soft)",
    ),
  "Sidebar Chat/CLI/IDE tabs should keep a quiet active/focus state without the underglow.",
);
expect(
  appSource.includes("REMOVED_PROJECTS_STORAGE_KEY") &&
    appSource.includes("visibleSessionsForProjects") &&
    appSource.includes("requestRemoveProject") &&
    appSource.includes("confirmRemoveProject") &&
    appSource.includes("ProjectRemoveConfirmOverlay") &&
    surfaceSource.includes("onRemoveProject") &&
    surfaceSource.includes("gyro-sidebar-project-remove") &&
    surfaceSource.includes("remove-saved-project:") &&
    surfaceSource.includes("removeAction") &&
    surfaceSource.includes("Trash2") &&
    surfaceSource.includes("Remove from Gyro app?") &&
    surfaceSource.includes("Nothing will be deleted from your Mac.") &&
    surfaceSource.includes("Remove from app") &&
    styleSource.includes(".gyro-project-remove-overlay") &&
    styleSource.includes(".gyro-project-remove-note") &&
    styleSource.includes(".gyro-project-remove-confirm") &&
    styleSource.includes(".gyro-project-remove-keep"),
  "Projects should expose a remove-from-app action with a screen-level confirmation that does not imply local deletion.",
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
    surfaceSource.includes('aria-label="Search settings"') &&
    surfaceSource.includes("gyro-settings-sidebar-group") &&
    surfaceSource.includes("No settings found") &&
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
    !styleSource.includes("button:not(.gyro-pane-add):not(.is-active)"),
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
    surfaceSource.includes("diffAdditions") &&
    surfaceSource.includes("diffDeletions") &&
    surfaceSource.includes("gyro-thread-diff-pill") &&
    surfaceSource.includes('onOpenToolPanel?.("diff")') &&
    styleSource.includes(".gyro-thread-diff-pill em.is-added") &&
    styleSource.includes(".gyro-thread-diff-pill em.is-removed") &&
    appSource.includes("savedProjectsFromSessions") &&
    appSource.includes("select-saved-project:") &&
    surfaceSource.includes("savedProjectItems") &&
    surfaceSource.includes(
      "select-saved-project:${encodeURIComponent(project.path)}",
    ) &&
    surfaceSource.includes("if (isInternalTranscriptEvent(event))") &&
    surfaceSource.includes("gyro-provider-status-row") &&
    styleSource.includes(".gyro-thread-topbar-actions") &&
    styleSource.includes(".gyro-chat-composer-dock .gyro-composer-shell") &&
    surfaceSource.includes('popoverPlacement="up"') &&
    surfaceSource.includes('variant="hero"') &&
    styleSource.includes(".gyro-composer-shell textarea:focus-visible") &&
    styleSource.includes(
      ".gyro-chat-composer-dock .gyro-composer-shell:focus-within",
    ) &&
    styleSource.includes(
      ".gyro-chat-composer-dock .gyro-composer-shell.is-hero.has-provider",
    ) &&
    styleSource.includes("width: min(820px, calc(100vw - 96px))") &&
    surfaceSource.includes("!event.shiftKey") &&
    surfaceSource.includes("event.preventDefault()") &&
    styleSource.includes("--gyro-chat-content-width: 735px") &&
    styleSource.includes("max-width: var(--gyro-chat-content-width)") &&
    styleSource.includes("border-radius: 21px") &&
    styleSource.includes("color: #ff8a3d") &&
    styleSource.includes(
      ".gyro-chat-start .gyro-composer-shell:focus-within .gyro-composer-bar",
    ) &&
    styleSource.includes("border-color: #45474d") &&
    styleSource.includes(
      "grid-template-columns: minmax(0, 1fr) minmax(288px, 316px)",
    ) &&
    surfaceSource.includes("function AssistantResponse") &&
    surfaceSource.includes("gyro-response-body") &&
    surfaceSource.includes('aria-label="Copy response"') &&
    styleSource.includes(".gyro-chat-transcript .gyro-message.is-user") &&
    styleSource.includes("width: min(100%, var(--gyro-chat-content-width))") &&
    styleSource.includes("max-width: 100%") &&
    styleSource.includes("pointer-events: none") &&
    surfaceSource.includes("isUser || isAssistant ? null") &&
    !surfaceSource.includes("<strong>Workbench activity</strong>") &&
    !surfaceSource.includes("Open terminal\n          </button>"),
  "First chat should default to a clean Codex-style thread with topbar pills, provider status recovery, and matching docked composer.",
);
expect(
  reducerSource.includes("activeChatPanel: panel") &&
    reducerSource.includes(
      'chatEnvironmentRailOpen: panel === "environment"',
    ) &&
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
    surfaceSource.includes("startProjectLabel") &&
    surfaceSource.includes("gyroLogoTransparentDark") &&
    surfaceSource.includes("gyroLogoTransparentLight") &&
    surfaceSource.includes("gyro-chat-start-brand-word") &&
    surfaceSource.includes(
      'style={{ width: "min(860px, calc(100vw - 96px))" }}',
    ) &&
    surfaceSource.includes('width: "min(820px, calc(100vw - 96px))"') &&
    styleSource.includes("width: min(860px, calc(100vw - 96px))") &&
    styleSource.includes("width: min(820px, 100%)") &&
    surfaceSource.includes("What should we do in ") &&
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
    appSource.includes("configSaveQueueRef.current") &&
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
    surfaceSource.includes("providerAuthSummary(provider.id)") &&
    !surfaceSource.includes('label="Selected model"') &&
    !surfaceSource.includes('className="gyro-provider-model-picker"') &&
    !surfaceSource.includes("Refresh models") &&
    appSource.includes("onTestProvider={testProvider}") &&
    styleSource.includes(".gyro-settings-provider-actions") &&
    styleSource.includes("/* Minimal provider settings */") &&
    styleSource.includes(
      ".gyro-providers-surface {\n  align-content: start;",
    ) &&
    styleSource.includes("overflow-y: auto") &&
    styleSource.includes("padding: 24px clamp(24px, 3vw, 44px) 120px") &&
    styleSource.includes(".gyro-provider-boundary {\n  display: none;") &&
    styleSource.includes(
      ".gyro-provider-card-body .gyro-settings-row {\n  background: transparent;",
    ) &&
    styleSource.includes(".gyro-settings-surface .gyro-provider-list") &&
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
    !surfaceSource.includes("connect-provider:${modelPickerProvider.id}") &&
    !surfaceSource.includes('kind: "action"') &&
    surfaceSource.includes(
      "(provider) => provider.id === config.selectedProviderId",
    ) &&
    surfaceSource.includes(
      "active: isConnected && provider.id === config.selectedProviderId",
    ) &&
    surfaceSource.includes(
      'trailingLabel: isConnected ? undefined : "Unavailable"',
    ) &&
    surfaceSource.includes("showChevron: isConnected") &&
    surfaceSource.includes("disabled: !isConnected") &&
    surfaceSource.includes("item.providerId && !item.disabled") &&
    surfaceSource.includes(
      "modelPickerProvider.id === config.selectedProviderId",
    ) &&
    appSource.includes("selectProvider(providerId);") &&
    appSource.includes("{ notifySuccess: false }") &&
    !appSource.includes('"Model selected"') &&
    !surfaceSource.includes('action: "select-model"') &&
    styleSource.includes(".gyro-composer-menu-trailing") &&
    styleSource.includes(".gyro-composer-menu-item.is-provider:disabled") &&
    styleSource.includes(".gyro-provider-picker.has-flyout") &&
    styleSource.includes("grid-template-columns: 148px 176px"),
  "Provider picker should keep provider rows compact and show models in a hover flyout without Connect, Refresh, or Settings rows.",
);
expect(
  surfaceSource.includes("<ProviderLogo providerId={displayProvider.id} />") &&
    /const modelChipLabel =\s*hasSelectedProvider\s*\?\s*providerModelLabel\s*:\s*"Choose model"/.test(
      surfaceSource,
    ) &&
    surfaceSource.includes("sessionModel?.modelLabel") &&
    surfaceSource.includes("{modelChipLabel}") &&
    surfaceSource.includes('title="Provider"') &&
    !surfaceSource.includes("`${providerLabel} · ${providerModelLabel}`") &&
    styleSource.includes(".gyro-model-chip .gyro-provider-logo") &&
    !styleSource.includes(
      ".gyro-composer-menu-item:has(.gyro-provider-logo.is-anthropic):hover",
    ) &&
    !styleSource.includes(
      ".gyro-model-chip:has(.gyro-provider-logo.is-anthropic):hover",
    ),
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
    surfaceSource.includes('label: "File"') &&
    surfaceSource.includes('label: "Folder"') &&
    surfaceSource.includes('label: "Goal"') &&
    surfaceSource.includes('label: "Plan"') &&
    surfaceSource.includes('label: "Search"') &&
    surfaceSource.includes('title="Add"') &&
    !surfaceSource.includes('label: "Photos"') &&
    !surfaceSource.includes('label: "Spreadsheet"') &&
    !surfaceSource.includes('label: "Slides"') &&
    !surfaceSource.includes("Attach a folder or file") &&
    !surfaceSource.includes("Find commands and files") &&
    appSource.includes('case "select-file":') &&
    appSource.includes('case "add-plan":') &&
    !appSource.includes("Coming soon") &&
    appSource.includes('type: "set-chat-panel", panel: "plan"') &&
    styleSource.includes("min-height: 32px"),
  "Composer add popover should stay compact and expose only working context actions.",
);
expect(
  surfaceSource.includes("OpenAI permissions") &&
    surfaceSource.includes("Anthropic permissions") &&
    surfaceSource.includes("Default Permissions") &&
    surfaceSource.includes("Full Access") &&
    !surfaceSource.includes('action: "toggle-access"') &&
    !surfaceSource.includes("Codex settings") &&
    !surfaceSource.includes("Claude settings") &&
    surfaceSource.includes("Command policy") &&
    surfaceSource.includes("File edit policy") &&
    surfaceSource.includes("approvalChipClassName") &&
    surfaceSource.includes('approvalMode === "direct"') &&
    surfaceSource.includes('approvalMode !== "direct"') &&
    surfaceSource.includes('kind: "permission-direct"') &&
    styleSource.includes(".gyro-composer-menu-item.is-permission-direct") &&
    surfaceSource.includes('"gyro-composer-chip is-warning"') &&
    surfaceSource.includes("className={approvalChipClassName}") &&
    appSource.includes("approvalNotificationCopy"),
  "Permission controls should expose only Default Permissions and orange Full Access while keeping backend settings separate.",
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
    appSource.includes(
      'dispatchWorkbench({ type: "set-workbench-mode", mode: "local" });',
    ) &&
    appSource.includes("onCreateSession={startNewChat}") &&
    surfaceSource.includes("const transcriptState = useMemo") &&
    surfaceSource.includes("if (transcriptEvents.length === 0)") &&
    surfaceSource.includes('aria-label="New thread"'),
  "New chat should clear the active session, reset to local mode, and render the start screen from transcript events.",
);
expect(
  !surfaceSource.includes("pane-shell") &&
    !surfaceSource.includes("VITE ready") &&
    !surfaceSource.includes("3 changed") &&
    surfaceSource.includes('aria-label="No terminal panes"') &&
    surfaceSource.includes("hasPanes ? (") &&
    surfaceSource.includes("gyro-terminal-tools") &&
    surfaceSource.includes("No file selected") &&
    surfaceSource.includes("Loading file preview") &&
    appSource.includes(
      'invoke<WorkspaceFileContent>("read_workspace_file_full"',
    ) &&
    tauriSource.includes("write_workspace_file") &&
    appSource.includes("<MonacoEditorPane") &&
    surfaceSource.includes("renderEditor") &&
    surfaceSource.includes("gyro-editor-ai-bar") &&
    surfaceSource.includes("gyro-editor-contextbar") &&
    !surfaceSource.includes("gyro-editor-workbench-row"),
  "IDE and terminal panels should not seed fake activity or skip real file previews.",
);
expect(
  surfaceSource.includes("function EditorGroupPane") &&
    surfaceSource.includes('aria-label="Split editor down"') &&
    surfaceSource.includes('aria-label="Editor AI companion"') &&
    surfaceSource.includes("gyro-sidebar-explorer-toolbar") &&
    surfaceSource.includes('aria-label="New file"') &&
    surfaceSource.includes('aria-label="Source control message"') &&
    surfaceSource.includes('aria-label="Debug adapter command"') &&
    surfaceSource.includes("Discard all local changes in") &&
    surfaceSource.includes("task.id === test.id") &&
    appSource.includes("const createWorkspacePath = useCallback") &&
    appSource.includes("const renameWorkspacePath = useCallback") &&
    appSource.includes("const deleteWorkspacePath = useCallback") &&
    appSource.includes("const openSourceControlDiff = useCallback") &&
    appSource.includes("const startIdeDebugSession = useCallback") &&
    appSource.includes("const sendIdeDebugCommand = useCallback") &&
    appSource.includes("const stopIdeDebugSession = useCallback") &&
    appSource.includes('method: "textDocument/didOpen"') &&
    appSource.includes('method: "textDocument/didChange"') &&
    reducerSource.includes('case "ide-select-group"') &&
    reducerSource.includes('case "ide-set-language-server"') &&
    tauriSource.includes("impl LanguageServerManager") &&
    tauriSource.includes("spawn_lsp_message_reader") &&
    styleSource.includes(".gyro-editor-groups.is-split-right") &&
    styleSource.includes(".gyro-ide-assistant-composer"),
  "Core IDE controls should operate real editor groups, workspace files, Git review, AI context, and language-server lifecycles.",
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
  appSource.includes("drawBoldTextInBrightColors: true") &&
    appSource.includes("minimumContrastRatio: 2.6") &&
    appSource.includes('brightMagenta: "#f08cff"') &&
    appSource.includes('magenta: "#d86cff"') &&
    appSource.includes('brightYellow: "#ffd166"'),
  "Embedded CLI terminals should preserve visible ANSI accent colors.",
);

expect(
  !/green|is-green/i.test(surfaceSource) &&
    !/green|is-green/i.test(styleSource),
  "Gyro design surfaces should not use green palette names or green classes.",
);
expect(
  appSource.includes('activeWorkspaceLayout === "terminal-grid"') &&
    appSource.includes("renderWorkspaceToolPanel(true)") &&
    surfaceSource.includes('aria-label="Workspace tools"') &&
    surfaceSource.includes("{!isPrimary ? (") &&
    styleSource.includes(
      ".gyro-workspace-tool-panel.is-primary {\n  border-top: 0;\n  grid-template-rows: minmax(0, 1fr);",
    ),
  "Terminal Grid should use the shared panel body without the IDE tool-tab header.",
);
expect(
  surfaceSource.includes('activeTab === "terminal" && onAddPane') &&
    surfaceSource.includes('aria-label="New terminal"'),
  "The add control should appear only beside the terminal panel that it affects.",
);
expect(
  surfaceSource.includes("showEmbeddedPanel = true") &&
    appSource.includes("showEmbeddedPanel={false}") &&
    surfaceSource.includes('"is-workspace-shell"') &&
    surfaceSource.includes('"is-editor-only"') &&
    surfaceSource.includes("onOpenWorkspaceFile?.(file.path)") &&
    (appSource.includes("onOpenWorkspaceFile={openEditorFile}") ||
      appSource.includes("onOpenWorkspaceFile={openEditorLocation}")) &&
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

expect(
  surfaceSource.includes("data-active-mode={activeWorkspaceLayout}") &&
    styleSource.includes(
      '.gyro-sidebar-mode-group[data-active-mode="terminal-grid"]::before',
    ) &&
    styleSource.includes(
      '.gyro-sidebar-mode-group[data-active-mode="code"]::before',
    ) &&
    styleSource.includes("transition: transform var(--gyro-premium-motion)") &&
    styleSource.includes("@keyframes gyro-native-surface-enter"),
  "Workspace mode switching should use the shared sliding indicator and restrained surface motion.",
);

expect(
  (styleSource.match(/^:root\s*\{/gm) ?? []).length === 1 &&
    styleSource.includes(
      "--gyro-premium-hairline: rgba(225, 233, 244, 0.075)",
    ) &&
    styleSource.includes("--gyro-premium-radius-md: 7px") &&
    styleSource.includes("--gyro-premium-motion: 130ms") &&
    styleSource.includes("--gyro-accent: #7aa7ff") &&
    styleSource.includes(':root[data-theme="light"]') &&
    styleSource.includes("--gyro-premium-hairline: rgba(23, 27, 34, 0.1)") &&
    styleSource.includes("--gyro-accent: #356fd6"),
  "The premium graphite system should keep one token authority with thin hairlines, fast motion, and dark/light accent parity.",
);

expect(
  styleSource.includes(
    "grid-template-rows: 34px 28px 25px 34px minmax(0, 1fr)",
  ) &&
    styleSource.includes(".gyro-ide-editor-stack.is-editor-only") &&
    styleSource.includes("height: 22px") &&
    styleSource.includes(".gyro-code-surface .monaco-editor-background"),
  "The IDE shell should reserve all five editor rows and keep the status bar constrained.",
);

expect(
  styleSource.includes("@media (prefers-reduced-motion: reduce)") &&
    styleSource.includes("animation-duration: 1ms !important") &&
    styleSource.includes("transition-duration: 1ms !important"),
  "Premium motion should respect the system reduced-motion preference.",
);

expect(
  appSource.includes("theme={workbench.preferences.theme}") &&
    appSource.includes("function terminalThemeFor") &&
    appSource.includes("terminal.options.theme = terminalThemeFor(theme)") &&
    appSource.includes('background: "#ffffff"') &&
    appSource.includes('background: "#101722"') &&
    appSource.includes('brightMagenta: "#f08cff"') &&
    appSource.includes('brightYellow: "#ffd166"'),
  "Live terminals should update their xterm palette in place for dark and light themes.",
);

expect(
  styleSource.includes(
    ".gyro-chat-start .gyro-composer-shell.is-hero.has-provider",
  ) &&
    styleSource.includes(
      ".gyro-composer-shell.is-hero.has-provider\n  > .gyro-composer-bar",
    ) &&
    styleSource.includes(
      ".gyro-composer-shell.is-hero.has-provider\n  > .gyro-composer-context-row",
    ) &&
    styleSource.includes("Hero composer: one coherent surface") &&
    styleSource.includes(
      "border-top: 1px solid var(--gyro-premium-hairline-soft)",
    ),
  "The hero composer should render as one bordered surface without nested card borders.",
);

for (const heroThemeToken of [
  "--gyro-hero-heading",
  "--gyro-hero-composer",
  "--gyro-hero-context",
  "--gyro-hero-border",
  "--gyro-hero-text",
  "--gyro-hero-muted",
  "--gyro-hero-placeholder",
  "--gyro-hero-send",
  "--gyro-hero-shadow",
]) {
  expect(
    (styleSource.match(new RegExp(heroThemeToken, "g")) ?? []).length >= 3,
    `Hero composer theme token should be defined in both themes and consumed: ${heroThemeToken}`,
  );
}

expect(
  styleSource.includes("color: var(--gyro-hero-heading)") &&
    styleSource.includes("background: var(--gyro-hero-composer)") &&
    styleSource.includes("background: var(--gyro-hero-context)") &&
    styleSource.includes("caret-color: var(--gyro-hero-text)") &&
    styleSource.includes("color: var(--gyro-hero-placeholder)") &&
    styleSource.includes("opacity: 1") &&
    styleSource.includes("background: var(--gyro-hero-send)"),
  "The welcome and in-chat composer text, caret, and placeholder should consume semantic colors in both light and dark mode.",
);

expect(
  styleSource.includes(
    ".gyro-app-shell.is-chat-shell .gyro-account-button:hover",
  ) &&
    styleSource.includes(
      "background: color-mix(in srgb, var(--gyro-text) 5%, transparent)",
    ),
  "The persistent Settings footer should use a subtle theme-aware hover instead of a dark navigation pill.",
);

for (const compactMenuSelector of [
  ".gyro-composer-popover-title",
  ".gyro-composer-menu-item:disabled",
  ".gyro-account-menu-row.is-muted",
  ".gyro-agent-launcher-menu strong",
  ".gyro-terminal-actions-menu button.is-danger",
]) {
  expect(
    styleSource.includes(compactMenuSelector),
    `Compact menu state should have explicit theme parity: ${compactMenuSelector}`,
  );
}

expect(
  styleSource.includes(
    "var(--gyro-accent) 12%,\n    var(--gyro-surface-raised) 88%",
  ) &&
    styleSource.includes(
      "color-mix(in srgb, var(--gyro-faint) 82%, var(--gyro-muted) 18%)",
    ),
  "Open menus should keep selected and disabled rows readable in both themes.",
);

expect(
  surfaceSource.includes('kind: "permission-direct"') &&
    styleSource.includes(".gyro-composer-menu-item.is-permission-direct") &&
    styleSource.includes(
      ':root[data-theme="light"] .gyro-chat-start .gyro-composer-chip.is-warning',
    ) &&
    styleSource.includes("color: var(--gyro-warn)"),
  "Full Access should retain its warning color in the menu and selected composer chip.",
);

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
