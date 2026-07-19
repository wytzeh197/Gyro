import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { OnMount } from "@monaco-editor/react";
import type { FitAddon as FitAddonInstance } from "@xterm/addon-fit";
import type { Terminal as XTermInstance } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  AppChrome,
  CHAT_GRID_MAX_SLOTS,
  CLI_LAUNCH_PRESET_MAX_PANES,
  AutomationsSurface,
  ChatGridSurface,
  ChatSurface,
  CommandPaletteOverlay,
  IdeStatusBar,
  IdeSurface,
  ModelStandardPromptOverlay,
  ProjectRemoveConfirmOverlay,
  ProvidersSurface,
  SettingsSurface,
  TaskBoardSurface,
  TerminalTerminateConfirmOverlay,
  ToolsSurface,
  WorkspaceToolPanel,
  chatGridReducer,
  createInitialChatGridState,
  createInitialWorkbenchState,
  createNotification,
  createTerminalPane,
  isUserSelectedWorkspacePath,
  defaultCommandProfiles,
  getProviderModel,
  isProviderId,
  isProviderExecutable,
  isProviderRuntimeUsable,
  normalizeCliLaunchPreset,
  normalizedChatProjectKey,
  normalizedConfig,
  parseProviderHealthOutput,
  providerAuthStatusAfterHealth,
  providerConnectionStatusFromRuntime,
  providerSupportsUsage,
  providersForConfig,
  persistableChatGridState,
  sanitizeStoredIdeState,
  sanitizeStoredChatGridState,
  selectedReasoningEffort,
  workbenchReducer,
  type AppDestination,
  type Automation,
  type BrowserPreviewCapture,
  type BrowserPreviewDiagnostic,
  type CapabilityActivity,
  type CapabilityApprovalDecision,
  type CapabilityApprovalEvent,
  type CapabilityCallEvent,
  type CapabilityResourceRef,
  type ChatBrowserResource,
  type ChatAttachment,
  type ChatGridState,
  type ChatMode,
  type ChatPaneRef,
  type ChatSidePanelId,
  type CliLaunchPreset,
  type CommandProfile,
  type DebugSessionState,
  type EditorBuffer,
  type EditorRevealTarget,
  type EditorSelection,
  type GyroConfig,
  type GitBranchCatalog,
  type HarnessRunStatus,
  type IdeAssistantAction,
  type IdeAssistantRequest,
  type LanguageServerState,
  type MenuBarOutcome,
  type MenuBarSnapshot,
  type OutputChannel,
  type ModelProviderConfig,
  type NotificationPermissionState,
  type ProviderHealthDetails,
  type ProjectCapabilityPolicy,
  type ProviderId,
  type ProviderUsageState,
  type ProviderHandoff,
  type ProviderChatStreamEvent,
  type ProviderResumeCursor,
  type ReasoningEffort,
  type ProviderSession,
  type ProblemDiagnostic,
  type Session,
  type SessionEvent,
  type SessionGoal,
  type SessionPlan,
  type SessionPlanItem,
  type SessionPlanItemStatus,
  type SessionsLayoutId,
  type SettingsSectionId,
  type SourceControlState,
  type Task,
  type TaskDefinition,
  type TaskStatus,
  type TestTreeItem,
  type TerminalPaneStatus,
  type TerminalPane,
  type TerminalTemplate,
  type UpdateState,
  type WorkbenchPaneTab,
  type WorkbenchState,
  type WorkbenchTurn,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type WorkspaceFileStat,
  type WorkspaceChangedEvent,
  type WorkspacePreparationProgress,
  type WorkspacePreparationSnapshot,
  type WorkspaceSearchQuery,
  type WorkspaceSearchResult,
  type WorkspaceLayoutId,
} from "@gyro-dev/ui";
import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  applyProviderChatStreamDeltas,
  applyProviderChatStreamActivity,
  isProviderStatusEvent,
  limitSessionEventsForUi,
  mergePersistedAndOptimisticEvents,
  mergeProviderResponseEvents,
  orderProviderChatStreamEvent,
  resetStreamingAssistantForRetry,
  type ProviderStreamOrderState,
  upsertStreamingAssistantEvent,
} from "./provider-stream-events";
import { useGyroUpdater } from "./update-controller";
import {
  deriveLatestMenuBarOutcome,
  deriveMenuBarJobs,
  deriveMenuBarSnapshot,
} from "./menu-bar-state";

const MonacoEditor = lazy(() => import("./monaco-editor"));

type AppNotification = {
  kind: "open-session" | "attach-session";
  sessionId: string;
  workspacePath: string;
  workspaceMode?: WorkbenchState["workspaceMode"];
  branch?: string;
  worktreeName?: string;
};

type ProviderApprovalNotificationOpen = {
  sessionId: string;
  approvalId: string;
};

type MenuBarNavigationTarget = {
  kind: "chat" | "automation" | "settings";
  id: string;
};

type ProviderCapabilityResourceEvent = {
  sessionId: string;
  turnId?: string;
  callId: string;
  resource: CapabilityResourceRef;
  data: unknown;
};

type TerminalPaneSnapshot = {
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
};

type LspSessionResult = {
  serverId: string;
  languageId: string;
  command: string;
  status: string;
  message: string;
};

type LspBridgeResponse = {
  status: string;
  result?: unknown;
  error?: unknown;
  messages?: unknown[];
};

type ProviderHealthCheck = {
  providerId: string;
  output: string;
  runtimeStatus: string;
  authOwner: string;
  authCommand?: string | null;
  loginCommand?: string | null;
  accountLabel?: string | null;
  subscriptionLabel?: string | null;
  providerMode?: string | null;
  secretStorage: string;
  privacyNote: string;
  diagnosticsOptIn: boolean;
};

type ProviderChatResponse = {
  activityEvents?: SessionEvent[];
  assistantEvent: SessionEvent;
  resumeCursor?: ProviderResumeCursor | null;
  session?: Session | null;
  sessionTitle?: string | null;
  statusEvent: SessionEvent;
};

type DiagnosticsExportResult = {
  path: string;
};

type ProviderStreamBatch = {
  streamEvent: ProviderChatStreamEvent;
  textDelta: string;
};

type SourceControlLineStats = {
  additions: number;
  deletions: number;
};

type TurnSourceControlBaselines = Record<
  string,
  Record<string, SourceControlLineStats>
>;

type ChatTurnContextSnapshot = {
  mode?: ChatMode;
  goal?: SessionGoal;
  plan?: SessionPlan;
  attachments?: ChatAttachment[];
  sessionModel?: SessionModelSelection;
  requireCommandApproval?: boolean;
  requireFileEditApproval?: boolean;
  fullAccess?: boolean;
  workspacePath?: string;
  preserveDraft?: boolean;
  turnId?: string;
  retryTurnId?: string;
};

type QueuedChatMessage = {
  deliveryAttempts?: number;
  id: string;
  message: string;
  context: ChatTurnContextSnapshot;
  retryAt?: number;
  status: "failed" | "waiting" | "sending";
};

type WorkspaceFileWriteRequest = {
  workspacePath: string;
  path: string;
  content: string;
  expectedHash?: string;
};

type IdeCommandOutput = {
  status: "done" | "failed";
  stdout: string;
  stderr: string;
};

type AutomationDraft = Pick<
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

type ModelStandardPrompt = {
  count: number;
  modelId: string;
  modelLabel: string;
  providerId: ProviderId;
  providerLabel: string;
};

type ModelUsageEntry = {
  count: number;
  snoozeUntil?: number;
  standard?: boolean;
};

type ModelUsageMap = Record<string, ModelUsageEntry>;

type SessionModelSelection = {
  providerId?: ProviderId;
  providerLabel?: string;
  modelId?: string;
  modelLabel?: string;
  reasoningEffort?: ReasoningEffort;
};

type SavedProject = {
  path: string;
  label: string;
  detail: string;
  sessionCount: number;
};

const EMPTY_CONFIG: GyroConfig = {
  automaticUpdateChecks: true,
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
  fullAccess: false,
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

const PREVIEW_WORKSPACE_PATH = "/preview/Gyro";
const WORKBENCH_STORAGE_KEY = "gyro.workbench-state";
const PINNED_SESSIONS_STORAGE_KEY = "gyro.pinned-session-ids";
const REMOVED_PROJECTS_STORAGE_KEY = "gyro.removed-project-paths";
const RECENT_PROJECTS_STORAGE_KEY = "gyro.recent-project-paths";
const PREVIEW_CONFIG_STORAGE_KEY = "gyro.preview-config";
const THEME_STORAGE_KEY = "gyro.theme";
const MODEL_USAGE_STORAGE_KEY = "gyro.model-standard-usage";
const CHAT_DRAFTS_STORAGE_KEY = "gyro.chat-drafts-v1";
const CHAT_ATTACHMENTS_STORAGE_KEY = "gyro.chat-attachments-v1";
const CHAT_GRID_STORAGE_KEY = "gyro.chat-grid-layouts-v1";
const MODEL_STANDARD_PROMPT_THRESHOLD = 3;
const MODEL_STANDARD_PROMPT_SNOOZE_SELECTIONS = 3;
const DEFAULT_TOOL_PANEL_HEIGHT = 280;
const PROVIDER_AUTH_POLL_INTERVAL_MS = 3_000;
const PROVIDER_AUTH_POLL_ATTEMPTS = 40;
const MAX_CHAT_MESSAGE_CHARS = 24_000;
const MAX_QUEUED_CHAT_MESSAGES_PER_SESSION = 8;
const MAX_QUEUED_CHAT_MESSAGES_TOTAL = 24;
const NEW_CHAT_DRAFT_KEY = "new";
const PROVIDER_STREAM_FLUSH_MS = 80;
const WORKBENCH_PERSIST_DEBOUNCE_MS = 500;
const WORKBENCH_PERSIST_IDLE_TIMEOUT_MS = 1_500;
const TERMINAL_POLL_INTERVAL_MS = 1_000;

type BrowserPreviewCheck = {
  reachable: boolean;
  statusCode?: number;
  message: string;
  diagnostics: BrowserPreviewDiagnostic[];
  diagnosticsSupported: boolean;
  diagnosticsCaptured: boolean;
};

type ProviderUsageSnapshot = {
  providerId: ProviderId;
  windows: ProviderUsageState["windows"];
  fetchedAt: string;
};
const TERMINAL_CHAT_BUSY_POLL_INTERVAL_MS = 4_000;
const MAX_PERSISTED_TERMINAL_OUTPUT_CHARS = 8_000;
const MAX_PERSISTED_OUTPUT_CHANNEL_LINES = 100;
const MAX_STORED_WORKBENCH_STATE_CHARS = 2_000_000;
const MAX_STORED_PREVIEW_CONFIG_CHARS = 200_000;
const MAX_STORED_MODEL_USAGE_CHARS = 100_000;
const MAX_PINNED_SESSIONS = 200;
const MAX_REMOVED_PROJECTS = 200;
const MAX_RECENT_PROJECTS = 12;
const AUTOMATION_SCHEDULER_COMMANDS = {
  claimDue: "claim_due_automation",
  completeLease: "complete_automation_lease",
  list: "list_automations",
  listDue: "list_due_automations",
  recoverLeases: "recover_automation_leases",
} as const;
const ACTIVE_TURN_IDLE_MS = 5 * 60 * 1000;

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function modelUsageKey(providerId: ProviderId, modelId: string) {
  return `${providerId}:${modelId}`;
}

function providerLoginProfile(providerId: ProviderId): CommandProfile {
  if (providerId === "anthropic") {
    return {
      args: ["auth", "login"],
      command: "claude",
      displayName: "Anthropic Login",
      id: "anthropic-login",
      workingDirectory: null,
    };
  }
  if (providerId === "cursor") {
    return {
      args: ["login"],
      command: "cursor-agent",
      displayName: "Cursor Login",
      id: "cursor-login",
      workingDirectory: null,
    };
  }
  if (providerId === "opencode") {
    return {
      args: ["auth", "login"],
      command: "opencode",
      displayName: "OpenCode Login",
      id: "opencode-login",
      workingDirectory: null,
    };
  }
  if (providerId === "kimi") {
    return {
      args: ["login"],
      command: "kimi",
      displayName: "Kimi Login",
      id: "kimi-login",
      workingDirectory: null,
    };
  }

  return {
    args: ["login", "--device-auth"],
    command: "codex",
    displayName: "OpenAI Login",
    id: "openai-login",
    workingDirectory: null,
  };
}

function providerLoginCommandText(profile: CommandProfile) {
  return [profile.command, ...profile.args].join(" ");
}

function providerHealthRequest(
  provider: ModelProviderConfig | undefined,
  providerId?: string,
) {
  return {
    apiKeyRef: provider?.apiKeyRef,
    baseUrl: provider?.baseUrl,
    providerId: provider?.id ?? providerId,
  };
}

function providerHealthDetailsFromCheck(
  check: ProviderHealthCheck,
  fallback: ProviderHealthDetails,
): ProviderHealthDetails {
  return {
    ...fallback,
    accountLabel: check.accountLabel ?? fallback.accountLabel,
    authCommand: check.authCommand ?? fallback.authCommand,
    authOwner: check.authOwner as ProviderHealthDetails["authOwner"],
    diagnosticsOptIn: check.diagnosticsOptIn,
    loginCommand: check.loginCommand ?? fallback.loginCommand,
    privacyNote: check.privacyNote,
    providerMode: check.providerMode ?? fallback.providerMode,
    runtimeStatus:
      check.runtimeStatus as ProviderHealthDetails["runtimeStatus"],
    secretStorage: check.secretStorage,
    subscriptionLabel: check.subscriptionLabel ?? fallback.subscriptionLabel,
  };
}

function waitFor(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function loadModelUsageMap(): ModelUsageMap {
  try {
    const stored = readBoundedLocalStorage(
      MODEL_USAGE_STORAGE_KEY,
      MAX_STORED_MODEL_USAGE_CHARS,
    );
    if (!stored) {
      return {};
    }
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return [];
        }
        const entry = value as Partial<ModelUsageEntry>;
        return [
          [
            key,
            {
              count:
                typeof entry.count === "number" && Number.isFinite(entry.count)
                  ? entry.count
                  : 0,
              snoozeUntil:
                typeof entry.snoozeUntil === "number" &&
                Number.isFinite(entry.snoozeUntil)
                  ? entry.snoozeUntil
                  : undefined,
              standard: entry.standard === true,
            },
          ],
        ];
      }),
    );
  } catch {
    return {};
  }
}

function saveModelUsageMap(usage: ModelUsageMap) {
  safeSetLocalStorage(MODEL_USAGE_STORAGE_KEY, JSON.stringify(usage));
}

export function App() {
  const [workbench, dispatchWorkbench] = useReducer(
    workbenchReducer,
    undefined,
    loadInitialWorkbenchState,
  );
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const [sessionEventsById, setSessionEventsById] = useState<
    Record<string, SessionEvent[]>
  >({});
  const [capabilityRunsBySessionId, setCapabilityRunsBySessionId] = useState<
    Record<string, Record<string, CapabilityActivity>>
  >({});
  const [capabilityPoliciesByProject, setCapabilityPoliciesByProject] =
    useState<Record<string, ProjectCapabilityPolicy>>({});
  const [browserResourcesBySessionId, setBrowserResourcesBySessionId] =
    useState<Record<string, ChatBrowserResource>>({});
  const [capabilityResourceDataByCallId, setCapabilityResourceDataByCallId] =
    useState<Record<string, unknown>>({});
  const [chatGrid, dispatchChatGrid] = useReducer(
    chatGridReducer,
    undefined,
    loadChatGridState,
  );
  const events = activeSessionId
    ? (sessionEventsById[activeSessionId] ?? [])
    : [];
  const setEventsForSession = useCallback(
    (
      sessionId: string,
      value: SessionEvent[] | ((current: SessionEvent[]) => SessionEvent[]),
    ) => {
      setSessionEventsById((current) => {
        const previous = current[sessionId] ?? [];
        const next = typeof value === "function" ? value(previous) : value;
        return previous === next ? current : { ...current, [sessionId]: next };
      });
    },
    [],
  );
  const setEvents = useCallback(
    (value: SessionEvent[] | ((current: SessionEvent[]) => SessionEvent[])) => {
      const sessionId = activeSessionIdRef.current;
      if (sessionId) setEventsForSession(sessionId, value);
    },
    [setEventsForSession],
  );
  const eventsRef = useRef<SessionEvent[]>([]);
  const optimisticEventsRef = useRef(new Map<string, SessionEvent[]>());
  const [workspacePath, setWorkspacePath] = useState<string>();
  const [branchCatalog, setBranchCatalog] = useState<GitBranchCatalog>();
  const [isBranchLoading, setIsBranchLoading] = useState(false);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>();
  const [editorRevealTarget, setEditorRevealTarget] =
    useState<EditorRevealTarget>();
  const [selectedFileContent, setSelectedFileContent] =
    useState<WorkspaceFileContent>();
  const [selectedFileError, setSelectedFileError] = useState("");
  const [selectedFileLoadState, setSelectedFileLoadState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [draftResetToken, setDraftResetToken] = useState(0);
  const [chatDrafts, setChatDrafts] = useState<Record<string, string>>(() =>
    loadChatDrafts(),
  );
  const [chatAttachments, setChatAttachments] = useState<
    Record<string, ChatAttachment[]>
  >(() => loadChatAttachments());
  const [chatMessageQueues, setChatMessageQueues] = useState<
    Record<string, QueuedChatMessage[]>
  >({});
  const [pendingNewChatGoal, setPendingNewChatGoal] = useState<SessionGoal>();
  const [isGoalComposerActive, setIsGoalComposerActive] = useState(false);
  const [pendingNewChatMode, setPendingNewChatMode] =
    useState<ChatMode>("normal");
  const [pendingNewChatPlan, setPendingNewChatPlan] = useState<SessionPlan>({
    title: "Plan",
    items: [],
  });
  const [terminalOutput, setTerminalOutput] = useState("");
  const [terminalSourceControlByPane, setTerminalSourceControlByPane] =
    useState<Record<string, SourceControlState>>({});
  const [turnSourceControlBaselines, setTurnSourceControlBaselines] =
    useState<TurnSourceControlBaselines>({});
  const [
    terminalSourceControlLoadingPaneId,
    setTerminalSourceControlLoadingPaneId,
  ] = useState<string>();
  const [config, setConfig] = useState<GyroConfig>(loadPreviewConfig);
  const configRef = useRef(config);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermissionState>("prompt");
  const [isTestingNotification, setIsTestingNotification] = useState(false);
  const [providerUsageByProvider, setProviderUsageByProvider] = useState<
    Partial<Record<ProviderId, ProviderUsageState>>
  >({});
  const configSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const providerUsageRequestRef = useRef(0);
  const providerStreamBatchRef = useRef(new Map<string, ProviderStreamBatch>());
  const providerStreamOrderRef = useRef<ProviderStreamOrderState>(new Map());
  const providerStreamFlushTimerRef = useRef<number>();
  const sessionEventsRequestRef = useRef<Record<string, number>>({});
  const liveCapabilityResourceIdsRef = useRef(new Set<string>());
  const pendingWorkbenchPersistRef = useRef<WorkbenchState>();
  const workbenchPersistTimerRef = useRef<number>();
  const workbenchPersistIdleRef = useRef<number>();
  const selectedTerminalPaneIdRef = useRef(workbench.selectedTerminalPaneId);
  const terminalPanesRef = useRef(workbench.terminalPanes);
  const terminalOutputRevisionRef = useRef<Record<string, number>>({});
  const terminalReadInFlightRef = useRef(new Set<string>());
  const terminalSourceControlRequestRef = useRef<Record<string, number>>({});
  const branchCatalogRequestRef = useRef(0);
  const ideSourceControlRequestRef = useRef(0);
  const ideServicesRequestRef = useRef(0);
  const workspaceSearchRequestRef = useRef(0);
  const workspaceTreeRequestRef = useRef(0);
  const [activeProfileId, setActiveProfileId] = useState("shell");
  const [isLaunchingCliPreset, setIsLaunchingCliPreset] = useState(false);
  const [pinnedSessionIds, setPinnedSessionIds] =
    useState<string[]>(loadPinnedSessionIds);
  const [removedProjectPaths, setRemovedProjectPaths] = useState<string[]>(
    loadRemovedProjectPaths,
  );
  const [recentProjectPaths, setRecentProjectPaths] = useState<string[]>(
    loadRecentProjectPaths,
  );
  const [projectRemoveCandidate, setProjectRemoveCandidate] =
    useState<SavedProject>();
  const [sendingSessionIds, setSendingSessionIds] = useState<string[]>([]);
  const sendingSessionIdsRef = useRef(new Set<string>());
  const [menuBarOutcome, setMenuBarOutcome] = useState<MenuBarOutcome>();
  const [reduceMotion, setReduceMotion] = useState(false);
  const menuBarOutcomeInitializedRef = useRef(false);
  const latestMenuBarOutcomeIdRef = useRef<string>();
  const queuedChatDispatchesRef = useRef(new Set<string>());
  const queuedChatDispatchMessageIdsRef = useRef(new Map<string, string>());
  const persistedChatTurnIdsRef = useRef(new Set<string>());
  const [queueRetryTick, setQueueRetryTick] = useState(0);
  const pendingPaneSendRef = useRef<{
    paneId: string;
    message: string;
  }>();
  const [chatPanelByPaneId, setChatPanelByPaneId] = useState<
    Record<string, ChatSidePanelId | undefined>
  >({});
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [workspacePreparation, setWorkspacePreparation] =
    useState<WorkspacePreparationProgress>();
  const [workspaceWatchMode, setWorkspaceWatchMode] = useState<
    "event" | "polling"
  >("polling");
  const [workspaceChangeGeneration, setWorkspaceChangeGeneration] = useState(0);
  const workspacePreparationRunRef = useRef("");
  const workspacePreparationReadyTimerRef = useRef<number>();
  const openGlobalSearch = useCallback(() => {
    setCommandPaletteQuery("");
    setIsCommandPaletteOpen(true);
  }, []);
  const closeGlobalSearch = useCallback(() => {
    setIsCommandPaletteOpen(false);
    setCommandPaletteQuery("");
  }, []);
  const [planEditorRequest, setPlanEditorRequest] = useState<{
    kind: "goal" | "item";
    token: number;
  }>();
  const planEditorRequestTokenRef = useRef(0);
  const [modelStandardPrompt, setModelStandardPrompt] =
    useState<ModelStandardPrompt>();
  const [terminalTerminateCandidate, setTerminalTerminateCandidate] =
    useState<TerminalPane>();
  const [toolPanelHeight, setToolPanelHeight] = useState(
    DEFAULT_TOOL_PANEL_HEIGHT,
  );
  const [isStartingFirstTurn, setIsStartingFirstTurn] = useState(false);
  const suppressSessionAutoSelectRef = useRef(true);
  const ingestedSessionEventIds = useRef(new Set<string>());
  const refreshedFileActivityKeysRef = useRef(new Set<string>());
  const lastNonSettingsDestinationRef = useRef<AppDestination>("workspace");
  const initialTerminalRestoreModeRef = useRef(workbench.workspaceMode);
  const languageServerIdsRef = useRef<Record<string, string>>({});
  const languageServerOpenedDocsRef = useRef(new Set<string>());

  const activeDestination = workbench.activeDestination;
  const activeWorkspaceLayout = workbench.activeWorkspaceLayout;
  const selectedUsageProviderId = useMemo(() => {
    const providers = providersForConfig(config);
    return (
      workbench.preferences.usageProviderId ??
      providers.find((provider) => provider.authStatus === "connected")?.id ??
      providers[0]?.id
    );
  }, [config, workbench.preferences.usageProviderId]);
  const activeChatPanel: ChatSidePanelId | undefined =
    workbench.preferences.activeChatPanel ??
    (workbench.preferences.chatEnvironmentRailOpen ? "environment" : undefined);
  const commandProfiles =
    config.commandProfiles.length > 0
      ? config.commandProfiles
      : defaultCommandProfiles();
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  );
  const activeCapabilityPolicy =
    capabilityPoliciesByProject[
      normalizeProjectPath(activeSession?.workspacePath ?? workspacePath)
    ];
  const currentChatProjectKey =
    chatGrid.activeProjectKey ??
    normalizedChatProjectKey(activeSession?.workspacePath ?? workspacePath);
  const activeChatLayout = currentChatProjectKey
    ? chatGrid.layouts[currentChatProjectKey]
    : undefined;
  const activeChatPane = activeChatLayout?.slots.find(
    (pane) => pane?.paneId === activeChatLayout.focusedPaneId,
  );
  const persistableWorkbench = useMemo(
    () => persistableWorkbenchState(workbench),
    [
      workbench.activeDestination,
      workbench.activePaneTab,
      workbench.activeWorkspaceLayout,
      workbench.lastSessionsLayout,
      workbench.automations,
      workbench.browserPreview,
      workbench.diffReview,
      workbench.ide,
      workbench.isToolPanelOpen,
      workbench.notifications,
      workbench.onboarding,
      workbench.preferences,
      workbench.providerHandoffs,
      workbench.providerSessions,
      workbench.providerStatuses,
      workbench.selectedAutomationId,
      workbench.selectedProviderSessionId,
      workbench.selectedTaskId,
      workbench.selectedTerminalPaneId,
      workbench.tasks,
      workbench.terminalPanes,
      workbench.terminalTemplate,
      workbench.workspaceMode,
    ],
  );
  configRef.current = config;
  eventsRef.current = events;
  selectedTerminalPaneIdRef.current = workbench.selectedTerminalPaneId;
  terminalPanesRef.current = workbench.terminalPanes;
  const deferredEventsForPlan = useDeferredValue(events);
  const deferredEventsForTurn = deferredEventsForPlan;
  const persistedActiveSessionPlan = useMemo(
    () => deriveSessionPlan(deferredEventsForPlan, activeSessionId),
    [activeSessionId, deferredEventsForPlan],
  );
  const activeSessionPlan = activeSessionId
    ? persistedActiveSessionPlan
    : pendingNewChatPlan;
  const persistedActiveSessionGoal = useMemo(
    () => deriveSessionGoal(deferredEventsForPlan, activeSessionId),
    [activeSessionId, deferredEventsForPlan],
  );
  const persistedActiveChatMode = useMemo(
    () => deriveChatMode(deferredEventsForPlan),
    [deferredEventsForPlan],
  );
  const activeSessionGoal = activeSessionId
    ? persistedActiveSessionGoal
    : pendingNewChatGoal;
  const activeChatMode = activeSessionId
    ? persistedActiveChatMode
    : pendingNewChatMode;
  const activeDraftKey =
    activeChatPane?.kind === "draft"
      ? activeChatPane.draftKey
      : (activeSessionId ?? NEW_CHAT_DRAFT_KEY);
  const activeChatDraft = chatDrafts[activeDraftKey] ?? "";
  const activeChatAttachments = chatAttachments[activeDraftKey] ?? [];
  const activeQueuedChatMessages = activeSessionId
    ? (chatMessageQueues[activeSessionId] ?? [])
    : [];
  useEffect(() => {
    setIsGoalComposerActive(false);
  }, [activeSessionId]);
  const derivedActiveTurn = useMemo(
    () => deriveActiveTurn(deferredEventsForTurn, activeSession?.title),
    [activeSession?.title, deferredEventsForTurn],
  );
  const activeSessionHasTranscriptEvents = useMemo(
    () =>
      events.some(
        (event) =>
          event.kind === "user-message" || event.kind === "assistant-message",
      ),
    [activeSessionId, events],
  );
  const visibleSessions = useMemo(() => {
    const pinned = new Set(pinnedSessionIds);
    return visibleSessionsForProjects(sessions, removedProjectPaths).sort(
      (first, second) => {
        const firstPinned = pinned.has(first.id);
        const secondPinned = pinned.has(second.id);
        if (firstPinned === secondPinned) {
          return 0;
        }
        return firstPinned ? -1 : 1;
      },
    );
  }, [pinnedSessionIds, removedProjectPaths, sessions]);
  useEffect(() => {
    const sessionById = new Map(
      sessions.map((session) => [session.id, session]),
    );
    for (const layout of Object.values(chatGrid.layouts)) {
      if (
        removedProjectPaths.some(
          (path) => normalizedChatProjectKey(path) === layout.projectKey,
        )
      ) {
        dispatchChatGrid({
          type: "clear-project-layout",
          projectKey: layout.projectKey,
        });
        continue;
      }
      for (const pane of layout.slots) {
        const session =
          pane?.kind === "session"
            ? sessionById.get(pane.sessionId)
            : undefined;
        if (
          pane?.kind === "session" &&
          (!session ||
            normalizedChatProjectKey(session.workspacePath) !==
              layout.projectKey)
        ) {
          dispatchChatGrid({
            type: "remove-session-pane",
            sessionId: pane.sessionId,
          });
        }
      }
    }
    const layout = chatGrid.activeProjectKey
      ? chatGrid.layouts[chatGrid.activeProjectKey]
      : undefined;
    if (activeSessionId) {
      const requestedSession = sessionById.get(activeSessionId);
      const requestedPane = layout?.slots.find(
        (pane) =>
          pane?.kind === "session" && pane.sessionId === activeSessionId,
      );
      if (requestedSession && !requestedPane) {
        dispatchChatGrid({
          type: "select-pane",
          projectKey: normalizedChatProjectKey(requestedSession.workspacePath),
          mode: "replace",
          pane: chatPaneForSession(requestedSession),
        });
        return;
      }
    }
    const focusedPane = layout?.slots.find(
      (pane) => pane?.paneId === layout.focusedPaneId,
    );
    if (focusedPane?.kind === "session") {
      const session = sessionById.get(focusedPane.sessionId);
      if (session && activeSessionId !== session.id) {
        activeSessionIdRef.current = session.id;
        setActiveSessionId(session.id);
        setWorkspacePath(session.workspacePath);
      }
    } else if (focusedPane?.kind === "draft" && activeSessionId) {
      activeSessionIdRef.current = undefined;
      setActiveSessionId(undefined);
      setWorkspacePath(focusedPane.workspacePath);
    }
  }, [
    activeSessionId,
    chatGrid.activeProjectKey,
    chatGrid.layouts,
    removedProjectPaths,
    sessions,
  ]);
  const searchableProjects = useMemo(
    () =>
      savedProjectsFromSessions(
        sessions,
        workspacePath,
        removedProjectPaths,
        recentProjectPaths,
      ),
    [recentProjectPaths, removedProjectPaths, sessions, workspacePath],
  );
  const savedProjects = useMemo(
    () => searchableProjects.slice(0, 6),
    [searchableProjects],
  );

  useEffect(() => {
    if (activeDestination !== "settings") {
      lastNonSettingsDestinationRef.current = activeDestination;
    }
  }, [activeDestination]);
  useEffect(() => {
    if (!selectedFile && workbench.ide.activePath) {
      setSelectedFile(workbench.ide.activePath);
    }
  }, [selectedFile, workbench.ide.activePath]);
  const liveTerminalPaneIds = useMemo(
    () =>
      workbench.terminalPanes
        .filter(
          (pane) => pane.status === "running" || pane.status === "waiting",
        )
        .map((pane) => pane.id),
    [workbench.terminalPanes],
  );
  const activeEditorBuffer = workbench.ide.activePath
    ? workbench.ide.buffers[workbench.ide.activePath]
    : undefined;
  const notify = useCallback(
    (
      kind: Parameters<typeof createNotification>[1],
      title: string,
      detail: string,
    ) => {
      dispatchWorkbench({
        type: "add-notification",
        notification: createNotification(
          `note-${Date.now()}`,
          kind,
          title,
          detail,
        ),
      });
    },
    [],
  );
  useEffect(() => {
    if (
      activeDestination !== "settings" ||
      workbench.preferences.lastSettingsSection !== "permissions" ||
      !isTauriRuntime()
    ) {
      return undefined;
    }
    void invoke<NotificationPermissionState>("get_notification_permission")
      .then(setNotificationPermission)
      .catch(() => undefined);
  }, [activeDestination, workbench.preferences.lastSettingsSection]);
  const testSystemNotification = useCallback(async () => {
    if (isTestingNotification) return;
    setIsTestingNotification(true);
    try {
      const permission = isTauriRuntime()
        ? await invoke<NotificationPermissionState>("test_notification")
        : "granted";
      setNotificationPermission(permission);
      if (permission === "granted") {
        notify(
          "terminal",
          "Notification test sent",
          "Gyro can report automation outcomes in the background.",
        );
      } else {
        notify(
          "command-failed",
          "Notifications are blocked",
          "Enable Gyro in macOS System Settings, then test again.",
        );
      }
    } catch (error) {
      notify("command-failed", "Notification test failed", String(error));
    } finally {
      setIsTestingNotification(false);
    }
  }, [isTestingNotification, notify]);
  const refreshProviderUsage = useCallback(
    async (providerId: ProviderId, showFailureNotification = false) => {
      const request = ++providerUsageRequestRef.current;
      setProviderUsageByProvider((current) => ({
        ...current,
        [providerId]: {
          providerId,
          status: "loading",
          windows: current[providerId]?.windows ?? [],
          fetchedAt: current[providerId]?.fetchedAt,
        },
      }));

      if (!providerSupportsUsage(providerId)) {
        setProviderUsageByProvider((current) => ({
          ...current,
          [providerId]: {
            providerId,
            status: "unavailable",
            windows: [],
            error: "This provider does not expose a supported quota source.",
          },
        }));
        return;
      }

      if (!isTauriRuntime()) {
        setProviderUsageByProvider((current) => ({
          ...current,
          [providerId]: {
            providerId,
            status: "unavailable",
            windows: [],
            error: "Live account usage is available in the Gyro desktop app.",
          },
        }));
        return;
      }

      try {
        const snapshot = await invoke<ProviderUsageSnapshot>(
          "get_provider_usage",
          { providerId },
        );
        if (request !== providerUsageRequestRef.current) return;
        setProviderUsageByProvider((current) => ({
          ...current,
          [providerId]: {
            providerId,
            status: snapshot.windows.length > 0 ? "available" : "unavailable",
            windows: snapshot.windows,
            fetchedAt: snapshot.fetchedAt,
            error:
              snapshot.windows.length > 0
                ? undefined
                : "Codex did not report an active rolling usage window.",
          },
        }));
      } catch (error) {
        if (request !== providerUsageRequestRef.current) return;
        const detail = String(error);
        setProviderUsageByProvider((current) => {
          const previous = current[providerId];
          return {
            ...current,
            [providerId]: {
              providerId,
              status: "error",
              windows: previous?.windows ?? [],
              fetchedAt: previous?.fetchedAt,
              stale: Boolean(previous?.windows.length),
              error: detail,
            },
          };
        });
        if (showFailureNotification) {
          notify(
            "command-failed",
            "Provider usage could not be loaded",
            detail,
          );
        }
      }
    },
    [notify],
  );

  useEffect(() => {
    if (
      activeDestination !== "settings" ||
      workbench.preferences.lastSettingsSection !== "usage-limits" ||
      !selectedUsageProviderId
    ) {
      return undefined;
    }
    void refreshProviderUsage(selectedUsageProviderId);
  }, [
    activeDestination,
    refreshProviderUsage,
    selectedUsageProviderId,
    workbench.preferences.lastSettingsSection,
  ]);
  const setSessionSending = useCallback(
    (sessionId: string, isSending: boolean) => {
      if (isSending) {
        sendingSessionIdsRef.current.add(sessionId);
      } else {
        sendingSessionIdsRef.current.delete(sessionId);
      }
      setSendingSessionIds((current) => {
        const hasSession = current.includes(sessionId);
        if (isSending) {
          return hasSession ? current : [...current, sessionId];
        }
        return hasSession ? current.filter((id) => id !== sessionId) : current;
      });
    },
    [],
  );
  const replaceSendingSessionId = useCallback(
    (fromSessionId: string, toSessionId: string) => {
      sendingSessionIdsRef.current.delete(fromSessionId);
      sendingSessionIdsRef.current.add(toSessionId);
      setSendingSessionIds((current) => {
        const next = current.filter((id) => id !== fromSessionId);
        return next.includes(toSessionId) ? next : [...next, toSessionId];
      });
    },
    [],
  );
  const isActiveSessionSending = activeSessionId
    ? sendingSessionIds.includes(activeSessionId)
    : isStartingFirstTurn;
  const latestMenuBarOutcome = useMemo(
    () =>
      deriveLatestMenuBarOutcome(
        sessions,
        sessionEventsById,
        workbench.automations,
      ),
    [sessionEventsById, sessions, workbench.automations],
  );
  const menuBarJobs = useMemo(
    () =>
      deriveMenuBarJobs({
        automations: workbench.automations,
        sendingSessionIds,
        sessionEventsById,
        sessions,
      }),
    [sendingSessionIds, sessionEventsById, sessions, workbench.automations],
  );
  const menuBarSnapshot = useMemo<MenuBarSnapshot>(
    () =>
      deriveMenuBarSnapshot({
        automations: workbench.automations,
        outcome: menuBarOutcome,
        reduceMotion,
        sendingSessionIds,
        sessionEventsById,
        sessions,
        theme: workbench.preferences.theme,
      }),
    [
      menuBarOutcome,
      reduceMotion,
      sendingSessionIds,
      sessionEventsById,
      sessions,
      workbench.automations,
      workbench.preferences.theme,
    ],
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!menuBarOutcomeInitializedRef.current) {
      menuBarOutcomeInitializedRef.current = true;
      latestMenuBarOutcomeIdRef.current = latestMenuBarOutcome?.id;
      return;
    }
    if (
      !latestMenuBarOutcome ||
      latestMenuBarOutcomeIdRef.current === latestMenuBarOutcome.id
    ) {
      return;
    }
    latestMenuBarOutcomeIdRef.current = latestMenuBarOutcome.id;
    setMenuBarOutcome(
      latestMenuBarOutcome.status === "stopped"
        ? undefined
        : latestMenuBarOutcome,
    );
  }, [latestMenuBarOutcome]);

  useEffect(() => {
    if (menuBarOutcome?.status !== "succeeded" || menuBarJobs.length > 0) {
      return undefined;
    }
    const outcomeId = menuBarOutcome.id;
    const timeout = window.setTimeout(() => {
      setMenuBarOutcome((current) =>
        current?.id === outcomeId ? undefined : current,
      );
    }, 3_000);
    return () => window.clearTimeout(timeout);
  }, [menuBarJobs.length, menuBarOutcome]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void invoke("set_menu_bar_snapshot", { snapshot: menuBarSnapshot }).catch(
      () => undefined,
    );
  }, [menuBarSnapshot]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void invoke("set_menu_bar_visible", {
      visible: workbench.preferences.showMenuBarIcon,
    }).catch(() => undefined);
  }, [workbench.preferences.showMenuBarIcon]);
  const terminalPanePollKey = liveTerminalPaneIds.join("\n");
  const selectedTerminalPane = useMemo(
    () =>
      workbench.terminalPanes.find(
        (pane) => pane.id === workbench.selectedTerminalPaneId,
      ) ?? workbench.terminalPanes[0],
    [workbench.selectedTerminalPaneId, workbench.terminalPanes],
  );
  const selectedTerminalSourceControl = selectedTerminalPane
    ? terminalSourceControlByPane[selectedTerminalPane.id]
    : undefined;
  useEffect(() => {
    safeSetLocalStorage(CHAT_DRAFTS_STORAGE_KEY, JSON.stringify(chatDrafts));
  }, [chatDrafts]);
  useEffect(() => {
    safeSetLocalStorage(
      CHAT_ATTACHMENTS_STORAGE_KEY,
      JSON.stringify(chatAttachments),
    );
  }, [chatAttachments]);
  useEffect(() => {
    safeSetLocalStorage(
      CHAT_GRID_STORAGE_KEY,
      JSON.stringify(persistableChatGridState(chatGrid)),
    );
  }, [chatGrid]);

  const resetChatDraft = useCallback(() => {
    const key = activeSessionId ?? NEW_CHAT_DRAFT_KEY;
    setChatDrafts((current) => ({ ...current, [key]: "" }));
    setChatAttachments((current) => ({ ...current, [key]: [] }));
    setDraftResetToken((token) => token + 1);
  }, [activeSessionId]);

  const checkProviderReadiness = useCallback(
    (intent: "chat" | "task" | "handoff", providerId?: string) => {
      dispatchWorkbench({
        type: "set-provider-readiness",
        status: "checking",
        message: "Checking provider availability...",
        providerId,
      });

      const providerConfigs = providersForConfig(config);
      const targetProviderId = providerId ?? config.selectedProviderId;
      const enabledProviders = providerConfigs.filter((provider) =>
        targetProviderId ? provider.id === targetProviderId : provider.enabled,
      );
      const readyProvider = enabledProviders.find((provider) => {
        const health = workbench.providerStatuses.find(
          (status) => status.id === provider.id,
        );
        return (
          isProviderExecutable(provider.id) &&
          isProviderRuntimeUsable(provider, health)
        );
      });

      if (readyProvider) {
        dispatchWorkbench({
          type: "set-provider-readiness",
          status: "ready",
          message: `${readyProvider.displayName} ready for ${intent}`,
          providerId: readyProvider.id,
        });
        return true;
      }

      const targetProvider = targetProviderId
        ? providerLabelForId(
            providerConfigs,
            workbench.providerStatuses,
            targetProviderId,
          )
        : enabledProviders[0]?.displayName;
      const message =
        targetProviderId &&
        (!isProviderId(targetProviderId) ||
          !isProviderExecutable(targetProviderId))
          ? `${targetProvider ?? targetProviderId} is visible for readiness only and cannot execute ${intent} runs`
          : targetProvider
            ? `${targetProvider} is not connected yet`
            : "Enable and connect a provider before sending";

      dispatchWorkbench({
        type: "set-provider-readiness",
        status: "blocked",
        message,
        providerId: targetProviderId,
      });
      dispatchWorkbench({
        type: "select-destination",
        destination: "providers",
      });
      notify("provider", "Provider not ready", message);
      return false;
    },
    [config, notify, workbench.providerStatuses],
  );

  const persistConfig = useCallback(
    async (
      nextConfig: GyroConfig,
      options: { notifySuccess?: boolean } = {},
    ) => {
      const shouldNotifySuccess = options.notifySuccess ?? true;
      const normalizedNextConfig = normalizedConfig(nextConfig);
      configRef.current = normalizedNextConfig;
      setConfig(normalizedNextConfig);
      safeSetLocalStorage(
        PREVIEW_CONFIG_STORAGE_KEY,
        JSON.stringify({
          ...normalizedNextConfig,
          accountSession: { signedIn: false },
        }),
      );
      if (!isTauriRuntime()) {
        if (shouldNotifySuccess) {
          notify(
            "provider",
            "Settings saved locally",
            "Preview config updated",
          );
        }
        return;
      }
      try {
        configSaveQueueRef.current = configSaveQueueRef.current
          .catch(() => undefined)
          .then(() => invoke("save_config", { config: normalizedNextConfig }));
        await configSaveQueueRef.current;
        if (shouldNotifySuccess) {
          notify("provider", "Settings saved", "Configuration persisted");
        }
      } catch {
        notify(
          "command-failed",
          "Settings save failed",
          "Config kept in memory",
        );
      }
    },
    [notify],
  );

  const refreshSessions = useCallback(async () => {
    if (!isTauriRuntime()) {
      setSessions([]);
      return;
    }
    try {
      const nextSessions = await invoke<Session[]>("list_sessions");
      const nextVisibleSessions = visibleSessionsForProjects(
        nextSessions,
        removedProjectPaths,
      );
      setSessions(nextSessions);
      setActiveSessionId((current) => {
        if (current || suppressSessionAutoSelectRef.current) {
          return current;
        }
        return nextVisibleSessions[0]?.id;
      });
      setWorkspacePath(
        (current) => current ?? nextVisibleSessions[0]?.workspacePath,
      );
    } catch {
      setSessions([]);
    }
  }, [removedProjectPaths]);

  const refreshEvents = useCallback(
    async (sessionId: string) => {
      const requestId = (sessionEventsRequestRef.current[sessionId] ?? 0) + 1;
      sessionEventsRequestRef.current[sessionId] = requestId;
      if (!isTauriRuntime()) {
        setEventsForSession(
          sessionId,
          limitSessionEventsForUi(
            optimisticEventsRef.current.get(sessionId) ?? [],
          ),
        );
        return;
      }
      try {
        const nextEvents = await invoke<SessionEvent[]>("read_session_events", {
          sessionId,
        });
        if (sessionEventsRequestRef.current[sessionId] === requestId) {
          // Streaming can continue while the persisted transcript is loading.
          // Read the buffer after the await so late chunks are never overwritten
          // by the older transcript snapshot.
          const latestOptimisticEvents =
            optimisticEventsRef.current.get(sessionId);
          setEventsForSession(
            sessionId,
            limitSessionEventsForUi(
              markInactiveCapabilityResources(
                mergePersistedAndOptimisticEvents(
                  nextEvents,
                  latestOptimisticEvents,
                ),
                liveCapabilityResourceIdsRef.current,
              ),
            ),
          );
        }
      } catch {
        if (sessionEventsRequestRef.current[sessionId] === requestId) {
          const optimisticEvents = optimisticEventsRef.current.get(sessionId);
          if (optimisticEvents && optimisticEvents.length > 0) {
            setEventsForSession(
              sessionId,
              limitSessionEventsForUi(optimisticEvents),
            );
          }
        }
      }
    },
    [setEventsForSession],
  );

  useEffect(() => {
    const layout = chatGrid.activeProjectKey
      ? chatGrid.layouts[chatGrid.activeProjectKey]
      : undefined;
    for (const pane of layout?.slots ?? []) {
      if (pane?.kind === "session") void refreshEvents(pane.sessionId);
    }
  }, [chatGrid.activeProjectKey, chatGrid.layouts, refreshEvents]);

  const flushProviderStreamBatches = useCallback(() => {
    if (providerStreamFlushTimerRef.current !== undefined) {
      window.clearTimeout(providerStreamFlushTimerRef.current);
      providerStreamFlushTimerRef.current = undefined;
    }
    const batches = Array.from(providerStreamBatchRef.current.values());
    providerStreamBatchRef.current.clear();
    startTransition(() => {
      const bySession = new Map<string, ProviderStreamBatch[]>();
      for (const batch of batches) {
        const group = bySession.get(batch.streamEvent.sessionId) ?? [];
        group.push(batch);
        bySession.set(batch.streamEvent.sessionId, group);
      }
      for (const [sessionId, sessionBatches] of bySession) {
        applyProviderChatStreamDeltas(
          optimisticEventsRef,
          (value) => setEventsForSession(sessionId, value),
          sessionBatches.map((batch) => ({
            ...batch.streamEvent,
            textDelta: batch.textDelta,
          })),
        );
      }
    });
  }, [setEventsForSession]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let isMounted = true;
    let unlistenCapability: (() => void) | undefined;
    let unlistenResource: (() => void) | undefined;
    void listen<SessionEvent>("gyro://provider-capability-event", (event) => {
      if (!isMounted) return;
      const capabilityEvent = event.payload;
      const mergeEvent = (items: SessionEvent[]) =>
        limitSessionEventsForUi(
          mergePersistedAndOptimisticEvents(items, [capabilityEvent]),
        );
      optimisticEventsRef.current.set(
        capabilityEvent.sessionId,
        mergeEvent(
          optimisticEventsRef.current.get(capabilityEvent.sessionId) ?? [],
        ),
      );
      setEventsForSession(capabilityEvent.sessionId, (current) =>
        mergeEvent(current),
      );
      const activity = capabilityActivityFromSessionEvent(capabilityEvent);
      if (activity) {
        setCapabilityRunsBySessionId((current) => ({
          ...current,
          [activity.sessionId]: {
            ...(current[activity.sessionId] ?? {}),
            [activity.callId]: activity,
          },
        }));
      }
    }).then((unlisten) => {
      if (!isMounted) unlisten();
      else unlistenCapability = unlisten;
    });
    void listen<ProviderCapabilityResourceEvent>(
      "gyro://provider-capability-resource",
      (event) => {
        if (!isMounted) return;
        const payload = event.payload;
        liveCapabilityResourceIdsRef.current.add(payload.resource.id);
        setCapabilityResourceDataByCallId((current) => ({
          ...current,
          [payload.callId]: payload.data,
        }));
        if (payload.resource.kind === "terminal") {
          const snapshot = terminalSnapshotFromCapabilityData(payload.data);
          if (snapshot) {
            const pane = terminalPaneFromSnapshot(snapshot, "local");
            dispatchWorkbench({
              type: "upsert-background-terminal-pane",
              pane: {
                ...pane,
                owner: {
                  kind: "model",
                  sessionId: payload.sessionId,
                  turnId: payload.turnId,
                  callId: payload.callId,
                },
              },
            });
            terminalOutputRevisionRef.current[snapshot.paneId] =
              snapshot.outputRevision;
          }
        }
        if (payload.resource.kind === "browser") {
          const data = recordFromUnknown(payload.data);
          const capture = recordFromUnknown(data?.capture);
          const session = sessions.find(
            (item) => item.id === payload.sessionId,
          );
          const url = stringFromRecord(data, "url") ?? payload.resource.label;
          if (session && url) {
            setBrowserResourcesBySessionId((current) => ({
              ...current,
              [payload.sessionId]: {
                id: payload.resource.id,
                sessionId: payload.sessionId,
                projectPath: session.workspacePath,
                url,
                status: "completed",
                label: payload.resource.label,
                latestCapturePath: stringFromRecord(capture, "path"),
              },
            }));
          }
        }
      },
    ).then((unlisten) => {
      if (!isMounted) unlisten();
      else unlistenResource = unlisten;
    });
    return () => {
      isMounted = false;
      unlistenCapability?.();
      unlistenResource?.();
    };
  }, [sessions, setEventsForSession]);

  useEffect(() => {
    if (!activeSessionId) return;
    const browser = browserResourcesBySessionId[activeSessionId];
    if (browser && workbench.browserPreview.url !== browser.url) {
      dispatchWorkbench({ type: "set-browser-url", url: browser.url });
    }
    const modelTerminal = workbench.terminalPanes.find(
      (pane) =>
        pane.owner?.kind === "model" &&
        pane.owner.sessionId === activeSessionId,
    );
    if (
      modelTerminal &&
      workbench.activePaneTab === "terminal" &&
      workbench.selectedTerminalPaneId !== modelTerminal.id
    ) {
      dispatchWorkbench({
        type: "select-terminal-pane",
        paneId: modelTerminal.id,
      });
    }
  }, [
    activeSessionId,
    browserResourcesBySessionId,
    workbench.activePaneTab,
    workbench.browserPreview.url,
    workbench.selectedTerminalPaneId,
    workbench.terminalPanes,
  ]);

  const scheduleProviderStreamFlush = useCallback(() => {
    if (providerStreamFlushTimerRef.current !== undefined) {
      return;
    }
    providerStreamFlushTimerRef.current = window.setTimeout(
      flushProviderStreamBatches,
      PROVIDER_STREAM_FLUSH_MS,
    );
  }, [flushProviderStreamBatches]);

  const processProviderChatStreamEvent = useCallback(
    (streamEvent: ProviderChatStreamEvent) => {
      if (
        streamEvent.phase === "started" ||
        streamEvent.phase === "completed" ||
        streamEvent.phase === "failed" ||
        streamEvent.phase === "cancelled"
      ) {
        flushProviderStreamBatches();
        applyProviderChatStreamEvent(
          optimisticEventsRef,
          (value) => setEventsForSession(streamEvent.sessionId, value),
          streamEvent,
        );
        return;
      }
      if (streamEvent.phase === "activity") {
        flushProviderStreamBatches();
        applyProviderChatStreamActivity(
          optimisticEventsRef,
          (value) => setEventsForSession(streamEvent.sessionId, value),
          streamEvent,
        );
        return;
      }
      const turnId = streamEvent.turnId ?? undefined;
      const textDelta = streamEvent.textDelta ?? "";
      if (
        streamEvent.phase !== "delta" ||
        !streamEvent.sessionId ||
        !turnId ||
        textDelta === ""
      ) {
        return;
      }
      const batchKey = providerStreamBatchKey(streamEvent.sessionId, turnId);
      const existing = providerStreamBatchRef.current.get(batchKey);
      providerStreamBatchRef.current.set(batchKey, {
        streamEvent,
        textDelta: `${existing?.textDelta ?? ""}${textDelta}`,
      });
      scheduleProviderStreamFlush();
    },
    [
      flushProviderStreamBatches,
      scheduleProviderStreamFlush,
      setEventsForSession,
    ],
  );

  const queueProviderChatStreamEvent = useCallback(
    (streamEvent: ProviderChatStreamEvent) => {
      const orderedEvents = orderProviderChatStreamEvent(
        providerStreamOrderRef.current,
        streamEvent,
      );
      for (const orderedEvent of orderedEvents) {
        processProviderChatStreamEvent(orderedEvent);
      }
    },
    [processProviderChatStreamEvent],
  );

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let isMounted = true;
    let unlistenProviderChat: (() => void) | undefined;
    void listen<ProviderChatStreamEvent>(
      "gyro://provider-chat-event",
      (event) => {
        if (!isMounted) {
          return;
        }
        queueProviderChatStreamEvent(event.payload);
      },
    ).then((unlisten) => {
      if (!isMounted) {
        unlisten();
        return;
      }
      unlistenProviderChat = unlisten;
    });
    return () => {
      isMounted = false;
      if (providerStreamFlushTimerRef.current !== undefined) {
        window.clearTimeout(providerStreamFlushTimerRef.current);
        providerStreamFlushTimerRef.current = undefined;
      }
      providerStreamBatchRef.current.clear();
      providerStreamOrderRef.current.clear();
      unlistenProviderChat?.();
    };
  }, [flushProviderStreamBatches, queueProviderChatStreamEvent]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let isMounted = true;
    let unlistenProviderApproval: (() => void) | undefined;
    void listen<SessionEvent>("gyro://provider-approval-event", (event) => {
      if (!isMounted) return;
      const approvalEvent = event.payload;
      const sessionId = approvalEvent.sessionId;
      const mergeEvent = (items: SessionEvent[]) =>
        limitSessionEventsForUi(
          mergePersistedAndOptimisticEvents(items, [approvalEvent]),
        );
      optimisticEventsRef.current.set(
        sessionId,
        mergeEvent(optimisticEventsRef.current.get(sessionId) ?? []),
      );
      setEventsForSession(sessionId, (current) => mergeEvent(current));
    }).then((unlisten) => {
      if (!isMounted) {
        unlisten();
        return;
      }
      unlistenProviderApproval = unlisten;
    });
    return () => {
      isMounted = false;
      unlistenProviderApproval?.();
    };
  }, [setEventsForSession]);

  const applyProviderChatResponse = useCallback(
    (sessionId: string, response?: ProviderChatResponse) => {
      const updatedSession = response?.session;
      const responseEvents = [
        ...(response?.activityEvents ?? []),
        response?.statusEvent,
        response?.assistantEvent,
      ].filter((event): event is SessionEvent => Boolean(event));
      if (!updatedSession && responseEvents.length === 0) {
        return;
      }
      if (updatedSession) {
        setSessions((current) =>
          current.map((session) =>
            session.id === updatedSession.id ? updatedSession : session,
          ),
        );
      }
      if (responseEvents.length === 0) {
        return;
      }
      optimisticEventsRef.current.set(
        sessionId,
        mergeProviderResponseEvents(
          optimisticEventsRef.current.get(sessionId) ?? [],
          responseEvents,
        ),
      );
      startTransition(() => {
        setEventsForSession(sessionId, (current) => {
          return limitSessionEventsForUi(
            mergeProviderResponseEvents(current, responseEvents),
          );
        });
      });
    },
    [setEventsForSession],
  );

  const updateSessionTitle = useCallback(
    async (
      sessionId: string,
      title: string,
      options: { notifyFailure?: boolean; notifySuccess?: boolean } = {},
    ) => {
      const nextTitle = normalizeSessionTitleInput(title);
      const session = sessions.find((item) => item.id === sessionId);
      if (!session || !nextTitle || nextTitle === session.title) {
        return;
      }

      setSessions((current) =>
        current.map((item) =>
          item.id === sessionId ? { ...item, title: nextTitle } : item,
        ),
      );

      if (!isTauriRuntime()) {
        if (options.notifySuccess) {
          notify("terminal", "Chat renamed", nextTitle);
        }
        return;
      }

      try {
        const renamed = await invoke<Session>("rename_session", {
          sessionId,
          title: nextTitle,
        });
        setSessions((current) =>
          current.map((item) => (item.id === sessionId ? renamed : item)),
        );
        if (options.notifySuccess) {
          notify("terminal", "Chat renamed", renamed.title);
        }
      } catch {
        setSessions((current) =>
          current.map((item) =>
            item.id === sessionId ? { ...item, title: session.title } : item,
          ),
        );
        if (options.notifyFailure ?? true) {
          notify(
            "command-failed",
            "Rename failed",
            "The chat name was not changed",
          );
        }
      }
    },
    [notify, sessions],
  );

  const refreshAutomations = useCallback(async () => {
    if (!isTauriRuntime()) {
      return;
    }
    try {
      const automations = await invoke<Automation[]>(
        AUTOMATION_SCHEDULER_COMMANDS.list,
      );
      dispatchWorkbench({ type: "set-automations", automations });
    } catch {
      notify(
        "command-failed",
        "Automations unavailable",
        "Local scheduler state was not loaded",
      );
    }
  }, [notify]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let mounted = true;
    let unlistenAutomation: (() => void) | undefined;
    void listen<Automation>("gyro://automation-updated", (event) => {
      if (!mounted) return;
      dispatchWorkbench({
        type: "upsert-automation",
        automation: event.payload,
      });
      void refreshSessions();
    }).then((unlisten) => {
      if (!mounted) {
        unlisten();
        return;
      }
      unlistenAutomation = unlisten;
    });
    return () => {
      mounted = false;
      unlistenAutomation?.();
    };
  }, [refreshSessions]);

  const refreshConfig = useCallback(async () => {
    if (!isTauriRuntime()) {
      setConfig(loadPreviewConfig());
      setActiveProfileId("shell");
      return;
    }
    try {
      const nextConfig = await invoke<GyroConfig>("load_config");
      setConfig(normalizedConfig(nextConfig));
      setActiveProfileId(nextConfig.commandProfiles[0]?.id ?? "shell");
    } catch {
      setConfig(EMPTY_CONFIG);
      setActiveProfileId("shell");
    }
  }, []);

  const selectDestination = useCallback((destination: AppDestination) => {
    dispatchWorkbench({ type: "select-destination", destination });
  }, []);

  const returnFromSettings = useCallback(() => {
    const destination =
      lastNonSettingsDestinationRef.current === "settings"
        ? "workspace"
        : lastNonSettingsDestinationRef.current;
    dispatchWorkbench({ type: "select-destination", destination });
  }, []);

  const selectWorkspaceLayout = useCallback((layout: WorkspaceLayoutId) => {
    dispatchWorkbench({ type: "select-workspace-layout", layout });
  }, []);

  const openToolPanel = useCallback((tab: WorkbenchPaneTab) => {
    setToolPanelHeight((current) =>
      current < DEFAULT_TOOL_PANEL_HEIGHT ? DEFAULT_TOOL_PANEL_HEIGHT : current,
    );
    dispatchWorkbench({ type: "open-tool-panel", tab });
  }, []);

  const toggleChatToolPanel = useCallback(() => {
    if (workbench.isToolPanelOpen) {
      dispatchWorkbench({ type: "close-tool-panel" });
      return;
    }
    openToolPanel(workbench.activePaneTab);
  }, [openToolPanel, workbench.activePaneTab, workbench.isToolPanelOpen]);

  const openSettingsSection = useCallback((section: SettingsSectionId) => {
    dispatchWorkbench({ type: "set-settings-section", section });
    dispatchWorkbench({
      type: "select-destination",
      destination: "settings",
    });
  }, []);

  const refreshIdeSourceControl = useCallback((root?: string) => {
    const requestId = ideSourceControlRequestRef.current + 1;
    ideSourceControlRequestRef.current = requestId;
    if (!root) {
      return;
    }
    if (!isTauriRuntime()) {
      dispatchWorkbench({
        type: "ide-set-source-control",
        sourceControl: {
          provider: "git",
          available: true,
          branch: "preview",
          ahead: 0,
          behind: 0,
          additions: 0,
          deletions: 0,
          statsPartial: false,
          files: [],
        },
      });
      return;
    }

    void invoke<SourceControlState>("git_status", { workspacePath: root })
      .then((sourceControl) => {
        if (ideSourceControlRequestRef.current !== requestId) {
          return;
        }
        dispatchWorkbench({
          type: "ide-set-source-control",
          sourceControl,
        });
      })
      .catch((error) => {
        if (ideSourceControlRequestRef.current !== requestId) {
          return;
        }
        dispatchWorkbench({
          type: "ide-set-source-control",
          sourceControl: {
            provider: "git",
            available: false,
            ahead: 0,
            behind: 0,
            additions: 0,
            deletions: 0,
            statsPartial: false,
            files: [],
            error: String(error),
          },
        });
      });
  }, []);

  const refreshWorkspaceBranches = useCallback(async (root?: string) => {
    const requestId = branchCatalogRequestRef.current + 1;
    branchCatalogRequestRef.current = requestId;
    if (!root) {
      setBranchCatalog(undefined);
      setIsBranchLoading(false);
      return;
    }
    setIsBranchLoading(true);
    if (!isTauriRuntime()) {
      setBranchCatalog({
        available: true,
        current: "main",
        branches: ["main"],
      });
      setIsBranchLoading(false);
      return;
    }
    try {
      const catalog = await invoke<GitBranchCatalog>("git_branches", {
        workspacePath: root,
      });
      if (branchCatalogRequestRef.current === requestId) {
        setBranchCatalog(catalog);
      }
    } catch (error) {
      if (branchCatalogRequestRef.current === requestId) {
        setBranchCatalog({
          available: false,
          branches: [],
          error: String(error),
        });
      }
    } finally {
      if (branchCatalogRequestRef.current === requestId) {
        setIsBranchLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshWorkspaceBranches(
      activeSession?.workspacePath ?? workspacePath,
    );
  }, [activeSession?.workspacePath, refreshWorkspaceBranches, workspacePath]);

  const switchWorkspaceBranch = useCallback(
    async (branch: string) => {
      const root = activeSession?.workspacePath ?? workspacePath;
      if (!root) {
        notify(
          "command-failed",
          "Choose a workspace",
          "Select a Git repository before choosing a branch.",
        );
        return;
      }
      if (workbench.workspaceMode === "worktree") {
        notify(
          "command-failed",
          "Worktree branch is fixed",
          "Start a local chat to switch the shared workspace branch.",
        );
        return;
      }
      if (
        (activeSessionId &&
          sendingSessionIdsRef.current.has(activeSessionId)) ||
        isStartingFirstTurn
      ) {
        notify(
          "command-failed",
          "Branch is busy",
          "Wait for the active turn to finish before switching branches.",
        );
        return;
      }
      setIsBranchLoading(true);
      try {
        const catalog = isTauriRuntime()
          ? await invoke<GitBranchCatalog>("git_checkout_branch", {
              request: { workspacePath: root, branch },
            })
          : { available: true, current: branch, branches: [branch] };
        setBranchCatalog(catalog);
        if (activeSessionId && isTauriRuntime()) {
          await invoke<Session>("set_session_branch", {
            sessionId: activeSessionId,
            branch,
          });
          await refreshSessions();
        }
        refreshIdeSourceControl(root);
        notify("terminal", "Branch switched", branch);
      } catch (error) {
        notify("command-failed", "Could not switch branch", String(error));
        await refreshWorkspaceBranches(root);
      } finally {
        setIsBranchLoading(false);
      }
    },
    [
      activeSession?.workspacePath,
      activeSessionId,
      isStartingFirstTurn,
      notify,
      refreshIdeSourceControl,
      refreshSessions,
      refreshWorkspaceBranches,
      workbench.workspaceMode,
      workspacePath,
    ],
  );

  const refreshIdeServices = useCallback(
    (root?: string) => {
      const requestId = ideServicesRequestRef.current + 1;
      ideServicesRequestRef.current = requestId;
      if (!root) {
        return;
      }
      refreshIdeSourceControl(root);
      if (!isTauriRuntime()) {
        dispatchWorkbench({
          type: "ide-set-tasks",
          tasks: [
            {
              id: "preview:typecheck",
              label: "pnpm typecheck",
              command: "pnpm",
              args: ["typecheck"],
              group: "build",
              status: "idle",
              outputChannelId: "task-preview-typecheck",
            },
          ],
        });
        dispatchWorkbench({
          type: "ide-set-test-tree",
          tests: [
            {
              id: "preview-tests",
              label: "Workspace tests",
              status: "unknown",
              children: [],
            },
          ],
        });
        return;
      }

      void invoke<TaskDefinition[]>("task_discover", { workspacePath: root })
        .then((tasks) => {
          if (ideServicesRequestRef.current === requestId) {
            dispatchWorkbench({ type: "ide-set-tasks", tasks });
          }
        })
        .catch(() => {
          if (ideServicesRequestRef.current === requestId) {
            dispatchWorkbench({ type: "ide-set-tasks", tasks: [] });
          }
        });

      void invoke<TestTreeItem[]>("test_discover", { workspacePath: root })
        .then((tests) => {
          if (ideServicesRequestRef.current === requestId) {
            dispatchWorkbench({ type: "ide-set-test-tree", tests });
          }
        })
        .catch(() => {
          if (ideServicesRequestRef.current === requestId) {
            dispatchWorkbench({ type: "ide-set-test-tree", tests: [] });
          }
        });
    },
    [refreshIdeSourceControl],
  );

  const runWorkspaceSearch = useCallback(
    async (query: WorkspaceSearchQuery) => {
      const requestId = workspaceSearchRequestRef.current + 1;
      workspaceSearchRequestRef.current = requestId;
      const root = activeSession?.workspacePath ?? workspacePath;
      dispatchWorkbench({ type: "ide-set-search-query", query });
      if (!root || !query.query.trim()) {
        dispatchWorkbench({
          type: "ide-set-search-results",
          query,
          results: [],
        });
        return;
      }
      if (!isTauriRuntime()) {
        const results = previewFiles
          .filter(
            (file) => file.kind === "file" && file.path.includes(query.query),
          )
          .slice(0, query.maxResults ?? 200)
          .map((file) => ({
            path: file.path,
            lineNumber: 1,
            line: `Preview match for ${query.query}`,
            ranges: [{ startColumn: 1, endColumn: query.query.length + 1 }],
          }));
        dispatchWorkbench({
          type: "ide-set-search-results",
          query,
          results,
        });
        return;
      }
      try {
        const results = await invoke<WorkspaceSearchResult[]>(
          "search_workspace",
          {
            request: {
              workspacePath: root,
              query: query.query,
              globs: query.globs,
              maxResults: query.maxResults ?? 200,
            },
          },
        );
        if (workspaceSearchRequestRef.current === requestId) {
          dispatchWorkbench({
            type: "ide-set-search-results",
            query,
            results,
          });
        }
      } catch (error) {
        if (workspaceSearchRequestRef.current === requestId) {
          notify("command-failed", "Workspace search failed", String(error));
        }
      }
    },
    [activeSession?.workspacePath, notify, workspacePath],
  );

  const settleWorkspacePreparation = useCallback(
    (progress: WorkspacePreparationProgress) => {
      if (progress.runId !== workspacePreparationRunRef.current) return;
      setWorkspacePreparation(progress);
      if (workspacePreparationReadyTimerRef.current !== undefined) {
        window.clearTimeout(workspacePreparationReadyTimerRef.current);
        workspacePreparationReadyTimerRef.current = undefined;
      }
      if (progress.status === "ready") {
        workspacePreparationReadyTimerRef.current = window.setTimeout(() => {
          if (workspacePreparationRunRef.current === progress.runId) {
            setWorkspacePreparation(undefined);
          }
        }, 1500);
      }
    },
    [],
  );

  const prepareWorkspace = useCallback(
    async (root: string) => {
      const runId =
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `workspace-${Date.now()}`;
      workspacePreparationRunRef.current = runId;
      settleWorkspacePreparation({
        runId,
        workspacePath: root,
        phase: "catalog",
        status: "preparing",
        completedSteps: 0,
        totalSteps: 5,
        message: "Cataloging workspace",
        errors: [],
      });
      if (!isTauriRuntime()) {
        setFiles(previewFiles);
        setWorkspaceWatchMode("polling");
        settleWorkspacePreparation({
          runId,
          workspacePath: root,
          phase: "tests",
          status: "ready",
          completedSteps: 5,
          totalSteps: 5,
          message: "Workspace ready",
          errors: [],
        });
        return;
      }
      try {
        const snapshot = await invoke<WorkspacePreparationSnapshot>(
          "prepare_workspace",
          { request: { workspacePath: root, runId } },
        );
        if (workspacePreparationRunRef.current !== runId) return;
        setFiles(snapshot.files);
        setWorkspaceWatchMode(snapshot.watcherMode);
        setWorkspaceChangeGeneration(snapshot.generation);
        if (snapshot.sourceControl) {
          dispatchWorkbench({
            type: "ide-set-source-control",
            sourceControl: snapshot.sourceControl,
          });
        }
        if (snapshot.branches) setBranchCatalog(snapshot.branches);
        dispatchWorkbench({ type: "ide-set-tasks", tasks: snapshot.tasks });
        dispatchWorkbench({ type: "ide-set-test-tree", tests: snapshot.tests });
        settleWorkspacePreparation(snapshot);
      } catch (error) {
        if (workspacePreparationRunRef.current !== runId) return;
        settleWorkspacePreparation({
          runId,
          workspacePath: root,
          phase: "catalog",
          status: "failed",
          completedSteps: 1,
          totalSteps: 5,
          message: "Workspace preparation failed",
          errors: [{ phase: "catalog", message: String(error) }],
        });
      }
    },
    [settleWorkspacePreparation],
  );

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlistenProgress: (() => void) | undefined;
    let unlistenWorkspace: (() => void) | undefined;
    void listen<WorkspacePreparationProgress>(
      "gyro://workspace-preparation",
      (event) => settleWorkspacePreparation(event.payload),
    ).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenProgress = unlisten;
    });
    void listen<WorkspaceChangedEvent>("gyro://workspace-changed", (event) => {
      const currentRoot = activeSession?.workspacePath ?? workspacePath;
      if (
        normalizeProjectPath(event.payload.workspacePath) !==
        normalizeProjectPath(currentRoot)
      ) {
        return;
      }
      setFiles(event.payload.files);
      setWorkspaceChangeGeneration(event.payload.generation);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenWorkspace = unlisten;
    });
    return () => {
      disposed = true;
      unlistenProgress?.();
      unlistenWorkspace?.();
    };
  }, [activeSession?.workspacePath, settleWorkspacePreparation, workspacePath]);

  useEffect(
    () => () => {
      if (workspacePreparationReadyTimerRef.current !== undefined) {
        window.clearTimeout(workspacePreparationReadyTimerRef.current);
      }
    },
    [],
  );

  const refreshSourceControl = useCallback(() => {
    refreshIdeServices(activeSession?.workspacePath ?? workspacePath);
  }, [activeSession?.workspacePath, refreshIdeServices, workspacePath]);

  useEffect(() => {
    const root = activeSession?.workspacePath ?? workspacePath;
    if (!root || !isTauriRuntime()) return;
    void invoke<ProjectCapabilityPolicy>("get_project_capability_policy", {
      workspacePath: root,
    }).then((policy) => {
      setCapabilityPoliciesByProject((current) => ({
        ...current,
        [normalizeProjectPath(root)]: policy,
      }));
    });
  }, [activeSession?.workspacePath, workspacePath]);

  useEffect(() => {
    const root = activeSession?.workspacePath ?? workspacePath;
    if (!root || !isTauriRuntime()) return;
    void invoke("update_capability_ide_evidence", {
      request: {
        workspacePath: root,
        diagnostics: workbench.ide.diagnostics,
      },
    });
  }, [activeSession?.workspacePath, workbench.ide.diagnostics, workspacePath]);

  const refreshTerminalSourceControl = useCallback(
    async (paneId: string) => {
      const pane = terminalPanesRef.current.find((item) => item.id === paneId);
      const root =
        pane?.workingDirectory ?? activeSession?.workspacePath ?? workspacePath;
      if (!pane || !root) {
        return;
      }
      const requestId =
        (terminalSourceControlRequestRef.current[paneId] ?? 0) + 1;
      terminalSourceControlRequestRef.current[paneId] = requestId;
      setTerminalSourceControlLoadingPaneId(paneId);

      if (!isTauriRuntime()) {
        setTerminalSourceControlByPane((current) => ({
          ...current,
          [paneId]: {
            provider: "git",
            available: true,
            branch: pane.branch || "preview",
            ahead: 0,
            behind: 0,
            additions: 0,
            deletions: 0,
            statsPartial: false,
            files: [],
            repoRoot: root,
            lastCheckedAt: new Date().toISOString(),
          },
        }));
        setTerminalSourceControlLoadingPaneId((current) =>
          current === paneId ? undefined : current,
        );
        return;
      }

      try {
        const sourceControl = await invoke<SourceControlState>("git_status", {
          workspacePath: root,
        });
        if (terminalSourceControlRequestRef.current[paneId] !== requestId) {
          return;
        }
        setTerminalSourceControlByPane((current) => ({
          ...current,
          [paneId]: sourceControl,
        }));
      } catch (error) {
        if (terminalSourceControlRequestRef.current[paneId] !== requestId) {
          return;
        }
        setTerminalSourceControlByPane((current) => ({
          ...current,
          [paneId]: {
            provider: "git",
            available: false,
            ahead: 0,
            behind: 0,
            additions: 0,
            deletions: 0,
            statsPartial: false,
            files: [],
            error: String(error),
          },
        }));
      } finally {
        if (terminalSourceControlRequestRef.current[paneId] === requestId) {
          setTerminalSourceControlLoadingPaneId((current) =>
            current === paneId ? undefined : current,
          );
        }
      }
    },
    [activeSession?.workspacePath, workspacePath],
  );

  const stageSourceControlFile = useCallback(
    async (path: string, staged: boolean) => {
      const root = activeSession?.workspacePath ?? workspacePath;
      if (!root || !isTauriRuntime()) {
        return;
      }
      const command = staged ? "git_unstage" : "git_stage";
      try {
        const sourceControl = await invoke<SourceControlState>(command, {
          request: { workspacePath: root, path },
        });
        dispatchWorkbench({ type: "ide-set-source-control", sourceControl });
      } catch (error) {
        notify("command-failed", "Git action failed", String(error));
      }
    },
    [activeSession?.workspacePath, notify, workspacePath],
  );

  const discardSourceControlFile = useCallback(
    async (path: string) => {
      const root = activeSession?.workspacePath ?? workspacePath;
      if (!root || !isTauriRuntime()) {
        return;
      }
      try {
        const sourceControl = await invoke<SourceControlState>("git_discard", {
          request: { workspacePath: root, path },
        });
        dispatchWorkbench({ type: "ide-set-source-control", sourceControl });
        const workspaceFiles = await invoke<WorkspaceFile[]>(
          "watch_workspace",
          {
            workspacePath: root,
          },
        );
        setFiles(workspaceFiles);
      } catch (error) {
        notify("command-failed", "Discard failed", String(error));
      }
    },
    [activeSession?.workspacePath, notify, workspacePath],
  );

  const runIdeTask = useCallback(
    async (task: TaskDefinition) => {
      const root = activeSession?.workspacePath ?? workspacePath;
      if (!root) {
        notify("command-failed", "Task blocked", "Open a workspace first");
        return;
      }
      const channelId = task.outputChannelId ?? `task-${task.id}`;
      dispatchWorkbench({
        type: "ide-upsert-output-channel",
        channel: {
          id: channelId,
          label: task.label,
          kind: task.group === "test" ? "test" : "task",
          lines: [`$ ${task.command} ${task.args.join(" ")}`],
          updatedAt: new Date().toISOString(),
        } satisfies OutputChannel,
      });
      dispatchWorkbench({
        type: "open-tool-panel",
        tab: "output",
      });
      if (!isTauriRuntime()) {
        dispatchWorkbench({
          type: "ide-append-output",
          channelId,
          lines: ["Preview task completed."],
        });
        return;
      }
      try {
        const output = await invoke<IdeCommandOutput>("task_run", {
          request: {
            workspacePath: root,
            taskId: task.id,
            command: task.command,
            args: task.args,
          },
        });
        dispatchWorkbench({
          type: "ide-append-output",
          channelId,
          lines: [output.stdout, output.stderr].filter(Boolean),
        });
      } catch (error) {
        dispatchWorkbench({
          type: "ide-append-output",
          channelId,
          lines: [String(error)],
        });
      }
    },
    [activeSession?.workspacePath, notify, workspacePath],
  );

  const startIdeDebugSession = useCallback(
    async (command: string) => {
      const root = activeSession?.workspacePath ?? workspacePath;
      if (!root) {
        notify("command-failed", "Debug blocked", "Open a workspace first");
        return;
      }
      const adapter = command.trim().split(/\s+/)[0]?.split(/[\\/]/).pop();
      if (!adapter) {
        return;
      }
      const channelId = "debug-adapter";
      dispatchWorkbench({
        type: "ide-upsert-output-channel",
        channel: {
          id: channelId,
          label: "Debug Adapter",
          kind: "debug",
          lines: [`Initializing ${command}`],
          updatedAt: new Date().toISOString(),
        },
      });
      dispatchWorkbench({ type: "open-tool-panel", tab: "output" });
      if (!isTauriRuntime()) {
        dispatchWorkbench({
          type: "ide-set-debug-session",
          session: {
            id: `debug-preview-${Date.now()}`,
            name: `Debug (${adapter})`,
            adapter,
            status: "configured",
            message: "Preview adapter initialized",
            capabilities: [],
          },
        });
        return;
      }
      try {
        const session = await invoke<DebugSessionState>("debug_start", {
          request: {
            workspacePath: root,
            name: `Debug (${adapter})`,
            adapter,
            command,
            args: [],
          },
        });
        dispatchWorkbench({ type: "ide-set-debug-session", session });
        dispatchWorkbench({
          type: "ide-append-output",
          channelId,
          lines: [
            `${session.name}: ${session.message ?? "adapter ready"}`,
            session.capabilities?.length
              ? `Capabilities: ${session.capabilities.join(", ")}`
              : "No optional capabilities reported",
          ],
        });
      } catch (error) {
        dispatchWorkbench({
          type: "ide-append-output",
          channelId,
          lines: [String(error)],
        });
        notify("command-failed", "Debug adapter unavailable", String(error));
      }
    },
    [activeSession?.workspacePath, notify, workspacePath],
  );

  const sendIdeDebugCommand = useCallback(
    async (session: DebugSessionState, command: string) => {
      const channelId = "debug-adapter";
      if (!isTauriRuntime()) {
        dispatchWorkbench({
          type: "ide-set-debug-session",
          session: {
            ...session,
            status: command === "pause" ? "paused" : "running",
            message: `${command} sent in preview`,
          },
        });
        return;
      }
      try {
        const result = await invoke<Record<string, unknown>>("debug_send", {
          request: {
            sessionId: session.id,
            request: {
              command,
              arguments: ["continue", "pause", "next"].includes(command)
                ? { threadId: 1 }
                : {},
            },
          },
        });
        const response = result.response as
          { success?: boolean; message?: string } | undefined;
        const succeeded = response?.success !== false;
        dispatchWorkbench({
          type: "ide-set-debug-session",
          session: {
            ...session,
            status: succeeded
              ? command === "pause"
                ? "paused"
                : command === "threads"
                  ? session.status
                  : "running"
              : session.status,
            message: succeeded
              ? `${command} completed`
              : (response?.message ?? `${command} was rejected`),
            lastEvent: command,
          },
        });
        dispatchWorkbench({
          type: "ide-append-output",
          channelId,
          lines: [JSON.stringify(result, null, 2)],
        });
      } catch (error) {
        dispatchWorkbench({
          type: "ide-set-debug-session",
          session: { ...session, message: String(error) },
        });
        dispatchWorkbench({
          type: "ide-append-output",
          channelId,
          lines: [String(error)],
        });
      }
    },
    [],
  );

  const stopIdeDebugSession = useCallback(
    async (session: DebugSessionState) => {
      try {
        if (isTauriRuntime()) {
          await invoke("debug_stop", { sessionId: session.id });
        }
        dispatchWorkbench({
          type: "ide-set-debug-session",
          session: {
            ...session,
            status: "stopped",
            message: "Adapter stopped",
          },
        });
      } catch (error) {
        dispatchWorkbench({
          type: "ide-set-debug-session",
          session: { ...session, status: "failed", message: String(error) },
        });
      }
    },
    [],
  );

  const refreshWorkspaceTree = useCallback(async () => {
    const requestId = workspaceTreeRequestRef.current + 1;
    workspaceTreeRequestRef.current = requestId;
    const root = activeSession?.workspacePath ?? workspacePath;
    if (!root) {
      return;
    }
    if (!isTauriRuntime()) {
      setFiles(previewFiles);
      return;
    }
    try {
      const workspaceFiles = await invoke<WorkspaceFile[]>("watch_workspace", {
        workspacePath: root,
      });
      if (workspaceTreeRequestRef.current === requestId) {
        setFiles(workspaceFiles);
      }
    } catch (error) {
      if (workspaceTreeRequestRef.current === requestId) {
        notify("command-failed", "Workspace refresh failed", String(error));
      }
    }
  }, [activeSession?.workspacePath, notify, workspacePath]);

  const createWorkspacePath = useCallback(
    async (kind: "file" | "directory", parentPath?: string) => {
      const root = activeSession?.workspacePath ?? workspacePath;
      if (!root) {
        notify("command-failed", "Create blocked", "Open a workspace first");
        return;
      }
      const entered = window.prompt(
        kind === "directory" ? "New folder path" : "New file path",
        parentPath ? `${parentPath}/` : "",
      );
      const path = entered?.trim().replace(/^\/+/, "");
      if (!path) {
        return;
      }
      if (!isTauriRuntime()) {
        setFiles((current) => [
          ...current.filter((file) => file.path !== path),
          {
            path,
            kind,
            depth: path.split("/").length,
          },
        ]);
        if (kind === "file") {
          setSelectedFile(path);
          dispatchWorkbench({
            type: "ide-upsert-buffer",
            buffer: {
              path,
              content: "",
              savedContent: "",
              sizeBytes: 0,
              truncated: false,
              status: "ready",
              updatedAt: new Date().toISOString(),
            },
          });
        }
        return;
      }
      try {
        await invoke("create_workspace_file", {
          request: { workspacePath: root, path, kind },
        });
        await refreshWorkspaceTree();
        notify(
          "tests-passed",
          kind === "file" ? "File created" : "Folder created",
          path,
        );
        if (kind === "file") {
          setSelectedFile(path);
          dispatchWorkbench({
            type: "ide-open-tab",
            tab: { path, title: workspaceName(path), dirty: false },
          });
        }
      } catch (error) {
        notify("command-failed", "Create failed", String(error));
      }
    },
    [activeSession?.workspacePath, notify, refreshWorkspaceTree, workspacePath],
  );

  const renameWorkspacePath = useCallback(
    async (fromPath: string) => {
      const root = activeSession?.workspacePath ?? workspacePath;
      if (!root || !fromPath) {
        return;
      }
      const affectedEditorPaths = workbench.ide.tabs
        .map((tab) => tab.path)
        .filter((path) => editorPathMatches(path, fromPath));
      if (
        affectedEditorPaths.some(
          (path) => workbench.ide.buffers[path]?.status === "dirty",
        )
      ) {
        notify(
          "command-failed",
          "Rename blocked",
          "Save or revert the file first",
        );
        return;
      }
      const entered = window.prompt("Rename workspace path", fromPath);
      const toPath = entered?.trim().replace(/^\/+/, "");
      if (!toPath || toPath === fromPath) {
        return;
      }
      if (!isTauriRuntime()) {
        setFiles((current) =>
          current.map((file) =>
            file.path === fromPath || file.path.startsWith(`${fromPath}/`)
              ? {
                  ...file,
                  path: `${toPath}${file.path.slice(fromPath.length)}`,
                }
              : file,
          ),
        );
      } else {
        try {
          await invoke("rename_workspace_path", {
            request: { workspacePath: root, fromPath, toPath },
          });
          await refreshWorkspaceTree();
        } catch (error) {
          notify("command-failed", "Rename failed", String(error));
          return;
        }
      }
      dispatchWorkbench({ type: "ide-rename-path", fromPath, toPath });
      disposeEditorModels(affectedEditorPaths);
      if (selectedFile && editorPathMatches(selectedFile, fromPath)) {
        setSelectedFile(renameEditorPath(selectedFile, fromPath, toPath));
      }
      notify("tests-passed", "Path renamed", toPath);
    },
    [
      activeSession?.workspacePath,
      activeSessionGoal,
      activeSessionId,
      activeChatMode,
      notify,
      refreshWorkspaceTree,
      selectedFile,
      workbench.ide.buffers,
      workbench.ide.tabs,
      workspacePath,
    ],
  );

  const deleteWorkspacePath = useCallback(
    async (path: string) => {
      const root = activeSession?.workspacePath ?? workspacePath;
      if (!root || !path) {
        return;
      }
      const affectedEditorPaths = workbench.ide.tabs
        .map((tab) => tab.path)
        .filter((tabPath) => editorPathMatches(tabPath, path));
      const buffer = workbench.ide.buffers[path];
      if (
        affectedEditorPaths.some(
          (editorPath) => workbench.ide.buffers[editorPath]?.status === "dirty",
        )
      ) {
        notify(
          "command-failed",
          "Delete blocked",
          "Save or revert the file first",
        );
        return;
      }
      if (!window.confirm(`Delete ${path}? This cannot be undone in Gyro.`)) {
        return;
      }
      if (!isTauriRuntime()) {
        setFiles((current) =>
          current.filter(
            (file) => file.path !== path && !file.path.startsWith(`${path}/`),
          ),
        );
      } else {
        try {
          await invoke("delete_workspace_path", {
            request: {
              workspacePath: root,
              path,
              expectedHash: buffer?.contentHash,
            },
          });
          await refreshWorkspaceTree();
        } catch (error) {
          notify("command-failed", "Delete failed", String(error));
          return;
        }
      }
      dispatchWorkbench({ type: "ide-delete-path", path });
      disposeEditorModels(affectedEditorPaths);
      if (selectedFile && editorPathMatches(selectedFile, path)) {
        setSelectedFile(undefined);
      }
      notify("tests-passed", "Path deleted", path);
    },
    [
      activeSession?.workspacePath,
      notify,
      refreshWorkspaceTree,
      selectedFile,
      workbench.ide.buffers,
      workbench.ide.tabs,
      workspacePath,
    ],
  );

  const openSourceControlDiffForRoot = useCallback(
    async (root: string, path: string, staged: boolean) => {
      const channelId = `git-diff:${path}`;
      dispatchWorkbench({
        type: "ide-upsert-output-channel",
        channel: {
          id: channelId,
          label: `Diff: ${workspaceName(path)}`,
          kind: "system",
          lines: ["Loading Git diff..."],
          updatedAt: new Date().toISOString(),
        },
      });
      dispatchWorkbench({ type: "ide-select-output-channel", channelId });
      dispatchWorkbench({ type: "open-tool-panel", tab: "output" });
      if (!isTauriRuntime()) {
        dispatchWorkbench({
          type: "ide-upsert-output-channel",
          channel: {
            id: channelId,
            label: `Diff: ${workspaceName(path)}`,
            kind: "system",
            lines: [`Preview diff for ${path}`],
            updatedAt: new Date().toISOString(),
          },
        });
        return;
      }
      try {
        const output = await invoke<IdeCommandOutput>("git_diff", {
          request: { workspacePath: root, path, staged },
        });
        dispatchWorkbench({
          type: "ide-upsert-output-channel",
          channel: {
            id: channelId,
            label: `Diff: ${workspaceName(path)}`,
            kind: "system",
            lines: [output.stdout || output.stderr || "No diff output."],
            updatedAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        notify("command-failed", "Git diff failed", String(error));
      }
    },
    [notify],
  );

  const openSourceControlDiff = useCallback(
    async (path: string, staged: boolean) => {
      const root = activeSession?.workspacePath ?? workspacePath;
      if (root) {
        await openSourceControlDiffForRoot(root, path, staged);
      }
    },
    [activeSession?.workspacePath, openSourceControlDiffForRoot, workspacePath],
  );

  const loadInlineChangeDiff = useCallback(
    async (path: string) => {
      const root = activeSession?.workspacePath ?? workspacePath;
      if (!root) {
        throw new Error("Open a workspace to inspect this change.");
      }
      if (!isTauriRuntime()) {
        return `diff --git a/${path} b/${path}\n@@ Preview @@\n+Inline diff preview for ${path}`;
      }

      const normalizedPath = path.replaceAll("\\", "/");
      const file = workbench.ide.sourceControl.files.find(
        (item) => item.path.replaceAll("\\", "/") === normalizedPath,
      );
      const requests: Array<Promise<IdeCommandOutput>> = [];
      if (file?.staged) {
        requests.push(
          invoke<IdeCommandOutput>("git_diff", {
            request: { workspacePath: root, path, staged: true },
          }),
        );
      }
      requests.push(
        invoke<IdeCommandOutput>("git_diff", {
          request: { workspacePath: root, path, staged: false },
        }),
      );
      const outputs = await Promise.all(requests);
      const diff = outputs
        .map((output) => output.stdout || output.stderr)
        .filter((output) => output.trim())
        .join("\n");
      if (diff) return diff;

      if (file?.state === "untracked" || file?.state === "added") {
        const content = await invoke<WorkspaceFileContent>(
          "read_workspace_file_full",
          { workspacePath: root, path },
        );
        return untrackedWorkspaceFileDiff(path, content);
      }
      return "No changes to display.";
    },
    [
      activeSession?.workspacePath,
      workspacePath,
      workbench.ide.sourceControl.files,
    ],
  );

  const reviewTerminalChanges = useCallback(
    (file?: SourceControlState["files"][number]) => {
      if (!selectedTerminalSourceControl?.available) {
        return;
      }
      dispatchWorkbench({
        type: "ide-set-source-control",
        sourceControl: selectedTerminalSourceControl,
      });
      dispatchWorkbench({ type: "ide-select-view", view: "source-control" });
      dispatchWorkbench({ type: "select-workspace-layout", layout: "code" });
      if (file && selectedTerminalSourceControl.repoRoot) {
        void openSourceControlDiffForRoot(
          selectedTerminalSourceControl.repoRoot,
          file.path,
          file.staged,
        );
      }
    },
    [openSourceControlDiffForRoot, selectedTerminalSourceControl],
  );

  const commitSourceControl = useCallback(
    async (message: string) => {
      const root = activeSession?.workspacePath ?? workspacePath;
      if (!root || !message.trim()) {
        return;
      }
      if (!isTauriRuntime()) {
        notify("tests-passed", "Commit created", message);
        return;
      }
      try {
        const output = await invoke<IdeCommandOutput>("git_commit", {
          request: { workspacePath: root, message: message.trim() },
        });
        dispatchWorkbench({
          type: "ide-upsert-output-channel",
          channel: {
            id: "git",
            label: "Git",
            kind: "system",
            lines: [output.stdout, output.stderr].filter(Boolean),
            updatedAt: new Date().toISOString(),
          },
        });
        refreshIdeServices(root);
        notify("tests-passed", "Commit created", message.trim());
      } catch (error) {
        notify("command-failed", "Commit failed", String(error));
      }
    },
    [activeSession?.workspacePath, notify, refreshIdeServices, workspacePath],
  );

  const activateWorkspacePath = useCallback(
    async (selected: string, notificationTitle = "Workspace opened") => {
      const normalizedSelected = normalizeProjectPath(selected);
      setRemovedProjectPaths((current) =>
        current.filter((path) => path !== normalizedSelected),
      );
      setRecentProjectPaths((current) =>
        [
          normalizedSelected,
          ...current.filter((path) => path !== normalizedSelected),
        ]
          .filter(Boolean)
          .slice(0, MAX_RECENT_PROJECTS),
      );
      if (!isTauriRuntime()) {
        setWorkspacePath(selected);
        setFiles(previewFiles);
        refreshIdeServices(selected);
        dispatchWorkbench({
          type: "complete-onboarding-step",
          step: "workspace",
        });
        notify("terminal", notificationTitle, "Preview workspace is active");
        return;
      }

      setWorkspacePath(selected);
      setFiles([]);
      dispatchWorkbench({
        type: "complete-onboarding-step",
        step: "workspace",
      });
      notify("terminal", notificationTitle, workspaceName(selected));
      await prepareWorkspace(selected);
    },
    [notify, prepareWorkspace, refreshIdeServices],
  );

  const openWorkspace = useCallback(async (): Promise<boolean> => {
    if (!isTauriRuntime()) {
      await activateWorkspacePath(PREVIEW_WORKSPACE_PATH);
      return true;
    }
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open workspace",
      });
      if (typeof selected !== "string") {
        return false;
      }
      await activateWorkspacePath(selected);
      return true;
    } catch {
      notify(
        "command-failed",
        "Workspace open failed",
        "The current chat was left unchanged.",
      );
      return false;
    }
  }, [activateWorkspacePath, notify]);

  const selectContextFile = useCallback(async () => {
    if (!isTauriRuntime()) {
      const previewFile = previewFiles[0]?.path ?? "apps/desktop/src/App.tsx";
      setWorkspacePath(PREVIEW_WORKSPACE_PATH);
      setFiles(previewFiles);
      setSelectedFile(previewFile);
      refreshIdeServices(PREVIEW_WORKSPACE_PATH);
      dispatchWorkbench({
        type: "ide-open-tab",
        tab: {
          path: previewFile,
          title: workspaceName(previewFile),
          dirty: false,
        },
      });
      dispatchWorkbench({
        type: "complete-onboarding-step",
        step: "workspace",
      });
      notify("terminal", "File selected", previewFile);
      return;
    }

    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: "Select file",
      });
      if (typeof selected !== "string") {
        return;
      }

      const workspace = parentDirectory(selected);
      const relativePath = relativeFilePath(selected, workspace);
      setRemovedProjectPaths((current) =>
        current.filter((path) => path !== normalizeProjectPath(workspace)),
      );
      setWorkspacePath(workspace);
      setSelectedFile(relativePath);
      refreshIdeServices(workspace);
      setFiles((current) =>
        current.some((file) => file.path === relativePath)
          ? current
          : [{ path: relativePath, kind: "file" }, ...current],
      );
      dispatchWorkbench({
        type: "complete-onboarding-step",
        step: "workspace",
      });
      dispatchWorkbench({
        type: "ide-open-tab",
        tab: {
          path: relativePath,
          title: workspaceName(relativePath),
          dirty: false,
        },
      });

      invoke<WorkspaceFile[]>("list_workspace_tree", {
        depth: 5,
        workspacePath: workspace,
      })
        .then((workspaceFiles) => {
          setFiles((current) => {
            if (workspaceFiles.some((file) => file.path === relativePath)) {
              return workspaceFiles;
            }
            const selectedFile = current.find(
              (file) => file.path === relativePath,
            ) ?? { path: relativePath, kind: "file" as const };
            return [selectedFile, ...workspaceFiles];
          });
        })
        .catch(() => undefined);

      notify("terminal", "File selected", relativePath);
    } catch {
      notify("command-failed", "File select failed", "No file was selected");
    }
  }, [notify, refreshIdeServices]);

  const createSession = useCallback(async () => {
    const sessionLayout: WorkspaceLayoutId = "thread";
    dispatchWorkbench({
      type: "select-workspace-layout",
      layout: sessionLayout,
    });
    dispatchWorkbench({ type: "close-tool-panel" });
    suppressSessionAutoSelectRef.current = false;
    if (!isTauriRuntime()) {
      const session = createPreviewSession(
        sessionLayout,
        workbench.workspaceMode,
        selectedSessionModelFromConfig(config),
        workspacePath ?? "",
        "New chat",
      );
      setWorkspacePath(session.workspacePath);
      setFiles([]);
      setSessions((current) => [session, ...current]);
      activeSessionIdRef.current = session.id;
      setActiveSessionId(session.id);
      setEventsForSession(session.id, []);
      dispatchWorkbench({
        type: "complete-onboarding-step",
        step: "first-session",
      });
      notify("terminal", "Session created", session.title);
      return;
    }
    try {
      const workspace = workspacePath ?? "";
      const shouldCreateWorktree =
        workbench.workspaceMode === "worktree" && workspace.length > 0;
      const title = "New chat";
      const metadata = workspaceRunMetadata(
        shouldCreateWorktree ? "worktree" : "local",
        `${title}-${Date.now()}`,
      );
      const session = shouldCreateWorktree
        ? await invoke<Session>("create_worktree_session", {
            branch: metadata.branch,
            ...selectedSessionModelFromConfig(config),
            title,
            worktreeName: metadata.worktreeName,
            workspacePath: workspace,
          })
        : await invoke<Session>("create_desktop_session", {
            ...selectedSessionModelFromConfig(config),
            title,
            workspacePath: workspace,
          });
      setWorkspacePath(session.workspacePath);
      await refreshSessions();
      setActiveSessionId(session.id);
      dispatchWorkbench({
        type: "complete-onboarding-step",
        step: "first-session",
      });
      notify("terminal", "Session created", session.title);
    } catch {
      const session = createPreviewSession(
        sessionLayout,
        workbench.workspaceMode,
        selectedSessionModelFromConfig(config),
        workspacePath ?? "",
        "New chat",
      );
      setWorkspacePath(session.workspacePath);
      setFiles([]);
      setSessions((current) => [session, ...current]);
      activeSessionIdRef.current = session.id;
      setActiveSessionId(session.id);
      setEventsForSession(session.id, []);
      notify("command-failed", "Session fallback", "Created preview session");
    }
  }, [
    config,
    notify,
    refreshSessions,
    setEventsForSession,
    workbench.workspaceMode,
    workspacePath,
  ]);

  const startNewChat = useCallback(() => {
    suppressSessionAutoSelectRef.current = true;
    const projectPath = activeSession?.workspacePath ?? workspacePath;
    const projectKey = normalizedChatProjectKey(projectPath);
    const draftKey = projectKey ? `new:${projectKey}` : NEW_CHAT_DRAFT_KEY;
    const hasExistingDraft = Object.values(chatGrid.layouts).some((layout) =>
      layout.slots.some(
        (pane) => pane?.kind === "draft" && pane.draftKey === draftKey,
      ),
    );
    if (projectKey && projectPath) {
      dispatchChatGrid({
        type: "select-pane",
        projectKey,
        mode: "replace",
        pane: {
          paneId: `draft:${projectKey}`,
          kind: "draft",
          draftKey,
          workspacePath: projectPath,
        },
      });
    }
    setIsStartingFirstTurn(false);
    activeSessionIdRef.current = undefined;
    setActiveSessionId(undefined);
    setChatDrafts((current) => ({
      ...current,
      ...(activeSessionId ? { [activeSessionId]: "" } : {}),
      ...(hasExistingDraft ? {} : { [draftKey]: "" }),
    }));
    setChatAttachments((current) => ({
      ...current,
      ...(activeSessionId ? { [activeSessionId]: [] } : {}),
      ...(hasExistingDraft ? {} : { [draftKey]: [] }),
    }));
    setDraftResetToken((token) => token + 1);
    dispatchWorkbench({ type: "set-workbench-mode", mode: "local" });
    dispatchWorkbench({ type: "select-workspace-layout", layout: "thread" });
    dispatchWorkbench({ type: "close-tool-panel" });
  }, [
    activeSession?.workspacePath,
    activeSessionId,
    chatGrid.layouts,
    workspacePath,
  ]);

  const selectSession = useCallback(
    (sessionId: string) => {
      suppressSessionAutoSelectRef.current = false;
      const session = sessions.find((item) => item.id === sessionId);
      if (session) {
        dispatchChatGrid({
          type: "select-pane",
          projectKey: normalizedChatProjectKey(session.workspacePath),
          mode: "replace",
          pane: chatPaneForSession(session),
        });
        setWorkspacePath(session.workspacePath);
      }
      setActiveSessionId(sessionId);
      dispatchWorkbench({ type: "set-chat-panel" });
      dispatchWorkbench({ type: "select-workspace-layout", layout: "thread" });
    },
    [sessions],
  );

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let mounted = true;
    let unlistenNavigation: (() => void) | undefined;
    void listen<MenuBarNavigationTarget>(
      "gyro://menu-bar-navigation",
      (event) => {
        if (!mounted) return;
        const target = event.payload;
        if (target.kind === "chat") {
          dispatchWorkbench({
            type: "select-destination",
            destination: "workspace",
          });
          selectSession(target.id);
          void refreshEvents(target.id);
          return;
        }
        if (target.kind === "automation") {
          dispatchWorkbench({
            type: "select-automation",
            automationId: target.id,
          });
          return;
        }
        dispatchWorkbench({
          type: "select-destination",
          destination: "settings",
        });
        dispatchWorkbench({
          type: "set-settings-section",
          section: "general",
        });
      },
    ).then((unlisten) => {
      if (!mounted) unlisten();
      else unlistenNavigation = unlisten;
    });
    return () => {
      mounted = false;
      unlistenNavigation?.();
    };
  }, [refreshEvents, selectSession]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let isMounted = true;
    let unlistenApprovalNotification: (() => void) | undefined;
    void listen<ProviderApprovalNotificationOpen>(
      "gyro://provider-approval-notification-open",
      (event) => {
        if (!isMounted || !event.payload.sessionId) return;
        selectSession(event.payload.sessionId);
        void refreshEvents(event.payload.sessionId);
      },
    ).then((unlisten) => {
      if (!isMounted) {
        unlisten();
        return;
      }
      unlistenApprovalNotification = unlisten;
    });
    return () => {
      isMounted = false;
      unlistenApprovalNotification?.();
    };
  }, [refreshEvents, selectSession]);

  const focusChatPane = useCallback(
    (pane: ChatPaneRef) => {
      const projectKey = normalizedChatProjectKey(pane.workspacePath);
      dispatchChatGrid({ type: "focus-pane", projectKey, paneId: pane.paneId });
      setWorkspacePath(pane.workspacePath);
      if (pane.kind === "session") {
        suppressSessionAutoSelectRef.current = false;
        activeSessionIdRef.current = pane.sessionId;
        setActiveSessionId(pane.sessionId);
        void refreshEvents(pane.sessionId);
      } else {
        suppressSessionAutoSelectRef.current = true;
        activeSessionIdRef.current = undefined;
        setActiveSessionId(undefined);
      }
    },
    [refreshEvents],
  );

  const addSessionToChatGrid = useCallback(
    (sessionId: string) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return;
      const projectKey = normalizedChatProjectKey(session.workspacePath);
      const layout = chatGrid.layouts[projectKey];
      const existingPane = layout?.slots.find(
        (pane) => pane?.kind === "session" && pane.sessionId === sessionId,
      );
      if (existingPane) {
        focusChatPane(existingPane);
        return;
      }
      const targetSlot = layout?.slots.findIndex((pane) => pane === null) ?? 0;
      if (targetSlot < 0) {
        notify(
          "command-failed",
          "Chat grid is full",
          "Close or replace a pane before adding a fifth chat.",
        );
        return;
      }
      dispatchChatGrid({
        type: "select-pane",
        projectKey,
        mode: "replace",
        slotIndex: targetSlot,
        pane: chatPaneForSession(session),
      });
      setWorkspacePath(session.workspacePath);
      setActiveSessionId(sessionId);
      dispatchWorkbench({ type: "set-chat-panel" });
      dispatchWorkbench({ type: "select-workspace-layout", layout: "thread" });
    },
    [chatGrid.layouts, focusChatPane, notify, sessions],
  );

  const pinSession = useCallback(
    (sessionId: string) => {
      const isPinned = pinnedSessionIds.includes(sessionId);
      const session = sessions.find((item) => item.id === sessionId);
      setPinnedSessionIds((current) =>
        current.includes(sessionId)
          ? current.filter((id) => id !== sessionId)
          : [sessionId, ...current].slice(0, MAX_PINNED_SESSIONS),
      );
      notify(
        "terminal",
        isPinned ? "Chat unpinned" : "Chat pinned",
        session?.title ?? sessionId,
      );
    },
    [notify, pinnedSessionIds, sessions],
  );

  const renameSession = useCallback(
    async (sessionId: string) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) {
        return;
      }
      const nextTitle = window.prompt("Rename chat", session.title)?.trim();
      if (!nextTitle || nextTitle === session.title) {
        return;
      }

      await updateSessionTitle(sessionId, nextTitle, { notifySuccess: true });
    },
    [sessions, updateSessionTitle],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      const session = sessions.find((item) => item.id === sessionId);
      const nextSessions = sessions.filter((item) => item.id !== sessionId);
      if (isTauriRuntime()) {
        try {
          const deleted = await invoke<boolean>("delete_session", {
            sessionId,
          });
          if (!deleted) {
            notify("command-failed", "Delete failed", "The chat was not found");
            return;
          }
        } catch {
          notify("command-failed", "Delete failed", "The chat was not removed");
          return;
        }
      }

      setSessions(nextSessions);
      dispatchChatGrid({ type: "remove-session-pane", sessionId });
      for (const pane of workbench.terminalPanes) {
        if (
          pane.owner?.kind === "model" &&
          pane.owner.sessionId === sessionId
        ) {
          dispatchWorkbench({ type: "remove-terminal-pane", paneId: pane.id });
        }
      }
      for (const activity of Object.values(
        capabilityRunsBySessionId[sessionId] ?? {},
      )) {
        if (activity.resource) {
          liveCapabilityResourceIdsRef.current.delete(activity.resource.id);
        }
      }
      setCapabilityRunsBySessionId((current) => {
        if (!current[sessionId]) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      setBrowserResourcesBySessionId((current) => {
        if (!current[sessionId]) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      setSessionEventsById((current) => {
        if (!current[sessionId]) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      setPinnedSessionIds((current) =>
        current.filter((id) => id !== sessionId),
      );
      setChatMessageQueues((current) => {
        if (!current[sessionId]) {
          return current;
        }
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      if (activeSessionId === sessionId) {
        activeSessionIdRef.current = undefined;
        setActiveSessionId(undefined);
      }
      notify("terminal", "Chat deleted", session?.title ?? sessionId);
    },
    [
      activeSessionId,
      capabilityRunsBySessionId,
      notify,
      sessions,
      workbench.terminalPanes,
    ],
  );

  const requestRemoveProject = useCallback(
    (project: { path: string; label: string }) => {
      const projectPath = normalizeProjectPath(project.path);
      if (!projectPath) {
        return;
      }
      const sessionCount = sessions.filter(
        (session) =>
          normalizeProjectPath(session.workspacePath) === projectPath,
      ).length;
      setProjectRemoveCandidate({
        path: projectPath,
        label: project.label || workspaceName(projectPath),
        detail: projectPath,
        sessionCount,
      });
    },
    [sessions],
  );

  const confirmRemoveProject = useCallback(() => {
    if (!projectRemoveCandidate) {
      return;
    }
    const projectPath = normalizeProjectPath(projectRemoveCandidate.path);
    if (!projectPath) {
      setProjectRemoveCandidate(undefined);
      return;
    }

    const projectSessionIds = new Set(
      sessions
        .filter(
          (session) =>
            normalizeProjectPath(session.workspacePath) === projectPath,
        )
        .map((session) => session.id),
    );
    const nextRemovedProjectPaths = removedProjectPaths.includes(projectPath)
      ? removedProjectPaths
      : [projectPath, ...removedProjectPaths].slice(0, MAX_REMOVED_PROJECTS);
    const nextVisibleSessions = visibleSessionsForProjects(
      sessions,
      nextRemovedProjectPaths,
    );
    const activeProjectPath = normalizeProjectPath(
      activeSession?.workspacePath ?? workspacePath,
    );

    setRemovedProjectPaths(nextRemovedProjectPaths);
    dispatchChatGrid({
      type: "clear-project-layout",
      projectKey: normalizedChatProjectKey(projectPath),
    });
    setRecentProjectPaths((current) =>
      current.filter((path) => normalizeProjectPath(path) !== projectPath),
    );
    setPinnedSessionIds((current) =>
      current.filter((sessionId) => !projectSessionIds.has(sessionId)),
    );
    for (const sessionId of projectSessionIds) {
      optimisticEventsRef.current.delete(sessionId);
    }
    setSessionEventsById((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([sessionId]) => !projectSessionIds.has(sessionId),
        ),
      ),
    );

    if (
      activeProjectPath === projectPath ||
      (activeSessionId && projectSessionIds.has(activeSessionId))
    ) {
      const nextSession = nextVisibleSessions[0];
      setActiveSessionId(nextSession?.id);
      setWorkspacePath(nextSession?.workspacePath);
      setFiles([]);
      setSelectedFile(undefined);
      setSelectedFileContent(undefined);
      dispatchWorkbench({
        type: "select-workspace-layout",
        layout: "thread",
      });
    }

    notify(
      "terminal",
      "Project removed from Gyro app",
      projectRemoveCandidate.label,
    );
    setProjectRemoveCandidate(undefined);
  }, [
    activeSession?.workspacePath,
    activeSessionId,
    notify,
    projectRemoveCandidate,
    removedProjectPaths,
    sessions,
    workspacePath,
  ]);

  const launchTerminalPane = useCallback(
    async ({
      commandOverride,
      paneId = `pane-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      profile,
      startingOutput = "",
      template,
      workspacePathOverride,
    }: {
      commandOverride?: string;
      paneId?: string;
      profile: CommandProfile;
      startingOutput?: string;
      template?: TerminalTemplate;
      workspacePathOverride?: string;
    }) => {
      const process = terminalProcessForProfile(profile, commandOverride);
      const existingPane = workbench.terminalPanes.find(
        (pane) => pane.id === paneId,
      );
      const selectedPane = workbench.terminalPanes.find(
        (pane) => pane.id === workbench.selectedTerminalPaneId,
      );
      const launchWorkspacePath =
        workspacePathOverride ??
        existingPane?.projectPath ??
        selectedPane?.projectPath ??
        activeSession?.workspacePath ??
        workspacePath ??
        savedProjects[0]?.path;
      const paneExists = Boolean(existingPane);
      if (!paneExists) {
        const pane = createTerminalPane(paneId, profile, "running", {
          ...workspaceRunMetadata(
            "local",
            profile.displayName,
            launchWorkspacePath,
          ),
          projectPath: launchWorkspacePath,
        });
        if (template) {
          dispatchWorkbench({ type: "split-terminal-pane", pane, template });
        } else {
          dispatchWorkbench({ type: "add-terminal-pane", pane });
        }
      }
      dispatchWorkbench({
        type: "run-terminal-pane",
        paneId,
        profileId: profile.id,
        command: process.displayCommand,
        output: startingOutput,
      });
      setTerminalOutput(startingOutput);

      if (profile.readiness === "blocked") {
        dispatchWorkbench({
          type: "set-terminal-pane-status",
          paneId,
          status: "failed",
          event: "profile blocked",
        });
        return false;
      }

      if (!isTauriRuntime()) {
        notify("approval", "Command waiting", profile.displayName);
        return true;
      }

      try {
        const size = template ? terminalSizeForTemplate(template) : undefined;
        const snapshot = await invoke<TerminalPaneSnapshot>(
          "create_terminal_pane",
          {
            request: {
              args: process.args,
              cols: size?.cols,
              command: process.command,
              paneId,
              profileId: profile.id,
              rows: size?.rows,
              title: profile.displayName,
              workspacePath: launchWorkspacePath,
              workspaceMode: "local",
              workingDirectory: launchWorkspacePath
                ? "Workspace"
                : profile.workingDirectory,
            },
          },
        );
        const status = terminalStatusFromSnapshot(snapshot.status);
        dispatchWorkbench({
          type: "sync-terminal-pane-snapshot",
          paneId: snapshot.paneId,
          command: snapshot.command,
          projectPath: snapshot.workspacePath ?? launchWorkspacePath,
          workingDirectory: snapshot.workingDirectory,
          event:
            snapshot.exitCode === null || snapshot.exitCode === undefined
              ? snapshot.status
              : `${snapshot.status} (${snapshot.exitCode})`,
          output: snapshot.output ?? "",
          status,
          hasForegroundJob: snapshot.hasForegroundJob ?? undefined,
        });
        terminalOutputRevisionRef.current[snapshot.paneId] =
          snapshot.outputRevision;
        setTerminalOutput(snapshot.output ?? "");
        return true;
      } catch (error) {
        const output = `Failed to start ${profile.displayName}\n${String(error)}`;
        dispatchWorkbench({
          type: "sync-terminal-pane-snapshot",
          command: process.displayCommand,
          paneId,
          output,
          status: "failed",
          event: "process failed to start",
        });
        setTerminalOutput(output);
        return false;
      }
    },
    [
      activeSession?.workspacePath,
      notify,
      savedProjects,
      workbench.selectedTerminalPaneId,
      workbench.terminalPanes,
      workbench.workspaceMode,
      workspacePath,
    ],
  );

  const addTerminalPane = useCallback(() => {
    const profile = getCommandProfile(commandProfiles, activeProfileId);
    void launchTerminalPane({ profile }).then((started) => {
      notify(
        started ? "terminal" : "command-failed",
        started ? "Terminal added" : "Terminal start failed",
        profile.displayName,
      );
    });
  }, [activeProfileId, commandProfiles, launchTerminalPane, notify]);

  const createCliSession = useCallback(
    (profileId: string, projectPath: string) => {
      const profile = getCommandProfile(commandProfiles, profileId);
      dispatchWorkbench({
        type: "select-workspace-layout",
        layout: "terminal-grid",
      });
      void launchTerminalPane({
        profile,
        workspacePathOverride: projectPath,
      }).then((started) => {
        notify(
          started ? "terminal" : "command-failed",
          started ? "CLI session started" : "CLI session failed",
          `${profile.displayName} · ${workspaceName(projectPath)}`,
        );
      });
    },
    [commandProfiles, launchTerminalPane, notify],
  );

  const saveSessionModel = useCallback(
    async (sessionId: string, model: SessionModelSelection) => {
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                providerId: model.providerId,
                providerLabel: model.providerLabel,
                modelId: model.modelId,
                modelLabel: model.modelLabel,
                reasoningEffort: model.reasoningEffort,
              }
            : session,
        ),
      );

      if (!isTauriRuntime()) {
        return;
      }

      try {
        const updated = await invoke<Session>("set_session_model", {
          sessionId,
          providerId: model.providerId,
          providerLabel: model.providerLabel,
          modelId: model.modelId,
          modelLabel: model.modelLabel,
          reasoningEffort: model.reasoningEffort,
        });
        setSessions((current) =>
          current.map((session) =>
            session.id === sessionId ? updated : session,
          ),
        );
      } catch {
        notify(
          "command-failed",
          "Model memory failed",
          "This chat kept the model in the current window only",
        );
      }
    },
    [notify],
  );

  const selectProvider = useCallback(
    (providerId: ProviderId) => {
      const providers = providersForConfig(config);
      const provider = providers.find((item) => item.id === providerId);
      const model = provider ? getProviderModel(provider) : undefined;
      void persistConfig(
        {
          ...config,
          selectedProviderId: providerId,
          modelProviders: providers,
        },
        { notifySuccess: false },
      );
      if (activeSessionId && provider) {
        void saveSessionModel(activeSessionId, {
          providerId,
          providerLabel: provider.displayName,
          modelId: model?.id ?? provider.selectedModelId,
          modelLabel: model?.displayName,
          reasoningEffort: selectedReasoningEffort(provider),
        });
      }
    },
    [activeSessionId, config, persistConfig, saveSessionModel],
  );

  const setProviderAuthStatus = useCallback(
    (providerId: ProviderId, authStatus: ModelProviderConfig["authStatus"]) => {
      const currentConfig = configRef.current;
      const currentProvider = providersForConfig(currentConfig).find(
        (provider) => provider.id === providerId,
      );
      if (currentProvider?.authStatus === authStatus) {
        return;
      }
      const providers = providersForConfig(currentConfig).map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              authStatus,
              enabled: authStatus === "connected",
            }
          : provider,
      );
      void persistConfig(
        {
          ...currentConfig,
          selectedProviderId: providerId,
          modelProviders: providers,
        },
        { notifySuccess: false },
      );
      dispatchWorkbench({
        type: "set-provider-status",
        providerId,
        status: authStatus === "connected" ? "connected" : "disconnected",
      });
    },
    [persistConfig],
  );

  const recordProviderHealthOutput = useCallback(
    (providerId: ProviderId, output: string, check?: ProviderHealthCheck) => {
      const parsed = parseProviderHealthOutput(providerId, output);
      const details = check
        ? providerHealthDetailsFromCheck(check, parsed.healthDetails)
        : parsed.healthDetails;
      const result = {
        ...parsed,
        connectionStatus: check
          ? providerConnectionStatusFromRuntime(
              check.runtimeStatus as ProviderHealthDetails["runtimeStatus"],
              parsed.connectionStatus,
            )
          : parsed.connectionStatus,
        healthDetails: details,
        runtimeStatus: details.runtimeStatus,
      };
      dispatchWorkbench({
        type: "record-provider-health",
        providerId,
        status: result.connectionStatus,
        summary: result.healthSummary ?? "Health check complete.",
        details,
        output,
      });

      const provider = providersForConfig(configRef.current).find(
        (item) => item.id === providerId,
      );
      if (provider) {
        const nextAuthStatus = providerAuthStatusAfterHealth(
          provider.authStatus,
          result.connectionStatus,
        );
        if (nextAuthStatus !== provider.authStatus) {
          setProviderAuthStatus(providerId, nextAuthStatus);
        }
      }

      return result;
    },
    [setProviderAuthStatus],
  );

  const connectProvider = useCallback(
    async (providerId: ProviderId) => {
      const provider = providersForConfig(config).find(
        (item) => item.id === providerId,
      );
      const providerLabel = provider?.displayName ?? providerId;
      dispatchWorkbench({
        type: "set-provider-status",
        providerId,
        status: "checking",
      });
      notify(
        "provider",
        providerId === "openai"
          ? "Checking Codex sign-in"
          : "Connecting provider",
        providerLabel,
      );

      if (isTauriRuntime()) {
        try {
          const check = await invoke<ProviderHealthCheck>(
            "check_provider_health",
            {
              request: providerHealthRequest(provider, providerId),
            },
          );
          const result = recordProviderHealthOutput(
            providerId,
            check.output,
            check,
          );
          if (provider?.authMode === "env") {
            notify(
              result.connectionStatus === "connected" ? "provider" : "approval",
              result.connectionStatus === "connected"
                ? "Provider connected"
                : "Provider env setup needed",
              result.healthSummary ?? providerLabel,
            );
            return;
          }
          if (result.connectionStatus === "connected") {
            notify(
              "provider",
              providerId === "openai"
                ? "Using Codex sign-in"
                : "Provider verified",
              providerId === "openai"
                ? "OpenAI is available through your local ChatGPT/Codex login."
                : providerLabel,
            );
            return;
          }
        } catch (error) {
          recordProviderHealthOutput(providerId, String(error));
        }
      } else if (provider?.authMode === "env") {
        const output = createProviderHealthOutput(providerId, provider);
        const result = recordProviderHealthOutput(providerId, output);
        notify(
          result.connectionStatus === "connected" ? "provider" : "approval",
          result.connectionStatus === "connected"
            ? "Preview provider connected"
            : "Provider env setup needed",
          result.healthSummary ?? providerLabel,
        );
        return;
      }

      if (provider?.authMode === "env") {
        notify(
          "approval",
          "Provider env setup needed",
          `${provider.displayName} auth stays in ${provider.apiKeyRef}; configure it outside Gyro and test again.`,
        );
        return;
      }

      const profile = providerLoginProfile(providerId);
      const commandText = providerLoginCommandText(profile);
      const paneId = `provider-${providerId}-login-${Date.now()}`;
      const pane = createTerminalPane(
        paneId,
        profile,
        "running",
        workspaceRunMetadata(
          "local",
          profile.displayName,
          activeSession?.workspacePath ?? workspacePath,
        ),
      );
      dispatchWorkbench({
        type: "select-workspace-layout",
        layout: "terminal-grid",
      });
      dispatchWorkbench({ type: "open-tool-panel", tab: "terminal" });
      dispatchWorkbench({ type: "add-terminal-pane", pane });
      setTerminalOutput(`Starting ${providerLabel} sign-in: ${commandText}`);

      if (!isTauriRuntime()) {
        setProviderAuthStatus(providerId, "connected");
        notify("provider", "Preview provider verified", providerLabel);
        return;
      }

      try {
        const snapshot = await invoke<TerminalPaneSnapshot>(
          "create_terminal_pane",
          {
            request: {
              args: profile.args,
              command: profile.command,
              paneId,
              title: profile.displayName,
              workspacePath: undefined,
              workspaceMode: "local",
              workingDirectory: "Home",
            },
          },
        );
        dispatchWorkbench({
          type: "sync-terminal-pane-snapshot",
          paneId: snapshot.paneId,
          command: snapshot.command,
          projectPath: snapshot.workspacePath,
          workingDirectory: snapshot.workingDirectory,
          event:
            snapshot.exitCode === null || snapshot.exitCode === undefined
              ? snapshot.status
              : `${snapshot.status} (${snapshot.exitCode})`,
          output: snapshot.output ?? "",
          status: terminalStatusFromSnapshot(snapshot.status),
          hasForegroundJob: snapshot.hasForegroundJob ?? undefined,
        });
        terminalOutputRevisionRef.current[snapshot.paneId] =
          snapshot.outputRevision;
        setTerminalOutput(snapshot.output ?? "");
        notify(
          "provider",
          "Finish provider sign-in",
          `Complete ${commandText}. Gyro will connect automatically.`,
        );

        for (
          let attempt = 0;
          attempt < PROVIDER_AUTH_POLL_ATTEMPTS;
          attempt += 1
        ) {
          await waitFor(PROVIDER_AUTH_POLL_INTERVAL_MS);
          const check = await invoke<ProviderHealthCheck>(
            "check_provider_health",
            {
              request: providerHealthRequest(provider, providerId),
            },
          ).catch((error) => ({
            authOwner: "provider-cli",
            diagnosticsOptIn: false,
            output: String(error),
            privacyNote:
              "Gyro stores readiness summaries only; provider tokens stay outside Gyro.",
            providerId,
            runtimeStatus: "warning",
            secretStorage: "Provider CLI, OS Keychain, or provider-owned files",
          }));
          const result = recordProviderHealthOutput(
            providerId,
            check.output,
            check,
          );
          if (result.connectionStatus === "connected") {
            notify(
              "provider",
              providerId === "openai"
                ? "Using Codex sign-in"
                : "Provider verified",
              providerId === "openai"
                ? "OpenAI is available through your local ChatGPT/Codex login."
                : providerLabel,
            );
            return;
          }
        }

        notify(
          "approval",
          "Provider sign-in still pending",
          `Finish ${commandText}, then press Connect again.`,
        );
      } catch (error) {
        dispatchWorkbench({
          type: "set-terminal-pane-status",
          paneId,
          status: "failed",
          event: "login failed to start",
        });
        const output = String(error);
        setTerminalOutput(output);
        recordProviderHealthOutput(providerId, output);
        notify("command-failed", `${providerLabel} login failed`, output);
      }
    },
    [
      activeSession?.workspacePath,
      config,
      notify,
      recordProviderHealthOutput,
      setProviderAuthStatus,
      workbench.workspaceMode,
      workspacePath,
    ],
  );

  const recordModelSelection = useCallback(
    (
      providerId: ProviderId,
      providerLabel: string,
      modelId: string,
      modelLabel: string,
    ) => {
      const usage = loadModelUsageMap();
      const key = modelUsageKey(providerId, modelId);
      const current = usage[key] ?? { count: 0 };
      const count = current.count + 1;
      const nextEntry: ModelUsageEntry = { ...current, count };
      usage[key] = nextEntry;
      saveModelUsageMap(usage);

      const shouldPrompt =
        !modelStandardPrompt &&
        !nextEntry.standard &&
        count >= MODEL_STANDARD_PROMPT_THRESHOLD &&
        count >= (nextEntry.snoozeUntil ?? MODEL_STANDARD_PROMPT_THRESHOLD);

      if (shouldPrompt) {
        setModelStandardPrompt({
          count,
          modelId,
          modelLabel,
          providerId,
          providerLabel,
        });
      }
    },
    [modelStandardPrompt],
  );

  const selectProviderModel = useCallback(
    (providerId: ProviderId, modelId: string) => {
      let providers = providersForConfig(config).map((provider) =>
        provider.id === providerId
          ? { ...provider, selectedModelId: modelId }
          : provider,
      );
      const provider = providers.find((item) => item.id === providerId);
      const selectedModel = provider
        ? getProviderModel(provider, modelId)
        : undefined;
      const reasoningEffort = provider
        ? selectedReasoningEffort(provider)
        : undefined;
      providers = providers.map((item) =>
        item.id === providerId
          ? { ...item, selectedReasoningEffort: reasoningEffort }
          : item,
      );
      void persistConfig({
        ...config,
        selectedProviderId: providerId,
        modelProviders: providers,
      });
      dispatchWorkbench({
        type: "set-provider-model",
        providerId,
        model: selectedModel?.displayName ?? modelId,
      });
      if (activeSessionId && provider) {
        void saveSessionModel(activeSessionId, {
          providerId,
          providerLabel: provider.displayName,
          modelId,
          modelLabel: selectedModel?.displayName ?? modelId,
          reasoningEffort,
        });
      }
      if (provider && selectedModel) {
        recordModelSelection(
          providerId,
          provider.displayName,
          modelId,
          selectedModel.displayName,
        );
      }
    },
    [
      activeSessionId,
      config,
      persistConfig,
      recordModelSelection,
      saveSessionModel,
    ],
  );

  const selectProviderReasoningEffort = useCallback(
    (providerId: ProviderId, effort: ReasoningEffort) => {
      const providers = providersForConfig(config).map((provider) =>
        provider.id === providerId
          ? { ...provider, selectedReasoningEffort: effort }
          : provider,
      );
      const provider = providers.find((item) => item.id === providerId);
      const model = provider ? getProviderModel(provider) : undefined;
      if (!provider || !model?.supportedReasoningEfforts?.includes(effort)) {
        notify(
          "command-failed",
          "Effort unavailable",
          "The selected model does not support that reasoning effort.",
        );
        return;
      }
      void persistConfig({
        ...config,
        selectedProviderId: providerId,
        modelProviders: providers,
      });
      if (activeSessionId) {
        void saveSessionModel(activeSessionId, {
          providerId,
          providerLabel: provider.displayName,
          modelId: model.id,
          modelLabel: model.displayName,
          reasoningEffort: effort,
        });
      }
    },
    [activeSessionId, config, notify, persistConfig, saveSessionModel],
  );

  const acceptModelStandardPrompt = useCallback(() => {
    if (!modelStandardPrompt) {
      return;
    }
    const usage = loadModelUsageMap();
    const key = modelUsageKey(
      modelStandardPrompt.providerId,
      modelStandardPrompt.modelId,
    );
    const current = usage[key] ?? { count: modelStandardPrompt.count };
    usage[key] = {
      ...current,
      count: Math.max(current.count, modelStandardPrompt.count),
      snoozeUntil: undefined,
      standard: true,
    };
    saveModelUsageMap(usage);

    const providers = providersForConfig(config).map((provider) =>
      provider.id === modelStandardPrompt.providerId
        ? { ...provider, selectedModelId: modelStandardPrompt.modelId }
        : provider,
    );
    void persistConfig({
      ...config,
      selectedProviderId: modelStandardPrompt.providerId,
      modelProviders: providers,
    });
    dispatchWorkbench({
      type: "set-provider-model",
      providerId: modelStandardPrompt.providerId,
      model: modelStandardPrompt.modelLabel,
    });
    if (activeSessionId) {
      void saveSessionModel(activeSessionId, {
        providerId: modelStandardPrompt.providerId,
        providerLabel: modelStandardPrompt.providerLabel,
        modelId: modelStandardPrompt.modelId,
        modelLabel: modelStandardPrompt.modelLabel,
      });
    }
    notify(
      "provider",
      "Standard model set",
      `${modelStandardPrompt.providerLabel} · ${modelStandardPrompt.modelLabel}`,
    );
    setModelStandardPrompt(undefined);
  }, [
    activeSessionId,
    config,
    modelStandardPrompt,
    notify,
    persistConfig,
    saveSessionModel,
  ]);

  const dismissModelStandardPrompt = useCallback(() => {
    if (!modelStandardPrompt) {
      return;
    }
    const usage = loadModelUsageMap();
    const key = modelUsageKey(
      modelStandardPrompt.providerId,
      modelStandardPrompt.modelId,
    );
    const current = usage[key] ?? { count: modelStandardPrompt.count };
    const count = Math.max(current.count, modelStandardPrompt.count);
    usage[key] = {
      ...current,
      count,
      snoozeUntil: count + MODEL_STANDARD_PROMPT_SNOOZE_SELECTIONS,
    };
    saveModelUsageMap(usage);
    setModelStandardPrompt(undefined);
  }, [modelStandardPrompt]);

  const updateActiveChatDraft = useCallback(
    (value: string) => {
      setChatDrafts((current) => ({ ...current, [activeDraftKey]: value }));
    },
    [activeDraftKey],
  );

  const removeChatAttachment = useCallback(
    (attachmentId: string) => {
      setChatAttachments((current) => ({
        ...current,
        [activeDraftKey]: (current[activeDraftKey] ?? []).filter(
          (attachment) => attachment.id !== attachmentId,
        ),
      }));
    },
    [activeDraftKey],
  );

  const selectChatAttachment = useCallback(
    async (kind: "image" | "video" | "workspace-file") => {
      if (!isTauriRuntime()) {
        notify(
          "command-failed",
          "Attachments require the app",
          "Open Gyro desktop to select local files",
        );
        return;
      }
      if (kind === "workspace-file" && !workspacePath) {
        notify(
          "command-failed",
          "Select a project first",
          "Workspace references must stay inside the active project",
        );
        return;
      }
      try {
        const selected = await open({
          directory: false,
          multiple: kind === "image" || kind === "video",
          title:
            kind === "image"
              ? "Attach images"
              : kind === "video"
                ? "Attach videos"
                : "Attach workspace file",
          filters:
            kind === "image"
              ? [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
              : kind === "video"
                ? [
                    {
                      name: "Videos",
                      extensions: ["mp4", "m4v", "mov", "webm"],
                    },
                  ]
                : undefined,
        });
        const paths =
          typeof selected === "string" ? [selected] : (selected ?? []);
        const existing = chatAttachments[activeDraftKey] ?? [];
        const mediaLimit = kind === "image" ? 4 : kind === "video" ? 2 : 0;
        const availableSlots =
          kind === "image" || kind === "video"
            ? Math.max(
                0,
                mediaLimit -
                  existing.filter((item) => item.kind === kind).length,
              )
            : paths.length;
        if (
          (kind === "image" || kind === "video") &&
          paths.length > availableSlots
        ) {
          notify(
            "command-failed",
            kind === "video" ? "Two-video limit" : "Four-image limit",
            `Only ${availableSlots} more ${kind}${availableSlots === 1 ? "" : "s"} can be attached`,
          );
        }
        const prepared: ChatAttachment[] = [];
        for (const path of paths.slice(0, availableSlots)) {
          const attachment = await invoke<ChatAttachment>(
            "prepare_chat_attachment",
            {
              request: {
                sessionId: activeSessionId ?? NEW_CHAT_DRAFT_KEY,
                path,
                workspacePath,
                kind,
              },
            },
          );
          prepared.push({
            ...attachment,
            previewUrl:
              attachment.kind === "image" || attachment.kind === "video"
                ? convertFileSrc(attachment.path)
                : undefined,
          });
        }
        if (prepared.length) {
          setChatAttachments((current) => ({
            ...current,
            [activeDraftKey]: [...(current[activeDraftKey] ?? []), ...prepared],
          }));
        }
      } catch (error) {
        notify("command-failed", "Attachment rejected", String(error));
      }
    },
    [activeDraftKey, activeSessionId, chatAttachments, notify, workspacePath],
  );

  const attachEditorSnapshot = useCallback(async () => {
    if (!isTauriRuntime() || !workspacePath || !selectedFile) {
      notify(
        "command-failed",
        "No editor to capture",
        "Open a project file in Workspace first",
      );
      return;
    }
    const buffer = workbench.ide.buffers[selectedFile];
    const content =
      buffer?.content ??
      (selectedFileContent?.path === selectedFile
        ? selectedFileContent.content
        : undefined);
    if (content === undefined || content.length === 0) {
      notify(
        "command-failed",
        "Editor snapshot is empty",
        "Open a text file with content before adding this context",
      );
      return;
    }
    try {
      const attachment = await invoke<ChatAttachment>(
        "prepare_chat_attachment",
        {
          request: {
            sessionId: activeSessionId ?? NEW_CHAT_DRAFT_KEY,
            path: "",
            workspacePath,
            kind: "ide-snapshot",
            name: `${workspaceName(selectedFile)}.snapshot.txt`,
            relativePath: selectedFile,
            bytes: Array.from(new TextEncoder().encode(content)),
          },
        },
      );
      setChatAttachments((current) => ({
        ...current,
        [activeDraftKey]: [...(current[activeDraftKey] ?? []), attachment],
      }));
      notify(
        "terminal",
        "Editor snapshot attached",
        `${selectedFile}${buffer?.status === "dirty" ? " · unsaved changes included" : ""}`,
      );
    } catch (error) {
      notify("command-failed", "Editor snapshot rejected", String(error));
    }
  }, [
    activeDraftKey,
    activeSessionId,
    notify,
    selectedFile,
    selectedFileContent,
    workbench.ide.buffers,
    workspacePath,
  ]);

  const attachDroppedMedia = useCallback(
    async (
      files: File[],
      target?: {
        draftKey: string;
        sessionId?: string;
        workspacePath?: string;
      },
    ) => {
      const attachmentDraftKey = target?.draftKey ?? activeDraftKey;
      const attachmentSessionId = target?.sessionId ?? activeSessionId;
      const attachmentWorkspacePath = target?.workspacePath ?? workspacePath;
      const existing = chatAttachments[attachmentDraftKey] ?? [];
      const remaining = {
        image: Math.max(
          0,
          4 - existing.filter((item) => item.kind === "image").length,
        ),
        video: Math.max(
          0,
          2 - existing.filter((item) => item.kind === "video").length,
        ),
      };
      const prepared: ChatAttachment[] = [];
      let rejectedCount = 0;
      let limitExceeded = false;
      for (const file of files) {
        const kind =
          file.type.startsWith("video/") || isSupportedChatVideoPath(file.name)
            ? "video"
            : "image";
        if (remaining[kind] <= 0) {
          limitExceeded = true;
          continue;
        }
        remaining[kind] -= 1;
        try {
          const attachment = await invoke<ChatAttachment>(
            "prepare_chat_attachment",
            {
              request: {
                sessionId: attachmentSessionId ?? NEW_CHAT_DRAFT_KEY,
                path: "",
                workspacePath: attachmentWorkspacePath,
                kind,
                name:
                  file.name ||
                  `pasted-${kind}-${Date.now()}.${kind === "video" ? "mp4" : "png"}`,
                bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
              },
            },
          );
          prepared.push({
            ...attachment,
            previewUrl: convertFileSrc(attachment.path),
          });
        } catch {
          rejectedCount += 1;
        }
      }
      if (prepared.length) {
        setChatAttachments((current) => ({
          ...current,
          [attachmentDraftKey]: [
            ...(current[attachmentDraftKey] ?? []),
            ...prepared,
          ],
        }));
      }
      if (limitExceeded) {
        notify(
          "command-failed",
          "Media limit reached",
          "Attach up to four images and two videos per message",
        );
      } else if (rejectedCount > 0) {
        notify(
          "command-failed",
          "Media rejected",
          `${rejectedCount} file${rejectedCount === 1 ? " was" : "s were"} not accepted`,
        );
      }
    },
    [activeDraftKey, activeSessionId, chatAttachments, notify, workspacePath],
  );

  const attachDroppedMediaPaths = useCallback(
    async (paths: string[]) => {
      const mediaPaths = paths.filter(
        (path) =>
          isSupportedChatImagePath(path) || isSupportedChatVideoPath(path),
      );
      const unsupportedCount = paths.length - mediaPaths.length;
      if (!mediaPaths.length) {
        notify(
          "command-failed",
          "Unsupported attachment",
          "Drop PNG, JPEG, WebP, MP4, MOV, or WebM media onto the chat",
        );
        return;
      }
      const existing = chatAttachments[activeDraftKey] ?? [];
      const remaining = {
        image: Math.max(
          0,
          4 - existing.filter((item) => item.kind === "image").length,
        ),
        video: Math.max(
          0,
          2 - existing.filter((item) => item.kind === "video").length,
        ),
      };
      const prepared: ChatAttachment[] = [];
      let rejectedCount = unsupportedCount;
      let limitExceeded = false;
      for (const path of mediaPaths) {
        const kind = isSupportedChatVideoPath(path) ? "video" : "image";
        if (remaining[kind] <= 0) {
          limitExceeded = true;
          continue;
        }
        remaining[kind] -= 1;
        try {
          const attachment = await invoke<ChatAttachment>(
            "prepare_chat_attachment",
            {
              request: {
                sessionId: activeSessionId ?? NEW_CHAT_DRAFT_KEY,
                path,
                workspacePath,
                kind,
              },
            },
          );
          prepared.push({
            ...attachment,
            previewUrl: convertFileSrc(attachment.path),
          });
        } catch {
          rejectedCount += 1;
        }
      }
      if (prepared.length) {
        setChatAttachments((current) => ({
          ...current,
          [activeDraftKey]: [...(current[activeDraftKey] ?? []), ...prepared],
        }));
      }
      if (limitExceeded) {
        notify(
          "command-failed",
          "Media limit reached",
          "Attach up to four images and two videos per message",
        );
      } else if (rejectedCount > 0) {
        notify(
          "command-failed",
          "Media rejected",
          `${rejectedCount} dropped item${rejectedCount === 1 ? " was" : "s were"} not accepted`,
        );
      }
    },
    [activeDraftKey, activeSessionId, chatAttachments, notify, workspacePath],
  );

  useEffect(() => {
    const isChatVisible =
      activeDestination === "onboarding" ||
      (activeDestination === "workspace" && activeWorkspaceLayout === "thread");
    if (!isTauriRuntime() || !isChatVisible) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") {
          return;
        }
        const scale = window.devicePixelRatio || 1;
        const target = document.elementFromPoint(
          event.payload.position.x / scale,
          event.payload.position.y / scale,
        );
        if (!target?.closest(".gyro-chat-surface")) {
          return;
        }
        void attachDroppedMediaPaths(event.payload.paths);
      })
      .then((dispose) => {
        if (disposed) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activeDestination, activeWorkspaceLayout, attachDroppedMediaPaths]);

  const changeChatMode = useCallback(
    async (mode: ChatMode) => {
      if (!activeSessionId) {
        setPendingNewChatMode(mode);
        if (mode === "plan") {
          setPendingNewChatGoal(undefined);
        }
        return true;
      }

      const shouldClearGoal = mode === "plan" && Boolean(activeSessionGoal);
      const shouldChangeMode = activeChatMode !== mode;
      if (!shouldClearGoal && !shouldChangeMode) {
        return true;
      }

      const modeMessage =
        mode === "plan" ? "Plan mode enabled" : "Normal mode enabled";
      if (!isTauriRuntime()) {
        const now = new Date().toISOString();
        setEvents((current) => [
          ...current,
          ...(shouldClearGoal
            ? [
                createGoalSessionEvent(activeSessionId, "Goal cleared", {
                  action: "clear",
                }),
              ]
            : []),
          ...(shouldChangeMode
            ? [
                {
                  id: `chat-mode-${Date.now()}`,
                  sessionId: activeSessionId,
                  createdAt: now,
                  kind: "chat-mode-changed" as const,
                  message: modeMessage,
                  payload: { mode },
                },
              ]
            : []),
        ]);
        return true;
      }

      try {
        if (shouldClearGoal) {
          await invoke<SessionEvent>("append_chat_context_event", {
            sessionId: activeSessionId,
            eventKind: "goal-updated",
            message: "Goal cleared",
            payload: { action: "clear" },
          });
        }
        if (shouldChangeMode) {
          await invoke<SessionEvent>("append_chat_context_event", {
            sessionId: activeSessionId,
            eventKind: "chat-mode-changed",
            message: modeMessage,
            payload: { mode },
          });
        }
        await refreshEvents(activeSessionId);
        return true;
      } catch (error) {
        notify("command-failed", "Mode change failed", String(error));
        return false;
      }
    },
    [activeChatMode, activeSessionGoal, activeSessionId, notify, refreshEvents],
  );

  const handleComposerAction = useCallback(
    (action: string) => {
      const currentWorkspacePath =
        activeSession?.workspacePath ?? workspacePath;
      const setComposerWorkspaceMode = (
        nextMode: WorkbenchState["workspaceMode"],
      ) => {
        const applyWorkspaceMode = () => {
          dispatchWorkbench({ type: "set-workbench-mode", mode: nextMode });
          dispatchWorkbench({ type: "close-tool-panel" });
          notify(
            "terminal",
            nextMode === "worktree" ? "Worktree mode" : "Local mode",
            nextMode === "worktree"
              ? "New runs will create an isolated worktree branch."
              : "New runs will use the current workspace branch.",
          );
        };
        if (nextMode === "worktree" && !currentWorkspacePath) {
          notify(
            "terminal",
            "Choose a workspace",
            "Worktree mode needs a repo or folder before the chat starts.",
          );
          void openWorkspace().then((selected) => {
            if (selected) {
              applyWorkspaceMode();
            }
          });
          return;
        }
        applyWorkspaceMode();
      };

      if (action.startsWith("select-provider:")) {
        const providerId = action.replace("select-provider:", "");
        if (isProviderId(providerId)) {
          selectProvider(providerId);
        }
        return;
      }

      if (action.startsWith("connect-provider:")) {
        const providerId = action.replace("connect-provider:", "");
        if (isProviderId(providerId)) {
          connectProvider(providerId);
        }
        return;
      }

      if (action.startsWith("select-provider-model:")) {
        const [, providerId, modelId] = action.split(":");
        if (isProviderId(providerId) && modelId) {
          selectProviderModel(providerId, modelId);
        }
        return;
      }

      if (action.startsWith("select-provider-effort:")) {
        const [, providerId, effort] = action.split(":");
        if (
          isProviderId(providerId) &&
          effort &&
          ["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)
        ) {
          selectProviderReasoningEffort(providerId, effort as ReasoningEffort);
        }
        return;
      }

      if (action.startsWith("refresh-provider-models:")) {
        const providerId = action.replace("refresh-provider-models:", "");
        if (isProviderId(providerId)) {
          const provider = providersForConfig(config).find(
            (item) => item.id === providerId,
          );
          void persistConfig({
            ...config,
            selectedProviderId: providerId,
            modelProviders: providersForConfig(config),
          });
          notify(
            "provider",
            "Models refreshed",
            provider
              ? `${provider.displayName} is using the seeded model catalog.`
              : "Seeded model catalog is current.",
          );
        }
        return;
      }

      if (action.startsWith("check-provider:")) {
        checkProviderReadiness("chat", action.replace("check-provider:", ""));
        return;
      }

      if (action.startsWith("set-workspace-mode:")) {
        const nextMode = action.replace(
          "set-workspace-mode:",
          "",
        ) as WorkbenchState["workspaceMode"];
        setComposerWorkspaceMode(nextMode);
        return;
      }

      if (action === "new-chat-select-workspace") {
        void openWorkspace().then((selected) => {
          if (selected) {
            startNewChat();
          }
        });
        return;
      }

      if (action === "new-local-chat-select-workspace") {
        void openWorkspace().then((selected) => {
          if (selected) {
            startNewChat();
            dispatchWorkbench({ type: "set-workbench-mode", mode: "local" });
          }
        });
        return;
      }

      if (action.startsWith("start-new-chat-mode:")) {
        const nextMode = action.replace("start-new-chat-mode:", "");
        if (nextMode === "local" || nextMode === "worktree") {
          startNewChat();
          setComposerWorkspaceMode(nextMode);
        }
        return;
      }

      if (action.startsWith("select-branch:")) {
        const encodedBranch = action.replace("select-branch:", "");
        try {
          const branch = decodeURIComponent(encodedBranch);
          if (branch) {
            void switchWorkspaceBranch(branch);
          }
        } catch {
          notify(
            "command-failed",
            "Invalid branch",
            "The branch name could not be read.",
          );
        }
        return;
      }

      if (action.startsWith("remove-saved-project:")) {
        const encodedPath = action.replace("remove-saved-project:", "");
        try {
          const selectedPath = normalizeProjectPath(
            decodeURIComponent(encodedPath),
          );
          if (!selectedPath) {
            return;
          }
          const project = savedProjects.find(
            (item) => normalizeProjectPath(item.path) === selectedPath,
          );
          setProjectRemoveCandidate({
            path: selectedPath,
            label: project?.label ?? workspaceName(selectedPath),
            detail: project?.detail ?? selectedPath,
            sessionCount:
              project?.sessionCount ??
              sessions.filter(
                (session) =>
                  normalizeProjectPath(session.workspacePath) === selectedPath,
              ).length,
          });
        } catch {
          notify(
            "command-failed",
            "Project remove failed",
            "The saved project path could not be read.",
          );
        }
        return;
      }

      if (action.startsWith("select-saved-project:")) {
        const encodedPath = action.replace("select-saved-project:", "");
        try {
          const selectedPath = decodeURIComponent(encodedPath);
          void activateWorkspacePath(selectedPath, "Project selected").catch(
            () => {
              notify(
                "command-failed",
                "Project unavailable",
                "The saved project folder could not be opened.",
              );
            },
          );
        } catch {
          notify(
            "command-failed",
            "Project select failed",
            "The saved project path could not be read.",
          );
        }
        return;
      }

      switch (action) {
        case "new-chat":
          startNewChat();
          break;
        case "add-context":
        case "select-file":
          void selectChatAttachment("workspace-file");
          break;
        case "select-image":
          void selectChatAttachment("image");
          break;
        case "select-video":
          void selectChatAttachment("video");
          break;
        case "attach-editor-snapshot":
          void attachEditorSnapshot();
          break;
        case "select-project":
        case "select-workspace":
        case "select-folder":
          void openWorkspace();
          break;
        case "add-goal":
          dispatchWorkbench({ type: "set-chat-panel" });
          setIsGoalComposerActive(true);
          if (activeChatMode === "plan") {
            void changeChatMode("normal");
          }
          break;
        case "add-plan":
          dispatchWorkbench({ type: "set-chat-panel", panel: "plan" });
          planEditorRequestTokenRef.current += 1;
          setPlanEditorRequest({
            kind: "item",
            token: planEditorRequestTokenRef.current,
          });
          break;
        case "set-chat-mode-plan":
        case "set-chat-mode-normal":
          {
            const mode: ChatMode = action.endsWith("plan") ? "plan" : "normal";
            if (mode === "plan") {
              setIsGoalComposerActive(false);
            }
            void changeChatMode(mode);
          }
          break;
        case "search-workspace":
          openGlobalSearch();
          break;
        case "toggle-access":
          openSettingsSection("permissions");
          break;
        case "set-approval-gated":
          void persistConfig({
            ...config,
            requireCommandApproval: true,
            requireFileEditApproval: true,
            fullAccess: false,
          });
          {
            const copy = approvalNotificationCopy(config, "gated");
            notify("terminal", copy.title, copy.detail);
          }
          break;
        case "set-approval-auto":
          void persistConfig({
            ...config,
            requireCommandApproval: false,
            requireFileEditApproval: false,
            fullAccess: false,
          });
          {
            const copy = approvalNotificationCopy(config, "auto");
            notify("terminal", copy.title, copy.detail);
          }
          break;
        case "set-approval-direct":
          void persistConfig({
            ...config,
            requireCommandApproval: false,
            requireFileEditApproval: false,
            fullAccess: true,
          });
          {
            const copy = approvalNotificationCopy(config, "direct");
            notify("terminal", copy.title, copy.detail);
          }
          break;
        case "select-model":
          dispatchWorkbench({
            type: "select-destination",
            destination: "providers",
          });
          break;
        case "select-branch":
          void refreshWorkspaceBranches(currentWorkspacePath);
          break;
        case "open-terminal-panel":
          openToolPanel("terminal");
          break;
        case "open-browser-panel":
          openToolPanel("browser");
          break;
        case "open-files":
          dispatchWorkbench({
            type: "select-workspace-layout",
            layout: "code",
          });
          break;
        default:
          notify("terminal", "Composer action", action);
      }
    },
    [
      attachEditorSnapshot,
      activeChatMode,
      activeSession?.workspacePath,
      activateWorkspacePath,
      checkProviderReadiness,
      changeChatMode,
      connectProvider,
      config,
      notify,
      openGlobalSearch,
      openSettingsSection,
      openToolPanel,
      openWorkspace,
      persistConfig,
      savedProjects,
      selectProvider,
      selectProviderModel,
      selectProviderReasoningEffort,
      switchWorkspaceBranch,
      refreshWorkspaceBranches,
      startNewChat,
      selectChatAttachment,
      sessions,
      workbench.workspaceMode,
      workspacePath,
    ],
  );

  const splitTerminalPane = useCallback(
    (template: TerminalTemplate) => {
      const profile = getCommandProfile(commandProfiles, activeProfileId);
      void launchTerminalPane({ profile, template }).then((started) => {
        notify(
          started ? "terminal" : "command-failed",
          started ? "Terminal split" : "Terminal start failed",
          started ? `${template}-pane template selected` : profile.displayName,
        );
      });
    },
    [activeProfileId, commandProfiles, launchTerminalPane, notify],
  );

  const renameTerminalPane = useCallback(
    (paneId: string) => {
      const pane = workbench.terminalPanes.find((item) => item.id === paneId);
      if (!pane) {
        return;
      }
      const title = window.prompt("Rename terminal", pane.title)?.trim();
      if (!title || title === pane.title) {
        return;
      }
      dispatchWorkbench({ type: "rename-terminal-pane", paneId, title });
      notify("terminal", "Terminal renamed", title);
    },
    [notify, workbench.terminalPanes],
  );

  const sendDraft = useCallback(
    async (
      overrideMessage?: string,
      overrideContext?: ChatTurnContextSnapshot,
    ) => {
      const message = normalizeChatMessage(overrideMessage ?? activeChatDraft);
      const turnAttachments =
        overrideContext?.attachments ?? activeChatAttachments;
      const turnMode = overrideContext?.mode ?? activeChatMode;
      const requestedTurnGoal = overrideContext?.goal ?? activeSessionGoal;
      const turnGoal = turnMode === "plan" ? undefined : requestedTurnGoal;
      const turnPlan = overrideContext?.plan ?? activeSessionPlan;
      const sessionModel = {
        ...selectedSessionModelFromConfig(config),
        ...overrideContext?.sessionModel,
      };
      const selectedProvider = providersForConfig(config).find(
        (provider) => provider.id === sessionModel.providerId,
      );
      const requireCommandApproval =
        overrideContext?.requireCommandApproval ??
        config.requireCommandApproval;
      const requireFileEditApproval =
        overrideContext?.requireFileEditApproval ??
        config.requireFileEditApproval;
      const fullAccess =
        overrideContext?.fullAccess ?? Boolean(config.fullAccess);
      const chatWorkspacePath =
        overrideContext?.workspacePath ??
        activeSession?.workspacePath ??
        workspacePath;
      if (message === "") {
        return false;
      }
      if (chatMessageLength(message) > MAX_CHAT_MESSAGE_CHARS) {
        notify(
          "command-failed",
          "Message too long",
          `Keep chat messages under ${MAX_CHAT_MESSAGE_CHARS.toLocaleString()} characters.`,
        );
        return false;
      }
      if (!activeSessionId && isStartingFirstTurn) {
        return false;
      }
      if (
        activeSessionId &&
        sendingSessionIdsRef.current.has(activeSessionId)
      ) {
        if (
          (chatMessageQueues[activeSessionId]?.length ?? 0) >=
          MAX_QUEUED_CHAT_MESSAGES_PER_SESSION
        ) {
          notify(
            "command-failed",
            "Queue full",
            `Finish or remove a queued message before adding more than ${MAX_QUEUED_CHAT_MESSAGES_PER_SESSION}.`,
          );
          return false;
        }
        const queuedMessageCount = Object.values(chatMessageQueues).reduce(
          (total, queued) => total + queued.length,
          0,
        );
        if (queuedMessageCount >= MAX_QUEUED_CHAT_MESSAGES_TOTAL) {
          notify(
            "command-failed",
            "Queue capacity reached",
            "Finish or remove a queued message in another chat before adding more.",
          );
          return false;
        }
        const queuedMessage: QueuedChatMessage = {
          deliveryAttempts: 0,
          id: `queued-${createTurnId()}`,
          message,
          status: "waiting",
          context: {
            attachments: turnAttachments.map((attachment) => ({
              ...attachment,
            })),
            goal: turnGoal ? { ...turnGoal } : undefined,
            mode: turnMode,
            plan: {
              ...turnPlan,
              items: turnPlan.items.map((item) => ({ ...item })),
            },
            sessionModel: { ...sessionModel },
            requireCommandApproval,
            requireFileEditApproval,
            fullAccess,
            turnId: createTurnId(),
            workspacePath: chatWorkspacePath,
          },
        };
        setChatMessageQueues((current) => {
          const queued = current[activeSessionId] ?? [];
          const totalQueued = Object.values(current).reduce(
            (total, messages) => total + messages.length,
            0,
          );
          if (
            queued.length >= MAX_QUEUED_CHAT_MESSAGES_PER_SESSION ||
            totalQueued >= MAX_QUEUED_CHAT_MESSAGES_TOTAL
          ) {
            return current;
          }
          return {
            ...current,
            [activeSessionId]: [...queued, queuedMessage],
          };
        });
        if (!overrideContext?.preserveDraft) {
          resetChatDraft();
        }
        notify(
          "terminal",
          "Message queued",
          "It will send when this chat is active and its current response finishes.",
        );
        return true;
      }
      if (!isUserSelectedWorkspacePath(chatWorkspacePath)) {
        notify(
          "command-failed",
          "Choose a project",
          "Select the folder Gyro should use before starting this chat.",
        );
        void openWorkspace();
        return false;
      }
      if (!checkProviderReadiness("chat", sessionModel.providerId)) {
        return false;
      }
      const retryTurnId = overrideContext?.retryTurnId;
      const turnId = retryTurnId ?? overrideContext?.turnId ?? createTurnId();
      setTurnSourceControlBaselines((current) => {
        if (current[turnId]) {
          return current;
        }
        return Object.fromEntries([
          ...Object.entries(current).slice(-49),
          [turnId, sourceControlLineStats(workbench.ide.sourceControl)],
        ]);
      });
      const isRetry = Boolean(activeSessionId && retryTurnId);
      const shouldSuggestTitle =
        !isRetry &&
        shouldSuggestSessionTitle(
          activeSession,
          activeSessionHasTranscriptEvents,
        );
      const provisionalTitle = shouldSuggestTitle
        ? sessionTitleFromMessage(message)
        : undefined;

      if (!activeSessionId) {
        setIsStartingFirstTurn(true);
        dispatchWorkbench({
          type: "select-workspace-layout",
          layout: "thread",
        });
        dispatchWorkbench({ type: "close-tool-panel" });
        dispatchWorkbench({ type: "set-chat-panel" });
        const session = createPreviewSession(
          "thread",
          workbench.workspaceMode,
          sessionModel,
          chatWorkspacePath,
          provisionalTitle,
        );
        const optimisticEvents = createOptimisticTurnEvents(
          session.id,
          message,
          turnId,
          selectedProvider,
          turnAttachments,
        );
        let sendingSessionId = session.id;
        optimisticEventsRef.current.set(session.id, optimisticEvents);
        suppressSessionAutoSelectRef.current = false;
        setSessionSending(session.id, true);
        setWorkspacePath(session.workspacePath);
        setFiles(previewFiles);
        setSessions((current) => [session, ...current]);
        dispatchChatGrid({
          type: "migrate-draft-pane",
          draftKey: activeDraftKey,
          sessionId: session.id,
          workspacePath: session.workspacePath,
        });
        activeSessionIdRef.current = session.id;
        setActiveSessionId(session.id);
        setEventsForSession(
          session.id,
          limitSessionEventsForUi(optimisticEvents),
        );
        if (!overrideContext?.preserveDraft) {
          resetChatDraft();
        }
        notify("terminal", "Message sending", "Starting chat");

        if (!isTauriRuntime()) {
          updateOptimisticProviderStatus(
            optimisticEventsRef,
            (value) => setEventsForSession(session.id, value),
            session.id,
            turnId,
            "done",
          );
          setSessionSending(session.id, false);
          setIsStartingFirstTurn(false);
          return true;
        }

        let optimisticSessionId = session.id;
        let didDeliverProviderResponse = false;
        try {
          await waitForNextPaint();
          const persistedSession = await createTauriThreadSession(
            chatWorkspacePath,
            workbench.workspaceMode,
            sessionModel,
            provisionalTitle,
          );
          optimisticSessionId = persistedSession.id;
          const migratedEvents = rekeySessionEvents(
            optimisticEvents,
            persistedSession.id,
          );
          optimisticEventsRef.current.delete(session.id);
          optimisticEventsRef.current.set(persistedSession.id, migratedEvents);
          setSessionEventsById((current) => {
            const next = { ...current };
            delete next[session.id];
            next[persistedSession.id] = migratedEvents;
            return next;
          });
          dispatchChatGrid({
            type: "rekey-session-pane",
            fromSessionId: session.id,
            toSessionId: persistedSession.id,
            workspacePath: persistedSession.workspacePath,
          });
          replaceSendingSessionId(session.id, persistedSession.id);
          setChatMessageQueues((current) => {
            const queued = current[session.id];
            if (!queued?.length) {
              return current;
            }
            const next = { ...current };
            delete next[session.id];
            next[persistedSession.id] = [
              ...(next[persistedSession.id] ?? []),
              ...queued,
            ];
            return next;
          });
          sendingSessionId = persistedSession.id;
          setSessions((current) => [
            persistedSession,
            ...current.filter((item) => item.id !== session.id),
          ]);
          setActiveSessionId((current) =>
            current === session.id ? persistedSession.id : current,
          );
          if (activeSessionIdRef.current === session.id) {
            activeSessionIdRef.current = persistedSession.id;
            setWorkspacePath(persistedSession.workspacePath);
            setEventsForSession(
              persistedSession.id,
              limitSessionEventsForUi(migratedEvents),
            );
          }

          const persistedTurnAttachments = await Promise.all(
            turnAttachments.map(async (attachment) => {
              const prepared = await invoke<ChatAttachment>(
                "prepare_chat_attachment",
                {
                  request: {
                    sessionId: persistedSession.id,
                    path: attachment.path,
                    workspacePath: persistedSession.workspacePath,
                    kind: attachment.kind,
                    name: attachment.name,
                    relativePath: attachment.relativePath,
                  },
                },
              );
              return {
                ...prepared,
                previewUrl:
                  prepared.kind === "image" || prepared.kind === "video"
                    ? convertFileSrc(prepared.path)
                    : undefined,
              };
            }),
          );

          const contextEvents: SessionEvent[] = [];
          if (turnGoal?.text) {
            contextEvents.push(
              await invoke<SessionEvent>("append_chat_context_event", {
                sessionId: persistedSession.id,
                eventKind: "goal-updated",
                message: `Goal set: ${turnGoal.text}`,
                payload: {
                  action: "set",
                  text: turnGoal.text,
                  status: turnGoal.status,
                },
              }),
            );
          }
          if (turnMode === "plan") {
            contextEvents.push(
              await invoke<SessionEvent>("append_chat_context_event", {
                sessionId: persistedSession.id,
                eventKind: "chat-mode-changed",
                message: "Plan mode enabled",
                payload: { mode: "plan" },
              }),
            );
          }
          if (turnPlan.items.length) {
            contextEvents.push(
              await invoke<SessionEvent>("append_plan_event", {
                sessionId: persistedSession.id,
                message: "Plan created",
                payload: {
                  action: "replace",
                  title: turnPlan.title,
                  content: turnPlan.content,
                  items: turnPlan.items,
                },
              }),
            );
          }
          if (contextEvents.length) {
            setEvents((current) => {
              if (
                !current.some(
                  (event) => event.sessionId === persistedSession.id,
                )
              ) {
                return current;
              }
              return limitSessionEventsForUi([...current, ...contextEvents]);
            });
          }

          await invoke<SessionEvent>("append_user_message", {
            attachments: persistedTurnAttachments,
            sessionId: persistedSession.id,
            message,
            turnId,
          });
          persistedChatTurnIdsRef.current.add(turnId);
          const providerResponse = await invoke<ProviderChatResponse>(
            "run_provider_chat",
            {
              request: {
                sessionId: persistedSession.id,
                message,
                turnId,
                providerId:
                  sessionModel.providerId ??
                  selectedProvider?.id ??
                  config.selectedProviderId,
                providerLabel:
                  sessionModel.providerLabel ?? selectedProvider?.displayName,
                modelId: sessionModel.modelId,
                modelLabel: sessionModel.modelLabel,
                reasoningEffort: sessionModel.reasoningEffort,
                requireCommandApproval,
                requireFileEditApproval,
                fullAccess,
                mode: turnMode,
                goal: turnGoal?.text ? turnGoal : undefined,
                plan: turnPlan.items.length ? turnPlan : undefined,
                attachments: persistedTurnAttachments,
                suggestTitle: shouldSuggestTitle,
                workspacePath: persistedSession.workspacePath,
              },
            },
          );
          applyProviderChatResponse(persistedSession.id, providerResponse);
          didDeliverProviderResponse = true;
          persistedChatTurnIdsRef.current.delete(turnId);
          setPendingNewChatGoal(undefined);
          setPendingNewChatMode("normal");
          setPendingNewChatPlan({ title: "Plan", items: [] });
          optimisticEventsRef.current.delete(persistedSession.id);
        } catch (error) {
          const errorMessage = String(error);
          const wasCancelled = errorMessage.includes("chat cancelled by user");
          if (!wasCancelled)
            dispatchWorkbench({
              type: "set-provider-readiness",
              status: "blocked",
              message: errorMessage,
              providerId: sessionModel.providerId ?? selectedProvider?.id,
            });
          updateOptimisticProviderStatus(
            optimisticEventsRef,
            (value) => setEventsForSession(optimisticSessionId, value),
            optimisticSessionId,
            turnId,
            wasCancelled ? "cancelled" : "failed",
            errorMessage,
          );
          if (optimisticSessionId !== session.id) {
            await refreshEvents(optimisticSessionId);
          }
          notify(
            wasCancelled ? "terminal" : "command-failed",
            wasCancelled ? "Turn stopped" : "Message fallback",
            wasCancelled
              ? "The provider process was cancelled"
              : "Chat stayed local",
          );
        } finally {
          setSessionSending(sendingSessionId, false);
          setIsStartingFirstTurn(false);
        }
        return didDeliverProviderResponse;
      }

      const optimisticEvents = isRetry
        ? []
        : createOptimisticTurnEvents(
            activeSessionId,
            message,
            turnId,
            selectedProvider,
            turnAttachments,
          );
      if (provisionalTitle) {
        void updateSessionTitle(activeSessionId, provisionalTitle, {
          notifyFailure: false,
        });
      }
      void saveSessionModel(activeSessionId, sessionModel);
      if (isRetry) {
        const resetEvents = (items: SessionEvent[]) =>
          resetStreamingAssistantForRetry(items, turnId);
        optimisticEventsRef.current.set(
          activeSessionId,
          resetEvents(optimisticEventsRef.current.get(activeSessionId) ?? []),
        );
        setEvents((current) => resetEvents(current));
        updateOptimisticProviderStatus(
          optimisticEventsRef,
          setEvents,
          activeSessionId,
          turnId,
          "running",
        );
      } else {
        optimisticEventsRef.current.set(
          activeSessionId,
          mergePersistedAndOptimisticEvents(
            optimisticEventsRef.current.get(activeSessionId) ?? [],
            optimisticEvents,
          ),
        );
      }
      setSessionSending(activeSessionId, true);
      dispatchWorkbench({ type: "set-chat-panel" });
      if (!isRetry) {
        setEvents((current) =>
          limitSessionEventsForUi(
            mergePersistedAndOptimisticEvents(current, optimisticEvents),
          ),
        );
        if (!overrideContext?.preserveDraft) {
          resetChatDraft();
        }
      }
      if (!isTauriRuntime()) {
        updateOptimisticProviderStatus(
          optimisticEventsRef,
          setEvents,
          activeSessionId,
          turnId,
          "done",
        );
        setSessionSending(activeSessionId, false);
        notify("terminal", "Message added", "Local optimistic event");
        return true;
      }
      let didDeliverProviderResponse = false;
      try {
        await waitForNextPaint();
        if (!isRetry) {
          await invoke<SessionEvent>("append_user_message", {
            attachments: turnAttachments,
            sessionId: activeSessionId,
            message,
            turnId,
          });
          persistedChatTurnIdsRef.current.add(turnId);
        }
        const providerResponse = await invoke<ProviderChatResponse>(
          "run_provider_chat",
          {
            request: {
              sessionId: activeSessionId,
              message,
              turnId,
              providerId:
                sessionModel.providerId ??
                selectedProvider?.id ??
                config.selectedProviderId,
              providerLabel:
                sessionModel.providerLabel ?? selectedProvider?.displayName,
              modelId: sessionModel.modelId,
              modelLabel: sessionModel.modelLabel,
              reasoningEffort: sessionModel.reasoningEffort,
              requireCommandApproval,
              requireFileEditApproval,
              fullAccess,
              mode: turnMode,
              goal: turnGoal?.text ? turnGoal : undefined,
              plan: turnPlan.items.length ? turnPlan : undefined,
              attachments: turnAttachments,
              suggestTitle: shouldSuggestTitle,
              workspacePath: chatWorkspacePath,
            },
          },
        );
        applyProviderChatResponse(activeSessionId, providerResponse);
        didDeliverProviderResponse = true;
        persistedChatTurnIdsRef.current.delete(turnId);
        optimisticEventsRef.current.delete(activeSessionId);
      } catch (error) {
        const errorMessage = String(error);
        const wasCancelled = errorMessage.includes("chat cancelled by user");
        if (!wasCancelled)
          dispatchWorkbench({
            type: "set-provider-readiness",
            status: "blocked",
            message: errorMessage,
            providerId: sessionModel.providerId ?? selectedProvider?.id,
          });
        updateOptimisticProviderStatus(
          optimisticEventsRef,
          setEvents,
          activeSessionId,
          turnId,
          wasCancelled ? "cancelled" : "failed",
          errorMessage,
        );
        await refreshEvents(activeSessionId);
        notify(
          wasCancelled ? "terminal" : "command-failed",
          wasCancelled ? "Turn stopped" : "Message fallback",
          wasCancelled
            ? "The provider process was cancelled"
            : "Chat stayed local",
        );
      } finally {
        setSessionSending(activeSessionId, false);
      }
      return didDeliverProviderResponse;
    },
    [
      activeSessionId,
      activeSession,
      activeSession?.workspacePath,
      activeSessionHasTranscriptEvents,
      activeDraftKey,
      activeChatAttachments,
      activeChatDraft,
      activeChatMode,
      activeSessionGoal,
      activeSessionPlan,
      applyProviderChatResponse,
      chatMessageQueues,
      checkProviderReadiness,
      config,
      isStartingFirstTurn,
      notify,
      openWorkspace,
      replaceSendingSessionId,
      refreshEvents,
      resetChatDraft,
      saveSessionModel,
      setSessionSending,
      setEventsForSession,
      updateSessionTitle,
      workbench.ide.sourceControl,
      workbench.workspaceMode,
      workspacePath,
    ],
  );

  useEffect(() => {
    const pending = pendingPaneSendRef.current;
    if (!pending || activeChatPane?.paneId !== pending.paneId) return;
    pendingPaneSendRef.current = undefined;
    void sendDraft(pending.message);
  }, [activeChatPane?.paneId, sendDraft]);

  const handlePlanDecision = useCallback(
    async (decision: "approve" | "reject") => {
      if (decision === "reject") {
        notify(
          "terminal",
          "Plan kept",
          "Stay in Plan mode to revise it or ask another question.",
        );
        return true;
      }
      if (activeSessionPlan.items.length === 0) {
        return false;
      }
      const modeChanged = await changeChatMode("normal");
      if (!modeChanged) {
        return false;
      }
      return sendDraft("Implement the approved plan.", {
        goal: activeSessionGoal,
        mode: "normal",
        plan: activeSessionPlan,
        preserveDraft: true,
      });
    },
    [activeSessionGoal, activeSessionPlan, changeChatMode, notify, sendDraft],
  );

  useEffect(() => {
    if (
      !activeSessionId ||
      sendingSessionIdsRef.current.has(activeSessionId) ||
      queuedChatDispatchesRef.current.has(activeSessionId)
    ) {
      return undefined;
    }
    const nextMessage = chatMessageQueues[activeSessionId]?.find(
      (message) => message.status !== "failed",
    );
    if (!nextMessage) {
      return undefined;
    }
    const retryDelay = (nextMessage.retryAt ?? 0) - Date.now();
    if (retryDelay > 0) {
      const timer = window.setTimeout(
        () => setQueueRetryTick((current) => current + 1),
        retryDelay,
      );
      return () => window.clearTimeout(timer);
    }
    queuedChatDispatchesRef.current.add(activeSessionId);
    queuedChatDispatchMessageIdsRef.current.set(
      activeSessionId,
      nextMessage.id,
    );
    setChatMessageQueues((current) => {
      const remaining = (current[activeSessionId] ?? []).filter(
        (item) => item.id !== nextMessage.id,
      );
      if (remaining.length === 0) {
        const next = { ...current };
        delete next[activeSessionId];
        return next;
      }
      return { ...current, [activeSessionId]: remaining };
    });
    void sendDraft(nextMessage.message, {
      ...nextMessage.context,
      preserveDraft: true,
    })
      .then((accepted) => {
        if (!accepted) {
          const willRetry = (nextMessage.deliveryAttempts ?? 0) + 1 < 2;
          setChatMessageQueues((current) => {
            const queued = current[activeSessionId] ?? [];
            if (queued.some((item) => item.id === nextMessage.id)) {
              return current;
            }
            const deliveryAttempts = (nextMessage.deliveryAttempts ?? 0) + 1;
            const stableTurnId =
              nextMessage.context.retryTurnId ?? nextMessage.context.turnId;
            const didPersist = Boolean(
              stableTurnId && persistedChatTurnIdsRef.current.has(stableTurnId),
            );
            const shouldRetry = deliveryAttempts < 2;
            return {
              ...current,
              [activeSessionId]: [
                {
                  ...nextMessage,
                  context: {
                    ...nextMessage.context,
                    retryTurnId: didPersist ? stableTurnId : undefined,
                    turnId: didPersist ? undefined : stableTurnId,
                  },
                  deliveryAttempts,
                  retryAt: shouldRetry ? Date.now() + 1_500 : undefined,
                  status: shouldRetry ? "waiting" : "failed",
                },
                ...queued,
              ],
            };
          });
          notify(
            "command-failed",
            willRetry ? "Queued delivery delayed" : "Queued delivery failed",
            willRetry
              ? "Gyro kept the message and will retry it once."
              : "Gyro kept the message in the queue. Retry, edit, or delete it.",
          );
        }
      })
      .finally(() => {
        queuedChatDispatchesRef.current.delete(activeSessionId);
        queuedChatDispatchMessageIdsRef.current.delete(activeSessionId);
      });
    return undefined;
  }, [
    activeSessionId,
    chatMessageQueues,
    notify,
    queueRetryTick,
    sendDraft,
    sendingSessionIds,
  ]);

  const removeQueuedChatMessage = useCallback(
    (messageId: string) => {
      if (!activeSessionId) {
        return;
      }
      if (
        queuedChatDispatchMessageIdsRef.current.get(activeSessionId) ===
        messageId
      ) {
        notify(
          "terminal",
          "Message already sending",
          "Stop the active response if you do not want this queued turn to continue.",
        );
        return;
      }
      setChatMessageQueues((current) => {
        const remaining = (current[activeSessionId] ?? []).filter(
          (item) => item.id !== messageId,
        );
        if (remaining.length === 0) {
          const next = { ...current };
          delete next[activeSessionId];
          return next;
        }
        return { ...current, [activeSessionId]: remaining };
      });
    },
    [activeSessionId, notify],
  );

  const editQueuedChatMessage = useCallback(
    (messageId: string) => {
      if (!activeSessionId) {
        return;
      }
      if (
        queuedChatDispatchMessageIdsRef.current.get(activeSessionId) ===
        messageId
      ) {
        notify(
          "terminal",
          "Message already sending",
          "Stop the active response before editing this queued turn.",
        );
        return;
      }
      const selected = (chatMessageQueues[activeSessionId] ?? []).find(
        (item) => item.id === messageId,
      );
      if (!selected) {
        return;
      }
      setChatDrafts((current) => ({
        ...current,
        [activeDraftKey]: selected.message,
      }));
      setChatAttachments((current) => ({
        ...current,
        [activeDraftKey]: (selected.context.attachments ?? []).map(
          (attachment) => ({ ...attachment }),
        ),
      }));
      setChatMessageQueues((current) => {
        const remaining = (current[activeSessionId] ?? []).filter(
          (item) => item.id !== messageId,
        );
        if (remaining.length === 0) {
          const next = { ...current };
          delete next[activeSessionId];
          return next;
        }
        return { ...current, [activeSessionId]: remaining };
      });
      notify(
        "terminal",
        "Editing queued message",
        "The message is back in the composer.",
      );
    },
    [activeDraftKey, activeSessionId, chatMessageQueues, notify],
  );

  const handleProviderStatusAction = useCallback(
    (action: string, event: SessionEvent) => {
      const payload = recordFromUnknown(event.payload);
      const providerId = stringFromRecord(payload, "providerId");
      const turnId = turnIdFromSessionEvent(event);
      const userEvent = turnId
        ? eventsRef.current.find(
            (item) =>
              item.kind === "user-message" &&
              (turnIdFromSessionEvent(item) ?? item.id) === turnId,
          )
        : undefined;
      const userMessage =
        userEvent?.message ??
        stringFromRecord(payload, "userMessage") ??
        stringFromRecord(payload, "messagePreview");

      if (action === "show-capability") {
        const activity = capabilityActivityFromSessionEvent(event);
        if (!activity?.resource) return;
        selectSession(event.sessionId);
        const session = sessions.find((item) => item.id === event.sessionId);
        if (session) setWorkspacePath(session.workspacePath);
        if (activity.resource.kind === "terminal") {
          const terminalData = capabilityResourceDataByCallId[activity.callId];
          const snapshot = terminalSnapshotFromCapabilityData(terminalData);
          if (snapshot) {
            dispatchWorkbench({
              type: "select-terminal-pane",
              paneId: snapshot.paneId,
            });
            dispatchWorkbench({ type: "open-tool-panel", tab: "terminal" });
          }
        } else if (activity.resource.kind === "browser") {
          const browser = browserResourcesBySessionId[event.sessionId];
          if (browser) {
            dispatchWorkbench({ type: "browser-navigate", url: browser.url });
            dispatchWorkbench({ type: "open-tool-panel", tab: "browser" });
          }
        } else {
          const path = activity.resource.label;
          if (path && activity.resource.kind === "ide") {
            const ideData = recordFromUnknown(
              capabilityResourceDataByCallId[activity.callId],
            );
            const filePath = stringFromRecord(ideData, "path") ?? path;
            const line = typeof ideData?.line === "number" ? ideData.line : 1;
            const column =
              typeof ideData?.column === "number" ? ideData.column : 1;
            setSelectedFile(filePath);
            dispatchWorkbench({
              type: "ide-open-tab",
              tab: {
                path: filePath,
                title: workspaceName(filePath),
                dirty: false,
                preview: true,
              },
            });
            setEditorRevealTarget({
              path: filePath,
              lineNumber: Math.max(1, line),
              column: Math.max(1, column),
              nonce: Date.now(),
            });
            dispatchWorkbench({
              type: "select-workspace-layout",
              layout: "code",
            });
          } else if (path && activity.resource.kind === "workspace") {
            setSelectedFile(path);
            dispatchWorkbench({
              type: "ide-open-tab",
              tab: {
                path,
                title: workspaceName(path),
                dirty: false,
                preview: true,
              },
            });
            dispatchWorkbench({
              type: "select-workspace-layout",
              layout: "code",
            });
          }
        }
        return;
      }

      if (action === "stop-capability") {
        const activity = capabilityActivityFromSessionEvent(event);
        if (!activity?.resource || !isTauriRuntime()) return;
        const resourceLabel = activity.resource.label;
        const resourceId = activity.resource.id;
        void invoke("stop_model_terminal_resource", {
          sessionId: event.sessionId,
          resourceId,
        })
          .then(() => {
            liveCapabilityResourceIdsRef.current.delete(resourceId);
            const terminalData =
              capabilityResourceDataByCallId[activity.callId];
            const snapshot = terminalSnapshotFromCapabilityData(terminalData);
            if (snapshot) {
              dispatchWorkbench({
                type: "set-terminal-pane-status",
                paneId: snapshot.paneId,
                status: "done",
                event: "Stopped by user",
              });
            }
            notify("terminal", "Model process stopped", resourceLabel);
          })
          .catch((error) =>
            notify(
              "command-failed",
              "Could not stop model process",
              String(error),
            ),
          );
        return;
      }

      if (action === "open-providers") {
        dispatchWorkbench({
          type: "select-destination",
          destination: "providers",
        });
        return;
      }

      if (action === "reconnect-provider" && isProviderId(providerId)) {
        connectProvider(providerId);
        return;
      }

      if (action === "retry-send" && userMessage) {
        if (turnId) {
          setChatMessageQueues((current) => {
            const queued = current[event.sessionId] ?? [];
            const remaining = queued.filter(
              (item) =>
                item.context.retryTurnId !== turnId &&
                item.context.turnId !== turnId,
            );
            if (remaining.length === queued.length) return current;
            const next = { ...current };
            if (remaining.length) next[event.sessionId] = remaining;
            else delete next[event.sessionId];
            return next;
          });
        }
        const userPayload = recordFromUnknown(userEvent?.payload);
        const attachments = Array.isArray(userPayload?.attachments)
          ? (userPayload.attachments as ChatAttachment[])
          : Array.isArray(payload?.attachments)
            ? (payload.attachments as ChatAttachment[])
            : [];
        const goalRecord = recordFromUnknown(payload?.goal);
        const planRecord = recordFromUnknown(payload?.plan);
        void sendDraft(userMessage, {
          retryTurnId: turnId,
          mode:
            stringFromRecord(payload, "chatMode") === "plan"
              ? "plan"
              : "normal",
          attachments,
          goal:
            goalRecord && stringFromRecord(goalRecord, "text")
              ? {
                  text: stringFromRecord(goalRecord, "text")!,
                  status:
                    stringFromRecord(goalRecord, "status") === "complete"
                      ? "complete"
                      : "active",
                }
              : undefined,
          plan:
            planRecord && Array.isArray(planRecord.items)
              ? (planRecord as unknown as SessionPlan)
              : undefined,
        });
      }
    },
    [
      browserResourcesBySessionId,
      capabilityResourceDataByCallId,
      connectProvider,
      notify,
      selectSession,
      sendDraft,
      sessions,
    ],
  );

  const handleMutationApprovalAction = useCallback(
    async (proposalId: string, decision: "approve" | "reject") => {
      if (!activeSessionId || !isTauriRuntime()) {
        return;
      }
      try {
        const result = await invoke<{
          proposal: { path: string; status: string };
        }>("resolve_file_mutation_proposal", {
          request: { proposalId, decision },
        });
        await refreshEvents(activeSessionId);
        if (result.proposal.status === "applied") {
          await refreshWorkspaceTree();
          refreshIdeSourceControl(
            activeSession?.workspacePath ?? workspacePath,
          );
          notify("diff-ready", "Change applied", result.proposal.path);
        } else if (result.proposal.status === "rejected") {
          notify("approval", "Change rejected", result.proposal.path);
        } else if (result.proposal.status === "failed") {
          notify(
            "command-failed",
            "Change needs a new review",
            result.proposal.path,
          );
        }
      } catch (error) {
        notify(
          "command-failed",
          "Could not resolve change",
          error instanceof Error ? error.message : String(error),
        );
        await refreshEvents(activeSessionId);
      }
    },
    [
      activeSession?.workspacePath,
      activeSessionId,
      notify,
      refreshEvents,
      refreshIdeSourceControl,
      refreshWorkspaceTree,
      workspacePath,
    ],
  );

  const handleProviderApprovalAction = useCallback(
    async (
      approvalId: string,
      decision: "approve" | "reject" | "allow-project",
    ) => {
      if (!isTauriRuntime()) return;
      const approvalEvent = Object.values(sessionEventsById)
        .flat()
        .find((event) => {
          const payload = recordFromUnknown(event.payload);
          return stringFromRecord(payload, "approvalId") === approvalId;
        });
      const capabilityApproval = approvalEvent
        ? capabilityApprovalFromSessionEvent(approvalEvent)
        : undefined;
      const ownerSessionId = approvalEvent?.sessionId ?? activeSessionId;
      if (!ownerSessionId) return;
      try {
        if (capabilityApproval && approvalEvent) {
          const capabilityDecision: CapabilityApprovalDecision =
            decision === "reject"
              ? "deny"
              : decision === "allow-project"
                ? "allow-project"
                : "allow-once";
          await invoke("resolve_capability_approval", {
            request: {
              approvalId,
              sessionId: approvalEvent.sessionId,
              turnId: approvalEvent.turnId,
              decision: capabilityDecision,
            },
          });
          notify(
            "approval",
            capabilityDecision === "deny"
              ? "Capability denied"
              : capabilityDecision === "allow-project"
                ? "Capability allowed for project"
                : "Capability allowed once",
            capabilityApproval.capabilityId.replaceAll("-", " "),
          );
          await refreshEvents(ownerSessionId);
          return;
        }
        const event = await invoke<SessionEvent>("resolve_provider_approval", {
          request: {
            approvalId,
            decision: decision === "reject" ? "reject" : "approve",
          },
        });
        const changedPaths = (
          event.payload as { changedPaths?: unknown } | undefined
        )?.changedPaths;
        if (decision !== "reject" && Array.isArray(changedPaths)) {
          await refreshWorkspaceTree();
          refreshIdeSourceControl(
            activeSession?.workspacePath ?? workspacePath ?? undefined,
          );
        }
        notify(
          "approval",
          decision !== "reject"
            ? "Provider action approved"
            : "Provider action rejected",
          decision !== "reject"
            ? "The turn is continuing"
            : "The provider will continue without it",
        );
      } catch (error) {
        notify(
          "command-failed",
          "Could not resolve provider action",
          error instanceof Error ? error.message : String(error),
        );
        await refreshEvents(ownerSessionId);
      }
    },
    [
      activeSession?.workspacePath,
      activeSessionId,
      notify,
      refreshEvents,
      refreshIdeSourceControl,
      refreshWorkspaceTree,
      sessionEventsById,
      workspacePath,
    ],
  );

  const stopActiveChat = useCallback(() => {
    if (
      !activeSessionId ||
      !sendingSessionIdsRef.current.has(activeSessionId)
    ) {
      notify(
        "terminal",
        "No active turn",
        "There is no provider process to stop",
      );
      return;
    }
    void invoke("stop_provider_chat", { sessionId: activeSessionId }).catch(
      (error) => notify("command-failed", "Stop failed", String(error)),
    );
  }, [activeSessionId, notify]);

  const steerQueuedChatMessage = useCallback(
    (messageId: string) => {
      if (!activeSessionId) {
        return;
      }
      setChatMessageQueues((current) => {
        const queued = current[activeSessionId] ?? [];
        const selected = queued.find((item) => item.id === messageId);
        if (!selected) {
          return current;
        }
        return {
          ...current,
          [activeSessionId]: [
            {
              ...selected,
              deliveryAttempts: 0,
              retryAt: undefined,
              status: "waiting",
            },
            ...queued.filter((item) => item.id !== messageId),
          ],
        };
      });
      if (sendingSessionIdsRef.current.has(activeSessionId)) {
        stopActiveChat();
      }
      notify(
        "terminal",
        "Steering next",
        "Stopping the current response, then sending this message.",
      );
    },
    [activeSessionId, notify, stopActiveChat],
  );

  const appendPlanEvent = useCallback(
    async (payload: Record<string, unknown>, message = "Plan updated") => {
      if (!activeSessionId) {
        notify("command-failed", "No active session", "Start a chat first");
        return;
      }
      const event = createPlanSessionEvent(activeSessionId, message, payload);
      if (!isTauriRuntime()) {
        setEvents((current) => [...current, event]);
        return;
      }
      try {
        await invoke<SessionEvent>("append_plan_event", {
          sessionId: activeSessionId,
          message,
          payload,
        });
        await refreshEvents(activeSessionId);
      } catch {
        setEvents((current) => [...current, event]);
        notify("command-failed", "Plan update fallback", message);
      }
    },
    [activeSessionId, notify, refreshEvents],
  );

  const appendGoalEvent = useCallback(
    async (payload: Record<string, unknown>, message: string) => {
      if (!activeSessionId) {
        notify("command-failed", "No active session", "Start a chat first");
        return;
      }
      const event = createGoalSessionEvent(activeSessionId, message, payload);
      if (!isTauriRuntime()) {
        setEvents((current) => [...current, event]);
        return;
      }
      try {
        await invoke<SessionEvent>("append_chat_context_event", {
          sessionId: activeSessionId,
          eventKind: "goal-updated",
          message,
          payload,
        });
        await refreshEvents(activeSessionId);
      } catch {
        setEvents((current) => [...current, event]);
        notify("command-failed", "Goal update fallback", message);
      }
    },
    [activeSessionId, notify, refreshEvents],
  );

  const appendEditorEvent = useCallback(
    async (
      eventKind: string,
      message: string,
      payload: Record<string, unknown>,
    ) => {
      if (!activeSessionId) {
        return;
      }
      const event = createEditorSessionEvent(
        activeSessionId,
        eventKind,
        message,
        payload,
      );
      if (!isTauriRuntime()) {
        setEvents((current) => [...current, event]);
        return;
      }
      try {
        await invoke<SessionEvent>("append_editor_event", {
          sessionId: activeSessionId,
          eventKind,
          message,
          payload,
        });
        await refreshEvents(activeSessionId);
      } catch {
        setEvents((current) => [...current, event]);
      }
    },
    [activeSessionId, refreshEvents],
  );

  const openEditorFile = useCallback(
    (path: string) => {
      const entry = files.find((file) => file.path === path);
      if (entry?.kind === "directory") {
        return;
      }
      setSelectedFile(path);
      dispatchWorkbench({
        type: "ide-open-tab",
        tab: {
          path,
          title: workspaceName(path),
          dirty: false,
          preview: true,
        },
      });
      void appendEditorEvent("editor-file-opened", `Opened ${path}`, {
        path,
      });
    },
    [appendEditorEvent, files],
  );

  const openEditorLocation = useCallback(
    (path: string, lineNumber = 1, column = 1) => {
      openEditorFile(path);
      setEditorRevealTarget({
        path,
        lineNumber: Math.max(1, lineNumber),
        column: Math.max(1, column),
        nonce: Date.now(),
      });
    },
    [openEditorFile],
  );

  const closeEditorTab = useCallback(
    (path: string, groupId?: string) => {
      const groupsWithPath = workbench.ide.layout.groups.filter((group) =>
        group.tabs.some((tab) => tab.path === path),
      );
      const closesLastReference = !groupId || groupsWithPath.length <= 1;
      if (
        closesLastReference &&
        workbench.ide.buffers[path]?.status === "dirty" &&
        !window.confirm(`Discard unsaved changes in ${workspaceName(path)}?`)
      ) {
        return;
      }
      dispatchWorkbench({ type: "ide-close-tab", path, groupId });
      if (closesLastReference) {
        disposeEditorModels([path]);
      }
      if (
        selectedFile === path &&
        (!groupId || groupId === workbench.ide.layout.activeGroupId)
      ) {
        const nextPath = groupId
          ? (workbench.ide.layout.groups
              .find((group) => group.id === groupId)
              ?.tabs.filter((tab) => tab.path !== path)
              .at(-1)?.path ??
            workbench.ide.layout.groups.find(
              (group) =>
                group.id !== groupId &&
                group.tabs.some((tab) => tab.path === path),
            )?.activePath)
          : workbench.ide.tabs.filter((tab) => tab.path !== path).at(-1)?.path;
        setSelectedFile(nextPath);
      }
    },
    [
      selectedFile,
      workbench.ide.buffers,
      workbench.ide.layout.activeGroupId,
      workbench.ide.layout.groups,
      workbench.ide.tabs,
    ],
  );

  const closeEditorGroup = useCallback(
    (groupId: string) => {
      const group = workbench.ide.layout.groups.find(
        (item) => item.id === groupId,
      );
      if (!group) {
        return;
      }
      const remaining = workbench.ide.layout.groups.filter(
        (item) => item.id !== groupId,
      );
      const pathsStillOpen = new Set(
        remaining.flatMap((item) => item.tabs.map((tab) => tab.path)),
      );
      const dirtyPaths = group.tabs
        .map((tab) => tab.path)
        .filter(
          (path) =>
            !pathsStillOpen.has(path) &&
            workbench.ide.buffers[path]?.status === "dirty",
        );
      if (
        dirtyPaths.length > 0 &&
        !window.confirm(
          dirtyPaths.length === 1
            ? `Discard unsaved changes in ${workspaceName(dirtyPaths[0] ?? "file")}?`
            : `Discard unsaved changes in ${dirtyPaths.length} files?`,
        )
      ) {
        return;
      }
      const nextGroup =
        remaining.find(
          (item) => item.id === workbench.ide.layout.activeGroupId,
        ) ?? remaining[0];
      dispatchWorkbench({ type: "ide-close-group", groupId });
      disposeEditorModels(
        group.tabs
          .map((tab) => tab.path)
          .filter((path) => !pathsStillOpen.has(path)),
      );
      if (groupId === workbench.ide.layout.activeGroupId) {
        setSelectedFile(nextGroup?.activePath);
      }
    },
    [workbench.ide.buffers, workbench.ide.layout],
  );

  const pinEditorTab = useCallback((path: string) => {
    dispatchWorkbench({ type: "ide-pin-tab", path });
  }, []);

  const updateEditorBuffer = useCallback((path: string, content: string) => {
    dispatchWorkbench({ type: "ide-update-buffer", path, content });
  }, []);

  const saveEditorBuffer = useCallback(
    async (path: string) => {
      const buffer = workbench.ide.buffers[path];
      const root = activeSession?.workspacePath ?? workspacePath;
      if (!buffer || !root) {
        notify("command-failed", "Save blocked", "Open a workspace first");
        return;
      }
      if (!isTauriRuntime()) {
        dispatchWorkbench({
          type: "ide-mark-buffer-saved",
          path,
          content: buffer.content,
          contentHash: buffer.contentHash,
          sizeBytes: buffer.content.length,
        });
        setSelectedFileContent({
          path,
          content: buffer.content,
          contentHash: buffer.contentHash,
          sizeBytes: buffer.content.length,
          truncated: false,
        });
        void appendEditorEvent("file-write-approved", `Saved ${path}`, {
          path,
          preview: true,
        });
        return;
      }
      try {
        const saved = await invoke<WorkspaceFileContent>(
          "write_workspace_file",
          {
            request: {
              workspacePath: root,
              path,
              content: buffer.content,
              expectedHash: buffer.contentHash,
            } satisfies WorkspaceFileWriteRequest,
          },
        );
        dispatchWorkbench({
          type: "ide-mark-buffer-saved",
          path,
          content: saved.content,
          contentHash: saved.contentHash,
          sizeBytes: saved.sizeBytes,
        });
        setSelectedFileContent(saved);
        notify("tests-passed", "File saved", path);
        void appendEditorEvent("file-write-approved", `Saved ${path}`, {
          path,
          contentHash: saved.contentHash,
        });
      } catch (error) {
        const detail = String(error);
        dispatchWorkbench({
          type: "ide-mark-buffer-error",
          path,
          error: detail,
        });
        notify("command-failed", "Save failed", detail);
        void appendEditorEvent(
          "file-write-rejected",
          `Save rejected for ${path}`,
          {
            path,
            error: detail,
          },
        );
      }
    },
    [
      activeSession?.workspacePath,
      appendEditorEvent,
      notify,
      workbench.ide.buffers,
      workspacePath,
    ],
  );

  const revertEditorBuffer = useCallback(
    (path: string) => {
      const buffer = workbench.ide.buffers[path];
      if (!buffer) {
        return;
      }
      dispatchWorkbench({
        type: "ide-upsert-buffer",
        buffer: {
          ...buffer,
          content: buffer.savedContent,
          error: undefined,
          status: "ready",
          updatedAt: new Date().toISOString(),
        },
      });
    },
    [workbench.ide.buffers],
  );

  const setEditorSelection = useCallback((selection?: EditorSelection) => {
    dispatchWorkbench({ type: "ide-set-selection", selection });
  }, []);

  const runEditorAssistantAction = useCallback(
    (action: IdeAssistantAction, instruction: string) => {
      if (!checkProviderReadiness("chat")) {
        return;
      }
      const path = workbench.ide.activePath ?? selectedFile;
      const selection =
        workbench.ide.selection?.path === path
          ? workbench.ide.selection
          : undefined;
      const provider = providersForConfig(config).find(
        (item) => item.id === config.selectedProviderId,
      );
      const request: IdeAssistantRequest = {
        id: `ide-ai-${Date.now()}`,
        action,
        instruction,
        path,
        selection,
        visibleTabs: workbench.ide.tabs.map((tab) => tab.path),
        providerId: provider?.id,
        model: provider?.selectedModelId,
        createdAt: new Date().toISOString(),
      };
      dispatchWorkbench({ type: "ide-record-assistant-request", request });
      void appendEditorEvent("ai-editor-requested", `AI ${action}`, {
        request,
      });
      const context = [
        `Workspace action: ${action}`,
        path ? `File: ${path}` : undefined,
        selection?.text ? `Selected code:\n${selection.text}` : undefined,
        instruction,
      ]
        .filter(Boolean)
        .join("\n\n");
      void sendDraft(context);
      if (
        action === "fix-selection" ||
        action === "refactor-file" ||
        action === "generate-tests" ||
        action === "apply-proposed-edit"
      ) {
        const targetPath = path ?? "workspace";
        dispatchWorkbench({
          type: "sync-diff-event",
          path: targetPath,
          message: `AI edit requested: ${instruction}`,
          source: "agent-generated",
          turnId: workbench.activeTurn?.id,
        });
        void appendEditorEvent(
          "ai-edit-proposed",
          `AI edit proposed for ${targetPath}`,
          {
            request,
            path: targetPath,
          },
        );
      }
    },
    [
      appendEditorEvent,
      checkProviderReadiness,
      config,
      selectedFile,
      sendDraft,
      workbench.activeTurn?.id,
      workbench.ide.activePath,
      workbench.ide.selection,
      workbench.ide.tabs,
    ],
  );

  const changePlanItemStatus = useCallback(
    (itemId: string, status: SessionPlanItemStatus) => {
      const item = activeSessionPlan.items.find((entry) => entry.id === itemId);
      void appendPlanEvent(
        {
          action: "update-item",
          item: { id: itemId, status },
          source: "user",
          turnId: workbench.activeTurn?.id,
        },
        `Plan item ${planStatusVerb(status)}: ${item?.title ?? itemId}`,
      );
    },
    [activeSessionPlan.items, appendPlanEvent, workbench.activeTurn?.id],
  );

  const changePlan = useCallback(
    (
      action: "add" | "edit" | "remove" | "move-up" | "move-down",
      itemId?: string,
      value?: string,
    ) => {
      const item = activeSessionPlan.items.find((entry) => entry.id === itemId);
      if (action === "add") {
        const title = value?.trim();
        if (title && !activeSessionId) {
          const now = new Date().toISOString();
          setPendingNewChatPlan((current) => ({
            ...current,
            items: [
              ...current.items,
              {
                id: crypto.randomUUID(),
                title,
                status: "todo",
                createdAt: now,
                updatedAt: now,
              },
            ],
          }));
        } else if (title)
          void appendPlanEvent(
            {
              action: "add-item",
              item: { id: crypto.randomUUID(), title, status: "todo" },
            },
            `Plan item added: ${title}`,
          );
        return;
      }
      if (!item) return;
      if (!activeSessionId) {
        setPendingNewChatPlan((current) => {
          if (action === "edit") {
            const title = value?.trim();
            return title
              ? {
                  ...current,
                  items: current.items.map((entry) =>
                    entry.id === item.id
                      ? { ...entry, title, updatedAt: new Date().toISOString() }
                      : entry,
                  ),
                }
              : current;
          }
          if (action === "remove")
            return {
              ...current,
              items: current.items.filter((entry) => entry.id !== item.id),
            };
          const index = current.items.findIndex(
            (entry) => entry.id === item.id,
          );
          const target = action === "move-up" ? index - 1 : index + 1;
          if (target < 0 || target >= current.items.length) return current;
          const items = [...current.items];
          const [moved] = items.splice(index, 1);
          if (!moved) return current;
          items.splice(target, 0, moved);
          return { ...current, items };
        });
        return;
      }
      if (action === "edit") {
        const title = value?.trim();
        if (title)
          void appendPlanEvent(
            { action: "update-item", item: { ...item, title } },
            `Plan item edited: ${title}`,
          );
        return;
      }
      if (action === "remove") {
        void appendPlanEvent(
          { action: "remove-item", item: { id: item.id } },
          `Plan item removed: ${item.title}`,
        );
        return;
      }
      const index = activeSessionPlan.items.findIndex(
        (entry) => entry.id === item.id,
      );
      const target = action === "move-up" ? index - 1 : index + 1;
      if (target < 0 || target >= activeSessionPlan.items.length) return;
      const items = [...activeSessionPlan.items];
      const [moved] = items.splice(index, 1);
      if (!moved) return;
      items.splice(target, 0, moved);
      void appendPlanEvent(
        { action: "replace", items },
        `Plan item reordered: ${item.title}`,
      );
    },
    [activeSessionId, activeSessionPlan.items, appendPlanEvent],
  );

  const changeGoal = useCallback(
    (
      action: "set" | "edit" | "complete" | "reopen" | "clear",
      value?: string,
    ) => {
      if (action !== "set" && !activeSessionGoal) return;
      const text =
        action === "set" || action === "edit"
          ? value?.trim()
          : activeSessionGoal?.text;
      if ((action === "set" || action === "edit") && !text) return;
      const status =
        action === "complete"
          ? "complete"
          : action === "set" || action === "reopen"
            ? "active"
            : (activeSessionGoal?.status ?? "active");
      if (!activeSessionId) {
        if (action === "set" || action === "edit") {
          setPendingNewChatMode("normal");
        }
        setPendingNewChatGoal(
          action === "clear"
            ? undefined
            : {
                ...activeSessionGoal,
                text: text!,
                status,
              },
        );
        return;
      }
      const payload =
        action === "clear"
          ? { action: "clear" }
          : {
              action: "set",
              text,
              status,
            };
      const message =
        action === "clear"
          ? "Goal cleared"
          : action === "complete"
            ? `Goal completed: ${text}`
            : action === "reopen"
              ? `Goal reopened: ${text}`
              : action === "set"
                ? `Goal set: ${text}`
                : `Goal updated: ${text}`;
      void (async () => {
        if (
          (action === "set" || action === "edit") &&
          activeChatMode === "plan"
        ) {
          const modeChanged = await changeChatMode("normal");
          if (!modeChanged) {
            return;
          }
        }
        await appendGoalEvent(payload, message);
      })();
    },
    [
      activeChatMode,
      activeSessionGoal,
      activeSessionId,
      appendGoalEvent,
      changeChatMode,
    ],
  );

  const syncTerminalSnapshot = useCallback((snapshot: TerminalPaneSnapshot) => {
    const status = terminalStatusFromSnapshot(snapshot.status);
    const selectedPaneId = selectedTerminalPaneIdRef.current;
    const currentPane = terminalPanesRef.current.find(
      (pane) => pane.id === snapshot.paneId,
    );
    const output = snapshot.output ?? currentPane?.output ?? "";
    terminalOutputRevisionRef.current[snapshot.paneId] =
      snapshot.outputRevision;
    dispatchWorkbench({
      type: "sync-terminal-pane-snapshot",
      paneId: snapshot.paneId,
      command: snapshot.command,
      projectPath: snapshot.workspacePath,
      workingDirectory: snapshot.workingDirectory,
      event:
        snapshot.exitCode === null || snapshot.exitCode === undefined
          ? snapshot.status
          : `${snapshot.status} (${snapshot.exitCode})`,
      output,
      status,
      hasForegroundJob: snapshot.hasForegroundJob ?? undefined,
    });
    if (
      snapshot.output !== undefined &&
      snapshot.output !== null &&
      (!selectedPaneId || selectedPaneId === snapshot.paneId)
    ) {
      setTerminalOutput((current) => (current === output ? current : output));
    }
  }, []);

  const refreshTerminalPane = useCallback(
    async (paneId: string) => {
      if (!isTauriRuntime()) {
        return;
      }
      if (terminalReadInFlightRef.current.has(paneId)) {
        return;
      }
      terminalReadInFlightRef.current.add(paneId);
      try {
        const snapshot = await invoke<TerminalPaneSnapshot>(
          "read_terminal_output",
          {
            paneId,
            knownOutputRevision: terminalOutputRevisionRef.current[paneId],
          },
        );
        syncTerminalSnapshot(snapshot);
      } catch (error) {
        if (terminalPaneProcessIsMissing(error)) {
          dispatchWorkbench({
            type: "set-terminal-pane-status",
            paneId,
            status: "restored",
            event: "not running",
          });
        } else {
          notify("command-failed", "Terminal read failed", paneId);
        }
      } finally {
        terminalReadInFlightRef.current.delete(paneId);
      }
    },
    [notify, syncTerminalSnapshot],
  );

  const writeTerminalInputToPane = useCallback(
    async (paneId: string, input: string) => {
      if (!paneId) {
        return;
      }
      if (!isTauriRuntime()) {
        const pane = workbench.terminalPanes.find((item) => item.id === paneId);
        dispatchWorkbench({
          type: "sync-terminal-pane-snapshot",
          paneId,
          event: "input queued",
          output: `${pane?.output ?? ""}${pane?.output ? "\n" : ""}${input}`,
          status: pane?.status ?? "running",
        });
        setTerminalOutput(
          (current) => `${current}${current ? "\n" : ""}${input}`,
        );
        return;
      }
      try {
        const snapshot = await invoke<TerminalPaneSnapshot>(
          "write_terminal_input",
          { input, paneId },
        );
        syncTerminalSnapshot(snapshot);
        window.setTimeout(() => {
          void refreshTerminalPane(paneId);
        }, 200);
      } catch {
        notify("command-failed", "Terminal input failed", paneId);
      }
    },
    [
      notify,
      refreshTerminalPane,
      syncTerminalSnapshot,
      workbench.terminalPanes,
    ],
  );

  const writeTerminalInput = useCallback(
    async (input: string) => {
      const paneId = workbench.selectedTerminalPaneId;
      if (!paneId) {
        return;
      }
      await writeTerminalInputToPane(paneId, input);
    },
    [workbench.selectedTerminalPaneId, writeTerminalInputToPane],
  );

  const runProfile = useCallback(
    async (profileId = activeProfileId, commandOverride?: string) => {
      const profile = getCommandProfile(commandProfiles, profileId);
      const process = terminalProcessForProfile(profile, commandOverride);
      const paneId = workbench.selectedTerminalPaneId || `pane-${Date.now()}`;
      const output = `Starting ${profile.displayName}: ${process.displayCommand}`;
      const started = await launchTerminalPane({
        commandOverride,
        paneId,
        profile,
        startingOutput: output,
      });
      if (started) {
        window.setTimeout(() => {
          void refreshTerminalPane(paneId);
        }, 350);
      } else {
        notify("command-failed", "Terminal start failed", profile.displayName);
      }
    },
    [
      activeProfileId,
      commandProfiles,
      launchTerminalPane,
      notify,
      refreshTerminalPane,
      workbench.selectedTerminalPaneId,
    ],
  );

  const runCommandProfile = useCallback(
    (profileId: string) => {
      setActiveProfileId(profileId);
      void runProfile(profileId);
    },
    [runProfile],
  );

  const launchCliPreset = useCallback(async () => {
    const preset = normalizeCliLaunchPreset(
      workbench.preferences.cliLaunchPreset,
      commandProfiles,
    );
    const launches = preset.entries.flatMap((entry) => {
      const profile = getCommandProfile(commandProfiles, entry.profileId);
      return Array.from({ length: entry.count }, () => profile);
    });
    if (
      launches.length === 0 ||
      launches.length > CLI_LAUNCH_PRESET_MAX_PANES ||
      isLaunchingCliPreset
    ) {
      return;
    }

    setIsLaunchingCliPreset(true);
    const paneIds: string[] = [];
    let failures = 0;
    try {
      for (const [index, profile] of launches.entries()) {
        const paneId = `pane-${Date.now()}-${index}`;
        paneIds.push(paneId);
        const started = await launchTerminalPane({
          paneId,
          profile,
          startingOutput: "",
        });
        if (!started) {
          failures += 1;
        }
      }
    } finally {
      setIsLaunchingCliPreset(false);
    }

    const focusedPaneId =
      preset.focus === "last" ? paneIds[paneIds.length - 1] : paneIds[0];
    if (focusedPaneId) {
      dispatchWorkbench({
        type: "select-terminal-pane",
        paneId: focusedPaneId,
      });
    }
    notify(
      failures > 0 ? "command-failed" : "terminal",
      failures > 0 ? "Preset partially started" : "Preset started",
      failures > 0
        ? `${launches.length - failures}/${launches.length} panes running`
        : `${launches.length} pane${launches.length === 1 ? "" : "s"} running`,
    );
  }, [
    commandProfiles,
    isLaunchingCliPreset,
    launchTerminalPane,
    notify,
    workbench.preferences.cliLaunchPreset,
  ]);

  const stopTerminalPane = useCallback(
    async (paneId: string) => {
      if (!isTauriRuntime()) {
        dispatchWorkbench({
          type: "set-terminal-pane-status",
          paneId,
          status: "failed",
          event: "killed",
        });
        return;
      }
      try {
        const snapshot = await invoke<TerminalPaneSnapshot>(
          "stop_terminal_pane",
          { paneId },
        );
        syncTerminalSnapshot(snapshot);
      } catch {
        notify("command-failed", "Terminal stop failed", paneId);
      }
    },
    [notify, syncTerminalSnapshot],
  );

  const closeTerminalPane = useCallback(async (paneId: string) => {
    if (isTauriRuntime()) {
      try {
        await invoke("close_terminal_pane", { paneId });
      } catch {
        // Closing the UI should still succeed if the backing PTY is already gone.
      }
    }
    setTerminalSourceControlByPane((current) => {
      if (!(paneId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    dispatchWorkbench({ type: "remove-terminal-pane", paneId });
  }, []);

  const requestCloseTerminalPane = useCallback(
    async (paneId: string) => {
      const pane = workbench.terminalPanes.find((item) => item.id === paneId);
      if (!pane) {
        return;
      }
      if (pane.status === "running" || pane.status === "waiting") {
        if (isPlainShellTerminal(pane)) {
          if (!isTauriRuntime()) {
            await closeTerminalPane(paneId);
            return;
          }
          try {
            const hasForegroundJob = await invoke<boolean>(
              "terminal_pane_has_foreground_job",
              { paneId },
            );
            if (!hasForegroundJob) {
              await closeTerminalPane(paneId);
              return;
            }
          } catch (error) {
            if (terminalPaneProcessIsMissing(error)) {
              await closeTerminalPane(paneId);
              return;
            }
            // If activity cannot be determined, keep the protective confirmation.
          }
        }
        setTerminalTerminateCandidate(pane);
        return;
      }
      await closeTerminalPane(paneId);
    },
    [closeTerminalPane, workbench.terminalPanes],
  );

  const confirmTerminateTerminal = useCallback(() => {
    if (!terminalTerminateCandidate) {
      return;
    }
    const paneId = terminalTerminateCandidate.id;
    setTerminalTerminateCandidate(undefined);
    void closeTerminalPane(paneId);
  }, [closeTerminalPane, terminalTerminateCandidate]);

  const restartTerminalPane = useCallback(
    async (paneId: string) => {
      if (!isTauriRuntime()) {
        dispatchWorkbench({
          type: "set-terminal-pane-status",
          paneId,
          status: "running",
          event: "restarted",
        });
        return;
      }
      try {
        const snapshot = await invoke<TerminalPaneSnapshot>(
          "restart_terminal_pane",
          { paneId },
        );
        syncTerminalSnapshot(snapshot);
      } catch (error) {
        const pane = workbench.terminalPanes.find((item) => item.id === paneId);
        if (!pane) {
          notify("command-failed", "Terminal restart failed", paneId);
          return;
        }
        const profile = getCommandProfile(
          commandProfiles,
          pane.profileId || activeProfileId,
        );
        const process = terminalProcessForProfile(profile);
        const started = await launchTerminalPane({
          paneId,
          profile,
          startingOutput: `Reconnecting ${profile.displayName}: ${process.displayCommand}`,
        });
        if (!started) {
          dispatchWorkbench({
            type: "set-terminal-pane-status",
            paneId,
            status: "failed",
            event: "process failed to reconnect",
          });
          notify("command-failed", "Terminal restart failed", String(error));
        }
      }
    },
    [
      activeProfileId,
      commandProfiles,
      launchTerminalPane,
      notify,
      syncTerminalSnapshot,
      workbench.terminalPanes,
    ],
  );

  const resizeTerminalPane = useCallback(
    async (paneId: string, cols: number, rows: number) => {
      if (!isTauriRuntime()) {
        return;
      }
      try {
        const snapshot = await invoke<TerminalPaneSnapshot>(
          "resize_terminal_pane",
          { cols, paneId, rows },
        );
        syncTerminalSnapshot(snapshot);
      } catch {
        notify("command-failed", "Terminal resize failed", paneId);
      }
    },
    [notify, syncTerminalSnapshot],
  );

  const setTerminalTemplate = useCallback(
    async (template: TerminalTemplate) => {
      dispatchWorkbench({ type: "set-terminal-template", template });
      const paneId = workbench.selectedTerminalPaneId;
      if (!isTauriRuntime() || !paneId) {
        return;
      }
      const size = terminalSizeForTemplate(template);
      try {
        const snapshot = await invoke<TerminalPaneSnapshot>(
          "resize_terminal_pane",
          { cols: size.cols, paneId, rows: size.rows },
        );
        syncTerminalSnapshot(snapshot);
      } catch {
        notify("command-failed", "Terminal resize failed", paneId);
      }
    },
    [notify, syncTerminalSnapshot, workbench.selectedTerminalPaneId],
  );

  const handleTerminalUtilityAction = useCallback(
    (action: string) => {
      if (action === "read-screen" && workbench.selectedTerminalPaneId) {
        void refreshTerminalPane(workbench.selectedTerminalPaneId);
        return;
      }
      notify("terminal", "Terminal action", action);
    },
    [notify, refreshTerminalPane, workbench.selectedTerminalPaneId],
  );

  const openBrowserPreviewExternal = useCallback(async () => {
    try {
      const url = normalizedPreviewUrl(workbench.browserPreview.url);
      if (isTauriRuntime()) {
        await openUrl(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      notify("terminal", "Opened in browser", url);
    } catch (error) {
      notify("command-failed", "Browser open failed", String(error));
    }
  }, [notify, workbench.browserPreview.url]);

  const captureBrowserPreview = useCallback(
    async (action: "capture" | "reveal" = "capture") => {
      if (action === "reveal") {
        const path = workbench.browserPreview.latestCapture?.path;
        if (!path) return;
        try {
          await revealItemInDir(path);
        } catch (error) {
          notify(
            "command-failed",
            "Could not reveal screenshot",
            String(error),
          );
        }
        return;
      }

      dispatchWorkbench({ type: "browser-capture-start" });
      if (!isTauriRuntime()) {
        dispatchWorkbench({
          type: "browser-capture-failure",
          error: "Preview screenshots require the Gyro desktop app",
        });
        return;
      }
      try {
        const capture = await invoke<BrowserPreviewCapture>(
          "capture_browser_preview",
          {
            request: {
              device: workbench.browserPreview.device,
              url: normalizedPreviewUrl(workbench.browserPreview.url),
            },
          },
        );
        dispatchWorkbench({
          type: "browser-capture-success",
          capture,
        });
      } catch (error) {
        const message = String(error);
        dispatchWorkbench({
          type: "browser-capture-failure",
          error: message,
        });
        notify("command-failed", "Screenshot failed", message);
      }
    },
    [
      notify,
      workbench.browserPreview.device,
      workbench.browserPreview.latestCapture?.path,
      workbench.browserPreview.url,
    ],
  );

  useEffect(() => {
    if (workbench.browserPreview.status !== "loading") return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4_000);
    let disposed = false;
    const url = normalizedPreviewUrl(workbench.browserPreview.url);

    const verification = isTauriRuntime()
      ? invoke<BrowserPreviewCheck>("check_browser_preview", {
          request: { url },
        })
      : fetch(url, {
          cache: "no-store",
          method: "GET",
          mode: "no-cors",
          signal: controller.signal,
        }).then(
          () =>
            ({
              reachable: true,
              message: "Local preview reachable",
              diagnostics: [],
              diagnosticsSupported: false,
              diagnosticsCaptured: false,
            }) satisfies BrowserPreviewCheck,
        );

    void verification
      .then((result) => {
        if (disposed) return;
        dispatchWorkbench({
          type: "browser-status",
          status: !result.reachable
            ? "verification-failed"
            : result.diagnostics.length > 0
              ? "console-error"
              : "ready",
          message: result.message,
          consoleErrors: result.diagnostics.length,
          diagnostics: result.diagnostics,
          diagnosticsSupported: result.diagnosticsSupported,
          diagnosticsCaptured: result.diagnosticsCaptured,
        });
      })
      .catch((error) => {
        if (disposed) return;
        const reason =
          error instanceof DOMException && error.name === "AbortError"
            ? "connection timed out"
            : "connection refused or offline";
        dispatchWorkbench({
          type: "browser-status",
          status: "verification-failed",
          message: `Preview unavailable: ${reason}`,
        });
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [workbench.browserPreview.status, workbench.browserPreview.url]);

  const createTask = useCallback(() => {
    const metadata = workspaceRunMetadata(
      workbench.workspaceMode,
      "new-agent-task",
    );
    const task: Task = {
      id: `task-${Date.now()}`,
      title: "New agent task",
      status: "todo",
      repo: "gyro",
      agent: "Codex",
      branch: metadata.branch,
      workspaceMode: metadata.workspaceMode,
      worktreeName: metadata.worktreeName,
      lastEvent:
        metadata.workspaceMode === "worktree"
          ? "queued for isolated worktree"
          : "created locally",
      diffStatus: "none",
      testStatus: "not run",
      timeRunning: "0m",
      attentionNeeded: false,
    };
    dispatchWorkbench({ type: "create-task", task });
    notify(
      "terminal",
      "Task created",
      metadata.workspaceMode === "worktree"
        ? `${task.title} · ${metadata.worktreeName}`
        : task.title,
    );
  }, [notify, workbench.workspaceMode]);

  const dispatchTask = useCallback(
    async (taskId: string) => {
      if (!checkProviderReadiness("task", "openai")) {
        return;
      }
      const task = workbench.tasks.find((item) => item.id === taskId);
      if (!task) {
        notify("command-failed", "Task not found", taskId);
        return;
      }
      if (task.terminalPaneId) {
        dispatchWorkbench({
          type: "select-workspace-layout",
          layout: "terminal-grid",
        });
        dispatchWorkbench({
          type: "select-terminal-pane",
          paneId: task.terminalPaneId,
        });
        return;
      }
      const profile = getCommandProfile(commandProfiles, "codex");
      const metadata = task;
      const pane = createTerminalPane(
        `pane-task-${Date.now()}`,
        profile,
        "waiting",
        {
          workspaceMode: metadata.workspaceMode,
          branch: metadata.branch,
          worktreeName: metadata.worktreeName,
        },
      );
      dispatchWorkbench({ type: "dispatch-task", taskId, pane });
      const started = await launchTerminalPane({
        paneId: pane.id,
        profile: {
          ...profile,
          args: [...profile.args, task.title],
        },
        startingOutput: `Starting ${profile.displayName}: ${task.title}`,
      });
      if (!started) {
        dispatchWorkbench({
          type: "move-task",
          taskId,
          status: "in-review",
          event: "agent failed to start",
        });
        notify("command-failed", "Task dispatch failed", task.title);
        return;
      }
      notify(
        "terminal",
        "Task running",
        metadata.workspaceMode === "worktree"
          ? `Agent started for ${metadata.worktreeName}`
          : "Agent started in terminal pane",
      );
    },
    [
      checkProviderReadiness,
      commandProfiles,
      launchTerminalPane,
      notify,
      workbench.tasks,
      workbench.workspaceMode,
    ],
  );

  const createAutomation = useCallback(async () => {
    const root = activeSession?.workspacePath ?? workspacePath;
    if (!root) {
      notify(
        "command-failed",
        "Choose a workspace first",
        "Automations need a concrete local folder before they can run",
      );
      return;
    }
    const providerConfigs = providersForConfig(config);
    const provider =
      providerConfigs.find(
        (item) => item.id === config.selectedProviderId && item.enabled,
      ) ?? providerConfigs.find((item) => item.enabled);
    if (!provider || !isProviderExecutable(provider.id)) {
      notify(
        "provider",
        "Connect a provider first",
        "Automations run through a connected executable provider",
      );
      return;
    }
    const providerHealth = workbench.providerStatuses.find(
      (status) => status.id === provider.id,
    );
    const providerReady = isProviderRuntimeUsable(provider, providerHealth);
    if (!providerReady) {
      notify(
        "provider",
        `${provider.displayName} is not connected`,
        "Connect the provider before scheduling unattended work",
      );
      return;
    }
    const draft = createAutomationDraft(
      workbench.workspaceMode,
      root,
      provider,
    );

    if (isTauriRuntime()) {
      try {
        const automation = await invoke<Automation>("create_automation", {
          draft,
        });
        dispatchWorkbench({ type: "upsert-automation", automation });
        notify("terminal", "Automation created", automation.title);
      } catch {
        notify(
          "command-failed",
          "Automation create failed",
          "No automation was saved",
        );
      }
      return;
    }

    const automation = createPreviewAutomation(draft);
    dispatchWorkbench({ type: "create-automation", automation });
    notify("terminal", "Automation created", automation.title);
  }, [
    activeSession?.workspacePath,
    config,
    notify,
    workbench.providerStatuses,
    workbench.workspaceMode,
    workspacePath,
  ]);

  const runAutomation = useCallback(
    async (automationId: string) => {
      const automation = workbench.automations.find(
        (item) => item.id === automationId,
      );
      if (!automation) {
        notify("command-failed", "Automation not found", automationId);
        return;
      }
      if (isTauriRuntime()) {
        try {
          const updated = await invoke<Automation>("run_automation", {
            automationId,
          });
          dispatchWorkbench({ type: "upsert-automation", automation: updated });
          notify("terminal", "Automation queued", updated.title);
        } catch {
          notify(
            "command-failed",
            "Automation run failed",
            automation?.title ?? automationId,
          );
        }
        return;
      }

      dispatchWorkbench({
        type: "run-automation",
        automationId,
        summary: "Preview automation completed",
      });
      notify("terminal", "Automation completed", automation.title);
    },
    [notify, workbench.automations],
  );

  const toggleAutomation = useCallback(
    async (automationId: string) => {
      const automation = workbench.automations.find(
        (item) => item.id === automationId,
      );
      const status =
        automation?.status === "paused" || automation?.status === "completed"
          ? "current"
          : "paused";

      if (isTauriRuntime()) {
        try {
          const updated = await invoke<Automation>("set_automation_status", {
            automationId,
            status,
          });
          dispatchWorkbench({ type: "upsert-automation", automation: updated });
          notify(
            "terminal",
            status === "paused"
              ? "Automation paused"
              : automation?.status === "completed"
                ? "Automation reactivated"
                : "Automation resumed",
            updated.title,
          );
        } catch {
          notify(
            "command-failed",
            "Automation status failed",
            automation?.title ?? automationId,
          );
        }
        return;
      }

      dispatchWorkbench({
        type: "set-automation-status",
        automationId,
        status,
      });
      notify(
        "terminal",
        status === "paused"
          ? "Automation paused"
          : automation?.status === "completed"
            ? "Automation reactivated"
            : "Automation resumed",
        automation?.title ?? automationId,
      );
    },
    [notify, workbench.automations],
  );

  const archiveAutomation = useCallback(
    async (automationId: string) => {
      const automation = workbench.automations.find(
        (item) => item.id === automationId,
      );

      if (isTauriRuntime()) {
        try {
          const updated = await invoke<Automation>("triage_automation", {
            automationId,
            triageState: "archived",
          });
          dispatchWorkbench({ type: "upsert-automation", automation: updated });
          notify("terminal", "Automation result archived", updated.title);
        } catch {
          notify(
            "command-failed",
            "Automation archive failed",
            automation?.title ?? automationId,
          );
        }
        return;
      }

      dispatchWorkbench({
        type: "triage-automation",
        automationId,
        triageState: "archived",
      });
      notify(
        "terminal",
        "Automation result archived",
        automation?.title ?? automationId,
      );
    },
    [notify, workbench.automations],
  );

  const handleConfigChange = useCallback(
    (nextConfig: GyroConfig) => {
      void persistConfig(nextConfig);
    },
    [persistConfig],
  );

  const toggleProvider = useCallback(
    (providerId: string) => {
      if (!isProviderId(providerId)) {
        return;
      }
      const provider = providersForConfig(config).find(
        (item) => item.id === providerId,
      );
      if (provider?.authStatus === "connected") {
        setProviderAuthStatus(providerId, "not-connected");
        notify(
          "provider",
          provider.authMode === "cli"
            ? "Provider disabled in Gyro"
            : "Provider disconnected",
          provider.authMode === "cli"
            ? `${provider.displayName} was disabled in Gyro. This does not log out of the provider CLI.`
            : provider.displayName,
        );
        return;
      }
      connectProvider(providerId);
    },
    [config, connectProvider, notify, setProviderAuthStatus],
  );

  const testProvider = useCallback(
    async (providerId: string) => {
      const provider = providersForConfig(config).find(
        (item) => item.id === providerId,
      );
      dispatchWorkbench({
        type: "set-provider-status",
        providerId,
        status: "checking",
      });
      notify(
        "provider",
        "Testing provider",
        provider?.displayName ?? providerId,
      );

      const check =
        isProviderId(providerId) && isTauriRuntime()
          ? await invoke<ProviderHealthCheck>("check_provider_health", {
              request: providerHealthRequest(provider, providerId),
            }).catch((error) => undefined)
          : undefined;
      const output =
        check?.output ?? createProviderHealthOutput(providerId, provider);
      const result = isProviderId(providerId)
        ? recordProviderHealthOutput(providerId, output, check)
        : parseProviderHealthOutput(providerId, output);

      if (!isProviderId(providerId)) {
        dispatchWorkbench({
          type: "record-provider-health",
          providerId,
          status: result.connectionStatus,
          summary: result.healthSummary ?? "Health check complete.",
          details: result.healthDetails,
          output,
        });
      }
      notify(
        result.connectionStatus === "connected" ? "provider" : "command-failed",
        result.connectionStatus === "connected"
          ? providerId === "openai"
            ? "Codex sign-in verified"
            : "Provider ready"
          : "Provider needs setup",
        result.healthSummary ?? providerId,
      );
    },
    [config, notify, recordProviderHealthOutput],
  );

  const queueProviderHandoff = useCallback(
    ({
      fromProviderId,
      toProviderId,
      contextSummary,
    }: {
      fromProviderId: string;
      toProviderId: string;
      contextSummary: string;
    }) => {
      if (!checkProviderReadiness("handoff", toProviderId)) {
        return;
      }
      const providerConfigs = providersForConfig(config);
      const fromLabel = providerLabelForId(
        providerConfigs,
        workbench.providerStatuses,
        fromProviderId,
      );
      const toLabel = providerLabelForId(
        providerConfigs,
        workbench.providerStatuses,
        toProviderId,
      );
      const toStatus = workbench.providerStatuses.find(
        (provider) => provider.id === toProviderId,
      );
      const now = new Date().toISOString();
      const sessionTitle = activeSession?.title ?? "Desktop session";
      const providerSession: ProviderSession = {
        id: `provider-session-${toProviderId}-${activeSessionId ?? "local"}`,
        providerId: toProviderId,
        displayName: toLabel,
        status: "queued",
        model: toStatus?.defaultModel ?? "Default",
        sessionId: activeSessionId,
        sessionTitle,
        workspaceMode: activeSession?.workspaceMode ?? workbench.workspaceMode,
        branch: activeSession?.branch ?? "main",
        worktreeName: activeSession?.worktreeName,
        lastEvent: `handoff queued from ${fromLabel}`,
        createdAt: now,
        updatedAt: now,
      };
      const handoff: ProviderHandoff = {
        id: `handoff-${Date.now()}`,
        fromProviderId,
        fromLabel,
        toProviderId,
        toLabel,
        status: "queued",
        sessionId: activeSessionId,
        sessionTitle,
        contextSummary,
        createdAt: now,
        updatedAt: now,
      };
      dispatchWorkbench({
        type: "queue-provider-handoff",
        handoff,
        session: providerSession,
      });
      notify("provider", "Handoff queued", `${fromLabel} to ${toLabel}`);
    },
    [
      activeSession,
      activeSessionId,
      checkProviderReadiness,
      config,
      notify,
      workbench.providerStatuses,
      workbench.workspaceMode,
    ],
  );

  const runCommandPaletteCommand = useCallback(
    (commandId: string) => {
      dispatchWorkbench({ type: "record-command", commandId });
      switch (commandId) {
        case "new-chat":
          startNewChat();
          break;
        case "open-workspace":
          void openWorkspace();
          break;
        case "new-terminal":
          addTerminalPane();
          break;
        case "run-codex":
          runCommandProfile("codex");
          dispatchWorkbench({
            type: "select-workspace-layout",
            layout: "terminal-grid",
          });
          break;
        case "run-claude":
          runCommandProfile("claude");
          dispatchWorkbench({
            type: "select-workspace-layout",
            layout: "terminal-grid",
          });
          break;
        case "run-tests":
          runProfile("shell", "pnpm check");
          dispatchWorkbench({
            type: "select-workspace-layout",
            layout: "terminal-grid",
          });
          break;
        case "split-terminal":
          splitTerminalPane(2);
          break;
        case "search-files":
          dispatchWorkbench({
            type: "select-workspace-layout",
            layout: "code",
          });
          dispatchWorkbench({ type: "ide-select-view", view: "search" });
          notify("terminal", "Search ready", "Workspace file tree focused");
          break;
        case "open-browser-preview":
          dispatchWorkbench({
            type: "browser-navigate",
            url: workbench.browserPreview.url,
          });
          break;
        case "show-diffs":
          dispatchWorkbench({
            type: "open-tool-panel",
            tab: "diff",
          });
          break;
        case "open-settings":
          dispatchWorkbench({
            type: "select-destination",
            destination: "settings",
          });
          break;
        case "configure-cli-launcher":
          dispatchWorkbench({
            type: "set-settings-section",
            section: "cli-profiles",
          });
          dispatchWorkbench({
            type: "select-destination",
            destination: "settings",
          });
          break;
        case "toggle-theme":
          dispatchWorkbench({
            type: "set-theme",
            theme: workbench.preferences.theme === "dark" ? "light" : "dark",
          });
          break;
        case "create-task":
          createTask();
          break;
        case "open-automations":
          dispatchWorkbench({
            type: "select-destination",
            destination: "automations",
          });
          break;
        case "create-automation":
          void createAutomation();
          break;
        case "run-automation":
          if (workbench.selectedAutomationId) {
            void runAutomation(workbench.selectedAutomationId);
          }
          break;
      }
    },
    [
      addTerminalPane,
      createAutomation,
      createTask,
      notify,
      openWorkspace,
      runAutomation,
      runCommandProfile,
      runProfile,
      splitTerminalPane,
      startNewChat,
      workbench.browserPreview.url,
      workbench.preferences.theme,
      workbench.selectedAutomationId,
      workbench.selectedTaskId,
    ],
  );

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const providers = providersForConfig(config).filter(
      (provider) => provider.enabled && isProviderExecutable(provider.id),
    );
    if (providers.length === 0) return;
    let cancelled = false;
    void Promise.all(
      providers.map(async (provider) => {
        const check = await invoke<ProviderHealthCheck>(
          "check_provider_health",
          { request: providerHealthRequest(provider, provider.id) },
        );
        if (!cancelled) {
          recordProviderHealthOutput(provider.id, check.output, check);
        }
      }),
    ).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [config.modelProviders, recordProviderHealthOutput]);

  useEffect(() => {
    void refreshSessions();
    void refreshAutomations();
  }, [refreshAutomations, refreshSessions]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let cancelled = false;
    void invoke<TerminalPaneSnapshot[]>("restore_terminal_panes")
      .then((snapshots) => {
        if (cancelled) {
          return;
        }
        const livePaneIds = new Set(
          snapshots
            .filter((snapshot) => snapshot.status === "running")
            .map((snapshot) => snapshot.paneId),
        );
        for (const pane of terminalPanesRef.current) {
          if (
            (pane.status === "running" || pane.status === "waiting") &&
            !livePaneIds.has(pane.id)
          ) {
            dispatchWorkbench({
              type: "set-terminal-pane-status",
              paneId: pane.id,
              status: "restored",
              event: "restored snapshot; restart to reconnect",
            });
          }
        }
        for (const snapshot of snapshots) {
          dispatchWorkbench({
            type: "upsert-restored-terminal-pane",
            pane: terminalPaneFromSnapshot(
              snapshot,
              initialTerminalRestoreModeRef.current,
            ),
          });
          syncTerminalSnapshot(snapshot);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [syncTerminalSnapshot]);

  useEffect(() => {
    document.documentElement.dataset.theme = workbench.preferences.theme;
    document.documentElement.dataset.density = workbench.preferences.density;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        workbench.preferences.theme === "light" ? "#f6f7f8" : "#07080a",
      );
    safeSetLocalStorage(THEME_STORAGE_KEY, workbench.preferences.theme);
  }, [workbench.preferences.density, workbench.preferences.theme]);

  useEffect(() => {
    const syncWindowFocus = () => {
      document.documentElement.dataset.windowActive = document.hasFocus()
        ? "true"
        : "false";
    };
    syncWindowFocus();
    window.addEventListener("focus", syncWindowFocus);
    window.addEventListener("blur", syncWindowFocus);
    return () => {
      window.removeEventListener("focus", syncWindowFocus);
      window.removeEventListener("blur", syncWindowFocus);
    };
  }, []);

  useEffect(() => {
    pendingWorkbenchPersistRef.current = persistableWorkbench;
    if (
      workbenchPersistTimerRef.current !== undefined ||
      workbenchPersistIdleRef.current !== undefined
    ) {
      return;
    }
    workbenchPersistTimerRef.current = window.setTimeout(() => {
      workbenchPersistTimerRef.current = undefined;
      schedulePersistedWorkbenchStateFlush(
        pendingWorkbenchPersistRef,
        workbenchPersistIdleRef,
      );
    }, WORKBENCH_PERSIST_DEBOUNCE_MS);
  }, [persistableWorkbench]);

  useEffect(
    () => () => {
      if (workbenchPersistTimerRef.current !== undefined) {
        window.clearTimeout(workbenchPersistTimerRef.current);
        workbenchPersistTimerRef.current = undefined;
      }
      cancelPersistedWorkbenchStateFlush(workbenchPersistIdleRef);
      flushPersistedWorkbenchState(pendingWorkbenchPersistRef);
    },
    [],
  );

  const requestLanguageFeature = useCallback(
    async (path: string, method: string, params: Record<string, unknown>) => {
      const root = activeSession?.workspacePath ?? workspacePath;
      const descriptor = languageServerDescriptorForPath(path);
      if (!root || !descriptor || !isTauriRuntime()) {
        return undefined;
      }
      const stateId = `${descriptor.languageId}:${descriptor.command}`;
      const serverId = languageServerIdsRef.current[stateId];
      if (!serverId) {
        return undefined;
      }
      const response = await invoke<LspBridgeResponse>("lsp_request", {
        request: {
          serverId,
          method,
          params: {
            ...params,
            textDocument: { uri: workspaceFileUri(root, path) },
          },
        },
      });
      const diagnostics = diagnosticsFromLspMessages(response.messages, root);
      if (diagnostics) {
        dispatchWorkbench({ type: "ide-set-diagnostics", diagnostics });
      }
      if (response.status === "error") {
        throw new Error(JSON.stringify(response.error ?? "LSP request failed"));
      }
      return response.result;
    },
    [activeSession?.workspacePath, workspacePath],
  );

  useEffect(() => {
    safeSetLocalStorage(
      PINNED_SESSIONS_STORAGE_KEY,
      JSON.stringify(pinnedSessionIds),
    );
  }, [pinnedSessionIds]);

  useEffect(() => {
    safeSetLocalStorage(
      REMOVED_PROJECTS_STORAGE_KEY,
      JSON.stringify(removedProjectPaths),
    );
  }, [removedProjectPaths]);

  useEffect(() => {
    safeSetLocalStorage(
      RECENT_PROJECTS_STORAGE_KEY,
      JSON.stringify(recentProjectPaths),
    );
  }, [recentProjectPaths]);

  useEffect(() => {
    const selectedPane = workbench.terminalPanes.find(
      (pane) => pane.id === workbench.selectedTerminalPaneId,
    );
    if (!selectedPane) {
      return;
    }
    setTerminalOutput((current) =>
      current === selectedPane.output ? current : selectedPane.output,
    );
  }, [workbench.selectedTerminalPaneId, workbench.terminalPanes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isCommand = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        closeGlobalSearch();
        setModelStandardPrompt(undefined);
        setProjectRemoveCandidate(undefined);
        return;
      }
      if (!isCommand) {
        return;
      }
      if (
        event.key.toLowerCase() === "s" &&
        workbench.activeWorkspaceLayout === "code" &&
        workbench.ide.activePath
      ) {
        event.preventDefault();
        void saveEditorBuffer(workbench.ide.activePath);
      } else if (event.key.toLowerCase() === "f" && event.shiftKey) {
        event.preventDefault();
        dispatchWorkbench({ type: "select-workspace-layout", layout: "code" });
        dispatchWorkbench({ type: "ide-select-view", view: "search" });
      } else if (event.key === "`") {
        event.preventDefault();
        openToolPanel("terminal");
      } else if (
        event.key.toLowerCase() === "k" ||
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        openGlobalSearch();
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        startNewChat();
      } else if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        addTerminalPane();
      } else if (event.key === "\\") {
        event.preventDefault();
        splitTerminalPane(2);
      } else if (event.key === ",") {
        event.preventDefault();
        dispatchWorkbench({
          type: "select-destination",
          destination: "settings",
        });
      } else if (event.key === "1") {
        event.preventDefault();
        dispatchWorkbench({
          type: "select-workspace-layout",
          layout: "thread",
        });
      } else if (event.key === "2") {
        event.preventDefault();
        dispatchWorkbench({
          type: "select-workspace-layout",
          layout: "terminal-grid",
        });
      } else if (event.key === "3") {
        event.preventDefault();
        dispatchWorkbench({ type: "select-workspace-layout", layout: "code" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    addTerminalPane,
    closeGlobalSearch,
    openGlobalSearch,
    openToolPanel,
    saveEditorBuffer,
    splitTerminalPane,
    startNewChat,
    workbench.activeWorkspaceLayout,
    workbench.ide.activePath,
  ]);

  useEffect(() => {
    if (activeSessionId) {
      void refreshEvents(activeSessionId);
    } else {
      setEvents([]);
    }
  }, [activeSessionId, refreshEvents]);

  useEffect(() => {
    if (!activeSession) {
      workspaceTreeRequestRef.current += 1;
      return;
    }
    setWorkspacePath(activeSession.workspacePath);
    if (activeSession.workspaceMode) {
      dispatchWorkbench({
        type: "set-workbench-mode",
        mode: activeSession.workspaceMode,
      });
    }
    if (
      activeSession.providerId &&
      isProviderId(activeSession.providerId) &&
      activeSession.modelId
    ) {
      setConfig((current) => {
        const providers = providersForConfig(current).map((provider) =>
          provider.id === activeSession.providerId
            ? {
                ...provider,
                selectedModelId: activeSession.modelId,
                selectedReasoningEffort:
                  activeSession.reasoningEffort ??
                  provider.selectedReasoningEffort,
              }
            : provider,
        );
        return normalizedConfig({
          ...current,
          selectedProviderId: activeSession.providerId,
          modelProviders: providers,
        });
      });
      dispatchWorkbench({
        type: "set-provider-model",
        providerId: activeSession.providerId,
        model: activeSession.modelLabel ?? activeSession.modelId,
      });
    }
    if (!isTauriRuntime()) {
      setFiles(previewFiles);
      refreshIdeServices(activeSession.workspacePath);
      return;
    }
    if (!activeSession.workspacePath) {
      workspaceTreeRequestRef.current += 1;
      setFiles([]);
      return;
    }
    setFiles([]);
    void prepareWorkspace(activeSession.workspacePath);
  }, [activeSession, prepareWorkspace, refreshIdeServices]);

  useEffect(() => {
    if (!selectedFile) {
      setSelectedFileContent(undefined);
      setSelectedFileError("");
      setSelectedFileLoadState("idle");
      return;
    }

    const existingBuffer = workbench.ide.buffers[selectedFile];
    if (existingBuffer && existingBuffer.status === "dirty") {
      setSelectedFileContent({
        path: selectedFile,
        content: existingBuffer.content,
        contentHash: existingBuffer.contentHash,
        sizeBytes: existingBuffer.sizeBytes,
        truncated: existingBuffer.truncated,
      });
      setSelectedFileLoadState("ready");
      setSelectedFileError("");
      return;
    }
    if (
      existingBuffer &&
      (existingBuffer.status === "ready" ||
        existingBuffer.status === "saved" ||
        existingBuffer.status === "saving")
    ) {
      setSelectedFileContent({
        path: selectedFile,
        content: existingBuffer.content,
        contentHash: existingBuffer.contentHash,
        sizeBytes: existingBuffer.sizeBytes,
        truncated: existingBuffer.truncated,
      });
      setSelectedFileLoadState("ready");
      setSelectedFileError("");
      return;
    }

    const selectedEntry = files.find((file) => file.path === selectedFile);
    if (selectedEntry?.kind === "directory") {
      setSelectedFileContent(undefined);
      setSelectedFileError("Select a file to preview its contents.");
      setSelectedFileLoadState("error");
      return;
    }

    if (!isTauriRuntime()) {
      const content = createPreviewWorkspaceFileContent(selectedFile);
      setSelectedFileContent(content);
      dispatchWorkbench({
        type: "ide-upsert-buffer",
        buffer: workspaceContentToEditorBuffer(content),
      });
      setSelectedFileError("");
      setSelectedFileLoadState("ready");
      return;
    }

    const root = activeSession?.workspacePath ?? workspacePath;
    if (!root) {
      setSelectedFileContent(undefined);
      setSelectedFileError("Open a workspace before previewing files.");
      setSelectedFileLoadState("error");
      return;
    }

    let cancelled = false;
    setSelectedFileLoadState("loading");
    setSelectedFileError("");
    void invoke<WorkspaceFileContent>("read_workspace_file_full", {
      path: selectedFile,
      workspacePath: root,
    })
      .then((content) => {
        if (cancelled) {
          return;
        }
        setSelectedFileContent(content);
        dispatchWorkbench({
          type: "ide-upsert-buffer",
          buffer: workspaceContentToEditorBuffer(content),
        });
        setSelectedFileLoadState("ready");
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setSelectedFileContent(undefined);
        setSelectedFileError(String(error));
        setSelectedFileLoadState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeSession?.workspacePath,
    files,
    selectedFile,
    workbench.ide.buffers,
    workspacePath,
  ]);

  useEffect(() => {
    refreshedFileActivityKeysRef.current.clear();
  }, [activeSessionId]);

  useEffect(() => {
    const root = activeSession?.workspacePath ?? workspacePath;
    const buffer = selectedFile
      ? workbench.ide.buffers[selectedFile]
      : undefined;
    if (!root || !isTauriRuntime()) {
      return;
    }
    let cancelled = false;
    let polling = false;
    const pollWorkspace = async () => {
      if (polling) {
        return;
      }
      polling = true;
      try {
        const workspaceFiles = await invoke<WorkspaceFile[]>(
          "watch_workspace",
          {
            workspacePath: root,
          },
        );
        if (cancelled) {
          return;
        }
        setFiles((current) =>
          workspaceTreeSignature(current) ===
          workspaceTreeSignature(workspaceFiles)
            ? current
            : workspaceFiles,
        );
        if (!selectedFile || !buffer?.contentHash) {
          return;
        }
        const stat = await invoke<WorkspaceFileStat>("stat_workspace_file", {
          workspacePath: root,
          path: selectedFile,
        });
        if (cancelled) {
          return;
        }
        if (!stat.contentHash || stat.contentHash === buffer.contentHash) {
          return;
        }
        if (buffer.status === "dirty") {
          dispatchWorkbench({
            type: "ide-mark-buffer-error",
            path: selectedFile,
            error:
              "File changed on disk; reload or preserve your buffer before saving.",
          });
          notify(
            "command-failed",
            "File changed on disk",
            `${selectedFile} has external changes`,
          );
          return;
        }
        const content = await invoke<WorkspaceFileContent>(
          "read_workspace_file_full",
          { workspacePath: root, path: selectedFile },
        );
        if (cancelled) {
          return;
        }
        setSelectedFileContent(content);
        dispatchWorkbench({
          type: "ide-upsert-buffer",
          buffer: workspaceContentToEditorBuffer(content),
        });
      } catch {
        // Polling is opportunistic; direct operations still surface errors.
      } finally {
        polling = false;
      }
    };
    const interval =
      workspaceWatchMode === "polling"
        ? window.setInterval(() => void pollWorkspace(), 2500)
        : undefined;
    if (workspaceWatchMode === "event") {
      void pollWorkspace();
    }
    return () => {
      cancelled = true;
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [
    activeSession?.workspacePath,
    notify,
    selectedFile,
    selectedFile ? workbench.ide.buffers[selectedFile]?.contentHash : undefined,
    selectedFile ? workbench.ide.buffers[selectedFile]?.status : undefined,
    workspaceChangeGeneration,
    workspacePath,
    workspaceWatchMode,
  ]);

  useEffect(() => {
    const root = activeSession?.workspacePath ?? workspacePath;
    if (!root) {
      return;
    }
    const hasRunningFileEdit = deferredEventsForTurn.some((event) => {
      const payload = recordFromUnknown(event.payload);
      return (
        event.kind === "system-event" &&
        payload?.kind === "provider-activity" &&
        payload.activityKind === "file" &&
        stringFromRecord(payload, "status") === "running"
      );
    });
    if (!hasRunningFileEdit) {
      return;
    }
    refreshIdeSourceControl(root);
    const interval = window.setInterval(
      () => refreshIdeSourceControl(root),
      800,
    );
    return () => window.clearInterval(interval);
  }, [
    activeSession?.workspacePath,
    deferredEventsForTurn,
    refreshIdeSourceControl,
    workspacePath,
  ]);

  useEffect(() => {
    const root = activeSession?.workspacePath ?? workspacePath;
    const descriptor = selectedFile
      ? languageServerDescriptorForPath(selectedFile)
      : undefined;
    if (!root || !selectedFile || !descriptor || !isTauriRuntime()) {
      return;
    }
    let cancelled = false;
    const stateId = `${descriptor.languageId}:${descriptor.command}`;
    const startingState: LanguageServerState = {
      id: stateId,
      languageId: descriptor.languageId,
      command: descriptor.command,
      status: "starting",
      activePath: selectedFile,
      message: `Starting ${descriptor.command}`,
    };
    dispatchWorkbench({
      type: "ide-set-language-server",
      server: startingState,
    });
    void invoke<LspSessionResult>("lsp_start", {
      request: {
        workspacePath: root,
        languageId: descriptor.languageId,
        command: descriptor.command,
      },
    })
      .then(async (session) => {
        if (cancelled) {
          return;
        }
        languageServerIdsRef.current[stateId] = session.serverId;
        dispatchWorkbench({
          type: "ide-set-language-server",
          server: {
            ...startingState,
            serverId: session.serverId,
            status: "ready",
            message: session.message,
          },
        });
        dispatchWorkbench({
          type: "ide-upsert-output-channel",
          channel: {
            id: `lsp:${descriptor.languageId}`,
            label: `${descriptor.languageId} language server`,
            kind: "lsp",
            lines: [session.message],
            updatedAt: new Date().toISOString(),
          },
        });
        const content =
          workbench.ide.buffers[selectedFile]?.content ??
          (selectedFileContent?.path === selectedFile
            ? selectedFileContent.content
            : "");
        const uri = workspaceFileUri(root, selectedFile);
        const documentKey = `${session.serverId}:${uri}`;
        if (languageServerOpenedDocsRef.current.has(documentKey)) {
          return;
        }
        languageServerOpenedDocsRef.current.add(documentKey);
        const response = await invoke<LspBridgeResponse>("lsp_request", {
          request: {
            serverId: session.serverId,
            method: "textDocument/didOpen",
            params: {
              textDocument: {
                uri,
                languageId: descriptor.languageId,
                version: 1,
                text: content,
              },
            },
          },
        });
        const diagnostics = diagnosticsFromLspMessages(response.messages, root);
        if (diagnostics) {
          dispatchWorkbench({ type: "ide-set-diagnostics", diagnostics });
        }
        window.setTimeout(() => {
          void invoke<LspBridgeResponse>("lsp_request", {
            request: {
              serverId: session.serverId,
              method: "$/gyro/poll",
              params: {},
            },
          })
            .then((pollResponse) => {
              const publishedDiagnostics = diagnosticsFromLspMessages(
                pollResponse.messages,
                root,
              );
              if (publishedDiagnostics) {
                dispatchWorkbench({
                  type: "ide-set-diagnostics",
                  diagnostics: publishedDiagnostics,
                });
              }
            })
            .catch(() => undefined);
        }, 350);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = String(error);
        dispatchWorkbench({
          type: "ide-set-language-server",
          server: {
            ...startingState,
            status: message.toLowerCase().includes("not found")
              ? "not-installed"
              : "error",
            message,
          },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeSession?.workspacePath,
    selectedFile,
    selectedFileContent?.contentHash,
    workspacePath,
  ]);

  useEffect(() => {
    const root = activeSession?.workspacePath ?? workspacePath;
    const descriptor = selectedFile
      ? languageServerDescriptorForPath(selectedFile)
      : undefined;
    const content = selectedFile
      ? workbench.ide.buffers[selectedFile]?.content
      : undefined;
    if (
      !root ||
      !selectedFile ||
      !descriptor ||
      content === undefined ||
      !isTauriRuntime()
    ) {
      return;
    }
    const stateId = `${descriptor.languageId}:${descriptor.command}`;
    const serverId = languageServerIdsRef.current[stateId];
    if (!serverId) {
      return;
    }
    const timer = window.setTimeout(() => {
      const uri = workspaceFileUri(root, selectedFile);
      void invoke<LspBridgeResponse>("lsp_request", {
        request: {
          serverId,
          method: "textDocument/didChange",
          params: {
            textDocument: { uri, version: Date.now() },
            contentChanges: [{ text: content }],
          },
        },
      })
        .then((response) => {
          const immediate = diagnosticsFromLspMessages(response.messages, root);
          if (immediate) {
            dispatchWorkbench({
              type: "ide-set-diagnostics",
              diagnostics: immediate,
            });
          }
          window.setTimeout(() => {
            void invoke<LspBridgeResponse>("lsp_request", {
              request: { serverId, method: "$/gyro/poll", params: {} },
            }).then((pollResponse) => {
              const diagnostics = diagnosticsFromLspMessages(
                pollResponse.messages,
                root,
              );
              if (diagnostics) {
                dispatchWorkbench({
                  type: "ide-set-diagnostics",
                  diagnostics,
                });
              }
            });
          }, 300);
        })
        .catch(() => undefined);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    activeSession?.workspacePath,
    selectedFile,
    selectedFile ? workbench.ide.buffers[selectedFile]?.content : undefined,
    workspacePath,
  ]);

  useEffect(
    () => () => {
      if (!isTauriRuntime()) {
        return;
      }
      for (const serverId of Object.values(languageServerIdsRef.current)) {
        void invoke("lsp_stop", { serverId });
      }
    },
    [],
  );

  useEffect(() => {
    if (!isTauriRuntime() || !terminalPanePollKey) {
      return;
    }
    const paneIds = terminalPanePollKey.split("\n");
    const pollInterval = isActiveSessionSending
      ? TERMINAL_CHAT_BUSY_POLL_INTERVAL_MS
      : TERMINAL_POLL_INTERVAL_MS;

    for (const paneId of paneIds) {
      void refreshTerminalPane(paneId);
    }

    const interval = window.setInterval(() => {
      for (const paneId of paneIds) {
        void refreshTerminalPane(paneId);
      }
    }, pollInterval);

    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      for (const paneId of paneIds) {
        void refreshTerminalPane(paneId);
      }
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [isActiveSessionSending, refreshTerminalPane, terminalPanePollKey]);

  useEffect(() => {
    const pane = selectedTerminalPane;
    const cliIsVisible =
      activeDestination === "workspace" &&
      activeWorkspaceLayout === "terminal-grid";
    if (!pane || !cliIsVisible) {
      return;
    }

    void refreshTerminalSourceControl(pane.id);
    const handleFocus = () => void refreshTerminalSourceControl(pane.id);
    window.addEventListener("focus", handleFocus);
    const interval =
      pane.status === "running" || pane.status === "waiting"
        ? window.setInterval(
            () => void refreshTerminalSourceControl(pane.id),
            6000,
          )
        : undefined;
    return () => {
      window.removeEventListener("focus", handleFocus);
      if (interval !== undefined) {
        window.clearInterval(interval);
      }
    };
  }, [
    activeDestination,
    activeWorkspaceLayout,
    refreshTerminalSourceControl,
    selectedTerminalPane?.id,
    selectedTerminalPane?.status,
    selectedTerminalPane?.workingDirectory,
  ]);

  useEffect(() => {
    const pane = selectedTerminalPane;
    if (
      !pane ||
      activeDestination !== "workspace" ||
      activeWorkspaceLayout !== "terminal-grid"
    ) {
      return;
    }
    const timeout = window.setTimeout(
      () => void refreshTerminalSourceControl(pane.id),
      900,
    );
    return () => window.clearTimeout(timeout);
  }, [
    activeDestination,
    activeWorkspaceLayout,
    refreshTerminalSourceControl,
    selectedTerminalPane?.id,
    selectedTerminalPane?.output,
  ]);

  useEffect(() => {
    const nextTurn = derivedActiveTurn;
    if (areWorkbenchTurnsEqual(workbench.activeTurn, nextTurn)) {
      return;
    }
    dispatchWorkbench({
      type: "reconcile-active-turn",
      turn: nextTurn,
    });
  }, [derivedActiveTurn, workbench.activeTurn]);

  useEffect(() => {
    const turn = workbench.activeTurn;
    if (
      !turn ||
      turn.status === "done" ||
      turn.status === "failed" ||
      (turn.status === "waiting" && turn.approvalsPending > 0)
    ) {
      return;
    }
    const updatedAt = new Date(turn.updatedAt).getTime();
    if (Number.isNaN(updatedAt)) {
      return;
    }
    const delay = Math.max(
      1000,
      ACTIVE_TURN_IDLE_MS - (Date.now() - updatedAt),
    );
    const timeout = window.setTimeout(() => {
      dispatchWorkbench({
        type: "reconcile-active-turn-timeout",
        idleMs: ACTIVE_TURN_IDLE_MS,
        now: new Date().toISOString(),
      });
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [
    workbench.activeTurn?.approvalsPending,
    workbench.activeTurn?.id,
    workbench.activeTurn?.status,
    workbench.activeTurn?.updatedAt,
  ]);

  useEffect(() => {
    const root = activeSession?.workspacePath ?? workspacePath;
    if (!root) {
      return;
    }
    const freshKeys = deferredEventsForTurn
      .map((event) => {
        const payload = recordFromUnknown(event.payload);
        if (
          event.kind !== "system-event" ||
          payload?.kind !== "provider-activity" ||
          payload.activityKind !== "file"
        ) {
          return undefined;
        }
        const status = stringFromRecord(payload, "status") ?? "done";
        return `${event.id}:${status}`;
      })
      .filter(
        (key): key is string =>
          typeof key === "string" &&
          !refreshedFileActivityKeysRef.current.has(key),
      );
    if (freshKeys.length === 0) {
      return;
    }
    freshKeys.forEach((key) => refreshedFileActivityKeysRef.current.add(key));
    const timeout = window.setTimeout(() => refreshIdeSourceControl(root), 100);
    return () => window.clearTimeout(timeout);
  }, [
    activeSession?.workspacePath,
    deferredEventsForTurn,
    refreshIdeSourceControl,
    workspacePath,
  ]);

  useEffect(() => {
    const activeTurnId = workbench.activeTurn?.id ?? derivedActiveTurn?.id;
    const resolvedMutationProposalIds = new Set(
      deferredEventsForTurn
        .filter((event) => event.kind === "system-event")
        .map((event) => recordFromUnknown(event.payload))
        .filter(
          (payload) =>
            stringFromRecord(payload, "kind") === "mutation-approval" &&
            stringFromRecord(payload, "status") !== "pending",
        )
        .map((payload) => stringFromRecord(payload, "proposalId"))
        .filter((proposalId): proposalId is string => Boolean(proposalId)),
    );
    const freshEvents = deferredEventsForTurn.filter((event) => {
      if (
        (event.kind !== "file-edit-proposed" &&
          event.kind !== "approval-requested") ||
        ingestedSessionEventIds.current.has(event.id)
      ) {
        return false;
      }
      const payload = recordFromUnknown(event.payload);
      const proposalId = stringFromRecord(payload, "proposalId");
      return !proposalId || !resolvedMutationProposalIds.has(proposalId);
    });
    if (freshEvents.length === 0) {
      return;
    }

    freshEvents.forEach((event) => {
      ingestedSessionEventIds.current.add(event.id);
      const eventTurnId = turnIdFromSessionEvent(event);
      if (activeTurnId && eventTurnId && eventTurnId !== activeTurnId) {
        return;
      }
      if (event.kind === "file-edit-proposed") {
        dispatchWorkbench({
          type: "sync-diff-event",
          path: pathFromSessionEvent(event),
          message: event.message,
          source: "agent-generated",
          turnId: eventTurnId,
        });
        notify("diff-ready", "Diff proposal received", event.message);
      } else {
        notify("approval", "Approval requested", event.message);
      }
    });
  }, [
    derivedActiveTurn?.id,
    deferredEventsForTurn,
    notify,
    workbench.activeTurn?.id,
  ]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let unlisten: Promise<(() => void) | undefined>;
    try {
      unlisten = listen<AppNotification>("gyro://app-notification", (event) => {
        suppressSessionAutoSelectRef.current = false;
        setActiveSessionId(event.payload.sessionId);
        setWorkspacePath(event.payload.workspacePath);
        if (event.payload.workspaceMode) {
          dispatchWorkbench({
            type: "set-workbench-mode",
            mode: event.payload.workspaceMode,
          });
        }
        dispatchWorkbench({
          type: "select-workspace-layout",
          layout:
            event.payload.kind === "attach-session"
              ? "terminal-grid"
              : "thread",
        });
        setTerminalOutput(
          (current) =>
            `${current}${current ? "\n" : ""}${event.payload.kind} ${event.payload.sessionId}`,
        );
        notify("terminal", "CLI session attached", event.payload.sessionId);
        void refreshSessions();
        void refreshEvents(event.payload.sessionId);
      }).catch(() => undefined);
    } catch {
      unlisten = Promise.resolve(undefined);
    }
    return () => {
      void unlisten.then((dispose) => dispose?.());
    };
  }, [notify, refreshEvents, refreshSessions]);

  const renderWorkspaceToolPanel = (isPrimary = false) => (
    <WorkspaceToolPanel
      activePaneTab={workbench.activePaneTab}
      activeProfileId={activeProfileId}
      browserPreview={workbench.browserPreview}
      cliLaunchPreset={workbench.preferences.cliLaunchPreset}
      diffReview={workbench.diffReview}
      terminalSourceControl={selectedTerminalSourceControl}
      isTerminalSourceControlLoading={
        terminalSourceControlLoadingPaneId === selectedTerminalPane?.id
      }
      height={isPrimary ? undefined : toolPanelHeight}
      ide={workbench.ide}
      isPrimary={isPrimary}
      isLaunchingCliPreset={isLaunchingCliPreset}
      isResizable={!isPrimary}
      terminalOnly={!isPrimary && activeWorkspaceLayout === "thread"}
      onAcceptAllDiffs={() =>
        dispatchWorkbench({
          type: "set-diff-review-state",
          state: "approved",
          action: "all changes approved",
        })
      }
      onAcceptDiffFile={(path) =>
        dispatchWorkbench({
          type: "set-diff-file-state",
          path,
          state: "accepted",
          action: `${path} accepted`,
        })
      }
      onAddTerminalPane={addTerminalPane}
      onBrowserBack={() => dispatchWorkbench({ type: "browser-back" })}
      onBrowserDeviceChange={(device) =>
        dispatchWorkbench({ type: "browser-device", device })
      }
      onBrowserForward={() => dispatchWorkbench({ type: "browser-forward" })}
      onBrowserNavigate={(url) =>
        dispatchWorkbench({ type: "browser-navigate", url })
      }
      onBrowserOpenExternal={openBrowserPreviewExternal}
      onBrowserReload={() => dispatchWorkbench({ type: "browser-reload" })}
      onBrowserScreenshot={captureBrowserPreview}
      onBrowserUrlChange={(url) =>
        dispatchWorkbench({ type: "set-browser-url", url })
      }
      onCollapse={() => dispatchWorkbench({ type: "close-tool-panel" })}
      onCloseTerminalPane={requestCloseTerminalPane}
      onClose={() => dispatchWorkbench({ type: "close-tool-panel" })}
      onCommentDiff={(path) =>
        dispatchWorkbench({ type: "add-diff-comment", path })
      }
      onHeightChange={setToolPanelHeight}
      onKillTerminalPane={stopTerminalPane}
      onMoveTerminalPane={(sourcePaneId, targetPaneId) =>
        dispatchWorkbench({
          type: "move-terminal-pane",
          sourcePaneId,
          targetPaneId,
        })
      }
      onSetTerminalPaneLayout={(paneId, layout) =>
        dispatchWorkbench({
          type: "set-terminal-pane-layout",
          paneId,
          layout,
        })
      }
      onOpenDiffInEditor={(path) => {
        openEditorFile(path);
        dispatchWorkbench({
          type: "select-workspace-layout",
          layout: "code",
        });
      }}
      onOpenCommandPalette={openGlobalSearch}
      onPaneTabChange={(tab) =>
        dispatchWorkbench({ type: "set-pane-tab", tab })
      }
      onLaunchCliPreset={launchCliPreset}
      onProfileChange={setActiveProfileId}
      onRejectAllDiffs={() =>
        dispatchWorkbench({
          type: "set-diff-review-state",
          state: "rejected",
          action: "all changes rejected",
        })
      }
      onRejectDiffFile={(path) =>
        dispatchWorkbench({
          type: "set-diff-file-state",
          path,
          state: "rejected",
          action: `${path} rejected`,
        })
      }
      onRenameTerminalPane={renameTerminalPane}
      onRestartTerminalPane={restartTerminalPane}
      onRefreshTerminalSourceControl={() => {
        if (selectedTerminalPane) {
          void refreshTerminalSourceControl(selectedTerminalPane.id);
        }
      }}
      onReviewTerminalChanges={reviewTerminalChanges}
      onRunGitReviewAction={(actionId) =>
        dispatchWorkbench({ type: "run-git-review-action", actionId })
      }
      onRunCommandProfile={runCommandProfile}
      onRunProfile={runProfile}
      onSelectDiffFile={(path) =>
        dispatchWorkbench({ type: "select-diff-file", path })
      }
      onSelectTerminalPane={(paneId) =>
        dispatchWorkbench({ type: "select-terminal-pane", paneId })
      }
      onSplitTerminalPane={splitTerminalPane}
      onTerminalUtilityAction={handleTerminalUtilityAction}
      onToggleDiffDirectory={(directory) =>
        dispatchWorkbench({ type: "toggle-diff-directory", directory })
      }
      onUndoDiff={() =>
        dispatchWorkbench({
          type: "undo-diff-action",
          action: "diff review reset",
        })
      }
      onWriteTerminalInput={writeTerminalInput}
      profiles={commandProfiles}
      renderTerminalPaneBody={(pane) => (
        <LiveTerminalPaneBody
          isActive={pane.id === workbench.selectedTerminalPaneId}
          onBell={(paneId) => {
            if (paneId !== selectedTerminalPaneIdRef.current) {
              dispatchWorkbench({
                type: "set-terminal-pane-attention",
                paneId,
                attention: "waiting",
              });
            }
          }}
          onReconnect={restartTerminalPane}
          onResize={resizeTerminalPane}
          onSelect={(paneId) =>
            dispatchWorkbench({ type: "select-terminal-pane", paneId })
          }
          onWrite={writeTerminalInputToPane}
          pane={pane}
          theme={workbench.preferences.theme}
        />
      )}
      selectedTerminalPaneId={workbench.selectedTerminalPaneId}
      terminalOutput={terminalOutput}
      terminalPanes={workbench.terminalPanes}
      terminalTemplate={workbench.terminalTemplate}
    />
  );

  const updater = useGyroUpdater({
    automaticChecks: config.automaticUpdateChecks !== false,
  });
  const checkForUpdatesWithFeedback = useCallback(async () => {
    const result = await updater.checkForUpdate(true);
    if (result.status === "current") {
      notify(
        "tests-passed",
        "Gyro is up to date",
        `Version ${result.currentVersion} is the latest public Alpha verified by Gyro's updater signature`,
      );
    } else if (result.status === "available") {
      notify(
        "terminal",
        `Gyro ${result.nextVersion} is available`,
        "Use the update control in the titlebar to download it",
      );
    } else if (result.status === "failed") {
      notify("command-failed", "Update check failed", result.error);
    }
  }, [notify, updater]);
  const runUpdateAction = useCallback(
    (state: UpdateState = updater.state) => {
      if (state.status === "available") {
        void updater.downloadUpdate();
      } else if (state.status === "ready") {
        void updater.restartAndInstallUpdate();
      } else if (state.status === "failed") {
        void updater.downloadUpdate();
      } else if (state.status === "current" || state.status === "checking") {
        void updater.checkForUpdate(true);
      }
    },
    [updater],
  );

  const renderChatPane = (
    pane: ChatPaneRef,
    options: { isMaximized: boolean; isTiled: boolean },
  ) => {
    const paneSession =
      pane.kind === "session"
        ? sessions.find((session) => session.id === pane.sessionId)
        : undefined;
    const paneEvents =
      pane.kind === "session" ? (sessionEventsById[pane.sessionId] ?? []) : [];
    const paneDraftKey =
      pane.kind === "session" ? pane.sessionId : pane.draftKey;
    const panePlan =
      pane.kind === "session"
        ? deriveSessionPlan(paneEvents, pane.sessionId)
        : pendingNewChatPlan;
    const paneGoal =
      pane.kind === "session"
        ? deriveSessionGoal(paneEvents, pane.sessionId)
        : pendingNewChatGoal;
    const paneMode =
      pane.kind === "session" ? deriveChatMode(paneEvents) : pendingNewChatMode;
    const panePanel = chatPanelByPaneId[pane.paneId];
    const isFocused = pane.paneId === activeChatLayout?.focusedPaneId;
    const queue =
      pane.kind === "session" ? (chatMessageQueues[pane.sessionId] ?? []) : [];
    const requestSend = (message: string) => {
      if (isFocused) {
        void sendDraft(message);
        return;
      }
      pendingPaneSendRef.current = { paneId: pane.paneId, message };
      focusChatPane(pane);
    };
    const togglePanePanel = (panel: ChatSidePanelId) => {
      focusChatPane(pane);
      setChatPanelByPaneId((current) => ({
        ...current,
        [pane.paneId]: current[pane.paneId] === panel ? undefined : panel,
      }));
    };
    return (
      <ChatSurface
        activeChatPanel={panePanel}
        browserPreview={workbench.browserPreview}
        capabilityActivities={
          pane.kind === "session"
            ? Object.values(capabilityRunsBySessionId[pane.sessionId] ?? {})
            : []
        }
        capabilityPolicy={
          capabilityPoliciesByProject[normalizeProjectPath(pane.workspacePath)]
        }
        config={config}
        attachments={chatAttachments[paneDraftKey] ?? []}
        chatMode={paneMode}
        diffReview={workbench.diffReview}
        draftResetToken={draftResetToken}
        draft={chatDrafts[paneDraftKey] ?? ""}
        events={paneEvents}
        branchName={
          workbench.workspaceMode === "local"
            ? (branchCatalog?.current ?? paneSession?.branch)
            : paneSession?.branch
        }
        branchCatalog={branchCatalog}
        isEnvironmentRailOpen={panePanel === "environment"}
        isGoalComposerActive={isFocused && isGoalComposerActive}
        isComposerSending={
          pane.kind === "session"
            ? sendingSessionIds.includes(pane.sessionId)
            : isFocused && isStartingFirstTurn
        }
        isBranchLoading={isBranchLoading}
        isToolPanelOpen={isFocused && workbench.isToolPanelOpen}
        isTiled={options.isTiled}
        maxDraftLength={MAX_CHAT_MESSAGE_CHARS}
        onboarding={workbench.onboarding}
        onAgentAction={(action) => notify("terminal", "Agent action", action)}
        onCompleteOnboardingStep={(step) =>
          dispatchWorkbench({ type: "complete-onboarding-step", step })
        }
        onAttachMediaFiles={(files) => {
          focusChatPane(pane);
          void attachDroppedMedia(files, {
            draftKey: paneDraftKey,
            sessionId: pane.kind === "session" ? pane.sessionId : undefined,
            workspacePath: pane.workspacePath,
          });
        }}
        onComposerAction={(action) => {
          focusChatPane(pane);
          handleComposerAction(action);
        }}
        onDraftChange={(value) =>
          setChatDrafts((current) => ({ ...current, [paneDraftKey]: value }))
        }
        onRemoveAttachment={(attachmentId) =>
          setChatAttachments((current) => ({
            ...current,
            [paneDraftKey]: (current[paneDraftKey] ?? []).filter(
              (attachment) => attachment.id !== attachmentId,
            ),
          }))
        }
        onReusePrompt={(message) =>
          setChatDrafts((current) => ({ ...current, [paneDraftKey]: message }))
        }
        onStopChat={() => {
          focusChatPane(pane);
          if (pane.kind === "session" && isTauriRuntime()) {
            void invoke("stop_provider_chat", { sessionId: pane.sessionId });
          }
        }}
        onContinueChat={() => requestSend("Continue")}
        onCloseChat={() => {
          setChatPanelByPaneId((current) => {
            const next = { ...current };
            delete next[pane.paneId];
            return next;
          });
          dispatchChatGrid({
            type: "close-pane",
            projectKey:
              activeChatLayout?.projectKey ??
              normalizedChatProjectKey(pane.workspacePath),
            paneId: pane.paneId,
          });
        }}
        onOpenToolPanel={(tab) => {
          focusChatPane(pane);
          openToolPanel(tab);
        }}
        onToggleToolPanel={() => {
          focusChatPane(pane);
          toggleChatToolPanel();
        }}
        onPlanItemStatusChange={(itemId, status) => {
          focusChatPane(pane);
          changePlanItemStatus(itemId, status);
        }}
        onPlanAction={(action, itemId, value) => {
          focusChatPane(pane);
          changePlan(action, itemId, value);
        }}
        onPlanDecision={async (decision) => {
          focusChatPane(pane);
          return handlePlanDecision(decision);
        }}
        planEditorRequest={isFocused ? planEditorRequest : undefined}
        onPlanEditorRequestHandled={() => setPlanEditorRequest(undefined)}
        onGoalAction={(action, value) => {
          focusChatPane(pane);
          changeGoal(action, value);
        }}
        onCancelGoalComposer={() => setIsGoalComposerActive(false)}
        onLoadChangeDiff={loadInlineChangeDiff}
        onEditQueuedMessage={(messageId) => {
          focusChatPane(pane);
          editQueuedChatMessage(messageId);
        }}
        onRemoveQueuedMessage={(messageId) => {
          focusChatPane(pane);
          removeQueuedChatMessage(messageId);
        }}
        onSteerQueuedMessage={(messageId) => {
          focusChatPane(pane);
          steerQueuedChatMessage(messageId);
        }}
        onMutationApprovalAction={(proposalId, decision) => {
          focusChatPane(pane);
          handleMutationApprovalAction(proposalId, decision);
        }}
        onProviderApprovalAction={(approvalId, decision) => {
          focusChatPane(pane);
          handleProviderApprovalAction(approvalId, decision);
        }}
        onProviderStatusAction={(action, event) => {
          focusChatPane(pane);
          handleProviderStatusAction(action, event);
        }}
        onSend={requestSend}
        onSetOnboardingStep={(step) =>
          dispatchWorkbench({ type: "set-onboarding-step", step })
        }
        onToggleEnvironmentRail={() => togglePanePanel("environment")}
        onTogglePlanPanel={() => togglePanePanel("plan")}
        providerReadiness={workbench.providerReadiness}
        queuedMessages={queue.map((item) => ({
          attachmentCount: item.context.attachments?.length ?? 0,
          hasFailed: item.status === "failed",
          id: item.id,
          isDispatching: item.status === "sending",
          message: item.message,
        }))}
        savedProjects={savedProjects}
        sessionModel={{
          modelLabel: paneSession?.modelLabel,
          providerId: paneSession?.providerId,
          providerLabel: paneSession?.providerLabel,
          reasoningEffort: paneSession?.reasoningEffort,
        }}
        sessionPlan={panePlan}
        sessionGoal={paneGoal}
        sessionSummary={paneSession?.summary}
        sessionTitle={paneSession?.title}
        sourceControl={workbench.ide.sourceControl}
        terminalPanes={workbench.terminalPanes}
        turnSourceControlBaselines={turnSourceControlBaselines}
        worktreeName={paneSession?.worktreeName}
        workspaceMode={workbench.workspaceMode}
        workspacePath={pane.workspacePath}
      />
    );
  };

  return (
    <AppChrome
      activePaneTab={workbench.activePaneTab}
      activeDestination={activeDestination}
      activeSessionId={activeSessionId}
      sendingSessionIds={sendingSessionIds}
      activeSettingsSection={workbench.preferences.lastSettingsSection}
      activeWorkspaceLayout={activeWorkspaceLayout}
      commandProfiles={commandProfiles}
      updateState={updater.state}
      workspacePreparation={workspacePreparation}
      files={files}
      ide={workbench.ide}
      isChatsCollapsed={workbench.preferences.sidebarChatsCollapsed}
      notifications={workbench.notifications}
      onAddTerminalPane={addTerminalPane}
      onCloseTerminalPane={requestCloseTerminalPane}
      onCreateSession={startNewChat}
      onCreateCliSession={createCliSession}
      onDeleteSession={deleteSession}
      onDismissNotification={(id) =>
        dispatchWorkbench({ type: "dismiss-notification", id })
      }
      onOpenCommandPalette={openGlobalSearch}
      onOpenSettings={() =>
        dispatchWorkbench({
          type: "select-destination",
          destination: "settings",
        })
      }
      onOpenSettingsSection={openSettingsSection}
      onOpenWorkspace={openWorkspace}
      onUpdateAction={runUpdateAction}
      onRetryWorkspacePreparation={() => {
        const root = activeSession?.workspacePath ?? workspacePath;
        if (root) void prepareWorkspace(root);
      }}
      onOpenWorkspaceFile={openEditorLocation}
      onPinEditorTab={pinEditorTab}
      onRefreshWorkspace={refreshWorkspaceTree}
      onCreateWorkspacePath={createWorkspacePath}
      onRenameWorkspacePath={renameWorkspacePath}
      onDeleteWorkspacePath={deleteWorkspacePath}
      onOpenToolPanel={openToolPanel}
      onOpenSourceControlDiff={openSourceControlDiff}
      onCommitSourceControl={commitSourceControl}
      onRefreshSourceControl={refreshSourceControl}
      onDiscardSourceControlFile={discardSourceControlFile}
      onRunIdeTask={runIdeTask}
      onStartDebugSession={startIdeDebugSession}
      onSendDebugCommand={sendIdeDebugCommand}
      onStopDebugSession={stopIdeDebugSession}
      onRunWorkspaceSearch={(query) =>
        void runWorkspaceSearch({ query, maxResults: 200 })
      }
      onSelectIdeView={(view) =>
        dispatchWorkbench({ type: "ide-select-view", view })
      }
      onToggleSourceControlFile={stageSourceControlFile}
      onPinSession={pinSession}
      onRenameSession={renameSession}
      onRemoveProject={requestRemoveProject}
      onSelectDestination={selectDestination}
      onAddSessionToGrid={addSessionToChatGrid}
      onSelectSession={selectSession}
      onSelectSessions={() => dispatchWorkbench({ type: "select-sessions" })}
      onSelectTerminalPane={(paneId) => {
        dispatchWorkbench({ type: "select-terminal-pane", paneId });
        dispatchWorkbench({
          type: "select-workspace-layout",
          layout: "terminal-grid",
        });
      }}
      onSelectWorkspaceLayout={selectWorkspaceLayout}
      onSettingsBack={returnFromSettings}
      onSettingsSectionChange={(section: SettingsSectionId) =>
        dispatchWorkbench({ type: "set-settings-section", section })
      }
      onToggleChatsCollapsed={() =>
        dispatchWorkbench({ type: "toggle-sidebar-chats" })
      }
      pinnedSessionIds={pinnedSessionIds}
      openChatSessionIds={(activeChatLayout?.slots ?? []).flatMap((pane) =>
        pane?.kind === "session" ? [pane.sessionId] : [],
      )}
      savedProjects={savedProjects}
      selectedTerminalPaneId={workbench.selectedTerminalPaneId}
      sessions={visibleSessions}
      terminalPanes={workbench.terminalPanes}
      workspacePath={activeSession?.workspacePath ?? workspacePath}
    >
      {activeDestination === "workspace" ? (
        <div className={`gyro-workspace-route is-${activeWorkspaceLayout}`}>
          {activeWorkspaceLayout === "thread" ? (
            <section className="gyro-workspace-primary" aria-label="Thread">
              {activeChatLayout?.slots.some(Boolean) ? (
                <ChatGridSurface
                  layout={activeChatLayout}
                  maximizedPaneId={chatGrid.maximizedPaneId}
                  onDropSession={(
                    sessionId,
                    sourceProjectKey,
                    slotIndex,
                    placement,
                  ) => {
                    const session = sessions.find(
                      (item) => item.id === sessionId,
                    );
                    if (!session) return;
                    const projectKey = normalizedChatProjectKey(
                      session.workspacePath,
                    );
                    if (
                      sourceProjectKey &&
                      sourceProjectKey !== activeChatLayout.projectKey
                    ) {
                      notify(
                        "terminal",
                        "Chat project switched",
                        workspaceName(session.workspacePath),
                      );
                    }
                    dispatchChatGrid({
                      type: "select-pane",
                      projectKey,
                      mode: "drop",
                      slotIndex,
                      insertPosition: placement?.insertPosition,
                      splitDirection: placement?.splitDirection,
                      pane: chatPaneForSession(session),
                    });
                    activeSessionIdRef.current = session.id;
                    setActiveSessionId(session.id);
                    setWorkspacePath(session.workspacePath);
                    void refreshEvents(session.id);
                  }}
                  onFocusPane={focusChatPane}
                  onMovePane={(paneId, slotIndex) =>
                    dispatchChatGrid({
                      type: "move-pane",
                      projectKey: activeChatLayout.projectKey,
                      paneId,
                      slotIndex,
                    })
                  }
                  onToggleMaximize={(paneId) =>
                    dispatchChatGrid({
                      type: "toggle-maximize-pane",
                      paneId,
                    })
                  }
                  renderPane={renderChatPane}
                />
              ) : (
                <ChatSurface
                  activeChatPanel={activeChatPanel}
                  browserPreview={workbench.browserPreview}
                  capabilityPolicy={activeCapabilityPolicy}
                  config={config}
                  capabilityActivities={
                    activeSessionId
                      ? Object.values(
                          capabilityRunsBySessionId[activeSessionId] ?? {},
                        )
                      : []
                  }
                  attachments={activeChatAttachments}
                  chatMode={activeChatMode}
                  diffReview={workbench.diffReview}
                  draftResetToken={draftResetToken}
                  draft={activeChatDraft}
                  events={events}
                  branchName={
                    workbench.workspaceMode === "local"
                      ? (branchCatalog?.current ?? activeSession?.branch)
                      : activeSession?.branch
                  }
                  branchCatalog={branchCatalog}
                  isEnvironmentRailOpen={activeChatPanel === "environment"}
                  isGoalComposerActive={isGoalComposerActive}
                  isComposerSending={isActiveSessionSending}
                  isBranchLoading={isBranchLoading}
                  isToolPanelOpen={workbench.isToolPanelOpen}
                  maxDraftLength={MAX_CHAT_MESSAGE_CHARS}
                  onboarding={workbench.onboarding}
                  onAgentAction={(action) =>
                    notify("terminal", "Agent action", action)
                  }
                  onCompleteOnboardingStep={(step) =>
                    dispatchWorkbench({
                      type: "complete-onboarding-step",
                      step,
                    })
                  }
                  onAttachMediaFiles={attachDroppedMedia}
                  onComposerAction={handleComposerAction}
                  onDraftChange={updateActiveChatDraft}
                  onRemoveAttachment={removeChatAttachment}
                  onReusePrompt={updateActiveChatDraft}
                  onStopChat={stopActiveChat}
                  onContinueChat={() => void sendDraft("Continue")}
                  onOpenToolPanel={openToolPanel}
                  onToggleToolPanel={toggleChatToolPanel}
                  onPlanItemStatusChange={changePlanItemStatus}
                  onPlanAction={changePlan}
                  onPlanDecision={handlePlanDecision}
                  planEditorRequest={planEditorRequest}
                  onPlanEditorRequestHandled={() =>
                    setPlanEditorRequest(undefined)
                  }
                  onGoalAction={changeGoal}
                  onCancelGoalComposer={() => setIsGoalComposerActive(false)}
                  onLoadChangeDiff={loadInlineChangeDiff}
                  onEditQueuedMessage={editQueuedChatMessage}
                  onRemoveQueuedMessage={removeQueuedChatMessage}
                  onSteerQueuedMessage={steerQueuedChatMessage}
                  onMutationApprovalAction={handleMutationApprovalAction}
                  onProviderApprovalAction={handleProviderApprovalAction}
                  onProviderStatusAction={handleProviderStatusAction}
                  onSend={sendDraft}
                  onSetOnboardingStep={(step) =>
                    dispatchWorkbench({ type: "set-onboarding-step", step })
                  }
                  onToggleEnvironmentRail={() =>
                    dispatchWorkbench({ type: "toggle-chat-environment-rail" })
                  }
                  onTogglePlanPanel={() =>
                    dispatchWorkbench({ type: "toggle-chat-plan" })
                  }
                  providerReadiness={workbench.providerReadiness}
                  queuedMessages={activeQueuedChatMessages.map((item) => ({
                    attachmentCount: item.context.attachments?.length ?? 0,
                    hasFailed: item.status === "failed",
                    id: item.id,
                    isDispatching: item.status === "sending",
                    message: item.message,
                  }))}
                  savedProjects={savedProjects}
                  sessionModel={{
                    modelLabel: activeSession?.modelLabel,
                    providerId: activeSession?.providerId,
                    providerLabel: activeSession?.providerLabel,
                    reasoningEffort: activeSession?.reasoningEffort,
                  }}
                  sessionPlan={activeSessionPlan}
                  sessionGoal={activeSessionGoal}
                  sessionSummary={activeSession?.summary}
                  sessionTitle={activeSession?.title}
                  sourceControl={workbench.ide.sourceControl}
                  terminalPanes={workbench.terminalPanes}
                  turnSourceControlBaselines={turnSourceControlBaselines}
                  worktreeName={activeSession?.worktreeName}
                  workspaceMode={workbench.workspaceMode}
                  workspacePath={activeSession?.workspacePath ?? workspacePath}
                />
              )}
            </section>
          ) : null}

          {activeWorkspaceLayout === "terminal-grid"
            ? renderWorkspaceToolPanel(true)
            : null}

          {activeWorkspaceLayout === "code" ? (
            <section className="gyro-workspace-primary" aria-label="Workspace">
              <IdeSurface
                activePaneTab={workbench.activePaneTab}
                browserPreview={workbench.browserPreview}
                diffReview={workbench.diffReview}
                activeBuffer={activeEditorBuffer}
                editorSelection={workbench.ide.selection}
                editorRevealTarget={editorRevealTarget}
                editorTabs={workbench.ide.tabs}
                fileContent={selectedFileContent}
                fileError={selectedFileError}
                fileLoadState={selectedFileLoadState}
                files={files}
                ide={workbench.ide}
                workspacePath={activeSession?.workspacePath ?? workspacePath}
                onOpenWorkspace={openWorkspace}
                onAcceptAllDiffs={() =>
                  dispatchWorkbench({
                    type: "set-diff-review-state",
                    state: "approved",
                    action: "all changes approved",
                  })
                }
                onAcceptDiffFile={(path) =>
                  dispatchWorkbench({
                    type: "set-diff-file-state",
                    path,
                    state: "accepted",
                    action: `${path} accepted`,
                  })
                }
                onAddTerminalPane={addTerminalPane}
                onBrowserBack={() =>
                  dispatchWorkbench({ type: "browser-back" })
                }
                onBrowserDeviceChange={(device) =>
                  dispatchWorkbench({ type: "browser-device", device })
                }
                onBrowserForward={() =>
                  dispatchWorkbench({ type: "browser-forward" })
                }
                onBrowserNavigate={(url) =>
                  dispatchWorkbench({ type: "browser-navigate", url })
                }
                onBrowserOpenExternal={openBrowserPreviewExternal}
                onBrowserReload={() =>
                  dispatchWorkbench({ type: "browser-reload" })
                }
                onBrowserScreenshot={captureBrowserPreview}
                onBrowserUrlChange={(url) =>
                  dispatchWorkbench({ type: "set-browser-url", url })
                }
                onAssistantAction={runEditorAssistantAction}
                onCommentDiff={(path) =>
                  dispatchWorkbench({ type: "add-diff-comment", path })
                }
                onCloseEditorTab={closeEditorTab}
                onEditorChange={updateEditorBuffer}
                onEditorRevert={revertEditorBuffer}
                onEditorSave={saveEditorBuffer}
                onEditorSelectionChange={setEditorSelection}
                onKillTerminalPane={stopTerminalPane}
                onPaneTabChange={(tab) =>
                  dispatchWorkbench({ type: "set-pane-tab", tab })
                }
                onOpenDiffInEditor={(path, lineNumber, column) => {
                  openEditorLocation(path, lineNumber, column);
                  dispatchWorkbench({
                    type: "select-workspace-layout",
                    layout: "code",
                  });
                }}
                onRejectAllDiffs={() =>
                  dispatchWorkbench({
                    type: "set-diff-review-state",
                    state: "rejected",
                    action: "all changes rejected",
                  })
                }
                onRejectDiffFile={(path) =>
                  dispatchWorkbench({
                    type: "set-diff-file-state",
                    path,
                    state: "rejected",
                    action: `${path} rejected`,
                  })
                }
                onRenameTerminalPane={renameTerminalPane}
                onRunGitReviewAction={(actionId) =>
                  dispatchWorkbench({
                    type: "run-git-review-action",
                    actionId,
                  })
                }
                onRestartTerminalPane={restartTerminalPane}
                onSelectDiffFile={(path) =>
                  dispatchWorkbench({ type: "select-diff-file", path })
                }
                onSelectFile={openEditorFile}
                onPinEditorTab={pinEditorTab}
                onSelectEditorGroup={(groupId) => {
                  const group = workbench.ide.layout.groups.find(
                    (item) => item.id === groupId,
                  );
                  dispatchWorkbench({ type: "ide-select-group", groupId });
                  if (group?.activePath) {
                    setSelectedFile(group.activePath);
                  }
                }}
                onMoveEditorTab={(path, toGroupId, fromGroupId) =>
                  dispatchWorkbench({
                    type: "ide-move-tab",
                    path,
                    toGroupId,
                    fromGroupId,
                  })
                }
                onSelectTerminalPane={(paneId) =>
                  dispatchWorkbench({ type: "select-terminal-pane", paneId })
                }
                onCloseEditorGroup={closeEditorGroup}
                onSplitEditorGroup={(direction) =>
                  dispatchWorkbench({ type: "ide-split-group", direction })
                }
                onSplitTerminalPane={splitTerminalPane}
                onTerminalUtilityAction={handleTerminalUtilityAction}
                onToggleAssistant={() =>
                  dispatchWorkbench({ type: "ide-toggle-assistant" })
                }
                onToggleDiffDirectory={(directory) =>
                  dispatchWorkbench({
                    type: "toggle-diff-directory",
                    directory,
                  })
                }
                onToggleMinimap={() =>
                  dispatchWorkbench({ type: "ide-toggle-minimap" })
                }
                onUndoDiff={() =>
                  dispatchWorkbench({
                    type: "undo-diff-action",
                    action: "diff review reset",
                  })
                }
                onWriteTerminalInput={writeTerminalInput}
                selectedPath={selectedFile}
                selectedTerminalPaneId={workbench.selectedTerminalPaneId}
                showEmbeddedPanel={false}
                terminalOutput={terminalOutput}
                terminalPanes={workbench.terminalPanes}
                terminalTemplate={workbench.terminalTemplate}
                renderEditor={(props) => (
                  <MonacoEditorPane
                    {...props}
                    onLspRequest={requestLanguageFeature}
                    theme={workbench.preferences.theme}
                  />
                )}
              />
            </section>
          ) : null}

          {activeWorkspaceLayout !== "terminal-grid" &&
          (activeWorkspaceLayout !== "code" ||
            Boolean(activeSession?.workspacePath ?? workspacePath))
            ? workbench.isToolPanelOpen
              ? renderWorkspaceToolPanel(false)
              : null
            : null}
          {activeWorkspaceLayout === "code" ? (
            <IdeStatusBar
              activeBuffer={activeEditorBuffer}
              editorSelection={workbench.ide.selection}
              fileContent={selectedFileContent}
              fileLoadState={selectedFileLoadState}
              groupCount={Math.max(workbench.ide.layout.groups.length, 1)}
              ide={workbench.ide}
              selectedPath={selectedFile}
            />
          ) : null}
        </div>
      ) : null}
      {activeDestination === "settings" ? (
        <SettingsSurface
          activeSection={workbench.preferences.lastSettingsSection}
          cliLaunchPreset={workbench.preferences.cliLaunchPreset}
          config={config}
          density={workbench.preferences.density}
          showMenuBarIcon={workbench.preferences.showMenuBarIcon}
          onConfigChange={handleConfigChange}
          onCheckForUpdates={() => void checkForUpdatesWithFeedback()}
          onCliLaunchPresetChange={(preset: CliLaunchPreset) =>
            dispatchWorkbench({ type: "set-cli-launch-preset", preset })
          }
          onDensityChange={(density) =>
            dispatchWorkbench({ type: "set-density", density })
          }
          onMenuBarVisibilityChange={(visible) =>
            dispatchWorkbench({ type: "set-menu-bar-visible", visible })
          }
          onExportDiagnostics={() =>
            isTauriRuntime()
              ? void invoke<DiagnosticsExportResult>("export_diagnostics")
                  .then((result) =>
                    notify("terminal", "Diagnostics exported", result.path),
                  )
                  .catch((error) =>
                    notify(
                      "command-failed",
                      "Diagnostics export failed",
                      String(error),
                    ),
                  )
              : notify("terminal", "Diagnostics exported", "Preview bundle")
          }
          isTestingNotification={isTestingNotification}
          notificationPermission={notificationPermission}
          onTestNotification={() => void testSystemNotification()}
          onResetUiState={() => dispatchWorkbench({ type: "reset-state" })}
          onSectionChange={(section: SettingsSectionId) =>
            dispatchWorkbench({ type: "set-settings-section", section })
          }
          onThemeChange={(theme) =>
            dispatchWorkbench({ type: "set-theme", theme })
          }
          onTestProvider={testProvider}
          onToggleProvider={toggleProvider}
          selectedUsageProviderId={selectedUsageProviderId}
          usageVisualization={workbench.preferences.usageVisualization}
          onUsageProviderChange={(providerId) => {
            dispatchWorkbench({ type: "set-usage-provider", providerId });
          }}
          onUsageVisualizationChange={(visualization) =>
            dispatchWorkbench({
              type: "set-usage-visualization",
              visualization,
            })
          }
          onRefreshProviderUsage={(providerId) =>
            void refreshProviderUsage(providerId, true)
          }
          providerUsage={
            selectedUsageProviderId
              ? providerUsageByProvider[selectedUsageProviderId]
              : undefined
          }
          themeMode={workbench.preferences.theme}
          updateState={updater.state}
        />
      ) : null}
      {activeDestination === "tools" ? (
        <ToolsSurface
          automationCount={workbench.automations.length}
          connectedProviderCount={
            workbench.providerStatuses.filter(
              (provider) => provider.connectionStatus === "connected",
            ).length
          }
          onSelectDestination={selectDestination}
          taskCount={workbench.tasks.length}
        />
      ) : null}
      {activeDestination === "tasks" ? (
        <TaskBoardSurface
          onCreateTask={createTask}
          onDispatchTask={dispatchTask}
          onMoveTask={(taskId, status: TaskStatus) =>
            dispatchWorkbench({
              type: "move-task",
              taskId,
              status,
              event: `moved to ${status}`,
            })
          }
          onSelectTask={(taskId) =>
            dispatchWorkbench({ type: "select-task", taskId })
          }
          selectedTaskId={workbench.selectedTaskId}
          tasks={workbench.tasks}
        />
      ) : null}
      {activeDestination === "automations" ? (
        <AutomationsSurface
          automations={workbench.automations}
          onArchiveAutomation={archiveAutomation}
          onCreateAutomation={createAutomation}
          onRunAutomation={runAutomation}
          onSelectAutomation={(automationId) =>
            dispatchWorkbench({ type: "select-automation", automationId })
          }
          onToggleAutomation={toggleAutomation}
          selectedAutomationId={workbench.selectedAutomationId}
        />
      ) : null}
      {activeDestination === "providers" ? (
        <ProvidersSurface
          config={config}
          onAddCustomProfile={() => {
            const customProfile = {
              id: `custom-${Date.now()}`,
              displayName: "Custom Agent",
              command: "./agent.sh",
              args: [],
              workingDirectory: "Workspace",
            };
            void persistConfig({
              ...config,
              commandProfiles: [...commandProfiles, customProfile],
            });
          }}
          onQueueProviderHandoff={queueProviderHandoff}
          onTestProvider={testProvider}
          onToggleProvider={toggleProvider}
          providerHandoffs={workbench.providerHandoffs}
          providerSessions={workbench.providerSessions}
          providerStatuses={workbench.providerStatuses}
        />
      ) : null}
      {activeDestination === "onboarding" ? (
        <ChatSurface
          activeChatPanel={activeChatPanel}
          capabilityActivities={
            activeSessionId
              ? Object.values(capabilityRunsBySessionId[activeSessionId] ?? {})
              : []
          }
          capabilityPolicy={activeCapabilityPolicy}
          config={config}
          attachments={activeChatAttachments}
          chatMode={activeChatMode}
          draftResetToken={draftResetToken}
          draft={activeChatDraft}
          events={[]}
          branchCatalog={branchCatalog}
          branchName={
            workbench.workspaceMode === "local"
              ? (branchCatalog?.current ?? activeSession?.branch)
              : activeSession?.branch
          }
          isEnvironmentRailOpen={activeChatPanel === "environment"}
          isGoalComposerActive={isGoalComposerActive}
          isComposerSending={isActiveSessionSending}
          isBranchLoading={isBranchLoading}
          isToolPanelOpen={workbench.isToolPanelOpen}
          maxDraftLength={MAX_CHAT_MESSAGE_CHARS}
          onboarding={workbench.onboarding}
          onCompleteOnboardingStep={(step) =>
            dispatchWorkbench({ type: "complete-onboarding-step", step })
          }
          onAttachMediaFiles={attachDroppedMedia}
          onComposerAction={handleComposerAction}
          onDraftChange={updateActiveChatDraft}
          onRemoveAttachment={removeChatAttachment}
          onReusePrompt={updateActiveChatDraft}
          onStopChat={stopActiveChat}
          onContinueChat={() => void sendDraft("Continue")}
          onOpenToolPanel={openToolPanel}
          onToggleToolPanel={toggleChatToolPanel}
          onPlanItemStatusChange={changePlanItemStatus}
          onPlanAction={changePlan}
          onPlanDecision={handlePlanDecision}
          planEditorRequest={planEditorRequest}
          onPlanEditorRequestHandled={() => setPlanEditorRequest(undefined)}
          onGoalAction={changeGoal}
          onCancelGoalComposer={() => setIsGoalComposerActive(false)}
          onEditQueuedMessage={editQueuedChatMessage}
          onRemoveQueuedMessage={removeQueuedChatMessage}
          onSteerQueuedMessage={steerQueuedChatMessage}
          onMutationApprovalAction={handleMutationApprovalAction}
          onProviderApprovalAction={handleProviderApprovalAction}
          onProviderStatusAction={handleProviderStatusAction}
          onSend={sendDraft}
          onSetOnboardingStep={(step) =>
            dispatchWorkbench({ type: "set-onboarding-step", step })
          }
          sessionModel={{
            modelLabel: activeSession?.modelLabel,
            providerId: activeSession?.providerId,
            providerLabel: activeSession?.providerLabel,
            reasoningEffort: activeSession?.reasoningEffort,
          }}
          workspaceMode={workbench.workspaceMode}
          onToggleEnvironmentRail={() =>
            dispatchWorkbench({ type: "toggle-chat-environment-rail" })
          }
          onTogglePlanPanel={() =>
            dispatchWorkbench({ type: "toggle-chat-plan" })
          }
          providerReadiness={workbench.providerReadiness}
          queuedMessages={activeQueuedChatMessages.map((item) => ({
            attachmentCount: item.context.attachments?.length ?? 0,
            hasFailed: item.status === "failed",
            id: item.id,
            isDispatching: item.status === "sending",
            message: item.message,
          }))}
          savedProjects={savedProjects}
          sessionPlan={activeSessionPlan}
          sessionGoal={activeSessionGoal}
          showOnboardingSteps
          sourceControl={workbench.ide.sourceControl}
          turnSourceControlBaselines={turnSourceControlBaselines}
          workspacePath={workspacePath}
        />
      ) : null}
      {modelStandardPrompt ? (
        <ModelStandardPromptOverlay
          modelLabel={modelStandardPrompt.modelLabel}
          onAccept={acceptModelStandardPrompt}
          onDismiss={dismissModelStandardPrompt}
          providerId={modelStandardPrompt.providerId}
          providerLabel={modelStandardPrompt.providerLabel}
          selectionCount={modelStandardPrompt.count}
        />
      ) : null}
      {projectRemoveCandidate ? (
        <ProjectRemoveConfirmOverlay
          onKeep={() => setProjectRemoveCandidate(undefined)}
          onRemove={confirmRemoveProject}
          projectLabel={projectRemoveCandidate.label}
          projectPath={projectRemoveCandidate.path}
          sessionCount={projectRemoveCandidate.sessionCount}
        />
      ) : null}
      {terminalTerminateCandidate ? (
        <TerminalTerminateConfirmOverlay
          onCancel={() => setTerminalTerminateCandidate(undefined)}
          onTerminate={confirmTerminateTerminal}
          terminalLabel={
            commandProfiles.find(
              (profile) => profile.id === terminalTerminateCandidate.profileId,
            )?.displayName ?? terminalTerminateCandidate.title
          }
        />
      ) : null}
      {isCommandPaletteOpen ? (
        <CommandPaletteOverlay
          onClose={closeGlobalSearch}
          onCommand={runCommandPaletteCommand}
          onQueryChange={setCommandPaletteQuery}
          onSelectDestination={selectDestination}
          onOpenToolPanel={openToolPanel}
          onSelectProject={(path) => {
            void activateWorkspacePath(path, "Project selected")
              .then(() => startNewChat())
              .catch((error) =>
                notify("command-failed", "Project unavailable", String(error)),
              );
          }}
          onSelectSession={selectSession}
          onSelectWorkspaceLayout={selectWorkspaceLayout}
          pinnedSessionIds={pinnedSessionIds}
          projects={searchableProjects.map((project) => ({
            ...project,
            current:
              normalizeProjectPath(project.path) ===
              normalizeProjectPath(
                activeSession?.workspacePath ?? workspacePath,
              ),
          }))}
          query={commandPaletteQuery}
          recents={workbench.preferences.commandPaletteRecents}
          sessions={visibleSessions}
        />
      ) : null}
    </AppChrome>
  );
}

function loadInitialWorkbenchState(): WorkbenchState {
  const base = createInitialWorkbenchState();
  const legacyTheme = readBoundedLocalStorage(THEME_STORAGE_KEY, 16);
  const stored = readBoundedLocalStorage(
    WORKBENCH_STORAGE_KEY,
    MAX_STORED_WORKBENCH_STATE_CHARS,
  );
  if (!stored) {
    return {
      ...base,
      preferences: {
        ...base.preferences,
        theme: legacyTheme === "light" ? "light" : base.preferences.theme,
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
    const tasks = sanitizeStoredTasks(parsed.tasks);
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
      diffReview,
      ide: sanitizeStoredIdeState(parsed.ide, base.ide),
      isToolPanelOpen,
      notifications: Array.isArray(parsed.notifications)
        ? parsed.notifications.filter(
            (notification) =>
              notification.id !== "note-approval" &&
              notification.id !== "note-tests",
          )
        : base.notifications,
      onboarding: {
        ...base.onboarding,
        ...parsed.onboarding,
      },
      preferences: {
        ...base.preferences,
        ...parsed.preferences,
        activeChatPanel: undefined,
        chatEnvironmentRailOpen: false,
        theme:
          legacyTheme === "light" || legacyTheme === "dark"
            ? legacyTheme
            : (parsed.preferences?.theme ?? base.preferences.theme),
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

function normalizeStoredDestination(
  destination: unknown,
  fallback: AppDestination,
): AppDestination {
  if (
    destination === "workspace" ||
    destination === "tools" ||
    destination === "settings" ||
    destination === "tasks" ||
    destination === "automations" ||
    destination === "providers" ||
    destination === "onboarding"
  ) {
    return destination;
  }
  return fallback;
}

function normalizeStoredWorkspaceLayout(
  layout: unknown,
  fallback: WorkspaceLayoutId,
): WorkspaceLayoutId {
  if (layout === "thread" || layout === "terminal-grid" || layout === "code") {
    return layout;
  }
  return fallback;
}

function normalizeStoredSessionsLayout(
  layout: unknown,
  fallback: SessionsLayoutId,
): SessionsLayoutId {
  return layout === "thread" || layout === "terminal-grid" ? layout : fallback;
}

function normalizeStoredPaneTab(
  tab: unknown,
  fallback: WorkbenchPaneTab,
): WorkbenchPaneTab {
  if (tab === "terminal" || tab === "diff" || tab === "browser") {
    return tab;
  }
  return fallback;
}

function sanitizeStoredTerminalPanes(
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

function sanitizeStoredTasks(
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

function sanitizeStoredAutomations(
  automations: Partial<WorkbenchState>["automations"],
): WorkbenchState["automations"] {
  if (!Array.isArray(automations)) {
    return [];
  }
  return automations;
}

function sanitizeStoredDiffReview(
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
    collapsedDirectories: Array.isArray(diffReview.collapsedDirectories)
      ? diffReview.collapsedDirectories
      : base.diffReview.collapsedDirectories,
    gitActions: Array.isArray(diffReview.gitActions)
      ? diffReview.gitActions
      : base.diffReview.gitActions,
  };
}

function sanitizeStoredBrowserPreview(
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

function LiveTerminalPaneBody({
  isActive,
  onBell,
  onReconnect,
  onResize,
  onSelect,
  onWrite,
  pane,
  theme,
}: {
  isActive: boolean;
  onBell: (paneId: string) => void;
  onReconnect: (paneId: string) => void;
  onResize: (paneId: string, cols: number, rows: number) => void;
  onSelect: (paneId: string) => void;
  onWrite: (paneId: string, input: string) => void;
  pane: TerminalPane;
  theme: WorkbenchState["preferences"]["theme"];
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTermInstance | null>(null);
  const fitAddonRef = useRef<FitAddonInstance | null>(null);
  const paneOutputRef = useRef(pane.output ?? "");
  const renderedOutputRef = useRef("");
  const resizeFrameRef = useRef<number | undefined>();
  const lastSizeRef = useRef("");
  const statusRef = useRef(pane.status);
  const themeRef = useRef(theme);
  const onResizeRef = useRef(onResize);
  const onBellRef = useRef(onBell);
  const onWriteRef = useRef(onWrite);

  paneOutputRef.current = pane.output ?? "";
  themeRef.current = theme;

  useEffect(() => {
    statusRef.current = pane.status;
    onResizeRef.current = onResize;
    onBellRef.current = onBell;
    onWriteRef.current = onWrite;
  }, [onBell, onResize, onWrite, pane.status]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    let disposed = false;
    let disposeTerminal: (() => void) | undefined;

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !hostRef.current) {
          return;
        }

        const terminal = new Terminal({
          allowTransparency: true,
          cursorBlink: true,
          drawBoldTextInBrightColors: true,
          fontFamily:
            "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
          fontSize: 12,
          lineHeight: 1.35,
          macOptionIsMeta: true,
          minimumContrastRatio: 2.6,
          rightClickSelectsWord: true,
          scrollOnUserInput: true,
          scrollback: 5000,
          theme: terminalThemeFor(themeRef.current),
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(hostRef.current);
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        const initialOutput = paneOutputRef.current;
        if (initialOutput) {
          terminal.write(formatTerminalDelta(initialOutput));
          renderedOutputRef.current = initialOutput;
        }
        if (isActive) {
          terminal.focus();
        }

        const dataDisposable = terminal.onData((data) => {
          onWriteRef.current(pane.id, data);
        });
        const bellDisposable = terminal.onBell(() => {
          onBellRef.current(pane.id);
        });

        const fitAndReport = () => {
          try {
            fitAddon.fit();
            const sizeKey = `${terminal.cols}x${terminal.rows}`;
            if (
              statusRef.current === "running" &&
              sizeKey !== lastSizeRef.current
            ) {
              lastSizeRef.current = sizeKey;
              onResizeRef.current(pane.id, terminal.cols, terminal.rows);
            }
          } catch {
            // The terminal can be hidden during route transitions; the next resize fixes it.
          }
        };

        const scheduleFit = () => {
          if (resizeFrameRef.current) {
            window.cancelAnimationFrame(resizeFrameRef.current);
          }
          resizeFrameRef.current = window.requestAnimationFrame(fitAndReport);
        };

        const resizeObserver = new ResizeObserver(scheduleFit);
        resizeObserver.observe(hostRef.current);
        scheduleFit();

        disposeTerminal = () => {
          resizeObserver.disconnect();
          if (resizeFrameRef.current) {
            window.cancelAnimationFrame(resizeFrameRef.current);
          }
          dataDisposable.dispose();
          bellDisposable.dispose();
          terminal.dispose();
        };
      })
      .catch(() => {
        if (!disposed && hostRef.current) {
          hostRef.current.textContent = "Terminal renderer failed to load.";
        }
      });

    return () => {
      disposed = true;
      disposeTerminal?.();
      terminalRef.current = null;
      fitAddonRef.current = null;
      renderedOutputRef.current = "";
      lastSizeRef.current = "";
    };
  }, [pane.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    const nextOutput = pane.output ?? "";
    const previousOutput = renderedOutputRef.current;
    if (nextOutput === previousOutput) {
      return;
    }
    if (nextOutput.startsWith(previousOutput)) {
      terminal.write(
        formatTerminalDelta(nextOutput.slice(previousOutput.length)),
      );
    } else {
      terminal.clear();
      terminal.write(formatTerminalDelta(nextOutput));
    }
    renderedOutputRef.current = nextOutput;
  }, [pane.output]);

  useEffect(() => {
    if (isActive) {
      terminalRef.current?.focus();
    }
  }, [isActive]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.options.theme = terminalThemeFor(theme);
    }
  }, [theme]);

  return (
    <div className="gyro-xterm-frame">
      {pane.owner?.kind === "model" ? (
        <div className="gyro-model-terminal-notice" role="note">
          Model-owned process · your typed input and echoed output may be
          visible to this Chat
        </div>
      ) : null}
      <div
        aria-label="Terminal input"
        className="gyro-xterm-host"
        onClick={(event) => {
          event.stopPropagation();
          onSelect(pane.id);
          terminalRef.current?.focus();
        }}
        ref={hostRef}
        role="textbox"
        tabIndex={0}
      />
      {pane.status === "restored" ? (
        <button
          className="gyro-terminal-reconnect"
          onClick={(event) => {
            event.stopPropagation();
            onReconnect(pane.id);
          }}
          type="button"
        >
          Restart to reconnect
        </button>
      ) : null}
    </div>
  );
}

function terminalThemeFor(theme: WorkbenchState["preferences"]["theme"]) {
  if (theme === "light") {
    return {
      background: "#ffffff",
      black: "#1f242c",
      blue: "#1f66d1",
      brightBlack: "#5b6470",
      brightBlue: "#2f7dff",
      brightCyan: "#008f9a",
      brightGreen: "#168a50",
      brightMagenta: "#b034c9",
      brightRed: "#d92d20",
      brightWhite: "#171a20",
      brightYellow: "#a15c00",
      cursor: "#1f242c",
      cursorAccent: "#ffffff",
      cyan: "#007c89",
      foreground: "#25272d",
      green: "#087443",
      magenta: "#9b26b6",
      red: "#b42318",
      selectionBackground: "#dfe2e6",
      white: "#d8d9dc",
      yellow: "#875200",
    };
  }

  return {
    background: "#020304",
    black: "#05070a",
    blue: "#6ea8ff",
    brightBlack: "#7b8491",
    brightBlue: "#99c2ff",
    brightCyan: "#7ce7e1",
    brightGreen: "#7ee2a8",
    brightMagenta: "#f08cff",
    brightRed: "#ff8a88",
    brightWhite: "#f5f7fa",
    brightYellow: "#ffd166",
    cursor: "#e7edf6",
    cursorAccent: "#020304",
    cyan: "#51d7d0",
    foreground: "#e2e8f0",
    green: "#52d985",
    magenta: "#d86cff",
    red: "#ff6f6f",
    selectionBackground: "#1d3048",
    white: "#d9e0ea",
    yellow: "#f2c94c",
  };
}

function formatTerminalDelta(value: string) {
  return value.replace(/\r?\n/g, "\r\n");
}

function loadPreviewConfig(): GyroConfig {
  const stored = readBoundedLocalStorage(
    PREVIEW_CONFIG_STORAGE_KEY,
    MAX_STORED_PREVIEW_CONFIG_CHARS,
  );
  if (!stored) {
    return normalizedConfig(EMPTY_CONFIG);
  }
  try {
    return normalizedConfig({
      ...EMPTY_CONFIG,
      ...(JSON.parse(stored) as Partial<GyroConfig>),
    });
  } catch {
    return normalizedConfig(EMPTY_CONFIG);
  }
}

function loadPinnedSessionIds(): string[] {
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

function loadChatDrafts(): Record<string, string> {
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
          entry[1].length <= MAX_CHAT_MESSAGE_CHARS,
      ),
    );
  } catch {
    return {};
  }
}

function loadChatAttachments(): Record<string, ChatAttachment[]> {
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

function loadChatGridState(): ChatGridState {
  const stored = readBoundedLocalStorage(CHAT_GRID_STORAGE_KEY, 512_000);
  if (!stored) return createInitialChatGridState();
  try {
    return sanitizeStoredChatGridState(JSON.parse(stored));
  } catch {
    return createInitialChatGridState();
  }
}

function isSupportedChatImagePath(path: string) {
  return /\.(?:png|jpe?g|webp)$/i.test(path.trim());
}

function isSupportedChatVideoPath(path: string) {
  return /\.(?:mp4|m4v|mov|webm)$/i.test(path.trim());
}

function loadRemovedProjectPaths(): string[] {
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

function loadRecentProjectPaths(): string[] {
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

function normalizeProjectPath(path?: string) {
  return path?.trim().replace(/\/+$/, "") ?? "";
}

function chatPaneForSession(session: Session): ChatPaneRef {
  return {
    paneId: `session:${session.id}`,
    kind: "session",
    sessionId: session.id,
    workspacePath: session.workspacePath,
  };
}

function visibleSessionsForProjects(
  sessions: Session[],
  removedProjectPaths: string[],
) {
  const removed = new Set(removedProjectPaths.map(normalizeProjectPath));
  return sessions.filter(
    (session) => !removed.has(normalizeProjectPath(session.workspacePath)),
  );
}

function readBoundedLocalStorage(key: string, maxChars: number) {
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored || stored.length > maxChars) {
      return undefined;
    }
    return stored;
  } catch {
    return undefined;
  }
}

function safeSetLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Local storage can be unavailable or quota-limited in preview contexts.
  }
}

function flushPersistedWorkbenchState(ref: { current?: WorkbenchState }) {
  const pending = ref.current;
  if (!pending) {
    return;
  }
  ref.current = undefined;
  safeSetLocalStorage(WORKBENCH_STORAGE_KEY, JSON.stringify(pending));
}

function schedulePersistedWorkbenchStateFlush(
  pendingRef: { current?: WorkbenchState },
  idleRef: { current?: number },
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
        flushPersistedWorkbenchState(pendingRef);
      },
      { timeout: WORKBENCH_PERSIST_IDLE_TIMEOUT_MS },
    );
    return;
  }
  idleRef.current = window.setTimeout(() => {
    idleRef.current = undefined;
    flushPersistedWorkbenchState(pendingRef);
  }, 0);
}

function cancelPersistedWorkbenchStateFlush(ref: { current?: number }) {
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

function persistableWorkbenchState(workbench: WorkbenchState): WorkbenchState {
  return {
    ...workbench,
    activeTurn: undefined,
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
      buffers: {},
      selection: undefined,
      outputChannels: workbench.ide.outputChannels.map(
        persistableOutputChannel,
      ),
    },
  };
}

function persistableOutputChannel(channel: OutputChannel): OutputChannel {
  return {
    ...channel,
    lines: channel.lines.slice(-MAX_PERSISTED_OUTPUT_CHANNEL_LINES),
  };
}

function truncatePersistedText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  return `...${value.slice(-maxChars)}`;
}

function normalizeChatMessage(value: string) {
  return value.replace(/\u0000/g, "").trim();
}

function normalizeSessionTitleInput(value: string) {
  const normalized = value
    .replace(/\u0000/g, "")
    .replace(/[`*_#[\](){}<>|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s:;,.!?'"-]+|[\s:;,.!?'"-]+$/g, "");
  if (!normalized) {
    return undefined;
  }
  const chars = Array.from(normalized);
  return chars.length > 80 ? `${chars.slice(0, 77).join("")}...` : normalized;
}

function sessionTitleFromMessage(message: string) {
  const cleaned = normalizeChatMessage(message)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\/\w+\s+/, "")
    .split(/[.!?\n]/)[0]
    ?.replace(
      /^(please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|i\s+want\s+to\s+|i\s+need\s+to\s+|help\s+me\s+|let'?s\s+)/i,
      "",
    )
    .trim();
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

function shouldSuggestSessionTitle(
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

function isGenericSessionTitle(title: string) {
  return [
    "Desktop session",
    "New chat",
    "Worktree session",
    "CLI workspace",
    "Worktree CLI workspace",
  ].includes(title.trim());
}

function chatMessageLength(value: string) {
  return Array.from(value).length;
}

function chatMessagePreview(value: string) {
  const normalized = normalizeChatMessage(value).replace(/\s+/g, " ");
  const chars = Array.from(normalized);
  if (chars.length <= 160) {
    return normalized;
  }
  return `${chars.slice(0, 160).join("")}...`;
}

function normalizedPreviewUrl(value: string) {
  const trimmed = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Preview URLs must use http or https");
  }
  return url.toString();
}

function languageServerDescriptorForPath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return {
        languageId:
          extension === "tsx"
            ? "typescriptreact"
            : extension === "jsx"
              ? "javascriptreact"
              : extension?.startsWith("j") ||
                  extension === "mjs" ||
                  extension === "cjs"
                ? "javascript"
                : "typescript",
        command: "typescript-language-server --stdio",
      };
    case "rs":
      return { languageId: "rust", command: "rust-analyzer" };
    case "json":
    case "jsonc":
      return {
        languageId: "json",
        command: "vscode-json-language-server --stdio",
      };
    case "css":
    case "scss":
    case "less":
      return {
        languageId: extension,
        command: "vscode-css-language-server --stdio",
      };
    case "html":
    case "htm":
      return {
        languageId: "html",
        command: "vscode-html-language-server --stdio",
      };
    default:
      return undefined;
  }
}

function workspaceFileUri(workspacePath: string, relativePath: string) {
  const fullPath =
    `${workspacePath.replace(/[\\/]+$/, "")}/${relativePath.replace(/^[/\\]+/, "")}`
      .replaceAll("\\", "/")
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  return `file://${fullPath}`;
}

function diagnosticsFromLspMessages(
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

function lspRelativePath(uri: string, workspacePath: string) {
  try {
    const absolutePath = decodeURIComponent(uri.replace(/^file:\/\//, ""));
    const normalizedRoot = workspacePath
      .replaceAll("\\", "/")
      .replace(/\/$/, "");
    return absolutePath.startsWith(`${normalizedRoot}/`)
      ? absolutePath.slice(normalizedRoot.length + 1)
      : absolutePath;
  } catch {
    return uri;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberField(value: Record<string, unknown> | undefined, key: string) {
  return typeof value?.[key] === "number" ? value[key] : 0;
}

function getCommandProfile(
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

function terminalProcessForProfile(
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

function terminalStatusFromSnapshot(
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

function terminalPaneFromSnapshot(
  snapshot: TerminalPaneSnapshot,
  mode: WorkbenchState["workspaceMode"],
) {
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

function terminalSnapshotFromCapabilityData(
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

function capabilityActivityFromSessionEvent(
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
    sessionId: event.sessionId,
    turnId: event.turnId,
    createdAt: event.createdAt,
  };
}

function markInactiveCapabilityResources(
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

function capabilityApprovalFromSessionEvent(
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
    choices: ["deny", "allow-once", "allow-project"],
  };
}

function inferredTerminalProfileId(snapshot: TerminalPaneSnapshot): string {
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

function isPlainShellTerminal(pane: TerminalPane): boolean {
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

function terminalPaneProcessIsMissing(error: unknown): boolean {
  return String(error).toLowerCase().includes("terminal pane not found");
}

function terminalSizeForTemplate(template: TerminalTemplate) {
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

function pathFromSessionEvent(event: SessionEvent): string {
  const payload = recordFromUnknown(event.payload);
  const directPath = stringFromRecord(payload, "path");
  const dataPath = stringFromRecord(recordFromUnknown(payload?.data), "path");
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
}

function turnIdFromSessionEvent(event: SessionEvent): string | undefined {
  if (event.turnId) {
    return event.turnId;
  }
  if (
    typeof event.payload === "object" &&
    event.payload &&
    "turnId" in event.payload &&
    typeof event.payload.turnId === "string"
  ) {
    return event.payload.turnId;
  }
  return undefined;
}

function deriveActiveTurn(
  events: SessionEvent[],
  sessionTitle = "Desktop session",
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
      changedFiles.add(pathFromSessionEvent(event));
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
      const proposalId = stringFromRecord(payload, "proposalId");
      const status = stringFromRecord(payload, "status");
      if (
        proposalId &&
        status &&
        stringFromRecord(payload, "kind") === "mutation-approval"
      ) {
        mutationApprovalStatuses.set(proposalId, status);
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

  const status =
    approvalsPending > 0
      ? "waiting"
      : hasStreamingAssistant
        ? "running"
        : hasCommandOutput ||
            (!hasCommandRequest && lastEvent.kind === "assistant-message")
          ? "done"
          : hasCommandRequest
            ? "running"
            : "queued";

  return {
    id: turnId,
    sessionId: latestUserEvent.sessionId,
    sessionTitle,
    status,
    startedAt: latestUserEvent.createdAt,
    updatedAt: lastEvent.createdAt,
    lastEvent:
      lastEvent.kind === "assistant-message"
        ? "Assistant response received"
        : lastEvent.message,
    changedFiles: changedFiles.size,
    approvalsPending,
  };
}

function isStreamingAssistantSessionEvent(event: SessionEvent) {
  const payload = recordFromUnknown(event.payload);
  return (
    event.kind === "assistant-message" &&
    payload?.kind === "provider-stream" &&
    payload.streaming === true
  );
}

function areWorkbenchTurnsEqual(
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

function deriveSessionPlan(
  events: SessionEvent[],
  sessionId?: string,
): SessionPlan {
  const assistantContentByTurnId = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "assistant-message" || !event.message.trim()) {
      continue;
    }
    const turnId = turnIdFromSessionEvent(event);
    if (turnId) {
      assistantContentByTurnId.set(turnId, event.message.trim());
    }
  }
  let plan: SessionPlan = {
    sessionId,
    title: "Plan",
    items: [],
  };

  for (const event of events) {
    if (event.kind !== "plan-updated") {
      continue;
    }
    if (!plan.createdAt) {
      plan = { ...plan, createdAt: event.createdAt };
    }
    const payload = recordFromUnknown(event.payload);
    const action = stringFromRecord(payload, "action") ?? "replace";
    const sourceTurnId =
      turnIdFromSessionEvent(event) ?? stringFromRecord(payload, "turnId");
    const providerId = stringFromRecord(payload, "providerId");
    const title = stringFromRecord(payload, "title");
    const content =
      stringFromRecord(payload, "content") ??
      stringFromRecord(payload, "markdown") ??
      (action === "replace" && sourceTurnId
        ? assistantContentByTurnId.get(sourceTurnId)
        : undefined);
    if (title) {
      plan = { ...plan, title };
    }
    if (content) {
      plan = { ...plan, content };
    }
    if (sourceTurnId && (action === "replace" || !plan.sourceTurnId)) {
      plan = { ...plan, sourceTurnId };
    }
    if (providerId) {
      plan = { ...plan, providerId };
    }

    if (action === "clear") {
      plan = {
        ...plan,
        content: undefined,
        items: [],
        updatedAt: event.createdAt,
      };
      continue;
    }

    const payloadItems = Array.isArray(payload?.items)
      ? payload.items
      : undefined;
    if (payloadItems && (action === "add-item" || action === "append")) {
      plan = {
        ...plan,
        items: [
          ...plan.items,
          ...payloadItems.map((item, index) =>
            normalizePlanItem(item, event, plan.items.length + index),
          ),
        ],
        updatedAt: event.createdAt,
      };
      continue;
    }

    if (action === "replace" || payloadItems) {
      plan = {
        ...plan,
        items: (payloadItems ?? []).map((item, index) =>
          normalizePlanItem(item, event, index),
        ),
        updatedAt: event.createdAt,
      };
      continue;
    }

    const payloadItem = payload?.item;
    if (!payloadItem) {
      plan = { ...plan, updatedAt: event.createdAt };
      continue;
    }

    const nextItemRecord = recordFromUnknown(payloadItem);
    const explicitTitle =
      stringFromRecord(nextItemRecord, "title") ??
      stringFromRecord(nextItemRecord, "label");
    const explicitDetail = stringFromRecord(nextItemRecord, "detail");
    const nextItem = normalizePlanItem(payloadItem, event, plan.items.length);
    if (action === "remove-item") {
      plan = {
        ...plan,
        items: plan.items.filter((item) => item.id !== nextItem.id),
        updatedAt: event.createdAt,
      };
      continue;
    }

    const existingItem = plan.items.find((item) => item.id === nextItem.id);
    const items = existingItem
      ? plan.items.map((item) =>
          item.id === nextItem.id
            ? {
                ...item,
                ...nextItem,
                createdAt: item.createdAt,
                detail: explicitDetail ?? item.detail,
                title: explicitTitle ?? item.title,
              }
            : item,
        )
      : [...plan.items, nextItem];
    plan = { ...plan, items, updatedAt: event.createdAt };
  }

  return plan;
}

function deriveSessionGoal(
  events: SessionEvent[],
  sessionId?: string,
): SessionGoal | undefined {
  let goal: SessionGoal | undefined;
  for (const event of events) {
    if (event.kind !== "goal-updated") {
      continue;
    }
    const payload = recordFromUnknown(event.payload);
    const action = stringFromRecord(payload, "action") ?? "set";
    if (action === "clear") {
      goal = undefined;
      continue;
    }
    const text = stringFromRecord(payload, "text") ?? goal?.text;
    if (!text) {
      continue;
    }
    goal = {
      sessionId,
      text,
      status:
        stringFromRecord(payload, "status") === "complete"
          ? "complete"
          : "active",
      sourceTurnId:
        stringFromRecord(payload, "sourceTurnId") ?? goal?.sourceTurnId,
      createdAt: goal?.createdAt ?? event.createdAt,
      updatedAt: event.createdAt,
    };
  }
  return goal;
}

function deriveChatMode(events: SessionEvent[]): ChatMode {
  let mode: ChatMode = "normal";
  for (const event of events) {
    if (event.kind !== "chat-mode-changed") {
      continue;
    }
    const value = stringFromRecord(recordFromUnknown(event.payload), "mode");
    mode = value === "plan" ? "plan" : "normal";
  }
  return mode;
}

function normalizePlanItem(
  value: unknown,
  event: SessionEvent,
  index: number,
): SessionPlanItem {
  const record = recordFromUnknown(value);
  const title =
    stringFromRecord(record, "title") ??
    stringFromRecord(record, "label") ??
    `Checklist item ${index + 1}`;
  const sourceTurnId =
    stringFromRecord(record, "sourceTurnId") ??
    turnIdFromSessionEvent(event) ??
    stringFromRecord(record, "turnId");
  const id =
    stringFromRecord(record, "id") ??
    `${event.id}-${slugify(title) || `item-${index + 1}`}`;
  return {
    id,
    title,
    detail: stringFromRecord(record, "detail"),
    status: normalizePlanStatus(record?.status),
    sourceTurnId,
    providerId:
      stringFromRecord(record, "providerId") ??
      stringFromRecord(recordFromUnknown(event.payload), "providerId"),
    createdAt: stringFromRecord(record, "createdAt") ?? event.createdAt,
    updatedAt: stringFromRecord(record, "updatedAt") ?? event.createdAt,
  };
}

function normalizePlanStatus(value: unknown): SessionPlanItemStatus {
  if (
    value === "todo" ||
    value === "in-progress" ||
    value === "complete" ||
    value === "blocked"
  ) {
    return value;
  }
  if (value === "done") {
    return "complete";
  }
  if (value === "doing" || value === "running") {
    return "in-progress";
  }
  return "todo";
}

function recordFromUnknown(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function planStatusVerb(status: SessionPlanItemStatus) {
  switch (status) {
    case "in-progress":
      return "started";
    case "complete":
      return "completed";
    case "blocked":
      return "blocked";
    case "todo":
    default:
      return "reopened";
  }
}

function createPlanSessionEvent(
  sessionId: string,
  message: string,
  payload: Record<string, unknown>,
): SessionEvent {
  const now = new Date().toISOString();
  const turnId =
    typeof payload.turnId === "string" ? payload.turnId : undefined;
  return {
    id: `plan-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    sessionId,
    turnId,
    createdAt: now,
    kind: "plan-updated",
    message,
    payload,
  };
}

function createGoalSessionEvent(
  sessionId: string,
  message: string,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    id: `goal-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    sessionId,
    createdAt: new Date().toISOString(),
    kind: "goal-updated",
    message,
    payload,
  };
}

function createEditorSessionEvent(
  sessionId: string,
  eventKind: string,
  message: string,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    id: `editor-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    sessionId,
    createdAt: new Date().toISOString(),
    kind:
      eventKind === "ai-edit-proposed" ? "file-edit-proposed" : "system-event",
    message,
    payload: {
      kind: eventKind,
      surface: "desktop-ide",
      data: payload,
    },
  };
}

function workspaceContentToEditorBuffer(
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

function untrackedWorkspaceFileDiff(path: string, file: WorkspaceFileContent) {
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

function sourceControlLineStats(sourceControl: SourceControlState) {
  return Object.fromEntries(
    sourceControl.files.map((file) => [
      file.path.replaceAll("\\", "/"),
      { additions: file.additions, deletions: file.deletions },
    ]),
  );
}

function workspaceName(path?: string) {
  return path?.split("/").filter(Boolean).at(-1) ?? "Untitled";
}

function savedProjectsFromSessions(
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
  recentProjectPaths.forEach((path, index) =>
    upsertProject(path, new Date(Date.now() - index).toISOString(), {
      countSession: false,
    }),
  );
  sessions.forEach((session) =>
    upsertProject(session.workspacePath, session.updatedAt),
  );

  const currentPath = normalizeProjectPath(currentWorkspacePath);
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

function parentDirectory(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function relativeFilePath(path: string, parent: string) {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedParent = parent.replaceAll("\\", "/").replace(/\/+$/, "");
  const prefix = `${normalizedParent}/`;
  return normalizedPath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : workspaceName(normalizedPath);
}

function editorPathMatches(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}

function renameEditorPath(path: string, fromPath: string, toPath: string) {
  return editorPathMatches(path, fromPath)
    ? `${toPath}${path.slice(fromPath.length)}`
    : path;
}

function workspaceTreeSignature(files: WorkspaceFile[]) {
  return files
    .map((file) => `${file.kind}:${file.path}:${file.depth ?? ""}`)
    .join("\n");
}

function disposeEditorModels(paths: string[]) {
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

function MonacoEditorPane({
  buffer,
  fileContent,
  loadState,
  minimapEnabled,
  onChange,
  onLspRequest,
  onSelectionChange,
  path,
  revealTarget,
  theme,
}: {
  buffer?: EditorBuffer;
  fileContent?: WorkspaceFileContent;
  loadState: "idle" | "loading" | "ready" | "error";
  minimapEnabled: boolean;
  onChange: (value: string) => void;
  onLspRequest?: (
    path: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  onSelectionChange: (selection?: EditorSelection) => void;
  path?: string;
  revealTarget?: EditorRevealTarget;
  theme: WorkbenchState["preferences"]["theme"];
}) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const languageRegistrationsRef = useRef<Array<{ dispose: () => void }>>([]);
  const revealEditorTarget = useCallback(
    (editor: Parameters<OnMount>[0]) => {
      if (!revealTarget || revealTarget.path !== path) {
        return;
      }
      const position = {
        lineNumber: revealTarget.lineNumber,
        column: revealTarget.column,
      };
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
      editor.focus();
    },
    [path, revealTarget],
  );
  useEffect(() => {
    if (editorRef.current) {
      revealEditorTarget(editorRef.current);
    }
  }, [revealEditorTarget, revealTarget?.nonce]);
  useEffect(
    () => () => {
      languageRegistrationsRef.current.forEach((registration) =>
        registration.dispose(),
      );
      languageRegistrationsRef.current = [];
    },
    [],
  );

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    revealEditorTarget(editor);
    languageRegistrationsRef.current.forEach((registration) =>
      registration.dispose(),
    );
    languageRegistrationsRef.current = [];
    if (path && onLspRequest) {
      const language = languageForPath(path);
      const completionRegistration =
        monaco.languages.registerCompletionItemProvider(language, {
          triggerCharacters: [".", '"', "'", "/", "<", ":"],
          provideCompletionItems: async (model, position, context) => {
            try {
              const result = await onLspRequest(
                path,
                "textDocument/completion",
                {
                  position: {
                    line: position.lineNumber - 1,
                    character: position.column - 1,
                  },
                  context: {
                    triggerKind: context.triggerKind,
                    triggerCharacter: context.triggerCharacter,
                  },
                },
              );
              const resultRecord = isRecord(result) ? result : undefined;
              const items = Array.isArray(result)
                ? result
                : Array.isArray(resultRecord?.items)
                  ? resultRecord.items
                  : [];
              const word = model.getWordUntilPosition(position);
              const fallbackRange = new monaco.Range(
                position.lineNumber,
                word.startColumn,
                position.lineNumber,
                word.endColumn,
              );
              return {
                suggestions: items.flatMap((value) => {
                  if (!isRecord(value)) {
                    return [];
                  }
                  const label = completionLabel(value.label);
                  if (!label) {
                    return [];
                  }
                  const textEdit = isRecord(value.textEdit)
                    ? value.textEdit
                    : undefined;
                  const rangeValue = textEdit?.range ?? value.range;
                  const range =
                    monacoRangeFromLsp(monaco, rangeValue) ?? fallbackRange;
                  const insertText =
                    typeof textEdit?.newText === "string"
                      ? textEdit.newText
                      : typeof value.insertText === "string"
                        ? value.insertText
                        : label;
                  return [
                    {
                      label,
                      detail:
                        typeof value.detail === "string"
                          ? value.detail
                          : undefined,
                      documentation: completionDocumentation(
                        value.documentation,
                      ),
                      insertText,
                      kind: monacoCompletionKind(monaco, value.kind),
                      range,
                    },
                  ];
                }),
              };
            } catch {
              return { suggestions: [] };
            }
          },
        });
      const hoverRegistration = monaco.languages.registerHoverProvider(
        language,
        {
          provideHover: async (_model, position) => {
            try {
              const result = await onLspRequest(path, "textDocument/hover", {
                position: {
                  line: position.lineNumber - 1,
                  character: position.column - 1,
                },
              });
              if (!isRecord(result)) {
                return null;
              }
              const markdown = lspMarkdown(result.contents);
              if (!markdown) {
                return null;
              }
              return {
                contents: [{ value: markdown }],
                range: monacoRangeFromLsp(monaco, result.range),
              };
            } catch {
              return null;
            }
          },
        },
      );
      languageRegistrationsRef.current = [
        completionRegistration,
        hoverRegistration,
      ];
    }
    editor.onDidChangeCursorSelection((event) => {
      const model = editor.getModel();
      if (!model || !path) {
        onSelectionChange(undefined);
        return;
      }
      const text = model.getValueInRange(event.selection);
      if (!text) {
        onSelectionChange(undefined);
        return;
      }
      onSelectionChange({
        path,
        startLineNumber: event.selection.startLineNumber,
        startColumn: event.selection.startColumn,
        endLineNumber: event.selection.endLineNumber,
        endColumn: event.selection.endColumn,
        text,
      });
    });
  };

  if (loadState === "loading") {
    return <div className="gyro-code-empty">Loading file preview...</div>;
  }
  if (!path) {
    return <div className="gyro-code-empty">Select a workspace file.</div>;
  }

  return (
    <Suspense
      fallback={<div className="gyro-code-empty">Loading editor...</div>}
    >
      <MonacoEditor
        height="100%"
        keepCurrentModel
        language={languageForPath(path)}
        onChange={(value) => onChange(value ?? "")}
        onMount={handleMount}
        options={{
          automaticLayout: true,
          bracketPairColorization: { enabled: true },
          fontFamily:
            "SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace",
          fontLigatures: false,
          fontSize: 13.5,
          guides: { bracketPairs: true, indentation: true },
          lineHeight: 21,
          minimap: { enabled: minimapEnabled, scale: 0.75 },
          overviewRulerBorder: false,
          padding: { top: 8, bottom: 12 },
          renderWhitespace: "selection",
          scrollbar: {
            horizontalScrollbarSize: 10,
            verticalScrollbarSize: 10,
          },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          stickyScroll: { enabled: true, maxLineCount: 3 },
          tabSize: 2,
          wordWrap: "off",
        }}
        path={path}
        theme={theme === "light" ? "vs" : "gyro-dark"}
        value={buffer?.content ?? fileContent?.content ?? ""}
      />
    </Suspense>
  );
}

function languageForPath(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "css":
      return "css";
    case "html":
      return "html";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "rs":
      return "rust";
    case "ts":
      return "typescript";
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return "plaintext";
  }
}

function monacoRangeFromLsp(monaco: Parameters<OnMount>[1], value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  const start = isRecord(value.start) ? value.start : undefined;
  const end = isRecord(value.end) ? value.end : undefined;
  if (!start || !end) {
    return undefined;
  }
  return new monaco.Range(
    numberField(start, "line") + 1,
    numberField(start, "character") + 1,
    numberField(end, "line") + 1,
    numberField(end, "character") + 1,
  );
}

function monacoCompletionKind(monaco: Parameters<OnMount>[1], value: unknown) {
  const kinds = monaco.languages.CompletionItemKind;
  switch (value) {
    case 2:
      return kinds.Method;
    case 3:
      return kinds.Function;
    case 4:
      return kinds.Constructor;
    case 5:
      return kinds.Field;
    case 6:
      return kinds.Variable;
    case 7:
      return kinds.Class;
    case 8:
      return kinds.Interface;
    case 9:
      return kinds.Module;
    case 10:
      return kinds.Property;
    case 13:
      return kinds.Enum;
    case 14:
      return kinds.Keyword;
    case 15:
      return kinds.Snippet;
    case 21:
      return kinds.Constant;
    default:
      return kinds.Text;
  }
}

function completionLabel(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return isRecord(value) && typeof value.label === "string"
    ? value.label
    : undefined;
}

function completionDocumentation(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.value === "string") {
    return { value: value.value };
  }
  return undefined;
}

function lspMarkdown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(lspMarkdown).filter(Boolean).join("\n\n");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.language === "string" && typeof value.value === "string") {
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
  }
  return typeof value.value === "string" ? value.value : "";
}

function createTurnId() {
  return globalThis.crypto?.randomUUID?.() ?? `turn-${Date.now()}`;
}

function providerLabelForId(
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

function selectedSessionModelFromConfig(config: GyroConfig) {
  const provider = providersForConfig(config).find(
    (item) => item.id === config.selectedProviderId,
  );
  const model = provider ? getProviderModel(provider) : undefined;
  return {
    providerId: provider?.id,
    providerLabel: provider?.displayName,
    modelId: model?.id ?? provider?.selectedModelId,
    modelLabel: model?.displayName ?? provider?.selectedModelId,
    reasoningEffort: provider ? selectedReasoningEffort(provider) : undefined,
  };
}

function approvalNotificationCopy(
  config: GyroConfig,
  mode: "auto" | "direct" | "gated",
) {
  const providerName =
    config.selectedProviderId === "anthropic"
      ? "Claude"
      : config.selectedProviderId === "kimi"
        ? "Kimi"
        : "Codex";
  if (mode === "gated") {
    return {
      title: "Ask before executing",
      detail: `${providerName} will ask before commands and file edits.`,
    };
  }

  if (mode === "auto") {
    return {
      title: "Auto approve",
      detail: `${providerName} can work without prompts inside the workspace boundary.`,
    };
  }

  return {
    title: "Full access",
    detail: `${providerName} can run commands and apply edits without prompts.`,
  };
}

function createProviderHealthOutput(
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
      return "xai provider-env auth available; XAI_API_KEY is set; value not read by Gyro.";
    case "cursor":
      return "cursor-agent: logged in; command available";
    case "gemini":
      return "gemini provider-env auth available; GEMINI_API_KEY is set; value not read by Gyro.";
    case "opencode":
      return "opencode: local config available";
    case "custom":
      return "custom command failed: executable not found";
    default:
      return `${provider.displayName}: health output inconclusive`;
  }
}

const previewFiles: WorkspaceFile[] = [
  { path: "apps", kind: "directory", depth: 1 },
  { path: "apps/desktop", kind: "directory", depth: 2 },
  { path: "apps/desktop/src", kind: "directory", depth: 3 },
  { path: "apps/desktop/src/App.tsx", kind: "file", depth: 4 },
  { path: "apps/desktop/src-tauri", kind: "directory", depth: 3 },
  { path: "apps/desktop/src-tauri/src", kind: "directory", depth: 4 },
  {
    path: "apps/desktop/src-tauri/src/lib.rs",
    kind: "file",
    depth: 5,
  },
  { path: "crates", kind: "directory", depth: 1 },
  { path: "crates/gyro-core", kind: "directory", depth: 2 },
  { path: "crates/gyro-core/src", kind: "directory", depth: 3 },
  { path: "crates/gyro-core/src/sessions.rs", kind: "file", depth: 4 },
  { path: "docs", kind: "directory", depth: 1 },
  { path: "docs/architecture.md", kind: "file", depth: 2 },
  { path: "packages", kind: "directory", depth: 1 },
  { path: "packages/ui", kind: "directory", depth: 2 },
  { path: "packages/ui/src", kind: "directory", depth: 3 },
  { path: "packages/ui/src/styles.css", kind: "file", depth: 4 },
  { path: "packages/ui/src/surfaces.tsx", kind: "file", depth: 4 },
];

function createPreviewWorkspaceFileContent(path: string): WorkspaceFileContent {
  const content = `// ${path}
// File preview is connected through the desktop workspace bridge.
// Open the Tauri app with a local workspace to read real file contents.`;
  return {
    path,
    content,
    contentHash: `preview-${content.length}`,
    truncated: false,
    sizeBytes: new TextEncoder().encode(content).length,
  };
}

function createPreviewSession(
  layout: WorkspaceLayoutId,
  mode: WorkbenchState["workspaceMode"] = "local",
  model: Partial<
    Pick<
      Session,
      | "modelId"
      | "modelLabel"
      | "providerId"
      | "providerLabel"
      | "reasoningEffort"
    >
  > = {},
  workspacePath = "",
  titleOverride?: string,
  sessionId = `preview-${Date.now()}`,
): Session {
  const now = new Date().toISOString();
  const metadata = workspaceRunMetadata(mode, layout);
  const defaultTitle =
    layout === "terminal-grid"
      ? mode === "worktree"
        ? "Worktree CLI workspace"
        : "CLI workspace"
      : mode === "worktree"
        ? "Worktree session"
        : "Desktop session";
  return {
    id: sessionId,
    title: normalizeSessionTitleInput(titleOverride ?? "") ?? defaultTitle,
    workspacePath,
    origin: layout === "terminal-grid" ? "cli" : "desktop",
    workspaceMode: metadata.workspaceMode,
    branch: metadata.branch,
    worktreeName: metadata.worktreeName,
    providerId: model.providerId,
    providerLabel: model.providerLabel,
    modelId: model.modelId,
    modelLabel: model.modelLabel,
    reasoningEffort: model.reasoningEffort,
    createdAt: now,
    updatedAt: now,
    eventsPath: "preview://events",
  };
}

async function createTauriThreadSession(
  workspacePath: string | undefined,
  mode: WorkbenchState["workspaceMode"],
  model: ReturnType<typeof selectedSessionModelFromConfig>,
  titleOverride?: string,
): Promise<Session> {
  const workspace = workspacePath ?? "";
  const shouldCreateWorktree = mode === "worktree" && workspace.length > 0;
  const title =
    normalizeSessionTitleInput(titleOverride ?? "") ??
    (shouldCreateWorktree ? "Worktree session" : "Desktop session");
  const metadata = workspaceRunMetadata(
    shouldCreateWorktree ? "worktree" : "local",
    `${title}-${Date.now()}`,
  );

  if (shouldCreateWorktree) {
    return invoke<Session>("create_worktree_session", {
      branch: metadata.branch,
      ...model,
      title,
      worktreeName: metadata.worktreeName,
      workspacePath: workspace,
    });
  }

  return invoke<Session>("create_desktop_session", {
    ...model,
    title,
    workspacePath: workspace,
  });
}

function createAutomationDraft(
  mode: WorkbenchState["workspaceMode"],
  workspacePath: string,
  provider: ModelProviderConfig,
): AutomationDraft {
  const metadata = workspaceRunMetadata(mode, "heartbeat-automation");
  const model = getProviderModel(provider);
  return {
    title: "Heartbeat check",
    prompt:
      "Check the workspace, run the smoke gate, and report only if attention is needed.",
    schedule: "heartbeat",
    project: workspaceName(workspacePath),
    provider: provider.displayName,
    branch: metadata.branch,
    workspaceMode: metadata.workspaceMode,
    worktreeName: metadata.worktreeName,
    stopCondition:
      "Stop after the workspace passes smoke twice without changes.",
    nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    execution: {
      workspacePath,
      providerId: provider.id,
      providerLabel: provider.displayName,
      modelId: model?.id ?? provider.selectedModelId,
      modelLabel: model?.displayName,
      reasoningEffort: selectedReasoningEffort(provider),
    },
  };
}

function createPreviewAutomation(draft: AutomationDraft): Automation {
  const now = new Date().toISOString();
  return {
    ...draft,
    id: `automation-${Date.now()}`,
    status: "current",
    triageState: "none",
    lastResult: "Waiting for first local run",
    unreadResults: 0,
    runHistory: [
      {
        id: `run-draft-${Date.now()}`,
        status: "queued",
        startedAt: now,
        summary: "Automation created locally",
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function workspaceRunMetadata(
  mode: WorkbenchState["workspaceMode"],
  label: string,
  workingDirectory?: string,
) {
  if (mode === "local") {
    return { workspaceMode: mode, branch: "main", workingDirectory };
  }
  const slug = slugify(label || "task");
  return {
    workspaceMode: mode,
    branch: `gyro/${slug}`,
    worktreeName: `gyro-${slug}`,
    workingDirectory,
  };
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function createOptimisticTurnEvents(
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

type OptimisticProviderStatus = HarnessRunStatus | "ready";

function providerStatusPayload(
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

function providerStatusMessage(
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

function rekeySessionEvents(events: SessionEvent[], sessionId: string) {
  return events.map((event) => ({
    ...event,
    id: event.id.replace(event.sessionId, sessionId),
    sessionId,
  }));
}

function providerStreamBatchKey(sessionId: string, turnId: string) {
  return `${sessionId}:${turnId}`;
}

function applyProviderChatStreamEvent(
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
  if (streamEvent.phase === "started" || streamEvent.phase === "completed") {
    updateOptimisticProviderStatus(
      optimisticEventsRef,
      setEvents,
      streamEvent.sessionId,
      turnId,
      streamEvent.status ??
        (streamEvent.phase === "completed" ? "done" : "running"),
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
    limitSessionEventsForUi(
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

function updateOptimisticProviderStatus(
  optimisticEventsRef: { current: Map<string, SessionEvent[]> },
  setEvents: (
    value: SessionEvent[] | ((current: SessionEvent[]) => SessionEvent[]),
  ) => void,
  sessionId: string,
  turnId: string,
  status: OptimisticProviderStatus,
  error?: string,
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
      message: providerStatusMessage(status, {
        id: stringFromRecord(payload, "providerId") ?? "openai",
        displayName: providerLabel,
      } as ModelProviderConfig),
      payload: {
        ...payload,
        completedAt: isActiveStatus ? undefined : now,
        durationMs:
          !isActiveStatus &&
          Number.isFinite(startedAtMs) &&
          Number.isFinite(completedAtMs)
            ? Math.max(0, completedAtMs - startedAtMs)
            : undefined,
        error,
        startedAt,
        status,
      },
    };
  };
  const optimisticEvents = optimisticEventsRef.current.get(sessionId);
  if (optimisticEvents) {
    optimisticEventsRef.current.set(
      sessionId,
      limitSessionEventsForUi(updateEvents(optimisticEvents)),
    );
  }
  setEvents((current) => {
    if (!current.some((event) => event.sessionId === sessionId)) {
      return current;
    }
    return limitSessionEventsForUi(updateEvents(current));
  });
}
