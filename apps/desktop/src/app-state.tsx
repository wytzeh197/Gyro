import {
  absoluteWorkspaceFilePath,
  applyLaunchView,
  createInitialChatGridState,
  createInitialWorkbenchState,
  createTerminalPane,
  defaultCommandProfiles,
  getProviderModel,
  isProviderId,
  isTransientWorkspacePath,
  isUserSelectedWorkspacePath,
  normalizedConfig,
  normalizedCouncilConfig,
  resolveLanguage,
  sanitizeStoredChatGridState,
  sanitizeStoredIdeState,
  selectedReasoningEffort,
  workspaceRelativeFilePath,
  type AppDestination,
  type Automation,
  type BrowserPreviewDiagnostic,
  type CapabilityActivity,
  type CapabilityApprovalEvent,
  type CapabilityCallEvent,
  type CapabilityResourceRef,
  type ChatAttachment,
  type ChatGridState,
  type ChatMode,
  type ChatPaneRef,
  type CommandProfile,
  type CouncilRun,
  type EditorBuffer,
  type GyroConfig,
  type HarnessRunStatus,
  type IdeAiToolCall,
  type ModelProviderConfig,
  type OutputChannel,
  type ProblemDiagnostic,
  type ProviderChatStreamEvent,
  type ProviderId,
  type ProviderResumeCursor,
  type Session,
  type SessionEvent,
  type SessionGoal,
  type SessionPlan,
  type SessionsLayoutId,
  type SourceControlState,
  type Task,
  type TaskDefinition,
  type TerminalPane,
  type TerminalPaneStatus,
  type TerminalTemplate,
  type TestTreeItem,
  type WorkbenchPaneTab,
  type WorkbenchState,
  type WorkbenchTurn,
  type WorkspaceContextSnapshot,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type WorkspaceLayoutId,
} from "@gyro-dev/ui";
import "@xterm/xterm/css/xterm.css";
import { lazy } from "react";
import { recoverWorkspaceBuffers } from "./editor/edit-recovery";
import {
  MODEL_DEFAULT_SUGGESTION_MAX_STORAGE_CHARS,
  MODEL_DEFAULT_SUGGESTION_STORAGE_KEY,
  parseModelDefaultSuggestionState,
} from "./model-default-suggestion";
import { applyNativeProviderRetryStatus } from "./provider-retry-stream";
import {
  isProviderStatusEvent,
  limitOptimisticSessionEvents,
  limitSessionEventsForUi,
  upsertStreamingAssistantEvent,
} from "./provider-stream-events";
import {
  recordFromUnknown,
  stringFromRecord,
  turnIdFromSessionEvent,
} from "./session-context-events";
import {
  normalizeSessionTitleInput,
  workspaceRunMetadata,
} from "./session-creation";
import { normalizeProjectPath } from "./session-listing";
import {
  readBoundedLocalStorage,
  readStoredAppearance,
  safeSetLocalStorage,
  saveAppearancePreferences,
} from "./ui-storage";
import { type SessionModelSelection } from "./use-session-model-save";
import { storedThemeMode, THEME_STORAGE_KEY } from "./use-workbench-appearance";

export type AppNotification = {
  kind: "open-session" | "attach-session";
  sessionId: string;
  workspacePath: string;
  workspaceMode?: WorkbenchState["workspaceMode"];
  branch?: string;
  worktreeName?: string;
};

export type ProviderApprovalNotificationOpen = {
  sessionId: string;
  approvalId: string;
};

export type MenuBarNavigationTarget = {
  kind: "chat" | "automation" | "settings";
  id: string;
};

export type ProviderCapabilityResourceEvent = {
  sessionId: string;
  turnId?: string;
  callId: string;
  resource: CapabilityResourceRef;
  data: unknown;
};

export type TerminalPaneSnapshot = {
  paneId: string;
  title: string;
  profileId?: string | null;
  command: string;
  output?: string | null;
  outputRevision: number;
  status: "running" | "done" | "failed";
  hasForegroundJob?: boolean | null;
  exitCode?: number | null;
  workspacePath?: string;
  workingDirectory?: string;
  cols: number;
  rows: number;
  governedSessionId?: string | null;
  governedProviderId?: string | null;
};

export type LspBridgeResponse = {
  status: string;
  result?: unknown;
  error?: unknown;
  messages?: unknown[];
};

export type ProviderChatResponse = {
  activityEvents?: SessionEvent[];
  assistantEvent: SessionEvent;
  resumeCursor?: ProviderResumeCursor | null;
  session?: Session | null;
  sessionTitle?: string | null;
  statusEvent: SessionEvent;
};

export type ProviderContextCompactionResponse = {
  activityEvents?: SessionEvent[];
};

export type CouncilChatInvokeResponse = {
  councilRun: CouncilRun;
  assistantEvent: SessionEvent;
  statusEvent: SessionEvent;
  session?: Session | null;
};

export type DiagnosticsExportResult = {
  path: string;
};

export type ProviderStreamBatch = {
  streamEvent: ProviderChatStreamEvent;
  textDelta: string;
};

export type SourceControlLineStats = {
  additions: number;
  deletions: number;
};

export type TurnSourceControlBaselines = Record<
  string,
  Record<string, SourceControlLineStats>
>;

export type ChatTurnContextSnapshot = {
  /** Scheduler delivery may wait, but must never enqueue another copy. */
  queuedDelivery?: boolean;
  mode?: ChatMode;
  /** Captured when a send must focus another chat pane first. */
  draftModeKey?: string;
  draftModeRevision?: number;
  consumeDraftMode?: boolean;
  goal?: SessionGoal;
  plan?: SessionPlan;
  attachments?: ChatAttachment[];
  sessionModel?: SessionModelSelection;
  requireCommandApproval?: boolean;
  requireFileEditApproval?: boolean;
  /**
   * Internal delivery target for queued turns. A queued message must keep
   * running in its original chat after the user switches to another one.
   */
  sessionId?: string;
  fullAccess?: boolean;
  workspacePath?: string;
  workspaceContext?: WorkspaceContextSnapshot;
  preserveDraft?: boolean;
  turnId?: string;
  retryTurnId?: string;
  /** Cancel a retry that is still preparing when Stop or a new send wins. */
  retryDispatchGuard?: () => boolean;
};

export type QueuedChatMessage = {
  deliveryAttempts?: number;
  id: string;
  message: string;
  context: ChatTurnContextSnapshot;
  retryAt?: number;
  status: "failed" | "waiting" | "sending";
};

export type WorkspaceFileWriteRequest = {
  workspacePath: string;
  path: string;
  content: string;
  expectedHash?: string;
};

export type IdeCommandOutput = {
  /** Mirrors the Rust bounded-command terminations, not just done/failed. */
  status:
    "done" | "failed" | "cancelled" | "timed-out" | "inactive" | "output-limit";
  stdout: string;
  stderr: string;
};

/** Result of git_push / git_pull / git_fetch: output plus refreshed status. */
export type GitSyncResult = {
  output: IdeCommandOutput;
  status: SourceControlState;
};

export type AutomationDraft = Pick<
  Automation,
  | "branch"
  | "nextRunAt"
  | "project"
  | "prompt"
  | "provider"
  | "schedule"
  | "stopCondition"
  | "title"
  | "workspaceMode"
  | "worktreeName"
  | "execution"
>;

export type ModelStandardPrompt = {
  usageCount: number;
  chatCount: number;
  modelId: string;
  modelLabel: string;
  providerId: ProviderId;
  providerLabel: string;
};

export type SavedProject = {
  path: string;
  label: string;
  detail: string;
  sessionCount: number;
};

export const EMPTY_CONFIG: GyroConfig = {
  automaticUpdateChecks: true,
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
  fullAccess: false,
  changeSummariesEnabled: false,
  accountOidc: {
    issuerUrl: "local-device://gyro",
    clientId: "gyro-local-device",
    redirectLoopbackBase: "http://127.0.0.1",
    scopes: ["openid", "profile", "email", "offline_access"],
  },
  accountSession: { signedIn: false },
  modelProviders: [],
  commandProfiles: [],
};

export const PREVIEW_WORKSPACE_PATH = "/preview/Gyro";

export const WORKBENCH_STORAGE_KEY = "gyro.workbench-state";

export const CHAT_TASK_METADATA_KEY = "gyro.chat-task-metadata.v1";

export const PINNED_SESSIONS_STORAGE_KEY = "gyro.pinned-session-ids";

export const REMOVED_PROJECTS_STORAGE_KEY = "gyro.removed-project-paths";

export const RECENT_PROJECTS_STORAGE_KEY = "gyro.recent-project-paths";

export const PREVIEW_CONFIG_STORAGE_KEY = "gyro.preview-config";

/** Lines shown either side of the revealed line in a model focus peek. */
export const MODEL_FOCUS_PEEK_CONTEXT_LINES = 12;

export const CHAT_DRAFTS_STORAGE_KEY = "gyro.chat-drafts-v1";

export const CHAT_DRAFT_MODES_STORAGE_KEY = "gyro.chat-draft-modes-v1";

export const CHAT_ATTACHMENTS_STORAGE_KEY = "gyro.chat-attachments-v1";

export const CHAT_GRID_STORAGE_KEY = "gyro.chat-grid-layouts-v1";

/** Record the first automatic request before macOS opens a permission sheet. */
export const SYSTEM_ACCESS_PROMPTED_STORAGE_KEY =
  "gyro.system-access-prompted-v1";

export const DEFAULT_TOOL_PANEL_HEIGHT = 280;

export const BROWSER_TOOL_PANEL_HEIGHT = 420;

/** ~65% of viewport — Browser focus mode; never shrink a taller panel. */
export const BROWSER_FOCUS_PANEL_HEIGHT_RATIO = 0.65;

export const PROVIDER_AUTH_POLL_INTERVAL_MS = 3_000;

export const PROVIDER_AUTH_POLL_ATTEMPTS = 40;

