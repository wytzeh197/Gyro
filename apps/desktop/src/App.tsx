import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Editor, { type OnMount } from "@monaco-editor/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  AppChrome,
  CLI_LAUNCH_PRESET_MAX_PANES,
  AutomationsSurface,
  ChatSurface,
  CommandPaletteOverlay,
  IdeSurface,
  ModelStandardPromptOverlay,
  ProvidersSurface,
  SettingsSurface,
  TaskBoardSurface,
  ToolsSurface,
  WorkspaceToolPanel,
  WorkspaceToolPanelPeek,
  createInitialWorkbenchState,
  createNotification,
  createTerminalPane,
  defaultCommandProfiles,
  getProviderModel,
  isProviderId,
  normalizeCliLaunchPreset,
  normalizedConfig,
  parseProviderHealthOutput,
  providersForConfig,
  workbenchReducer,
  type AppDestination,
  type Automation,
  type ChatSidePanelId,
  type CliLaunchPreset,
  type CommandProfile,
  type EditorBuffer,
  type EditorSelection,
  type GyroAccountSession,
  type GyroAccountStatus,
  type GyroConfig,
  type IdeAssistantAction,
  type IdeAssistantRequest,
  type ModelProviderConfig,
  type ProviderHealthDetails,
  type ProviderId,
  type ProviderHandoff,
  type ProviderSession,
  type Session,
  type SessionEvent,
  type SessionPlan,
  type SessionPlanItem,
  type SessionPlanItemStatus,
  type SettingsSectionId,
  type Task,
  type TaskStatus,
  type TerminalPaneStatus,
  type TerminalPane,
  type TerminalTemplate,
  type WorkbenchPaneTab,
  type WorkbenchState,
  type WorkbenchTurn,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type WorkspaceLayoutId,
} from "@gyro-dev/ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

type AppNotification = {
  kind: "open-session" | "attach-session";
  sessionId: string;
  workspacePath: string;
  workspaceMode?: WorkbenchState["workspaceMode"];
  branch?: string;
  worktreeName?: string;
};

