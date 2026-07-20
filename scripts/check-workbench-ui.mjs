#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLI_LAUNCH_PRESET_MAX_PANES,
  CHAT_GRID_MAX_SLOTS,
  chatGridReducer,
  createInitialChatGridState,
  canSendChat,
  createInitialWorkbenchState,
  createTerminalPane,
  defaultCliLaunchPreset,
  defaultCommandProfiles,
  isUserSelectedWorkspacePath,
  normalizeCliLaunchPreset,
  parseProviderHealthOutput,
  sanitizeStoredIdeState,
  sanitizeStoredChatGridState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";
import {
  globalSearchMatchScore,
  normalizedGlobalSearchText,
} from "../packages/ui/src/global-search.ts";
import {
  isProviderExecutable,
  isProviderRuntimeUsable,
  normalizedConfig,
  providerCatalog,
  providerAuthStatusAfterHealth,
  providerConnectionStatusFromRuntime,
  providersForConfig,
} from "../packages/ui/src/provider-catalog.ts";
import {
  CHAT_RESPONSE_TRUNCATION_SUFFIX,
  MAX_CHAT_EVENT_RENDER_COUNT,
  MAX_CHAT_RESPONSE_CHARS,
  applyProviderChatStreamDeltas,
  mergePersistedAndOptimisticEvents,
  orderProviderChatStreamEvent,
  resetStreamingAssistantForRetry,
} from "../apps/desktop/src/provider-stream-events.ts";
import {
  shouldShowSidebarUpdate,
  updatePrimaryActionLabel,
  updateProgressPercent,
  updateSidebarLabel,
} from "../packages/ui/src/update-state.ts";

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

const gridPane = (sessionId, workspacePath = "/Users/example/Gyro") => ({
  paneId: `pane:${sessionId}`,
  kind: "session",
  sessionId,
  workspacePath,
});
let chatGridState = createInitialChatGridState();
chatGridState = chatGridReducer(chatGridState, {
  type: "select-pane",
  projectKey: "/Users/example/Gyro",
  pane: gridPane("one"),
  mode: "replace",
});
chatGridState = chatGridReducer(chatGridState, {
  type: "select-pane",
  projectKey: "/Users/example/Gyro",
  pane: gridPane("two"),
  mode: "drop",
  slotIndex: 1,
});
chatGridState = chatGridReducer(chatGridState, {
  type: "move-pane",
  projectKey: "/Users/example/Gyro",
  paneId: "pane:two",
  slotIndex: 0,
});
const testedGridLayout = chatGridState.layouts["/Users/example/Gyro"];
expect(
  CHAT_GRID_MAX_SLOTS === 4 &&
    testedGridLayout?.slots.length === 4 &&
    testedGridLayout.slots[0]?.kind === "session" &&
    testedGridLayout.slots[0].sessionId === "two" &&
    testedGridLayout.slots[1]?.kind === "session" &&
    testedGridLayout.slots[1].sessionId === "one" &&
    testedGridLayout.focusedPaneId === "pane:two",
  "Chat grid state should add, focus, and reorder four stable project slots.",
);
let directionalGridState = createInitialChatGridState();
directionalGridState = chatGridReducer(directionalGridState, {
  type: "select-pane",
  projectKey: "/Users/example/Gyro",
  pane: gridPane("one"),
  mode: "replace",
});
directionalGridState = chatGridReducer(directionalGridState, {
  type: "select-pane",
  projectKey: "/Users/example/Gyro",
  pane: gridPane("above"),
  mode: "drop",
  slotIndex: 0,
  insertPosition: "before",
  splitDirection: "vertical",
});
const directionalGridLayout =
  directionalGridState.layouts["/Users/example/Gyro"];
expect(
  directionalGridLayout?.splitDirection === "vertical" &&
    directionalGridLayout.slots[0]?.kind === "session" &&
    directionalGridLayout.slots[0].sessionId === "above" &&
    directionalGridLayout.slots[1]?.kind === "session" &&
    directionalGridLayout.slots[1].sessionId === "one",
  "Directional chat drops should preserve above/below ordering and split orientation.",
);
const sanitizedChatGrid = sanitizeStoredChatGridState({
  activeProjectKey: "/Users/example/Gyro",
  layouts: {
    "/Users/example/Gyro": {
      focusedPaneId: "pane:one",
      slots: [
        gridPane("one"),
        gridPane("one"),
        { ...gridPane("three"), paneId: "pane:one" },
        null,
        gridPane("five"),
      ],
    },
  },
});
expect(
  sanitizedChatGrid.layouts["/Users/example/Gyro"]?.slots.length === 4 &&
    sanitizedChatGrid.layouts["/Users/example/Gyro"]?.slots.filter(Boolean)
      .length === 1,
  "Stored chat grids should cap slots and reject duplicate sessions and pane IDs.",
);

expect(
  globalSearchMatchScore("gyro", "Gyro", "Gyro desktop") <
    globalSearchMatchScore("gyro", "Gyro workspace", "Gyro workspace") &&
    globalSearchMatchScore("work", "Open workspace", "Open workspace") <
      globalSearchMatchScore("space", "Open workspace", "Open workspace") &&
    !Number.isFinite(
      globalSearchMatchScore("missing", "Gyro", "Gyro desktop"),
    ) &&
    normalizedGlobalSearchText("SésSïon") === "session",
  "Global search should rank exact, prefix, word, and substring matches deterministically.",
);

function cssRules(source, selector) {
  const rules = [];
  const needle = `${selector} {`;
  let selectorIndex = source.indexOf(needle);
  while (selectorIndex !== -1) {
    const ruleStart = source.indexOf("{", selectorIndex);
    const ruleEnd = source.indexOf("}", ruleStart);
    rules.push(source.slice(selectorIndex, ruleEnd + 1));
    selectorIndex = source.indexOf(needle, ruleEnd + 1);
  }
  return rules;
}

expect(
  !canSendChat(true) &&
    !canSendChat(true, "/tmp/gyro-session-1783969000000") &&
    !canSendChat(false, "/Users/example/Project") &&
    canSendChat(true, "/Users/example/Project") &&
    isUserSelectedWorkspacePath("/Users/example/Project"),
  "Chat send requires a connected provider and a user-selected project.",
);

const appSource = readRepoFile("apps/desktop/src/App.tsx");
const monacoEditorSource = readRepoFile("apps/desktop/src/monaco-editor.ts");
const providerStreamSource = readRepoFile(
  "apps/desktop/src/provider-stream-events.ts",
);
const appAndStreamSource = `${appSource}\n${providerStreamSource}`;
const indexSource = readRepoFile("packages/ui/src/index.ts");
const packageSource = readRepoFile("package.json");
const readmeSource = readRepoFile("README.md");
const launchDocsSource = readRepoFile("docs/launch.md");
const installLocalSource = readRepoFile("scripts/install-local-app.mjs");
const roadmapSource = readRepoFile("ROADMAP.md");
const readinessAuditSource = readRepoFile("docs/product-readiness-audit.md");
const surfaceSource = readRepoFile("packages/ui/src/surfaces.tsx");
const styleSource = readRepoFile("packages/ui/src/styles.css");
const desktopRustSource = readRepoFile("apps/desktop/src-tauri/src/lib.rs");
expect(
  !surfaceSource.includes("gyro-chat-pane-frame-actions") &&
    !surfaceSource.includes('isFocused ? "is-focused"') &&
    !styleSource.includes("gyro-chat-pane-frame-actions") &&
    !styleSource.includes("gyro-chat-grid-slot.is-focused"),
  "Chat panes should omit floating controls and focused-pane outlines.",
);
expect(
  surfaceSource.includes('aria-label="Close chat"') &&
    surfaceSource.includes("onCloseChat={onCloseChat}") &&
    appSource.includes('type: "close-pane"') &&
    appSource.includes("paneId: pane.paneId"),
  "Grid chats should always expose a same-size close control in the chat header.",
);
expect(
  surfaceSource.includes('className="gyro-chat-thread-identity"') &&
    surfaceSource.includes('className="gyro-chat-thread-branch"') &&
    surfaceSource.includes("Current branch: ${branchLabel}") &&
    styleSource.includes(".gyro-chat-thread-branch") &&
    styleSource.includes("max-width: 180px"),
  "Chat headers should show the current branch in a compact, truncating identity label.",
);
expect(
  surfaceSource.includes('className="gyro-chat-grid-drop-overlay"') &&
    surfaceSource.includes('className="gyro-chat-grid-drop-tile"') &&
    surfaceSource.includes('label: "Above"') &&
    surfaceSource.includes('label: "Next"') &&
    surfaceSource.includes('label: "Below"') &&
    surfaceSource.includes("chatGridDropZones(slots)") &&
    surfaceSource.includes('window.addEventListener("blur", finishDrag)') &&
    surfaceSource.includes("didDrop && maximizedPaneId") &&
    !surfaceSource.includes("Drag another chat here") &&
    !surfaceSource.includes("Choose one of four chat slots") &&
    styleSource.includes(".gyro-chat-grid-drop-overlay") &&
    styleSource.includes(
      ".gyro-chat-grid-drop-zone.is-drop-target .gyro-chat-grid-drop-tile",
    ) &&
    !styleSource.includes(
      ".gyro-chat-grid.is-count-4,\n.gyro-chat-grid.is-dragging",
    ),
  "Chat dragging should keep the live layout still and reveal adaptive placement tiles.",
);
expect(
  surfaceSource.includes('className="gyro-sidebar-scm-identity"') &&
    surfaceSource.includes('className="gyro-sidebar-scm-directory"') &&
    surfaceSource.includes('className="gyro-sidebar-scm-state"') &&
    surfaceSource.includes('className="gyro-sidebar-scm-stage"') &&
    surfaceSource.includes('className="gyro-sidebar-scm-discard"') &&
    surfaceSource.includes("function workspaceParentFolder") &&
    cssRules(styleSource, ".gyro-sidebar-scm-row").some(
      (rule) =>
        rule.includes("grid-template-columns: minmax(0, 1fr) auto 24px 24px") &&
        rule.includes("min-height: 30px"),
    ) &&
    cssRules(styleSource, ".gyro-sidebar-scm-discard").some((rule) =>
      rule.includes("opacity: 0"),
    ) &&
    !cssRules(styleSource, ".gyro-sidebar-scm-row > button").some((rule) =>
      rule.includes("grid-template-columns"),
    ),
  "Workspace Source Control files should use compact single-line rows with stable actions.",
);
expect(
  cssRules(styleSource, ".gyro-settings-topbar").some((rule) =>
    rule.includes("background: var(--gyro-sidebar)"),
  ) &&
    cssRules(styleSource, ".gyro-sidebar-persistent-header.is-settings").some(
      (rule) => rule.includes("background: transparent"),
    ),
  "Settings should share one sidebar-colored titlebar across the whole window.",
);
expect(
  cssRules(styleSource, ".gyro-chat-message-queue").some(
    (rule) =>
      rule.includes("max-width: 820px") &&
      rule.includes("width: min(820px, 100%)"),
  ),
  "The chat message queue should match the composer width.",
);
expect(
  styleSource.includes(
    ':root[data-theme="light"] .gyro-chat-run-change-summary',
  ) &&
    styleSource.includes(
      ':root[data-theme="light"] .gyro-change-summary-diff',
    ) &&
    styleSource.includes("background: #f8fafc") &&
    styleSource.includes("background: #e7f3eb") &&
    styleSource.includes("background: #f9e8ea"),
  "Light-mode change summaries should use a clean code canvas and readable diff colors.",
);
expect(
  surfaceSource.includes('className={[\n        "gyro-session-row"') &&
    surfaceSource.includes("draggable={Boolean(onDragStart)}") &&
    surfaceSource.includes("onDragStart={onDragStart}") &&
    !surfaceSource.includes("gyro-session-drag-handle") &&
    !styleSource.includes(".gyro-session-drag-handle"),
  "The full chat row should remain directly draggable without a separate dotted grip.",
);
expect(
  surfaceSource.includes(
    "title={`${attachment.name} · ${formatAttachmentSize(attachment.size)}`}",
  ) &&
    cssRules(
      styleSource,
      ".gyro-composer-shell > .gyro-composer-attachments",
    ).some(
      (rule) =>
        rule.includes("overflow-x: auto") &&
        !rule.includes("position: absolute"),
    ) &&
    !styleSource.includes(
      ".gyro-composer-shell:has(> .gyro-composer-attachments .is-image) {\n  margin-top:",
    ) &&
    styleSource.includes("object-fit: contain"),
  "Linked screenshots should use a contained preview tray inside the composer.",
);
expect(
  surfaceSource.includes("interleavedChatTimelineItems(turn.timelineEvents)") &&
    !surfaceSource.includes(
      'if (providerActivityFromEvent(event)?.kind === "file") {\n      continue;',
    ) &&
    surfaceSource.includes('kind: "activity-group"') &&
    surfaceSource.includes('className="gyro-chat-run-sequence"') &&
    surfaceSource.includes("function ProviderActivityGroup") &&
    surfaceSource.includes('"collapsed" | "preview" | "expanded"') &&
    surfaceSource.includes("events.slice(0, 3)") &&
    surfaceSource.includes("click again to show") &&
    surfaceSource.includes("function ChatTurnChangeSummary") &&
    surfaceSource.includes('aria-live="polite"') &&
    surfaceSource.includes("changeSummary={changeSummary}") &&
    surfaceSource.includes("structuredCommentaryBlocks(activity.label)") &&
    styleSource.includes(".gyro-chat-run-activity-group-toggle") &&
    styleSource.includes(".gyro-change-summary-actions"),
  "Chat turns should interleave text with expandable actions and one aggregate live change summary.",
);
expect(
  surfaceSource.includes('label: "Suggested"') &&
    surfaceSource.includes('label: "Recent sessions"') &&
    surfaceSource.includes('role="combobox"') &&
    surfaceSource.includes('role="listbox"') &&
    surfaceSource.includes('event.key === "ArrowDown"') &&
    surfaceSource.includes("onSelectProject?.(entry.selection.path)") &&
    appSource.includes("const openGlobalSearch = useCallback") &&
    appSource.includes('{ type: "ide-select-view", view: "search" }'),
  "Global search should group navigation metadata, support keyboard selection, reset on open, and route file search to the IDE search view.",
);
expect(
  desktopRustSource.includes(
    'WORKSPACE_PREPARATION_EVENT: &str = "gyro://workspace-preparation"',
  ) &&
    desktopRustSource.includes(
      'WORKSPACE_CHANGED_EVENT: &str = "gyro://workspace-changed"',
    ) &&
    desktopRustSource.includes("WORKSPACE_CHANGE_DEBOUNCE") &&
    desktopRustSource.includes("fn test_tree_from_tasks") &&
    appSource.includes('workspaceWatchMode === "polling"'),
  "Workspace preparation should expose honest native stages and disable steady polling when the event watcher is healthy.",
);
const composerSourceStart = surfaceSource.indexOf("function Composer({");
const composerSourceEnd = surfaceSource.indexOf(
  "\nfunction ",
  composerSourceStart + 1,
);
const composerSource = surfaceSource.slice(
  composerSourceStart,
  composerSourceEnd,
);
const composerHandlerStart = appSource.indexOf(
  "const handleComposerAction = useCallback",
);
const composerHandlerEnd = appSource.indexOf(
  "const splitTerminalPane = useCallback",
  composerHandlerStart,
);
const composerHandlerSource = appSource.slice(
  composerHandlerStart,
  composerHandlerEnd,
);
const threadSurfaceRules = cssRules(
  styleSource,
  ".gyro-chat-surface.is-thread",
);
const threadTopbarRules = cssRules(
  styleSource,
  ".gyro-chat-surface.is-thread > .gyro-chat-thread-topbar",
);
const threadCanvasRules = cssRules(
  styleSource,
  ".gyro-chat-surface.is-thread > .gyro-chat-thread-canvas",
);
const threadRailRules = cssRules(
  styleSource,
  ".gyro-chat-surface.is-thread.has-environment > .gyro-environment-rail",
);
const typeSource = readRepoFile("packages/ui/src/types.ts");
const reducerSource = readRepoFile("packages/ui/src/workbench-state.ts");
const coreHarnessSource = readRepoFile("crates/gyro-core/src/harness.rs");
const coreExecutionSource = readRepoFile("crates/gyro-core/src/execution.rs");
const coreAutomationSource = readRepoFile(
  "crates/gyro-core/src/automations.rs",
);
const coreIpcSource = readRepoFile("crates/gyro-core/src/ipc.rs");
const coreProviderHealthSource = readRepoFile(
  "crates/gyro-core/src/provider_health.rs",
);
const coreProviderStreamSource = readRepoFile(
  "crates/gyro-core/src/provider_stream.rs",
);
const coreMutationsSource = readRepoFile("crates/gyro-core/src/mutations.rs");
const coreSessionsSource = readRepoFile("crates/gyro-core/src/sessions.rs");
const tauriSource = readRepoFile("apps/desktop/src-tauri/src/lib.rs");
const updateControllerSource = readRepoFile(
  "apps/desktop/src/update-controller.ts",
);
const tauriConfigSource = readRepoFile(
  "apps/desktop/src-tauri/tauri.conf.json",
);
const tauriConfig = JSON.parse(tauriConfigSource);
const releaseWorkflowSource = readRepoFile(".github/workflows/release.yml");

