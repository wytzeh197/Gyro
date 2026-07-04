import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AppChrome,
  AutomationsSurface,
  BrowserPreviewSurface,
  ChatSurface,
  ChatUtilityBar,
  CliWorkspaceSurface,
  CommandPaletteOverlay,
  DiffReviewSurface,
  IdeSurface,
  ProvidersSurface,
  SettingsSurface,
  TaskBoardSurface,
  createInitialWorkbenchState,
  createNotification,
  createTerminalPane,
  defaultCommandProfiles,
  parseProviderHealthOutput,
  workbenchReducer,
  type AppDestination,
  type Automation,
  type BrowserPreviewDevice,
  type CommandProfile,
  type GyroConfig,
  type ModelProviderConfig,
  type ProviderHandoff,
  type ProviderSession,
  type Session,
  type SessionEvent,
  type SettingsSectionId,
  type Task,
  type TaskStatus,
  type TerminalPaneStatus,
  type TerminalTemplate,
  type WorkbenchState,
  type WorkbenchTurn,
  type WorkspaceFile,
  type WorkspaceFileContent,
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

const EMPTY_CONFIG: GyroConfig = {
  updateChannel: "stable",
  telemetryEnabled: false,
  requireCommandApproval: true,
  requireFileEditApproval: true,
  modelProviders: [],
  commandProfiles: [],
};

const DEFAULT_WORKSPACE_PATH = "/Users/wytzehemrica/Documents/Gyro";
const WORKBENCH_STORAGE_KEY = "gyro.workbench-state";
const PINNED_SESSIONS_STORAGE_KEY = "gyro.pinned-session-ids";
const PREVIEW_CONFIG_STORAGE_KEY = "gyro.preview-config";
const THEME_STORAGE_KEY = "gyro.theme";
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