// A sign-in Gyro asked for waits longer than a background readiness poll: it
// runs a browser login someone has to complete by hand, and giving up early
// means dropping the message that was waiting on it.
export const PROVIDER_SIGN_IN_POLL_ATTEMPTS = 100;

// The model popover shows the sign-in link as soon as the CLI prints it, so an
// inline sign-in reads its terminal quickly for the first few seconds.
export const PROVIDER_SIGN_IN_FAST_POLL_MS = 500;

export const PROVIDER_SIGN_IN_FAST_POLL_ATTEMPTS = 12;

// npm installs of a provider CLI finish in well under five minutes.
export const PROVIDER_INSTALL_POLL_ATTEMPTS = 600;

export const MAX_CHAT_MESSAGE_CHARS = 24_000;

export const MAX_CHAT_IMAGES_PER_MESSAGE = 10;

export const MAX_CHAT_VIDEOS_PER_MESSAGE = 2;

// Mirrors the native limits so oversized files are rejected before they are
// read into memory.
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;

export const MAX_CHAT_VIDEO_BYTES = 200 * 1024 * 1024;

export const MAX_QUEUED_CHAT_MESSAGES_PER_SESSION = 8;

export const MAX_QUEUED_CHAT_MESSAGES_TOTAL = 24;

// The draft key for a chat with no session yet. Shared with the UI package so
// a drop and the composer holding it always name the same draft.
export const PROVIDER_STREAM_FLUSH_MS = 80;

export const WORKBENCH_PERSIST_DEBOUNCE_MS = 500;

export const WORKBENCH_PERSIST_IDLE_TIMEOUT_MS = 1_500;

export const TERMINAL_POLL_INTERVAL_MS = 1_000;

export type BrowserPreviewCheck = {
  reachable: boolean;
  statusCode?: number;
  message: string;
  diagnostics: BrowserPreviewDiagnostic[];
  diagnosticsSupported: boolean;
  diagnosticsCaptured: boolean;
};

export type OllamaDiscovery = {
  baseUrl: string;
  models: Array<{
    id: string;
    displayName: string;
    description: string;
    contextWindowTokens?: number;
    supportsTools: boolean;
  }>;
};

export const TERMINAL_CHAT_BUSY_POLL_INTERVAL_MS = 4_000;

export const MAX_PERSISTED_TERMINAL_OUTPUT_CHARS = 8_000;

export const MAX_PERSISTED_OUTPUT_CHANNEL_LINES = 100;

export const MAX_PERSISTED_DIRTY_BUFFER_CHARS = 500_000;

export const MAX_PERSISTED_DIRTY_BUFFERS_TOTAL_CHARS = 1_000_000;

export const MAX_STORED_WORKBENCH_STATE_CHARS = 2_000_000;

export const MAX_STORED_PREVIEW_CONFIG_CHARS = 200_000;

export const MAX_PINNED_SESSIONS = 200;

export const MAX_REMOVED_PROJECTS = 200;

export const MAX_RECENT_PROJECTS = 12;

export const AUTOMATION_SCHEDULER_COMMANDS = {
  claimDue: "claim_due_automation",
  completeLease: "complete_automation_lease",
  list: "list_automations",
  listDue: "list_due_automations",
  recoverLeases: "recover_automation_leases",
} as const;

export const ACTIVE_TURN_IDLE_MS = 5 * 60 * 1000;

/**
 * Propose a branch name from the pending commit message, so the common case is
 * one keystroke instead of typing a slug by hand.
 */
/** Provider-facing name of the capability that creates reviewable edits. */
export const GYRO_PROPOSE_EDIT_TOOL = "gyro_workspace_propose_edit";

export function suggestedBranchName(commitMessage: string) {
  const slug = commitMessage
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug ? `gyro/${slug}` : "gyro/review";
}

/**
 * What a git command that did not succeed actually said.
 *
 * Git explains itself on stderr, but not always — a rejected commit hook can
 * write its reason to stdout instead — so both are read before falling back
 * to nothing, which lets the caller supply wording of its own.
 */
export function gitOutputDetail(output: IdeCommandOutput) {
  const spoken = [output.stderr, output.stdout]
    .map((text) => text?.trim())
    .find(Boolean);
  return spoken ? spoken.split("\n")[0] : undefined;
}