const emittedComposerActions = new Set([
  ...[...surfaceSource.matchAll(/onComposerAction\?\.\("([^"]+)"\)/g)].map(
    (match) => match[1],
  ),
  ...[
    ...composerSource.matchAll(
      /action:[^,\n]*?(?:"([^"$]+)"|`([^`$]+)(?:\$\{|`))/g,
    ),
  ].map((match) => match[1] ?? match[2]),
]);
const handledComposerActions = new Set(
  [...composerHandlerSource.matchAll(/case\s+"([^"]+)"\s*:/g)].map(
    (match) => match[1],
  ),
);
const handledComposerPrefixes = [
  ...composerHandlerSource.matchAll(/action\.startsWith\("([^"]+)"\)/g),
].map((match) => match[1]);
const unhandledComposerActions = [...emittedComposerActions].filter(
  (action) =>
    !handledComposerActions.has(action) &&
    !handledComposerPrefixes.some((prefix) => action.startsWith(prefix)),
);
expect(
  composerSourceStart >= 0 &&
    composerSourceEnd > composerSourceStart &&
    composerHandlerStart >= 0 &&
    composerHandlerEnd > composerHandlerStart &&
    emittedComposerActions.size > 0 &&
    unhandledComposerActions.length === 0,
  `Every visible Chat/composer action should have a concrete handler; unhandled: ${unhandledComposerActions.join(", ") || "none"}.`,
);