export function App() {
  const [workbench, dispatchWorkbench] = useReducer(
    workbenchReducer,
    undefined,
    loadInitialWorkbenchState,
  );
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [events, setEvents] = useState<SessionEvent[]>([]);
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
  const [activeProfileId, setActiveProfileId] = useState("shell");
  const [pinnedSessionIds, setPinnedSessionIds] =
    useState<string[]>(loadPinnedSessionIds);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const ingestedSessionEventIds = useRef(new Set<string>());

  const activeDestination = workbench.activeDestination;
  const commandProfiles =
    config.commandProfiles.length > 0
      ? config.commandProfiles
      : defaultCommandProfiles();
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
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
  const shouldShowChatUtilityBar =
    Boolean(activeSession) ||
    workbench.terminalPanes.length > 0 ||
    workbench.diffReview.files.length > 0 ||
    workbench.browserPreview.status !== "idle";
  const liveTerminalPaneIds = useMemo(
    () =>
      workbench.terminalPanes
        .filter(
          (pane) => pane.status === "running" || pane.status === "waiting",
        )
        .map((pane) => pane.id),
    [workbench.terminalPanes],
  );
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

      const providerConfigs = providerConfigsForConfig(config);
      const enabledProviders = providerConfigs.filter((provider) =>
        providerId ? provider.id === providerId : provider.enabled,
      );
      const readyProvider = enabledProviders.find((provider) =>
        workbench.providerStatuses.some(
          (status) =>
            status.id === provider.id &&
            status.connectionStatus === "connected",
        ),
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

      const targetProvider = providerId
        ? providerLabelForId(
            providerConfigs,
            workbench.providerStatuses,
            providerId,
          )
        : enabledProviders[0]?.displayName;
      const message = targetProvider
        ? `${targetProvider} is not connected yet`
        : "Enable and connect a provider before sending";

      dispatchWorkbench({
        type: "set-provider-readiness",
        status: "blocked",
        message,
        providerId,
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
      setConfig(nextConfig);
      window.localStorage.setItem(
        PREVIEW_CONFIG_STORAGE_KEY,
        JSON.stringify(nextConfig),
      );
      if (!isTauriRuntime()) {
        notify("provider", "Settings saved locally", "Preview config updated");
        return;
      }
      try {
        await invoke("save_config", { config: nextConfig });
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

  const refreshSessions = useCallback(async () => {
    if (!isTauriRuntime()) {
      setSessions([]);
      return;
    }
    try {
      const nextSessions = await invoke<Session[]>("list_sessions");
      setSessions(nextSessions);
      setActiveSessionId((current) => current ?? nextSessions[0]?.id);
      setWorkspacePath((current) => current ?? nextSessions[0]?.workspacePath);
    } catch {
      setSessions([]);
    }
  }, []);

  const refreshEvents = useCallback(async (sessionId: string) => {
    if (!isTauriRuntime()) {
      setEvents([]);
      return;
    }
    try {
      const nextEvents = await invoke<SessionEvent[]>("read_session_events", {
        sessionId,
      });
      setEvents(nextEvents);
    } catch {
      setEvents([]);
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
      setConfig(nextConfig);
      setActiveProfileId(nextConfig.commandProfiles[0]?.id ?? "shell");
    } catch {
      setConfig(EMPTY_CONFIG);
      setActiveProfileId("shell");
    }
  }, []);

  const selectDestination = useCallback((destination: AppDestination) => {
    dispatchWorkbench({ type: "select-destination", destination });
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
        "list_workspace_files",
        { workspacePath: selected },
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

  const createSession = useCallback(async () => {
    if (!isTauriRuntime()) {
      const session = createPreviewSession(
        activeDestination,
        workbench.workspaceMode,
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
      const workspace =
        workspacePath ?? (await open({ directory: true, multiple: false }));
      if (typeof workspace !== "string") {
        return;
      }
      const title =
        activeDestination === "cli"
          ? workbench.workspaceMode === "worktree"
            ? "Worktree CLI workspace"
            : "CLI workspace"
          : workbench.workspaceMode === "worktree"
            ? "Worktree session"
            : "Desktop session";
      const metadata = workspaceRunMetadata(
        workbench.workspaceMode,
        `${title}-${Date.now()}`,
      );
      const session =
        workbench.workspaceMode === "worktree"
          ? await invoke<Session>("create_worktree_session", {
              branch: metadata.branch,
              title,
              worktreeName: metadata.worktreeName,
              workspacePath: workspace,
            })
          : await invoke<Session>("create_desktop_session", {
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
        activeDestination,
        workbench.workspaceMode,
      );
      setWorkspacePath(session.workspacePath);
      setFiles([]);
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
      setEvents([]);
      notify("command-failed", "Session fallback", "Created preview session");
    }
  }, [
    activeDestination,
    notify,
    refreshSessions,
    workbench.workspaceMode,
    workspacePath,
  ]);

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

  const addTerminalPane = useCallback(() => {
    const profile = getCommandProfile(commandProfiles, activeProfileId);
    const pane = createTerminalPane(
      `pane-${Date.now()}`,
      profile,
      "restored",
      workspaceRunMetadata(workbench.workspaceMode, profile.displayName),
    );
    dispatchWorkbench({ type: "add-terminal-pane", pane });
    notify("terminal", "Terminal added", pane.title);
  }, [activeProfileId, commandProfiles, notify, workbench.workspaceMode]);

  const splitTerminalPane = useCallback(
    (template: TerminalTemplate) => {
      const profile = getCommandProfile(commandProfiles, activeProfileId);
      const pane = createTerminalPane(
        `pane-${Date.now()}`,
        profile,
        "restored",
        workspaceRunMetadata(workbench.workspaceMode, profile.displayName),
      );
      dispatchWorkbench({ type: "split-terminal-pane", pane, template });
      notify(
        "terminal",
        "Terminal split",
        `${template}-pane template selected`,
      );
    },
    [activeProfileId, commandProfiles, notify, workbench.workspaceMode],
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

  const sendDraft = useCallback(async () => {
    if (draft.trim() === "") {
      return;
    }
    if (!checkProviderReadiness("chat")) {
      return;
    }
    const turnId = createTurnId();
    if (!activeSessionId) {
      dispatchWorkbench({ type: "set-chat-environment-rail", open: false });
      const session = createPreviewSession("chat");
      setWorkspacePath(session.workspacePath);
      setFiles(previewFiles);
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
      setEvents(createLocalEvents(session.id, draft.trim(), turnId));
      setDraft("");
      notify("terminal", "Message queued", "Preview session created");
      return;
    }
    if (!isTauriRuntime()) {
      setEvents((current) => [
        ...current,
        ...createLocalEvents(activeSessionId, draft.trim(), turnId),
      ]);
      setDraft("");
      notify("terminal", "Message added", "Local preview event");
      return;
    }
    try {
      await invoke<SessionEvent>("append_user_message", {
        sessionId: activeSessionId,
        message: draft.trim(),
      });
      setDraft("");
      await refreshEvents(activeSessionId);
    } catch {
      setEvents((current) => [
        ...current,
        ...createLocalEvents(activeSessionId, draft.trim(), turnId),
      ]);
      setDraft("");
      notify("command-failed", "Message fallback", "Stored preview message");
    }
  }, [activeSessionId, checkProviderReadiness, draft, notify, refreshEvents]);

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

  const writeTerminalInput = useCallback(
    async (input: string) => {
      const paneId = workbench.selectedTerminalPaneId;
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
      workbench.selectedTerminalPaneId,
      workbench.terminalPanes,
    ],
  );

  const runProfile = useCallback(
    async (profileId = activeProfileId, commandOverride?: string) => {
      const profile = getCommandProfile(commandProfiles, profileId);
      const process = terminalProcessForProfile(profile, commandOverride);
      const paneId = workbench.selectedTerminalPaneId || `pane-${Date.now()}`;
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
        dispatchWorkbench({ type: "add-terminal-pane", pane });
      }
      const output = `Starting ${profile.displayName}: ${process.displayCommand}`;
      dispatchWorkbench({
        type: "run-terminal-pane",
        paneId,
        profileId: profile.id,
        command: process.displayCommand,
        output,
      });
      setTerminalOutput(output);
      if (!isTauriRuntime()) {
        notify("approval", "Command waiting", profile.displayName);
        return;
      }
      try {
        const snapshot = await invoke<TerminalPaneSnapshot>(
          "create_terminal_pane",
          {
            request: {
              args: process.args,
              command: process.command,
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
        syncTerminalSnapshot(snapshot);
        window.setTimeout(() => {
          void refreshTerminalPane(paneId);
        }, 350);
      } catch (error) {
        dispatchWorkbench({
          type: "set-terminal-pane-status",
          paneId,
          status: "failed",
          event: "process failed to start",
        });
        setTerminalOutput(String(error));
        notify("command-failed", "Terminal start failed", String(error));
      }
    },
    [
      activeProfileId,
      activeSession?.workspacePath,
      commandProfiles,
      notify,
      refreshTerminalPane,
      syncTerminalSnapshot,
      workbench.selectedTerminalPaneId,
      workbench.terminalPanes,
      workbench.workspaceMode,
      workspacePath,
    ],
  );

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
      } catch {
        notify("command-failed", "Terminal restart failed", paneId);
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
      const providers = providerConfigsForConfig(config).map((provider) =>
        provider.id === providerId
          ? { ...provider, enabled: !provider.enabled }
          : provider,
      );
      void persistConfig({ ...config, modelProviders: providers });
      dispatchWorkbench({
        type: "set-provider-status",
        providerId,
        status: providers.find((provider) => provider.id === providerId)
          ?.enabled
          ? "connected"
          : "disconnected",
      });
    },
    [config, persistConfig],
  );

  const testProvider = useCallback(
    (providerId: string) => {
      const provider = providerConfigsForConfig(config).find(
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
      window.setTimeout(() => {
        const output = createProviderHealthOutput(providerId, provider);
        const result = parseProviderHealthOutput(providerId, output);
        dispatchWorkbench({
          type: "record-provider-health",
          providerId,
          status: result.connectionStatus,
          summary: result.healthSummary ?? "Health check complete.",
          output,
        });
        notify(
          result.connectionStatus === "connected"
            ? "provider"
            : "command-failed",
          result.connectionStatus === "connected"
            ? "Provider ready"
            : "Provider needs setup",
          result.healthSummary ?? providerId,
        );
      }, 450);
    },
    [config, notify],
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
      const providerConfigs = providerConfigsForConfig(config);
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
          void createSession();
          dispatchWorkbench({
            type: "select-destination",
            destination: "chat",
          });
          break;
        case "open-workspace":
          void openWorkspace();
          break;
        case "new-terminal":
          addTerminalPane();
          break;
        case "run-codex":
          runProfile("codex");
          dispatchWorkbench({ type: "select-destination", destination: "cli" });
          break;
        case "run-claude":
          runProfile("claude");
          dispatchWorkbench({ type: "select-destination", destination: "cli" });
          break;
        case "run-tests":
          runProfile("shell", "pnpm check");
          dispatchWorkbench({ type: "select-destination", destination: "cli" });
          break;
        case "split-terminal":
          splitTerminalPane(2);
          break;
        case "search-files":
          dispatchWorkbench({ type: "select-surface", surface: "ide" });
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
            type: "select-destination",
            destination: "diff",
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
      createSession,
      createTask,
      dispatchTask,
      notify,
      openWorkspace,
      runAutomation,
      runProfile,
      splitTerminalPane,
      workbench.browserPreview.url,
      workbench.preferences.theme,
      workbench.selectedAutomationId,
      workbench.selectedTaskId,
    ],
  );

  useEffect(() => {
    void refreshSessions();
    void refreshAutomations();
    void refreshConfig();
  }, [refreshAutomations, refreshConfig, refreshSessions]);

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
            pane: terminalPaneFromSnapshot(snapshot, workbench.workspaceMode),
          });
          syncTerminalSnapshot(snapshot);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [syncTerminalSnapshot, workbench.workspaceMode]);

  useEffect(() => {
    document.documentElement.dataset.theme = workbench.preferences.theme;
    document.documentElement.dataset.density = workbench.preferences.density;
    window.localStorage.setItem(THEME_STORAGE_KEY, workbench.preferences.theme);
    window.localStorage.setItem(
      WORKBENCH_STORAGE_KEY,
      JSON.stringify(workbench),
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
        void createSession();
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
        dispatchWorkbench({ type: "select-surface", surface: "chat" });
      } else if (event.key === "2") {
        event.preventDefault();
        dispatchWorkbench({ type: "select-surface", surface: "cli" });
      } else if (event.key === "3") {
        event.preventDefault();
        dispatchWorkbench({ type: "select-surface", surface: "ide" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addTerminalPane, createSession, splitTerminalPane]);

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
    if (
      activeSession.workspaceMode &&
      activeSession.workspaceMode !== workbench.workspaceMode
    ) {
      dispatchWorkbench({
        type: "set-workbench-mode",
        mode: activeSession.workspaceMode,
      });
    }
    if (!isTauriRuntime()) {
      setFiles(previewFiles);
      return;
    }
    void invoke<WorkspaceFile[]>("list_workspace_files", {
      workspacePath: activeSession.workspacePath,
    })
      .then(setFiles)
      .catch(() => setFiles([]));
  }, [activeSession, workbench.workspaceMode]);

  useEffect(() => {
    if (!selectedFile) {
      setSelectedFileContent(undefined);
      setSelectedFileError("");
      setSelectedFileLoadState("idle");
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
      setSelectedFileContent(createPreviewWorkspaceFileContent(selectedFile));
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
    void invoke<WorkspaceFileContent>("read_workspace_file", {
      path: selectedFile,
      workspacePath: root,
    })
      .then((content) => {
        if (cancelled) {
          return;
        }
        setSelectedFileContent(content);
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
  }, [activeSession?.workspacePath, files, selectedFile, workspacePath]);

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
        setActiveSessionId(event.payload.sessionId);
        setWorkspacePath(event.payload.workspacePath);
        if (event.payload.workspaceMode) {
          dispatchWorkbench({
            type: "set-workbench-mode",
            mode: event.payload.workspaceMode,
          });
        }
        dispatchWorkbench({
          type: "select-destination",
          destination: event.payload.kind === "attach-session" ? "cli" : "chat",
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

  return (
    <AppChrome
      activeDestination={activeDestination}
      activeSessionId={activeSessionId}
      isChatsCollapsed={workbench.preferences.sidebarChatsCollapsed}
      notifications={workbench.notifications}
      onCreateSession={createSession}
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
      onOpenSettingsSection={(section) => {
        dispatchWorkbench({ type: "set-settings-section", section });
        dispatchWorkbench({
          type: "select-destination",
          destination: "settings",
        });
      }}
      onOpenWorkspace={openWorkspace}
      onPinSession={pinSession}
      onRenameSession={renameSession}
      onSelectDestination={selectDestination}
      onSelectSession={(sessionId) => {
        setActiveSessionId(sessionId);
        dispatchWorkbench({ type: "select-destination", destination: "chat" });
      }}
      onSelectSurface={(surface) =>
        dispatchWorkbench({ type: "select-surface", surface })
      }
      onToggleChatsCollapsed={() =>
        dispatchWorkbench({ type: "toggle-sidebar-chats" })
      }
      pinnedSessionIds={pinnedSessionIds}
      sessions={visibleSessions}
      workspacePath={activeSession?.workspacePath ?? workspacePath}
    >
      {activeDestination === "chat" && shouldShowChatUtilityBar ? (
        <ChatUtilityBar
          activeTurn={workbench.activeTurn}
          browserPreview={workbench.browserPreview}
          diffReview={workbench.diffReview}
          onCreateSession={createSession}
          onOpenDestination={selectDestination}
          onOpenWorkspace={openWorkspace}
          sessionTitle={activeSession?.title}
          terminalPanes={workbench.terminalPanes}
          workspaceMode={
            activeSession?.workspaceMode ?? workbench.workspaceMode
          }
          workspacePath={activeSession?.workspacePath ?? workspacePath}
        />
      ) : null}
      {activeDestination === "chat" ? (
        <ChatSurface
          browserPreview={workbench.browserPreview}
          config={config}
          diffReview={workbench.diffReview}
          draft={draft}
          events={events}
          isEnvironmentRailOpen={workbench.preferences.chatEnvironmentRailOpen}
          onboarding={workbench.onboarding}
          onAgentAction={(action) => notify("terminal", "Agent action", action)}
          onCompleteOnboardingStep={(step) =>
            dispatchWorkbench({ type: "complete-onboarding-step", step })
          }
          onComposerAction={(action) =>
            notify("terminal", "Composer action", action)
          }
          onDraftChange={setDraft}
          onOpenDestination={selectDestination}
          onSend={sendDraft}
          onSetOnboardingStep={(step) =>
            dispatchWorkbench({ type: "set-onboarding-step", step })
          }
          onToggleEnvironmentRail={() =>
            dispatchWorkbench({ type: "toggle-chat-environment-rail" })
          }
          providerReadiness={workbench.providerReadiness}
          sessionTitle={activeSession?.title}
          terminalPanes={workbench.terminalPanes}
          workspacePath={activeSession?.workspacePath ?? workspacePath}
        />
      ) : null}
      {activeDestination === "cli" ? (
        <CliWorkspaceSurface
          activePaneTab={workbench.activePaneTab}
          activeProfileId={activeProfileId}
          browserPreview={workbench.browserPreview}
          diffReview={workbench.diffReview}
          files={files}
          onAcceptAllDiffs={() => {
            dispatchWorkbench({
              type: "set-diff-review-state",
              state: "approved",
              action: "all changes approved",
            });
            notify("diff-ready", "Diff approved", "All files accepted");
          }}
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
          onBrowserForward={() =>
            dispatchWorkbench({ type: "browser-forward" })
          }
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
          onCommentDiff={(path) =>
            dispatchWorkbench({ type: "add-diff-comment", path })
          }
          onDispatchTask={dispatchTask}
          onKillTerminalPane={stopTerminalPane}
          onOpenDiffInEditor={(path) => {
            setSelectedFile(path);
            dispatchWorkbench({ type: "select-surface", surface: "ide" });
          }}
          onPaneTabChange={(tab) =>
            dispatchWorkbench({ type: "set-pane-tab", tab })
          }
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
          onRunGitReviewAction={(actionId) =>
            dispatchWorkbench({ type: "run-git-review-action", actionId })
          }
          onRestartTerminalPane={restartTerminalPane}
          onRunProfile={runProfile}
          onSelectDiffFile={(path) =>
            dispatchWorkbench({ type: "select-diff-file", path })
          }
          onSelectFile={setSelectedFile}
          onSelectTerminalPane={(paneId) =>
            dispatchWorkbench({ type: "select-terminal-pane", paneId })
          }
          onSplitTerminalPane={splitTerminalPane}
          onTerminalTemplateChange={setTerminalTemplate}
          onTerminalUtilityAction={handleTerminalUtilityAction}
          onWriteTerminalInput={writeTerminalInput}
          onToggleDiffDirectory={(directory) =>
            dispatchWorkbench({ type: "toggle-diff-directory", directory })
          }
          onUndoDiff={() =>
            dispatchWorkbench({
              type: "undo-diff-action",
              action: "diff review reset",
            })
          }
          profiles={commandProfiles}
          selectedPath={selectedFile}
          selectedTerminalPaneId={workbench.selectedTerminalPaneId}
          tasks={workbench.tasks}
          terminalOutput={terminalOutput}
          terminalPanes={workbench.terminalPanes}
          terminalTemplate={workbench.terminalTemplate}
        />
      ) : null}
      {activeDestination === "ide" ? (
        <IdeSurface
          activePaneTab={workbench.activePaneTab}
          browserPreview={workbench.browserPreview}
          diffReview={workbench.diffReview}
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
          onBrowserBack={() => dispatchWorkbench({ type: "browser-back" })}
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
            notify("terminal", "Open external", workbench.browserPreview.url)
          }
          onBrowserReload={() => dispatchWorkbench({ type: "browser-reload" })}
          onBrowserScreenshot={() =>
            dispatchWorkbench({ type: "browser-screenshot" })
          }
          onBrowserUrlChange={(url) =>
            dispatchWorkbench({ type: "set-browser-url", url })
          }
          onCommentDiff={(path) =>
            dispatchWorkbench({ type: "add-diff-comment", path })
          }
          onKillTerminalPane={stopTerminalPane}
          onPaneTabChange={(tab) =>
            dispatchWorkbench({ type: "set-pane-tab", tab })
          }
          onOpenDiffInEditor={(path) => {
            setSelectedFile(path);
            dispatchWorkbench({ type: "select-surface", surface: "ide" });
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
            dispatchWorkbench({ type: "run-git-review-action", actionId })
          }
          onRestartTerminalPane={restartTerminalPane}
          onSelectFile={setSelectedFile}
          onSelectDiffFile={(path) =>
            dispatchWorkbench({ type: "select-diff-file", path })
          }
          onSelectTerminalPane={(paneId) =>
            dispatchWorkbench({ type: "select-terminal-pane", paneId })
          }
          onSplitTerminalPane={splitTerminalPane}
          onTerminalUtilityAction={handleTerminalUtilityAction}
          onWriteTerminalInput={writeTerminalInput}
          onToggleDiffDirectory={(directory) =>
            dispatchWorkbench({ type: "toggle-diff-directory", directory })
          }
          onUndoDiff={() =>
            dispatchWorkbench({
              type: "undo-diff-action",
              action: "diff review reset",
            })
          }
          selectedPath={selectedFile}
          selectedTerminalPaneId={workbench.selectedTerminalPaneId}
          terminalOutput={terminalOutput}
          terminalPanes={workbench.terminalPanes}
          terminalTemplate={workbench.terminalTemplate}
        />
      ) : null}
      {activeDestination === "settings" ? (
        <SettingsSurface
          activeSection={workbench.preferences.lastSettingsSection}
          config={config}
          density={workbench.preferences.density}
          onConfigChange={handleConfigChange}
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
          themeMode={workbench.preferences.theme}
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
          onProviderModelChange={(providerId, model) =>
            dispatchWorkbench({ type: "set-provider-model", providerId, model })
          }
          onQueueProviderHandoff={queueProviderHandoff}
          onTestProvider={testProvider}
          onToggleProvider={toggleProvider}
          providerHandoffs={workbench.providerHandoffs}
          providerSessions={workbench.providerSessions}
          providerStatuses={workbench.providerStatuses}
        />
      ) : null}
      {activeDestination === "diff" ? (
        <DiffReviewSurface
          diffReview={workbench.diffReview}
          onAcceptAll={() =>
            dispatchWorkbench({
              type: "set-diff-review-state",
              state: "approved",
              action: "all changes approved",
            })
          }
          onAcceptFile={(path) =>
            dispatchWorkbench({
              type: "set-diff-file-state",
              path,
              state: "accepted",
              action: `${path} accepted`,
            })
          }
          onComment={(path) =>
            dispatchWorkbench({ type: "add-diff-comment", path })
          }
          onOpenInEditor={(path) => {
            setSelectedFile(path);
            dispatchWorkbench({ type: "select-surface", surface: "ide" });
          }}
          onRejectAll={() =>
            dispatchWorkbench({
              type: "set-diff-review-state",
              state: "rejected",
              action: "all changes rejected",
            })
          }
          onRejectFile={(path) =>
            dispatchWorkbench({
              type: "set-diff-file-state",
              path,
              state: "rejected",
              action: `${path} rejected`,
            })
          }
          onRunGitAction={(actionId) =>
            dispatchWorkbench({ type: "run-git-review-action", actionId })
          }
          onSelectFile={(path) =>
            dispatchWorkbench({ type: "select-diff-file", path })
          }
          onToggleDirectory={(directory) =>
            dispatchWorkbench({ type: "toggle-diff-directory", directory })
          }
          onUndo={() =>
            dispatchWorkbench({
              type: "undo-diff-action",
              action: "diff review reset",
            })
          }
        />
      ) : null}
      {activeDestination === "browser" ? (
        <BrowserPreviewSurface
          browserPreview={workbench.browserPreview}
          onBack={() => dispatchWorkbench({ type: "browser-back" })}
          onDeviceChange={(device: BrowserPreviewDevice) =>
            dispatchWorkbench({ type: "browser-device", device })
          }
          onForward={() => dispatchWorkbench({ type: "browser-forward" })}
          onNavigate={(url) =>
            dispatchWorkbench({ type: "browser-navigate", url })
          }
          onOpenExternal={() =>
            notify("terminal", "Open external", workbench.browserPreview.url)
          }
          onReload={() => dispatchWorkbench({ type: "browser-reload" })}
          onScreenshot={() => dispatchWorkbench({ type: "browser-screenshot" })}
          onUrlChange={(url) =>
            dispatchWorkbench({ type: "set-browser-url", url })
          }
        />
      ) : null}
      {activeDestination === "onboarding" ? (
        <ChatSurface
          config={config}
          draft={draft}
          events={[]}
          isEnvironmentRailOpen={workbench.preferences.chatEnvironmentRailOpen}
          onboarding={workbench.onboarding}
          onCompleteOnboardingStep={(step) =>
            dispatchWorkbench({ type: "complete-onboarding-step", step })
          }
          onComposerAction={(action) =>
            notify("terminal", "Composer action", action)
          }
          onDraftChange={setDraft}
          onSend={sendDraft}
          onSetOnboardingStep={(step) =>
            dispatchWorkbench({ type: "set-onboarding-step", step })
          }
          onToggleEnvironmentRail={() =>
            dispatchWorkbench({ type: "toggle-chat-environment-rail" })
          }
          providerReadiness={workbench.providerReadiness}
          showOnboardingSteps
          workspacePath={workspacePath}
        />
      ) : null}
      {isCommandPaletteOpen ? (
        <CommandPaletteOverlay
          onClose={() => setIsCommandPaletteOpen(false)}
          onCommand={runCommandPaletteCommand}
          onQueryChange={setCommandPaletteQuery}
          onSelectDestination={selectDestination}
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
      automations,
      browserPreview,
      diffReview,
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
        theme:
          legacyTheme === "light" || legacyTheme === "dark"
            ? legacyTheme
            : (parsed.preferences?.theme ?? base.preferences.theme),
      },
      providerStatuses: Array.isArray(parsed.providerStatuses)
        ? hasSeededDemoState
          ? parsed.providerStatuses.map((provider) =>
              provider.id === "openai" || provider.id === "anthropic"
                ? { ...provider, connectionStatus: "not-configured" as const }
                : provider,
            )
          : parsed.providerStatuses
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

function loadPreviewConfig(): GyroConfig {
  const stored = window.localStorage.getItem(PREVIEW_CONFIG_STORAGE_KEY);
  if (!stored) {
    return EMPTY_CONFIG;
  }
  try {
    return { ...EMPTY_CONFIG, ...(JSON.parse(stored) as Partial<GyroConfig>) };
  } catch {
    return EMPTY_CONFIG;
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

function createTurnId() {
  return globalThis.crypto?.randomUUID?.() ?? `turn-${Date.now()}`;
}

function providerConfigsForConfig(config: GyroConfig): ModelProviderConfig[] {
  if (config.modelProviders.length > 0) {
    return config.modelProviders;
  }
  return [
    {
      id: "openai",
      displayName: "OpenAI / Codex",
      apiKeyRef: "keychain:openai",
      enabled: false,
      baseUrl: null,
    },
    {
      id: "anthropic",
      displayName: "Anthropic / Claude Code",
      apiKeyRef: "keychain:anthropic",
      enabled: false,
      baseUrl: null,
    },
    {
      id: "cursor",
      displayName: "Cursor Agent",
      apiKeyRef: "subscription",
      enabled: false,
      baseUrl: null,
    },
    {
      id: "gemini",
      displayName: "Gemini CLI",
      apiKeyRef: "keychain:gemini",
      enabled: false,
      baseUrl: null,
    },
    {
      id: "opencode",
      displayName: "OpenCode",
      apiKeyRef: "local config",
      enabled: false,
      baseUrl: null,
    },
    {
      id: "custom",
      displayName: "Custom local command",
      apiKeyRef: "env vars",
      enabled: false,
      baseUrl: null,
    },
  ];
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
    case "cursor":
      return "cursor-agent: logged in; command available";
    case "gemini":
      return "gemini cli: authenticated; ready";
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
    truncated: false,
    sizeBytes: new TextEncoder().encode(content).length,
  };
}

function createPreviewSession(
  destination: AppDestination,
  mode: WorkbenchState["workspaceMode"] = "local",
): Session {
  const now = new Date().toISOString();
  const metadata = workspaceRunMetadata(mode, destination);
  return {
    id: `preview-${Date.now()}`,
    title:
      destination === "cli"
        ? mode === "worktree"
          ? "Worktree CLI workspace"
          : "CLI workspace"
        : mode === "worktree"
          ? "Worktree session"
          : "Desktop session",
    workspacePath: "",
    origin: destination === "cli" ? "cli" : "desktop",
    workspaceMode: metadata.workspaceMode,
    branch: metadata.branch,
    worktreeName: metadata.worktreeName,
    createdAt: now,
    updatedAt: now,
    eventsPath: "preview://events",
  };
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

function createLocalEvents(
  sessionId: string,
  message: string,
  turnId: string,
): SessionEvent[] {
  const now = new Date().toISOString();
  const baseEvents: SessionEvent[] = [
    {
      id: `${sessionId}-user-${Date.now()}`,
      sessionId,
      turnId,
      createdAt: now,
      kind: "user-message",
      message,
      payload: { turnId },
    },
    {
      id: `${sessionId}-assistant-${Date.now()}`,
      sessionId,
      turnId,
      createdAt: now,
      kind: "assistant-message",
      message:
        "I can keep this local. Connect a provider or ask for a tool run when you want terminals, diffs, or approvals involved.",
      payload: { turnId },
    },
  ];

  if (!shouldPreviewToolActivity(message)) {
    return baseEvents;
  }

  return [
    ...baseEvents,
    {
      id: `${sessionId}-command-${Date.now()}`,
      sessionId,
      turnId,
      createdAt: now,
      kind: "command-requested",
      message: "pnpm check",
      payload: {
        command: "pnpm check",
        cwd: DEFAULT_WORKSPACE_PATH,
        profile: "Codex",
        requiresApproval: true,
        turnId,
      },
    },
    {
      id: `${sessionId}-diff-${Date.now()}`,
      sessionId,
      turnId,
      createdAt: now,
      kind: "file-edit-proposed",
      message:
        "file: packages/ui/src/surfaces.tsx proposed workbench interaction wiring",
      payload: {
        additions: 1,
        deletions: 1,
        path: "packages/ui/src/surfaces.tsx",
        source: "agent-generated",
        turnId,
      },
    },
    {
      id: `${sessionId}-approval-${Date.now()}`,
      sessionId,
      turnId,
      createdAt: now,
      kind: "approval-requested",
      message: "Approve proposed diff before any file mutation is applied.",
      payload: {
        policy: "approval-gated",
        reason: "file edit proposed",
        turnId,
      },
    },
  ];
}

function shouldPreviewToolActivity(message: string) {
  return (
    /\b(run|execute|test|check)\s+(pnpm|npm|yarn|bun|cargo|git|make|deno)\b/i.test(
      message,
    ) ||
    /\b(open|show|review)\s+(terminal|diff|approval|tool|browser)\b/i.test(
      message,
    ) ||
    /\b(tool preview|command preview|diff preview)\b/i.test(message)
  );
}