export function waitFor(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

export function loadModelDefaultSuggestionState() {
  return parseModelDefaultSuggestionState(
    readBoundedLocalStorage(
      MODEL_DEFAULT_SUGGESTION_STORAGE_KEY,
      MODEL_DEFAULT_SUGGESTION_MAX_STORAGE_CHARS,
    ),
    Date.now(),
  );
}

/** Pane key for the chat surfaces that render outside the tiled grid. */
export const SOLO_CHAT_PANE_ID = "solo-chat";

export const EMPTY_BROWSER_PREVIEW =
  createInitialWorkbenchState().browserPreview;

export type BrowserOwner = {
  sessionId: string;
  workspaceKey: string;
  draftKey: string;
};

export function loadInitialWorkbenchState(): WorkbenchState {
  const stored = loadStoredWorkbenchState();
  return applyLaunchView(
    recoverWorkspaceBuffers({
      ...stored,
      preferences: { ...stored.preferences, ...readStoredAppearance() },
    }),
  );
}

export function loadStoredWorkbenchState(): WorkbenchState {
  const base = createInitialWorkbenchState({
    tasks: Object.values(loadChatTaskMetadata()),
  });
  const legacyTheme = storedThemeMode(
    readBoundedLocalStorage(THEME_STORAGE_KEY, 16),
  );
  const stored = readBoundedLocalStorage(
    WORKBENCH_STORAGE_KEY,
    MAX_STORED_WORKBENCH_STATE_CHARS,
  );
  if (!stored) {
    return {
      ...base,
      preferences: {
        ...base.preferences,
        theme: legacyTheme ?? base.preferences.theme,
      },
    };
  }
  try {
    const parsed = JSON.parse(stored) as Partial<WorkbenchState>;
    const legacyDestination = (parsed as { activeDestination?: unknown })
      .activeDestination;
    const storedLayout = normalizeStoredWorkspaceLayout(
      (parsed as { activeWorkspaceLayout?: unknown }).activeWorkspaceLayout,
      base.activeWorkspaceLayout,
    );
    const storedPaneTab = normalizeStoredPaneTab(
      (parsed as { activePaneTab?: unknown }).activePaneTab,
      base.activePaneTab,
    );
    let activeDestination = normalizeStoredDestination(
      legacyDestination,
      base.activeDestination,
    );
    let activeWorkspaceLayout = storedLayout;
    let activePaneTab = storedPaneTab;
    let isToolPanelOpen =
      typeof parsed.isToolPanelOpen === "boolean"
        ? parsed.isToolPanelOpen
        : base.isToolPanelOpen;

    if (legacyDestination === "chat") {
      activeDestination = "workspace";
      activeWorkspaceLayout = "thread";
    } else if (legacyDestination === "cli") {
      activeDestination = "workspace";
      activeWorkspaceLayout = "terminal-grid";
      activePaneTab = "terminal";
      isToolPanelOpen = true;
    } else if (legacyDestination === "ide") {
      activeDestination = "workspace";
      activeWorkspaceLayout = "code";
    } else if (legacyDestination === "diff") {
      activeDestination = "workspace";
      activePaneTab = "diff";
      isToolPanelOpen = true;
    } else if (legacyDestination === "browser") {
      activeDestination = "workspace";
      activePaneTab = "browser";
      isToolPanelOpen = true;
    }
    if (activeWorkspaceLayout === "thread") {
      isToolPanelOpen = false;
    }
    const lastSessionsLayout = normalizeStoredSessionsLayout(
      parsed.lastSessionsLayout,
      activeWorkspaceLayout === "code"
        ? base.lastSessionsLayout
        : activeWorkspaceLayout,
    );

    const terminalPanes = sanitizeStoredTerminalPanes(parsed.terminalPanes);
    const legacyTasks = sanitizeStoredTasks(parsed.tasks);
    const metadata = loadChatTaskMetadata();
    const tasks = [
      ...Object.values(metadata),
      ...legacyTasks.filter(
        (task) => !task.sessionId || !metadata[task.sessionId],
      ),
    ];
    const automations = sanitizeStoredAutomations(parsed.automations);
    const diffReview = sanitizeStoredDiffReview(parsed.diffReview, base);
    const browserPreview = sanitizeStoredBrowserPreview(
      parsed.browserPreview,
      base,
    );
    const hasSeededDemoState =
      terminalPanes.length !== (parsed.terminalPanes?.length ?? 0) ||
      tasks.length !== (parsed.tasks?.length ?? 0) ||
      parsed.diffReview?.commitMessage ===
        "Upgrade Gyro agent workbench UI surfaces";
    const selectedTerminalPaneId = terminalPanes.some(
      (pane) => pane.id === parsed.selectedTerminalPaneId,
    )
      ? parsed.selectedTerminalPaneId
      : undefined;
    const selectedTaskId = tasks.some(
      (task) => task.id === parsed.selectedTaskId,
    )
      ? parsed.selectedTaskId
      : undefined;
    const selectedAutomationId = automations.some(
      (automation) => automation.id === parsed.selectedAutomationId,
    )
      ? parsed.selectedAutomationId
      : undefined;

    return createInitialWorkbenchState({
      ...parsed,
      activeDestination,
      activePaneTab,
      activeWorkspaceLayout,
      lastSessionsLayout,
      automations,
      browserPreview,
      browserPreviewsBySession: undefined,
      diffReview,
      ide: sanitizeStoredIdeState(parsed.ide, base.ide),
      isToolPanelOpen,
      modelFocus: undefined,
      modelFocusHistory: [],
      notifications: Array.isArray(parsed.notifications)
        ? parsed.notifications
            .filter(
              (notification) =>
                notification.id !== "note-approval" &&
                notification.id !== "note-tests",
            )
            // A failure from an earlier launch is not a current one, so it
            // must not reappear as a notice when Gyro starts.
            .map((notification) => ({ ...notification, read: true }))
        : base.notifications,
      onboarding: {
        ...base.onboarding,
        ...parsed.onboarding,
      },
      preferences: {
        ...base.preferences,
        ...parsed.preferences,
        activeChatPanel: undefined,
        // A restart returns the chat to its resting state: no panel on the
        // rail, and the Environment showing beneath where one was.
        chatEnvironmentRailOpen: true,
        theme:
          legacyTheme ??
          storedThemeMode(parsed.preferences?.theme) ??
          base.preferences.theme,
      },
      providerStatuses: Array.isArray(parsed.providerStatuses)
        ? hasSeededDemoState
          ? parsed.providerStatuses
              .map((provider) =>
                provider.id === "openai" ||
                provider.id === "anthropic" ||
                provider.id === "kimi" ||
                provider.id === "xai" ||
                provider.id === "gemini"
                  ? { ...provider, connectionStatus: "not-configured" as const }
                  : provider,
              )
              .filter((provider) => isProviderId(provider.id))
          : parsed.providerStatuses.filter((provider) =>
              isProviderId(provider.id),
            )
        : base.providerStatuses,
      providerReadiness: parsed.providerReadiness ?? base.providerReadiness,
      selectedTaskId,
      selectedAutomationId,
      selectedTerminalPaneId,
      tasks,
      terminalPanes,
    });
  } catch {
    return base;
  }
}

export function normalizeStoredDestination(
  destination: unknown,
  fallback: AppDestination,
): AppDestination {
  if (destination === "tasks") return "automations";
  if (
    destination === "workspace" ||
    destination === "tools" ||
    destination === "settings" ||
    destination === "automations" ||
    destination === "providers" ||
    destination === "onboarding"
  ) {
    return destination;
  }
  return fallback;
}

export function normalizeStoredWorkspaceLayout(
  layout: unknown,
  fallback: WorkspaceLayoutId,
): WorkspaceLayoutId {
  if (layout === "thread" || layout === "terminal-grid" || layout === "code") {
    return layout;
  }
  return fallback;
}

export function normalizeStoredSessionsLayout(
  layout: unknown,
  fallback: SessionsLayoutId,
): SessionsLayoutId {
  return layout === "thread" || layout === "terminal-grid" ? layout : fallback;
}

export function normalizeStoredPaneTab(
  tab: unknown,
  fallback: WorkbenchPaneTab,
): WorkbenchPaneTab {
  if (tab === "terminal" || tab === "diff" || tab === "browser") {
    return tab;
  }
  return fallback;
}

export function sanitizeStoredTerminalPanes(
  panes: Partial<WorkbenchState>["terminalPanes"],
): WorkbenchState["terminalPanes"] {
  if (!Array.isArray(panes)) {
    return [];
  }
  const demoPaneIds = new Set([
    "pane-shell",
    "pane-codex",
    "pane-claude",
    "pane-checks",
  ]);
  return panes.filter((pane) => !demoPaneIds.has(pane.id));
}

export function loadChatTaskMetadata(): Record<string, Task> {
  try {
    const value: unknown = JSON.parse(
      readBoundedLocalStorage(CHAT_TASK_METADATA_KEY, 2_000_000) ?? "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([id, task]) =>
          task &&
          typeof task === "object" &&
          task.sessionId === id &&
          task.id === id &&
          typeof task.title === "string" &&
          typeof task.prompt === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function sanitizeStoredTasks(
  tasks: Partial<WorkbenchState>["tasks"],
): WorkbenchState["tasks"] {
  if (!Array.isArray(tasks)) {
    return [];
  }
  const demoTaskIds = new Set([
    "task-onboarding",
    "task-providers",
    "task-terminal-workbench",
    "task-diff-review",
    "task-browser-preview",
  ]);
  return tasks.filter((task) => !demoTaskIds.has(task.id));
}

export function sanitizeStoredAutomations(
  automations: Partial<WorkbenchState>["automations"],
): WorkbenchState["automations"] {
  if (!Array.isArray(automations)) {
    return [];
  }
  return automations;
}

export function sanitizeStoredDiffReview(
  diffReview: Partial<WorkbenchState>["diffReview"],
  base: WorkbenchState,
): WorkbenchState["diffReview"] {
  if (!diffReview) {
    return base.diffReview;
  }
  if (diffReview.commitMessage === "Upgrade Gyro agent workbench UI surfaces") {
    return base.diffReview;
  }
  return {
    ...base.diffReview,
    ...diffReview,
    files: (diffReview.files ?? []).map((file) =>
      file.countsKnown === undefined
        ? { ...file, additions: 0, deletions: 0, countsKnown: false, lines: [] }
        : file,
    ),
    collapsedDirectories: Array.isArray(diffReview.collapsedDirectories)
      ? diffReview.collapsedDirectories
      : base.diffReview.collapsedDirectories,
    gitActions: Array.isArray(diffReview.gitActions)
      ? // A git action that was in flight when the app closed has no process to
        // resume; restore it as runnable rather than spinning forever.
        diffReview.gitActions.map((action) =>
          action.status === "running"
            ? { ...action, status: "ready" as const }
            : action,
        )
      : base.diffReview.gitActions,
  };
}

export function sanitizeStoredBrowserPreview(
  browserPreview: Partial<WorkbenchState>["browserPreview"],
  base: WorkbenchState,
): WorkbenchState["browserPreview"] {
  if (!browserPreview) {
    return base.browserPreview;
  }
  if (
    browserPreview.verificationMessage === "Agent verification passed" ||
    browserPreview.url?.includes("localhost:1420") ||
    browserPreview.url?.includes("127.0.0.1:1420")
  ) {
    return base.browserPreview;
  }
  const diagnostics = Array.isArray(browserPreview.diagnostics)
    ? browserPreview.diagnostics
        .filter((diagnostic): diagnostic is BrowserPreviewDiagnostic =>
          Boolean(
            diagnostic &&
            ["console-error", "page-error", "unhandled-rejection"].includes(
              diagnostic.kind,
            ) &&
            typeof diagnostic.message === "string",
          ),
        )
        .slice(0, 8)
        .map((diagnostic) => ({
          ...diagnostic,
          message: truncatePersistedText(diagnostic.message, 400),
          source:
            typeof diagnostic.source === "string"
              ? truncatePersistedText(diagnostic.source, 400)
              : undefined,
          line:
            typeof diagnostic.line === "number" &&
            Number.isFinite(diagnostic.line)
              ? diagnostic.line
              : undefined,
          column:
            typeof diagnostic.column === "number" &&
            Number.isFinite(diagnostic.column)
              ? diagnostic.column
              : undefined,
        }))
    : [];
  return {
    ...base.browserPreview,
    ...browserPreview,
    consoleErrors: diagnostics.length,
    diagnostics,
    diagnosticsSupported: browserPreview.diagnosticsSupported === true,
    diagnosticsCaptured: browserPreview.diagnosticsCaptured === true,
    captureStatus: "idle",
    captureError: undefined,
    latestCapture: undefined,
  };
}

export function withCouncilConfig(config: GyroConfig): GyroConfig {
  const base = normalizedConfig(config);
  return {
    ...base,
    council: normalizedCouncilConfig(base.council ?? config.council),
  };
}

export function loadPreviewConfig(): GyroConfig {
  const stored = readBoundedLocalStorage(
    PREVIEW_CONFIG_STORAGE_KEY,
    MAX_STORED_PREVIEW_CONFIG_CHARS,
  );
  if (!stored) {
    return withCouncilConfig(EMPTY_CONFIG);
  }
  try {
    return withCouncilConfig({
      ...EMPTY_CONFIG,
      ...(JSON.parse(stored) as Partial<GyroConfig>),
    });
  } catch {
    return withCouncilConfig(EMPTY_CONFIG);
  }
}

export function loadPinnedSessionIds(): string[] {
  const stored = readBoundedLocalStorage(
    PINNED_SESSIONS_STORAGE_KEY,
    MAX_STORED_PREVIEW_CONFIG_CHARS,
  );
  if (!stored) {
    return [];
  }
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed
          .filter((id): id is string => typeof id === "string")
          .slice(0, MAX_PINNED_SESSIONS)
      : [];
  } catch {
    return [];
  }
}

export function loadChatDrafts(): Record<string, string> {
  const stored = readBoundedLocalStorage(CHAT_DRAFTS_STORAGE_KEY, 256_000);
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" &&
          typeof entry[1] === "string" &&
          chatMessageLength(entry[1]) <= MAX_CHAT_MESSAGE_CHARS,
      ),
    );
  } catch {
    return {};
  }
}

export function loadChatDraftModes(): Record<string, ChatMode> {
  const stored = readBoundedLocalStorage(CHAT_DRAFT_MODES_STORAGE_KEY, 64_000);
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, ChatMode] =>
          typeof entry[0] === "string" &&
          (entry[1] === "plan" || entry[1] === "council"),
      ),
    );
  } catch {
    return {};
  }
}

export function loadChatAttachments(): Record<string, ChatAttachment[]> {
  const stored = readBoundedLocalStorage(CHAT_ATTACHMENTS_STORAGE_KEY, 512_000);
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [
        key,
        Array.isArray(value)
          ? value
              .filter(
                (item): item is ChatAttachment =>
                  Boolean(item) &&
                  typeof item === "object" &&
                  typeof (item as ChatAttachment).id === "string" &&
                  typeof (item as ChatAttachment).path === "string",
              )
              .slice(0, 12)
          : [],
      ]),
    );
  } catch {
    return {};
  }
}

export function loadChatGridState(): ChatGridState {
  const stored = readBoundedLocalStorage(CHAT_GRID_STORAGE_KEY, 512_000);
  if (!stored) return createInitialChatGridState();
  try {
    return sanitizeStoredChatGridState(JSON.parse(stored));
  } catch {
    return createInitialChatGridState();
  }
}