const profiles = defaultCommandProfiles();
expect(
  providerCatalog.map((provider) => provider.id).join(",") ===
    "openai,anthropic,kimi,xai,gemini",
  "Provider catalog should include executable Kimi between Anthropic and readiness-only providers.",
);
const orderedStreamState = new Map();
const orderedStreamBase = {
  sessionId: "ordered-session",
  turnId: "ordered-turn",
  providerId: "openai",
  eventId: "ordered-0",
  sequence: 0,
  phase: "started",
};
expect(
  orderProviderChatStreamEvent(orderedStreamState, orderedStreamBase).length ===
    1 &&
    orderProviderChatStreamEvent(orderedStreamState, {
      ...orderedStreamBase,
      eventId: "ordered-2",
      sequence: 2,
      phase: "delta",
      textDelta: "second",
    }).length === 0 &&
    orderProviderChatStreamEvent(orderedStreamState, {
      ...orderedStreamBase,
      eventId: "ordered-1",
      sequence: 1,
      phase: "delta",
      textDelta: "first",
    })
      .map((event) => event.sequence)
      .join(",") === "1,2",
  "Provider stream IPC should reorder delayed events and reject duplicate sequences.",
);
const availableUpdate = {
  status: "available",
  currentVersion: "0.1.0",
  nextVersion: "0.2.0",
};
const repeatedMessageBase = {
  id: "user-turn-1",
  sessionId: "session-1",
  turnId: "turn-1",
  createdAt: "2026-07-12T12:00:00.000Z",
  kind: "user-message",
  message: "Test",
  payload: { turnId: "turn-1" },
};
const repeatedMessageNext = {
  ...repeatedMessageBase,
  id: "user-turn-2",
  turnId: "turn-2",
  payload: { turnId: "turn-2", optimistic: true },
};
const repeatedMessages = mergePersistedAndOptimisticEvents(
  [repeatedMessageBase],
  [repeatedMessageNext],
);
const retriedStreamingEvents = resetStreamingAssistantForRetry(
  [
    repeatedMessageBase,
    {
      id: "streaming-answer",
      sessionId: "session-1",
      turnId: "turn-1",
      createdAt: "2026-07-12T12:00:01.000Z",
      kind: "assistant-message",
      message: "partial",
      payload: { streaming: true },
    },
  ],
  "turn-1",
);
expect(
  repeatedMessages.filter((event) => event.kind === "user-message").length ===
    2 &&
    mergePersistedAndOptimisticEvents(
      [repeatedMessageBase],
      [{ ...repeatedMessageNext, turnId: "turn-1" }],
    ).filter((event) => event.kind === "user-message").length === 1 &&
    retriedStreamingEvents.length === 1 &&
    retriedStreamingEvents[0]?.id === "user-turn-1",
  "Repeated messages should remain distinct by turn while retry clears only partial streamed output.",
);
expect(
  appSource.includes("retryTurnId") &&
    appSource.includes("if (!isRetry)") &&
    appSource.includes("resetStreamingAssistantForRetry") &&
    appSource.includes(
      "const attachments = Array.isArray(userPayload?.attachments)",
    ) &&
    appSource.includes("attachments,") &&
    desktopRustSource.includes('"attachments": attachments') &&
    surfaceSource.includes("Previous send was interrupted") &&
    surfaceSource.includes("Retry continues the same message") &&
    surfaceSource.includes(
      'providerStatus.status === "cancelled" ||\n              wasInterrupted',
    ) &&
    tauriSource.includes("flags.contains_key(&session_id)") &&
    tauriSource.includes("a provider turn is already running for this session"),
  "Chat recovery should retry the same turn, recover interrupted runs, and reject concurrent provider sends.",
);
expect(
  shouldShowSidebarUpdate(availableUpdate) &&
    !shouldShowSidebarUpdate({ status: "current", currentVersion: "0.2.0" }) &&
    !shouldShowSidebarUpdate({
      status: "failed",
      currentVersion: "0.1.0",
      silentFailure: true,
    }) &&
    updateSidebarLabel(availableUpdate) === "Update Gyro" &&
    updatePrimaryActionLabel(availableUpdate) === "Update to 0.2.0" &&
    updateSidebarLabel({
      status: "downloading",
      currentVersion: "0.1.0",
      progressPercent: 64,
    }) === "Downloading 64%" &&
    updateProgressPercent(64, 100) === 64 &&
    updateProgressPercent(10, undefined) === undefined,
  "Update state should drive sidebar visibility, labels, and bounded progress.",
);
const openAiCatalog = providerCatalog.find(
  (provider) => provider.id === "openai",
);
expect(
  openAiCatalog?.models
    .slice(0, 3)
    .map((model) => model.id)
    .join(",") === "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna" &&
    openAiCatalog.selectedModelId === "gpt-5.6-sol" &&
    openAiCatalog.models
      .slice(0, 3)
      .every(
        (model) =>
          model.supportedReasoningEfforts?.join(",") ===
            "low,medium,high,xhigh,max,ultra" &&
          model.contextWindowTokens === 1_050_000,
      ),
  "OpenAI should expose all GPT-5.6 variants with their supported effort levels.",
);
const restoredEnabledConfig = normalizedConfig({
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
  restoredEnabledConfig.modelProviders
    .find((provider) => provider.id === "openai")
    ?.models.slice(0, 3)
    .map((model) => model.id)
    .join(",") === "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna",
  "Saved legacy provider configs should merge in the current GPT-5.6 catalog.",
);
expect(
  providersForConfig(restoredEnabledConfig).find(
    (provider) => provider.id === "openai",
  )?.authStatus === "connected",
  "Saved enabled providers should rehydrate as connected when backend config omits authStatus.",
);
const kimiCatalog = providerCatalog.find((provider) => provider.id === "kimi");
expect(
  kimiCatalog?.selectedModelId === "k3" &&
    kimiCatalog.models[0]?.displayName === "Kimi K3" &&
    kimiCatalog.models[0]?.supportedReasoningEfforts?.join(",") === "max" &&
    isProviderExecutable("kimi") &&
    !isProviderExecutable("xai") &&
    !isProviderExecutable("gemini"),
  "Kimi should default to K3/Max while xAI and Gemini remain readiness-only.",
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
  splitGroupId === "group-2" &&
    editorGroupState.ide.layout.groups.length === 2 &&
    editorGroupState.ide.layout.groups.every(
      (group) => group.activePath === "src/main.ts",
    ),
  "Splitting the editor should create a deterministic second live group with the active file.",
);
editorGroupState = workbenchReducer(editorGroupState, {
  type: "ide-close-group",
  groupId: splitGroupId,
});
expect(
  editorGroupState.ide.layout.groups.length === 1,
  "Closing an editor group should preserve one usable editor group.",
);

let tabMoveState = workbenchReducer(createInitialWorkbenchState(), {
  type: "ide-open-tab",
  tab: {
    path: "src/shared.ts",
    title: "shared.ts",
    dirty: false,
    pinned: true,
  },
});
tabMoveState = workbenchReducer(tabMoveState, {
  type: "ide-split-group",
  direction: "right",
});
const tabMoveSourceGroupId = tabMoveState.ide.layout.activeGroupId;
tabMoveState = workbenchReducer(tabMoveState, {
  type: "ide-open-tab",
  tab: {
    path: "src/side-only.ts",
    title: "side-only.ts",
    dirty: false,
    pinned: true,
  },
});
tabMoveState = workbenchReducer(tabMoveState, {
  type: "ide-split-group",
  direction: "right",
});
const tabMoveTargetGroupId = tabMoveState.ide.layout.activeGroupId;
expect(
  tabMoveSourceGroupId === "group-2" && tabMoveTargetGroupId === "group-3",
  "Repeated editor splits should allocate deterministic group IDs.",
);
tabMoveState = workbenchReducer(tabMoveState, {
  type: "ide-move-tab",
  path: "src/shared.ts",
  fromGroupId: tabMoveSourceGroupId,
  toGroupId: tabMoveTargetGroupId,
});
expect(
  tabMoveState.ide.layout.groups
    .find((group) => group.id === "group-main")
    ?.tabs.some((tab) => tab.path === "src/shared.ts") &&
    tabMoveState.ide.layout.groups
      .find((group) => group.id === tabMoveSourceGroupId)
      ?.tabs.every((tab) => tab.path !== "src/shared.ts") &&
    tabMoveState.ide.layout.groups
      .find((group) => group.id === tabMoveTargetGroupId)
      ?.tabs.some((tab) => tab.path === "src/shared.ts"),
  "Moving a duplicated editor should remove only the dragged group copy.",
);
tabMoveState = workbenchReducer(tabMoveState, {
  type: "ide-move-tab",
  path: "src/side-only.ts",
  fromGroupId: tabMoveTargetGroupId,
  toGroupId: tabMoveTargetGroupId,
});
expect(
  tabMoveState.ide.layout.groups
    .find((group) => group.id === tabMoveTargetGroupId)
    ?.tabs.map((tab) => tab.path)
    .join(",") === "src/shared.ts,src/side-only.ts",
  "Dropping a tab within its group should reorder it without duplicating it.",
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
  initialState.providerStatuses.length === 5 &&
    initialState.providerStatuses.some((provider) => provider.id === "kimi") &&
    initialState.providerStatuses.some((provider) => provider.id === "xai"),
  "Initial workbench state should include Kimi and the readiness-only provider statuses.",
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
    initialState.lastSessionsLayout === "thread" &&
    initialState.isToolPanelOpen === false,
  "Initial workbench state should start in Chat within Sessions with the tool panel closed.",
);
expect(
  appSource.includes('activeWorkspaceLayout === "thread"') &&
    appSource.includes("isToolPanelOpen = false"),
  "Persisted chat/thread restore should force the shared tool panel closed.",
);
expect(
  typeSource.includes(
    'export type SessionsLayoutId = Exclude<WorkspaceLayoutId, "code">',
  ) &&
    typeSource.includes("lastSessionsLayout: SessionsLayoutId") &&
    reducerSource.includes('case "select-sessions"') &&
    appSource.includes("normalizeStoredSessionsLayout") &&
    appSource.includes("parsed.lastSessionsLayout"),
  "Sessions routing should persist and safely hydrate the last Chat or CLI layout.",
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
    state.preferences.chatEnvironmentRailOpen === true &&
    state.isToolPanelOpen === false,
  "Chat plan toggle should expand the checklist inside the environment rail without opening the bottom drawer.",
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
let sessionsState = workbenchReducer(initialState, {
  type: "select-workspace-layout",
  layout: "terminal-grid",
});
sessionsState = workbenchReducer(sessionsState, {
  type: "select-workspace-layout",
  layout: "code",
});
expect(
  sessionsState.lastSessionsLayout === "terminal-grid",
  "Workspace navigation should preserve the last Chat or CLI layout.",
);
sessionsState = workbenchReducer(sessionsState, { type: "select-sessions" });
expect(
  sessionsState.activeWorkspaceLayout === "terminal-grid" &&
    sessionsState.activePaneTab === "terminal" &&
    sessionsState.isToolPanelOpen === true,
  "Sessions should restore the last-used CLI layout and terminal focus.",
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
  const movedTerminalState = workbenchReducer(state, {
    type: "sync-terminal-pane-snapshot",
    paneId: pane.id,
    status: "done",
    event: "done (0)",
    command: "codex --help",
    output: "terminal output captured",
    workingDirectory: "/tmp/gyro-worktree-final",
  });
  expect(
    movedTerminalState !== state &&
      movedTerminalState.terminalPanes.find((item) => item.id === pane.id)
        ?.workingDirectory === "/tmp/gyro-worktree-final",
    "Terminal snapshots should apply working-directory-only updates.",
  );
  state = movedTerminalState;
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
expect(
  state.browserPreview.status === "loading" &&
    state.browserPreview.verificationMessage === "Checking local preview" &&
    appSource.includes('invoke<BrowserPreviewCheck>("check_browser_preview"') &&
    tauriSource.includes("check_browser_preview_blocking"),
  "Browser preview navigation should verify reachability before claiming success.",
);
state = workbenchReducer(state, { type: "browser-device", device: "mobile" });
state = workbenchReducer(state, { type: "browser-capture-start" });
expect(
  state.browserPreview.captureStatus === "capturing",
  "Browser capture should expose a real in-progress state.",
);
state = workbenchReducer(state, {
  type: "browser-capture-success",
  capture: {
    path: "/tmp/Gyro/browser-captures/browser-preview-smoke.png",
    filename: "browser-preview-smoke.png",
    width: 390,
    height: 844,
    createdAt: "2026-07-14T12:00:00.000Z",
  },
});
state = workbenchReducer(state, {
  type: "browser-status",
  status: "console-error",
  message: "Local preview reachable (HTTP 200)",
  consoleErrors: 1,
  diagnostics: [
    {
      kind: "page-error",
      message: "Render failed",
      source: "/src/app.ts",
      line: 12,
    },
  ],
  diagnosticsSupported: true,
  diagnosticsCaptured: true,
});
expect(
  state.browserPreview.device === "mobile" &&
    state.browserPreview.captureStatus === "captured" &&
    state.browserPreview.latestCapture?.width === 390 &&
    state.browserPreview.consoleErrors === 1 &&
    state.browserPreview.diagnostics[0]?.source === "/src/app.ts" &&
    state.browserPreview.diagnosticsCaptured,
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
expect(
  providerConnectionStatusFromRuntime("ready") === "connected" &&
    providerConnectionStatusFromRuntime("not-logged-in") === "not-configured" &&
    providerConnectionStatusFromRuntime("warning") === "failed",
  "Typed backend runtime status should drive the provider connection result.",
);
expect(
  providerAuthStatusAfterHealth("connected", "failed") === "connected" &&
    providerAuthStatusAfterHealth("connected", "not-configured") ===
      "connected" &&
    providerAuthStatusAfterHealth("not-connected", "connected") === "connected",
  "Provider probes should promote success without persisting failures as logout.",
);
const enabledOpenAiProvider = {
  ...providerCatalog.find((provider) => provider.id === "openai"),
  authStatus: "connected",
  enabled: true,
};
expect(
  isProviderRuntimeUsable(enabledOpenAiProvider, {
    connectionStatus: "failed",
    runtimeStatus: "warning",
  }) &&
    !isProviderRuntimeUsable(enabledOpenAiProvider, {
      connectionStatus: "not-configured",
      runtimeStatus: "not-logged-in",
    }),
  "Transient health warnings should retain enabled providers while definitive auth failures block execution.",
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

const ideHydrationBase = createInitialWorkbenchState().ide;
const restoredIde = sanitizeStoredIdeState(
  {
    ...ideHydrationBase,
    activePath: "src/side.ts",
    activeView: "search",
    tabs: [
      {
        path: "src/main.ts",
        title: "main.ts",
        dirty: true,
        pinned: true,
      },
      {
        path: "src/side.ts",
        title: "side.ts",
        dirty: true,
        preview: true,
      },
    ],
    buffers: {
      "src/main.ts": {
        path: "src/main.ts",
        content: "unsaved",
        savedContent: "saved",
        sizeBytes: 7,
        truncated: false,
        status: "dirty",
        updatedAt: new Date().toISOString(),
      },
    },
    diagnostics: [
      {
        id: "stale-diagnostic",
        path: "src/main.ts",
        lineNumber: 1,
        column: 1,
        endLineNumber: 1,
        endColumn: 2,
        message: "stale",
        severity: "error",
        source: "test",
      },
    ],
    layout: {
      groups: [
        {
          id: "group-main",
          title: "Main",
          activePath: "src/main.ts",
          tabs: [{ path: "src/main.ts" }],
          panes: [{ id: "unsafe-pane", path: "../escape" }],
        },
        {
          id: "group-side",
          title: "Side",
          activePath: "src/side.ts",
          tabs: [{ path: "src/side.ts" }],
          panes: [],
        },
      ],
      activeGroupId: "group-side",
      splitDirection: "down",
      minimapEnabled: false,
      restoreOnLaunch: true,
      rightAssistantOpen: false,
    },
  },
  ideHydrationBase,
);
expect(
  restoredIde.activePath === "src/side.ts" &&
    restoredIde.activeView === "search" &&
    restoredIde.tabs.length === 2 &&
    restoredIde.tabs.every(
      (tab) => tab.dirty === false && tab.preview === false,
    ) &&
    restoredIde.layout.groups.length === 2 &&
    restoredIde.layout.activeGroupId === "group-side" &&
    restoredIde.layout.splitDirection === "down" &&
    restoredIde.layout.minimapEnabled === false &&
    restoredIde.layout.rightAssistantOpen === false &&
    restoredIde.layout.groups[1]?.panes[0]?.id === "group-side-pane" &&
    Object.keys(restoredIde.buffers).length === 0 &&
    restoredIde.diagnostics.length === 0,
  "IDE hydration should restore validated layout state without transient buffers.",
);

const rejectedStoredIde = sanitizeStoredIdeState(
  {
    tabs: [
      { path: "../outside.ts", title: "outside.ts", dirty: false },
      { path: "/absolute.ts", title: "absolute.ts", dirty: false },
      { path: "src/safe.ts", title: "safe.ts", dirty: false },
      { path: "src/safe.ts", title: "duplicate.ts", dirty: false },
    ],
    activePath: "../outside.ts",
    layout: {
      groups: [
        {
          id: "group-main",
          title: "Main",
          activePath: "src/safe.ts",
          tabs: [{ path: "src/safe.ts" }],
        },
        { id: "group-main", title: "Duplicate", tabs: [] },
        { id: "bad group id", title: "Invalid", tabs: [] },
      ],
      activeGroupId: "bad group id",
      splitDirection: "right",
      minimapEnabled: true,
      restoreOnLaunch: true,
      rightAssistantOpen: true,
    },
  },
  ideHydrationBase,
);
expect(
  rejectedStoredIde.tabs.length === 1 &&
    rejectedStoredIde.tabs[0]?.path === "src/safe.ts" &&
    rejectedStoredIde.activePath === "src/safe.ts" &&
    rejectedStoredIde.layout.groups.length === 1 &&
    rejectedStoredIde.layout.activeGroupId === "group-main",
  "IDE hydration should reject unsafe paths, duplicate tabs, and invalid groups.",
);

const restoreDisabledIde = sanitizeStoredIdeState(
  {
    activeView: "source-control",
    tabs: [{ path: "src/main.ts", title: "main.ts", dirty: false }],
    layout: {
      ...ideHydrationBase.layout,
      restoreOnLaunch: false,
    },
  },
  ideHydrationBase,
);
expect(
  restoreDisabledIde.tabs.length === 0 &&
    restoreDisabledIde.activePath === undefined &&
    restoreDisabledIde.activeView === "source-control" &&
    restoreDisabledIde.layout.restoreOnLaunch === false &&
    restoreDisabledIde.layout.groups.length === 1,
  "IDE hydration should honor restore-on-launch being disabled.",
);

let backgroundScmState = createInitialWorkbenchState();
backgroundScmState = workbenchReducer(backgroundScmState, {
  type: "ide-select-view",
  view: "search",
});
backgroundScmState = workbenchReducer(backgroundScmState, {
  type: "ide-set-source-control",
  sourceControl: {
    ...backgroundScmState.ide.sourceControl,
    available: true,
    branch: "main",
    files: [
      {
        path: "src/main.ts",
        state: "modified",
        staged: false,
        additions: 1,
        deletions: 0,
      },
    ],
  },
});
expect(
  backgroundScmState.ide.activeView === "search" &&
    backgroundScmState.ide.sourceControl.branch === "main" &&
    backgroundScmState.ide.fileDecorations[0]?.path === "src/main.ts",
  "Background source-control refresh should not steal the active IDE view.",
);

let previewState = createInitialWorkbenchState();
previewState = workbenchReducer(previewState, {
  type: "ide-open-tab",
  tab: {
    path: "src/preview-a.ts",
    title: "preview-a.ts",
    dirty: false,
    preview: true,
  },
});
previewState = workbenchReducer(previewState, {
  type: "ide-open-tab",
  tab: {
    path: "src/preview-b.ts",
    title: "preview-b.ts",
    dirty: false,
    preview: true,
  },
});
expect(
  previewState.ide.tabs.length === 1 &&
    previewState.ide.tabs[0]?.path === "src/preview-b.ts" &&
    previewState.ide.layout.groups[0]?.tabs[0]?.preview === true,
  "A clean preview tab should be replaced by the next preview file.",
);
previewState = workbenchReducer(previewState, {
  type: "ide-pin-tab",
  path: "src/preview-b.ts",
});
previewState = workbenchReducer(previewState, {
  type: "ide-open-tab",
  tab: {
    path: "src/preview-c.ts",
    title: "preview-c.ts",
    dirty: false,
    preview: true,
  },
});
expect(
  previewState.ide.tabs.length === 2 &&
    previewState.ide.tabs.find((tab) => tab.path === "src/preview-b.ts")
      ?.pinned === true &&
    previewState.ide.layout.groups[0]?.tabs.some(
      (tab) => tab.path === "src/preview-c.ts" && tab.preview === true,
    ),
  "Pinned tabs should remain open beside a new preview tab.",
);
previewState = workbenchReducer(previewState, {
  type: "ide-upsert-buffer",
  buffer: {
    path: "src/preview-c.ts",
    content: "const preview = true;\n",
    savedContent: "const preview = true;\n",
    contentHash: "preview-hash",
    sizeBytes: 22,
    truncated: false,
    status: "ready",
    updatedAt: new Date().toISOString(),
  },
});
previewState = workbenchReducer(previewState, {
  type: "ide-update-buffer",
  path: "src/preview-c.ts",
  content: "const preview = false;\n",
});
expect(
  previewState.ide.tabs.find((tab) => tab.path === "src/preview-c.ts")
    ?.pinned === true &&
    previewState.ide.layout.groups[0]?.tabs.some(
      (tab) =>
        tab.path === "src/preview-c.ts" &&
        tab.preview === false &&
        tab.dirty === true,
    ),
  "Editing a preview tab should pin it before it becomes dirty.",
);

let groupCloseState = createInitialWorkbenchState();
groupCloseState = workbenchReducer(groupCloseState, {
  type: "ide-open-tab",
  tab: {
    path: "src/shared.ts",
    title: "shared.ts",
    dirty: false,
    pinned: true,
  },
});
groupCloseState = workbenchReducer(groupCloseState, {
  type: "ide-upsert-buffer",
  buffer: {
    path: "src/shared.ts",
    content: "shared\n",
    savedContent: "shared\n",
    contentHash: "shared-hash",
    sizeBytes: 7,
    truncated: false,
    status: "ready",
    updatedAt: new Date().toISOString(),
  },
});
groupCloseState = workbenchReducer(groupCloseState, {
  type: "ide-split-group",
  direction: "right",
});
const groupCloseSplitId = groupCloseState.ide.layout.activeGroupId;
groupCloseState = workbenchReducer(groupCloseState, {
  type: "ide-close-tab",
  path: "src/shared.ts",
  groupId: groupCloseSplitId,
});
expect(
  groupCloseState.ide.tabs.some((tab) => tab.path === "src/shared.ts") &&
    groupCloseState.ide.buffers["src/shared.ts"]?.status === "ready" &&
    groupCloseState.ide.activePath === "src/shared.ts" &&
    groupCloseState.ide.layout.activeGroupId === "group-main" &&
    groupCloseState.ide.layout.groups[0]?.tabs.some(
      (tab) => tab.path === "src/shared.ts",
    ) &&
    groupCloseState.ide.layout.groups
      .find((group) => group.id === groupCloseSplitId)
      ?.tabs.every((tab) => tab.path !== "src/shared.ts"),
  "Closing a duplicated editor should affect only the targeted group.",
);
groupCloseState = workbenchReducer(groupCloseState, {
  type: "ide-select-group",
  groupId: groupCloseSplitId,
});
groupCloseState = workbenchReducer(groupCloseState, {
  type: "ide-open-tab",
  tab: {
    path: "src/side-only.ts",
    title: "side-only.ts",
    dirty: false,
    pinned: true,
  },
});
groupCloseState = workbenchReducer(groupCloseState, {
  type: "ide-upsert-buffer",
  buffer: {
    path: "src/side-only.ts",
    content: "side\n",
    savedContent: "side\n",
    contentHash: "side-hash",
    sizeBytes: 5,
    truncated: false,
    status: "ready",
    updatedAt: new Date().toISOString(),
  },
});
groupCloseState = workbenchReducer(groupCloseState, {
  type: "ide-close-group",
  groupId: groupCloseSplitId,
});
expect(
  groupCloseState.ide.layout.groups.length === 1 &&
    groupCloseState.ide.layout.activeGroupId === "group-main" &&
    groupCloseState.ide.activePath === "src/shared.ts" &&
    groupCloseState.ide.tabs.length === 1 &&
    groupCloseState.ide.tabs[0]?.path === "src/shared.ts" &&
    groupCloseState.ide.buffers["src/shared.ts"]?.status === "ready" &&
    groupCloseState.ide.buffers["src/side-only.ts"] === undefined,
  "Closing an editor group should remove orphaned tabs and preserve shared editors.",
);

let pathMutationState = createInitialWorkbenchState();
pathMutationState = workbenchReducer(pathMutationState, {
  type: "ide-open-tab",
  tab: {
    path: "src/components/Button.tsx",
    title: "Button.tsx",
    dirty: false,
    pinned: true,
  },
});
pathMutationState = workbenchReducer(pathMutationState, {
  type: "ide-upsert-buffer",
  buffer: {
    path: "src/components/Button.tsx",
    content: "export function Button() {}\n",
    savedContent: "export function Button() {}\n",
    contentHash: "button-hash",
    sizeBytes: 28,
    truncated: false,
    status: "ready",
    updatedAt: new Date().toISOString(),
  },
});
pathMutationState = workbenchReducer(pathMutationState, {
  type: "ide-set-selection",
  selection: {
    path: "src/components/Button.tsx",
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 7,
    text: "export",
  },
});
pathMutationState = workbenchReducer(pathMutationState, {
  type: "ide-rename-path",
  fromPath: "src",
  toPath: "app",
});
expect(
  pathMutationState.ide.activePath === "app/components/Button.tsx" &&
    pathMutationState.ide.tabs[0]?.path === "app/components/Button.tsx" &&
    pathMutationState.ide.layout.groups[0]?.activePath ===
      "app/components/Button.tsx" &&
    pathMutationState.ide.layout.groups[0]?.tabs[0]?.path ===
      "app/components/Button.tsx" &&
    pathMutationState.ide.buffers["app/components/Button.tsx"]?.path ===
      "app/components/Button.tsx" &&
    pathMutationState.ide.buffers["src/components/Button.tsx"] === undefined &&
    pathMutationState.ide.selection?.path === "app/components/Button.tsx",
  "Renaming a workspace directory should remap descendant editor state atomically.",
);
pathMutationState = workbenchReducer(pathMutationState, {
  type: "ide-delete-path",
  path: "app/components",
});
expect(
  pathMutationState.ide.activePath === undefined &&
    pathMutationState.ide.tabs.length === 0 &&
    pathMutationState.ide.layout.groups[0]?.tabs.length === 0 &&
    Object.keys(pathMutationState.ide.buffers).length === 0 &&
    pathMutationState.ide.selection === undefined,
  "Deleting a workspace directory should remove descendant editor state atomically.",
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
    state.ide.tabs[0]?.dirty === true &&
    state.ide.layout.groups.some((group) =>
      group.tabs.some(
        (tab) =>
          tab.path === "packages/ui/src/surfaces.tsx" && tab.dirty === true,
      ),
    ),
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
    state.ide.layout.groups.every((group) =>
      group.tabs.every(
        (tab) =>
          tab.path !== "packages/ui/src/surfaces.tsx" || tab.dirty === false,
      ),
    ) &&
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
  "get_notification_permission",
  "test_notification",
]) {
  expect(
    appSource.includes(commandName) || tauriSource.includes(commandName),
    `Desktop app no longer references stable Tauri command ${commandName}.`,
  );
}

expect(
  tauriSource.includes("start_automation_scheduler(app.handle().clone())") &&
    tauriSource.includes("run_automation_scheduler_once_with") &&
    tauriSource.includes("execute_claimed_automation") &&
    tauriSource.includes("tauri::RunEvent::Resumed") &&
    tauriSource.includes("wait_for_change") &&
    tauriSource.includes("AutomationSchedulerClock") &&
    tauriSource.includes("automation_scheduler_effective_now") &&
    tauriSource.includes("run_automation_scheduler_once_at_with") &&
    tauriSource.includes("AutomationLeaseHeartbeat") &&
    tauriSource.includes("AUTOMATION_LEASE_HEARTBEAT_INTERVAL") &&
    tauriSource.includes("require_command_approval: true") &&
    tauriSource.includes("require_file_edit_approval: true") &&
    appSource.includes('listen<Automation>("gyro://automation-updated"') &&
    !appSource.includes("pane-automation-${Date.now()}"),
  "Automations should execute through the durable backend provider/session path without opening a terminal panel.",
);

expect(
  tauriSource.includes("tauri_plugin_notification::init()") &&
    tauriSource.includes("notify_automation_outcome") &&
    tauriSource.includes("notification_permission_allows_delivery") &&
    tauriSource.includes("permission_state()") &&
    tauriSource.includes("request_permission()") &&
    tauriSource.includes("A scheduled automation completed") &&
    tauriSource.includes("A scheduled automation failed") &&
    appSource.includes(
      'invoke<NotificationPermissionState>("test_notification")',
    ) &&
    surfaceSource.includes("Test notification") &&
    surfaceSource.includes("Gyro asks only when you run the test") &&
    !tauriSource.includes("body(automation.prompt)") &&
    !tauriSource.includes("body(automation.last_result)"),
  "Background automation outcomes should require explicit native permission and use generic notices without exposing prompts or results.",
);

expect(
  coreAutomationSource.includes("AutomationExecutionContext") &&
    coreAutomationSource.includes("queue_automation_now") &&
    coreAutomationSource.includes("claim_due_automation_at") &&
    coreAutomationSource.includes("renew_automation_lease") &&
    coreAutomationSource.includes("current_expiry.max(requested_expiry)") &&
    coreAutomationSource.includes("finish_automation_lease") &&
    coreAutomationSource.includes("recover_expired_automation_leases") &&
    coreAutomationSource.includes("automation_retry_delay"),
  "Automation storage should preserve execution context, deterministic due claims, leases, interruption recovery, and retry backoff.",
);

expect(
  coreAutomationSource.includes("stop_condition_met: Option<bool>") &&
    coreAutomationSource.includes(
      "finish_automation_lease_with_stop_condition",
    ) &&
    tauriSource.includes("parse_automation_execution_outcome") &&
    tauriSource.includes("gyro-automation-result") &&
    tauriSource.includes("failed closed") &&
    surfaceSource.includes("Stop condition met") &&
    surfaceSource.includes("Reactivate"),
  "Automation stop conditions should fail closed, persist their verdict, complete atomically, and remain visible to the user.",
);

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
      "limitSessionEventsForUi(updateEvents(optimisticEvents))",
    ) &&
    appSource.includes("items.findLastIndex(") &&
    appSource.includes("updateOptimisticProviderStatus") &&
    appSource.includes("setIsStartingFirstTurn") &&
    appSource.includes("sendingSessionIdsRef") &&
    appSource.includes("setSessionSending") &&
    appSource.includes("const activeSessionHasTranscriptEvents = useMemo") &&
    appSource.includes("[activeSessionId, events]") &&
    /shouldSuggestSessionTitle\(\s*activeSession,\s*activeSessionHasTranscriptEvents/.test(
      appSource,
    ) &&
    !appSource.includes(
      "shouldSuggestSessionTitle(\n        activeSession,\n        events",
    ) &&
    appSource.includes("draftResetToken") &&
    appSource.includes("setEventsForSession(") &&
    appSource.includes("limitSessionEventsForUi(optimisticEvents)") &&
    appSource.includes(
      "sessionModel,\n          chatWorkspacePath,\n          provisionalTitle",
    ) &&
    appSource.includes(
      "const draftKey = projectKey ? `new:${projectKey}` : NEW_CHAT_DRAFT_KEY",
    ) &&
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
      "const bySession = new Map<string, ProviderStreamBatch[]>()",
    ) &&
    appSource.includes("(value) => setEventsForSession(sessionId, value)") &&
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
    appSource.includes("applyProviderChatStreamActivity") &&
    appSource.includes('streamEvent.phase === "activity"') &&
    appSource.includes("sessionBatches.map((batch) => ({") &&
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
    providerStreamSource.includes('kind: "provider-activity"') &&
    providerStreamSource.includes("applyProviderChatStreamActivity") &&
    providerStreamSource.includes("receivedTerminalEvent") &&
    providerStreamSource.includes('event.phase === "started"') &&
    appSource.includes('streamEvent.phase === "cancelled"') &&
    providerStreamSource.includes("hasSameTurnAssistant") &&
    appSource.includes("suggestTitle: shouldSuggestTitle") &&
    appSource.includes('kind: "provider-status"') &&
    surfaceSource.includes("function ChatTurn") &&
    surfaceSource.includes("function ChatRunHeader") &&
    surfaceSource.includes("function ProviderActivityRow") &&
    surfaceSource.includes("timelineEvents: SessionEvent[]") &&
    surfaceSource.includes("turn.timelineEvents.push(event)") &&
    surfaceSource.includes('className="gyro-chat-run-sequence"') &&
    surfaceSource.includes(
      'className="gyro-chat-run-timeline is-final-response"',
    ) &&
    surfaceSource.includes('aria-label="Work timeline"') &&
    surfaceSource.includes("interleavedChatTimelineItems") &&
    surfaceSource.includes(
      'isRunning ? "Assistant update" : "Final response"',
    ) &&
    surfaceSource.includes('isRunning ? "Working" : "Worked"') &&
    surfaceSource.includes("formatThoughtDuration") &&
    surfaceSource.includes("formatMessageTime(event.createdAt)") &&
    surfaceSource.includes('aria-label="Copy message"') &&
    surfaceSource.includes("`${hours}h`") &&
    surfaceSource.includes("`${minutes % 60}m`") &&
    surfaceSource.includes("`${seconds}s`") &&
    surfaceSource.includes("interleavedChatTimelineItems") &&
    surfaceSource.includes("providerActivityPathsMatch") &&
    surfaceSource.includes('if (activity.kind === "file")') &&
    surfaceSource.includes("`Ran ${count} commands`") &&
    surfaceSource.includes('activity.kind === "context"') &&
    surfaceSource.includes("<Minimize2") &&
    styleSource.includes(".gyro-chat-run-toggle") &&
    styleSource.includes("max-width: min(78%, 720px)") &&
    styleSource.includes(".gyro-user-message-meta") &&
    styleSource.includes(".gyro-user-message-bubble") &&
    styleSource.includes(
      ".gyro-message.is-user:hover .gyro-user-message-meta",
    ) &&
    !surfaceSource.includes("assistantEvents: SessionEvent[]") &&
    !surfaceSource.includes("activityEvents: SessionEvent[]") &&
    surfaceSource.includes("const isStopAction = Boolean(") &&
    surfaceSource.includes("isStopAction ? (") &&
    surfaceSource.includes('"Stop response"') &&
    surfaceSource.includes('"Queue message"') &&
    surfaceSource.includes("onStop?.();") &&
    surfaceSource.includes(
      "!isStopAction && (!canSubmitComposer || draft.trim().length === 0)",
    ) &&
    surfaceSource.includes('className="gyro-send-button"') &&
    !surfaceSource.includes('className="gyro-composer-stop-button"') &&
    surfaceSource.includes("function ChatMessageQueue") &&
    surfaceSource.includes('aria-label="Queued message options"') &&
    surfaceSource.includes("gyro-chat-message-queue-menu") &&
    surfaceSource.includes("<span>Edit</span>") &&
    surfaceSource.includes("<span>Delete</span>") &&
    appSource.includes("const editQueuedChatMessage") &&
    appSource.includes("onEditQueuedMessage={editQueuedChatMessage}") &&
    styleSource.includes(".gyro-chat-message-queue-menu") &&
    styleSource.includes(
      ".gyro-chat-message-queue:has(.gyro-chat-message-queue-menu)",
    ) &&
    appSource.includes('"Message queued"') &&
    appSource.includes("MAX_QUEUED_CHAT_MESSAGES_PER_SESSION = 8") &&
    appSource.includes("MAX_QUEUED_CHAT_MESSAGES_TOTAL = 24") &&
    appSource.includes("const totalQueued = Object.values(current).reduce") &&
    /queuedChatDispatchMessageIdsRef\.current\.set\([\s\S]*?setChatMessageQueues\([\s\S]*?item\.id !== nextMessage\.id[\s\S]*?void sendDraft\(nextMessage\.message/.test(
      appSource,
    ) &&
    appSource.includes(".then((accepted) =>") &&
    appSource.includes("if (!accepted)") &&
    appSource.includes("queuedChatDispatchMessageIdsRef") &&
    appSource.includes("persistedChatTurnIdsRef") &&
    appSource.includes("didDeliverProviderResponse") &&
    appSource.includes("deliveryAttempts < 2") &&
    appSource.includes('status: shouldRetry ? "waiting" : "failed"') &&
    appSource.includes("Date.now() + 1_500") &&
    appSource.includes("Queued delivery failed") &&
    surfaceSource.includes('message.hasFailed ? "Retry" : "Steer"') &&
    styleSource.includes(".gyro-chat-message-queue article.is-failed") &&
    appSource.includes("sessionModel: { ...sessionModel }") &&
    surfaceSource.includes("message.isDispatching") &&
    surfaceSource.includes("disabled={message.isDispatching}") &&
    !surfaceSource.includes("isRunning && onStopChat") &&
    surfaceSource.includes('activity.kind === "commentary"') &&
    surfaceSource.includes("gyro-chat-run-commentary") &&
    surfaceSource.includes("providerActivityFilePath") &&
    surfaceSource.includes("sourceControlFileForActivityPath") &&
    surfaceSource.includes("chatTurnChangeSummary") &&
    surfaceSource.includes("hasGenericFileActivity") &&
    surfaceSource.includes("sourceControlFileChangedSinceBaseline") &&
    surfaceSource.includes("sourceControlFileDelta") &&
    surfaceSource.includes("sourceControlStatsForActivityPath") &&
    surfaceSource.includes("turnSourceControlBaselines?.[turn.id]") &&
    surfaceSource.includes("gyro-chat-run-change-summary") &&
    surfaceSource.includes('activity.kind === "file"') &&
    surfaceSource.includes('activity.status === "running"') &&
    surfaceSource.includes("hasFileActivity && !isRunning && hasResponse ?") &&
    surfaceSource.includes(
      '`Edited ${fileCount} ${fileCount === 1 ? "file" : "files"}`',
    ) &&
    surfaceSource.includes(
      'className="gyro-chat-run-change-summary is-complete"',
    ) &&
    surfaceSource.includes("changeSummary.fileChanges.map((file)") &&
    !surfaceSource.includes("Hide changed files") &&
    !surfaceSource.includes("Show changed files") &&
    !surfaceSource.includes("showAllFiles") &&
    appSource.includes("refreshedFileActivityKeysRef") &&
    appSource.includes("setTurnSourceControlBaselines") &&
    appSource.includes("sourceControlLineStats(workbench.ide.sourceControl)") &&
    appSource.includes('payload.activityKind !== "file"') &&
    appSource.includes("refreshIdeSourceControl(root)") &&
    appSource.includes("refreshedFileActivityKeysRef.current.clear()") &&
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
    surfaceSource.includes("const turns: ChatTranscriptTurn[] = []") &&
    surfaceSource.includes("const turnsById = new Map") &&
    surfaceSource.includes("isStreamingAssistantEvent") &&
    surfaceSource.includes("ASSISTANT_RESPONSE_RICH_PARSE_MAX_CHARS") &&
    surfaceSource.includes('{ kind: "ordered-list"; items: string[] }') &&
    surfaceSource.includes("structuredCommentaryBlocks(activity.label)") &&
    surfaceSource.includes("stripHiddenSessionTitleMarker") &&
    surfaceSource.includes("isHiddenSessionTitleActivity") &&
    surfaceSource.includes("const shouldUsePlainText") &&
    surfaceSource.includes(
      "visibleMessage.length > ASSISTANT_RESPONSE_RICH_PARSE_MAX_CHARS",
    ) &&
    surfaceSource.includes("gyro-response-streaming-text") &&
    styleSource.includes(".gyro-response-streaming-text") &&
    surfaceSource.includes("gyro-chat-run-thinking") &&
    surfaceSource.includes("isRunning && turn.timelineEvents.length === 0") &&
    styleSource.includes(".gyro-chat-run-header") &&
    surfaceSource.includes("visibleWorkTimelineItems") &&
    surfaceSource.includes("responseTimelineItems") &&
    styleSource.includes(".gyro-chat-run-activity") &&
    styleSource.includes(".gyro-chat-run-activity.is-file") &&
    styleSource.includes(".gyro-chat-run-change-summary") &&
    styleSource.includes(".gyro-chat-run-timeline") &&
    styleSource.includes("@keyframes gyro-chat-composer-dock-enter") &&
    styleSource.includes("@keyframes gyro-chat-final-response-enter") &&
    surfaceSource.includes("isHiddenTranscriptEvent") &&
    surfaceSource.includes('"provider-diagnostics"') &&
    styleSource.includes(
      ".gyro-chat-transcript .gyro-message.is-assistant:hover .gyro-response-actions",
    ) &&
    typeSource.includes("ProviderChatStreamEvent") &&
    typeSource.includes("ProviderResumeCursor") &&
    tauriSource.includes("SessionEventKind::AssistantMessage") &&
    tauriSource.includes("ProviderResumeCursor") &&
    tauriSource.includes("ProviderChatStreamEvent") &&
    tauriSource.includes("extract_provider_activity") &&
    tauriSource.includes("extract_provider_commentary_activity") &&
    tauriSource.includes("provider_activities_for_response") &&
    tauriSource.includes('text.contains("GYRO_SESSION_TITLE:")') &&
    tauriSource.includes("polished, scannable Markdown") &&
    tauriSource.includes("provider_activity_event_entry") &&
    tauriSource.includes("append_system_events_with_turn_id") &&
    tauriSource.includes('phase: "activity".into()') &&
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
    coreProviderStreamSource.includes("pub enum ProviderTextChunk") &&
    tauriSource.includes("ProviderTextChunk::Snapshot") &&
    tauriSource.includes("push_assistant_snapshot") &&
    coreProviderStreamSource.includes("extract_provider_text_value") &&
    coreProviderStreamSource.includes('Some("reasoning" | "reasoning_text")') &&
    tauriSource.includes("extract_provider_text_delta") &&
    tauriSource.includes("PROVIDER_CHAT_EVENT") &&
    tauriSource.includes("clear_provider_session_binding") &&
    tauriSource.includes("upsert_provider_session_binding") &&
    tauriSource.includes("validate_chat_message") &&
    tauriSource.includes("async fn run_provider_chat") &&
    /spawn_blocking\(move \|\|\s*\{?\s*run_provider_chat_blocking\((?:app|worker_app),\s*request\)/.test(
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
    coreExecutionSource.includes("stdin(Stdio::null())") &&
    tauriSource.includes("sanitize_provider_text_delta") &&
    tauriSource.includes("extract_codex_agent_message_text") &&
    tauriSource.includes('"item.completed"') &&
    tauriSource.includes("PROVIDER_CHAT_MAX_RUNTIME_SECS") &&
    tauriSource.includes("PROVIDER_CHAT_INACTIVITY_TIMEOUT_SECS") &&
    tauriSource.includes(
      "execution.inactivity_timeout = Some(inactivity_timeout)",
    ) &&
    tauriSource.includes("ExecutionTermination::Inactive") &&
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
    coreSessionsSource.includes("read_recent_event_lines") &&
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
  appSource.includes("sendingSessionIds={sendingSessionIds}") &&
    appSource.includes(
      "(value) => setEventsForSession(streamEvent.sessionId, value)",
    ) &&
    surfaceSource.includes("sendingSessionIds.includes(session.id)") &&
    surfaceSource.includes('aria-label={isSending ? "Chat working"') &&
    surfaceSource.includes("gyro-session-time is-working") &&
    styleSource.includes(".gyro-session-time.is-working svg"),
  "Background chats should keep session-scoped updates and show a rotating sidebar activity indicator.",
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
  appSource.includes('pane.profileId === "shell"') &&
    appSource.includes("profileId: profile.id") &&
    appSource.includes(
      "snapshot.profileId ?? inferredTerminalProfileId(snapshot)",
    ) &&
    appSource.includes("restored snapshot; restart to reconnect") &&
    appSource.includes("terminalPaneProcessIsMissing(error)") &&
    appSource.includes('"terminal_pane_has_foreground_job"') &&
    tauriSource.includes("profile_id: process.request.profile_id.clone()") &&
    tauriSource.includes("fn has_foreground_job") &&
    tauriSource.includes("terminal_pane_has_foreground_job"),
  "Idle shells should preserve their profile identity and close directly while foreground jobs remain protected.",
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
    surfaceSource.includes("Review in Workspace") &&
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
  appSource.includes("sessionEventsRequestRef") &&
    appSource.includes(
      "sessionEventsRequestRef.current[sessionId] === requestId",
    ) &&
    appSource.includes("optimisticEvents && optimisticEvents.length > 0") &&
    appSource.includes("workspaceSearchRequestRef") &&
    appSource.includes("workspaceTreeRequestRef") &&
    appSource.includes("ideSourceControlRequestRef") &&
    appSource.includes("ideServicesRequestRef") &&
    appSource.includes("if (cancelled)") &&
    reducerSource.includes(
      "existingPane.workingDirectory === nextWorkingDirectory",
    ),
  "Chat, CLI, and Workspace async refreshes should reject stale results and preserve current state on transient failures.",
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
    appSource.includes(
      "const terminalPanePollKey = liveTerminalPaneIds.join",
    ) &&
    appSource.includes("isActiveSessionSending") &&
    appSource.includes("const pollInterval = isActiveSessionSending") &&
    appSource.includes('document.addEventListener("visibilitychange"') &&
    appSource.includes("selectedPaneId === snapshot.paneId") &&
    appSource.includes("knownOutputRevision") &&
    appSource.includes("terminalOutputRevisionRef") &&
    appSource.includes("terminalReadInFlightRef") &&
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
    tauriSource.includes("known_output_revision") &&
    tauriSource.includes("output_revision") &&
    tauriSource.includes("snapshot_terminal_output") &&
    tauriSource.includes("has_foreground_job") &&
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
  appSource.includes(': "Home"') &&
    tauriSource.includes(
      'request.working_directory.as_deref() == Some("Home")',
    ) &&
    tauriSource.includes("fn user_home_directory()") &&
    tauriSource.includes("return Ok(Some(user_home_directory()?));"),
  "Interactive CLI terminals should start in the user's home directory instead of inheriting the Gyro workspace.",
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
    !appSource.includes("GyroAccountGate") &&
    !appSource.includes("gyro-account-gate") &&
    !appSource.includes("Use Gyro on this Mac") &&
    !appSource.includes("if (!accountSession.signedIn)") &&
    !appSource.includes("External Claude/OpenAI logins") &&
    !appSource.includes('className="gyro-account-provider"') &&
    !styleSource.includes(".gyro-account-gate") &&
    !styleSource.includes(".gyro-account-panel") &&
    !styleSource.includes(".gyro-account-provider") &&
    tauriSource.includes("get_account_session") &&
    tauriSource.includes("start_account_login") &&
    tauriSource.includes("refresh_account_session") &&
    tauriSource.includes("logout_account"),
  "First-install access gate removal or native account compatibility is missing.",
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
    surfaceSource.includes("gyro-sidebar-persistent-header") &&
    styleSource.includes(".gyro-sidebar-persistent-header") &&
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
    tauriConfig.app.windows[0].trafficLightPosition.x === 16 &&
    tauriConfig.app.windows[0].trafficLightPosition.y === 21 &&
    surfaceSource.includes("New Chat") &&
    surfaceSource.includes('aria-label="Primary surfaces"') &&
    surfaceSource.includes("function restingSidebarWidth()") &&
    surfaceSource.includes("ideSidebarMinimumWidth * 2") &&
    surfaceSource.includes('aria-label="Resize Workspace sidebar"') &&
    surfaceSource.includes('role="separator"') &&
    surfaceSource.includes("onDoubleClick") &&
    surfaceSource.includes("resizeIdeSidebarWithKeyboard") &&
    surfaceSource.includes("syncIdeSidebarBreakpoint") &&
    surfaceSource.includes('window.addEventListener("resize"') &&
    surfaceSource.includes("isIdeSidebarCustomized") &&
    surfaceSource.includes("requestAnimationFrame") &&
    surfaceSource.includes("appShellRef.current?.style.setProperty") &&
    styleSource.includes(".gyro-ide-sidebar-resizer") &&
    styleSource.includes("grid-template-columns 180ms") &&
    styleSource.includes("will-change: grid-template-columns") &&
    surfaceSource.includes('label="Sessions"') &&
    surfaceSource.includes('label="Workspace"') &&
    !surfaceSource.includes('label="IDE"') &&
    surfaceSource.indexOf('aria-label="Primary surfaces"') <
      surfaceSource.indexOf('className="gyro-sidebar-actions"') &&
    surfaceSource.includes("gyro-sidebar-project-chat-list") &&
    surfaceSource.includes("gyro-sidebar-small-title") &&
    surfaceSource.includes("collapsedProjectIds") &&
    surfaceSource.includes("expandedProjectIds") &&
    surfaceSource.includes("sidebarProjectGroups") &&
    !surfaceSource.includes("if (groups.size === 0)") &&
    surfaceSource.includes("toggleProjectMore") &&
    surfaceSource.includes("aria-expanded={isCollapsed") &&
    styleSource.includes(".gyro-sidebar-collapse-icon") &&
    styleSource.includes(".gyro-sidebar-more-button") &&
    surfaceSource.includes("projectSidebarName") &&
    surfaceSource.includes("SessionSidebarRow") &&
    !surfaceSource.includes("localCliPanes") &&
    surfaceSource.includes("Create Chat or CLI session") &&
    !surfaceSource.includes("meta={String(commandProfiles.length)}") &&
    !surfaceSource.includes("visibleCommandProfiles") &&
    surfaceSource.includes('title="Explorer"') &&
    surfaceSource.includes('aria-label="Code tools"') &&
    surfaceSource.includes('className="gyro-ide-panel-shortcuts"') &&
    surfaceSource.includes("headerActions={") &&
    styleSource.includes(".gyro-sidebar-section-heading") &&
    styleSource.includes(".gyro-ide-panel-shortcuts") &&
    !surfaceSource.includes("Run terminal") &&
    !surfaceSource.includes("Split pane") &&
    !surfaceSource.includes("Command search") &&
    surfaceSource.includes("Diff review") &&
    surfaceSource.includes("Browser preview") &&
    !surfaceSource.includes('title="Chats"') &&
    !surfaceSource.includes("primarySidebarActionForLayout") &&
    !surfaceSource.includes('<SidebarSection title="Layouts">'),
  "The shared shell should expose Sessions and Workspace while preserving Chat, CLI, and Workspace-specific content.",
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
  appSource.includes("openUrl, revealItemInDir") &&
    appSource.includes("openBrowserPreviewExternal") &&
    appSource.includes("invoke<BrowserPreviewCapture>(") &&
    appSource.includes('"capture_browser_preview"') &&
    appSource.includes("browser-capture-success") &&
    surfaceSource.includes('title="Local browser preview"') &&
    surfaceSource.includes('aria-label="Capture preview screenshot"') &&
    surfaceSource.includes("isLoopbackBrowserPreviewUrl") &&
    surfaceSource.includes("Screenshots are available for local previews") &&
    surfaceSource.includes('onScreenshot?.("reveal")') &&
    surfaceSource.includes("normalizedBrowserPreviewUrl") &&
    surfaceSource.includes("<iframe") &&
    surfaceSource.includes("Browser preview diagnostics") &&
    surfaceSource.includes("No page errors") &&
    appSource.includes("result.diagnostics.length") &&
    tauriSource.includes("capture_browser_preview_diagnostics") &&
    tauriSource.includes("capture_macos_browser_preview_snapshot") &&
    tauriSource.includes("takeSnapshotWithConfiguration_completionHandler") &&
    tauriSource.includes("persist_browser_preview_capture") &&
    tauriSource.includes("MAX_BROWSER_PREVIEW_CAPTURES") &&
    tauriSource.includes(
      "screenshots are limited to local loopback previews",
    ) &&
    tauriSource.includes("browser_preview_capture_script") &&
    tauriSource.includes(".incognito(true)") &&
    tauriSource.includes(".visible(false)") &&
    tauriSource.includes("console.error") &&
    tauriSource.includes("unhandledrejection") &&
    tauriSource.includes("redact_secrets") &&
    !tauriSource.includes("dangerousRemoteDomainIpcAccess") &&
    !surfaceSource.includes("gyro-browser-skeleton") &&
    !reducerSource.includes("screenshotCount") &&
    reducerSource.includes('url: "http://localhost:3000"') &&
    tauriConfigSource.includes("frame-src http://localhost:*") &&
    tauriConfigSource.includes("http://127.0.0.1:*") &&
    styleSource.includes(".gyro-browser-page iframe"),
  "Browser preview should render a real local URL, open it externally, and collect bounded loopback diagnostics without remote Tauri IPC.",
);

expect(
  appSource.includes("const started = await launchTerminalPane") &&
    appSource.includes("agent failed to start") &&
    appSource.includes("task.terminalPaneId") &&
    appSource.includes("Automation queued") &&
    surfaceSource.includes("Running") &&
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
expect(
  surfaceSource.includes('className="gyro-ide-project-empty"') &&
    surfaceSource.includes("Open a project to start coding") &&
    surfaceSource.includes(
      "Local workspace · guarded edits · reviewable changes",
    ) &&
    surfaceSource.includes("if (!workspacePath)") &&
    appSource.includes(
      "workspacePath={activeSession?.workspacePath ?? workspacePath}",
    ) &&
    appSource.includes("onOpenWorkspace={openWorkspace}") &&
    appSource.includes('activeWorkspaceLayout !== "code" ||') &&
    surfaceSource.includes(
      'disabled={!workspacePath && view.id !== "settings"}',
    ) &&
    surfaceSource.includes(
      'workspacePath ? (\n            <nav className="gyro-ide-panel-shortcuts"',
    ) &&
    styleSource.includes(".gyro-ide-surface.is-project-empty") &&
    styleSource.includes(".gyro-ide-sidebar-activity button:disabled") &&
    styleSource.includes(".gyro-ide-project-empty > button:focus-visible"),
  "IDE should lead with one project-opening action and withhold inactive workbench regions until a project exists.",
);
const chatSidebarSource = surfaceSource.slice(
  surfaceSource.indexOf("{isSessionsSidebar ? ("),
  surfaceSource.indexOf("function SidebarSection"),
);
expect(
  cssRules(styleSource, ".gyro-sidebar-new-session-menu").some(
    (rule) =>
      rule.includes("border: 1px solid var(--gyro-premium-hairline-soft)") &&
      rule.includes("box-shadow: 0 8px 20px var(--gyro-premium-shadow-soft)") &&
      rule.includes("padding: 4px"),
  ) &&
    cssRules(styleSource, ".gyro-sidebar-cli-location select").some((rule) =>
      rule.includes("min-height: 28px"),
    ),
  "The New menu should keep a compact, low-emphasis surface and project picker.",
);
expect(
  chatSidebarSource.includes("New Chat") &&
    chatSidebarSource.includes("<span>CLI</span>") &&
    chatSidebarSource.includes("CLI session location") &&
    !chatSidebarSource.includes("Start in the focused project") &&
    !chatSidebarSource.includes(": profile.command") &&
    chatSidebarSource.includes("commandProfiles.map") &&
    chatSidebarSource.includes("Search") &&
    chatSidebarSource.includes("gyro-sidebar-project-chat-list") &&
    chatSidebarSource.includes("Pinned") &&
    chatSidebarSource.includes("Projects") &&
    chatSidebarSource.includes(
      "pinnedSessions.map((session) => renderSessionRow(session))",
    ) &&
    chatSidebarSource.includes("projectGroups.map") &&
    chatSidebarSource.includes("project.items.slice(0, 3)") &&
    surfaceSource.includes("const primaryGyroProjectPath = [") &&
    surfaceSource.includes("projectGroupKey(path, primaryGyroProjectPath)") &&
    surfaceSource.includes('projectSidebarName(normalizedPath) === "Gyro"') &&
    chatSidebarSource.includes(
      "const activeProjectSession = project.items.find",
    ) &&
    chatSidebarSource.includes(
      "!collapsedProjectSessions.includes(activeProjectSession)",
    ) &&
    chatSidebarSource.includes("...collapsedProjectSessions.slice(0, 2)") &&
    chatSidebarSource.includes("toggleProject(project.key)") &&
    chatSidebarSource.includes("toggleProjectMore(project.key)") &&
    chatSidebarSource.includes("gyro-sidebar-more-button") &&
    chatSidebarSource.includes("No recent sessions") &&
    !chatSidebarSource.includes("Local CLI") &&
    !chatSidebarSource.includes("<small>Start one</small>") &&
    chatSidebarSource.includes("onOpenWorkspace();") &&
    !chatSidebarSource.includes("Scheduled") &&
    !chatSidebarSource.includes("Plugins") &&
    !chatSidebarSource.includes('title="Projects"') &&
    !chatSidebarSource.includes("activeSession.worktreeName") &&
    !chatSidebarSource.includes('onSelectDestination("automations")'),
  "Sessions sidebar should combine Chat and CLI rows, merge duplicate Gyro workspace groups, keep the active row visible, and omit unrelated destinations.",
);
expect(
  appSource.includes("const createCliSession = useCallback") &&
    appSource.includes("workspacePathOverride: projectPath") &&
    appSource.includes("workingDirectory: launchWorkspacePath") &&
    appSource.includes("existingPane?.projectPath") &&
    appSource.includes("selectedPane?.projectPath") &&
    appSource.includes("projectPath: snapshot.workspacePath") &&
    appSource.includes("onCreateCliSession={createCliSession}") &&
    appSource.includes('type: "select-sessions"') &&
    surfaceSource.includes("onCreateCliSession(") &&
    surfaceSource.includes(
      "onCreateCliSession(profile.id, newCliWorkspacePath)",
    ) &&
    surfaceSource.includes("!newCliWorkspacePath") &&
    surfaceSource.includes("pane.projectPath ?? pane.workingDirectory") &&
    surfaceSource.includes("selectedTerminalPaneId"),
  "New CLI should require a project and restore beneath that project in Sessions.",
);
expect(
  styleSource.includes(".gyro-sidebar-mode-row:focus-visible") &&
    styleSource.includes(
      ".gyro-app-shell.is-chat-shell .gyro-sidebar-mode-row:focus-visible",
    ) &&
    styleSource.includes(
      "box-shadow: inset 0 0 0 0.5px var(--gyro-premium-hairline-soft)",
    ),
  "Sidebar Sessions/Workspace tabs should keep a quiet active/focus state without the underglow.",
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
    surfaceSource.includes("settingsSearchEntries") &&
    surfaceSource.includes("settingsSearchResults(settingsQuery)") &&
    surfaceSource.includes('role="combobox"') &&
    surfaceSource.includes('role="listbox"') &&
    surfaceSource.includes("data-setting-key={settingsSearchKey(label)}") &&
    surfaceSource.includes('className="gyro-settings-topbar"') &&
    surfaceSource.includes('aria-label="Clear settings search"') &&
    !surfaceSource.includes("gyro-settings-sidebar-search") &&
    !surfaceSource.includes("query={settingsQuery}") &&
    styleSource.includes(".gyro-settings-topbar-search:focus-within") &&
    styleSource.includes(".gyro-settings-search-results") &&
    styleSource.includes(".gyro-settings-row.is-search-target") &&
    cssRules(styleSource, ".gyro-settings-topbar").some(
      (rule) =>
        rule.includes("position: fixed") &&
        rule.includes("justify-content: center"),
    ) &&
    styleSource.includes(
      ".gyro-main:has(> .gyro-settings-topbar) > .gyro-settings-surface",
    ) &&
    surfaceSource.includes("gyro-settings-sidebar-group") &&
    surfaceSource.includes('aria-label="Back from settings"') &&
    surfaceSource.includes("gyro-settings-back-button") &&
    surfaceSource.includes("<h2>{label}</h2>") &&
    surfaceSource.includes('aria-pressed={themeMode === "dark"}') &&
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
    styleSource.includes(".gyro-settings-section > header h1") &&
    appSource.includes("lastNonSettingsDestinationRef") &&
    appSource.includes("returnFromSettings"),
  "Settings should keep a stable grouped sidebar and use a centered result dropdown that targets individual settings.",
);
expect(
  !appSource.includes("WorkspaceToolPanelPeek") &&
    appSource.includes("toolPanelHeight") &&
    appSource.includes("DEFAULT_TOOL_PANEL_HEIGHT = 280") &&
    surfaceSource.includes("TOOL_PANEL_DEFAULT_HEIGHT = 280") &&
    surfaceSource.includes("data-active-tab={effectivePaneTab}") &&
    surfaceSource.includes("terminalTitle={activeTerminalPane?.title}") &&
    surfaceSource.includes("gyro-tool-panel-resize-handle") &&
    surfaceSource.includes("TOOL_PANEL_COLLAPSE_HEIGHT") &&
    surfaceSource.includes(
      'const effectivePaneTab = terminalOnly ? "terminal" : activePaneTab',
    ) &&
    surfaceSource.includes('tab.id === "terminal"') &&
    appSource.includes('openToolPanel("terminal")') &&
    !styleSource.includes(".gyro-tool-panel-reveal") &&
    styleSource.includes(".gyro-workspace-tool-panel.is-resizable") &&
    styleSource.includes('[data-active-tab="terminal"]') &&
    styleSource.includes(".gyro-terminal-toolbar {\n  display: none;") &&
    !styleSource.includes("button:not(.gyro-pane-add):not(.is-active)"),
  "Chat bottom panel should be a terminal-only tray opened from the explicit top control, with no reveal strip.",
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
    surfaceSource.includes("function PlanDocument") &&
    surfaceSource.includes("function PlanArtifactCard") &&
    typeSource.includes("content?: string") &&
    appSource.includes("assistantContentByTurnId") &&
    surfaceSource.includes("gyro-plan-inline-editor") &&
    surfaceSource.includes('aria-label="Plan item title"') &&
    surfaceSource.includes('aria-label="Save plan item"') &&
    surfaceSource.includes('aria-label="Session goal"') &&
    surfaceSource.includes('aria-label="Save session goal"') &&
    surfaceSource.includes("Set session goal") &&
    surfaceSource.includes('kind: "goal" | "item"') &&
    surfaceSource.includes("editorRequest={planEditorRequest}") &&
    surfaceSource.includes("onEditorRequestHandled?.()") &&
    surfaceSource.includes("handledEditorRequestTokenRef") &&
    surfaceSource.includes("const sidePanel = activeRailPanel ? (") &&
    surfaceSource.includes("{sidePanel}") &&
    surfaceSource.includes('"Reopen goal"') &&
    /sessionGoal\.status\s*===\s*"complete"\s*\?\s*"reopen"\s*:\s*"complete"/.test(
      surfaceSource,
    ) &&
    appSource.includes('action === "set" || action === "reopen"') &&
    appSource.includes("Goal reopened:") &&
    surfaceSource.includes('event.kind === "goal-updated"') &&
    surfaceSource.includes('event.kind === "chat-mode-changed"') &&
    surfaceSource.includes('event.key === "Escape"') &&
    appSource.includes("const title = value?.trim()") &&
    appSource.includes("const appendGoalEvent = useCallback") &&
    appSource.includes('case "add-goal"') &&
    appSource.includes("setIsGoalComposerActive(true)") &&
    surfaceSource.includes("isGoalComposerActive ?") &&
    surfaceSource.includes(
      'onGoalAction?.(sessionGoal?.text ? "edit" : "set"',
    ) &&
    appSource.includes('kind: "item",') &&
    appSource.includes("planEditorRequestTokenRef.current += 1") &&
    !appSource.includes('window.prompt("Session goal"') &&
    !appSource.includes('window.prompt("Add plan item"') &&
    appSource.includes("createGoalSessionEvent") &&
    appSource.includes('kind: "goal-updated"') &&
    styleSource.includes(".gyro-plan-inline-editor") &&
    styleSource.includes(".gyro-plan-artifact-card") &&
    styleSource.includes(".gyro-plan-harness") &&
    styleSource.includes(".gyro-plan-progress") &&
    surfaceSource.includes('aria-label="Plan harness"') &&
    surfaceSource.includes('role="progressbar"') &&
    surfaceSource.includes("model-managed checklist") &&
    surfaceSource.includes(
      'activeRailPanel === "plan" && sessionPlan?.content ? "has-plan" : ""',
    ) &&
    styleSource.includes(".gyro-chat-surface.is-empty.has-environment") &&
    styleSource.includes(".gyro-chat-start\n  .gyro-composer-shell") &&
    styleSource.includes("padding-top: 60px;") &&
    styleSource.includes("z-index: 71;") &&
    styleSource.includes("cursor: pointer;"),
  "AI model checklist plan events should be typed, persisted, derived, and visible in chat.",
);
expect(
  surfaceSource.includes('activeRailPanel ? "has-environment" : ""') &&
    surfaceSource.includes('aria-label="Environment"') &&
    surfaceSource.includes('aria-label="Plan harness"') &&
    surfaceSource.includes("function ChatEnvironmentLauncher") &&
    surfaceSource.includes('className="gyro-chat-tool-launcher"') &&
    surfaceSource.includes("<span>Changes</span>") &&
    surfaceSource.includes("<span>Terminal</span>") &&
    surfaceSource.includes("<span>Browser</span>") &&
    surfaceSource.includes("<span>Files</span>") &&
    surfaceSource.includes("<span>Plan</span>") &&
    surfaceSource.includes("function chatToolBrowserStatusLabel") &&
    surfaceSource.includes('return "Needs attention"') &&
    surfaceSource.includes("aria-label={`Open Browser, ${browserLabel}`}") &&
    surfaceSource.includes("aria-label={`Open Changes, ${changesLabel}`}") &&
    surfaceSource.includes("Open files in Workspace") &&
    surfaceSource.includes("<small>Open Workspace</small>") &&
    surfaceSource.includes('"has-activity"') &&
    surfaceSource.includes('"has-warning"') &&
    !surfaceSource.includes('(browserPreview?.status ?? "Ready")') &&
    surfaceSource.includes('onOpenTool("diff")') &&
    surfaceSource.includes('onOpenTool("terminal")') &&
    surfaceSource.includes('onOpenTool("browser")') &&
    surfaceSource.includes("onToggleToolPanel={onToggleToolPanel}") &&
    surfaceSource.includes('"Close bottom drawer"') &&
    surfaceSource.includes('"Open bottom drawer"') &&
    appSource.includes("const toggleChatToolPanel = useCallback") &&
    appSource.includes("openToolPanel(workbench.activePaneTab)") &&
    appSource.includes('openToolPanel("terminal")') &&
    !surfaceSource.includes('"Open last used panel"') &&
    surfaceSource.includes("onClick={onToggleToolPanel}") &&
    surfaceSource.includes('onComposerAction?.("open-files")') &&
    appSource.includes('case "open-files":') &&
    appSource.includes('layout: "code"') &&
    styleSource.includes(".gyro-chat-tool-launcher") &&
    styleSource.includes("button.has-activity > small") &&
    styleSource.includes("button.has-warning > small") &&
    styleSource.includes("minmax(260px, 40vh)") &&
    styleSource.includes("min-height: 36px;") &&
    styleSource.includes(".gyro-chat-tool-close") &&
    appSource.includes('dispatchWorkbench({ type: "set-chat-panel" })') &&
    surfaceSource.includes('action: "new-chat-select-workspace"') &&
    surfaceSource.includes('"new-local-chat-select-workspace"') &&
    surfaceSource.includes('"start-new-chat-mode:worktree"') &&
    surfaceSource.includes("This context stays fixed for the current chat") &&
    surfaceSource.includes("Keep this chat intact and choose another folder") &&
    !surfaceSource.includes('onComposerAction?.("show-project-context")') &&
    !surfaceSource.includes('onComposerAction?.("select-workspace-mode")') &&
    surfaceSource.includes('onComposerAction?.("select-branch")') &&
    surfaceSource.includes("sourceControl?.additions") &&
    surfaceSource.includes("sourceControl?.deletions") &&
    surfaceSource.includes("sourceControl?.files.length") &&
    !surfaceSource.includes("gyro-thread-diff-pill") &&
    surfaceSource.includes("hasFileActivity && !isRunning && hasResponse ?") &&
    surfaceSource.includes(
      'className="gyro-chat-run-change-summary is-complete"',
    ) &&
    surfaceSource.includes('onOpenToolPanel?.("diff")') &&
    styleSource.includes(".gyro-thread-diff-pill em.is-added") &&
    styleSource.includes(".gyro-thread-diff-pill em.is-removed") &&
    appSource.includes("savedProjectsFromSessions") &&
    appSource.includes('"gyro.recent-project-paths"') &&
    appSource.includes("loadRecentProjectPaths") &&
    appSource.includes("setRecentProjectPaths((current)") &&
    appSource.includes('"Recent project"') &&
    appSource.includes("select-saved-project:") &&
    surfaceSource.includes("savedProjectItems") &&
    surfaceSource.includes(
      "select-saved-project:${encodeURIComponent(project.path)}",
    ) &&
    surfaceSource.includes("if (isHiddenTranscriptEvent(event))") &&
    surfaceSource.includes("gyro-provider-status-row") &&
    surfaceSource.includes("gyro-chat-turn") &&
    surfaceSource.includes("gyro-chat-run") &&
    styleSource.includes(".gyro-thread-topbar-actions") &&
    styleSource.includes(".gyro-chat-composer-dock .gyro-composer-shell") &&
    surfaceSource.includes('aria-label="Jump to latest message"') &&
    surfaceSource.includes("isTranscriptAwayFromBottom") &&
    surfaceSource.includes("distanceFromBottom > 72") &&
    surfaceSource.includes('behavior: "smooth"') &&
    styleSource.includes(".gyro-chat-jump-to-bottom") &&
    styleSource.includes("bottom: calc(100% + 10px)") &&
    surfaceSource.includes('popoverPlacement="up"') &&
    surfaceSource.includes('variant="hero"') &&
    surfaceSource.includes("constrainToParent={Boolean(activeRailPanel)}") &&
    surfaceSource.includes('constrainToParent ? "stretch" : "center"') &&
    surfaceSource.includes("width: constrainToParent") &&
    surfaceSource.includes("showContextRow={false}") &&
    surfaceSource.includes(
      "const shouldShowContextRow = showContextRow ?? isHero",
    ) &&
    surfaceSource.includes("{shouldShowContextRow ? (") &&
    styleSource.includes(".gyro-composer-shell textarea:focus-visible") &&
    styleSource.includes(
      ".gyro-chat-composer-dock .gyro-composer-shell:focus-within",
    ) &&
    styleSource.includes(
      ".gyro-chat-composer-dock .gyro-composer-shell.is-hero.has-provider",
    ) &&
    /\.gyro-chat-composer-dock \.gyro-composer-shell\.is-hero\.has-provider\s*\{[\s\S]*?max-width:\s*var\(--gyro-chat-content-width\);[\s\S]*?width:\s*min\(100%,\s*var\(--gyro-chat-content-width\)\);/.test(
      styleSource,
    ) &&
    surfaceSource.includes("!event.shiftKey") &&
    surfaceSource.includes("event.preventDefault()") &&
    styleSource.includes("--gyro-chat-content-width: 772px") &&
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
    surfaceSource.includes('"gyro-chat-surface",\n        "is-thread"') &&
    styleSource.includes(
      ".gyro-chat-surface.is-thread > .gyro-chat-thread-topbar",
    ) &&
    styleSource.includes("grid-column: 1 / -1") &&
    styleSource.includes("justify-self: stretch") &&
    styleSource.includes("padding-inline: 18px") &&
    styleSource.includes("width: 100%") &&
    styleSource.includes(
      ".gyro-chat-surface.is-thread > .gyro-chat-thread-canvas",
    ) &&
    styleSource.includes("grid-template-rows: minmax(0, 1fr) auto") &&
    threadSurfaceRules.some((rule) =>
      rule.includes("grid-template-rows: 48px minmax(0, 1fr)"),
    ) &&
    threadTopbarRules.some(
      (rule) =>
        rule.includes("grid-column: 1 / -1") &&
        rule.includes("grid-row: 1") &&
        rule.includes("justify-self: stretch") &&
        rule.includes("width: 100%"),
    ) &&
    threadCanvasRules.some(
      (rule) => rule.includes("grid-row: 2") && rule.includes("min-height: 0"),
    ) &&
    threadRailRules.some(
      (rule) => rule.includes("grid-column: 2") && rule.includes("grid-row: 2"),
    ) &&
    surfaceSource.includes("function AssistantResponse") &&
    surfaceSource.includes("gyro-response-body") &&
    surfaceSource.includes('aria-label="Copy response"') &&
    styleSource.includes(".gyro-chat-transcript .gyro-message.is-user") &&
    styleSource.includes("justify-items: end") &&
    styleSource.includes("width: min(100%, var(--gyro-chat-content-width))") &&
    styleSource.includes("max-width: 100%") &&
    styleSource.includes("pointer-events: none") &&
    surfaceSource.includes("isUser || isAssistant ? null") &&
    !surfaceSource.includes("<strong>Workbench activity</strong>") &&
    !surfaceSource.includes("Open terminal\n          </button>"),
  "First chat should default to a clean Codex-style thread with a fixed full-width topbar, provider status recovery, and matching docked composer.",
);
expect(
  /:root\[data-theme="dark"\] \.gyro-chat-surface:not\(\.is-empty\),[\s\S]*?\.gyro-chat-composer-dock \{\s*background: var\(--gyro-app\);\s*\}/.test(
    styleSource,
  ),
  "Start-chat and in-chat canvases should share the same dark app background.",
);
expect(
  reducerSource.includes("activeChatPanel: panel") &&
    reducerSource.includes("chatEnvironmentRailOpen: panel !== undefined") &&
    appSource.includes('dispatchWorkbench({ type: "set-chat-panel" });') &&
    !appSource.includes(
      'panel: "environment" });\n        dispatchWorkbench({\n          type: "select-workspace-layout"',
    ),
  "Opening or selecting a chat should use the standard clean thread layout, not the Environment panel.",
);
expect(
  packageSource.includes('"desktop:bundle"') &&
    packageSource.includes('"desktop:install-local"') &&
    installLocalSource.includes("isInstalledAppRunning") &&
    installLocalSource.includes("waitForInstalledAppState(false)") &&
    installLocalSource.includes("waitForInstalledAppState(true)") &&
    installLocalSource.includes('application id "dev.gyro.desktop"') &&
    readmeSource.includes("target/debug/gyro-desktop") &&
    launchDocsSource.includes("open target/release/bundle/macos/Gyro.app") &&
    launchDocsSource.includes("~/Applications/Gyro.app") &&
    launchDocsSource.includes("generic `exec` Dock icon"),
  "Local app launch docs and scripts should steer users to Gyro.app instead of the raw debug executable.",
);
const updateControlStart = surfaceSource.indexOf(
  'className="gyro-sidebar-update is-windowbar"',
);
const updateControlSource = surfaceSource.slice(
  updateControlStart,
  surfaceSource.indexOf(
    'className="gyro-sidebar-titlebar-drag-region"',
    updateControlStart,
  ),
);
expect(
  surfaceSource.includes('className="gyro-sidebar-update is-windowbar"') &&
    surfaceSource.indexOf('className="gyro-sidebar-update is-windowbar"') >
      surfaceSource.indexOf('aria-label="Forward"') &&
    updateControlSource.includes(
      "onClick={() => onUpdateAction?.(updateState)}",
    ) &&
    updateControlSource.includes('className="gyro-sidebar-update-percent"') &&
    updateControlSource.includes("updateState.progressPercent ?? 0") &&
    updateControlSource.includes('updateState.status === "ready"') &&
    updateControlSource.includes("<RefreshCw") &&
    !updateControlSource.includes('aria-haspopup="dialog"') &&
    !surfaceSource.includes("function UpdatePopover") &&
    styleSource.includes(".gyro-sidebar-update-button") &&
    styleSource.includes(".gyro-sidebar-update.is-windowbar") &&
    styleSource.includes("--gyro-update-blue: #356fd6") &&
    styleSource.includes("background: var(--gyro-update-blue)") &&
    styleSource.includes("display: inline-flex") &&
    styleSource.includes("justify-content: center") &&
    styleSource.includes("grid-template-columns: none") &&
    styleSource.includes("height: 24px") &&
    styleSource.includes("width: 24px") &&
    styleSource.includes("height: 11px") &&
    styleSource.includes("width: 11px") &&
    styleSource.includes(".gyro-sidebar-update-percent") &&
    !styleSource.includes(".gyro-sidebar-update-indicator") &&
    !surfaceSource.includes("gyro-sidebar-update-indicator") &&
    !styleSource.includes(".gyro-update-popover") &&
    updateControllerSource.includes("import.meta.env.DEV") &&
    updateControllerSource.includes("allowDowngrades: false") &&
    updateControllerSource.includes(
      "localStorage.setItem(LAST_UPDATE_CHECK_STORAGE_KEY, checkedAt)",
    ) &&
    !updateControllerSource.includes("X-Gyro-Channel") &&
    updateControllerSource.includes("await update.download") &&
    updateControllerSource.includes("await update.install()") &&
    updateControllerSource.includes('invoke("restart_app")') &&
    !appSource.includes("updateRestartBlockers") &&
    !updateControllerSource.includes("restartBlockers") &&
    !updateControllerSource.includes('status: "restart-blocked"') &&
    !surfaceSource.includes("Finish active work first") &&
    tauriSource.includes("fn restart_app") &&
    tauriConfigSource.includes(
      "https://github.com/wytzeh197/Gyro/releases/latest/download/latest.json",
    ) &&
    !tauriConfigSource.includes("GYRO_DEV_UPDATER_PUBKEY") &&
    releaseWorkflowSource.includes("needs: macos") &&
    releaseWorkflowSource.includes("merge-multiple: true") &&
    releaseWorkflowSource.includes("scripts/create-updater-manifest.mjs") &&
    releaseWorkflowSource.includes('gh release create "$GITHUB_REF_NAME"') &&
    !releaseWorkflowSource.includes("tauri-apps/tauri-action") &&
    !tauriConfigSource.includes("updates.gyro.dev") &&
    surfaceSource.includes('title="Updates"') &&
    surfaceSource.includes("Public Alpha") &&
    surfaceSource.includes('"Check for updates"') &&
    surfaceSource.includes("formatUpdateCheckedAt") &&
    !surfaceSource.includes('label="Release channel"') &&
    !surfaceSource.includes('value="Valid"') &&
    !surfaceSource.includes('value="Today"'),
  "Updater-signed public Alpha releases should use one direct contextual action above Settings with progress and development safety.",
);
expect(
  updateControllerSource.includes(
    "const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1_000",
  ) &&
    updateControllerSource.includes(
      "const UPDATE_CHECK_POLL_INTERVAL_MS = 60 * 1_000",
    ) &&
    updateControllerSource.includes("stateRef.current.status") &&
    updateControllerSource.includes("updateRef.current !== null") &&
    updateControllerSource.includes(
      '["available", "downloading", "ready", "installing"].includes',
    ) &&
    updateControllerSource.includes("retryTimerRef.current = undefined") &&
    updateControllerSource.includes("Number.isFinite(lastCheckedAt)") &&
    updateControllerSource.includes("window.setInterval(") &&
    updateControllerSource.includes("checkIfDue") &&
    updateControllerSource.includes("window.clearInterval(periodicTimer)"),
  "Automatic update checks should run every 30 minutes while Gyro remains open.",
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
    appSource.includes("isUserSelectedWorkspacePath(chatWorkspacePath)") &&
    appSource.includes(
      '"Select the folder Gyro should use before starting this chat."',
    ) &&
    appSource.includes("void openWorkspace();") &&
    appSource.includes('void selectChatAttachment("workspace-file");') &&
    appSource.includes('action.startsWith("start-new-chat-mode:")') &&
    appSource.includes('type: "set-workbench-mode"') &&
    appSource.includes('type: "close-tool-panel"') &&
    surfaceSource.includes("workspaceModeLabel") &&
    surfaceSource.includes("projectLabel") &&
    surfaceSource.includes("composerProjectLabel") &&
    surfaceSource.includes("isGeneratedGyroWorkspace") &&
    surfaceSource.includes("startProjectLabel") &&
    surfaceSource.includes("What should we work on?") &&
    !surfaceSource.includes(': "Gyro";') &&
    surfaceSource.includes("gyroLogoTransparentDark") &&
    surfaceSource.includes("gyroLogoTransparentLight") &&
    surfaceSource.includes("gyro-chat-start-brand-word") &&
    surfaceSource.includes('style={{ width: "min(860px, 100%)" }}') &&
    surfaceSource.includes('"min(820px, 100%)"') &&
    styleSource.includes("grid-template-columns: minmax(0, 1fr)") &&
    styleSource.includes("width: min(860px, 100%)") &&
    !surfaceSource.includes("calc(100vw - 96px)") &&
    styleSource.includes("width: min(820px, 100%)") &&
    surfaceSource.includes("What should we do in ") &&
    surfaceSource.includes("Choose folder") &&
    surfaceSource.includes(
      "const canSubmitChat = canSendChat(hasReadyProvider, workspacePath)",
    ) &&
    surfaceSource.includes(
      "if (canSubmitComposer && draft.trim().length > 0)",
    ) &&
    surfaceSource.includes(
      "!isStopAction && (!canSubmitComposer || draft.trim().length === 0)",
    ) &&
    surfaceSource.includes("Choose a folder before sending") &&
    surfaceSource.includes("Connect a provider before sending") &&
    surfaceSource.includes("branchLabel") &&
    surfaceSource.includes('action: "select-file"') &&
    surfaceSource.includes('action: "select-folder"') &&
    surfaceSource.includes('"set-workspace-mode:worktree"') &&
    surfaceSource.includes("New worktree branch") &&
    surfaceSource.includes("Select folder") &&
    surfaceSource.includes("Change folder") &&
    appSource.includes('action === "new-chat-select-workspace"') &&
    appSource.includes('action === "new-local-chat-select-workspace"') &&
    appSource.includes('action.startsWith("start-new-chat-mode:")') &&
    appSource.includes("startNewChat();"),
  "Composer controls should route to real workspace, provider, permission, branch, and workspace-mode actions.",
);
expect(
  typeSource.includes("export type GitBranchCatalog") &&
    surfaceSource.includes("function branchPopoverItems") &&
    surfaceSource.includes("select-branch:${encodeURIComponent(branch)}") &&
    surfaceSource.includes("This isolated chat keeps its worktree branch") &&
    appSource.includes('action.startsWith("select-branch:")') &&
    appSource.includes('invoke<GitBranchCatalog>("git_checkout_branch"') &&
    appSource.includes('invoke<Session>("set_session_branch"') &&
    !/case "select-branch":\s*setComposerWorkspaceMode/.test(appSource) &&
    tauriSource.includes("git_branch_catalog_impl") &&
    tauriSource.includes("git_checkout_branch_impl") &&
    tauriSource.includes(
      "commit or stash workspace changes before switching branches",
    ) &&
    coreSessionsSource.includes("update_session_branch"),
  "Branch controls should list real local branches, guard dirty checkouts, preserve worktree branches, and persist the active session branch.",
);
expect(
  appSource.includes("CHAT_DRAFTS_STORAGE_KEY") &&
    appSource.includes('"prepare_chat_attachment"') &&
    appSource.includes('"append_chat_context_event"') &&
    appSource.includes('"stop_provider_chat"') &&
    appSource.includes("deriveSessionGoal") &&
    appSource.includes("deriveChatMode") &&
    surfaceSource.includes('action: "select-image"') &&
    surfaceSource.includes('action: "select-video"') &&
    surfaceSource.includes('command: "/video"') &&
    surfaceSource.includes('action: "add-goal"') &&
    appSource.includes('case "add-plan"') &&
    surfaceSource.includes('"set-chat-mode-plan"') &&
    surfaceSource.includes("gyro-composer-attachments") &&
    surfaceSource.includes("gyro-session-goal") &&
    tauriSource.includes("MAX_CHAT_IMAGE_BYTES") &&
    tauriSource.includes("MAX_CHAT_VIDEO_BYTES") &&
    tauriSource.includes('attachment.kind == "video"') &&
    tauriSource.includes('args.push("--image".into())') &&
    tauriSource.includes('args.push("plan".into())') &&
    tauriSource.includes("ProviderCancellationManager") &&
    coreSessionsSource.includes("GoalUpdated") &&
    coreSessionsSource.includes("ChatModeChanged"),
  "Chat should persist goals, plans, modes, drafts, attachments, and real provider cancellation.",
);
expect(
  coreSessionsSource.includes(
    "create table if not exists mutation_proposals",
  ) &&
    coreSessionsSource.includes("list_pending_mutation_proposals") &&
    coreMutationsSource.includes("decide_mutation_proposal") &&
    coreMutationsSource.includes("atomic_write_workspace_file") &&
    coreMutationsSource.includes("file changed after approval was requested") &&
    tauriSource.includes("create_file_mutation_proposal") &&
    tauriSource.includes("resolve_file_mutation_proposal") &&
    appSource.includes("handleMutationApprovalAction") &&
    appSource.includes("mutationApprovalStatuses") &&
    appSource.includes("resolvedMutationProposalIds") &&
    surfaceSource.includes("function MutationApprovalCard") &&
    surfaceSource.includes('decision: "approve" | "reject"') &&
    surfaceSource.includes("mutationDecisions") &&
    styleSource.includes(".gyro-mutation-approval"),
  "Chat file changes should use durable typed approvals, guarded atomic writes, and restart-safe decision reconciliation.",
);
expect(
  tauriSource.includes("run_provider_chat_with_retry_using") &&
    tauriSource.includes("provider_failure_recovery") &&
    tauriSource.includes('"recoveryKind"') &&
    surfaceSource.includes("providerStatus.recoveryMessage") &&
    surfaceSource.includes('providerStatus.recoveryKind === "authentication"'),
  "Chat recovery should clear stale resume state and distinguish offline, authentication, and retry guidance.",
);
expect(
  coreSessionsSource.includes("update_session_summary") &&
    coreSessionsSource.includes("summary_updated_at") &&
    tauriSource.includes("derive_session_summary") &&
    typeSource.includes("summaryUpdatedAt?: string") &&
    surfaceSource.includes(
      'aria-label={isGoalComposerActive ? "Set session goal" : "Message Gyro"}',
    ) &&
    surfaceSource.includes('role="log"') &&
    surfaceSource.includes('aria-live="polite"') &&
    surfaceSource.includes("session.summary") &&
    styleSource.includes(
      ".gyro-mutation-approval-actions button:focus-visible",
    ),
  "Chat should persist real-response summaries and expose keyboard and screen-reader timeline semantics.",
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
    appSource.includes('command: "kimi"') &&
    appSource.includes('args: ["login"]') &&
    appSource.includes('command: "cursor-agent"') &&
    appSource.includes('command: "opencode"') &&
    appSource.includes('"check_provider_health"') &&
    appSource.includes("providerHealthRequest(provider, providerId)") &&
    appSource.includes("configSaveQueueRef.current") &&
    appSource.includes("PROVIDER_AUTH_POLL_ATTEMPTS") &&
    appSource.includes("Gyro will connect automatically.") &&
    appSource.includes("isProviderExecutable(provider.id)") &&
    appSource.includes("isProviderRuntimeUsable(provider, health)") &&
    appSource.includes('provider?.authStatus === "connected"') &&
    appSource.includes('layout: "terminal-grid"') &&
    appSource.includes('tab: "terminal"') &&
    coreProviderHealthSource.includes("pub struct ProviderHealthService") &&
    coreProviderHealthSource.includes(
      '"codex",\n            &["login", "status"]',
    ) &&
    coreProviderHealthSource.includes(
      '"claude",\n                &["auth", "status"]',
    ) &&
    coreProviderHealthSource.includes('"xai"') &&
    coreProviderHealthSource.includes('"XAI_API_KEY"') &&
    coreProviderHealthSource.includes(
      "should_skip_codex_login_for_external_env",
    ) &&
    coreProviderHealthSource.includes("crate::security::redact_secrets") &&
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
    !surfaceSource.includes('sectionLabel: index === 0 ? "Effort"') &&
    !surfaceSource.includes('sectionLabel: index === 0 ? "Model"') &&
    !surfaceSource.includes(
      "refresh-provider-models:${modelPickerProvider.id}",
    ) &&
    !surfaceSource.includes("connect-provider:${modelPickerProvider.id}") &&
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
    styleSource.includes('.gyro-provider-picker[data-flyout-side="right"]') &&
    styleSource.includes("left: calc(100% + 4px)") &&
    styleSource.includes('.gyro-provider-picker[data-flyout-side="left"]') &&
    styleSource.includes("top: 0 !important") &&
    styleSource.includes("bottom: auto !important") &&
    styleSource.includes('.gyro-provider-picker[data-flyout-vertical="up"]') &&
    styleSource.includes("bottom: 0 !important") &&
    styleSource.includes(".gyro-composer-menu-item.is-effort") &&
    styleSource.includes(".gyro-composer-menu-item.has-no-icon") &&
    styleSource.includes("max-height: none !important") &&
    styleSource.includes("overflow: visible !important") &&
    surfaceSource.includes("getBoundingClientRect") &&
    surfaceSource.includes("?.scrollHeight ?? 420") &&
    surfaceSource.includes("availableRight < modelFlyoutWidth + 8") &&
    surfaceSource.includes("rect.top + modelFlyoutHeight") &&
    surfaceSource.includes("data-flyout-vertical={modelFlyoutVertical}") &&
    !surfaceSource.includes('title="Model & effort"'),
  "Provider picker should stay anchored and flip its model flyout horizontally or vertically when the viewport requires it.",
);
expect(
  surfaceSource.includes("<ProviderLogo providerId={displayProvider.id} />") &&
    /const modelChipLabel =\s*hasSelectedProvider\s*\?\s*providerModelLabel\s*:\s*"Choose model"/.test(
      surfaceSource,
    ) &&
    surfaceSource.includes("sessionModel?.modelLabel") &&
    surfaceSource.includes("{modelChipLabel}") &&
    surfaceSource.includes('togglePopover("effort")') &&
    surfaceSource.includes('className="gyro-effort-picker"') &&
    surfaceSource.includes("reasoningEffortLabel(providerReasoningEffort)") &&
    surfaceSource.includes('title="Provider"') &&
    !surfaceSource.includes("`${providerLabel} · ${providerModelLabel}`") &&
    styleSource.includes(".gyro-model-chip .gyro-provider-logo") &&
    !styleSource.includes(
      ".gyro-composer-menu-item:has(.gyro-provider-logo.is-anthropic):hover",
    ) &&
    !styleSource.includes(
      ".gyro-model-chip:has(.gyro-provider-logo.is-anthropic):hover",
    ),
  "Composer should expose separate compact model and effort selectors.",
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
    surfaceSource.includes('action: "set-chat-mode-plan"') &&
    surfaceSource.includes("icon: Lightbulb") &&
    !surfaceSource.includes('title="Add"') &&
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
  surfaceSource.includes("const slashCommands: ComposerSlashCommand[]") &&
    [
      "/goal",
      "/plan",
      "/normal",
      "/image",
      "/file",
      "/folder",
      "/search",
      "/model",
      "/permissions",
      "/new",
    ].every((command) => surfaceSource.includes(`command: "${command}"`)) &&
    surfaceSource.includes("const filteredSlashCommands") &&
    surfaceSource.includes("setActiveSlashCommandIndex") &&
    surfaceSource.includes('event.key === "ArrowDown"') &&
    surfaceSource.includes('event.key === "ArrowUp"') &&
    surfaceSource.includes('event.key === "Tab"') &&
    surfaceSource.includes('event.key === "Escape"') &&
    /scrollIntoView\(\{\s*block:\s*"nearest",?\s*\}\)/.test(surfaceSource) &&
    surfaceSource.includes("aria-activedescendant") &&
    surfaceSource.includes("runSlashCommand(command)") &&
    surfaceSource.includes('aria-label="Chat commands"') &&
    appSource.includes('case "new-chat":') &&
    styleSource.includes(".gyro-composer-slash-menu") &&
    /\.gyro-composer-slash-menu\s*\{[\s\S]*?bottom:\s*calc\(100% \+ 8px\);[\s\S]*?position:\s*absolute;/.test(
      styleSource,
    ) &&
    !styleSource.includes('.gyro-composer-slash-menu[data-placement="down"]') &&
    !surfaceSource.includes(
      'className="gyro-composer-slash-menu"\n          data-placement',
    ),
  "Chat composer should expose a filtered, keyboard-accessible slash command menu whose actions are wired.",
);
expect(
  styleSource.includes(".gyro-composer-context-wheel") &&
    /\.gyro-composer-context-wheel\s*\{[\s\S]*?height:\s*18px;[\s\S]*?width:\s*18px;/.test(
      styleSource,
    ) &&
    /\.gyro-composer-context-wheel\s*>\s*span\s*\{[\s\S]*?height:\s*12px;[\s\S]*?width:\s*12px;/.test(
      styleSource,
    ),
  "Composer context wheel should stay compact while remaining legible.",
);
expect(
  !surfaceSource.includes("function PlanDecisionCard") &&
    surfaceSource.includes('className="gyro-plan-artifact-actions"') &&
    surfaceSource.includes('className="gyro-plan-artifact-preview"') &&
    surfaceSource.includes("Yes, implement") &&
    surfaceSource.includes('onPlanDecision?.("approve")') &&
    surfaceSource.includes('activePanel === "plan" && sessionPlan?.content') &&
    surfaceSource.includes(
      "<PlanDocument content={sessionPlan.content} title={sessionPlan.title}",
    ) &&
    surfaceSource.includes('chatMode === "plan"') &&
    surfaceSource.includes("latestPlanModeEnabledAt") &&
    surfaceSource.includes(
      "sessionPlan.updatedAt >= latestPlanModeEnabledAt",
    ) &&
    surfaceSource.includes("!isComposerSending") &&
    appSource.includes("const handlePlanDecision = useCallback") &&
    appSource.includes('await changeChatMode("normal")') &&
    appSource.includes('sendDraft("Implement the approved plan."') &&
    appSource.includes('mode: "normal"') &&
    appSource.includes("plan: activeSessionPlan") &&
    appSource.includes("preserveDraft: true") &&
    styleSource.includes(".gyro-plan-artifact-actions") &&
    styleSource.includes(".gyro-plan-artifact-preview") &&
    styleSource.includes(".gyro-plan-rail.is-document") &&
    styleSource.includes(".gyro-chat-surface.is-thread.has-plan"),
  "Completed Plan-mode output should render a plan artifact with an inline implementation action and an expandable full document.",
);
expect(
  !surfaceSource.includes("const fileActivityIndexes = new Map") &&
    !surfaceSource.includes(
      'if (providerActivityFromEvent(event)?.kind === "file")',
    ) &&
    surfaceSource.includes('if (activity.kind === "file")') &&
    surfaceSource.includes(
      "const hasFileActivity = turn.timelineEvents.some",
    ) &&
    surfaceSource.includes("changeSummary={changeSummary}") &&
    styleSource.includes(".gyro-composer-image-fallback") &&
    styleSource.includes(
      ':root[data-theme="light"]\n  .gyro-chat-thread-topbar\n  .gyro-thread-pill-button',
    ) &&
    styleSource.includes("backdrop-filter: none") &&
    surfaceSource.includes(") : sessionGoal?.text ? (") &&
    appSource.includes("const changeChatMode = useCallback") &&
    appSource.includes(
      'const shouldClearGoal = mode === "plan" && Boolean(activeSessionGoal)',
    ) &&
    appSource.includes(
      'const turnGoal = turnMode === "plan" ? undefined : requestedTurnGoal',
    ) &&
    appSource.includes('const modeChanged = await changeChatMode("normal")') &&
    appSource.includes("if (!modeChanged)"),
  "Live file edits, composer overlays, light context pills, and Goal/Plan exclusivity should remain enforced.",
);
expect(
  styleSource.includes(
    ".gyro-composer-shell > .gyro-composer-bar,\n.gyro-chat-start",
  ) &&
    styleSource.includes("z-index: 120") &&
    styleSource.includes(
      ".gyro-composer-control:has(.gyro-composer-popover, .gyro-provider-picker)",
    ) &&
    styleSource.includes(
      ".gyro-app-shell.is-sidebar-hidden.is-thread-layout\n  .gyro-chat-surface.is-thread\n  > .gyro-chat-thread-topbar",
    ) &&
    styleSource.lastIndexOf("z-index: 120") >
      styleSource.lastIndexOf("/* Ordered chat activity"),
  "Composer menus should stay above the composer and hidden-sidebar chat titles should clear native window controls.",
);
expect(
  styleSource.includes("/* Readable composer popovers in Light mode. */") &&
    styleSource.includes(
      ".gyro-context-picker .gyro-composer-menu-item strong",
    ) &&
    styleSource.includes("color: #252a32") &&
    styleSource.includes("color: #687383") &&
    styleSource.includes("background: #edf2f8"),
  "Light-mode composer popovers should keep labels, icons, details, and hover states comfortably readable.",
);
expect(
  surfaceSource.includes("OpenAI permissions") &&
    surfaceSource.includes("Anthropic permissions") &&
    surfaceSource.includes("Ask Before Executing") &&
    surfaceSource.includes("Auto Approve") &&
    surfaceSource.includes("Full Access") &&
    !surfaceSource.includes('action: "toggle-access"') &&
    !surfaceSource.includes("Codex settings") &&
    !surfaceSource.includes("Claude settings") &&
    surfaceSource.includes("Command policy") &&
    surfaceSource.includes("File edit policy") &&
    surfaceSource.includes("approvalChipClassName") &&
    surfaceSource.includes('approvalMode === "direct"') &&
    surfaceSource.includes('approvalMode === "auto"') &&
    surfaceSource.includes('action: "set-approval-auto"') &&
    surfaceSource.includes('kind: "permission-direct"') &&
    styleSource.includes(".gyro-composer-menu-item.is-permission-direct") &&
    surfaceSource.includes('"gyro-composer-chip is-warning"') &&
    surfaceSource.includes("className={approvalChipClassName}") &&
    appSource.includes("approvalNotificationCopy") &&
    appSource.includes("fullAccess: true") &&
    desktopRustSource.includes("request.full_access = config.full_access") &&
    desktopRustSource.includes('"danger-full-access"') &&
    desktopRustSource.includes('"type": "dangerFullAccess"') &&
    desktopRustSource.includes('"on-request"'),
  "Permission controls should expose ask, sandboxed auto-approval, and orange Full Access as distinct backend modes.",
);
expect(
  !styleSource.includes(".gyro-tool-panel-reveal") &&
    styleSource.includes(".gyro-sidebar-footer") &&
    styleSource.includes(".gyro-sidebar-windowbar") &&
    styleSource.includes(".gyro-sidebar-restore-button") &&
    styleSource.includes(".gyro-app-shell.is-sidebar-hidden") &&
    styleSource.includes(".gyro-sidebar-titlebar-drag-region") &&
    styleSource.includes(".gyro-main-titlebar-drag-region") &&
    styleSource.includes(".gyro-chat-empty-drag-region") &&
    styleSource.includes(".gyro-sidebar-mode-group") &&
    styleSource.includes(
      ".gyro-sidebar-persistent-header > .gyro-sidebar-mode-group",
    ) &&
    styleSource.includes(
      ".gyro-sidebar-persistent-header > .gyro-sidebar-windowbar",
    ) &&
    cssRules(styleSource, ".gyro-sidebar-persistent-header").some((rule) =>
      rule.includes("background: transparent"),
    ) &&
    styleSource.includes(
      ".gyro-ide-sidebar-resizer:focus-visible:not(:hover)::after",
    ) &&
    !styleSource.includes(
      ".gyro-ide-sidebar-resizer:hover::after,\n.gyro-ide-sidebar-resizer:focus-visible::after",
    ) &&
    surfaceSource.includes(
      'className="gyro-sidebar-persistent-header is-settings"',
    ) &&
    cssRules(styleSource, ".gyro-sidebar-windowbar.is-settings").some((rule) =>
      rule.includes("padding-left: 112px"),
    ) &&
    styleSource.includes(
      ".gyro-app-shell:has(.gyro-chat-surface.is-empty) .gyro-sidebar-windowbar",
    ) &&
    styleSource.includes(
      ".gyro-app-shell:has(.gyro-chat-surface.is-thread) .gyro-sidebar-windowbar",
    ) &&
    styleSource.includes("border-bottom-color: transparent") &&
    appSource.includes("document.documentElement.dataset.windowActive") &&
    appSource.includes('window.addEventListener("blur", syncWindowFocus)') &&
    appSource.includes('window.addEventListener("focus", syncWindowFocus)') &&
    styleSource.includes(
      ':root[data-theme="light"][data-window-active="false"]',
    ) &&
    styleSource.includes("rgba(82, 92, 104, 0.2)") &&
    cssRules(
      styleSource,
      ':root[data-theme="light"][data-window-active="false"]\n  .gyro-sidebar-persistent-header::after',
    ).some(
      (rule) => rule.includes("left: 8px") && rule.includes("top: 18px"),
    ) &&
    surfaceSource.includes('className="gyro-composer-branch-picker"') &&
    cssRules(styleSource, ".gyro-composer-branch-picker").some(
      (rule) =>
        rule.includes("grid-auto-rows: 40px") &&
        rule.includes("max-height: 172px") &&
        rule.includes("overflow-y: auto"),
    ) &&
    styleSource.includes("margin-right: -3px") &&
    styleSource.includes("padding: 0 9px 0") &&
    styleSource.includes("height: 58px") &&
    cssRules(styleSource, ".gyro-sidebar-windowbar").some(
      (rule) =>
        rule.includes("height: 48px") &&
        rule.includes("min-height: 48px") &&
        rule.includes("padding: 0 5px 0 84px"),
    ) &&
    cssRules(styleSource, ".gyro-sidebar-restore-button").some((rule) =>
      rule.includes("top: 14px"),
    ) &&
    cssRules(styleSource, ".gyro-sidebar-restore-button").every(
      (rule) => !rule.includes("top: 16px"),
    ) &&
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
    appSource.includes("const suppressSessionAutoSelectRef = useRef(true)") &&
    appSource.includes("suppressSessionAutoSelectRef.current = true") &&
    appSource.includes("setActiveSessionId(undefined)") &&
    appSource.includes(
      'dispatchWorkbench({ type: "set-workbench-mode", mode: "local" });',
    ) &&
    appSource.includes("onCreateSession={startNewChat}") &&
    surfaceSource.includes("const transcriptState = useMemo") &&
    surfaceSource.includes(
      "if (turns.length === 0 && looseEvents.length === 0)",
    ) &&
    surfaceSource.includes('aria-label="New Chat"'),
  "Cold launch and New chat should keep recent sessions unselected, reset to local mode, and render the start screen from transcript events.",
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
    appSource.includes('lazy(() => import("./monaco-editor"))') &&
    monacoEditorSource.includes("loader.config({ monaco })") &&
    monacoEditorSource.includes("MonacoEnvironment") &&
    monacoEditorSource.includes("export function disposeMonacoModel") &&
    monacoEditorSource.includes("new EditorWorker()") &&
    monacoEditorSource.includes("new TypeScriptWorker()") &&
    appSource.includes("keepCurrentModel") &&
    appSource.includes("function disposeEditorModels") &&
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
    appSource.includes("const affectedEditorPaths") &&
    appSource.includes("const openSourceControlDiff = useCallback") &&
    appSource.includes("const startIdeDebugSession = useCallback") &&
    appSource.includes("const sendIdeDebugCommand = useCallback") &&
    appSource.includes("const stopIdeDebugSession = useCallback") &&
    appSource.includes("const closesLastReference") &&
    appSource.includes("Discard unsaved changes in") &&
    appSource.includes('method: "textDocument/didOpen"') &&
    appSource.includes('method: "textDocument/didChange"') &&
    reducerSource.includes('case "ide-select-group"') &&
    reducerSource.includes('case "ide-rename-path"') &&
    reducerSource.includes('case "ide-delete-path"') &&
    reducerSource.includes("const pathStillOpen") &&
    reducerSource.includes('case "ide-set-language-server"') &&
    surfaceSource.includes("onCloseEditorTab?.(path, group.id)") &&
    surfaceSource.includes('"application/x-gyro-editor-group"') &&
    surfaceSource.includes("onMoveEditorTab?.(path, group.id, fromGroupId)") &&
    appSource.includes("onMoveEditorTab={(path, toGroupId, fromGroupId)") &&
    tauriSource.includes("impl LanguageServerManager") &&
    tauriSource.includes("spawn_lsp_message_reader") &&
    styleSource.includes(".gyro-editor-groups.is-split-right") &&
    styleSource.includes(".gyro-ide-assistant-composer") &&
    surfaceSource.includes('role="tree"') &&
    surfaceSource.includes('role="treeitem"') &&
    surfaceSource.includes('event.key === "ArrowRight"') &&
    surfaceSource.includes('event.key === "ArrowLeft"') &&
    surfaceSource.includes('event.key === "Enter"') &&
    surfaceSource.includes('event.key === " "') &&
    surfaceSource.includes("explorerRowRefs") &&
    styleSource.includes(".gyro-sidebar-explorer-tree"),
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
  "gyro-chat-surface.is-empty",
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
  surfaceSource.includes(
    'data-active-mode={isIdeSidebar ? "workspace" : "sessions"}',
  ) &&
    styleSource.includes(
      '.gyro-sidebar-mode-group[data-active-mode="workspace"]::before',
    ) &&
    styleSource.includes(".gyro-sidebar-mode-row > span") &&
    styleSource.includes("font-weight: 450") &&
    styleSource.includes("font-weight: 500") &&
    styleSource.includes("line-height: 16px") &&
    styleSource.includes("transition: transform var(--gyro-premium-motion)") &&
    styleSource.includes("@keyframes gyro-native-surface-enter"),
  "Sessions and Workspace switching should use centered reference typography, the shared sliding indicator, and restrained surface motion.",
);

expect(
  (styleSource.match(/^:root\s*\{/gm) ?? []).length === 1 &&
    styleSource.includes(
      "--gyro-premium-hairline: rgba(255, 255, 255, 0.09)",
    ) &&
    styleSource.includes("--gyro-premium-radius-md: 7px") &&
    styleSource.includes("--gyro-premium-motion: 130ms") &&
    styleSource.includes("--gyro-app: #101010") &&
    styleSource.includes("--gyro-pane: #121212") &&
    styleSource.includes("--gyro-hero-composer: #1a1a1a") &&
    styleSource.includes("--gyro-accent: #7aa7ff") &&
    styleSource.includes(':root[data-theme="light"]') &&
    styleSource.includes("--gyro-premium-hairline: rgba(23, 27, 34, 0.13)") &&
    styleSource.includes("--gyro-accent: #356fd6") &&
    styleSource.includes(
      "Balanced light and dark theme contrast for primary interactive surfaces.",
    ) &&
    styleSource.includes("var(--gyro-hero-shadow), var(--gyro-hero-highlight)"),
  "The premium graphite system should keep one token authority with thin hairlines, fast motion, and dark/light accent parity.",
);

expect(
  surfaceSource.includes("export function IdeStatusBar") &&
    surfaceSource.includes('aria-label="Workspace status"') &&
    appSource.includes("<IdeStatusBar") &&
    styleSource.includes(
      ".gyro-workspace-route.is-code > .gyro-editor-statusbar",
    ) &&
    styleSource.includes("var(--gyro-ide-status-height)") &&
    styleSource.includes(".gyro-editor-statusbar-group.is-secondary") &&
    styleSource.includes("grid-template-rows: minmax(0, 1fr);") &&
    styleSource.includes(".gyro-code-surface .monaco-editor-background"),
  "Workspace should keep the global status bar below the editor and tool panel with compact left and right metadata groups.",
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
    appSource.includes('background: "#0b0b0b"') &&
    appSource.includes('brightMagenta: "#f08cff"') &&
    appSource.includes('brightYellow: "#ffd166"'),
  "Live terminals should update their xterm palette in place for dark and light themes.",
);

expect(
  monacoEditorSource.includes('monaco.editor.defineTheme("gyro-dark"') &&
    monacoEditorSource.includes('"editor.background": "#1E1F22"') &&
    monacoEditorSource.includes(
      '"editor.lineHighlightBackground": "#25262A"',
    ) &&
    appSource.includes("stickyScroll: { enabled: true, maxLineCount: 3 }") &&
    appSource.includes('theme={theme === "light" ? "vs" : "gyro-dark"}'),
  "The IDE editor should use a readable neutral graphite palette with built-in navigation aids.",
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
    styleSource.includes("color: var(--gyro-warn)") &&
    styleSource.includes("background: transparent") &&
    styleSource.includes("border-color: transparent") &&
    styleSource.includes("color: #ff8a3d"),
  "Full Access should keep orange text and icons on a transparent menu and composer control.",
);

const requiredViewports = [
  "860x620 compact",
  "1280x720",
  "1440x900",
  "1728x1117",
];

for (const token of [
  "--gyro-space-compact",
  "--gyro-space-standard",
  "--gyro-space-comfortable",
  "--gyro-space-section",
  "--gyro-status-running",
  "--gyro-status-waiting",
  "--gyro-status-success",
  "--gyro-status-failed",
  "--gyro-status-cancelled",
]) {
  expect(
    styleSource.includes(token),
    `Shared v0.2 design token missing: ${token}`,
  );
}

expect(
  tauriSource.includes("next_provider_event_sequence") &&
    typeSource.includes("sequence: number") &&
    appSource.includes("providerStreamOrderRef") &&
    coreSessionsSource.includes("read_recent_event_lines") &&
    coreSessionsSource.includes("file.sync_data()"),
  "Reliability contract should cover ordered IPC, durable writes, and tail-based recovery.",
);

expect(
  surfaceSource.includes("gyro-usage-provider-select") &&
    surfaceSource.includes('aria-label="Refresh provider usage"') &&
    surfaceSource.includes('label="Usage visualization"') &&
    surfaceSource.includes("aria-label={`${remaining}% remaining`}") &&
    surfaceSource.includes("<small>remaining</small>") &&
    surfaceSource.includes('"--usage": `${remaining * 3.6}deg`') &&
    surfaceSource.includes("Usage unavailable from this provider") &&
    surfaceSource.includes(
      "Gyro does not estimate allowance from local activity",
    ) &&
    surfaceSource.includes('aria-label="Provider usage limits"') &&
    surfaceSource.includes('className="gyro-composer-limit-summary"') &&
    surfaceSource.includes("providerUsage.windows.map((window)") &&
    styleSource.includes(".gyro-composer-limit-summary"),
  "Usage settings should select a provider, switch bars or wheels, and represent unsupported provider quotas honestly.",
);

expect(
  appSource.includes(
    'invoke<ProviderUsageSnapshot>(\n          "get_provider_usage"',
  ) &&
    appSource.includes("refreshProviderUsage(selectedUsageProviderId)") &&
    appSource.includes("PROVIDER_USAGE_REFRESH_INTERVAL_MS") &&
    appSource.includes("refreshInBackground") &&
    appSource.includes('window.addEventListener("focus"') &&
    appSource.includes('document.addEventListener("visibilitychange"') &&
    appSource.includes("providerUsageInFlightRef") &&
    appSource.includes('status: hasCachedWindows ? "available" : "error"') &&
    appSource.includes("providerUsageByProvider={providerUsageByProvider}") &&
    tauriSource.includes('"account/rateLimits/read"') &&
    tauriSource.includes("CODEX_USAGE_TIMEOUT") &&
    tauriSource.includes("provider_usage_windows_from_codex") &&
    tauriSource.includes("get_provider_usage,"),
  "Usage limits should refresh in the background, retain cached data, and surface in Settings and the composer.",
);

expect(
  surfaceSource.includes('role="switch"') &&
    surfaceSource.includes("Require command approval") &&
    surfaceSource.includes("Automatic update checks") &&
    surfaceSource.includes("gyro-settings-confirm-overlay"),
  "Settings should use semantic switches for persisted booleans and confirm destructive resets.",
);

for (const settingsSelector of [
  ".gyro-settings-group",
  ".gyro-settings-control-column",
  ".gyro-provider-table",
  ".gyro-usage-cards",
  ".gyro-update-summary",
]) {
  expect(
    styleSource.includes(settingsSelector),
    `The line-based settings workspace should include ${settingsSelector}.`,
  );
}

expect(
  tauriSource.includes('"item/commandExecution/requestApproval"') &&
    tauriSource.includes('"item/fileChange/requestApproval"') &&
    tauriSource.includes('"gyro://provider-approval-event"') &&
    tauriSource.includes('"read-only"') &&
    tauriSource.includes("AppliedByGyro") &&
    tauriSource.includes("wait_for_provider_approval") &&
    appSource.includes('"resolve_provider_approval"'),
  "Default Permissions should route gated Codex actions through live Gyro approval decisions and keep file edits read-only until approved.",
);

expect(
  tauriSource.includes('summary("Gyro has a question")') &&
    tauriSource.includes('"gyro://provider-approval-notification-open"') &&
    tauriSource.includes("notify_provider_approval_question") &&
    tauriSource.includes('"developerInstructions": approval_instructions') &&
    tauriSource.includes("!request.require_command_approval") &&
    tauriSource.includes("!request.require_file_edit_approval") &&
    appSource.includes('"gyro://provider-approval-notification-open"') &&
    appSource.includes("selectSession(event.payload.sessionId)"),
  "Approval questions should override full access, notify on macOS, and reopen the exact chat when clicked.",
);

expect(
  tauriSource.includes("run_provider_permission_server") &&
    tauriSource.includes("desktop_claude_permission_mcp_config") &&
    tauriSource.includes('"--strict-mcp-config"') &&
    tauriSource.includes("handle_desktop_provider_approval_request") &&
    tauriSource.includes("wait_for_provider_approval_with_transaction") &&
    coreIpcSource.includes("DesktopProviderApprovalRequest") &&
    coreIpcSource.includes("request_desktop_provider_approval") &&
    coreMutationsSource.includes(
      "prepare_claude_provider_mutation_transaction",
    ),
  "Default Permissions should route desktop Claude callbacks through versioned local IPC and the shared journaled transaction.",
);

expect(
  surfaceSource.includes("ProviderToolApprovalCard") &&
    surfaceSource.includes(
      'approvalType: "command" | "file-change" | "permissions"',
    ) &&
    surfaceSource.includes("providerApprovalDecisions") &&
    surfaceSource.includes('status === "applied"') &&
    surfaceSource.includes(
      "approval.error ?? approval.reason ?? approval.risk",
    ) &&
    styleSource.includes(".gyro-provider-tool-approval") &&
    styleSource.includes(".gyro-provider-tool-approval.is-applied") &&
    styleSource.includes(
      ".gyro-provider-tool-approval-actions button:focus-visible",
    ),
  "Provider command, file, and permission requests should render as reconciled accessible transcript cards.",
);

expect(
  surfaceSource.includes("estimateComposerContextUsage") &&
    surfaceSource.includes("contextUsage.remainingLabel") &&
    readRepoFile("packages/ui/src/context-usage.ts").includes(
      "eventModelId !== model.modelId",
    ) &&
    readRepoFile("packages/ui/src/context-usage.ts").includes(
      "reportedTokens + liveEstimatedTokens",
    ) &&
    surfaceSource.includes("gyro-composer-context-bar") &&
    styleSource.includes(
      ':root[data-theme="light"] .gyro-composer-context-tooltip',
    ) &&
    styleSource.includes(
      ':root[data-theme="light"] .gyro-composer-context-bar',
    ) &&
    cssRules(styleSource, ".gyro-composer-context-bar").some(
      (rule) =>
        rule.includes("height: 5px") &&
        rule.includes("var(--gyro-premium-hairline-soft)"),
    ) &&
    styleSource.includes("var(--gyro-accent-strong)") &&
    styleSource.includes("min-width: 316px") &&
    styleSource.includes("border-radius: 2px") &&
    desktopRustSource.includes('"thread/tokenUsage/updated"') &&
    desktopRustSource.includes('"thread/compacted"') &&
    desktopRustSource.includes('Some("contextCompaction")') &&
    desktopRustSource.includes("codex_context_compaction_activity") &&
    desktopRustSource.includes('kind: "context".into()') &&
    desktopRustSource.includes("provider_context_usage_from_codex_exec") &&
    desktopRustSource.includes('"contextUsage".into()'),
  "Composer context usage should prefer provider telemetry and render a readable detail card.",
);

expect(
  styleSource.includes("Codex-matched chat typography") &&
    styleSource.includes("font-size: 14px;\n  line-height: 1.5;") &&
    styleSource.includes(".gyro-user-message-bubble p") &&
    styleSource.includes(".gyro-chat-run-commentary") &&
    styleSource.includes("font-size: 13px;\n  line-height: 18px;") &&
    styleSource.includes(".gyro-change-summary-file > button") &&
    surfaceSource.includes("function ChangeSummaryFile") &&
    surfaceSource.includes("aria-label={`Changes in ${path}`}") &&
    surfaceSource.includes("changeSummary.fileChanges.map((file)") &&
    !styleSource.includes(".gyro-change-summary-more") &&
    styleSource.includes(".gyro-change-summary-diff-scroll") &&
    styleSource.includes("max-height: min(420px, 48vh)"),
  "Chat typography should use the Codex 14px body, 13px supporting, and 12px metadata scale.",
);

console.log(`Workbench smoke viewports: ${requiredViewports.join(", ")}`);

if (failures.length > 0) {
  console.error("Gyro workbench smoke checks failed.\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Gyro workbench smoke checks passed.");