type TerminalPaneSnapshot = {
  paneId: string;
  title: string;
  command: string;
  output: string;
  status: "running" | "done" | "failed";
  exitCode?: number | null;
  cols: number;
  rows: number;
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

type WorkspaceFileWriteRequest = {
  workspacePath: string;
  path: string;
  content: string;
  expectedHash?: string;
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
};

const EMPTY_CONFIG: GyroConfig = {
  updateChannel: "stable",
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
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

const DEFAULT_WORKSPACE_PATH = "/Users/wytzehemrica/Documents/Gyro";
const WORKBENCH_STORAGE_KEY = "gyro.workbench-state";
const PINNED_SESSIONS_STORAGE_KEY = "gyro.pinned-session-ids";
const PREVIEW_CONFIG_STORAGE_KEY = "gyro.preview-config";
const THEME_STORAGE_KEY = "gyro.theme";
const MODEL_USAGE_STORAGE_KEY = "gyro.model-standard-usage";
const MODEL_STANDARD_PROMPT_THRESHOLD = 3;
const MODEL_STANDARD_PROMPT_SNOOZE_SELECTIONS = 3;
const DEFAULT_TOOL_PANEL_HEIGHT = 280;
const PROVIDER_AUTH_POLL_INTERVAL_MS = 3_000;
const PROVIDER_AUTH_POLL_ATTEMPTS = 40;
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

function loadModelUsageMap(): ModelUsageMap {
  try {
    const stored = window.localStorage.getItem(MODEL_USAGE_STORAGE_KEY);
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
  window.localStorage.setItem(MODEL_USAGE_STORAGE_KEY, JSON.stringify(usage));
}

export function App() {
  const [workbench, dispatchWorkbench] = useReducer(
    workbenchReducer,
    undefined,
    loadInitialWorkbenchState,
  );
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const optimisticEventsRef = useRef(new Map<string, SessionEvent[]>());
  const [workspacePath, setWorkspacePath] = useState<string>();
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>();
  const [selectedFileContent, setSelectedFileContent] =
    useState<WorkspaceFileContent>();
  const [selectedFileError, setSelectedFileError] = useState("");
  const [selectedFileLoadState, setSelectedFileLoadState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [draft, setDraft] = useState("");
  const [terminalOutput, setTerminalOutput] = useState("");
  const [config, setConfig] = useState<GyroConfig>(loadPreviewConfig);
  const [accountStatus, setAccountStatus] =
    useState<GyroAccountStatus>("checking");
  const [accountSession, setAccountSession] = useState<GyroAccountSession>({
    signedIn: false,
  });
  const [accountError, setAccountError] = useState("");
  const [activeProfileId, setActiveProfileId] = useState("shell");
  const [isLaunchingCliPreset, setIsLaunchingCliPreset] = useState(false);
  const [pinnedSessionIds, setPinnedSessionIds] =
    useState<string[]>(loadPinnedSessionIds);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [modelStandardPrompt, setModelStandardPrompt] =
    useState<ModelStandardPrompt>();
  const [toolPanelHeight, setToolPanelHeight] = useState(
    DEFAULT_TOOL_PANEL_HEIGHT,
  );
  const [isStartingFirstTurn, setIsStartingFirstTurn] = useState(false);
  const suppressSessionAutoSelectRef = useRef(false);
  const ingestedSessionEventIds = useRef(new Set<string>());
  const lastNonSettingsDestinationRef = useRef<AppDestination>("workspace");
  const initialTerminalRestoreModeRef = useRef(workbench.workspaceMode);

  const activeDestination = workbench.activeDestination;
  const activeWorkspaceLayout = workbench.activeWorkspaceLayout;
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
  const activeSessionPlan = useMemo(
    () => deriveSessionPlan(events, activeSessionId),
    [activeSessionId, events],
  );
  const visibleSessions = useMemo(() => {
    const pinned = new Set(pinnedSessionIds);
    return [...sessions].sort((first, second) => {
      const firstPinned = pinned.has(first.id);
      const secondPinned = pinned.has(second.id);
      if (firstPinned === secondPinned) {
        return 0;
      }
      return firstPinned ? -1 : 1;
    });
  }, [pinnedSessionIds, sessions]);

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
      const readyProvider = enabledProviders.find(
        (provider) => provider.authStatus === "connected" || provider.enabled,
      );

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
      const message = targetProvider
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
    async (nextConfig: GyroConfig) => {
      const normalizedNextConfig = normalizedConfig(nextConfig);
      setConfig(normalizedNextConfig);
      window.localStorage.setItem(
        PREVIEW_CONFIG_STORAGE_KEY,
        JSON.stringify({
          ...normalizedNextConfig,
          accountSession: { signedIn: false },
        }),
      );
      if (!isTauriRuntime()) {
        notify("provider", "Settings saved locally", "Preview config updated");
        return;
      }
      try {
        await invoke("save_config", { config: normalizedNextConfig });
        notify("provider", "Settings saved", "Configuration persisted");
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

  const applyAccountSession = useCallback((session: GyroAccountSession) => {
    setAccountSession(session);
    setAccountStatus(session.signedIn ? "signed-in" : "signed-out");
    setAccountError("");
    setConfig((current) =>
      normalizedConfig({
        ...current,
        accountSession: session,
      }),
    );
    if (session.signedIn) {
      dispatchWorkbench({
        type: "complete-onboarding-step",
        step: "account",
      });
    }
  }, []);

  const refreshAccount = useCallback(async () => {
    if (!isTauriRuntime()) {
      applyAccountSession({ signedIn: true, name: "Preview user" });
      return;
    }

    setAccountStatus("checking");
    try {
      const session = await invoke<GyroAccountSession>(
        "refresh_account_session",
      );
      applyAccountSession(session);
    } catch (error) {
      try {
        const session = await invoke<GyroAccountSession>("get_account_session");
        applyAccountSession(session);
      } catch {
        setAccountSession({ signedIn: false });
        setAccountStatus("signed-out");
        setAccountError(String(error));
      }
    }
  }, [applyAccountSession]);

  const startAccountLogin = useCallback(async () => {
    setAccountStatus("signing-in");
    setAccountError("");

    if (!isTauriRuntime()) {
      applyAccountSession({
        signedIn: true,
        name: "Preview user",
        email: "preview@gyro.dev",
      });
      return;
    }

    try {
      const session = await invoke<GyroAccountSession>("start_account_login");
      applyAccountSession(session);
      notify("provider", "Gyro access ready", session.name ?? "This device");
    } catch (error) {
      setAccountStatus("failed");
      setAccountError(String(error));
      notify("command-failed", "Gyro sign-in failed", String(error));
    }
  }, [applyAccountSession, notify]);

  const logoutAccount = useCallback(async () => {
    if (isTauriRuntime()) {
      try {
        await invoke<GyroAccountSession>("logout_account");
      } catch (error) {
        notify("command-failed", "Sign out failed", String(error));
        return;
      }
    }
    applyAccountSession({ signedIn: false });
    notify(
      "provider",
      "Device access cleared",
      "Local sessions stayed on this Mac",
    );
  }, [applyAccountSession, notify]);

  const refreshSessions = useCallback(async () => {
    if (!isTauriRuntime()) {
      setSessions([]);
      return;
    }
    try {
      const nextSessions = await invoke<Session[]>("list_sessions");
      setSessions(nextSessions);
      setActiveSessionId((current) => {
        if (current || suppressSessionAutoSelectRef.current) {
          return current;
        }
        return nextSessions[0]?.id;
      });
      setWorkspacePath((current) => current ?? nextSessions[0]?.workspacePath);
    } catch {
      setSessions([]);
    }
  }, []);

  const refreshEvents = useCallback(async (sessionId: string) => {
    const optimisticEvents = optimisticEventsRef.current.get(sessionId);
    if (!isTauriRuntime()) {
      setEvents(optimisticEvents ?? []);
      return;
    }
    try {
      const nextEvents = await invoke<SessionEvent[]>("read_session_events", {
        sessionId,
      });
      setEvents(
        mergePersistedAndOptimisticEvents(nextEvents, optimisticEvents),
      );
    } catch {
      setEvents(optimisticEvents ?? []);
    }
  }, []);

  const refreshAutomations = useCallback(async () => {
    if (!isTauriRuntime()) {
      return;
    }
    try {
      await invoke<number>(AUTOMATION_SCHEDULER_COMMANDS.recoverLeases);
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

  const revealToolPanel = useCallback(() => {
    setToolPanelHeight((current) =>
      current < DEFAULT_TOOL_PANEL_HEIGHT ? DEFAULT_TOOL_PANEL_HEIGHT : current,
    );
    dispatchWorkbench({ type: "open-tool-panel" });
  }, []);

  const openSettingsSection = useCallback((section: SettingsSectionId) => {
    dispatchWorkbench({ type: "set-settings-section", section });
    dispatchWorkbench({
      type: "select-destination",
      destination: "settings",
    });
  }, []);

  const openWorkspace = useCallback(async () => {
    if (!isTauriRuntime()) {
      setWorkspacePath(DEFAULT_WORKSPACE_PATH);
      setFiles(previewFiles);
      dispatchWorkbench({
        type: "complete-onboarding-step",
        step: "workspace",
      });
      notify("terminal", "Workspace opened", "Preview workspace is active");
      return;
    }
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open workspace",
      });
      if (typeof selected !== "string") {
        return;
      }
      setWorkspacePath(selected);
      const workspaceFiles = await invoke<WorkspaceFile[]>(
        "list_workspace_tree",
        { depth: 5, workspacePath: selected },
      );
      setFiles(workspaceFiles);
      dispatchWorkbench({
        type: "complete-onboarding-step",
        step: "workspace",
      });
      notify("terminal", "Workspace opened", selected);
    } catch {
      setWorkspacePath(DEFAULT_WORKSPACE_PATH);
      setFiles(previewFiles);
      notify("command-failed", "Workspace open failed", "Using preview files");
    }
  }, [notify]);

  const selectContextFile = useCallback(async () => {
    if (!isTauriRuntime()) {
      const previewFile = previewFiles[0]?.path ?? "apps/desktop/src/App.tsx";
      setWorkspacePath(DEFAULT_WORKSPACE_PATH);
      setFiles(previewFiles);
      setSelectedFile(previewFile);
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
      setWorkspacePath(workspace);
      setSelectedFile(relativePath);
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
  }, [notify]);

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
      );
      setWorkspacePath(session.workspacePath);
      setFiles([]);
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
      setEvents([]);
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
      const title = shouldCreateWorktree
        ? "Worktree session"
        : "Desktop session";
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
      );
      setWorkspacePath(session.workspacePath);
      setFiles([]);
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
      setEvents([]);
      notify("command-failed", "Session fallback", "Created preview session");
    }
  }, [config, notify, refreshSessions, workbench.workspaceMode, workspacePath]);

  const startNewChat = useCallback(() => {
    suppressSessionAutoSelectRef.current = true;
    optimisticEventsRef.current.clear();
    setIsStartingFirstTurn(false);
    setActiveSessionId(undefined);
    setEvents([]);
    setDraft("");
    dispatchWorkbench({ type: "select-workspace-layout", layout: "thread" });
    dispatchWorkbench({ type: "close-tool-panel" });
  }, []);

  const pinSession = useCallback(
    (sessionId: string) => {
      const isPinned = pinnedSessionIds.includes(sessionId);
      const session = sessions.find((item) => item.id === sessionId);
      setPinnedSessionIds((current) =>
        current.includes(sessionId)
          ? current.filter((id) => id !== sessionId)
          : [sessionId, ...current],
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

      if (!isTauriRuntime()) {
        setSessions((current) =>
          current.map((item) =>
            item.id === sessionId
              ? {
                  ...item,
                  title: nextTitle,
                  updatedAt: new Date().toISOString(),
                }
              : item,
          ),
        );
        notify("terminal", "Chat renamed", nextTitle);
        return;
      }

      try {
        const renamed = await invoke<Session>("rename_session", {
          sessionId,
          title: nextTitle,
        });
        setSessions((current) => [
          renamed,
          ...current.filter((item) => item.id !== sessionId),
        ]);
        notify("terminal", "Chat renamed", renamed.title);
      } catch {
        notify(
          "command-failed",
          "Rename failed",
          "The chat name was not changed",
        );
      }
    },
    [notify, sessions],
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
      setPinnedSessionIds((current) =>
        current.filter((id) => id !== sessionId),
      );
      if (activeSessionId === sessionId) {
        setActiveSessionId(nextSessions[0]?.id);
        setEvents([]);
      }
      notify("terminal", "Chat deleted", session?.title ?? sessionId);
    },
    [activeSessionId, notify, sessions],
  );

  const launchTerminalPane = useCallback(
    async ({
      commandOverride,
      paneId = `pane-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      profile,
      startingOutput = "",
      template,
    }: {
      commandOverride?: string;
      paneId?: string;
      profile: CommandProfile;
      startingOutput?: string;
      template?: TerminalTemplate;
    }) => {
      const process = terminalProcessForProfile(profile, commandOverride);
      const paneExists = workbench.terminalPanes.some(
        (pane) => pane.id === paneId,
      );
      if (!paneExists) {
        const pane = createTerminalPane(
          paneId,
          profile,
          "running",
          workspaceRunMetadata(workbench.workspaceMode, profile.displayName),
        );
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
              rows: size?.rows,
              title: profile.displayName,
              workspacePath:
                activeSession?.workspacePath ??
                workspacePath ??
                DEFAULT_WORKSPACE_PATH,
              workingDirectory: profile.workingDirectory,
            },
          },
        );
        const status = terminalStatusFromSnapshot(snapshot.status);
        dispatchWorkbench({
          type: "sync-terminal-pane-snapshot",
          paneId: snapshot.paneId,
          command: snapshot.command,
          event:
            snapshot.exitCode === null || snapshot.exitCode === undefined
              ? snapshot.status
              : `${snapshot.status} (${snapshot.exitCode})`,
          output: snapshot.output,
          status,
        });
        setTerminalOutput(snapshot.output);
        return true;
      } catch (error) {
        dispatchWorkbench({
          type: "set-terminal-pane-status",
          paneId,
          status: "failed",
          event: "process failed to start",
        });
        setTerminalOutput(String(error));
        return false;
      }
    },
    [
      activeSession?.workspacePath,
      notify,
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
                updatedAt: new Date().toISOString(),
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
      void persistConfig({
        ...config,
        selectedProviderId: providerId,
        modelProviders: providers,
      });
      if (activeSessionId && provider) {
        void saveSessionModel(activeSessionId, {
          providerId,
          providerLabel: provider.displayName,
          modelId: model?.id ?? provider.selectedModelId,
          modelLabel: model?.displayName,
        });
      }
      notify(
        "provider",
        "Provider selected",
        provider?.displayName ?? providerId,
      );
    },
    [activeSessionId, config, notify, persistConfig, saveSessionModel],
  );

  const setProviderAuthStatus = useCallback(
    (providerId: ProviderId, authStatus: ModelProviderConfig["authStatus"]) => {
      const providers = providersForConfig(config).map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              authStatus,
              enabled: authStatus === "connected",
            }
          : provider,
      );
      void persistConfig({
        ...config,
        selectedProviderId: providerId,
        modelProviders: providers,
      });
      dispatchWorkbench({
        type: "set-provider-status",
        providerId,
        status: authStatus === "connected" ? "connected" : "disconnected",
      });
    },
    [config, persistConfig],
  );

  const recordProviderHealthOutput = useCallback(
    (providerId: ProviderId, output: string, check?: ProviderHealthCheck) => {
      const result = parseProviderHealthOutput(providerId, output);
      const details = check
        ? providerHealthDetailsFromCheck(check, result.healthDetails)
        : result.healthDetails;
      dispatchWorkbench({
        type: "record-provider-health",
        providerId,
        status: result.connectionStatus,
        summary: result.healthSummary ?? "Health check complete.",
        details,
        output,
      });

      if (result.connectionStatus === "connected") {
        setProviderAuthStatus(providerId, "connected");
      } else if (result.connectionStatus === "not-configured") {
        setProviderAuthStatus(providerId, "not-connected");
      } else if (result.connectionStatus === "failed") {
        setProviderAuthStatus(providerId, "failed");
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
      const providers = providersForConfig(config).map((item) =>
        item.id === providerId
          ? { ...item, authStatus: "connecting" as const, enabled: false }
          : item,
      );
      void persistConfig({
        ...config,
        selectedProviderId: providerId,
        modelProviders: providers,
      });
      dispatchWorkbench({
        type: "set-provider-status",
        providerId,
        status: "checking",
      });
      notify("provider", "Connecting provider", providerLabel);

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
            notify("provider", "Provider connected", providerLabel);
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
        setProviderAuthStatus(providerId, "not-connected");
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
        workspaceRunMetadata(workbench.workspaceMode, profile.displayName),
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
        notify("provider", "Preview provider connected", providerLabel);
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
              workspacePath:
                activeSession?.workspacePath ??
                workspacePath ??
                DEFAULT_WORKSPACE_PATH,
              workingDirectory: profile.workingDirectory,
            },
          },
        );
        dispatchWorkbench({
          type: "sync-terminal-pane-snapshot",
          paneId: snapshot.paneId,
          command: snapshot.command,
          event:
            snapshot.exitCode === null || snapshot.exitCode === undefined
              ? snapshot.status
              : `${snapshot.status} (${snapshot.exitCode})`,
          output: snapshot.output,
          status: terminalStatusFromSnapshot(snapshot.status),
        });
        setTerminalOutput(snapshot.output);
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
            notify("provider", "Provider connected", providerLabel);
            return;
          }
        }

        setProviderAuthStatus(providerId, "not-connected");
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
      persistConfig,
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
      const providers = providersForConfig(config).map((provider) =>
        provider.id === providerId
          ? { ...provider, selectedModelId: modelId }
          : provider,
      );
      const provider = providers.find((item) => item.id === providerId);
      const selectedModel = provider
        ? getProviderModel(provider, modelId)
        : undefined;
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
        });
      }
      notify(
        "provider",
        "Model selected",
        selectedModel
          ? `${provider?.displayName ?? providerId} · ${selectedModel.displayName}`
          : modelId,
      );
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
      notify,
      persistConfig,
      recordModelSelection,
      saveSessionModel,
    ],
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

  const startWorkspaceLayout = useCallback(
    (layout: WorkspaceLayoutId) => {
      if (layout === "thread") {
        startNewChat();
        return;
      }
      dispatchWorkbench({ type: "select-workspace-layout", layout });
      if (layout === "terminal-grid") {
        addTerminalPane();
      }
    },
    [addTerminalPane, startNewChat],
  );

  const handleComposerAction = useCallback(
    (action: string) => {
      const currentWorkspacePath =
        activeSession?.workspacePath ?? workspacePath;
      const setComposerWorkspaceMode = (
        nextMode: WorkbenchState["workspaceMode"],
      ) => {
        dispatchWorkbench({ type: "set-workbench-mode", mode: nextMode });
        dispatchWorkbench({ type: "close-tool-panel" });
        if (nextMode === "worktree" && !currentWorkspacePath) {
          notify(
            "terminal",
            "Choose a workspace",
            "Worktree mode needs a repo or folder before the chat starts.",
          );
          void openWorkspace();
          return;
        }
        notify(
          "terminal",
          nextMode === "worktree" ? "Worktree mode" : "Local mode",
          nextMode === "worktree"
            ? "New runs will create an isolated worktree branch."
            : "New runs will use the current workspace branch.",
        );
      };

      if (action.startsWith("select-provider:")) {
        const providerId = action.replace("select-provider:", "");
        if (isProviderId(providerId)) {
          const provider = providersForConfig(config).find(
            (item) => item.id === providerId,
          );
          if (provider?.authStatus === "connected") {
            selectProvider(providerId);
          } else {
            connectProvider(providerId);
          }
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

      switch (action) {
        case "add-context":
        case "select-file":
          void selectContextFile();
          break;
        case "select-project":
        case "select-workspace":
        case "select-folder":
          void openWorkspace();
          break;
        case "add-photos":
        case "add-document":
        case "add-pdf":
        case "add-spreadsheet":
        case "add-slides":
          notify("terminal", "Attach", "Coming soon");
          break;
        case "add-goal":
        case "add-plan":
          dispatchWorkbench({ type: "set-chat-panel", panel: "plan" });
          break;
        case "show-project-context":
          void openWorkspace();
          break;
        case "search-workspace":
          setCommandPaletteQuery("");
          setIsCommandPaletteOpen(true);
          break;
        case "toggle-access":
          openSettingsSection("permissions");
          break;
        case "set-approval-gated":
          void persistConfig({
            ...config,
            requireCommandApproval: true,
            requireFileEditApproval: true,
          });
          {
            const copy = approvalNotificationCopy(config, "gated");
            notify("terminal", copy.title, copy.detail);
          }
          break;
        case "set-approval-direct":
          void persistConfig({
            ...config,
            requireCommandApproval: false,
            requireFileEditApproval: false,
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
        case "select-workspace-mode": {
          const nextMode =
            workbench.workspaceMode === "local" ? "worktree" : "local";
          setComposerWorkspaceMode(nextMode);
          break;
        }
        case "select-branch":
          setComposerWorkspaceMode(
            workbench.workspaceMode === "worktree" ? "local" : "worktree",
          );
          break;
        case "open-terminal-panel":
          openToolPanel("terminal");
          break;
        case "open-browser-panel":
          openToolPanel("browser");
          break;
        case "dictate":
          notify(
            "terminal",
            "Dictation unavailable",
            "Voice input is not enabled in this build.",
          );
          break;
        default:
          notify("terminal", "Composer action", action);
      }
    },
    [
      activeSession?.workspacePath,
      checkProviderReadiness,
      connectProvider,
      config,
      notify,
      openSettingsSection,
      openToolPanel,
      openWorkspace,
      persistConfig,
      selectProvider,
      selectProviderModel,
      selectContextFile,
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
      const title = pane.title.endsWith(" (renamed)")
        ? pane.title.replace(" (renamed)", "")
        : `${pane.title} (renamed)`;
      dispatchWorkbench({ type: "rename-terminal-pane", paneId, title });
      notify("terminal", "Terminal renamed", title);
    },
    [notify, workbench.terminalPanes],
  );

  const sendDraft = useCallback(
    async (overrideMessage?: string) => {
      const message = (overrideMessage ?? draft).trim();
      if (message === "") {
        return;
      }
      if (!activeSessionId && isStartingFirstTurn) {
        return;
      }
      if (!checkProviderReadiness("chat")) {
        return;
      }
      if (
        workbench.workspaceMode === "worktree" &&
        !(activeSession?.workspacePath ?? workspacePath)
      ) {
        notify(
          "terminal",
          "Choose a workspace",
          "Worktree chats need a repo or folder before Gyro can create the branch.",
        );
        void openWorkspace();
        return;
      }
      const turnId = createTurnId();
      const selectedProvider = providersForConfig(config).find(
        (provider) => provider.id === config.selectedProviderId,
      );
      const sessionModel = selectedSessionModelFromConfig(config);

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
        );
        const optimisticEvents = createOptimisticTurnEvents(
          session.id,
          message,
          turnId,
          selectedProvider,
        );
        optimisticEventsRef.current.set(session.id, optimisticEvents);
        suppressSessionAutoSelectRef.current = false;
        setWorkspacePath(session.workspacePath);
        setFiles(previewFiles);
        setSessions((current) => [session, ...current]);
        setActiveSessionId(session.id);
        setEvents(optimisticEvents);
        setDraft("");
        notify("terminal", "Message queued", "Starting chat");

        if (!isTauriRuntime()) {
          updateOptimisticProviderStatus(
            optimisticEventsRef,
            setEvents,
            session.id,
            turnId,
            "ready",
          );
          setIsStartingFirstTurn(false);
          return;
        }

        let optimisticSessionId = session.id;
        try {
          const persistedSession = await createTauriThreadSession(
            workspacePath,
            workbench.workspaceMode,
            sessionModel,
          );
          optimisticSessionId = persistedSession.id;
          const migratedEvents = rekeySessionEvents(
            optimisticEvents,
            persistedSession.id,
          );
          optimisticEventsRef.current.delete(session.id);
          optimisticEventsRef.current.set(persistedSession.id, migratedEvents);
          setSessions((current) => [
            persistedSession,
            ...current.filter((item) => item.id !== session.id),
          ]);
          setWorkspacePath(persistedSession.workspacePath);
          setActiveSessionId(persistedSession.id);
          setEvents(migratedEvents);

          await invoke<SessionEvent>("append_user_message", {
            sessionId: persistedSession.id,
            message,
          });
          updateOptimisticProviderStatus(
            optimisticEventsRef,
            setEvents,
            persistedSession.id,
            turnId,
            "ready",
          );
          await refreshEvents(persistedSession.id);
        } catch (error) {
          updateOptimisticProviderStatus(
            optimisticEventsRef,
            setEvents,
            optimisticSessionId,
            turnId,
            "failed",
            String(error),
          );
          notify("command-failed", "Message fallback", "Chat stayed local");
        } finally {
          setIsStartingFirstTurn(false);
        }
        return;
      }

      const optimisticEvents = createOptimisticTurnEvents(
        activeSessionId,
        message,
        turnId,
        selectedProvider,
      );
      void saveSessionModel(activeSessionId, sessionModel);
      optimisticEventsRef.current.set(
        activeSessionId,
        mergePersistedAndOptimisticEvents(
          optimisticEventsRef.current.get(activeSessionId) ?? [],
          optimisticEvents,
        ),
      );
      dispatchWorkbench({ type: "set-chat-panel" });
      setEvents((current) =>
        mergePersistedAndOptimisticEvents(current, optimisticEvents),
      );
      setDraft("");

      if (!isTauriRuntime()) {
        updateOptimisticProviderStatus(
          optimisticEventsRef,
          setEvents,
          activeSessionId,
          turnId,
          "ready",
        );
        notify("terminal", "Message added", "Local optimistic event");
        return;
      }
      try {
        await invoke<SessionEvent>("append_user_message", {
          sessionId: activeSessionId,
          message,
        });
        updateOptimisticProviderStatus(
          optimisticEventsRef,
          setEvents,
          activeSessionId,
          turnId,
          "ready",
        );
        await refreshEvents(activeSessionId);
      } catch (error) {
        updateOptimisticProviderStatus(
          optimisticEventsRef,
          setEvents,
          activeSessionId,
          turnId,
          "failed",
          String(error),
        );
        notify("command-failed", "Message fallback", "Chat stayed local");
      }
    },
    [
      activeSessionId,
      activeSession?.workspacePath,
      checkProviderReadiness,
      config,
      draft,
      isStartingFirstTurn,
      notify,
      openWorkspace,
      refreshEvents,
      saveSessionModel,
      workbench.workspaceMode,
      workspacePath,
    ],
  );

  const handleProviderStatusAction = useCallback(
    (action: string, event: SessionEvent) => {
      const payload = recordFromUnknown(event.payload);
      const providerId = stringFromRecord(payload, "providerId");
      const userMessage = stringFromRecord(payload, "userMessage");

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
        void sendDraft(userMessage);
      }
    },
    [connectProvider, sendDraft],
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
        tab: { path, title: workspaceName(path), dirty: false },
      });
      void appendEditorEvent("editor-file-opened", `Opened ${path}`, {
        path,
      });
    },
    [appendEditorEvent, files],
  );

  const closeEditorTab = useCallback(
    (path: string) => {
      dispatchWorkbench({ type: "ide-close-tab", path });
      const remaining = workbench.ide.tabs.filter((tab) => tab.path !== path);
      if (selectedFile === path) {
        setSelectedFile(remaining[remaining.length - 1]?.path);
      }
    },
    [selectedFile, workbench.ide.tabs],
  );

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
        `IDE action: ${action}`,
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

  const syncTerminalSnapshot = useCallback((snapshot: TerminalPaneSnapshot) => {
    const status = terminalStatusFromSnapshot(snapshot.status);
    dispatchWorkbench({
      type: "sync-terminal-pane-snapshot",
      paneId: snapshot.paneId,
      command: snapshot.command,
      event:
        snapshot.exitCode === null || snapshot.exitCode === undefined
          ? snapshot.status
          : `${snapshot.status} (${snapshot.exitCode})`,
      output: snapshot.output,
      status,
    });
    setTerminalOutput(snapshot.output);
  }, []);

  const refreshTerminalPane = useCallback(
    async (paneId: string) => {
      if (!isTauriRuntime()) {
        return;
      }
      try {
        const snapshot = await invoke<TerminalPaneSnapshot>(
          "read_terminal_output",
          { paneId },
        );
        syncTerminalSnapshot(snapshot);
      } catch {
        notify("command-failed", "Terminal read failed", paneId);
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
      dispatchWorkbench({ type: "select-terminal-pane", paneId: focusedPaneId });
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
        await invoke<TerminalPaneSnapshot>("stop_terminal_pane", { paneId });
      } catch {
        // Closing the UI should still succeed if the backing PTY is already gone.
      }
    }
    dispatchWorkbench({ type: "remove-terminal-pane", paneId });
  }, []);

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
    (taskId: string) => {
      if (!checkProviderReadiness("task", "openai")) {
        return;
      }
      const task = workbench.tasks.find((item) => item.id === taskId);
      const profile = getCommandProfile(commandProfiles, "codex");
      const metadata =
        task ??
        workspaceRunMetadata(workbench.workspaceMode, `task-${Date.now()}`);
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
      notify(
        "approval",
        "Task dispatched",
        metadata.workspaceMode === "worktree"
          ? `Agent waiting in ${metadata.worktreeName}`
          : "Agent waiting in terminal pane",
      );
    },
    [
      checkProviderReadiness,
      commandProfiles,
      notify,
      workbench.tasks,
      workbench.workspaceMode,
    ],
  );

  const createAutomation = useCallback(async () => {
    const draft = createAutomationDraft(workbench.workspaceMode);

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
  }, [notify, workbench.workspaceMode]);

  const runAutomation = useCallback(
    async (automationId: string) => {
      const automation = workbench.automations.find(
        (item) => item.id === automationId,
      );
      const summary =
        "Local run queued for provider session and CLI pane handoff";

      if (isTauriRuntime()) {
        try {
          const updated = await invoke<Automation>("run_automation", {
            automationId,
            summary,
          });
          dispatchWorkbench({ type: "upsert-automation", automation: updated });
          notify("approval", "Automation run ready", updated.title);
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
        summary,
      });
      notify(
        "approval",
        "Automation run ready",
        automation?.title ?? automationId,
      );
    },
    [notify, workbench.automations],
  );

  const toggleAutomation = useCallback(
    async (automationId: string) => {
      const automation = workbench.automations.find(
        (item) => item.id === automationId,
      );
      const status = automation?.status === "paused" ? "current" : "paused";

      if (isTauriRuntime()) {
        try {
          const updated = await invoke<Automation>("set_automation_status", {
            automationId,
            status,
          });
          dispatchWorkbench({ type: "upsert-automation", automation: updated });
          notify(
            "terminal",
            status === "paused" ? "Automation paused" : "Automation resumed",
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
        status === "paused" ? "Automation paused" : "Automation resumed",
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
        notify("provider", "Provider disconnected", provider.displayName);
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
          ? "Provider ready"
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
          runProfile("codex");
          dispatchWorkbench({
            type: "select-workspace-layout",
            layout: "terminal-grid",
          });
          break;
        case "run-claude":
          runProfile("claude");
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
          notify("terminal", "Search ready", "IDE file tree focused");
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
        case "dispatch-agent":
          if (workbench.selectedTaskId) {
            dispatchTask(workbench.selectedTaskId);
          }
          break;
      }
    },
    [
      addTerminalPane,
      createAutomation,
      createTask,
      dispatchTask,
      notify,
      openWorkspace,
      runAutomation,
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
    void refreshAccount();
    void refreshConfig();
  }, [refreshAccount, refreshConfig]);

  useEffect(() => {
    if (!accountSession.signedIn) {
      return;
    }
    void refreshSessions();
    void refreshAutomations();
  }, [accountSession.signedIn, refreshAutomations, refreshSessions]);

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
    window.localStorage.setItem(THEME_STORAGE_KEY, workbench.preferences.theme);
    const persistedWorkbench: WorkbenchState = {
      ...workbench,
      ide: {
        ...workbench.ide,
        buffers: {},
        selection: undefined,
      },
    };
    window.localStorage.setItem(
      WORKBENCH_STORAGE_KEY,
      JSON.stringify(persistedWorkbench),
    );
  }, [workbench]);

  useEffect(() => {
    window.localStorage.setItem(
      PINNED_SESSIONS_STORAGE_KEY,
      JSON.stringify(pinnedSessionIds),
    );
  }, [pinnedSessionIds]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isCommand = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        setIsCommandPaletteOpen(false);
        setModelStandardPrompt(undefined);
        return;
      }
      if (!isCommand) {
        return;
      }
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsCommandPaletteOpen(true);
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
  }, [addTerminalPane, splitTerminalPane, startNewChat]);

  useEffect(() => {
    if (activeSessionId) {
      void refreshEvents(activeSessionId);
    } else {
      setEvents([]);
    }
  }, [activeSessionId, refreshEvents]);

  useEffect(() => {
    if (!activeSession) {
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
            ? { ...provider, selectedModelId: activeSession.modelId }
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
      return;
    }
    if (!activeSession.workspacePath) {
      setFiles([]);
      return;
    }
    void invoke<WorkspaceFile[]>("list_workspace_tree", {
      depth: 5,
      workspacePath: activeSession.workspacePath,
    })
      .then(setFiles)
      .catch(() => setFiles([]));
  }, [activeSession]);

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
    if (!isTauriRuntime() || liveTerminalPaneIds.length === 0) {
      return;
    }

    const interval = window.setInterval(() => {
      for (const paneId of liveTerminalPaneIds) {
        void refreshTerminalPane(paneId);
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [liveTerminalPaneIds, refreshTerminalPane]);

  useEffect(() => {
    dispatchWorkbench({
      type: "reconcile-active-turn",
      turn: deriveActiveTurn(events, activeSession?.title),
    });
  }, [activeSession?.title, events]);

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
    const activeTurnId =
      workbench.activeTurn?.id ??
      deriveActiveTurn(events, activeSession?.title)?.id;
    const freshEvents = events.filter(
      (event) =>
        (event.kind === "file-edit-proposed" ||
          event.kind === "approval-requested") &&
        !ingestedSessionEventIds.current.has(event.id),
    );
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
  }, [activeSession?.title, events, notify, workbench.activeTurn?.id]);

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
      height={isPrimary ? undefined : toolPanelHeight}
      isPrimary={isPrimary}
      isLaunchingCliPreset={isLaunchingCliPreset}
      isResizable={!isPrimary}
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
      onBrowserOpenExternal={() =>
        notify("terminal", "Open external", workbench.browserPreview.url)
      }
      onBrowserReload={() => dispatchWorkbench({ type: "browser-reload" })}
      onBrowserScreenshot={() =>
        dispatchWorkbench({ type: "browser-screenshot" })
      }
      onBrowserUrlChange={(url) =>
        dispatchWorkbench({ type: "set-browser-url", url })
      }
      onCollapse={() => dispatchWorkbench({ type: "close-tool-panel" })}
      onCloseTerminalPane={closeTerminalPane}
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
      onOpenDiffInEditor={(path) => {
        openEditorFile(path);
        dispatchWorkbench({
          type: "select-workspace-layout",
          layout: "code",
        });
      }}
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
      onRunGitReviewAction={(actionId) =>
        dispatchWorkbench({ type: "run-git-review-action", actionId })
      }
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
          onReconnect={restartTerminalPane}
          onResize={resizeTerminalPane}
          onSelect={(paneId) =>
            dispatchWorkbench({ type: "select-terminal-pane", paneId })
          }
          onWrite={writeTerminalInputToPane}
          pane={pane}
        />
      )}
      selectedTerminalPaneId={workbench.selectedTerminalPaneId}
      terminalOutput={terminalOutput}
      terminalPanes={workbench.terminalPanes}
      terminalTemplate={workbench.terminalTemplate}
    />
  );

  if (!accountSession.signedIn) {
    return (
      <GyroAccountGate
        error={accountError}
        oidc={config.accountOidc}
        onRefresh={refreshAccount}
        onSignIn={startAccountLogin}
        status={accountStatus}
      />
    );
  }

  return (
    <AppChrome
      activePaneTab={workbench.activePaneTab}
      activeDestination={activeDestination}
      activeSessionId={activeSessionId}
      activeSettingsSection={workbench.preferences.lastSettingsSection}
      activeWorkspaceLayout={activeWorkspaceLayout}
      commandProfiles={commandProfiles}
      files={files}
      isChatsCollapsed={workbench.preferences.sidebarChatsCollapsed}
      notifications={workbench.notifications}
      onAddTerminalPane={addTerminalPane}
      onCreateSession={startNewChat}
      onDeleteSession={deleteSession}
      onDismissNotification={(id) =>
        dispatchWorkbench({ type: "dismiss-notification", id })
      }
      onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
      onOpenSettings={() =>
        dispatchWorkbench({
          type: "select-destination",
          destination: "settings",
        })
      }
      onOpenSettingsSection={openSettingsSection}
      onOpenWorkspace={openWorkspace}
      onOpenWorkspaceFile={openEditorFile}
      onOpenToolPanel={openToolPanel}
      onPinSession={pinSession}
      onRenameSession={renameSession}
      onSelectDestination={selectDestination}
      onSelectSession={(sessionId) => {
        suppressSessionAutoSelectRef.current = false;
        setActiveSessionId(sessionId);
        dispatchWorkbench({ type: "set-chat-panel" });
        dispatchWorkbench({
          type: "select-workspace-layout",
          layout: "thread",
        });
      }}
      onSelectWorkspaceLayout={selectWorkspaceLayout}
      onSettingsBack={returnFromSettings}
      onSettingsSectionChange={(section: SettingsSectionId) =>
        dispatchWorkbench({ type: "set-settings-section", section })
      }
      onStartWorkspaceLayout={startWorkspaceLayout}
      onToggleChatsCollapsed={() =>
        dispatchWorkbench({ type: "toggle-sidebar-chats" })
      }
      pinnedSessionIds={pinnedSessionIds}
      sessions={visibleSessions}
      terminalPanes={workbench.terminalPanes}
      workspacePath={activeSession?.workspacePath ?? workspacePath}
    >
      {activeDestination === "workspace" ? (
        <div className={`gyro-workspace-route is-${activeWorkspaceLayout}`}>
          {activeWorkspaceLayout === "thread" ? (
            <section className="gyro-workspace-primary" aria-label="Thread">
              <ChatSurface
                activeChatPanel={activeChatPanel}
                browserPreview={workbench.browserPreview}
                config={config}
                diffReview={workbench.diffReview}
                draft={draft}
                events={events}
                branchName={activeSession?.branch}
                isEnvironmentRailOpen={activeChatPanel === "environment"}
                isComposerSending={isStartingFirstTurn}
                isToolPanelOpen={workbench.isToolPanelOpen}
                onboarding={workbench.onboarding}
                onAgentAction={(action) =>
                  notify("terminal", "Agent action", action)
                }
                onCompleteOnboardingStep={(step) =>
                  dispatchWorkbench({ type: "complete-onboarding-step", step })
                }
                onComposerAction={handleComposerAction}
                onDraftChange={setDraft}
                onOpenToolPanel={openToolPanel}
                onPlanItemStatusChange={changePlanItemStatus}
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
                sessionPlan={activeSessionPlan}
                sessionTitle={activeSession?.title}
                terminalPanes={workbench.terminalPanes}
                worktreeName={activeSession?.worktreeName}
                workspaceMode={workbench.workspaceMode}
                workspacePath={activeSession?.workspacePath ?? workspacePath}
              />
            </section>
          ) : null}

          {activeWorkspaceLayout === "terminal-grid"
            ? renderWorkspaceToolPanel(true)
            : null}

          {activeWorkspaceLayout === "code" ? (
            <section className="gyro-workspace-primary" aria-label="Code">
              <IdeSurface
                activePaneTab={workbench.activePaneTab}
                browserPreview={workbench.browserPreview}
                diffReview={workbench.diffReview}
                activeBuffer={activeEditorBuffer}
                editorSelection={workbench.ide.selection}
                editorTabs={workbench.ide.tabs}
                fileContent={selectedFileContent}
                fileError={selectedFileError}
                fileLoadState={selectedFileLoadState}
                files={files}
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
                onBrowserOpenExternal={() =>
                  notify(
                    "terminal",
                    "Open external",
                    workbench.browserPreview.url,
                  )
                }
                onBrowserReload={() =>
                  dispatchWorkbench({ type: "browser-reload" })
                }
                onBrowserScreenshot={() =>
                  dispatchWorkbench({ type: "browser-screenshot" })
                }
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
                onOpenDiffInEditor={(path) => {
                  openEditorFile(path);
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
                onSelectTerminalPane={(paneId) =>
                  dispatchWorkbench({ type: "select-terminal-pane", paneId })
                }
                onSplitTerminalPane={splitTerminalPane}
                onTerminalUtilityAction={handleTerminalUtilityAction}
                onToggleDiffDirectory={(directory) =>
                  dispatchWorkbench({
                    type: "toggle-diff-directory",
                    directory,
                  })
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
                    theme={workbench.preferences.theme}
                  />
                )}
              />
            </section>
          ) : null}

          {activeWorkspaceLayout !== "terminal-grid" ? (
            workbench.isToolPanelOpen ? (
              renderWorkspaceToolPanel(false)
            ) : (
              <WorkspaceToolPanelPeek
                activePaneTab={workbench.activePaneTab}
                onHeightChange={setToolPanelHeight}
                onReveal={revealToolPanel}
              />
            )
          ) : null}
        </div>
      ) : null}
      {activeDestination === "settings" ? (
        <SettingsSurface
          activeSection={workbench.preferences.lastSettingsSection}
          cliLaunchPreset={workbench.preferences.cliLaunchPreset}
          config={config}
          density={workbench.preferences.density}
          onConfigChange={handleConfigChange}
          onCliLaunchPresetChange={(preset: CliLaunchPreset) =>
            dispatchWorkbench({ type: "set-cli-launch-preset", preset })
          }
          onDensityChange={(density) =>
            dispatchWorkbench({ type: "set-density", density })
          }
          onExportDiagnostics={() =>
            notify("terminal", "Diagnostics exported", "Local redacted bundle")
          }
          onResetUiState={() => dispatchWorkbench({ type: "reset-state" })}
          onSectionChange={(section: SettingsSectionId) =>
            dispatchWorkbench({ type: "set-settings-section", section })
          }
          onThemeChange={(theme) =>
            dispatchWorkbench({ type: "set-theme", theme })
          }
          onTestProvider={testProvider}
          onToggleProvider={toggleProvider}
          themeMode={workbench.preferences.theme}
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
          onProviderModelChange={(providerId, modelId) => {
            if (isProviderId(providerId)) {
              selectProviderModel(providerId, modelId);
            }
          }}
          onRefreshProviderModels={(providerId) => {
            if (!isProviderId(providerId)) {
              return;
            }
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
          config={config}
          draft={draft}
          events={[]}
          isEnvironmentRailOpen={activeChatPanel === "environment"}
          isComposerSending={isStartingFirstTurn}
          isToolPanelOpen={workbench.isToolPanelOpen}
          onboarding={workbench.onboarding}
          onCompleteOnboardingStep={(step) =>
            dispatchWorkbench({ type: "complete-onboarding-step", step })
          }
          onComposerAction={handleComposerAction}
          onDraftChange={setDraft}
          onOpenToolPanel={openToolPanel}
          onPlanItemStatusChange={changePlanItemStatus}
          onProviderStatusAction={handleProviderStatusAction}
          onSend={sendDraft}
          onSetOnboardingStep={(step) =>
            dispatchWorkbench({ type: "set-onboarding-step", step })
          }
          workspaceMode={workbench.workspaceMode}
          onToggleEnvironmentRail={() =>
            dispatchWorkbench({ type: "toggle-chat-environment-rail" })
          }
          onTogglePlanPanel={() =>
            dispatchWorkbench({ type: "toggle-chat-plan" })
          }
          providerReadiness={workbench.providerReadiness}
          sessionPlan={activeSessionPlan}
          showOnboardingSteps
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
      {isCommandPaletteOpen ? (
        <CommandPaletteOverlay
          onClose={() => setIsCommandPaletteOpen(false)}
          onCommand={runCommandPaletteCommand}
          onQueryChange={setCommandPaletteQuery}
          onSelectDestination={selectDestination}
          onOpenToolPanel={openToolPanel}
          onSelectWorkspaceLayout={selectWorkspaceLayout}
          query={commandPaletteQuery}
          recents={workbench.preferences.commandPaletteRecents}
        />
      ) : null}
    </AppChrome>
  );
}

function loadInitialWorkbenchState(): WorkbenchState {
  const base = createInitialWorkbenchState();
  const legacyTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  const stored = window.localStorage.getItem(WORKBENCH_STORAGE_KEY);
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
      automations,
      browserPreview,
      diffReview,
      ide: sanitizeStoredIde(parsed.ide, base),
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
  if (browserPreview.verificationMessage === "Agent verification passed") {
    return base.browserPreview;
  }
  return {
    ...base.browserPreview,
    ...browserPreview,
  };
}

function sanitizeStoredIde(
  ide: Partial<WorkbenchState>["ide"],
  base: WorkbenchState,
): WorkbenchState["ide"] {
  if (!ide || !Array.isArray(ide.tabs)) {
    return base.ide;
  }
  const tabs = ide.tabs
    .filter(
      (tab) =>
        tab && typeof tab.path === "string" && typeof tab.title === "string",
    )
    .map((tab) => ({
      path: tab.path,
      title: tab.title,
      dirty: false,
      pinned: tab.pinned === true,
    }));
  const activePath =
    typeof ide.activePath === "string" &&
    tabs.some((tab) => tab.path === ide.activePath)
      ? ide.activePath
      : tabs[0]?.path;
  return {
    ...base.ide,
    activePath,
    tabs,
  };
}

function GyroAccountGate({
  error,
  oidc,
  onRefresh,
  onSignIn,
  status,
}: {
  error: string;
  oidc?: GyroConfig["accountOidc"];
  onRefresh: () => void;
  onSignIn: () => void;
  status: GyroAccountStatus;
}) {
  const isBusy = status === "checking" || status === "signing-in";
  const isLocalDevice =
    oidc?.issuerUrl?.replace(/\/$/, "") === "local-device://gyro" &&
    oidc?.clientId === "gyro-local-device";
  const detail =
    status === "checking"
      ? "Checking whether this Mac is already allowed..."
      : status === "signing-in"
        ? "Authorizing this local Gyro instance..."
        : isLocalDevice
          ? "Authorize this device to use the local Gyro instance. Claude, OpenAI, and other paid accounts stay external in Providers."
          : "Authorize Gyro access. Model-provider OAuth stays separate in Providers.";

  return (
    <main className="gyro-account-gate" aria-label="Gyro local access">
      <section className="gyro-account-panel">
        <div className="gyro-account-panel-mark">G</div>
        <div>
          <span className="gyro-account-kicker">Local access</span>
          <h1>Use Gyro on this Mac</h1>
          <p>{detail}</p>
        </div>
        <div className="gyro-account-provider">
          <span>Access mode</span>
          <code>
            {isLocalDevice
              ? "Local device session"
              : (oidc?.issuerUrl ?? "not configured")}
          </code>
        </div>
        <div className="gyro-account-provider">
          <span>Provider accounts</span>
          <code>External Claude/OpenAI logins</code>
        </div>
        {error ? <p className="gyro-account-error">{error}</p> : null}
        <div className="gyro-account-actions">
          <button disabled={isBusy} onClick={onSignIn} type="button">
            {status === "signing-in"
              ? "Authorizing..."
              : isLocalDevice
                ? "Use this device"
                : "Authorize access"}
          </button>
          <button disabled={isBusy} onClick={onRefresh} type="button">
            Check again
          </button>
        </div>
      </section>
    </main>
  );
}

function LiveTerminalPaneBody({
  isActive,
  onReconnect,
  onResize,
  onSelect,
  onWrite,
  pane,
}: {
  isActive: boolean;
  onReconnect: (paneId: string) => void;
  onResize: (paneId: string, cols: number, rows: number) => void;
  onSelect: (paneId: string) => void;
  onWrite: (paneId: string, input: string) => void;
  pane: TerminalPane;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const renderedOutputRef = useRef("");
  const resizeFrameRef = useRef<number | undefined>();
  const lastSizeRef = useRef("");
  const statusRef = useRef(pane.status);
  const onResizeRef = useRef(onResize);
  const onWriteRef = useRef(onWrite);

  useEffect(() => {
    statusRef.current = pane.status;
    onResizeRef.current = onResize;
    onWriteRef.current = onWrite;
  }, [onResize, onWrite, pane.status]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const terminal = new XTerm({
      allowTransparency: true,
      cursorBlink: true,
      fontFamily:
        "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
      fontSize: 12,
      lineHeight: 1.35,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      scrollOnUserInput: true,
      scrollback: 5000,
      theme: {
        background: "#050708",
        black: "#101419",
        blue: "#7aa7ff",
        brightBlack: "#505965",
        brightBlue: "#9dbdff",
        brightCyan: "#9ee7df",
        brightGreen: "#94e9b8",
        brightMagenta: "#d6b3ff",
        brightRed: "#ff9c9c",
        brightWhite: "#f5f7fa",
        brightYellow: "#ffe59b",
        cursor: "#e7edf6",
        cyan: "#71d7cf",
        foreground: "#d9e0ea",
        green: "#78dda2",
        magenta: "#bf95ff",
        red: "#ff8585",
        selectionBackground: "#2b3644",
        white: "#d9e0ea",
        yellow: "#f5d77a",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const dataDisposable = terminal.onData((data) => {
      onWriteRef.current(pane.id, data);
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
    resizeObserver.observe(host);
    scheduleFit();

    return () => {
      resizeObserver.disconnect();
      if (resizeFrameRef.current) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
      dataDisposable.dispose();
      terminal.dispose();
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

  return (
    <div className="gyro-xterm-frame">
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

function formatTerminalDelta(value: string) {
  return value.replace(/\r?\n/g, "\r\n");
}

function loadPreviewConfig(): GyroConfig {
  const stored = window.localStorage.getItem(PREVIEW_CONFIG_STORAGE_KEY);
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
  const stored = window.localStorage.getItem(PINNED_SESSIONS_STORAGE_KEY);
  if (!stored) {
    return [];
  }
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
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
    id: `restored-${snapshot.paneId}`,
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
      workspaceRunMetadata(mode, snapshot.title),
    ),
    command: snapshot.command,
    lastEvent:
      snapshot.exitCode === null || snapshot.exitCode === undefined
        ? snapshot.status
        : `${snapshot.status} (${snapshot.exitCode})`,
    output: snapshot.output,
  };
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
  const latestUserEvent = [...events]
    .reverse()
    .find((event) => event.kind === "user-message");
  if (!latestUserEvent) {
    return undefined;
  }

  const turnId = turnIdFromSessionEvent(latestUserEvent) ?? latestUserEvent.id;
  const turnEvents = events.filter(
    (event) =>
      (turnIdFromSessionEvent(event) ?? event.id) === turnId ||
      (event.kind !== "user-message" &&
        !turnIdFromSessionEvent(event) &&
        event.createdAt >= latestUserEvent.createdAt),
  );
  const changedFiles = new Set(
    turnEvents
      .filter((event) => event.kind === "file-edit-proposed")
      .map(pathFromSessionEvent),
  );
  const approvalsPending = turnEvents.filter(
    (event) => event.kind === "approval-requested",
  ).length;
  const lastEvent = turnEvents.at(-1) ?? latestUserEvent;
  const hasCommandRequest = turnEvents.some(
    (event) => event.kind === "command-requested",
  );
  const hasCommandOutput = turnEvents.some(
    (event) => event.kind === "command-output",
  );
  const status =
    approvalsPending > 0
      ? "waiting"
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
    lastEvent: lastEvent.message,
    changedFiles: changedFiles.size,
    approvalsPending,
  };
}

function deriveSessionPlan(
  events: SessionEvent[],
  sessionId?: string,
): SessionPlan {
  const planEvents = events.filter((event) => event.kind === "plan-updated");
  const firstEvent = planEvents[0];
  const latestEvent = planEvents.at(-1);
  let plan: SessionPlan = {
    sessionId,
    title: "Plan",
    items: [],
    createdAt: firstEvent?.createdAt,
    updatedAt: latestEvent?.createdAt,
  };

  for (const event of planEvents) {
    const payload = recordFromUnknown(event.payload);
    const action = stringFromRecord(payload, "action") ?? "replace";
    const sourceTurnId =
      turnIdFromSessionEvent(event) ?? stringFromRecord(payload, "turnId");
    const providerId = stringFromRecord(payload, "providerId");
    const title = stringFromRecord(payload, "title");
    if (title) {
      plan = { ...plan, title };
    }
    if (sourceTurnId) {
      plan = { ...plan, sourceTurnId };
    }
    if (providerId) {
      plan = { ...plan, providerId };
    }

    if (action === "clear") {
      plan = { ...plan, items: [], updatedAt: event.createdAt };
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

function workspaceName(path?: string) {
  return path?.split("/").filter(Boolean).at(-1) ?? "Untitled";
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

function MonacoEditorPane({
  buffer,
  fileContent,
  loadState,
  onChange,
  onSelectionChange,
  path,
  theme,
}: {
  buffer?: EditorBuffer;
  fileContent?: WorkspaceFileContent;
  loadState: "idle" | "loading" | "ready" | "error";
  onChange: (value: string) => void;
  onSelectionChange: (selection?: EditorSelection) => void;
  path?: string;
  theme: WorkbenchState["preferences"]["theme"];
}) {
  const handleMount: OnMount = (editor) => {
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
    <Editor
      height="100%"
      language={languageForPath(path)}
      onChange={(value) => onChange(value ?? "")}
      onMount={handleMount}
      options={{
        automaticLayout: true,
        bracketPairColorization: { enabled: Boolean("editor") },
        fontFamily:
          "SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace",
        fontLigatures: false,
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: Boolean("editor"), scale: 0.75 },
        padding: { top: 14, bottom: 14 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2,
        wordWrap: "off",
      }}
      path={path}
      theme={theme === "light" ? "vs" : "vs-dark"}
      value={buffer?.content ?? fileContent?.content ?? ""}
    />
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
  };
}

function approvalNotificationCopy(
  config: GyroConfig,
  mode: "direct" | "gated",
) {
  const isAnthropic = config.selectedProviderId === "anthropic";
  if (mode === "gated") {
    return isAnthropic
      ? {
          title: "Ask first",
          detail: "Claude will ask before tool use and file edits.",
        }
      : {
          title: "Approval gated",
          detail: "Codex will ask before commands and file edits.",
        };
  }

  return isAnthropic
    ? {
        title: "Auto-approve",
        detail: "Claude can use tools and apply edits without prompts.",
      }
    : {
        title: "Full access",
        detail: "Codex can run commands and apply edits without prompts.",
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
  { path: "packages/ui/src/surfaces.tsx", kind: "file" },
  { path: "packages/ui/src/styles.css", kind: "file" },
  { path: "apps/desktop/src/App.tsx", kind: "file" },
  { path: "apps/desktop/src-tauri/src/lib.rs", kind: "file" },
  { path: "crates/gyro-core/src/sessions.rs", kind: "file" },
  { path: "docs/architecture.md", kind: "file" },
  { path: "packages/ui/src", kind: "directory" },
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
    Pick<Session, "modelId" | "modelLabel" | "providerId" | "providerLabel">
  > = {},
  sessionId = `preview-${Date.now()}`,
): Session {
  const now = new Date().toISOString();
  const metadata = workspaceRunMetadata(mode, layout);
  return {
    id: sessionId,
    title:
      layout === "terminal-grid"
        ? mode === "worktree"
          ? "Worktree CLI workspace"
          : "CLI workspace"
        : mode === "worktree"
          ? "Worktree session"
          : "Desktop session",
    workspacePath: "",
    origin: layout === "terminal-grid" ? "cli" : "desktop",
    workspaceMode: metadata.workspaceMode,
    branch: metadata.branch,
    worktreeName: metadata.worktreeName,
    providerId: model.providerId,
    providerLabel: model.providerLabel,
    modelId: model.modelId,
    modelLabel: model.modelLabel,
    createdAt: now,
    updatedAt: now,
    eventsPath: "preview://events",
  };
}

async function createTauriThreadSession(
  workspacePath: string | undefined,
  mode: WorkbenchState["workspaceMode"],
  model: ReturnType<typeof selectedSessionModelFromConfig>,
): Promise<Session> {
  const workspace = workspacePath ?? "";
  const shouldCreateWorktree = mode === "worktree" && workspace.length > 0;
  const title = shouldCreateWorktree ? "Worktree session" : "Desktop session";
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
): AutomationDraft {
  const metadata = workspaceRunMetadata(mode, "heartbeat-automation");
  return {
    title: "Heartbeat check",
    prompt:
      "Check the workspace, run the smoke gate, and report only if attention is needed.",
    schedule: "heartbeat",
    project: "Gyro",
    provider: "Codex",
    branch: metadata.branch,
    workspaceMode: metadata.workspaceMode,
    worktreeName: metadata.worktreeName,
    stopCondition:
      "Stop after the workspace passes smoke twice without changes.",
    nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
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
) {
  if (mode === "local") {
    return { workspaceMode: mode, branch: "main" };
  }
  const slug = slugify(label || "task");
  return {
    workspaceMode: mode,
    branch: `gyro/${slug}`,
    worktreeName: `gyro-${slug}`,
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
      payload: { optimistic: true, turnId },
    },
    {
      id: `${sessionId}-provider-${Date.now()}`,
      sessionId,
      turnId,
      createdAt: now,
      kind: "system-event",
      message: providerStatusMessage("queued", provider),
      payload: providerStatusPayload("queued", message, turnId, provider),
    },
  ];
}

type OptimisticProviderStatus = "queued" | "ready" | "failed";

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
    providerId: provider?.id,
    providerLabel: provider?.displayName ?? "Provider",
    status,
    turnId,
    userMessage,
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
  if (status === "ready") {
    return `${providerLabel} is ready for the next step`;
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

function mergePersistedAndOptimisticEvents(
  persistedEvents: SessionEvent[],
  optimisticEvents?: SessionEvent[],
) {
  if (!optimisticEvents || optimisticEvents.length === 0) {
    return persistedEvents;
  }
  const merged = [...persistedEvents];
  for (const event of optimisticEvents) {
    const hasSameId = merged.some((item) => item.id === event.id);
    const hasSameTurnUser =
      event.kind === "user-message" &&
      merged.some(
        (item) =>
          item.kind === "user-message" &&
          (item.turnId === event.turnId || item.message === event.message),
      );
    const hasSameTurnProviderStatus =
      isProviderStatusEvent(event) &&
      merged.some(
        (item) => isProviderStatusEvent(item) && item.turnId === event.turnId,
      );
    if (!hasSameId && !hasSameTurnUser && !hasSameTurnProviderStatus) {
      merged.push(event);
    }
  }
  return merged;
}

function isProviderStatusEvent(event: SessionEvent) {
  const payload = recordFromUnknown(event.payload);
  return event.kind === "system-event" && payload?.kind === "provider-status";
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
  const updateEvent = (event: SessionEvent): SessionEvent => {
    if (!isProviderStatusEvent(event) || event.turnId !== turnId) {
      return event;
    }
    const payload = recordFromUnknown(event.payload);
    const userMessage = stringFromRecord(payload, "userMessage") ?? "";
    const providerLabel =
      stringFromRecord(payload, "providerLabel") ?? "Provider";
    return {
      ...event,
      message:
        status === "failed"
          ? `${providerLabel} send needs attention`
          : status === "ready"
            ? `${providerLabel} is ready for the next step`
            : `${providerLabel} queued this request`,
      payload: {
        ...payload,
        error,
        status,
        userMessage,
      },
    };
  };
  const optimisticEvents = optimisticEventsRef.current.get(sessionId);
  if (optimisticEvents) {
    optimisticEventsRef.current.set(
      sessionId,
      optimisticEvents.map(updateEvent),
    );
  }
  setEvents((current) => current.map(updateEvent));
}