// IPC header values must be ASCII; file names and paths may not be.
export function base64Utf8(value: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function loadRemovedProjectPaths(): string[] {
  const stored = readBoundedLocalStorage(
    REMOVED_PROJECTS_STORAGE_KEY,
    MAX_STORED_PREVIEW_CONFIG_CHARS,
  );
  if (!stored) {
    return [];
  }
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed
          .filter((path): path is string => typeof path === "string")
          .map(normalizeProjectPath)
          .filter(Boolean)
          .slice(0, MAX_REMOVED_PROJECTS)
      : [];
  } catch {
    return [];
  }
}

export function loadInitialWorkspacePath(): string | undefined {
  const removed = new Set(loadRemovedProjectPaths());
  return loadRecentProjectPaths().find((path) => !removed.has(path));
}

export function loadRecentProjectPaths(): string[] {
  const stored = readBoundedLocalStorage(
    RECENT_PROJECTS_STORAGE_KEY,
    MAX_STORED_PREVIEW_CONFIG_CHARS,
  );
  if (!stored) {
    return [];
  }
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed
              .filter((path): path is string => typeof path === "string")
              .map(normalizeProjectPath)
              .filter(Boolean),
          ),
        ].slice(0, MAX_RECENT_PROJECTS)
      : [];
  } catch {
    return [];
  }
}

export function chatPaneForSession(session: Session): ChatPaneRef {
  return {
    paneId: `session:${session.id}`,
    kind: "session",
    sessionId: session.id,
    workspacePath: session.workspacePath,
  };
}

export function persistChatDrafts(drafts: Record<string, string>) {
  safeSetLocalStorage(CHAT_DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
}

export function flushPersistedWorkbenchState(
  ref: { current?: WorkbenchState },
  onPersisted?: (
    preferences: WorkbenchState["preferences"],
    saved: boolean,
  ) => void,
) {
  const pending = ref.current;
  if (!pending) {
    return;
  }
  ref.current = undefined;
  const saved = saveAppearancePreferences(pending.preferences);
  onPersisted?.(pending.preferences, saved);
  safeSetLocalStorage(WORKBENCH_STORAGE_KEY, JSON.stringify(pending));
}

export function schedulePersistedWorkbenchStateFlush(
  pendingRef: { current?: WorkbenchState },
  idleRef: { current?: number },
  onPersisted?: (
    preferences: WorkbenchState["preferences"],
    saved: boolean,
  ) => void,
) {
  if (idleRef.current !== undefined) {
    return;
  }
  const idleWindow = window as Window & {
    cancelIdleCallback?: (handle: number) => void;
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout?: number },
    ) => number;
  };
  if (idleWindow.requestIdleCallback) {
    idleRef.current = idleWindow.requestIdleCallback(
      () => {
        idleRef.current = undefined;
        flushPersistedWorkbenchState(pendingRef, onPersisted);
      },
      { timeout: WORKBENCH_PERSIST_IDLE_TIMEOUT_MS },
    );
    return;
  }
  idleRef.current = window.setTimeout(() => {
    idleRef.current = undefined;
    flushPersistedWorkbenchState(pendingRef, onPersisted);
  }, 0);
}

export function cancelPersistedWorkbenchStateFlush(ref: { current?: number }) {
  if (ref.current === undefined) {
    return;
  }
  const idleWindow = window as Window & {
    cancelIdleCallback?: (handle: number) => void;
  };
  if (idleWindow.cancelIdleCallback) {
    idleWindow.cancelIdleCallback(ref.current);
  }
  window.clearTimeout(ref.current);
  ref.current = undefined;
}

export function persistableWorkbenchState(
  workbench: WorkbenchState,
): WorkbenchState {
  return {
    ...workbench,
    activeTurn: undefined,
    browserPreviewsBySession: undefined,
    terminalPanes: workbench.terminalPanes
      .filter((pane) => pane.owner?.kind !== "model")
      .map((pane) => ({
        ...pane,
        attention: undefined,
        output: truncatePersistedText(
          pane.output,
          MAX_PERSISTED_TERMINAL_OUTPUT_CHARS,
        ),
      })),
    providerReadiness: {
      status: "idle",
      message: "",
    },
    providerStatuses: workbench.providerStatuses.map((provider) => ({
      ...provider,
      healthOutput: undefined,
    })),
    ide: {
      ...workbench.ide,
      buffers: persistableDirtyEditorBuffers(workbench.ide.buffers),
      selection: undefined,
      outputChannels: workbench.ide.outputChannels.map(
        persistableOutputChannel,
      ),
    },
  };
}

export function persistableDirtyEditorBuffers(
  buffers: WorkbenchState["ide"]["buffers"],
) {
  const persisted: WorkbenchState["ide"]["buffers"] = {};
  let remainingChars = MAX_PERSISTED_DIRTY_BUFFERS_TOTAL_CHARS;
  for (const buffer of Object.values(buffers)) {
    if (buffer.status !== "dirty") continue;
    const chars = buffer.content.length + buffer.savedContent.length;
    if (chars > MAX_PERSISTED_DIRTY_BUFFER_CHARS || chars > remainingChars) {
      continue;
    }
    persisted[buffer.path] = buffer;
    remainingChars -= chars;
  }
  return persisted;
}

export function persistableOutputChannel(
  channel: OutputChannel,
): OutputChannel {
  return {
    ...channel,
    lines: channel.lines.slice(-MAX_PERSISTED_OUTPUT_CHANNEL_LINES),
  };
}

export function truncatePersistedText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  return `...${value.slice(-maxChars)}`;
}

export function normalizeChatMessage(value: string) {
  return value.replace(/\u0000/g, "").trim();
}

// Same rules as `session_title_from_message` in the desktop backend.
// Titles stay local so the selected model is not billed to name the chat.
// Keep in step with `strip_list_marker` in the desktop backend. A marker on
// its own ("1" from "1. …") carries no title words, so callers skip it.
export function stripTitleListMarker(text: string) {
  let rest = text.trim();
  for (;;) {
    const trimmed = rest.replace(/^[#>]+\s*/, "").trimStart();
    const bullet = /^[-*+•]\s+/.exec(trimmed);
    if (bullet) {
      rest = trimmed.slice(bullet[0].length);
      continue;
    }
    const ordered = /^(\d+)([.):])?\s*/.exec(trimmed);
    if (ordered) {
      if (!ordered[2]) {
        // A bare number left by the sentence split is still a marker.
        if (trimmed.slice(ordered[0].length).trim() === "") {
          return "";
        }
        return trimmed;
      }
      rest = trimmed.slice(ordered[0].length);
      continue;
    }
    return trimmed;
  }
}

export function sessionTitleFromMessage(message: string) {
  const base = normalizeChatMessage(message)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\/\w+\s+/, "");
  // A numbered or bulleted opening ("1. …") must not become the title: the
  // sentence split would otherwise keep only the marker itself.
  const cleaned = base
    .split(/[.!?\n]/)
    .map(stripTitleListMarker)
    .map((part) =>
      part
        .replace(
          /^(please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|i\s+want\s+to\s+|i\s+need\s+to\s+|help\s+me\s+|let'?s\s+)/i,
          "",
        )
        .trim(),
    )
    .find((part) => /[a-z]/i.test(part));
  const words = (cleaned ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((word) => {
      if (/^[A-Z0-9]{2,}$/.test(word)) {
        return word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    });
  return normalizeSessionTitleInput(words.join(" ")) ?? "New chat";
}

export function shouldSuggestSessionTitle(
  session: Session | undefined,
  hasTranscriptEvents: boolean,
) {
  if (!session) {
    return true;
  }
  if (!isGenericSessionTitle(session.title)) {
    return false;
  }
  return !hasTranscriptEvents;
}

// Keep in step with `is_generic_session_title` in the desktop backend. A
// placeholder this list misses is treated as a real title, so the first turn
// skips its rename and the chat keeps the placeholder forever.
export function isGenericSessionTitle(title: string) {
  // A title with no letters is a marker or a placeholder ("1", "-"), never a
  // name the user chose, so the model may still replace it.
  if (!/[a-z]/i.test(title)) {
    return true;
  }
  return [
    "Desktop session",
    "New chat",
    "Worktree session",
    "Agent workspace",
    "CLI workspace",
    "Worktree CLI workspace",
    "Agent workspace CLI",
    "Provider session",
    "Chat handoff",
    "Gyro session",
    "Untitled chat",
  ].includes(title.trim());
}

export function chatMessageLength(value: string) {
  return Array.from(value).length;
}

export function chatMessagePreview(value: string) {
  const normalized = normalizeChatMessage(value).replace(/\s+/g, " ");
  const chars = Array.from(normalized);
  if (chars.length <= 160) {
    return normalized;
  }
  return `${chars.slice(0, 160).join("")}...`;
}

export function languageServerDescriptorForPath(
  path: string,
  override?: string,
) {
  if (path.startsWith("gyro-diff:")) return undefined;
  const language = resolveLanguage({ path, override });
  return language.lsp
    ? {
        languageId: language.lsp.languageId ?? language.id,
        command: language.lsp.command,
      }
    : undefined;
}

export function workspaceFileUri(workspacePath: string, relativePath: string) {
  const fullPath = absoluteWorkspaceFilePath(workspacePath, relativePath)
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `file://${fullPath}`;
}

export function diagnosticsFromLspMessages(
  messages: unknown[] | undefined,
  workspacePath: string,
): ProblemDiagnostic[] | undefined {
  if (!messages) {
    return undefined;
  }
  let sawDiagnostics = false;
  const diagnostics: ProblemDiagnostic[] = [];
  for (const message of messages) {
    if (
      !isRecord(message) ||
      message.method !== "textDocument/publishDiagnostics"
    ) {
      continue;
    }
    const params = isRecord(message.params) ? message.params : undefined;
    if (!params || typeof params.uri !== "string") {
      continue;
    }
    sawDiagnostics = true;
    const path = lspRelativePath(params.uri, workspacePath);
    const values = Array.isArray(params.diagnostics) ? params.diagnostics : [];
    values.forEach((value, index) => {
      if (!isRecord(value) || typeof value.message !== "string") {
        return;
      }
      const range = isRecord(value.range) ? value.range : undefined;
      const start = range && isRecord(range.start) ? range.start : undefined;
      const end = range && isRecord(range.end) ? range.end : undefined;
      const severityValue =
        typeof value.severity === "number" ? value.severity : 3;
      const severity: ProblemDiagnostic["severity"] =
        severityValue === 1
          ? "error"
          : severityValue === 2
            ? "warning"
            : severityValue === 4
              ? "hint"
              : "info";
      diagnostics.push({
        id: `${path}:${numberField(start, "line")}:${index}:${value.message}`,
        path,
        message: value.message,
        severity,
        source: typeof value.source === "string" ? value.source : undefined,
        startLineNumber: numberField(start, "line") + 1,
        startColumn: numberField(start, "character") + 1,
        endLineNumber: numberField(end, "line") + 1,
        endColumn: numberField(end, "character") + 1,
      });
    });
  }
  return sawDiagnostics ? diagnostics : undefined;
}

export function lspRelativePath(uri: string, workspacePath: string) {
  try {
    const absolutePath = decodeURIComponent(uri.replace(/^file:\/\//, ""));
    return absoluteWorkspaceFilePath(workspacePath, absolutePath);
  } catch {
    return uri;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function numberField(
  value: Record<string, unknown> | undefined,
  key: string,
) {
  return typeof value?.[key] === "number" ? value[key] : 0;
}

export function getCommandProfile(
  profiles: CommandProfile[],
  preferredId?: string,
): CommandProfile {
  const [fallback] = defaultCommandProfiles();
  if (!fallback) {
    throw new Error("Gyro requires at least one command profile");
  }
  return (
    profiles.find((profile) => profile.id === preferredId) ??
    profiles[0] ??
    fallback
  );
}

/**
 * Whether a pane profile can run under Gyro's approval policy.
 *
 * Mirrors `governable_pane_provider` in the Tauri backend, which is the
 * authority — this only avoids asking for governance the backend will refuse.
 * Governance needs an interactive permission hook, which today means Claude
 * Code; Codex approves through the app-server path a raw PTY cannot speak.
 */
export function profileSupportsGovernance(profile: CommandProfile) {
  const command = profile.command.trim().split("/").pop() ?? "";
  return (
    profile.id === "claude" ||
    profile.id === "claude-code" ||
    command === "claude"
  );
}

export function terminalProcessForProfile(
  profile: CommandProfile,
  commandOverride?: string,
) {
  if (commandOverride) {
    return {
      args: ["-lc", commandOverride],
      command: "zsh",
      displayCommand: commandOverride,
    };
  }
  return {
    args: profile.args,
    command: profile.command,
    displayCommand: [profile.command, ...profile.args]
      .filter(Boolean)
      .join(" "),
  };
}

/** Preserve discovered task arguments when a task is launched through zsh. */
export function terminalCommandLine(task: TaskDefinition) {
  return [task.command, ...task.args]
    .map((part) => `'${part.replace(/'/g, "'\\''")}'`)
    .join(" ");
}

export function workspaceTaskTerminalPaneId(taskId: string) {
  return `workspace-task-${encodeURIComponent(taskId)}`;
}

export function terminalStatusFromSnapshot(
  status: TerminalPaneSnapshot["status"],
): TerminalPaneStatus {
  if (status === "done") {
    return "done";
  }
  if (status === "failed") {
    return "failed";
  }
  return "running";
}

export function terminalPaneFromSnapshot(
  snapshot: TerminalPaneSnapshot,
  mode: WorkbenchState["workspaceMode"],
): TerminalPane {
  const profile = {
    id: snapshot.profileId ?? inferredTerminalProfileId(snapshot),
    displayName: snapshot.title,
    command: snapshot.command.split(" ")[0] ?? "sh",
    args: [],
    workingDirectory: "Workspace",
  };
  return {
    ...createTerminalPane(
      snapshot.paneId,
      profile,
      terminalStatusFromSnapshot(snapshot.status),
      workspaceRunMetadata(mode, snapshot.title, snapshot.workingDirectory),
    ),
    projectPath: snapshot.workspacePath,
    command: snapshot.command,
    lastEvent:
      snapshot.exitCode === null || snapshot.exitCode === undefined
        ? snapshot.status
        : `${snapshot.status} (${snapshot.exitCode})`,
    output: snapshot.output ?? "",
    hasForegroundJob: snapshot.hasForegroundJob ?? undefined,
  };
}

export function terminalSnapshotFromCapabilityData(
  value: unknown,
): TerminalPaneSnapshot | undefined {
  const data = recordFromUnknown(value);
  const pane = recordFromUnknown(data?.pane);
  const paneId = stringFromRecord(pane, "paneId");
  const title = stringFromRecord(pane, "title");
  const command = stringFromRecord(pane, "command");
  const status = stringFromRecord(pane, "status");
  const outputRevision = pane?.outputRevision;
  if (
    !paneId ||
    !title ||
    !command ||
    !["running", "done", "failed"].includes(status ?? "") ||
    typeof outputRevision !== "number"
  ) {
    return undefined;
  }
  return {
    paneId,
    title,
    profileId: stringFromRecord(pane, "profileId"),
    command,
    output: stringFromRecord(pane, "output"),
    outputRevision,
    status: status as TerminalPaneSnapshot["status"],
    hasForegroundJob:
      typeof pane?.hasForegroundJob === "boolean"
        ? pane.hasForegroundJob
        : undefined,
    exitCode: typeof pane?.exitCode === "number" ? pane.exitCode : undefined,
    workspacePath: stringFromRecord(pane, "workspacePath"),
    workingDirectory: stringFromRecord(pane, "workingDirectory"),
    cols: typeof pane?.cols === "number" ? pane.cols : 120,
    rows: typeof pane?.rows === "number" ? pane.rows : 32,
  };
}

/**
 * Project a capability call onto the Workspace AI view's tool-call row.
 *
 * The capability status vocabulary is wider than the view's, so waiting and
 * requested both read as queued, and every terminal-but-unsuccessful status
 * reads as failed.
 */
export function ideAiToolCallFromActivity(
  activity: CapabilityActivity,
): IdeAiToolCall {
  const status: IdeAiToolCall["status"] =
    activity.status === "completed"
      ? "done"
      : activity.status === "running"
        ? "running"
        : activity.status === "denied"
          ? "blocked"
          : activity.status === "requested" || activity.status === "waiting"
            ? "queued"
            : "failed";
  return {
    id: activity.callId,
    name: activity.capabilityId,
    status,
    summary: activity.summary,
    createdAt: activity.createdAt,
    finishedAt:
      status === "done" || status === "failed" || status === "blocked"
        ? activity.createdAt
        : undefined,
  };
}

export function capabilityActivityFromSessionEvent(
  event: SessionEvent,
): CapabilityActivity | undefined {
  const payload = recordFromUnknown(event.payload);
  if (
    stringFromRecord(payload, "schema") !== "gyro.capability.v1" ||
    stringFromRecord(payload, "kind") !== "capability-call"
  ) {
    return undefined;
  }
  const callId = stringFromRecord(payload, "callId");
  const capabilityId = stringFromRecord(payload, "capabilityId");
  const status = stringFromRecord(payload, "status");
  const providerId = stringFromRecord(payload, "providerId");
  const summary = stringFromRecord(payload, "summary");
  const policyRevision = payload?.policyRevision;
  if (
    !callId ||
    !capabilityId ||
    !status ||
    !providerId ||
    !summary ||
    typeof policyRevision !== "number"
  ) {
    return undefined;
  }
  const resourceRecord = recordFromUnknown(payload?.resource);
  const resourceId = stringFromRecord(resourceRecord, "id");
  const resourceKind = stringFromRecord(resourceRecord, "kind");
  const resourceLabel = stringFromRecord(resourceRecord, "label");
  const resource =
    resourceId &&
    resourceLabel &&
    ["workspace", "ide", "terminal", "browser"].includes(resourceKind ?? "")
      ? {
          id: resourceId,
          kind: resourceKind as CapabilityResourceRef["kind"],
          label: resourceLabel,
        }
      : undefined;
  return {
    schema: "gyro.capability.v1",
    kind: "capability-call",
    callId,
    capabilityId: capabilityId as CapabilityCallEvent["capabilityId"],
    status: status as CapabilityCallEvent["status"],
    providerId,
    policyRevision,
    summary,
    resource,
    target: stringFromRecord(payload, "target"),
    sessionId: event.sessionId,
    turnId: event.turnId,
    createdAt: event.createdAt,
  };
}

export function markInactiveCapabilityResources(
  events: SessionEvent[],
  liveResourceIds: ReadonlySet<string>,
) {
  return events.map((event) => {
    const payload = recordFromUnknown(event.payload);
    if (
      stringFromRecord(payload, "schema") !== "gyro.capability.v1" ||
      stringFromRecord(payload, "kind") !== "capability-call" ||
      stringFromRecord(payload, "status") !== "completed"
    ) {
      return event;
    }
    const resource = recordFromUnknown(payload?.resource);
    const resourceId = stringFromRecord(resource, "id");
    const resourceKind = stringFromRecord(resource, "kind");
    if (
      !resourceId ||
      !["terminal", "browser"].includes(resourceKind ?? "") ||
      liveResourceIds.has(resourceId)
    ) {
      return event;
    }
    return {
      ...event,
      payload: {
        ...payload,
        status: "inactive",
        summary: `${stringFromRecord(payload, "summary") ?? event.message} · inactive after restart`,
      },
    };
  });
}

export function capabilityApprovalFromSessionEvent(
  event: SessionEvent,
): CapabilityApprovalEvent | undefined {
  const payload = recordFromUnknown(event.payload);
  if (
    event.kind !== "approval-requested" ||
    stringFromRecord(payload, "schema") !== "gyro.capability.v1" ||
    stringFromRecord(payload, "kind") !== "capability-approval"
  ) {
    return undefined;
  }
  const approvalId = stringFromRecord(payload, "approvalId");
  const callId = stringFromRecord(payload, "callId");
  const capabilityId = stringFromRecord(payload, "capabilityId");
  const capabilityClass = stringFromRecord(payload, "capabilityClass");
  const providerId = stringFromRecord(payload, "providerId");
  const scopeKind = stringFromRecord(payload, "scopeKind");
  const scopeValue = stringFromRecord(payload, "scopeValue");
  if (
    !approvalId ||
    !callId ||
    !capabilityId ||
    !capabilityClass ||
    !providerId ||
    !scopeKind ||
    !scopeValue
  ) {
    return undefined;
  }
  return {
    schema: "gyro.capability.v1",
    kind: "capability-approval",
    approvalId,
    callId,
    capabilityId: capabilityId as CapabilityApprovalEvent["capabilityId"],
    capabilityClass:
      capabilityClass as CapabilityApprovalEvent["capabilityClass"],
    providerId,
    status: "waiting",
    scopeKind,
    scopeValue,
    choices:
      capabilityId === "workspace-read-editor"
        ? ["deny", "allow-once"]
        : ["deny", "allow-once", "allow-project"],
  };
}

export function inferredTerminalProfileId(
  snapshot: TerminalPaneSnapshot,
): string {
  const command = snapshot.command.trim().split(/\s+/, 1)[0] ?? "";
  const executable = command.split("/").pop()?.toLowerCase();
  if (
    snapshot.title.trim().toLowerCase() === "shell" &&
    executable &&
    ["sh", "bash", "zsh", "fish"].includes(executable)
  ) {
    return "shell";
  }
  return `restored-${snapshot.paneId}`;
}

export function isPlainShellTerminal(pane: TerminalPane): boolean {
  if (pane.profileId === "shell") {
    return true;
  }
  const command = pane.command.trim().split(/\s+/, 1)[0] ?? "";
  const executable = command.split("/").pop()?.toLowerCase();
  return (
    pane.title.trim().toLowerCase() === "shell" &&
    executable !== undefined &&
    ["sh", "bash", "zsh", "fish"].includes(executable)
  );
}

export function terminalPaneProcessIsMissing(error: unknown): boolean {
  return String(error).toLowerCase().includes("terminal pane not found");
}

export function terminalSizeForTemplate(template: TerminalTemplate) {
  if (template <= 1) {
    return { cols: 132, rows: 36 };
  }
  if (template <= 4) {
    return { cols: 110, rows: 30 };
  }
  if (template <= 8) {
    return { cols: 92, rows: 24 };
  }
  return { cols: 80, rows: 20 };
}

export function pathFromSessionEvent(
  event: SessionEvent,
  workspacePath?: string,
): string {
  const payload = recordFromUnknown(event.payload);
  const directPath = stringFromRecord(payload, "path");
  const dataPath = stringFromRecord(recordFromUnknown(payload?.data), "path");
  const rawPath = (() => {
    if (directPath || dataPath) {
      return directPath ?? dataPath ?? "packages/ui/src/surfaces.tsx";
    }
    const explicitPath = event.message.match(/(?:file|path):\s*([^\s]+)/i)?.[1];
    if (explicitPath) {
      return explicitPath;
    }
    return (
      event.message.match(/[\w./-]+\.(?:css|json|md|rs|ts|tsx)/)?.[0] ??
      "packages/ui/src/surfaces.tsx"
    );
  })();
  return workspaceRelativeFilePath(rawPath, workspacePath);
}

export function deriveActiveTurn(
  events: SessionEvent[],
  sessionTitle = "Desktop session",
  workspacePath?: string,
): WorkbenchTurn | undefined {
  let latestUserEvent: SessionEvent | undefined;
  let latestUserIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "user-message") {
      latestUserEvent = event;
      latestUserIndex = index;
      break;
    }
  }
  if (!latestUserEvent) {
    return undefined;
  }

  const turnId = turnIdFromSessionEvent(latestUserEvent) ?? latestUserEvent.id;
  const changedFiles = new Set<string>();
  let genericApprovalsPending = 0;
  const mutationApprovalStatuses = new Map<string, string>();
  let lastEvent = latestUserEvent;
  let hasCommandRequest = false;
  let hasCommandOutput = false;
  let hasStreamingAssistant = false;
  let hasProviderActivity = false;
  let providerStatus: string | undefined;
  /** Heartbeats refresh the status event's createdAt; that is the live clock. */
  let providerStatusCreatedAt: string | undefined;

  for (
    let index = Math.max(0, latestUserIndex);
    index < events.length;
    index += 1
  ) {
    const event = events[index];
    if (!event) {
      continue;
    }
    const eventTurnId = turnIdFromSessionEvent(event);
    const isTurnEvent =
      (eventTurnId ?? event.id) === turnId ||
      (event.kind !== "user-message" &&
        !eventTurnId &&
        event.createdAt >= latestUserEvent.createdAt);
    if (!isTurnEvent) {
      continue;
    }
    lastEvent = event;
    if (event.kind === "file-edit-proposed") {
      changedFiles.add(pathFromSessionEvent(event, workspacePath));
    } else if (event.kind === "approval-requested") {
      const payload = recordFromUnknown(event.payload);
      const proposalId = stringFromRecord(payload, "proposalId");
      if (
        proposalId &&
        stringFromRecord(payload, "kind") === "mutation-approval"
      ) {
        mutationApprovalStatuses.set(
          proposalId,
          stringFromRecord(payload, "status") ?? "pending",
        );
      } else {
        genericApprovalsPending += 1;
      }
    } else if (event.kind === "system-event") {
      const payload = recordFromUnknown(event.payload);
      const payloadKind = stringFromRecord(payload, "kind");
      const proposalId = stringFromRecord(payload, "proposalId");
      const status = stringFromRecord(payload, "status");
      if (proposalId && status && payloadKind === "mutation-approval") {
        mutationApprovalStatuses.set(proposalId, status);
      }
      // Backend status is the source of truth for whether the turn is still
      // open. Heuristics below only fill gaps when no status event exists yet.
      if (payloadKind === "provider-status" && status) {
        providerStatus = status;
        providerStatusCreatedAt = event.createdAt;
      }
      if (payloadKind === "provider-activity") {
        hasProviderActivity = true;
      }
    } else if (event.kind === "command-requested") {
      hasCommandRequest = true;
    } else if (event.kind === "command-output") {
      hasCommandOutput = true;
    } else if (isStreamingAssistantSessionEvent(event)) {
      hasStreamingAssistant = true;
    }
  }

  const approvalsPending =
    genericApprovalsPending +
    Array.from(mutationApprovalStatuses.values()).filter(
      (status) => status === "pending",
    ).length;

  // Prefer the durable/streamed provider status so a mid-turn assistant bubble
  // never settles the workbench turn to "done" while the backend is still live.
  const status =
    approvalsPending > 0
      ? "waiting"
      : providerStatus === "running" ||
          providerStatus === "queued" ||
          providerStatus === "waiting"
        ? providerStatus
        : providerStatus === "done" ||
            providerStatus === "failed" ||
            providerStatus === "cancelled" ||
            providerStatus === "blocked"
          ? providerStatus === "cancelled" || providerStatus === "blocked"
            ? "failed"
            : providerStatus
          : hasStreamingAssistant || hasProviderActivity
            ? "running"
            : hasCommandOutput ||
                (!hasCommandRequest && lastEvent.kind === "assistant-message")
              ? "done"
              : hasCommandRequest
                ? "running"
                : "queued";

  // While the provider is still open, use the later of the last timeline beat
  // and the status event (which heartbeats touch). Otherwise quiet tool stretches
  // after early activity leave a stale updatedAt and the idle watchdog fires.
  const isLiveProviderStatus =
    status === "running" || status === "queued" || status === "waiting";
  const updatedAt =
    isLiveProviderStatus && providerStatusCreatedAt
      ? laterIsoTimestamp(lastEvent.createdAt, providerStatusCreatedAt)
      : lastEvent.createdAt;

  return {
    id: turnId,
    sessionId: latestUserEvent.sessionId,
    sessionTitle,
    status,
    startedAt: latestUserEvent.createdAt,
    updatedAt,
    lastEvent:
      lastEvent.kind === "assistant-message"
        ? "Assistant response received"
        : lastEvent.message,
    changedFiles: changedFiles.size,
    approvalsPending,
  };
}

export function isStreamingAssistantSessionEvent(event: SessionEvent) {
  const payload = recordFromUnknown(event.payload);
  return (
    event.kind === "assistant-message" &&
    payload?.kind === "provider-stream" &&
    payload.streaming === true
  );
}

export function areWorkbenchTurnsEqual(
  current: WorkbenchTurn | undefined,
  next: WorkbenchTurn | undefined,
) {
  if (!current || !next) {
    return current === next;
  }
  return (
    current.id === next.id &&
    current.sessionId === next.sessionId &&
    current.sessionTitle === next.sessionTitle &&
    current.status === next.status &&
    current.startedAt === next.startedAt &&
    current.updatedAt === next.updatedAt &&
    current.lastEvent === next.lastEvent &&
    current.changedFiles === next.changedFiles &&
    current.approvalsPending === next.approvalsPending
  );
}

export function editorBufferHasUnsavedChanges(
  buffer: EditorBuffer | undefined,
) {
  return Boolean(buffer && buffer.content !== buffer.savedContent);
}

export function workspaceContentToEditorBuffer(
  content: WorkspaceFileContent,
): EditorBuffer {
  return {
    path: content.path,
    content: content.content,
    savedContent: content.content,
    contentHash: content.contentHash,
    sizeBytes: content.sizeBytes,
    truncated: content.truncated,
    status: "ready",
    updatedAt: new Date().toISOString(),
  };
}

export function untrackedWorkspaceFileDiff(
  path: string,
  file: WorkspaceFileContent,
) {
  const lines = file.content.length > 0 ? file.content.split("\n") : [];
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    ...(file.truncated ? ["+… file preview truncated …"] : []),
  ].join("\n");
}

export function sourceControlLineStats(sourceControl: SourceControlState) {
  return Object.fromEntries(
    sourceControl.files.map((file) => [
      file.path.replaceAll("\\", "/"),
      { additions: file.additions, deletions: file.deletions },
    ]),
  );
}

export function workspaceName(path?: string) {
  return path?.split("/").filter(Boolean).at(-1) ?? "Untitled";
}

export function savedProjectsFromSessions(
  sessions: Session[],
  currentWorkspacePath?: string,
  removedProjectPaths: string[] = [],
  recentProjectPaths: string[] = [],
): SavedProject[] {
  const projects = new Map<
    string,
    { path: string; label: string; lastUsedAt: number; sessionCount: number }
  >();
  const removed = new Set(removedProjectPaths.map(normalizeProjectPath));
  const currentPath = normalizeProjectPath(currentWorkspacePath);

  const upsertProject = (
    path: string | undefined,
    updatedAt?: string,
    options: { includeRemoved?: boolean; countSession?: boolean } = {},
  ) => {
    if (!path) {
      return;
    }
    const normalizedPath = normalizeProjectPath(path);
    if (!normalizedPath) {
      return;
    }
    if (removed.has(normalizedPath) && !options.includeRemoved) {
      return;
    }
    // A generated scratch folder stays out of the switcher unless it is open.
    if (
      normalizedPath !== currentPath &&
      !isUserSelectedWorkspacePath(normalizedPath)
    ) {
      return;
    }
    const existing = projects.get(normalizedPath);
    const lastUsedAt = updatedAt
      ? new Date(updatedAt).getTime() || 0
      : Date.now();
    projects.set(normalizedPath, {
      path: normalizedPath,
      label: workspaceName(normalizedPath),
      lastUsedAt: Math.max(existing?.lastUsedAt ?? 0, lastUsedAt),
      sessionCount:
        (existing?.sessionCount ?? 0) +
        (updatedAt && options.countSession !== false ? 1 : 0),
    });
  };

  upsertProject(currentWorkspacePath, undefined, { includeRemoved: true });
  // Smoke tests and CLI probes run in system temp folders. They are not
  // projects the user chose, so only the open workspace may surface one.
  recentProjectPaths
    .filter((path) => !isTransientWorkspacePath(path))
    .forEach((path, index) =>
      upsertProject(path, new Date(Date.now() - index).toISOString(), {
        countSession: false,
      }),
    );
  sessions
    .filter(
      (session) =>
        session.origin !== "cli" &&
        !isTransientWorkspacePath(session.workspacePath),
    )
    .forEach((session) =>
      upsertProject(session.workspacePath, session.updatedAt),
    );

  return [...projects.values()]
    .sort((first, second) => {
      if (first.path === currentPath) {
        return -1;
      }
      if (second.path === currentPath) {
        return 1;
      }
      return second.lastUsedAt - first.lastUsedAt;
    })
    .map((project) => ({
      path: project.path,
      label: project.label,
      detail:
        project.path === currentPath
          ? "Current project"
          : project.sessionCount > 0
            ? `${project.sessionCount} chat${
                project.sessionCount === 1 ? "" : "s"
              }`
            : "Recent project",
      sessionCount: project.sessionCount,
    }));
}

export function parentDirectory(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : normalized;
}

export function relativeFilePath(path: string, parent: string) {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedParent = parent.replaceAll("\\", "/").replace(/\/+$/, "");
  const prefix = `${normalizedParent}/`;
  return normalizedPath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : workspaceName(normalizedPath);
}

export function workspaceFailedTests(items: TestTreeItem[]): TestTreeItem[] {
  return items.flatMap((item) => [
    ...(item.status === "failed" ? [item] : []),
    ...workspaceFailedTests(item.children ?? []),
  ]);
}

export function editorPathMatches(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}

export function renameEditorPath(
  path: string,
  fromPath: string,
  toPath: string,
) {
  return editorPathMatches(path, fromPath)
    ? `${toPath}${path.slice(fromPath.length)}`
    : path;
}

export function workspaceTreeSignature(files: WorkspaceFile[]) {
  return files
    .map((file) => `${file.kind}:${file.path}:${file.depth ?? ""}`)
    .join("\n");
}

export function disposeEditorModels(paths: string[]) {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (uniquePaths.length === 0) {
    return;
  }
  void import("./monaco-editor")
    .then(({ disposeMonacoModel }) => {
      uniquePaths.forEach(disposeMonacoModel);
    })
    .catch(() => undefined);
}

export function createTurnId() {
  return globalThis.crypto?.randomUUID?.() ?? `turn-${Date.now()}`;
}

/** Later of two ISO timestamps; falls back to the first parseable value. */
export function laterIsoTimestamp(first: string, second: string) {
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  if (!Number.isFinite(firstMs)) {
    return Number.isFinite(secondMs) ? second : first;
  }
  if (!Number.isFinite(secondMs)) {
    return first;
  }
  return secondMs >= firstMs ? second : first;
}

export function providerLabelForId(
  providers: ModelProviderConfig[],
  statuses: WorkbenchState["providerStatuses"],
  providerId: string,
) {
  return (
    providers.find((provider) => provider.id === providerId)?.displayName ??
    statuses.find((provider) => provider.id === providerId)?.displayName ??
    providerId
  );
}

export function approvalNotificationCopy(
  config: GyroConfig,
  mode: "auto" | "direct" | "gated",
) {
  const providerName =
    config.selectedProviderId === "anthropic"
      ? "Claude"
      : config.selectedProviderId === "kimi"
        ? "Kimi"
        : config.selectedProviderId === "xai"
          ? "Grok"
          : config.selectedProviderId === "antigravity"
            ? "Google Antigravity"
            : "Codex";
  if (mode === "gated") {
    return {
      title: "Ask for approval",
      detail: `${providerName} will ask before commands and file edits.`,
    };
  }

  if (mode === "auto") {
    return {
      title: "Approve for me",
      detail: `${providerName} can work without prompts inside the workspace boundary.`,
    };
  }

  return {
    title: "Full access",
    detail: `${providerName} can run commands and apply edits without prompts.`,
  };
}

export function createProviderHealthOutput(
  providerId: string,
  provider?: ModelProviderConfig,
) {
  if (!provider?.enabled) {
    return `${provider?.displayName ?? providerId}: not configured`;
  }

  switch (providerId) {
    case "openai":
      return "codex auth status: authenticated; model probe ok";
    case "anthropic":
      return "claude auth status: authenticated; local credential metadata verified";
    case "kimi":
      return "Kimi Code ACP authenticated; provider-owned token value was not read by Gyro.";
    case "xai":
      return "Grok Build ACP authenticated; provider-owned credentials were not read by Gyro.";
    case "cursor":
      return "cursor-agent: logged in; command available";
    case "gemini":
      return "Gemini CLI ACP authenticated; provider-owned credentials were not read by Gyro.";
    case "opencode":
      return "opencode: local config available";
    case "custom":
      return "custom command failed: executable not found";
    default:
      return `${provider.displayName}: health output inconclusive`;
  }
}

export function createAutomationDraft(
  mode: WorkbenchState["workspaceMode"],
  workspacePath: string,
  provider: ModelProviderConfig,
  details: {
    title: string;
    prompt: string;
    schedule: Automation["schedule"];
    calendar?: import("@gyro-dev/ui").CalendarSchedule;
    stopCondition?: string;
  },
): AutomationDraft {
  const metadata = workspaceRunMetadata(mode, details.title);
  if (mode === "worktree") {
    const suffix = crypto.randomUUID().slice(0, 8);
    metadata.branch = `${metadata.branch}-${suffix}`;
    metadata.worktreeName = `${metadata.worktreeName}-${suffix}`;
  }
  const model = getProviderModel(provider);
  return {
    title: details.title,
    prompt: details.prompt,
    schedule: details.schedule,
    project: workspaceName(workspacePath),
    provider: provider.displayName,
    branch: metadata.branch,
    workspaceMode: metadata.workspaceMode,
    worktreeName: metadata.worktreeName,
    stopCondition: details.stopCondition,
    execution: {
      calendar: details.calendar,
      workspacePath,
      providerId: provider.id,
      providerLabel: provider.displayName,
      modelId: model?.id ?? provider.selectedModelId,
      modelLabel: model?.displayName,
      reasoningEffort: selectedReasoningEffort(provider),
    },
  };
}

export function createPreviewAutomation(draft: AutomationDraft): Automation {
  const now = new Date().toISOString();
  const nextRunDelay =
    draft.schedule === "manual"
      ? 0
      : draft.schedule === "weekly"
        ? 7 * 24 * 60 * 60 * 1000
        : draft.schedule === "daily"
          ? 24 * 60 * 60 * 1000
          : 60 * 60 * 1000;
  return {
    ...draft,
    nextRunAt: nextRunDelay
      ? new Date(Date.now() + nextRunDelay).toISOString()
      : undefined,
    id: `automation-${Date.now()}`,
    status: "current",
    triageState: "none",
    lastResult: "Waiting for first local run",
    unreadResults: 0,
    runHistory: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createOptimisticTurnEvents(
  sessionId: string,
  message: string,
  turnId: string,
  provider?: ModelProviderConfig,
  attachments: ChatAttachment[] = [],
): SessionEvent[] {
  const now = new Date().toISOString();
  return [
    {
      id: `${sessionId}-user-${Date.now()}`,
      sessionId,
      turnId,
      createdAt: now,
      kind: "user-message",
      message,
      payload: { optimistic: true, turnId, attachments },
    },
    {
      id: `${sessionId}-provider-${Date.now()}`,
      sessionId,
      turnId,
      createdAt: now,
      kind: "system-event",
      message: providerStatusMessage("running", provider),
      payload: providerStatusPayload("running", message, turnId, provider),
    },
  ];
}

export type OptimisticProviderStatus = HarnessRunStatus | "ready";

export function providerStatusPayload(
  status: OptimisticProviderStatus,
  userMessage: string,
  turnId: string,
  provider?: ModelProviderConfig,
  error?: string,
) {
  const model = provider ? getProviderModel(provider) : undefined;
  return {
    kind: "provider-status",
    error,
    modelId: model?.id,
    modelLabel: model?.displayName,
    messagePreview: chatMessagePreview(userMessage),
    providerId: provider?.id,
    providerLabel: provider?.displayName ?? "Provider",
    status,
    turnId,
  };
}

// Kept in step with `PROVIDER_STOP_MARKER` in the Tauri crate, which every stop
// message opens with so a stop can be told from a genuine failure.
export const PROVIDER_STOP_MARKER = "chat cancelled by";

export const PROVIDER_SELF_STOP_MARKER = "chat cancelled by Gyro: ";

export function isProviderStop(errorMessage: string) {
  return errorMessage.includes(PROVIDER_STOP_MARKER);
}

// What to tell someone about a turn that stopped. Gyro stops turns of its own
// accord — at the per-call token ceiling, for one — so a stop is not always
// something the person did. Reporting every one of them as "cancelled" and
// nothing further is how a ceiling stop reads as the app breaking for no reason.
export function providerStopDetail(errorMessage: string) {
  const at = errorMessage.indexOf(PROVIDER_SELF_STOP_MARKER);
  if (at < 0) {
    return "The provider process was stopped";
  }
  return `Gyro stopped this turn: ${errorMessage.slice(at + PROVIDER_SELF_STOP_MARKER.length)}`;
}

/** Toast copy for a send that failed or was stopped. The failed turn card in
 * the transcript carries the full error; the toast names the outcome. */
export function providerFailureNotice(
  errorMessage: string,
  wasCancelled: boolean,
  chatPersisted: boolean,
): { title: string; detail: string } {
  if (wasCancelled) {
    return { title: "Turn stopped", detail: providerStopDetail(errorMessage) };
  }
  if (!chatPersisted) {
    return { title: "Message not sent", detail: "Chat stayed local" };
  }
  if (/rate.limit|too many requests|provider cooldown/i.test(errorMessage)) {
    return { title: "Provider rate limit reached", detail: "Open the chat to continue when the provider cooldown ends." };
  }
  const firstLine =
    errorMessage
      .replace(/^(Error:\s*)+/, "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const detail =
    firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine;
  return {
    title: "Message failed",
    detail: detail || "The provider could not complete this turn",
  };
}

/** Temporary request failures do not invalidate a connected provider. */
export function providerFailureBlocksReadiness(error: string): boolean {
  return /unauthori[sz]ed|authentication|invalid api key|not logged in|login required|credential|missing environment variable|insufficient_quota|payment required|balance exhausted|HTTP\s+(?:401|402|403)\b/i.test(error);
}

export function providerStatusMessage(
  status: OptimisticProviderStatus,
  provider?: ModelProviderConfig,
) {
  const providerLabel = provider?.displayName ?? "Provider";
  if (status === "failed") {
    return `${providerLabel} send needs attention`;
  }
  if (status === "blocked") {
    return `${providerLabel} is not available for chat yet`;
  }
  if (status === "cancelled") {
    return `${providerLabel} was cancelled`;
  }
  if (status === "waiting") {
    return `${providerLabel} is waiting`;
  }
  if (status === "done") {
    return `${providerLabel} answered`;
  }
  if (status === "ready") {
    return `${providerLabel} is ready for the next step`;
  }
  if (status === "running") {
    return `${providerLabel} is working`;
  }
  return `${providerLabel} queued this request`;
}

export function rekeySessionEvents(events: SessionEvent[], sessionId: string) {
  return events.map((event) => ({
    ...event,
    id: event.id.replace(event.sessionId, sessionId),
    sessionId,
  }));
}

export function providerStreamBatchKey(sessionId: string, turnId: string) {
  return `${sessionId}:${turnId}`;
}

export function applyProviderChatStreamEvent(
  optimisticEventsRef: { current: Map<string, SessionEvent[]> },
  setEvents: (
    value: SessionEvent[] | ((current: SessionEvent[]) => SessionEvent[]),
  ) => void,
  streamEvent: ProviderChatStreamEvent,
) {
  const turnId = streamEvent.turnId ?? undefined;
  if (!streamEvent.sessionId || !turnId) {
    return;
  }
  // Heartbeats keep a quiet-but-alive run marked running and refresh the status
  // event's timestamp so the idle watchdog does not settle the turn early.
  if (
    streamEvent.phase === "retry-wait" ||
    streamEvent.phase === "retry-started"
  ) {
    const update = (items: SessionEvent[]) =>
      applyNativeProviderRetryStatus(items, streamEvent);
    optimisticEventsRef.current.set(
      streamEvent.sessionId,
      limitOptimisticSessionEvents(
        update(optimisticEventsRef.current.get(streamEvent.sessionId) ?? []),
      ),
    );
    setEvents(update);
    return;
  }
  if (
    streamEvent.phase === "started" ||
    streamEvent.phase === "completed" ||
    streamEvent.phase === "heartbeat"
  ) {
    updateOptimisticProviderStatus(
      optimisticEventsRef,
      setEvents,
      streamEvent.sessionId,
      turnId,
      streamEvent.status ??
        (streamEvent.phase === "completed" ? "done" : "running"),
      undefined,
      streamEvent.phase === "heartbeat",
      undefined,
      streamEvent.quietSeconds ?? undefined,
    );
    return;
  }
  if (streamEvent.phase === "failed" || streamEvent.phase === "cancelled") {
    updateOptimisticProviderStatus(
      optimisticEventsRef,
      setEvents,
      streamEvent.sessionId,
      turnId,
      streamEvent.status ??
        (streamEvent.phase === "cancelled" ? "cancelled" : "failed"),
      streamEvent.error ?? undefined,
      false,
      streamEvent.recoveryKind ?? undefined,
    );
    return;
  }
  const textDelta = streamEvent.textDelta ?? "";
  if (streamEvent.phase !== "delta" || textDelta === "") {
    return;
  }
  const updateEvents = (items: SessionEvent[]) =>
    upsertStreamingAssistantEvent(items, streamEvent, turnId, textDelta);
  optimisticEventsRef.current.set(
    streamEvent.sessionId,
    limitOptimisticSessionEvents(
      updateEvents(
        optimisticEventsRef.current.get(streamEvent.sessionId) ?? [],
      ),
    ),
  );
  setEvents((current) => {
    if (!current.some((event) => event.sessionId === streamEvent.sessionId)) {
      return current;
    }
    return limitSessionEventsForUi(updateEvents(current));
  });
}

export function updateOptimisticProviderStatus(
  optimisticEventsRef: { current: Map<string, SessionEvent[]> },
  setEvents: (
    value: SessionEvent[] | ((current: SessionEvent[]) => SessionEvent[]),
  ) => void,
  sessionId: string,
  turnId: string,
  status: OptimisticProviderStatus,
  error?: string,
  /** Move createdAt forward so idle watches see the run is still alive. */
  touchTimestamp = false,
  recoveryKind?: string,
  quietForSeconds?: number,
) {
  const updateEvents = (items: SessionEvent[]) => {
    const targetIndex = items.findLastIndex(
      (event) => isProviderStatusEvent(event) && event.turnId === turnId,
    );
    if (targetIndex < 0) {
      return items;
    }
    const next = items.slice();
    const target = items[targetIndex];
    if (target) {
      next[targetIndex] = updateEvent(target);
    }
    return next;
  };
  const updateEvent = (event: SessionEvent): SessionEvent => {
    if (!isProviderStatusEvent(event) || event.turnId !== turnId) {
      return event;
    }
    const payload = recordFromUnknown(event.payload);
    const providerLabel =
      stringFromRecord(payload, "providerLabel") ?? "Provider";
    const now = new Date().toISOString();
    const previousStatus = stringFromRecord(payload, "status");
    if (touchTimestamp && payload?.nativeRetry === true) {
      return { ...event, createdAt: now };
    }
    const previousStartedAt = stringFromRecord(payload, "startedAt");
    const isActiveStatus = ["queued", "running", "waiting"].includes(status);
    const wasActiveStatus =
      previousStatus !== undefined &&
      ["queued", "running", "waiting"].includes(previousStatus);
    const startedAt = isActiveStatus
      ? wasActiveStatus
        ? (previousStartedAt ?? event.createdAt)
        : now
      : (previousStartedAt ?? event.createdAt);
    const startedAtMs = Date.parse(startedAt);
    const completedAtMs = Date.parse(now);
    return {
      ...event,
      // Heartbeats only move the timestamp; they do not invent a new status event.
      createdAt: touchTimestamp ? now : event.createdAt,
      message: providerStatusMessage(status, {
        id: stringFromRecord(payload, "providerId") ?? "openai",
        displayName: providerLabel,
      } as ModelProviderConfig),
      payload: {
        ...payload,
        nativeRetry: undefined,
        retryAt: undefined,
        retryAttempt: undefined,
        retryMaxAttempts: undefined,
        recoveryKind:
          recoveryKind ??
          (isActiveStatus || status === "done"
            ? undefined
            : payload?.recoveryKind),
        completedAt: isActiveStatus ? undefined : now,
        durationMs:
          !isActiveStatus &&
          Number.isFinite(startedAtMs) &&
          Number.isFinite(completedAtMs)
            ? Math.max(0, completedAtMs - startedAtMs)
            : undefined,
        error,
        // Every update replaces this, so the note cannot outlive its heartbeat.
        quietForSeconds,
        startedAt,
        status,
      },
    };
  };
  const optimisticEvents = optimisticEventsRef.current.get(sessionId);
  if (optimisticEvents) {
    optimisticEventsRef.current.set(
      sessionId,
      limitOptimisticSessionEvents(updateEvents(optimisticEvents)),
    );
  }
  setEvents((current) => {
    if (!current.some((event) => event.sessionId === sessionId)) {
      return current;
    }
    return limitSessionEventsForUi(updateEvents(current));
  });
}
