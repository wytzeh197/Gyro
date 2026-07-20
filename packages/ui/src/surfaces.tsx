import {
  Activity,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  CalendarClock,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Columns2,
  Command,
  Copy,
  CornerDownRight,
  Download,
  Edit3,
  FileCode2,
  FileText,
  Folder,
  Gauge,
  GitBranch,
  GitPullRequest,
  Globe2,
  Goal,
  GripVertical,
  HardDrive,
  HelpCircle,
  ImagePlus,
  KeyRound,
  Laptop,
  Lightbulb,
  ListChecks,
  LayoutPanelLeft,
  LockKeyhole,
  Maximize2,
  MessageSquare,
  Minimize2,
  Minus,
  Moon,
  MoreHorizontal,
  Palette,
  PanelBottom,
  PanelLeftClose,
  PanelRight,
  Paperclip,
  PauseCircle,
  Pin,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  Terminal,
  TriangleAlert,
  Trash2,
  UserCircle,
  Video,
  X,
} from "lucide-react";
import {
  Fragment,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import gyroLogoTransparentDark from "./assets/gyro-logo-transparent-dark.png";
import gyroLogoTransparentLight from "./assets/gyro-logo-transparent.png";
import { structuredCommentaryBlocks } from "./chat-commentary";
import {
  ChatArtifacts,
  chatArtifactsFromEvent,
  type ChatArtifactActions,
} from "./chat-artifacts";
import {
  interleavedChatTimelineItems,
  orderedChatTimelineEvents,
} from "./chat-timeline";
import {
  estimateComposerContextUsage,
  type ComposerContextUsage,
} from "./context-usage";
import {
  globalSearchMatchScore,
  normalizedGlobalSearchText,
} from "./global-search";
import type {
  AppDestination,
  Automation,
  BrowserPreview,
  BrowserPreviewDevice,
  CapabilityActivity,
  CapabilityCallEvent,
  ChatAttachment,
  ChatArtifact,
  ChatPaneRef,
  ChatProjectLayout,
  ChatMode,
  ChatSidePanelId,
  CliLaunchPreset,
  CommandProfile,
  DiffFile,
  DiffReview,
  DebugSessionState,
  EditorBuffer,
  EditorGroup,
  EditorRevealTarget,
  EditorSelection,
  EditorTab,
  IdeAssistantAction,
  IdeState,
  IdeViewId,
  GitReviewActionId,
  GlobalSearchProject,
  GlobalSearchSelection,
  GitBranchCatalog,
  GyroConfig,
  Notification,
  NotificationPermissionState,
  OnboardingState,
  ProviderId,
  ProviderUsageState,
  ProviderReadiness,
  ProviderHandoff,
  ProviderSession,
  ProviderStatus,
  ProjectCapabilityPolicy,
  ReasoningEffort,
  SettingsSectionId,
  Session,
  SessionEvent,
  SessionGoal,
  SessionPlan,
  SessionPlanItemStatus,
  SourceControlFile,
  SourceControlState,
  Task,
  TaskDefinition,
  TaskStatus,
  TerminalPane,
  TerminalPaneLayout,
  TerminalTemplate,
  ThemeMode,
  UpdateState,
  WorkbenchDensity,
  WorkbenchMode,
  WorkbenchPaneTab,
  WorkbenchTurn,
  WorkspaceFile,
  WorkspaceFileContent,
  WorkspaceLayoutId,
  WorkspacePreparationProgress,
} from "./types";
import {
  CLI_LAUNCH_PRESET_MAX_PANES,
  canSendChat,
  defaultCliLaunchPreset,
  defaultCommandProfiles,
  defaultProviderStatuses,
  isUserSelectedWorkspacePath,
} from "./workbench-state";
import {
  getProviderModel,
  isProviderExecutable,
  providerCapabilities,
  providersForConfig,
  selectedModelLabel,
  selectedReasoningEffort,
} from "./provider-catalog";

type BrowserScreenshotAction = "capture" | "reveal";
import { shouldShowSidebarUpdate, updateSidebarLabel } from "./update-state";

type IconComponent = typeof MessageSquare;
const CommandIcon = Command;
const CHAT_SESSION_DRAG_MIME = "application/x-gyro-chat-session";
const CHAT_PANE_DRAG_MIME = "application/x-gyro-chat-pane";
const TOOL_PANEL_DEFAULT_HEIGHT = 280;
const TOOL_PANEL_MIN_HEIGHT = 140;
const TOOL_PANEL_COLLAPSE_HEIGHT = 96;
const IDE_SIDEBAR_KEYBOARD_STEP = 16;

function restingSidebarWidth() {
  if (typeof window === "undefined") {
    return 240;
  }
  if (window.innerWidth <= 980) {
    return 190;
  }
  if (window.innerWidth <= 1280) {
    return 224;
  }
  return 240;
}

function useOutsidePointerDismiss<T extends HTMLElement>(
  isOpen: boolean,
  onDismiss: () => void,
) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const current = ref.current;
      if (!current || event.composedPath().includes(current)) {
        return;
      }
      onDismiss();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isOpen, onDismiss]);

  return ref;
}

type AppChromeProps = {
  sessions: Session[];
  commandProfiles: CommandProfile[];
  savedProjects: Array<{ path: string; label: string }>;
  activeSessionId?: string;
  sendingSessionIds?: string[];
  activeDestination: AppDestination;
  activeWorkspaceLayout: WorkspaceLayoutId;
  workspacePath?: string;
  notifications?: Notification[];
  pinnedSessionIds?: string[];
  openChatSessionIds?: string[];
  isChatsCollapsed?: boolean;
  terminalPanes?: TerminalPane[];
  selectedTerminalPaneId?: string;
  files?: WorkspaceFile[];
  ide?: IdeState;
  activePaneTab?: WorkbenchPaneTab;
  activeSettingsSection?: SettingsSectionId;
  updateState?: UpdateState;
  workspacePreparation?: WorkspacePreparationProgress;
  onSelectSession: (sessionId: string) => void;
  onAddSessionToGrid?: (sessionId: string) => void;
  onSelectWorkspaceLayout: (layout: WorkspaceLayoutId) => void;
  onSelectDestination: (destination: AppDestination) => void;
  onOpenToolPanel: (tab: WorkbenchPaneTab) => void;
  onDeleteSession?: (sessionId: string) => void;
  onDismissNotification?: (id: string) => void;
  onOpenSettings: () => void;
  onOpenSettingsSection?: (section: SettingsSectionId) => void;
  onOpenCommandPalette: () => void;
  onCreateSession: () => void;
  onCreateCliSession: (profileId: string, workspacePath: string) => void;
  onSelectSessions: () => void;
  onOpenWorkspace: () => void;
  onOpenWorkspaceFile?: (
    path: string,
    lineNumber?: number,
    column?: number,
  ) => void;
  onPinEditorTab?: (path: string) => void;
  onRefreshWorkspace?: () => void;
  onCreateWorkspacePath?: (
    kind: "file" | "directory",
    parentPath?: string,
  ) => void;
  onRenameWorkspacePath?: (path: string) => void;
  onDeleteWorkspacePath?: (path: string) => void;
  onSelectIdeView?: (view: IdeViewId) => void;
  onRunWorkspaceSearch?: (query: string) => void;
  onRefreshSourceControl?: () => void;
  onToggleSourceControlFile?: (path: string, staged: boolean) => void;
  onDiscardSourceControlFile?: (path: string) => void;
  onOpenSourceControlDiff?: (path: string, staged: boolean) => void;
  onCommitSourceControl?: (message: string) => void;
  onRunIdeTask?: (task: TaskDefinition) => void;
  onStartDebugSession?: (command: string) => void;
  onSendDebugCommand?: (session: DebugSessionState, command: string) => void;
  onStopDebugSession?: (session: DebugSessionState) => void;
  onAddTerminalPane?: () => void;
  onCloseTerminalPane?: (paneId: string) => void;
  onSelectTerminalPane?: (paneId: string) => void;
  onPinSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string) => void;
  onRemoveProject?: (project: { path: string; label: string }) => void;
  onToggleChatsCollapsed?: () => void;
  onSettingsSectionChange?: (section: SettingsSectionId) => void;
  onSettingsBack?: () => void;
  onUpdateAction?: (state: UpdateState) => void;
  onRetryWorkspacePreparation?: () => void;
  children: ReactNode;
};

const paneTabs: Array<{
  id: WorkbenchPaneTab;
  label: string;
  icon: IconComponent;
}> = [
  { id: "diff", label: "Diff", icon: GitPullRequest },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "browser", label: "Browser", icon: Globe2 },
  { id: "problems", label: "Problems", icon: CircleDashed },
  { id: "output", label: "Output", icon: FileText },
];

const settingsSidebarItems: Array<{
  id: SettingsSectionId;
  label: string;
  icon: IconComponent;
  group: "Workspace" | "System";
}> = [
  {
    id: "general",
    label: "General",
    icon: SlidersHorizontal,
    group: "Workspace",
  },
  { id: "appearance", label: "Appearance", icon: Palette, group: "Workspace" },
  {
    id: "usage-limits",
    label: "Usage Limits",
    icon: Gauge,
    group: "Workspace",
  },
  { id: "providers", label: "Providers", icon: KeyRound, group: "Workspace" },
  {
    id: "cli-profiles",
    label: "CLI Profiles",
    icon: Terminal,
    group: "Workspace",
  },
  {
    id: "permissions",
    label: "Permissions",
    icon: LockKeyhole,
    group: "System",
  },
  { id: "updates", label: "Updates", icon: RefreshCw, group: "System" },
  { id: "keyboard", label: "Keyboard", icon: CommandIcon, group: "System" },
  { id: "advanced", label: "Advanced", icon: Settings, group: "System" },
  { id: "about", label: "Help", icon: HelpCircle, group: "System" },
];

type SettingsSearchEntry = {
  detail: string;
  keywords?: string;
  label: string;
  section: SettingsSectionId;
};

const settingsSearchEntries: SettingsSearchEntry[] = [
  {
    section: "general",
    label: "General",
    detail: "Startup, sessions, workspace, and default surface",
  },
  {
    section: "general",
    label: "Startup behavior",
    detail: "Open the last workspace on launch",
    keywords: "restore reopen boot",
  },
  {
    section: "general",
    label: "Default workspace",
    detail: "Choose which folder opens for sessions",
    keywords: "project path launch",
  },
  {
    section: "general",
    label: "Default surface",
    detail: "Start in Sessions or Workspace",
    keywords: "chat destination",
  },
  {
    section: "general",
    label: "Session restore",
    detail: "Restore app and terminal layouts after restart",
    keywords: "resume reopen",
  },
  {
    section: "general",
    label: "Continue sessions from CLI",
    detail: "Attach CLI-origin sessions to the desktop app",
    keywords: "terminal resume",
  },
  {
    section: "appearance",
    label: "Appearance",
    detail: "Theme, density, font, and motion",
  },
  {
    section: "appearance",
    label: "Theme",
    detail: "Switch between Light and Dark mode",
    keywords: "color appearance",
  },
  {
    section: "appearance",
    label: "Density",
    detail: "Use Compact or Comfortable interface spacing",
    keywords: "layout spacing",
  },
  {
    section: "appearance",
    label: "Terminal font",
    detail: "Font used by CLI panes, logs, and command blocks",
    keywords: "sf mono typography",
  },
  {
    section: "appearance",
    label: "Reduce motion",
    detail: "Follow macOS animation preferences",
    keywords: "animation accessibility transitions",
  },
  {
    section: "usage-limits",
    label: "Usage Limits",
    detail: "Provider allowance, spend, and local guardrails",
  },
  {
    section: "usage-limits",
    label: "Provider spend",
    detail: "Provider-owned billing and allowance controls",
    keywords: "cost budget billing usage",
  },
  {
    section: "usage-limits",
    label: "Parallel agents",
    detail: "Control multiple simultaneous CLI agents",
    keywords: "concurrency",
  },
  {
    section: "usage-limits",
    label: "Command output",
    detail: "Bound and summarize large terminal output",
    keywords: "limit logs truncation",
  },
  {
    section: "usage-limits",
    label: "Approval budget",
    detail: "Guard file edits and command escalation",
    keywords: "permissions strict",
  },
  {
    section: "providers",
    label: "Providers",
    detail: "Connect OpenAI, Anthropic, Gemini, and xAI",
    keywords: "model api key authentication credentials",
  },
  {
    section: "cli-profiles",
    label: "CLI Profiles",
    detail: "Configure launch presets and saved terminal commands",
    keywords: "shell command agent",
  },
  {
    section: "cli-profiles",
    label: "Hook notifications",
    detail: "Show done, waiting, failed, and approval states",
    keywords: "alerts",
  },
  {
    section: "permissions",
    label: "Permissions",
    detail: "Agent approvals and workspace protection",
  },
  {
    section: "permissions",
    label: "Command policy",
    detail: "Require approval before executing commands",
    keywords: "ask auto approve shell",
  },
  {
    section: "permissions",
    label: "File edit policy",
    detail: "Require approval before changing files",
    keywords: "writes mutations auto approve",
  },
  {
    section: "permissions",
    label: "Workspace boundary",
    detail: "Protect files outside the current folder",
    keywords: "sandbox path access",
  },
  {
    section: "permissions",
    label: "Network access",
    detail: "Gate external calls by provider or profile",
    keywords: "internet permissions",
  },
  {
    section: "permissions",
    label: "Secrets redaction",
    detail: "Mask secrets in prompts, logs, and diagnostics",
    keywords: "privacy api keys tokens",
  },
  {
    section: "permissions",
    label: "Automation outcomes",
    detail: "Test system notifications",
    keywords: "alerts notification",
  },
  {
    section: "updates",
    label: "Updates",
    detail: "Automatic checks, release channel, and version status",
  },
  {
    section: "updates",
    label: "Automatic checks",
    detail: "Check for updates after launch and focus",
    keywords: "updater download",
  },
  {
    section: "updates",
    label: "Last checked",
    detail: "Check for updates now",
    keywords: "refresh version",
  },
  {
    section: "keyboard",
    label: "Keyboard",
    detail: "Shortcuts for navigation, sessions, terminal, and search",
    keywords: "hotkeys keybindings cmd command palette",
  },
  {
    section: "advanced",
    label: "Advanced",
    detail: "Local runtime, storage, diagnostics, and reset",
  },
  {
    section: "advanced",
    label: "Local socket",
    detail: "Desktop bridge used by CLI agents",
    keywords: "runtime connection",
  },
  {
    section: "advanced",
    label: "Session store",
    detail: "Location of saved sessions and terminal layouts",
    keywords: "application support storage files",
  },
  {
    section: "advanced",
    label: "Logs path",
    detail: "Location of local diagnostic logs",
    keywords: "debug diagnostics folder",
  },
  {
    section: "advanced",
    label: "Export diagnostics",
    detail: "Create a redacted issue-report bundle",
    keywords: "support logs",
  },
  {
    section: "advanced",
    label: "Reset UI state",
    detail: "Clear layout preferences without touching project files",
    keywords: "restore defaults",
  },
  {
    section: "about",
    label: "Help",
    detail: "Version, license, release notes, and security resources",
  },
  {
    section: "about",
    label: "Version and build",
    detail: "Installed Gyro version",
    keywords: "about release",
  },
  {
    section: "about",
    label: "License",
    detail: "Apache 2.0 open-source license",
  },
  {
    section: "about",
    label: "Security policy",
    detail: "Open the project security documentation",
    keywords: "vulnerability",
  },
];

function settingsSearchKey(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function settingsSearchResults(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return settingsSearchEntries
    .flatMap((entry) => {
      const label = entry.label.toLowerCase();
      const searchable = `${label} ${entry.detail.toLowerCase()} ${entry.keywords ?? ""}`;
      if (!tokens.every((token) => searchable.includes(token))) return [];
      const score =
        label === normalized
          ? 120
          : label.startsWith(normalized)
            ? 100
            : label.includes(normalized)
              ? 80
              : searchable.includes(normalized)
                ? 60
                : 40;
      return [{ entry, score }];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.entry.label.localeCompare(right.entry.label),
    )
    .slice(0, 8)
    .map(({ entry }) => entry);
}

export function AppChrome({
  sessions,
  commandProfiles,
  savedProjects,
  activeSessionId,
  sendingSessionIds = [],
  activeDestination,
  activeWorkspaceLayout,
  workspacePath,
  notifications = [],
  pinnedSessionIds = [],
  openChatSessionIds = [],
  isChatsCollapsed = false,
  terminalPanes = [],
  selectedTerminalPaneId,
  files = [],
  ide,
  activePaneTab = "diff",
  activeSettingsSection = "general",
  updateState,
  onSelectSession,
  onAddSessionToGrid,
  onSelectWorkspaceLayout,
  onSelectDestination,
  onOpenToolPanel,
  onDeleteSession,
  onDismissNotification,
  onOpenSettings,
  onOpenSettingsSection,
  onOpenCommandPalette,
  onCreateSession,
  onCreateCliSession,
  onSelectSessions,
  onOpenWorkspace,
  onOpenWorkspaceFile,
  onPinEditorTab,
  onRefreshWorkspace,
  onCreateWorkspacePath,
  onRenameWorkspacePath,
  onDeleteWorkspacePath,
  onSelectIdeView,
  onRunWorkspaceSearch,
  onRefreshSourceControl,
  onToggleSourceControlFile,
  onDiscardSourceControlFile,
  onOpenSourceControlDiff,
  onCommitSourceControl,
  onRunIdeTask,
  onStartDebugSession,
  onSendDebugCommand,
  onStopDebugSession,
  onAddTerminalPane,
  onCloseTerminalPane,
  onSelectTerminalPane,
  onPinSession,
  onRenameSession,
  onRemoveProject,
  onToggleChatsCollapsed,
  onSettingsSectionChange,
  onSettingsBack,
  onUpdateAction,
  workspacePreparation,
  onRetryWorkspacePreparation,
  children,
}: AppChromeProps) {
  const [isSidebarHidden, setIsSidebarHidden] = useState(false);
  const [settingsQuery, setSettingsQuery] = useState("");
  const [isSettingsSearchFocused, setIsSettingsSearchFocused] = useState(false);
  const [selectedSettingsResultIndex, setSelectedSettingsResultIndex] =
    useState(0);
  const matchingSettings = useMemo(
    () => settingsSearchResults(settingsQuery),
    [settingsQuery],
  );
  const [isWorkspacePreparationOpen, setIsWorkspacePreparationOpen] =
    useState(false);
  const workspacePreparationRef = useOutsidePointerDismiss<HTMLDivElement>(
    isWorkspacePreparationOpen,
    () => setIsWorkspacePreparationOpen(false),
  );
  const [ideSidebarMinimumWidth, setIdeSidebarMinimumWidth] =
    useState(restingSidebarWidth);
  const [ideSidebarWidth, setIdeSidebarWidth] = useState(restingSidebarWidth);
  const [isIdeSidebarCustomized, setIsIdeSidebarCustomized] = useState(false);
  const [isIdeSidebarResizing, setIsIdeSidebarResizing] = useState(false);
  const appShellRef = useRef<HTMLDivElement>(null);
  const ideSidebarResizeRef = useRef<
    | {
        animationFrame?: number;
        currentWidth: number;
        pendingWidth: number;
        pointerId: number;
        startWidth: number;
        startX: number;
      }
    | undefined
  >(undefined);
  const activeSession = sessions.find(
    (session) => session.id === activeSessionId,
  );
  const isIdeSurface =
    activeDestination === "workspace" && activeWorkspaceLayout === "code";
  const ideSidebarMaximumWidth = ideSidebarMinimumWidth * 2;
  const showSidebarUpdate = updateState
    ? shouldShowSidebarUpdate(updateState)
    : false;

  useEffect(() => {
    setSelectedSettingsResultIndex(0);
  }, [settingsQuery]);

  const openSettingsSearchResult = (entry: SettingsSearchEntry) => {
    onSettingsSectionChange?.(entry.section);
    setSettingsQuery("");
    setIsSettingsSearchFocused(false);
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        const sectionLabel = settingsSidebarItems.find(
          (item) => item.id === entry.section,
        )?.label;
        const target =
          document.querySelector<HTMLElement>(
            `[data-setting-key="${settingsSearchKey(entry.label)}"]`,
          ) ??
          (sectionLabel
            ? document.querySelector<HTMLElement>(
                `[data-setting-key="${settingsSearchKey(sectionLabel)}"]`,
              )
            : null);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
        target?.focus({ preventScroll: true });
        target?.classList.add("is-search-target");
        window.setTimeout(
          () => target?.classList.remove("is-search-target"),
          1_400,
        );
      }),
    );
  };

  useEffect(() => {
    if (!isIdeSurface) {
      const restingWidth = restingSidebarWidth();
      const resize = ideSidebarResizeRef.current;
      if (resize?.animationFrame !== undefined) {
        cancelAnimationFrame(resize.animationFrame);
      }
      ideSidebarResizeRef.current = undefined;
      appShellRef.current?.style.setProperty(
        "--gyro-ide-sidebar-width",
        `${restingWidth}px`,
      );
      setIsIdeSidebarResizing(false);
      setIsIdeSidebarCustomized(false);
      setIdeSidebarMinimumWidth(restingWidth);
      setIdeSidebarWidth(restingWidth);
    }
  }, [isIdeSurface]);

  useEffect(() => {
    const syncIdeSidebarBreakpoint = () => {
      const restingWidth = restingSidebarWidth();
      const maximumWidth = restingWidth * 2;
      setIdeSidebarMinimumWidth(restingWidth);
      setIdeSidebarWidth((currentWidth) => {
        const nextWidth = isIdeSidebarCustomized
          ? Math.min(maximumWidth, Math.max(restingWidth, currentWidth))
          : restingWidth;
        appShellRef.current?.style.setProperty(
          "--gyro-ide-sidebar-width",
          `${nextWidth}px`,
        );
        return nextWidth;
      });
    };

    window.addEventListener("resize", syncIdeSidebarBreakpoint);
    return () => window.removeEventListener("resize", syncIdeSidebarBreakpoint);
  }, [isIdeSidebarCustomized]);

  const clampIdeSidebarWidth = useCallback(
    (width: number) =>
      Math.min(ideSidebarMaximumWidth, Math.max(ideSidebarMinimumWidth, width)),
    [ideSidebarMaximumWidth, ideSidebarMinimumWidth],
  );

  const beginIdeSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      ideSidebarResizeRef.current = {
        currentWidth: ideSidebarWidth,
        pendingWidth: ideSidebarWidth,
        pointerId: event.pointerId,
        startWidth: ideSidebarWidth,
        startX: event.clientX,
      };
      setIsIdeSidebarResizing(true);
    },
    [ideSidebarWidth],
  );

  const resizeIdeSidebar = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resize = ideSidebarResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) {
        return;
      }
      resize.pendingWidth = clampIdeSidebarWidth(
        resize.startWidth + event.clientX - resize.startX,
      );
      if (resize.animationFrame !== undefined) {
        return;
      }
      resize.animationFrame = requestAnimationFrame(() => {
        resize.animationFrame = undefined;
        resize.currentWidth = resize.pendingWidth;
        appShellRef.current?.style.setProperty(
          "--gyro-ide-sidebar-width",
          `${resize.currentWidth}px`,
        );
      });
    },
    [clampIdeSidebarWidth],
  );

  const endIdeSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resize = ideSidebarResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) {
        return;
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (resize.animationFrame !== undefined) {
        cancelAnimationFrame(resize.animationFrame);
      }
      const finalWidth = resize.pendingWidth;
      appShellRef.current?.style.setProperty(
        "--gyro-ide-sidebar-width",
        `${finalWidth}px`,
      );
      ideSidebarResizeRef.current = undefined;
      setIdeSidebarWidth(finalWidth);
      setIsIdeSidebarCustomized(finalWidth !== ideSidebarMinimumWidth);
      setIsIdeSidebarResizing(false);
    },
    [ideSidebarMinimumWidth],
  );

  const resizeIdeSidebarWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      let nextWidth: number | undefined;
      if (event.key === "ArrowLeft") {
        nextWidth = ideSidebarWidth - IDE_SIDEBAR_KEYBOARD_STEP;
      } else if (event.key === "ArrowRight") {
        nextWidth = ideSidebarWidth + IDE_SIDEBAR_KEYBOARD_STEP;
      } else if (event.key === "Home") {
        nextWidth = ideSidebarMinimumWidth;
      } else if (event.key === "End") {
        nextWidth = ideSidebarMaximumWidth;
      }
      if (nextWidth === undefined) {
        return;
      }
      event.preventDefault();
      const clampedWidth = clampIdeSidebarWidth(nextWidth);
      setIdeSidebarWidth(clampedWidth);
      setIsIdeSidebarCustomized(clampedWidth !== ideSidebarMinimumWidth);
    },
    [
      clampIdeSidebarWidth,
      ideSidebarMaximumWidth,
      ideSidebarMinimumWidth,
      ideSidebarWidth,
    ],
  );

  return (
    <div
      className={`gyro-app-shell is-chat-shell is-workspace-shell ${
        activeDestination === "workspace" && activeWorkspaceLayout === "thread"
          ? "is-thread-layout"
          : ""
      } ${isSidebarHidden ? "is-sidebar-hidden" : ""} ${
        isIdeSidebarResizing ? "is-ide-sidebar-resizing" : ""
      }`}
      style={
        {
          "--gyro-ide-sidebar-width": `${ideSidebarWidth}px`,
        } as CSSProperties
      }
      ref={appShellRef}
    >
      {isSidebarHidden ? (
        <div className="gyro-sidebar-restore-cluster">
          <button
            aria-label="Show sidebar"
            className="gyro-sidebar-restore-button"
            onClick={() => setIsSidebarHidden(false)}
            type="button"
          >
            <PanelLeftClose size={13} />
          </button>
          <WorkspacePreparationControl
            controlRef={workspacePreparationRef}
            isOpen={isWorkspacePreparationOpen}
            onClose={() => setIsWorkspacePreparationOpen(false)}
            onRetry={onRetryWorkspacePreparation}
            onToggle={() =>
              setIsWorkspacePreparationOpen((current) => !current)
            }
            progress={workspacePreparation}
          />
        </div>
      ) : (
        <aside className="gyro-sidebar">
          {activeDestination === "settings" ? (
            <SettingsSidebarContent
              activeSection={activeSettingsSection}
              onBack={() => {
                setSettingsQuery("");
                (onSettingsBack ?? (() => onSelectDestination("workspace")))();
              }}
              onSectionChange={onSettingsSectionChange}
              onToggleSidebar={() => setIsSidebarHidden(true)}
              isWorkspacePreparationOpen={isWorkspacePreparationOpen}
              onCloseWorkspacePreparation={() =>
                setIsWorkspacePreparationOpen(false)
              }
              onRetryWorkspacePreparation={onRetryWorkspacePreparation}
              onToggleWorkspacePreparation={() =>
                setIsWorkspacePreparationOpen((current) => !current)
              }
              workspacePreparation={workspacePreparation}
              workspacePreparationRef={workspacePreparationRef}
            />
          ) : (
            <WorkspaceSidebarContent
              activeDestination={activeDestination}
              activePaneTab={activePaneTab}
              activeSession={activeSession}
              activeSessionId={activeSessionId}
              sendingSessionIds={sendingSessionIds}
              activeWorkspaceLayout={activeWorkspaceLayout}
              commandProfiles={commandProfiles}
              files={files}
              ide={ide}
              isChatsCollapsed={isChatsCollapsed}
              onAddTerminalPane={onAddTerminalPane}
              onCloseTerminalPane={onCloseTerminalPane}
              onCreateSession={onCreateSession}
              onCreateCliSession={onCreateCliSession}
              onDeleteSession={onDeleteSession}
              onOpenCommandPalette={onOpenCommandPalette}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
              onPinEditorTab={onPinEditorTab}
              onRefreshWorkspace={onRefreshWorkspace}
              onCreateWorkspacePath={onCreateWorkspacePath}
              onRenameWorkspacePath={onRenameWorkspacePath}
              onDeleteWorkspacePath={onDeleteWorkspacePath}
              onOpenToolPanel={onOpenToolPanel}
              onOpenWorkspace={onOpenWorkspace}
              onPinSession={onPinSession}
              onRenameSession={onRenameSession}
              onRemoveProject={onRemoveProject}
              onRefreshSourceControl={onRefreshSourceControl}
              onOpenSourceControlDiff={onOpenSourceControlDiff}
              onCommitSourceControl={onCommitSourceControl}
              onRunIdeTask={onRunIdeTask}
              onStartDebugSession={onStartDebugSession}
              onSendDebugCommand={onSendDebugCommand}
              onStopDebugSession={onStopDebugSession}
              onRunWorkspaceSearch={onRunWorkspaceSearch}
              onSelectDestination={onSelectDestination}
              onSelectIdeView={onSelectIdeView}
              onSelectSession={onSelectSession}
              onAddSessionToGrid={onAddSessionToGrid}
              onSelectSessions={onSelectSessions}
              onSelectTerminalPane={onSelectTerminalPane}
              onSelectWorkspaceLayout={onSelectWorkspaceLayout}
              onToggleChatsCollapsed={onToggleChatsCollapsed}
              onToggleSourceControlFile={onToggleSourceControlFile}
              onDiscardSourceControlFile={onDiscardSourceControlFile}
              onToggleSidebar={() => setIsSidebarHidden(true)}
              onUpdateAction={onUpdateAction}
              pinnedSessionIds={pinnedSessionIds}
              openChatSessionIds={openChatSessionIds}
              savedProjects={savedProjects}
              selectedTerminalPaneId={selectedTerminalPaneId}
              sessions={sessions}
              terminalPanes={terminalPanes}
              updateState={showSidebarUpdate ? updateState : undefined}
              isWorkspacePreparationOpen={isWorkspacePreparationOpen}
              onCloseWorkspacePreparation={() =>
                setIsWorkspacePreparationOpen(false)
              }
              onRetryWorkspacePreparation={onRetryWorkspacePreparation}
              onToggleWorkspacePreparation={() =>
                setIsWorkspacePreparationOpen((current) => !current)
              }
              workspacePreparation={workspacePreparation}
              workspacePreparationRef={workspacePreparationRef}
              workspacePath={workspacePath}
            />
          )}

          {activeDestination !== "settings" ? (
            <div className="gyro-sidebar-footer">
              <button
                className="gyro-account-button"
                onClick={() => {
                  if (onOpenSettingsSection) {
                    onOpenSettingsSection("general");
                    return;
                  }
                  onOpenSettings();
                }}
                type="button"
              >
                <Settings size={16} />
                <span className="gyro-account-name">
                  <strong>Settings</strong>
                </span>
              </button>
            </div>
          ) : null}
          {isIdeSurface ? (
            <div
              aria-label="Resize Workspace sidebar"
              aria-orientation="vertical"
              aria-valuemax={ideSidebarMaximumWidth}
              aria-valuemin={ideSidebarMinimumWidth}
              aria-valuenow={ideSidebarWidth}
              className="gyro-ide-sidebar-resizer"
              onDoubleClick={() => {
                setIdeSidebarWidth(ideSidebarMinimumWidth);
                setIsIdeSidebarCustomized(false);
              }}
              onKeyDown={resizeIdeSidebarWithKeyboard}
              onPointerCancel={endIdeSidebarResize}
              onPointerDown={beginIdeSidebarResize}
              onPointerMove={resizeIdeSidebar}
              onPointerUp={endIdeSidebarResize}
              role="separator"
              tabIndex={0}
              title="Resize Workspace sidebar"
            />
          ) : null}
        </aside>
      )}
      <main className="gyro-main">
        {activeDestination === "settings" ? (
          <div className="gyro-settings-topbar">
            <div
              aria-hidden="true"
              className="gyro-settings-topbar-drag-region"
              data-tauri-drag-region
            />
            <div
              className="gyro-settings-topbar-search"
              onBlurCapture={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  setIsSettingsSearchFocused(false);
                }
              }}
            >
              <Search aria-hidden="true" size={14} />
              <input
                aria-activedescendant={
                  matchingSettings.length > 0
                    ? `settings-result-${selectedSettingsResultIndex}`
                    : undefined
                }
                aria-autocomplete="list"
                aria-controls="settings-search-results"
                aria-expanded={
                  isSettingsSearchFocused && Boolean(settingsQuery.trim())
                }
                aria-label="Search settings"
                onChange={(event) => setSettingsQuery(event.target.value)}
                onFocus={() => setIsSettingsSearchFocused(true)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" && matchingSettings.length) {
                    event.preventDefault();
                    setSelectedSettingsResultIndex((current) =>
                      Math.min(current + 1, matchingSettings.length - 1),
                    );
                  } else if (
                    event.key === "ArrowUp" &&
                    matchingSettings.length
                  ) {
                    event.preventDefault();
                    setSelectedSettingsResultIndex((current) =>
                      Math.max(0, current - 1),
                    );
                  } else if (event.key === "Enter") {
                    const result =
                      matchingSettings[selectedSettingsResultIndex];
                    if (result) {
                      event.preventDefault();
                      openSettingsSearchResult(result);
                    }
                  } else if (event.key === "Escape") {
                    setSettingsQuery("");
                    setIsSettingsSearchFocused(false);
                  }
                }}
                placeholder="Search settings"
                role="combobox"
                type="search"
                value={settingsQuery}
              />
              {settingsQuery ? (
                <button
                  aria-label="Clear settings search"
                  onClick={() => setSettingsQuery("")}
                  type="button"
                >
                  <X size={13} />
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
              {isSettingsSearchFocused && settingsQuery.trim() ? (
                <div
                  className="gyro-settings-search-results"
                  id="settings-search-results"
                  role="listbox"
                >
                  {matchingSettings.length > 0 ? (
                    matchingSettings.map((entry, index) => {
                      const section = settingsSidebarItems.find(
                        (item) => item.id === entry.section,
                      );
                      const Icon = section?.icon ?? Settings;
                      return (
                        <button
                          aria-selected={selectedSettingsResultIndex === index}
                          className={
                            selectedSettingsResultIndex === index
                              ? "is-selected"
                              : undefined
                          }
                          id={`settings-result-${index}`}
                          key={`${entry.section}-${entry.label}`}
                          onClick={() => openSettingsSearchResult(entry)}
                          onMouseEnter={() =>
                            setSelectedSettingsResultIndex(index)
                          }
                          role="option"
                          type="button"
                        >
                          <Icon size={15} />
                          <span>
                            <strong>{entry.label}</strong>
                            <small>{entry.detail}</small>
                          </span>
                          <em>{section?.label}</em>
                        </button>
                      );
                    })
                  ) : (
                    <div className="gyro-settings-search-empty">
                      <Search size={16} />
                      <span>
                        <strong>No matching settings</strong>
                        <small>Try a control, feature, or related term.</small>
                      </span>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : activeDestination === "workspace" &&
          activeWorkspaceLayout === "thread" &&
          !activeSession ? (
          <div
            aria-hidden="true"
            className="gyro-main-titlebar-drag-region"
            data-tauri-drag-region
          />
        ) : null}
        {children}
      </main>
    </div>
  );
}

const workspacePreparationStages = [
  { id: "catalog", label: "Catalog workspace" },
  { id: "watcher", label: "Start file watcher" },
  { id: "git", label: "Inspect Git" },
  { id: "tasks", label: "Discover tasks" },
  { id: "tests", label: "Discover tests" },
] as const;

function WorkspacePreparationControl({
  progress,
  isOpen,
  onToggle,
  onClose,
  onRetry,
  controlRef,
}: {
  progress?: WorkspacePreparationProgress;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onRetry?: () => void;
  controlRef: RefObject<HTMLDivElement | null>;
}) {
  if (!progress) return null;
  const percent = Math.round(
    (Math.min(progress.completedSteps, progress.totalSteps) /
      Math.max(1, progress.totalSteps)) *
      100,
  );
  const failedPhases = new Set(progress.errors.map((error) => error.phase));
  const phaseIndex = workspacePreparationStages.findIndex(
    (stage) => stage.id === progress.phase,
  );

  return (
    <div className="gyro-workspace-preparation" ref={controlRef as never}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`${progress.message}, ${percent}%`}
        className="gyro-workspace-preparation-button"
        data-status={progress.status}
        onClick={onToggle}
        title={`${progress.message} · ${percent}%`}
        type="button"
      >
        <span
          aria-hidden="true"
          className="gyro-workspace-preparation-ring"
          style={
            { "--gyro-preparation-progress": `${percent}%` } as CSSProperties
          }
        >
          {progress.status === "ready" ? <Check size={9} /> : null}
          {progress.status === "degraded" || progress.status === "failed" ? (
            <TriangleAlert size={9} />
          ) : null}
        </span>
        <span>
          {progress.status === "preparing" ? `${percent}%` : progress.status}
        </span>
      </button>
      {isOpen ? (
        <section
          aria-label="Workspace preparation details"
          className="gyro-workspace-preparation-popover"
          role="dialog"
        >
          <header>
            <div>
              <strong>{progress.message}</strong>
              <span title={progress.workspacePath}>
                {workspaceName(progress.workspacePath)} · {percent}%
              </span>
            </div>
            <button
              aria-label="Close preparation details"
              onClick={onClose}
              type="button"
            >
              <X size={13} />
            </button>
          </header>
          <div
            aria-label="Workspace preparation progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent}
            className="gyro-workspace-preparation-bar"
            role="progressbar"
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="gyro-workspace-preparation-stages">
            {workspacePreparationStages.map((stage, index) => {
              const isFailed = failedPhases.has(stage.id);
              const isDone = index < progress.completedSteps && !isFailed;
              const isActive =
                progress.status === "preparing" && index === phaseIndex;
              return (
                <div
                  data-state={
                    isFailed
                      ? "failed"
                      : isDone
                        ? "done"
                        : isActive
                          ? "active"
                          : "waiting"
                  }
                  key={stage.id}
                >
                  {isFailed ? (
                    <TriangleAlert size={12} />
                  ) : isDone ? (
                    <Check size={12} />
                  ) : (
                    <CircleDashed size={12} />
                  )}
                  <span>{stage.label}</span>
                </div>
              );
            })}
          </div>
          {progress.errors.length > 0 ? (
            <p>{progress.errors.map((error) => error.message).join(" · ")}</p>
          ) : null}
          {progress.status === "degraded" || progress.status === "failed" ? (
            <button
              className="gyro-update-primary"
              onClick={onRetry}
              type="button"
            >
              <RefreshCw size={12} />
              Retry preparation
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function SettingsSidebarContent({
  activeSection,
  onBack,
  onSectionChange,
  onToggleSidebar,
  workspacePreparation,
  isWorkspacePreparationOpen,
  onToggleWorkspacePreparation,
  onCloseWorkspacePreparation,
  onRetryWorkspacePreparation,
  workspacePreparationRef,
}: {
  activeSection: SettingsSectionId;
  onBack: () => void;
  onSectionChange?: (section: SettingsSectionId) => void;
  onToggleSidebar: () => void;
  workspacePreparation?: WorkspacePreparationProgress;
  isWorkspacePreparationOpen: boolean;
  onToggleWorkspacePreparation: () => void;
  onCloseWorkspacePreparation: () => void;
  onRetryWorkspacePreparation?: () => void;
  workspacePreparationRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      <div className="gyro-sidebar-persistent-header is-settings">
        <div
          className="gyro-sidebar-windowbar is-settings"
          aria-label="Settings navigation"
        >
          <div className="gyro-sidebar-window-actions">
            <button
              aria-label="Hide sidebar"
              onClick={onToggleSidebar}
              type="button"
            >
              <PanelLeftClose size={13} />
            </button>
            <button
              aria-label="Back from settings"
              className="gyro-settings-back-button"
              onClick={onBack}
              type="button"
            >
              <ArrowLeft size={13} />
            </button>
          </div>
          <strong className="gyro-settings-sidebar-title">Settings</strong>
          <WorkspacePreparationControl
            controlRef={workspacePreparationRef}
            isOpen={isWorkspacePreparationOpen}
            onClose={onCloseWorkspacePreparation}
            onRetry={onRetryWorkspacePreparation}
            onToggle={onToggleWorkspacePreparation}
            progress={workspacePreparation}
          />
          <div
            aria-hidden="true"
            className="gyro-sidebar-titlebar-drag-region"
            data-tauri-drag-region
          />
        </div>
      </div>

      <div className="gyro-sidebar-actions is-settings-pages">
        {(["Workspace", "System"] as const).map((group) => {
          const items = settingsSidebarItems.filter(
            (item) => item.group === group,
          );
          if (items.length === 0) return null;
          return (
            <div className="gyro-settings-sidebar-group" key={group}>
              <span>{group}</span>
              {items.map(({ id, label, icon: Icon }) => (
                <button
                  aria-current={activeSection === id ? "page" : undefined}
                  className={
                    activeSection === id
                      ? "gyro-sidebar-action is-active is-settings-page"
                      : "gyro-sidebar-action is-settings-page"
                  }
                  key={id}
                  onClick={() => onSectionChange?.(id)}
                  type="button"
                >
                  <Icon size={15} />
                  {label}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

function WorkspaceSidebarContent({
  sessions,
  commandProfiles,
  savedProjects,
  activeSessionId,
  sendingSessionIds,
  activeSession,
  activeDestination,
  activeWorkspaceLayout,
  activePaneTab,
  terminalPanes,
  selectedTerminalPaneId,
  files,
  ide,
  isChatsCollapsed,
  workspacePath,
  pinnedSessionIds,
  openChatSessionIds,
  onSelectSession,
  onAddSessionToGrid,
  onSelectDestination,
  onSelectWorkspaceLayout,
  onOpenToolPanel,
  onCreateSession,
  onCreateCliSession,
  onSelectSessions,
  onOpenWorkspace,
  onOpenWorkspaceFile,
  onPinEditorTab,
  onRefreshWorkspace,
  onCreateWorkspacePath,
  onRenameWorkspacePath,
  onDeleteWorkspacePath,
  onOpenCommandPalette,
  onSelectIdeView,
  onRunWorkspaceSearch,
  onRefreshSourceControl,
  onToggleSourceControlFile,
  onDiscardSourceControlFile,
  onOpenSourceControlDiff,
  onCommitSourceControl,
  onRunIdeTask,
  onStartDebugSession,
  onSendDebugCommand,
  onStopDebugSession,
  onAddTerminalPane,
  onCloseTerminalPane,
  onSelectTerminalPane,
  onDeleteSession,
  onPinSession,
  onRenameSession,
  onRemoveProject,
  onToggleChatsCollapsed,
  onToggleSidebar,
  updateState,
  onUpdateAction,
  workspacePreparation,
  isWorkspacePreparationOpen,
  onToggleWorkspacePreparation,
  onCloseWorkspacePreparation,
  onRetryWorkspacePreparation,
  workspacePreparationRef,
}: {
  sessions: Session[];
  commandProfiles: CommandProfile[];
  savedProjects: Array<{ path: string; label: string }>;
  activeSessionId?: string;
  sendingSessionIds: string[];
  activeSession?: Session;
  activeDestination: AppDestination;
  activeWorkspaceLayout: WorkspaceLayoutId;
  activePaneTab: WorkbenchPaneTab;
  terminalPanes: TerminalPane[];
  selectedTerminalPaneId?: string;
  files: WorkspaceFile[];
  ide?: IdeState;
  isChatsCollapsed: boolean;
  workspacePath?: string;
  pinnedSessionIds: string[];
  openChatSessionIds: string[];
  onSelectSession: (sessionId: string) => void;
  onAddSessionToGrid?: (sessionId: string) => void;
  onSelectDestination: (destination: AppDestination) => void;
  onSelectWorkspaceLayout: (layout: WorkspaceLayoutId) => void;
  onOpenToolPanel: (tab: WorkbenchPaneTab) => void;
  onCreateSession: () => void;
  onCreateCliSession: (profileId: string, workspacePath: string) => void;
  onSelectSessions: () => void;
  onOpenWorkspace: () => void;
  onOpenWorkspaceFile?: (
    path: string,
    lineNumber?: number,
    column?: number,
  ) => void;
  onPinEditorTab?: (path: string) => void;
  onRefreshWorkspace?: () => void;
  onCreateWorkspacePath?: (
    kind: "file" | "directory",
    parentPath?: string,
  ) => void;
  onRenameWorkspacePath?: (path: string) => void;
  onDeleteWorkspacePath?: (path: string) => void;
  onOpenCommandPalette: () => void;
  onSelectIdeView?: (view: IdeViewId) => void;
  onRunWorkspaceSearch?: (query: string) => void;
  onRefreshSourceControl?: () => void;
  onToggleSourceControlFile?: (path: string, staged: boolean) => void;
  onDiscardSourceControlFile?: (path: string) => void;
  onOpenSourceControlDiff?: (path: string, staged: boolean) => void;
  onCommitSourceControl?: (message: string) => void;
  onRunIdeTask?: (task: TaskDefinition) => void;
  onStartDebugSession?: (command: string) => void;
  onSendDebugCommand?: (session: DebugSessionState, command: string) => void;
  onStopDebugSession?: (session: DebugSessionState) => void;
  onAddTerminalPane?: () => void;
  onCloseTerminalPane?: (paneId: string) => void;
  onSelectTerminalPane?: (paneId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onPinSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string) => void;
  onRemoveProject?: (project: { path: string; label: string }) => void;
  onToggleChatsCollapsed?: () => void;
  onToggleSidebar: () => void;
  updateState?: UpdateState;
  onUpdateAction?: (state: UpdateState) => void;
  workspacePreparation?: WorkspacePreparationProgress;
  isWorkspacePreparationOpen: boolean;
  onToggleWorkspacePreparation: () => void;
  onCloseWorkspacePreparation: () => void;
  onRetryWorkspacePreparation?: () => void;
  workspacePreparationRef: RefObject<HTMLDivElement | null>;
}) {
  const pinnedSessions = sessions.filter((session) =>
    pinnedSessionIds.includes(session.id),
  );
  const recentSessions = sessions.filter(
    (session) => !pinnedSessionIds.includes(session.id),
  );
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string>();
  const [draggedSessionId, setDraggedSessionId] = useState<string>();
  const [newSessionMenuView, setNewSessionMenuView] = useState<
    "closed" | "root"
  >("closed");
  const cliProjects = useMemo(() => {
    const selectedProjectPath = terminalPanes.find(
      (pane) => pane.id === selectedTerminalPaneId,
    )?.projectPath;
    const projects = [workspacePath, selectedProjectPath]
      .filter((path): path is string => Boolean(path))
      .map((path) => ({ path, label: projectSidebarName(path) }))
      .concat(savedProjects);
    return projects.filter(
      (project, index) =>
        isUserSelectedWorkspacePath(project.path) &&
        projects.findIndex(
          (candidate) =>
            normalizeSidebarPath(candidate.path) ===
            normalizeSidebarPath(project.path),
        ) === index,
    );
  }, [savedProjects, selectedTerminalPaneId, terminalPanes, workspacePath]);
  const [newCliWorkspacePath, setNewCliWorkspacePath] = useState(
    cliProjects[0]?.path ?? "",
  );
  const newSessionMenuRef = useOutsidePointerDismiss<HTMLDivElement>(
    newSessionMenuView !== "closed",
    () => setNewSessionMenuView("closed"),
  );
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>([]);
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>([]);
  const discoveredSessionNavigation = useMemo(
    () =>
      sidebarProjectGroups(
        recentSessions,
        terminalPanes,
        savedProjects,
        workspacePath,
      ),
    [recentSessions, savedProjects, terminalPanes, workspacePath],
  );
  const discoveredProjectGroups = discoveredSessionNavigation;
  const [projectOrder, setProjectOrder] = useState<string[]>(() =>
    mergeSidebarProjectOrder(
      loadSidebarProjectOrder(),
      discoveredProjectGroups.map((project) => project.key),
    ),
  );
  const [draggedProjectKey, setDraggedProjectKey] = useState<string>();
  const [projectDropTarget, setProjectDropTarget] = useState<{
    key: string;
    position: "before" | "after";
  }>();
  const projectGroups = stableSidebarProjectGroups(
    discoveredProjectGroups,
    projectOrder,
  );
  const [expandedWorkspaceDirectories, setExpandedWorkspaceDirectories] =
    useState<Set<string>>(() => new Set());
  const [selectedExplorerPath, setSelectedExplorerPath] = useState<string>();
  const [sourceControlMessage, setSourceControlMessage] = useState("");
  const [debugAdapterCommand, setDebugAdapterCommand] = useState("lldb-dap");
  const visibleFiles = useMemo(
    () =>
      files.filter((file) =>
        workspaceAncestorPaths(file.path).every((ancestor) =>
          expandedWorkspaceDirectories.has(ancestor),
        ),
      ),
    [expandedWorkspaceDirectories, files],
  );
  const explorerTreeRef = useRef<HTMLDivElement>(null);
  const explorerRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeIdeView = ide?.activeView ?? "explorer";
  const defaultTestTask = ide?.taskDefinitions.find(
    (task) => task.group === "test",
  );
  const [sidebarSearchDraft, setSidebarSearchDraft] = useState(
    ide?.searchQuery.query ?? "",
  );
  useEffect(() => {
    setSidebarSearchDraft(ide?.searchQuery.query ?? "");
  }, [ide?.searchQuery.query]);
  useEffect(() => {
    if (newSessionMenuView === "closed") {
      setNewCliWorkspacePath(cliProjects[0]?.path ?? "");
    }
  }, [cliProjects, newSessionMenuView]);
  useEffect(() => {
    const discoveredKeys = discoveredProjectGroups.map(
      (project) => project.key,
    );
    setProjectOrder((current) => {
      const next = mergeSidebarProjectOrder(current, discoveredKeys);
      return next.length === current.length &&
        next.every((key, index) => key === current[index])
        ? current
        : next;
    });
  }, [discoveredProjectGroups]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_PROJECT_ORDER_STORAGE_KEY,
        JSON.stringify(projectOrder),
      );
    } catch {
      // Project order remains available for the current app session.
    }
  }, [projectOrder]);
  useEffect(() => {
    setExpandedWorkspaceDirectories(new Set());
    setSelectedExplorerPath(
      ide?.activePath && files.some((file) => file.path === ide.activePath)
        ? ide.activePath
        : undefined,
    );
  }, [workspacePath]);
  useEffect(() => {
    if (
      !selectedExplorerPath ||
      files.some((file) => file.path === selectedExplorerPath)
    ) {
      return;
    }
    const hadExplorerFocus = Boolean(
      explorerTreeRef.current?.contains(document.activeElement),
    );
    const fallbackPath = [...workspaceAncestorPaths(selectedExplorerPath)]
      .reverse()
      .find((path) => files.some((file) => file.path === path));
    const nextPath = fallbackPath ?? visibleFiles[0]?.path;
    setSelectedExplorerPath(nextPath);
    if (hadExplorerFocus && nextPath) {
      window.requestAnimationFrame(() =>
        explorerRowRefs.current.get(nextPath)?.focus(),
      );
    }
  }, [files, selectedExplorerPath, visibleFiles]);
  const isSessionsSidebar =
    activeDestination === "workspace" && activeWorkspaceLayout !== "code";
  const isIdeSidebar =
    activeDestination === "workspace" && activeWorkspaceLayout === "code";
  const toggleProject = (projectKey: string) => {
    setCollapsedProjectIds((current) =>
      current.includes(projectKey)
        ? current.filter((id) => id !== projectKey)
        : [...current, projectKey],
    );
  };
  const toggleProjectMore = (projectKey: string) => {
    setExpandedProjectIds((current) =>
      current.includes(projectKey)
        ? current.filter((id) => id !== projectKey)
        : [...current, projectKey],
    );
  };
  const moveProject = (
    sourceKey: string,
    targetKey: string,
    position: "before" | "after",
  ) => {
    if (sourceKey === targetKey) {
      return;
    }
    setProjectOrder((current) => {
      const visibleOrder = stableSidebarProjectGroups(
        discoveredProjectGroups,
        current,
      ).map((project) => project.key);
      const next = visibleOrder.filter((key) => key !== sourceKey);
      const targetIndex = next.indexOf(targetKey);
      if (targetIndex < 0) {
        return current;
      }
      next.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourceKey);
      return next;
    });
  };
  const finishProjectDrag = () => {
    setDraggedProjectKey(undefined);
    setProjectDropTarget(undefined);
  };
  const toggleWorkspaceDirectory = (path: string, collapsed?: boolean) => {
    setExpandedWorkspaceDirectories((current) => {
      const next = new Set(current);
      if (collapsed ?? next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };
  const focusExplorerPath = (path?: string) => {
    if (!path) return;
    setSelectedExplorerPath(path);
    explorerRowRefs.current.get(path)?.focus();
  };
  const handleExplorerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const activePath = (document.activeElement as HTMLElement | null)?.dataset
      .explorerPath;
    const index = visibleFiles.findIndex((file) => file.path === activePath);
    if (index < 0) return;
    const file = visibleFiles[index];
    if (!file) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusExplorerPath(
        visibleFiles[Math.min(index + 1, visibleFiles.length - 1)]?.path,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusExplorerPath(visibleFiles[Math.max(index - 1, 0)]?.path);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusExplorerPath(visibleFiles[0]?.path);
    } else if (event.key === "End") {
      event.preventDefault();
      focusExplorerPath(visibleFiles.at(-1)?.path);
    } else if (event.key === "ArrowRight" && file.kind === "directory") {
      event.preventDefault();
      if (!expandedWorkspaceDirectories.has(file.path)) {
        toggleWorkspaceDirectory(file.path, false);
      } else {
        const child = visibleFiles.find(
          (candidate) =>
            workspaceAncestorPaths(candidate.path).at(-1) === file.path,
        );
        focusExplorerPath(child?.path);
      }
    } else if (event.key === "ArrowLeft") {
      const parentPath = workspaceAncestorPaths(file.path).at(-1);
      if (
        file.kind === "directory" &&
        expandedWorkspaceDirectories.has(file.path)
      ) {
        event.preventDefault();
        toggleWorkspaceDirectory(file.path, true);
      } else if (parentPath) {
        event.preventDefault();
        focusExplorerPath(parentPath);
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedExplorerPath(file.path);
      if (file.kind === "directory") {
        toggleWorkspaceDirectory(file.path);
      } else {
        onOpenWorkspaceFile?.(file.path);
      }
    }
  };
  const renderSessionRow = (session: Session, isNested = false) => (
    <SessionSidebarRow
      isActive={session.id === activeSessionId}
      isSending={sendingSessionIds.includes(session.id)}
      isNested={isNested}
      isMenuOpen={openSessionMenuId === session.id}
      isPinned={pinnedSessionIds.includes(session.id)}
      isOpen={openChatSessionIds.includes(session.id)}
      isDragging={draggedSessionId === session.id}
      key={session.id}
      onDelete={() => {
        onDeleteSession?.(session.id);
        setOpenSessionMenuId(undefined);
      }}
      onMenuClose={() => setOpenSessionMenuId(undefined)}
      onMenuToggle={() =>
        setOpenSessionMenuId((current) =>
          current === session.id ? undefined : session.id,
        )
      }
      onPin={() => onPinSession?.(session.id)}
      onRename={() => {
        onRenameSession?.(session.id);
        setOpenSessionMenuId(undefined);
      }}
      onOpenInGrid={() => {
        onAddSessionToGrid?.(session.id);
        setOpenSessionMenuId(undefined);
      }}
      onSelect={() => {
        onSelectSession(session.id);
        setOpenSessionMenuId(undefined);
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData(
          CHAT_SESSION_DRAG_MIME,
          JSON.stringify({
            sessionId: session.id,
            projectKey: normalizeSidebarPath(session.workspacePath),
          }),
        );
        event.dataTransfer.setData("text/plain", session.id);
        setDraggedSessionId(session.id);
      }}
      onDragEnd={() => setDraggedSessionId(undefined)}
      session={session}
    />
  );
  const renderCliPaneRow = (pane: TerminalPane, isNested = false) => {
    const activity = sidebarTerminalActivity(pane);
    return (
      <SidebarThreadRow
        icon={Terminal}
        indent={isNested}
        isActive={
          activeWorkspaceLayout === "terminal-grid" &&
          pane.id === selectedTerminalPaneId
        }
        key={pane.id}
        label={pane.title}
        meta={sidebarTerminalActivityLabel(activity)}
        onClick={() => onSelectTerminalPane?.(pane.id)}
        onClose={() => onCloseTerminalPane?.(pane.id)}
        state={activity}
      />
    );
  };
  const renderNavigationItem = (item: SidebarSessionItem) =>
    item.kind === "chat"
      ? renderSessionRow(item.session, true)
      : renderCliPaneRow(item.pane, true);

  return (
    <>
      <div className="gyro-sidebar-persistent-header">
        <div className="gyro-sidebar-windowbar" aria-label="Window navigation">
          <div className="gyro-sidebar-window-actions">
            <button
              aria-label="Hide sidebar"
              onClick={onToggleSidebar}
              type="button"
            >
              <PanelLeftClose size={13} />
            </button>
            <button aria-label="Back" disabled type="button">
              <ArrowLeft size={13} />
            </button>
            <button aria-label="Forward" disabled type="button">
              <ArrowRight size={13} />
            </button>
          </div>
          <WorkspacePreparationControl
            controlRef={workspacePreparationRef}
            isOpen={isWorkspacePreparationOpen}
            onClose={onCloseWorkspacePreparation}
            onRetry={onRetryWorkspacePreparation}
            onToggle={onToggleWorkspacePreparation}
            progress={workspacePreparation}
          />
          {updateState ? (
            <div className="gyro-sidebar-update is-windowbar">
              <button
                aria-busy={
                  updateState.status === "downloading" ||
                  updateState.status === "installing"
                }
                aria-label={updateSidebarLabel(updateState)}
                className="gyro-sidebar-update-button"
                data-status={updateState.status}
                disabled={
                  updateState.status === "downloading" ||
                  updateState.status === "installing"
                }
                onClick={() => onUpdateAction?.(updateState)}
                title={updateSidebarLabel(updateState)}
                type="button"
              >
                {updateState.status === "downloading" ? (
                  <span className="gyro-sidebar-update-percent">
                    {updateState.progressPercent ?? 0}%
                  </span>
                ) : updateState.status === "ready" ||
                  updateState.status === "installing" ? (
                  <RefreshCw
                    className={
                      updateState.status === "installing" ? "is-spinning" : ""
                    }
                    size={11}
                  />
                ) : (
                  <Download size={11} />
                )}
              </button>
            </div>
          ) : null}
          <div
            aria-hidden="true"
            className="gyro-sidebar-titlebar-drag-region"
            data-tauri-drag-region
          />
        </div>

        <div
          aria-label="Primary surfaces"
          className="gyro-sidebar-mode-group"
          data-active-mode={isIdeSidebar ? "workspace" : "sessions"}
        >
          <SidebarModeRow
            label="Sessions"
            isActive={
              activeDestination === "workspace" &&
              activeWorkspaceLayout !== "code"
            }
            onClick={onSelectSessions}
          />
          <SidebarModeRow
            label="Workspace"
            isActive={
              activeDestination === "workspace" &&
              activeWorkspaceLayout === "code"
            }
            onClick={() => onSelectWorkspaceLayout("code")}
          />
        </div>
      </div>

      {isIdeSidebar ? (
        <>
          {!workspacePath ? (
            <div className="gyro-sidebar-actions">
              <button
                className="gyro-sidebar-action"
                onClick={onOpenWorkspace}
                type="button"
              >
                <Folder size={15} />
                Open folder
              </button>
            </div>
          ) : null}

          <nav
            className="gyro-ide-sidebar-activity"
            aria-label="Workspace views"
          >
            {[
              { id: "explorer" as const, label: "Explorer", icon: FileText },
              { id: "search" as const, label: "Search", icon: Search },
              {
                id: "source-control" as const,
                label: "Source Control",
                icon: GitPullRequest,
              },
              { id: "run-test" as const, label: "Run/Test", icon: Play },
              { id: "ai" as const, label: "AI", icon: Bot },
              { id: "settings" as const, label: "Settings", icon: Settings },
            ].map((view) => {
              const Icon = view.icon;
              return (
                <button
                  aria-label={view.label}
                  className={activeIdeView === view.id ? "is-active" : ""}
                  disabled={!workspacePath && view.id !== "settings"}
                  key={view.id}
                  onClick={() => onSelectIdeView?.(view.id)}
                  title={
                    !workspacePath && view.id !== "settings"
                      ? `Open a project to use ${view.label}`
                      : view.label
                  }
                  type="button"
                >
                  <Icon size={15} />
                </button>
              );
            })}
          </nav>

          {activeIdeView === "explorer" ? (
            <SidebarSection
              grow
              headerActions={
                workspacePath ? (
                  <div className="gyro-sidebar-explorer-toolbar">
                    <button
                      aria-label="New file"
                      onClick={() => onCreateWorkspacePath?.("file")}
                      title="New file"
                      type="button"
                    >
                      <FileText size={13} />
                      <Plus size={9} />
                    </button>
                    <button
                      aria-label="New folder"
                      onClick={() => onCreateWorkspacePath?.("directory")}
                      title="New folder"
                      type="button"
                    >
                      <Folder size={13} />
                      <Plus size={9} />
                    </button>
                    <button
                      aria-label="Rename selected path"
                      disabled={!selectedExplorerPath && !ide?.activePath}
                      onClick={() =>
                        onRenameWorkspacePath?.(
                          selectedExplorerPath ?? ide?.activePath ?? "",
                        )
                      }
                      title="Rename selected path"
                      type="button"
                    >
                      <Edit3 size={13} />
                    </button>
                    <button
                      aria-label="Delete selected path"
                      disabled={!selectedExplorerPath && !ide?.activePath}
                      onClick={() =>
                        onDeleteWorkspacePath?.(
                          selectedExplorerPath ?? ide?.activePath ?? "",
                        )
                      }
                      title="Delete selected path"
                      type="button"
                    >
                      <Trash2 size={13} />
                    </button>
                    <button
                      aria-label="Refresh workspace files"
                      onClick={onRefreshWorkspace}
                      title="Refresh workspace files"
                      type="button"
                    >
                      <RefreshCw size={13} />
                    </button>
                  </div>
                ) : null
              }
              title="Explorer"
            >
              {workspacePath ? (
                <>
                  <SidebarProjectRow
                    icon={Folder}
                    label={workspaceName(workspacePath)}
                    meta="workspace"
                    onClick={onOpenWorkspace}
                  />
                  {visibleFiles.length > 0 ? (
                    <div
                      aria-label="Workspace files"
                      className="gyro-sidebar-explorer-tree"
                      onKeyDown={handleExplorerKeyDown}
                      ref={explorerTreeRef}
                      role="tree"
                    >
                      {visibleFiles.map((file, index) => {
                        const decoration = ide?.fileDecorations.find(
                          (item) => item.path === file.path,
                        );
                        return (
                          <WorkspaceExplorerRow
                            collapsed={
                              !expandedWorkspaceDirectories.has(file.path)
                            }
                            decoration={decoration}
                            depth={
                              file.depth ?? file.path.split(/[\\/]/).length
                            }
                            bufferStatus={ide?.buffers[file.path]?.status}
                            isActive={
                              selectedExplorerPath === file.path ||
                              (!selectedExplorerPath &&
                                ide?.activePath === file.path)
                            }
                            isOpen={Boolean(
                              ide?.tabs.some((tab) => tab.path === file.path),
                            )}
                            key={file.path}
                            kind={file.kind}
                            label={workspaceName(file.path)}
                            path={file.path}
                            rowRef={(element) => {
                              if (element)
                                explorerRowRefs.current.set(file.path, element);
                              else explorerRowRefs.current.delete(file.path);
                            }}
                            tabIndex={
                              selectedExplorerPath === file.path ||
                              (!selectedExplorerPath && index === 0)
                                ? 0
                                : -1
                            }
                            onClick={() => {
                              setSelectedExplorerPath(file.path);
                              if (file.kind === "file") {
                                onOpenWorkspaceFile?.(file.path);
                                return;
                              }
                              toggleWorkspaceDirectory(file.path);
                            }}
                            onDoubleClick={
                              file.kind === "file"
                                ? () => {
                                    onOpenWorkspaceFile?.(file.path);
                                    onPinEditorTab?.(file.path);
                                  }
                                : undefined
                            }
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <div className="gyro-sidebar-mini-copy">
                      This workspace has no files yet.
                    </div>
                  )}
                </>
              ) : (
                <div className="gyro-sidebar-mini-copy">
                  Open a folder to browse and edit its files.
                </div>
              )}
            </SidebarSection>
          ) : null}

          {activeIdeView === "search" ? (
            <SidebarSection
              grow
              meta={String(ide?.searchResults.length ?? 0)}
              title="Search"
            >
              <form
                className="gyro-sidebar-search-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  onRunWorkspaceSearch?.(sidebarSearchDraft);
                }}
              >
                <Search size={14} />
                <input
                  aria-label="Search workspace"
                  onChange={(event) =>
                    setSidebarSearchDraft(event.target.value)
                  }
                  placeholder="Search files"
                  value={sidebarSearchDraft}
                />
              </form>
              {(ide?.searchResults ?? []).length > 0 ? (
                ide?.searchResults
                  .slice(0, 30)
                  .map((result) => (
                    <SidebarDestinationRow
                      icon={FileCode2}
                      isActive={ide?.activePath === result.path}
                      key={`${result.path}:${result.lineNumber}:${result.line}`}
                      label={workspaceName(result.path)}
                      meta={`:${result.lineNumber}`}
                      onClick={() =>
                        onOpenWorkspaceFile?.(
                          result.path,
                          result.lineNumber,
                          result.ranges?.[0]?.startColumn ?? 1,
                        )
                      }
                    />
                  ))
              ) : (
                <div className="gyro-sidebar-mini-copy">
                  Search uses the local workspace index through rg when it is
                  available.
                </div>
              )}
            </SidebarSection>
          ) : null}

          {activeIdeView === "source-control" ? (
            <SidebarSection grow title="Source Control">
              <div className="gyro-sidebar-scm-group-label">
                <ChevronDown size={13} />
                <span>Repositories</span>
              </div>
              <div className="gyro-sidebar-scm-repository">
                <HardDrive size={13} />
                <strong>{workspaceName(workspacePath)}</strong>
                <span>
                  <GitBranch size={12} />
                  {ide?.sourceControl.branch ?? "No branch"}
                </span>
                <button
                  aria-label="Refresh source control"
                  onClick={onRefreshSourceControl}
                  title="Refresh"
                  type="button"
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              <form
                className="gyro-sidebar-commit-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const message = sourceControlMessage.trim();
                  if (!message) {
                    return;
                  }
                  onCommitSourceControl?.(message);
                  setSourceControlMessage("");
                }}
              >
                <input
                  aria-label="Source control message"
                  onChange={(event) =>
                    setSourceControlMessage(event.target.value)
                  }
                  placeholder="Commit message"
                  value={sourceControlMessage}
                />
                <button
                  disabled={
                    !sourceControlMessage.trim() ||
                    !(ide?.sourceControl.files ?? []).some(
                      (file) => file.staged,
                    )
                  }
                  type="submit"
                >
                  <Check size={13} />
                  Commit
                </button>
              </form>
              <div className="gyro-sidebar-scm-group-label is-changes">
                <ChevronDown size={13} />
                <span>Changes</span>
                <small>{ide?.sourceControl.files.length ?? 0}</small>
              </div>
              {ide?.sourceControl.available === false ? (
                <div className="gyro-sidebar-mini-copy">
                  Git is not ready for this workspace.
                </div>
              ) : null}
              {(ide?.sourceControl.files ?? []).length > 0 ? (
                [...(ide?.sourceControl.files ?? [])]
                  .sort(
                    (first, second) =>
                      Number(second.staged) - Number(first.staged) ||
                      first.path.localeCompare(second.path),
                  )
                  .slice(0, 60)
                  .map((file) => {
                    const parentFolder = workspaceParentFolder(file.path);
                    const stateLabel = file.staged ? "staged" : file.state;
                    const stateDecoration = file.staged
                      ? "S"
                      : file.state === "untracked"
                        ? "U"
                        : file.state === "deleted"
                          ? "D"
                          : file.state === "added"
                            ? "A"
                            : file.state === "renamed"
                              ? "R"
                              : file.state === "conflicted"
                                ? "!"
                                : "M";
                    return (
                      <div
                        className="gyro-sidebar-scm-row"
                        key={`${file.path}:${file.staged}`}
                      >
                        <button
                          aria-label={`Open diff for ${file.path}`}
                          className="gyro-sidebar-scm-identity"
                          onClick={() =>
                            onOpenSourceControlDiff?.(file.path, file.staged)
                          }
                          title={file.path}
                          type="button"
                        >
                          <FileCode2
                            aria-hidden="true"
                            className="gyro-sidebar-scm-file-icon"
                            size={13}
                          />
                          <span className="gyro-sidebar-scm-filename">
                            {workspaceName(file.path)}
                          </span>
                          {parentFolder ? (
                            <small className="gyro-sidebar-scm-directory">
                              {parentFolder}
                            </small>
                          ) : null}
                        </button>
                        <small
                          className="gyro-sidebar-scm-state"
                          title={stateLabel}
                        >
                          {stateDecoration}
                        </small>
                        <button
                          aria-label={`${file.staged ? "Unstage" : "Stage"} ${file.path}`}
                          className="gyro-sidebar-scm-stage"
                          onClick={() =>
                            onToggleSourceControlFile?.(file.path, file.staged)
                          }
                          title={file.staged ? "Unstage" : "Stage"}
                          type="button"
                        >
                          {file.staged ? (
                            <Minus size={13} />
                          ) : (
                            <Plus size={13} />
                          )}
                        </button>
                        <button
                          aria-label={`Discard changes in ${file.path}`}
                          className="gyro-sidebar-scm-discard"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Discard all local changes in ${file.path}? This cannot be undone.`,
                              )
                            ) {
                              onDiscardSourceControlFile?.(file.path);
                            }
                          }}
                          title="Discard changes"
                          type="button"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    );
                  })
              ) : (
                <div className="gyro-sidebar-mini-copy">
                  No local Git changes detected.
                </div>
              )}
            </SidebarSection>
          ) : null}

          {activeIdeView === "run-test" ? (
            <SidebarSection
              grow
              meta={String(ide?.taskDefinitions.length ?? 0)}
              title="Run and Test"
            >
              <form
                className="gyro-sidebar-debug-launch"
                onSubmit={(event) => {
                  event.preventDefault();
                  const command = debugAdapterCommand.trim();
                  if (command) {
                    onStartDebugSession?.(command);
                  }
                }}
              >
                <input
                  aria-label="Debug adapter command"
                  onChange={(event) =>
                    setDebugAdapterCommand(event.target.value)
                  }
                  placeholder="lldb-dap or debugpy-adapter"
                  value={debugAdapterCommand}
                />
                <button
                  disabled={!debugAdapterCommand.trim()}
                  title="Initialize local debug adapter"
                  type="submit"
                >
                  <Play size={13} />
                  Start
                </button>
              </form>
              <div className="gyro-sidebar-mini-copy">
                Gyro uses adapters already installed on this device and never
                installs one automatically.
              </div>
              {(ide?.debugSessions ?? []).map((session) => (
                <div className="gyro-sidebar-debug-session" key={session.id}>
                  <div>
                    <span>{session.name}</span>
                    <small>{session.status}</small>
                  </div>
                  <div className="gyro-sidebar-debug-controls">
                    <button
                      aria-label={`Refresh ${session.name}`}
                      disabled={
                        session.status === "stopped" ||
                        session.status === "failed"
                      }
                      onClick={() => onSendDebugCommand?.(session, "threads")}
                      title="Refresh threads"
                      type="button"
                    >
                      <RefreshCw size={12} />
                    </button>
                    <button
                      aria-label={`Continue ${session.name}`}
                      disabled={
                        session.status === "stopped" ||
                        session.status === "failed"
                      }
                      onClick={() => onSendDebugCommand?.(session, "continue")}
                      title="Continue"
                      type="button"
                    >
                      <Play size={12} />
                    </button>
                    <button
                      aria-label={`Pause ${session.name}`}
                      disabled={
                        session.status === "stopped" ||
                        session.status === "failed"
                      }
                      onClick={() => onSendDebugCommand?.(session, "pause")}
                      title="Pause"
                      type="button"
                    >
                      <PauseCircle size={12} />
                    </button>
                    <button
                      aria-label={`Step over ${session.name}`}
                      disabled={
                        session.status === "stopped" ||
                        session.status === "failed"
                      }
                      onClick={() => onSendDebugCommand?.(session, "next")}
                      title="Step over"
                      type="button"
                    >
                      <ArrowRight size={12} />
                    </button>
                    <button
                      aria-label={`Stop ${session.name}`}
                      disabled={session.status === "stopped"}
                      onClick={() => onStopDebugSession?.(session)}
                      title="Stop"
                      type="button"
                    >
                      <Square size={11} />
                    </button>
                  </div>
                  {session.message ? <p>{session.message}</p> : null}
                </div>
              ))}
              {(ide?.taskDefinitions ?? []).length > 0 ? (
                ide?.taskDefinitions
                  .slice(0, 24)
                  .map((task) => (
                    <SidebarDestinationRow
                      icon={task.group === "test" ? ListChecks : Play}
                      isActive={task.status === "running"}
                      key={task.id}
                      label={task.label}
                      meta={task.group}
                      onClick={() => onRunIdeTask?.(task)}
                    />
                  ))
              ) : (
                <div className="gyro-sidebar-mini-copy">
                  Tasks appear from package scripts and Cargo manifests.
                </div>
              )}
              {(ide?.testTree?.[0]?.children ?? []).slice(0, 8).map((test) => (
                <SidebarDestinationRow
                  icon={ListChecks}
                  isActive={test.status === "running"}
                  key={test.id}
                  label={test.label}
                  meta={test.status}
                  onClick={() => {
                    if (test.path) {
                      onOpenWorkspaceFile?.(test.path);
                      return;
                    }
                    const matchingTask = ide?.taskDefinitions.find(
                      (task) => task.id === test.id,
                    );
                    const task = matchingTask ?? defaultTestTask;
                    if (task) {
                      onRunIdeTask?.(task);
                    }
                  }}
                />
              ))}
            </SidebarSection>
          ) : null}

          {activeIdeView === "ai" ? (
            <SidebarSection
              grow
              meta={String(ide?.aiToolCalls.length ?? 0)}
              title="AI"
            >
              <div className="gyro-sidebar-mini-copy">
                Editor AI can read selected code, open tabs, diffs, terminal
                snapshots, and browser state. File edits still route through
                visible diff approval.
              </div>
              {ide?.lastAssistantRequest ? (
                <SidebarDestinationRow
                  icon={Bot}
                  isActive
                  label={ide.lastAssistantRequest.action.replaceAll("-", " ")}
                  meta={ide.lastAssistantRequest.path ?? "workspace"}
                  onClick={() => onOpenToolPanel("diff")}
                />
              ) : null}
              {(ide?.aiToolCalls ?? []).slice(0, 10).map((toolCall) => (
                <SidebarDestinationRow
                  icon={Sparkles}
                  isActive={toolCall.status === "running"}
                  key={toolCall.id}
                  label={toolCall.name}
                  meta={toolCall.status}
                  onClick={() => onOpenToolPanel("output")}
                />
              ))}
            </SidebarSection>
          ) : null}

          {activeIdeView === "settings" ? (
            <SidebarSection
              grow
              meta={String(ide?.contributions.length ?? 0)}
              title="Workspace Settings"
            >
              {(ide?.languageServers ?? []).map((server) => (
                <SidebarDestinationRow
                  icon={Activity}
                  isActive={server.status === "ready"}
                  key={server.id}
                  label={server.languageId}
                  meta={server.status}
                  onClick={() => onOpenToolPanel("output")}
                  title={server.message}
                />
              ))}
              {(ide?.contributions ?? []).flatMap((contribution) =>
                contribution.commands
                  .slice(0, 8)
                  .map((command) => (
                    <SidebarDestinationRow
                      icon={Settings}
                      isActive={false}
                      key={command.id}
                      label={command.label}
                      meta={command.category}
                      onClick={() =>
                        command.viewId
                          ? onSelectIdeView?.(command.viewId)
                          : onOpenCommandPalette()
                      }
                    />
                  )),
              )}
              <div className="gyro-sidebar-mini-copy">
                Language servers, debug adapters, Git, and provider CLIs are
                detected locally. Gyro does not auto-install them.
              </div>
            </SidebarSection>
          ) : null}

          {workspacePath ? (
            <nav className="gyro-ide-panel-shortcuts" aria-label="Code tools">
              {paneTabs.map(({ id, label, icon: Icon }) => (
                <button
                  aria-label={label}
                  aria-pressed={activePaneTab === id}
                  className={activePaneTab === id ? "is-active" : ""}
                  key={id}
                  onClick={() => onOpenToolPanel(id)}
                  title={
                    id === "diff"
                      ? "Diff review"
                      : id === "browser"
                        ? "Browser preview"
                        : label
                  }
                  type="button"
                >
                  <Icon size={14} />
                </button>
              ))}
            </nav>
          ) : null}
        </>
      ) : null}

      {isSessionsSidebar ? (
        <>
          <div className="gyro-sidebar-actions">
            <div className="gyro-sidebar-new-session" ref={newSessionMenuRef}>
              <button
                aria-expanded={newSessionMenuView !== "closed"}
                aria-haspopup="menu"
                className="gyro-sidebar-action"
                onClick={() =>
                  setNewSessionMenuView((current) =>
                    current === "closed" ? "root" : "closed",
                  )
                }
                type="button"
              >
                <Plus size={15} />
                New
              </button>
              {newSessionMenuView !== "closed" ? (
                <div
                  aria-label="Create Chat or CLI session"
                  className="gyro-sidebar-new-session-menu is-root"
                  role="menu"
                >
                  <button
                    aria-label="New Chat"
                    onClick={() => {
                      setNewSessionMenuView("closed");
                      onCreateSession();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <MessageSquare size={15} />
                    <strong>New Chat</strong>
                  </button>
                  <div className="gyro-sidebar-new-session-divider" />
                  <label className="gyro-sidebar-cli-location">
                    <span>CLI</span>
                    <select
                      aria-label="CLI session location"
                      onChange={(event) =>
                        setNewCliWorkspacePath(event.target.value)
                      }
                      value={newCliWorkspacePath}
                    >
                      {cliProjects.length === 0 ? (
                        <option value="">Open a project first</option>
                      ) : null}
                      {cliProjects.map((project) => (
                        <option key={project.path} value={project.path}>
                          {project.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {cliProjects.length === 0 ? (
                    <button
                      onClick={() => {
                        setNewSessionMenuView("closed");
                        onOpenWorkspace();
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <Folder size={15} />
                      <span>
                        <strong>Open project</strong>
                        <small>Choose where the CLI should run</small>
                      </span>
                    </button>
                  ) : null}
                  <div className="gyro-sidebar-cli-profiles">
                    {commandProfiles.map((profile) => (
                      <button
                        disabled={
                          profile.readiness === "blocked" ||
                          !newCliWorkspacePath
                        }
                        key={profile.id}
                        onClick={() => {
                          if (!newCliWorkspacePath) return;
                          onCreateCliSession(profile.id, newCliWorkspacePath);
                          setNewSessionMenuView("closed");
                        }}
                        role="menuitem"
                        type="button"
                      >
                        {profile.providerId ? (
                          <Bot size={15} />
                        ) : (
                          <Terminal size={15} />
                        )}
                        <span>
                          <strong>{profile.displayName}</strong>
                          {profile.readiness === "blocked" ? (
                            <small>Setup required</small>
                          ) : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <button
              className="gyro-sidebar-action"
              onClick={onOpenCommandPalette}
              type="button"
            >
              <Search size={15} />
              <span>Search</span>
              <kbd className="gyro-sidebar-shortcut">
                {primaryGlobalSearchShortcut()}
              </kbd>
            </button>
          </div>

          <div className="gyro-sidebar-project-chat-list">
            {pinnedSessions.length > 0 ? (
              <>
                <div className="gyro-sidebar-small-title">Pinned</div>
                {pinnedSessions.map((session) => renderSessionRow(session))}
              </>
            ) : null}
            <div className="gyro-sidebar-small-title">Projects</div>
            {projectGroups.map((project, projectIndex) => {
              const isCollapsed = collapsedProjectIds.includes(project.key);
              const isExpanded = expandedProjectIds.includes(project.key);
              const collapsedProjectSessions = project.items.slice(0, 3);
              const activeProjectSession = project.items.find((item) =>
                item.kind === "chat"
                  ? item.session.id === activeSessionId
                  : item.pane.id === selectedTerminalPaneId,
              );
              const visibleProjectSessions = isExpanded
                ? project.items
                : activeProjectSession &&
                    !collapsedProjectSessions.includes(activeProjectSession)
                  ? [
                      ...collapsedProjectSessions.slice(0, 2),
                      activeProjectSession,
                    ]
                  : collapsedProjectSessions;
              const hiddenCount =
                project.items.length - visibleProjectSessions.length;
              return (
                <div
                  className={[
                    "gyro-sidebar-project-group",
                    draggedProjectKey === project.key ? "is-dragging" : "",
                    projectDropTarget?.key === project.key
                      ? `is-drop-${projectDropTarget.position}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={project.key}
                  onDragOver={(event) => {
                    if (
                      !draggedProjectKey ||
                      draggedProjectKey === project.key
                    ) {
                      return;
                    }
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const rect =
                      event.currentTarget
                        .querySelector<HTMLElement>(".gyro-sidebar-project-row")
                        ?.getBoundingClientRect() ??
                      event.currentTarget.getBoundingClientRect();
                    setProjectDropTarget({
                      key: project.key,
                      position:
                        event.clientY < rect.top + rect.height / 2
                          ? "before"
                          : "after",
                    });
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceKey =
                      event.dataTransfer.getData("text/plain") ||
                      draggedProjectKey;
                    if (sourceKey && projectDropTarget) {
                      moveProject(
                        sourceKey,
                        project.key,
                        projectDropTarget.position,
                      );
                    }
                    finishProjectDrag();
                  }}
                >
                  <SidebarProjectRow
                    draggable
                    icon={project.hasWorkspace ? FileText : HardDrive}
                    isDragging={draggedProjectKey === project.key}
                    isCollapsed={isCollapsed}
                    label={project.label}
                    onDragEnd={finishProjectDrag}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", project.key);
                      setDraggedProjectKey(project.key);
                    }}
                    onKeyDown={(event) => {
                      if (!event.altKey) {
                        return;
                      }
                      if (event.key === "ArrowUp" && projectIndex > 0) {
                        event.preventDefault();
                        const previous = projectGroups[projectIndex - 1];
                        if (previous) {
                          moveProject(project.key, previous.key, "before");
                        }
                      } else if (
                        event.key === "ArrowDown" &&
                        projectIndex < projectGroups.length - 1
                      ) {
                        event.preventDefault();
                        const next = projectGroups[projectIndex + 1];
                        if (next) {
                          moveProject(project.key, next.key, "after");
                        }
                      }
                    }}
                    onClick={() => toggleProject(project.key)}
                    onRemove={
                      project.hasWorkspace
                        ? () =>
                            onRemoveProject?.({
                              path: project.key,
                              label: project.label,
                            })
                        : undefined
                    }
                  />
                  {!isCollapsed ? (
                    <>
                      {visibleProjectSessions.length > 0 ? (
                        visibleProjectSessions.map(renderNavigationItem)
                      ) : (
                        <button
                          className="gyro-sidebar-thread is-empty"
                          onClick={onCreateSession}
                          type="button"
                        >
                          <span>No recent sessions</span>
                        </button>
                      )}
                      {hiddenCount > 0 || isExpanded ? (
                        <button
                          className="gyro-sidebar-more-button"
                          onClick={() => toggleProjectMore(project.key)}
                          type="button"
                        >
                          {isExpanded ? "less" : "more"}
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </>
  );
}

function SidebarSection({
  title,
  grow,
  collapsible,
  isCollapsed,
  meta,
  headerActions,
  onToggle,
  children,
}: {
  title: string;
  grow?: boolean;
  collapsible?: boolean;
  isCollapsed?: boolean;
  meta?: string;
  headerActions?: ReactNode;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const listId = useId();
  const sectionClassName = [
    "gyro-sidebar-section",
    grow ? "is-grow" : "",
    collapsible ? "is-collapsible" : "",
    isCollapsed ? "is-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const expanded = !isCollapsed;

  return (
    <section className={sectionClassName}>
      {collapsible ? (
        <button
          aria-controls={listId}
          aria-expanded={expanded}
          className="gyro-sidebar-section-toggle"
          onClick={onToggle}
          type="button"
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>{title}</span>
          {meta ? <small>{meta}</small> : null}
        </button>
      ) : headerActions ? (
        <div className="gyro-sidebar-section-heading">
          <div className="gyro-nav-label">{title}</div>
          {headerActions}
        </div>
      ) : (
        <div className="gyro-nav-label">{title}</div>
      )}
      <div className="gyro-sidebar-list" hidden={isCollapsed} id={listId}>
        {children}
      </div>
    </section>
  );
}

function SidebarStaticRow({
  icon: Icon,
  label,
  meta,
}: {
  icon: IconComponent;
  label: string;
  meta?: string;
}) {
  return (
    <div className="gyro-sidebar-row">
      <Icon size={15} />
      <span>{label}</span>
      {meta ? <small>{meta}</small> : null}
    </div>
  );
}

function SidebarProjectRow({
  draggable = false,
  icon: Icon,
  isDragging,
  isCollapsed,
  label,
  meta,
  onClick,
  onDragEnd,
  onDragStart,
  onKeyDown,
  onRemove,
}: {
  draggable?: boolean;
  icon: IconComponent;
  isDragging?: boolean;
  isCollapsed?: boolean;
  label: string;
  meta?: string;
  onClick: () => void;
  onDragEnd?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragStart?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onRemove?: () => void;
}) {
  return (
    <div
      aria-grabbed={draggable ? Boolean(isDragging) : undefined}
      className={[
        "gyro-sidebar-project-row",
        draggable ? "is-draggable" : "",
        isDragging ? "is-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={draggable}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
      onKeyDown={onKeyDown}
      title={
        draggable
          ? "Drag to reorder. Alt+Arrow keys also move this project."
          : undefined
      }
    >
      <button
        aria-expanded={isCollapsed === undefined ? undefined : !isCollapsed}
        className="gyro-sidebar-project-toggle"
        onClick={onClick}
        type="button"
      >
        <Icon size={15} />
        <span>{label}</span>
        {isCollapsed === undefined ? (
          meta ? (
            <small>{meta}</small>
          ) : null
        ) : isCollapsed ? (
          <ChevronRight className="gyro-sidebar-collapse-icon" size={13} />
        ) : (
          <ChevronDown className="gyro-sidebar-collapse-icon" size={13} />
        )}
      </button>
      {onRemove ? (
        <button
          aria-label={`Remove ${label} from Gyro app`}
          className="gyro-sidebar-project-remove"
          onClick={onRemove}
          title="Remove from Gyro app"
          type="button"
        >
          <Trash2 size={13} />
        </button>
      ) : null}
    </div>
  );
}

function SessionSidebarRow({
  session,
  isActive,
  isSending,
  isNested,
  isPinned,
  isOpen,
  isDragging,
  isMenuOpen,
  onSelect,
  onPin,
  onMenuToggle,
  onMenuClose,
  onRename,
  onOpenInGrid,
  onDelete,
  onDragStart,
  onDragEnd,
}: {
  session: Session;
  isActive: boolean;
  isSending: boolean;
  isNested?: boolean;
  isPinned: boolean;
  isOpen?: boolean;
  isDragging?: boolean;
  isMenuOpen: boolean;
  onSelect: () => void;
  onPin: () => void;
  onMenuToggle: () => void;
  onMenuClose: () => void;
  onRename: () => void;
  onOpenInGrid?: () => void;
  onDelete: () => void;
  onDragStart?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd?: (event: ReactDragEvent<HTMLDivElement>) => void;
}) {
  const menuRef = useOutsidePointerDismiss<HTMLDivElement>(
    isMenuOpen,
    onMenuClose,
  );
  const sessionProviderId = providerIdForSession(session);
  const modelTitle =
    session.modelLabel ??
    session.modelId ??
    session.providerLabel ??
    session.providerId ??
    "No model saved";

  return (
    <div
      className={[
        "gyro-session-row",
        isActive ? "is-active" : "",
        isSending ? "is-sending" : "",
        isNested ? "is-nested" : "",
        isPinned ? "is-pinned" : "",
        isOpen ? "is-open" : "",
        isDragging ? "is-dragging" : "",
        isMenuOpen ? "is-menu-open" : "",
      ].join(" ")}
      aria-grabbed={onDragStart ? Boolean(isDragging) : undefined}
      draggable={Boolean(onDragStart)}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
      ref={menuRef}
    >
      <button
        aria-label={
          session.summary
            ? `${session.title}. ${session.summary}`
            : session.title
        }
        className={
          sessionProviderId
            ? "gyro-sidebar-thread-main has-model-logo"
            : "gyro-sidebar-thread-main"
        }
        onClick={onSelect}
        title={session.summary ?? session.title}
        type="button"
      >
        {sessionProviderId ? (
          <span className="gyro-sidebar-model-logo" title={modelTitle}>
            <ProviderLogo providerId={sessionProviderId} />
          </span>
        ) : null}
        <span>{session.title}</span>
        <small
          aria-label={isSending ? "Chat working" : undefined}
          className={
            isSending ? "gyro-session-time is-working" : "gyro-session-time"
          }
          title={isSending ? "Chat working in the background" : undefined}
        >
          {isSending ? (
            <CircleDashed aria-hidden="true" size={13} />
          ) : (
            relativeSessionTime(session.updatedAt)
          )}
        </small>
      </button>
      <div className="gyro-session-actions" aria-label="Chat actions">
        <button
          aria-label={isPinned ? "Unpin chat" : "Pin chat"}
          aria-pressed={isPinned}
          className={
            isPinned ? "gyro-session-action is-pinned" : "gyro-session-action"
          }
          onClick={onPin}
          title={isPinned ? "Unpin" : "Pin"}
          type="button"
        >
          <Pin fill={isPinned ? "currentColor" : "none"} size={13} />
        </button>
        <button
          aria-expanded={isMenuOpen}
          aria-label="Chat options"
          className="gyro-session-action is-more"
          onClick={onMenuToggle}
          title="More"
          type="button"
        >
          <MoreHorizontal size={15} />
        </button>
      </div>
      {isMenuOpen ? (
        <div className="gyro-session-menu" role="menu">
          {onOpenInGrid ? (
            <button onClick={onOpenInGrid} role="menuitem" type="button">
              Open in chat grid
            </button>
          ) : null}
          <button onClick={onRename} role="menuitem" type="button">
            Rename
          </button>
          <button
            className="is-danger"
            onClick={onDelete}
            role="menuitem"
            type="button"
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

function providerIdForSession(session: Session): ProviderId | undefined {
  return session.providerId === "openai" ||
    session.providerId === "anthropic" ||
    session.providerId === "xai" ||
    session.providerId === "gemini"
    ? session.providerId
    : undefined;
}

type SidebarSessionItem =
  { kind: "chat"; session: Session } | { kind: "cli"; pane: TerminalPane };

type SidebarProjectGroupData = {
  hasWorkspace: boolean;
  key: string;
  label: string;
  items: SidebarSessionItem[];
};

const SIDEBAR_PROJECT_ORDER_STORAGE_KEY = "gyro.sidebar-project-order-v1";

function sidebarProjectGroups(
  sessions: Session[],
  terminalPanes: TerminalPane[],
  savedProjects: Array<{ path: string; label: string }>,
  workspacePath?: string,
): SidebarProjectGroupData[] {
  const groups = new Map<string, SidebarProjectGroupData>();
  const primaryGyroProjectPath = [
    workspacePath,
    ...savedProjects.map((project) => project.path),
  ]
    .map(normalizeSidebarPath)
    .find(
      (path) =>
        isUserSelectedWorkspacePath(path) &&
        projectSidebarName(path) === "Gyro",
    );
  const groupKeyForPath = (path?: string) =>
    projectGroupKey(path, primaryGyroProjectPath);
  const currentProjectKey = groupKeyForPath(workspacePath);
  const fallbackProject = [
    workspacePath
      ? { path: workspacePath, label: projectSidebarName(workspacePath) }
      : undefined,
    ...savedProjects,
  ].find((project): project is { path: string; label: string } =>
    Boolean(project && isUserSelectedWorkspacePath(project.path)),
  );

  for (const session of sessions) {
    const key = groupKeyForPath(session.workspacePath);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push({ kind: "chat", session });
    } else {
      groups.set(key, {
        hasWorkspace: key !== "gyro" && isUserSelectedWorkspacePath(key),
        key,
        label: projectSidebarName(session.workspacePath),
        items: [{ kind: "chat", session }],
      });
    }
  }

  const projectPaths = savedProjects
    .map((project) => ({
      ...project,
      normalizedPath: normalizeSidebarPath(project.path),
    }))
    .filter((project) => project.normalizedPath)
    .sort(
      (first, second) =>
        second.normalizedPath.length - first.normalizedPath.length,
    );
  for (const pane of terminalPanes) {
    const panePath = normalizeSidebarPath(
      pane.projectPath ?? pane.workingDirectory,
    );
    const project = projectPaths.find(
      (candidate) =>
        panePath === candidate.normalizedPath ||
        panePath.startsWith(`${candidate.normalizedPath}/`),
    );
    const linkedProject = project ?? fallbackProject;
    const linkedPath = linkedProject?.path;
    const key = groupKeyForPath(linkedPath);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push({ kind: "cli", pane });
    } else {
      groups.set(key, {
        hasWorkspace: Boolean(
          linkedPath && isUserSelectedWorkspacePath(linkedPath),
        ),
        key,
        label: linkedProject?.label ?? projectSidebarName(linkedPath),
        items: [{ kind: "cli", pane }],
      });
    }
  }

  if (workspacePath && !groups.has(currentProjectKey)) {
    groups.set(currentProjectKey, {
      hasWorkspace: true,
      key: currentProjectKey,
      label: projectSidebarName(workspacePath),
      items: [],
    });
  }

  for (const group of groups.values()) {
    group.items.sort(
      (first, second) =>
        sidebarSessionTimestamp(second) - sidebarSessionTimestamp(first),
    );
  }
  return [...groups.values()];
}

function sidebarSessionTimestamp(item: SidebarSessionItem) {
  const value =
    item.kind === "chat" ? item.session.updatedAt : item.pane.createdAt;
  return new Date(value).getTime() || 0;
}

function normalizeSidebarPath(path?: string) {
  return path?.trim().replaceAll("\\", "/").replace(/\/+$/, "") ?? "";
}

function stableSidebarProjectGroups(
  groups: SidebarProjectGroupData[],
  projectOrder: string[],
) {
  const order = new Map(projectOrder.map((key, index) => [key, index]));
  return groups
    .map((group, discoveredIndex) => ({ group, discoveredIndex }))
    .sort(
      (first, second) =>
        (order.get(first.group.key) ??
          projectOrder.length + first.discoveredIndex) -
        (order.get(second.group.key) ??
          projectOrder.length + second.discoveredIndex),
    )
    .map(({ group }) => group);
}

function loadSidebarProjectOrder() {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const value = window.localStorage.getItem(
      SIDEBAR_PROJECT_ORDER_STORAGE_KEY,
    );
    const parsed: unknown = value ? JSON.parse(value) : [];
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

function mergeSidebarProjectOrder(current: string[], discovered: string[]) {
  const discoveredSet = new Set(discovered);
  return [
    ...current.filter((key) => discoveredSet.has(key)),
    ...discovered.filter((key) => !current.includes(key)),
  ];
}

function projectGroupKey(path?: string, primaryGyroProjectPath?: string) {
  const normalizedPath = normalizeSidebarPath(path);
  if (projectSidebarName(normalizedPath) === "Gyro") {
    return primaryGyroProjectPath || "gyro";
  }
  return normalizedPath || "gyro";
}

function SidebarThreadRow({
  icon: Icon,
  label,
  meta,
  indent,
  isActive,
  onClick,
  onClose,
  state,
}: {
  icon?: IconComponent;
  label: string;
  meta: string;
  indent?: boolean;
  isActive?: boolean;
  onClick: () => void;
  onClose?: () => void;
  state?: SidebarTerminalActivity;
}) {
  return (
    <div className="gyro-sidebar-terminal-row">
      <button
        className={[
          "gyro-sidebar-thread",
          Icon ? "has-icon" : "",
          indent ? "is-indent" : "",
          isActive ? "is-active" : "",
        ].join(" ")}
        data-state={state}
        onClick={onClick}
        title={`${label} · ${meta}`}
        type="button"
      >
        {Icon ? (
          <span className="gyro-sidebar-terminal-icon" aria-hidden="true">
            <Icon size={13} />
          </span>
        ) : null}
        <span className="gyro-sidebar-terminal-label">{label}</span>
        <small className="gyro-sidebar-terminal-state">
          <i aria-hidden="true" />
          {meta}
        </small>
      </button>
      {onClose ? (
        <button
          aria-label={`Close ${label}`}
          className="gyro-sidebar-terminal-close"
          onClick={onClose}
          title={`Close ${label}`}
          type="button"
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

type SidebarTerminalActivity =
  "checking" | "idle" | "running" | "waiting" | "done" | "failed" | "offline";

function sidebarTerminalActivity(pane: TerminalPane): SidebarTerminalActivity {
  if (pane.status === "waiting") {
    return "waiting";
  }
  if (pane.status === "done") {
    return "done";
  }
  if (pane.status === "failed") {
    return "failed";
  }
  if (pane.status === "restored") {
    return "offline";
  }
  if (!isInteractiveShellPane(pane)) {
    return "running";
  }
  if (pane.hasForegroundJob === undefined) {
    return "checking";
  }
  return pane.hasForegroundJob ? "running" : "idle";
}

function sidebarTerminalActivityLabel(activity: SidebarTerminalActivity) {
  switch (activity) {
    case "checking":
      return "Checking";
    case "idle":
      return "Idle";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "done":
      return "Exited";
    case "failed":
      return "Failed";
    case "offline":
      return "Offline";
  }
}

function isInteractiveShellPane(pane: TerminalPane) {
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

function terminalPaneHasActiveWork(pane: TerminalPane) {
  if (pane.status === "waiting") {
    return true;
  }
  if (pane.status !== "running") {
    return false;
  }
  return !isInteractiveShellPane(pane) || pane.hasForegroundJob !== false;
}

function SidebarDestinationRow({
  icon: Icon,
  label,
  meta,
  isActive,
  onClick,
  title,
}: {
  icon: IconComponent;
  label: string;
  meta?: string;
  isActive?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      className={isActive ? "gyro-sidebar-row is-active" : "gyro-sidebar-row"}
      onClick={onClick}
      title={title}
      type="button"
    >
      <Icon size={15} />
      <span>{label}</span>
      {meta ? <small>{meta}</small> : null}
    </button>
  );
}

function WorkspaceExplorerRow({
  label,
  decoration,
  bufferStatus,
  kind,
  depth,
  collapsed,
  isActive,
  isOpen,
  path,
  rowRef,
  tabIndex,
  onClick,
  onDoubleClick,
}: {
  label: string;
  decoration?: IdeState["fileDecorations"][number];
  bufferStatus?: EditorBuffer["status"];
  kind: WorkspaceFile["kind"];
  depth: number;
  collapsed: boolean;
  isActive: boolean;
  isOpen: boolean;
  path: string;
  rowRef: (element: HTMLButtonElement | null) => void;
  tabIndex: number;
  onClick: () => void;
  onDoubleClick?: () => void;
}) {
  const extension =
    kind === "file" ? label.split(".").pop()?.toLowerCase() : undefined;
  const fileTone = workspaceFileTone(extension);

  return (
    <button
      aria-expanded={kind === "directory" ? !collapsed : undefined}
      aria-label={`${kind === "directory" ? "Folder" : "File"} ${path}${decoration?.tooltip ? `, ${decoration.tooltip}` : ""}${bufferStatus === "dirty" ? ", unsaved changes" : ""}`}
      aria-level={Math.max(1, depth)}
      aria-selected={isActive}
      className={
        isActive
          ? "gyro-sidebar-row gyro-sidebar-explorer-row is-active"
          : "gyro-sidebar-row gyro-sidebar-explorer-row"
      }
      data-buffer-state={bufferStatus}
      data-explorer-path={path}
      data-file-state={decoration?.color}
      data-file-tone={fileTone}
      data-open={isOpen || undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      ref={rowRef}
      role="treeitem"
      style={{ paddingLeft: `${Math.max(8, Math.min(depth, 8) * 11)}px` }}
      tabIndex={tabIndex}
      title={`${path}${decoration?.tooltip ? ` · ${decoration.tooltip}` : ""}`}
      type="button"
    >
      {kind === "directory" ? (
        <ChevronRight className="gyro-explorer-chevron" size={13} />
      ) : (
        <FileCode2 className="gyro-explorer-file-icon" size={13} />
      )}
      <span>{label}</span>
      {decoration?.badge ? (
        <small className="gyro-explorer-decoration">{decoration.badge}</small>
      ) : null}
    </button>
  );
}

function workspaceFileTone(extension?: string) {
  if (!extension) return "default";
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) return "javascript";
  if (["ts", "tsx"].includes(extension)) return "typescript";
  if (["json", "jsonc"].includes(extension)) return "json";
  if (["css", "scss", "sass", "less"].includes(extension)) return "style";
  if (["md", "mdx", "txt"].includes(extension)) return "document";
  if (["rs", "toml"].includes(extension)) return "rust";
  if (["sh", "zsh", "bash", "fish"].includes(extension)) return "shell";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(extension)) {
    return "image";
  }
  return "default";
}

function SidebarModeRow({
  label,
  isActive,
  onClick,
}: {
  label: string;
  isActive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={
        isActive ? "gyro-sidebar-mode-row is-active" : "gyro-sidebar-mode-row"
      }
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
    </button>
  );
}

type WorkspaceHeaderProps = {
  title: string;
  subtitle: string;
  workspacePath?: string;
  onOpenWorkspace: () => void;
  onCreateSession: () => void;
  onMoreActions?: () => void;
  activityLabel?: string;
  statusItems?: TopbarStatusItem[];
  workspaceMode?: WorkbenchMode;
  onWorkspaceModeChange?: (mode: WorkbenchMode) => void;
  showWorkspaceActions?: boolean;
};

type TopbarStatusItem = {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
};

export function WorkspaceHeader({
  title,
  subtitle,
  workspacePath,
  onOpenWorkspace,
  onCreateSession,
  onMoreActions,
  activityLabel = "approval waiting",
  statusItems,
  workspaceMode,
  onWorkspaceModeChange,
  showWorkspaceActions = true,
}: WorkspaceHeaderProps) {
  const visibleStatusItems =
    statusItems && statusItems.length > 0
      ? statusItems
      : [{ label: "Activity", value: activityLabel, tone: "warning" as const }];

  return (
    <header className="gyro-topbar" data-tauri-drag-region>
      <div className="gyro-title-stack" data-tauri-drag-region>
        <div className="gyro-surface-title" data-tauri-drag-region>
          <span>{title}</span>
          <button
            aria-label="More title actions"
            className="gyro-title-more"
            onClick={onMoreActions}
            title="More"
            type="button"
          >
            <MoreHorizontal size={17} />
          </button>
        </div>
        <div className="gyro-workspace-path" data-tauri-drag-region>
          {workspacePath ?? subtitle}
        </div>
      </div>
      {showWorkspaceActions ? (
        <div className="gyro-toolbar-actions">
          {workspaceMode && onWorkspaceModeChange ? (
            <div className="gyro-mode-toggle" aria-label="Session mode">
              {(["local", "worktree"] as WorkbenchMode[]).map((mode) => (
                <button
                  aria-pressed={workspaceMode === mode}
                  className={workspaceMode === mode ? "is-active" : ""}
                  key={mode}
                  onClick={() => onWorkspaceModeChange(mode)}
                  type="button"
                >
                  {mode}
                </button>
              ))}
            </div>
          ) : null}
          <div className="gyro-topbar-status" aria-label="Workbench status">
            {visibleStatusItems.map((item) => (
              <span
                className={`gyro-status-chip is-${item.tone ?? "neutral"}`}
                key={`${item.label}-${item.value}`}
              >
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </span>
            ))}
          </div>
          <button
            aria-label="Open workspace"
            className="gyro-icon-button"
            onClick={onOpenWorkspace}
            title="Open workspace"
            type="button"
          >
            <Folder size={17} />
          </button>
          <button
            className="gyro-primary-button"
            onClick={onCreateSession}
            type="button"
          >
            <Plus size={16} />
            New thread
          </button>
        </div>
      ) : null}
    </header>
  );
}

type ChatUtilityBarProps = {
  sessionTitle?: string;
  workspacePath?: string;
  workspaceMode?: WorkbenchMode;
  activeTurn?: WorkbenchTurn;
  terminalPanes?: TerminalPane[];
  diffReview?: DiffReview;
  browserPreview?: BrowserPreview;
  onCreateSession?: () => void;
  onOpenToolPanel?: (tab: WorkbenchPaneTab) => void;
  onOpenWorkspace?: () => void;
};

export function ChatUtilityBar({
  sessionTitle,
  workspacePath,
  workspaceMode = "local",
  activeTurn,
  terminalPanes = [],
  diffReview,
  browserPreview,
  onCreateSession,
  onOpenToolPanel,
  onOpenWorkspace,
}: ChatUtilityBarProps) {
  const waitingPanes = terminalPanes.filter(
    (pane) => pane.status === "waiting",
  ).length;
  const runningPanes = terminalPanes.filter(terminalPaneHasActiveWork).length;
  const pendingDiffs =
    diffReview?.files.filter((file) => file.state === "pending").length ?? 0;
  const previewState = browserPreview?.status ?? "idle";
  const hasTerminalActivity = waitingPanes > 0 || runningPanes > 0;
  const hasDiffActivity = pendingDiffs > 0;
  const hasPreviewActivity = previewState !== "idle";
  const hasTurnActivity = activeTurn && activeTurn.sessionTitle;

  return (
    <header className="gyro-chat-utility-bar" data-tauri-drag-region>
      <div className="gyro-chat-context" data-tauri-drag-region>
        <strong>{sessionTitle ?? "Chat"}</strong>
        <span>
          {workspaceName(workspacePath)} · {workspaceMode}
        </span>
      </div>
      <div className="gyro-chat-tools" aria-label="Chat tools">
        {hasTerminalActivity ? (
          <button
            className="gyro-chat-tool"
            onClick={() => onOpenToolPanel?.("terminal")}
            title="Open terminal workbench"
            type="button"
          >
            <Terminal size={15} />
            <span>CLI</span>
            <small>
              {waitingPanes > 0
                ? `${waitingPanes} waiting`
                : `${runningPanes} live`}
            </small>
          </button>
        ) : null}
        {hasTurnActivity ? (
          <button
            className="gyro-chat-tool"
            onClick={() => onOpenToolPanel?.("diff")}
            title="Active turn checkpoint"
            type="button"
          >
            <Activity size={15} />
            <span>Turn</span>
            <small>{activeTurn.status}</small>
          </button>
        ) : null}
        {hasDiffActivity ? (
          <button
            className="gyro-chat-tool"
            onClick={() => onOpenToolPanel?.("diff")}
            title="Open diff review"
            type="button"
          >
            <GitPullRequest size={15} />
            <span>Diff</span>
            <small>{pendingDiffs} pending</small>
          </button>
        ) : null}
        {hasPreviewActivity ? (
          <button
            className="gyro-chat-tool"
            onClick={() => onOpenToolPanel?.("browser")}
            title="Open browser preview"
            type="button"
          >
            <Globe2 size={15} />
            <span>Preview</span>
            <small>{previewState.replace("-", " ")}</small>
          </button>
        ) : null}
        <button
          aria-label="Open workspace"
          className="gyro-chat-icon-tool"
          onClick={() => onOpenWorkspace?.()}
          title="Open workspace"
          type="button"
        >
          <Folder size={16} />
        </button>
        <button
          aria-label="New Chat"
          className="gyro-chat-icon-tool"
          onClick={() => onCreateSession?.()}
          title="New Chat"
          type="button"
        >
          <Edit3 size={16} />
        </button>
      </div>
    </header>
  );
}

export function ChatGridSurface({
  layout,
  maximizedPaneId,
  onDropSession,
  onFocusPane,
  onMovePane,
  onToggleMaximize,
  renderPane,
}: {
  layout: ChatProjectLayout;
  maximizedPaneId?: string;
  onDropSession: (
    sessionId: string,
    sourceProjectKey: string,
    slotIndex: number,
    placement?: ChatGridDropPlacement,
  ) => void;
  onFocusPane: (pane: ChatPaneRef) => void;
  onMovePane: (paneId: string, slotIndex: number) => void;
  onToggleMaximize: (paneId: string) => void;
  renderPane: (
    pane: ChatPaneRef,
    options: { isMaximized: boolean; isTiled: boolean },
  ) => ReactNode;
}) {
  const [dragSource, setDragSource] = useState<"session" | "pane">();
  const [dropTargetId, setDropTargetId] = useState<string>();
  const isChatDragging = dragSource !== undefined;
  const occupiedCount = layout.slots.filter(Boolean).length;
  const hasMultiplePanes = occupiedCount > 1;
  const focusedPaneId =
    layout.focusedPaneId ?? layout.slots.find(Boolean)?.paneId;
  const isMaximized = Boolean(maximizedPaneId);
  const slots = layout.slots.slice(0, 4);
  while (slots.length < 4) slots.push(null);
  const dropZones = chatGridDropZones(slots);

  const finishDrag = useCallback(() => {
    setDragSource(undefined);
    setDropTargetId(undefined);
  }, []);

  useEffect(() => {
    if (!isChatDragging) return;
    window.addEventListener("blur", finishDrag);
    window.addEventListener("dragend", finishDrag);
    return () => {
      window.removeEventListener("blur", finishDrag);
      window.removeEventListener("dragend", finishDrag);
    };
  }, [finishDrag, isChatDragging]);

  const handleDrop = (
    event: ReactDragEvent<HTMLDivElement>,
    zone: ChatGridDropZone,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    let didDrop = false;
    const paneId = event.dataTransfer.getData(CHAT_PANE_DRAG_MIME);
    if (paneId) {
      onMovePane(paneId, zone.slotIndex);
      didDrop = true;
    } else {
      const raw = event.dataTransfer.getData(CHAT_SESSION_DRAG_MIME);
      if (raw) {
        try {
          const payload = JSON.parse(raw) as {
            sessionId?: string;
            projectKey?: string;
          };
          if (payload.sessionId) {
            onDropSession(
              payload.sessionId,
              payload.projectKey ?? "",
              zone.slotIndex,
              zone.placement,
            );
            didDrop = true;
          }
        } catch {
          // Ignore external or malformed drag payloads.
        }
      }
    }
    if (didDrop && maximizedPaneId) {
      onToggleMaximize(maximizedPaneId);
    }
    finishDrag();
  };

  return (
    <div
      className={[
        "gyro-chat-grid",
        `is-count-${occupiedCount}`,
        occupiedCount === 2
          ? `is-split-${layout.splitDirection ?? "horizontal"}`
          : "",
        hasMultiplePanes ? "has-multiple-panes" : "",
        isChatDragging ? "is-dragging" : "",
        isMaximized ? "is-maximized" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onDragEnd={finishDrag}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          finishDrag();
        }
      }}
      onDragOver={(event) => {
        const source = chatDragSource(event.dataTransfer);
        if (source) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDragSource(source);
        }
      }}
    >
      {slots.map((pane, slotIndex) => {
        const paneMaximized = pane?.paneId === maximizedPaneId;
        const paneFocused = pane?.paneId === focusedPaneId;
        const hiddenByMaximize = isMaximized && !paneMaximized;
        return (
          <section
            aria-label={pane ? `Chat pane ${slotIndex + 1}` : "Empty chat pane"}
            className={[
              "gyro-chat-grid-slot",
              pane ? "is-occupied" : "is-empty",
              paneFocused ? "is-current-pane" : "is-subdued-pane",
              paneMaximized ? "is-pane-maximized" : "",
              hiddenByMaximize ? "is-hidden-by-maximize" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={pane?.paneId ?? `empty-${slotIndex}`}
            onFocusCapture={() => pane && onFocusPane(pane)}
            onPointerDown={() => pane && onFocusPane(pane)}
          >
            {pane
              ? renderPane(pane, {
                  isMaximized: paneMaximized,
                  isTiled: occupiedCount > 1 && !paneMaximized,
                })
              : null}
          </section>
        );
      })}
      {isChatDragging ? (
        <>
          <div
            aria-hidden="true"
            className="gyro-chat-grid-drop-overlay"
            data-drag-source={dragSource}
            data-layout={occupiedCount === 1 ? "directional" : "positions"}
            data-zone-count={dropZones.length}
          >
            {dropZones.map((zone) => (
              <div
                className={[
                  "gyro-chat-grid-drop-zone",
                  dropTargetId === zone.id ? "is-drop-target" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-position={zone.position}
                key={zone.id}
                onDragEnter={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setDropTargetId(zone.id);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "move";
                  if (dropTargetId !== zone.id) {
                    setDropTargetId(zone.id);
                  }
                }}
                onDrop={(event) => handleDrop(event, zone)}
              >
                <span className="gyro-chat-grid-drop-tile">{zone.label}</span>
              </div>
            ))}
          </div>
          <span aria-live="polite" className="gyro-sr-only">
            Choose where to place the chat: above, beside, or below another
            chat.
          </span>
        </>
      ) : null}
    </div>
  );
}

type ChatGridDropPlacement = {
  insertPosition: "before" | "after";
  splitDirection?: "horizontal" | "vertical";
};

type ChatGridDropZone = {
  id: string;
  label: string;
  placement?: ChatGridDropPlacement;
  position: string;
  slotIndex: number;
};

function chatGridDropZones(
  slots: Array<ChatPaneRef | null>,
): ChatGridDropZone[] {
  const occupiedSlots = slots.flatMap((pane, slotIndex) =>
    pane ? [slotIndex] : [],
  );
  if (occupiedSlots.length === 1) {
    const slotIndex = occupiedSlots[0] ?? 0;
    return [
      {
        id: "above",
        label: "Above",
        placement: { insertPosition: "before", splitDirection: "vertical" },
        position: "above",
        slotIndex,
      },
      {
        id: "left",
        label: "Left",
        placement: {
          insertPosition: "before",
          splitDirection: "horizontal",
        },
        position: "left",
        slotIndex,
      },
      {
        id: "right",
        label: "Next",
        placement: {
          insertPosition: "after",
          splitDirection: "horizontal",
        },
        position: "right",
        slotIndex,
      },
      {
        id: "below",
        label: "Below",
        placement: { insertPosition: "after", splitDirection: "vertical" },
        position: "below",
        slotIndex,
      },
    ];
  }

  if (occupiedSlots.length < 4) {
    const labels =
      occupiedSlots.length === 2
        ? ["Top left", "Next", "Below"]
        : ["Top left", "Top right", "Bottom left", "Bottom right"];
    return labels.map((label, index) => {
      const insertBefore = index === 0;
      const targetPosition = insertBefore ? 0 : index - 1;
      return {
        id: `insert-${index}`,
        label,
        placement: {
          insertPosition: insertBefore ? "before" : "after",
        },
        position: `position-${index + 1}`,
        slotIndex: occupiedSlots[targetPosition] ?? occupiedSlots.at(-1) ?? 0,
      };
    });
  }

  return occupiedSlots.map((slotIndex, index) => ({
    id: `replace-${slotIndex}`,
    label: `Replace ${index + 1}`,
    position: `position-${index + 1}`,
    slotIndex,
  }));
}

function chatDragSource(dataTransfer: DataTransfer) {
  if (dataTransfer.types.includes(CHAT_PANE_DRAG_MIME)) {
    return "pane" as const;
  }
  if (dataTransfer.types.includes(CHAT_SESSION_DRAG_MIME)) {
    return "session" as const;
  }
  return undefined;
}

type ChatSurfaceProps = {
  events: SessionEvent[];
  draft?: string;
  draftResetToken?: number;
  sessionTitle?: string;
  sessionSummary?: string;
  sessionModel?: {
    modelId?: string;
    modelLabel?: string;
    providerId?: ProviderId;
    providerLabel?: string;
    reasoningEffort?: ReasoningEffort;
  };
  workspacePath?: string;
  config: GyroConfig;
  providerReadiness?: ProviderReadiness;
  providerUsageByProvider?: Partial<Record<ProviderId, ProviderUsageState>>;
  terminalPanes?: TerminalPane[];
  diffReview?: DiffReview;
  sourceControl?: SourceControlState;
  turnSourceControlBaselines?: Record<
    string,
    Record<string, { additions: number; deletions: number }>
  >;
  browserPreview?: BrowserPreview;
  capabilityActivities?: CapabilityActivity[];
  capabilityPolicy?: ProjectCapabilityPolicy;
  onboarding?: OnboardingState;
  sessionPlan?: SessionPlan;
  sessionGoal?: SessionGoal;
  isGoalComposerActive?: boolean;
  promptHistory?: string[];
  chatMode?: ChatMode;
  attachments?: ChatAttachment[];
  queuedMessages?: Array<{
    attachmentCount: number;
    hasFailed: boolean;
    id: string;
    isDispatching: boolean;
    message: string;
  }>;
  savedProjects?: Array<{
    path: string;
    label: string;
    detail: string;
    sessionCount: number;
  }>;
  branchName?: string;
  branchCatalog?: GitBranchCatalog;
  isBranchLoading?: boolean;
  worktreeName?: string;
  workspaceMode?: WorkbenchMode;
  showOnboardingSteps?: boolean;
  isEnvironmentRailOpen?: boolean;
  isToolPanelOpen?: boolean;
  isComposerSending?: boolean;
  isTiled?: boolean;
  maxDraftLength?: number;
  activeChatPanel?: ChatSidePanelId;
  planEditorRequest?: {
    kind: "goal" | "item";
    token: number;
  };
  onDraftChange?: (value: string) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  onEditQueuedMessage?: (messageId: string) => void;
  onRemoveQueuedMessage?: (messageId: string) => void;
  onSteerQueuedMessage?: (messageId: string) => void;
  onAttachMediaFiles?: (files: File[]) => void;
  onReusePrompt?: (message: string) => void;
  onStopChat?: () => void;
  onCloseChat?: () => void;
  onContinueChat?: () => void;
  onSend: (message: string) => void;
  onComposerAction?: (action: string) => void;
  onMutationApprovalAction?: (
    proposalId: string,
    decision: "approve" | "reject",
  ) => void;
  onProviderApprovalAction?: (
    approvalId: string,
    decision: "approve" | "reject" | "allow-project",
  ) => void;
  onProviderStatusAction?: (action: string, event: SessionEvent) => void;
  onToggleEnvironmentRail?: () => void;
  onTogglePlanPanel?: () => void;
  onPlanEditorRequestHandled?: () => void;
  onPlanItemStatusChange?: (
    itemId: string,
    status: SessionPlanItemStatus,
  ) => void;
  onPlanAction?: (
    action: "add" | "edit" | "remove" | "move-up" | "move-down",
    itemId?: string,
    value?: string,
  ) => void;
  onPlanDecision?: (
    decision: "approve" | "reject",
  ) => boolean | void | Promise<boolean | void>;
  onGoalAction?: (
    action: "set" | "edit" | "complete" | "reopen" | "clear",
    value?: string,
  ) => void;
  onCancelGoalComposer?: () => void;
  onSetOnboardingStep?: (step: OnboardingState["activeStep"]) => void;
  onCompleteOnboardingStep?: (step: OnboardingState["activeStep"]) => void;
  onAgentAction?: (action: string) => void;
  onLoadChangeDiff?: (path: string) => Promise<string>;
  onOpenToolPanel?: (tab: WorkbenchPaneTab) => void;
  onToggleToolPanel?: () => void;
};

export function ChatSurface({
  events,
  draft = "",
  draftResetToken = 0,
  sessionTitle,
  sessionSummary,
  sessionModel,
  workspacePath,
  config,
  providerReadiness,
  providerUsageByProvider,
  terminalPanes,
  diffReview,
  sourceControl,
  turnSourceControlBaselines,
  browserPreview,
  capabilityActivities = [],
  capabilityPolicy,
  onboarding,
  sessionPlan,
  sessionGoal,
  isGoalComposerActive = false,
  promptHistory = [],
  chatMode = "normal",
  attachments = [],
  queuedMessages = [],
  savedProjects = [],
  branchName,
  branchCatalog,
  worktreeName,
  workspaceMode = "local",
  showOnboardingSteps = false,
  activeChatPanel,
  planEditorRequest,
  isEnvironmentRailOpen,
  isToolPanelOpen,
  isComposerSending,
  isTiled = false,
  isBranchLoading,
  maxDraftLength,
  onDraftChange,
  onRemoveAttachment,
  onEditQueuedMessage,
  onRemoveQueuedMessage,
  onSteerQueuedMessage,
  onAttachMediaFiles,
  onReusePrompt,
  onStopChat,
  onCloseChat,
  onContinueChat,
  onSend,
  onComposerAction,
  onMutationApprovalAction,
  onProviderApprovalAction,
  onProviderStatusAction,
  onSetOnboardingStep,
  onCompleteOnboardingStep,
  onLoadChangeDiff,
  onOpenToolPanel,
  onToggleToolPanel,
  onPlanItemStatusChange,
  onPlanAction,
  onPlanDecision,
  onGoalAction,
  onCancelGoalComposer,
  onToggleEnvironmentRail,
  onTogglePlanPanel,
  onPlanEditorRequestHandled,
}: ChatSurfaceProps) {
  const [localDraft, setLocalDraft] = useState(draft);
  const [dismissedPlanDecisionKey, setDismissedPlanDecisionKey] = useState<
    string | undefined
  >();
  const [isPlanDecisionPending, setIsPlanDecisionPending] = useState(false);
  const [isTranscriptAwayFromBottom, setIsTranscriptAwayFromBottom] =
    useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const autoOpenedPlanDecisionKeyRef = useRef<string>();
  const [activeThreadContextMenu, setActiveThreadContextMenu] = useState<
    "workspace" | null
  >(null);
  const threadContextMenuRef = useOutsidePointerDismiss<HTMLDivElement>(
    activeThreadContextMenu !== null,
    () => setActiveThreadContextMenu(null),
  );
  useEffect(() => {
    setLocalDraft(draft);
  }, [draft, draftResetToken]);
  const handleDraftChange = useCallback(
    (value: string) => {
      setLocalDraft(value);
      onDraftChange?.(value);
    },
    [onDraftChange],
  );
  const handleSend = useCallback(() => {
    if (isGoalComposerActive) {
      const goal = localDraft.trim();
      if (!goal) return;
      onGoalAction?.(sessionGoal?.text ? "edit" : "set", goal);
      setLocalDraft("");
      onDraftChange?.("");
      onCancelGoalComposer?.();
      return;
    }
    onSend(localDraft);
  }, [
    isGoalComposerActive,
    localDraft,
    onCancelGoalComposer,
    onDraftChange,
    onGoalAction,
    onSend,
    sessionGoal?.text,
  ]);
  const handleArtifactPrompt = useCallback(
    (prompt: string) => onSend(prompt),
    [onSend],
  );
  const handleMediaDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (
        Array.from(event.dataTransfer.items).some(
          (item) => item.kind === "file",
        )
      ) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    },
    [],
  );
  const handleMediaDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const files = Array.from(event.dataTransfer.files).filter(
        (file) =>
          /^(?:image|video)\//.test(file.type) ||
          /\.(?:png|jpe?g|webp|mp4|m4v|mov|webm)$/i.test(file.name),
      );
      if (!files.length) {
        return;
      }
      event.preventDefault();
      onAttachMediaFiles?.(files);
    },
    [onAttachMediaFiles],
  );
  const latestPlanModeEnabledAt = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event || event.kind !== "chat-mode-changed") {
        continue;
      }
      const mode = stringFromRecord(recordFromUnknown(event.payload), "mode");
      return mode === "plan" ? event.createdAt : undefined;
    }
    return undefined;
  }, [events]);
  const planDecisionKey = useMemo(() => {
    if (!sessionPlan?.updatedAt || sessionPlan.items.length === 0) {
      return undefined;
    }
    return [
      sessionPlan.sessionId ?? "session",
      sessionPlan.sourceTurnId ?? "plan",
      sessionPlan.updatedAt,
      sessionPlan.items.map((item) => `${item.id}:${item.updatedAt}`).join("|"),
    ].join(":");
  }, [sessionPlan]);
  const isPlanReadyForDecision = Boolean(
    chatMode === "plan" &&
    !isComposerSending &&
    latestPlanModeEnabledAt &&
    sessionPlan?.updatedAt &&
    sessionPlan.updatedAt >= latestPlanModeEnabledAt &&
    planDecisionKey &&
    planDecisionKey !== dismissedPlanDecisionKey,
  );
  const handlePlanDecision = useCallback(
    async (decision: "approve" | "reject") => {
      if (!planDecisionKey || isPlanDecisionPending) {
        return;
      }
      setIsPlanDecisionPending(true);
      try {
        const result = await onPlanDecision?.(decision);
        if (result !== false) {
          setDismissedPlanDecisionKey(planDecisionKey);
        }
      } finally {
        setIsPlanDecisionPending(false);
      }
    },
    [isPlanDecisionPending, onPlanDecision, planDecisionKey],
  );
  const startProjectLabel =
    workspacePath && !isGeneratedGyroWorkspace(workspacePath)
      ? workspaceName(workspacePath)
      : undefined;
  const deferredEvents = useDeferredValue(events);
  const updateTranscriptScrollPosition = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      setIsTranscriptAwayFromBottom(false);
      return;
    }
    const distanceFromBottom =
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;
    setIsTranscriptAwayFromBottom(distanceFromBottom > 72);
  }, []);
  const scrollTranscriptToBottom = useCallback(() => {
    const transcript = transcriptRef.current;
    transcript?.scrollTo({
      behavior: "smooth",
      top: transcript.scrollHeight,
    });
  }, []);
  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(
      updateTranscriptScrollPosition,
    );
    return () => window.cancelAnimationFrame(animationFrame);
  }, [deferredEvents, updateTranscriptScrollPosition]);
  const contextModel = useMemo(() => {
    const providers = providersForConfig(config);
    const providerId = config.selectedProviderId ?? sessionModel?.providerId;
    const provider = providers.find((item) => item.id === providerId);
    const modelId = provider?.selectedModelId ?? sessionModel?.modelId;
    const model = provider ? getProviderModel(provider, modelId) : undefined;
    return {
      providerId,
      modelId,
      modelLabel:
        model?.displayName ?? sessionModel?.modelLabel ?? modelId ?? undefined,
      contextWindowTokens: model?.contextWindowTokens,
    };
  }, [
    config,
    sessionModel?.modelId,
    sessionModel?.modelLabel,
    sessionModel?.providerId,
  ]);
  const contextUsage = useMemo(
    () =>
      estimateComposerContextUsage(deferredEvents, localDraft, contextModel),
    [contextModel, deferredEvents, localDraft],
  );
  const composerProviderUsage = contextModel.providerId
    ? providerUsageByProvider?.[contextModel.providerId]
    : undefined;
  const transcriptState = useMemo(
    () => deriveTranscriptState(deferredEvents),
    [deferredEvents],
  );
  const { looseEvents, turns } = transcriptState;
  const activeRailPanel =
    activeChatPanel ?? (isEnvironmentRailOpen ? "environment" : undefined);
  useEffect(() => {
    if (
      !isPlanReadyForDecision ||
      !planDecisionKey ||
      autoOpenedPlanDecisionKeyRef.current === planDecisionKey
    ) {
      return;
    }
    autoOpenedPlanDecisionKeyRef.current = planDecisionKey;
    if (activeRailPanel !== "plan") {
      onTogglePlanPanel?.();
    }
  }, [
    activeRailPanel,
    isPlanReadyForDecision,
    onTogglePlanPanel,
    planDecisionKey,
  ]);
  const activeTurnId = isComposerSending
    ? activeTranscriptTurnId(turns)
    : undefined;
  const hasSelectedProvider = providersForConfig(config).some(
    (provider) =>
      provider.id === config.selectedProviderId &&
      provider.authStatus === "connected",
  );
  const transcriptContent = useMemo(
    () => (
      <>
        {looseEvents.map((event) => (
          <ChatEvent
            event={event}
            key={event.id}
            onMutationApprovalAction={onMutationApprovalAction}
            onProviderApprovalAction={onProviderApprovalAction}
            onProviderStatusAction={onProviderStatusAction}
          />
        ))}
        {turns.map((turn) => (
          <ChatTurn
            artifactActions={{
              onOpenFiles: () => onComposerAction?.("open-files"),
              onOpenTool: onOpenToolPanel,
              onSendPrompt: handleArtifactPrompt,
            }}
            isActive={turn.id === activeTurnId}
            key={turn.id}
            onLoadChangeDiff={onLoadChangeDiff}
            onOpenChanges={() => onOpenToolPanel?.("diff")}
            onMutationApprovalAction={onMutationApprovalAction}
            onProviderApprovalAction={onProviderApprovalAction}
            onProviderStatusAction={onProviderStatusAction}
            onReusePrompt={onReusePrompt}
            onContinueChat={onContinueChat}
            onOpenPlan={onTogglePlanPanel}
            onPlanDecision={handlePlanDecision}
            plan={sessionPlan}
            isPlanDecisionPending={isPlanDecisionPending}
            isPlanPanelOpen={activeRailPanel === "plan"}
            isPlanReadyForDecision={isPlanReadyForDecision}
            sourceControl={sourceControl}
            sourceControlBaseline={turnSourceControlBaselines?.[turn.id]}
            turn={turn}
          />
        ))}
        {turns.length === 0 && looseEvents.length === 0 ? (
          <div className="gyro-thread-empty">Start with a request.</div>
        ) : null}
      </>
    ),
    [
      onMutationApprovalAction,
      onComposerAction,
      onLoadChangeDiff,
      onOpenToolPanel,
      onProviderApprovalAction,
      onProviderStatusAction,
      handlePlanDecision,
      handleArtifactPrompt,
      sourceControl,
      turnSourceControlBaselines,
      activeTurnId,
      isComposerSending,
      isPlanDecisionPending,
      isPlanReadyForDecision,
      activeRailPanel,
      looseEvents,
      onTogglePlanPanel,
      sessionPlan,
      turns,
    ],
  );
  const sidePanel = activeRailPanel ? (
    <ChatSidePanel
      activePanel={activeRailPanel}
      branchName={branchName}
      browserPreview={browserPreview}
      capabilityActivities={capabilityActivities}
      capabilityPolicy={capabilityPolicy}
      diffReview={diffReview}
      sourceControl={sourceControl}
      onPlanItemStatusChange={onPlanItemStatusChange}
      onPlanAction={onPlanAction}
      onGoalAction={onGoalAction}
      editorRequest={planEditorRequest}
      onEditorRequestHandled={onPlanEditorRequestHandled}
      onClose={onToggleEnvironmentRail}
      onComposerAction={onComposerAction}
      onOpenToolPanel={onOpenToolPanel}
      onTogglePlanPanel={onTogglePlanPanel}
      sessionPlan={sessionPlan}
      sessionGoal={sessionGoal}
      terminalPanes={terminalPanes}
      workspaceMode={workspaceMode}
      workspacePath={workspacePath}
      worktreeName={worktreeName}
    />
  ) : null;
  if (turns.length === 0 && looseEvents.length === 0) {
    return (
      <div
        className={[
          "gyro-chat-surface",
          "is-empty",
          isTiled ? "is-tiled" : "",
          activeRailPanel ? "has-environment" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onDragOver={handleMediaDragOver}
        onDrop={handleMediaDrop}
      >
        <div
          aria-hidden="true"
          className="gyro-chat-empty-drag-region"
          data-tauri-drag-region
        />
        <section
          className="gyro-chat-start"
          aria-label="New Chat"
          style={{ width: "min(860px, 100%)" }}
        >
          <span className="gyro-brand-logo">
            <img
              alt="Gyro"
              className="is-light"
              src={gyroLogoTransparentDark}
            />
            <img
              alt=""
              aria-hidden="true"
              className="is-dark"
              src={gyroLogoTransparentLight}
            />
          </span>
          <h1>
            {startProjectLabel ? (
              <>
                <span>What should we do in </span>
                <span className="gyro-chat-start-brand-word">
                  {startProjectLabel}?
                </span>
              </>
            ) : (
              <span>What should we work on?</span>
            )}
          </h1>
          <Composer
            attachments={attachments}
            chatMode={chatMode}
            config={config}
            constrainToParent={Boolean(activeRailPanel)}
            draft={localDraft}
            branchName={branchName}
            branchCatalog={branchCatalog}
            onDraftChange={handleDraftChange}
            onRemoveAttachment={onRemoveAttachment}
            onAttachMediaFiles={onAttachMediaFiles}
            onSend={handleSend}
            onStop={onStopChat}
            isSending={isComposerSending}
            isBranchLoading={isBranchLoading}
            maxDraftLength={maxDraftLength}
            providerReadiness={providerReadiness}
            providerUsage={composerProviderUsage}
            savedProjects={savedProjects}
            variant="hero"
            workspaceMode={workspaceMode}
            workspacePath={workspacePath}
            worktreeName={worktreeName}
            onComposerAction={onComposerAction}
            sessionModel={sessionModel}
            sessionGoal={sessionGoal}
            isGoalComposerActive={isGoalComposerActive}
            onCancelGoalComposer={onCancelGoalComposer}
            promptHistory={turns.flatMap((turn) =>
              turn.user ? [turn.user.message] : [],
            )}
            contextUsage={contextUsage}
          />
          {showOnboardingSteps ? (
            <OnboardingSteps
              onboarding={onboarding}
              onCompleteStep={onCompleteOnboardingStep}
              onSelectStep={onSetOnboardingStep}
            />
          ) : null}
        </section>
        {sidePanel}
      </div>
    );
  }

  const branchLabel =
    branchName ??
    (workspaceMode === "worktree" ? "New worktree branch" : "main");
  const threadBranchItems = branchPopoverItems({
    branchCatalog,
    branchName: branchLabel,
    isDisabled: isComposerSending,
    isLoading: isBranchLoading,
    workspaceMode,
    workspacePath,
  });
  const threadProjectItems: ComposerPopoverItem[] = [
    {
      active: true,
      disabled: true,
      detail: workspacePath ?? "No folder selected",
      icon: HardDrive,
      label: workspaceName(workspacePath),
    },
    {
      action: "new-chat-select-workspace",
      detail: "Keep this chat intact and choose another folder",
      icon: Folder,
      label: "New chat in another folder",
    },
  ];
  const threadWorkspaceModeItems: ComposerPopoverItem[] = [
    {
      active: true,
      disabled: true,
      detail: "This context stays fixed for the current chat",
      icon: workspaceMode === "worktree" ? GitBranch : Laptop,
      label: workspaceMode === "worktree" ? "Worktree" : "Local",
    },
    {
      action:
        workspaceMode === "worktree"
          ? "new-local-chat-select-workspace"
          : "start-new-chat-mode:worktree",
      detail:
        workspaceMode === "local"
          ? "Create an isolated branch when the new chat starts"
          : "Choose the source folder for a new local chat",
      icon: workspaceMode === "local" ? GitPullRequest : Laptop,
      label: workspaceMode === "local" ? "New worktree chat" : "New local chat",
    },
  ];
  const threadWorkspaceItems: ComposerPopoverItem[] = [
    ...threadProjectItems.map((item, index) => ({
      ...item,
      sectionLabel: index === 0 ? "Project" : undefined,
    })),
    ...threadWorkspaceModeItems.map((item, index) => ({
      ...item,
      sectionLabel: index === 0 ? "Mode" : undefined,
    })),
    ...threadBranchItems.map((item, index) => ({
      ...item,
      sectionLabel: index === 0 ? "Branch" : undefined,
    })),
  ];
  const workspaceModeLabel =
    workspaceMode === "worktree" ? "Worktree" : "Local";

  return (
    <div
      className={[
        "gyro-chat-surface",
        "is-thread",
        isTiled ? "is-tiled" : "",
        activeRailPanel ? "has-environment" : "",
        activeRailPanel === "plan" && sessionPlan?.content ? "has-plan" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onDragOver={handleMediaDragOver}
      onDrop={handleMediaDrop}
    >
      <div className="gyro-chat-thread-topbar">
        <div className="gyro-chat-thread-identity">
          <strong>{sessionTitle ?? "Gyro session"}</strong>
        </div>
        <div className="gyro-thread-topbar-actions">
          <div className="gyro-thread-pills" ref={threadContextMenuRef}>
            <div className="gyro-thread-context-control is-workspace-context">
              <button
                aria-label={`Workspace: ${workspaceName(workspacePath)}, branch ${branchLabel}, ${workspaceModeLabel}`}
                aria-controls={
                  activeThreadContextMenu === "workspace"
                    ? "gyro-thread-workspace-menu"
                    : undefined
                }
                aria-expanded={activeThreadContextMenu === "workspace"}
                aria-haspopup="menu"
                className="gyro-thread-pill-button gyro-thread-workspace-context-button"
                onClick={() => {
                  setActiveThreadContextMenu((current) =>
                    current === "workspace" ? null : "workspace",
                  );
                  if (activeThreadContextMenu !== "workspace") {
                    onComposerAction?.("select-branch");
                  }
                }}
                type="button"
                title={`${workspaceName(workspacePath)} / ${branchLabel} / ${workspaceModeLabel}`}
              >
                <HardDrive aria-hidden="true" size={13} />
                <em className="gyro-thread-context-project">
                  {workspaceName(workspacePath)}
                </em>
                <i aria-hidden="true">/</i>
                <em className="gyro-thread-context-branch">{branchLabel}</em>
                <i aria-hidden="true">/</i>
                <em className="gyro-thread-context-mode">
                  {workspaceModeLabel}
                </em>
                <ChevronDown aria-hidden="true" size={12} />
              </button>
              {activeThreadContextMenu === "workspace" ? (
                <ComposerPopover
                  align="end"
                  id="gyro-thread-workspace-menu"
                  items={threadWorkspaceItems}
                  onAction={(action) => {
                    setActiveThreadContextMenu(null);
                    if (action) {
                      onComposerAction?.(action);
                    }
                  }}
                  placement="down"
                  title="Workspace context"
                />
              ) : null}
            </div>
          </div>
          <ChatSurfaceControls
            activePanel={activeRailPanel}
            isToolPanelOpen={Boolean(isToolPanelOpen)}
            onCloseChat={onCloseChat}
            onToggleToolPanel={onToggleToolPanel}
            onToggleEnvironmentRail={onToggleEnvironmentRail}
            onTogglePlanPanel={onTogglePlanPanel}
            planItemCount={sessionPlan?.items.length ?? 0}
          />
        </div>
      </div>

      <section className="gyro-chat-thread-canvas" aria-label="Chat">
        <div
          aria-busy={isComposerSending}
          aria-live="polite"
          aria-relevant="additions text"
          className="gyro-thread-body gyro-chat-transcript"
          onScroll={updateTranscriptScrollPosition}
          ref={transcriptRef}
          role="log"
        >
          {transcriptContent}
        </div>

        <div className="gyro-chat-composer-dock">
          {isTranscriptAwayFromBottom ? (
            <button
              aria-label="Jump to latest message"
              className="gyro-chat-jump-to-bottom"
              onClick={scrollTranscriptToBottom}
              title="Jump to latest message"
              type="button"
            >
              <ArrowDown aria-hidden="true" size={20} strokeWidth={1.8} />
            </button>
          ) : null}
          {queuedMessages.length > 0 ? (
            <ChatMessageQueue
              messages={queuedMessages}
              onEditMessage={onEditQueuedMessage}
              onRemoveMessage={onRemoveQueuedMessage}
              onSteerMessage={onSteerQueuedMessage}
            />
          ) : null}
          {isPlanReadyForDecision && sessionPlan ? (
            <PlanDecisionCard
              isPending={isPlanDecisionPending}
              onDecision={handlePlanDecision}
              plan={sessionPlan}
            />
          ) : null}
          <Composer
            attachments={attachments}
            chatMode={chatMode}
            config={config}
            constrainToParent={Boolean(activeRailPanel)}
            draft={localDraft}
            branchName={branchName}
            onDraftChange={handleDraftChange}
            onRemoveAttachment={onRemoveAttachment}
            onAttachMediaFiles={onAttachMediaFiles}
            onSend={handleSend}
            onStop={onStopChat}
            isSending={isComposerSending}
            maxDraftLength={maxDraftLength}
            providerReadiness={providerReadiness}
            providerUsage={composerProviderUsage}
            savedProjects={savedProjects}
            workspaceMode={workspaceMode}
            workspacePath={workspacePath}
            worktreeName={worktreeName}
            onComposerAction={onComposerAction}
            sessionModel={sessionModel}
            sessionGoal={sessionGoal}
            isGoalComposerActive={isGoalComposerActive}
            onCancelGoalComposer={onCancelGoalComposer}
            promptHistory={turns.flatMap((turn) =>
              turn.user ? [turn.user.message] : [],
            )}
            contextUsage={contextUsage}
            showContextRow={false}
            popoverPlacement="up"
            variant="hero"
          />
        </div>
      </section>
      {sidePanel}
    </div>
  );
}

function PlanDecisionCard({
  isPending,
  onDecision,
  plan,
}: {
  isPending: boolean;
  onDecision: (decision: "approve" | "reject") => void;
  plan: SessionPlan;
}) {
  return (
    <section
      aria-label="Plan ready for approval"
      className="gyro-plan-decision-card"
    >
      <header>
        <span className="gyro-plan-decision-icon">
          <ListChecks size={16} />
        </span>
        <div>
          <small>Plan ready</small>
          <strong>{plan.title || "Implementation plan"}</strong>
        </div>
      </header>
      <ol>
        {plan.items.map((item) => (
          <li key={item.id}>
            <span aria-hidden="true">
              {item.status === "complete" ? (
                <Check size={12} />
              ) : item.status === "blocked" ? (
                <X size={12} />
              ) : (
                <CircleDashed size={12} />
              )}
            </span>
            <div>
              <strong>{item.title}</strong>
              {item.detail ? <small>{item.detail}</small> : null}
            </div>
          </li>
        ))}
      </ol>
      <footer>
        <span>Implement this plan?</span>
        <div>
          <button
            className="is-secondary"
            disabled={isPending}
            onClick={() => onDecision("reject")}
            type="button"
          >
            No, keep planning
          </button>
          <button
            className="is-primary"
            disabled={isPending}
            onClick={() => onDecision("approve")}
            type="button"
          >
            {isPending ? "Starting…" : "Yes, implement"}
          </button>
        </div>
      </footer>
    </section>
  );
}

function PlanDocument({ content, title }: { content: string; title: string }) {
  const visibleContent = content
    .replace(/^\s*<proposed_plan>\s*$/gim, "")
    .replace(/^\s*<\/proposed_plan>\s*$/gim, "")
    .trim();
  const blocks = useMemo(
    () => assistantResponseBlocks(visibleContent),
    [visibleContent],
  );
  const firstHeadingIndex = blocks.findIndex(
    (block) => block.kind === "heading",
  );

  return (
    <article className="gyro-plan-document">
      {firstHeadingIndex < 0 ? <h1>{title || "Implementation plan"}</h1> : null}
      {blocks.map((block, index) =>
        block.kind === "heading" ? (
          index === firstHeadingIndex ? (
            <h1 key={`plan-heading-${index}`}>
              {renderAssistantInlineContent(block.content)}
            </h1>
          ) : (
            <h2 key={`plan-heading-${index}`}>
              {renderAssistantInlineContent(block.content)}
            </h2>
          )
        ) : (
          <AssistantResponseBlockView
            block={block}
            key={`${block.kind}-${index}`}
          />
        ),
      )}
    </article>
  );
}

function PlanArtifactCard({
  content,
  isOpen,
  isPending,
  onOpen,
  onPlanDecision,
  showDecision,
  title,
}: {
  content: string;
  isOpen: boolean;
  isPending: boolean;
  onOpen?: () => void;
  onPlanDecision?: (decision: "approve" | "reject") => void;
  showDecision: boolean;
  title: string;
}) {
  return (
    <div className="gyro-plan-artifact">
      <section className="gyro-plan-artifact-card" aria-label="Plan">
        <button
          aria-expanded={isOpen}
          aria-label={isOpen ? "Close plan document" : "Open plan document"}
          className="gyro-plan-artifact-header"
          onClick={onOpen}
          type="button"
        >
          <span>
            <Lightbulb size={15} />
            <strong>Plan</strong>
          </span>
          {isOpen ? <PanelLeftClose size={14} /> : <Maximize2 size={14} />}
        </button>
        <div className="gyro-plan-artifact-preview">
          <PlanDocument content={content} title={title} />
        </div>
      </section>
      {showDecision ? (
        <div className="gyro-plan-artifact-actions">
          <button
            disabled={isPending}
            onClick={() => onPlanDecision?.("approve")}
            type="button"
          >
            {isPending
              ? "Starting implementation…"
              : "Yes, implement this plan"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ChatMessageQueue({
  messages,
  onEditMessage,
  onRemoveMessage,
  onSteerMessage,
}: {
  messages: Array<{
    attachmentCount: number;
    hasFailed: boolean;
    id: string;
    isDispatching: boolean;
    message: string;
  }>;
  onEditMessage?: (messageId: string) => void;
  onRemoveMessage?: (messageId: string) => void;
  onSteerMessage?: (messageId: string) => void;
}) {
  const [menuState, setMenuState] = useState<{
    messageId: string;
    placement: "down" | "up";
  }>();
  const menuMessageId = menuState?.messageId;
  const menuRef = useOutsidePointerDismiss<HTMLElement>(
    menuMessageId !== undefined,
    () => setMenuState(undefined),
  );
  return (
    <section className="gyro-chat-message-queue" aria-label="Queued messages">
      <div className="gyro-chat-message-queue-list">
        {messages.map((message, index) => (
          <article
            className={[message.isDispatching ? "is-dispatching" : ""]
              .concat(message.hasFailed ? "is-failed" : "")
              .filter(Boolean)
              .join(" ")}
            key={message.id}
            ref={menuMessageId === message.id ? menuRef : undefined}
          >
            <CornerDownRight
              aria-hidden="true"
              className="gyro-chat-message-queue-icon"
              size={15}
            />
            <p>{message.message}</p>
            <div className="gyro-chat-message-queue-actions">
              <button
                className="gyro-chat-message-queue-steer"
                disabled={message.isDispatching}
                onClick={() => onSteerMessage?.(message.id)}
                title={
                  message.hasFailed
                    ? "Retry this queued message"
                    : "Stop the current response and send this next"
                }
                type="button"
              >
                {message.hasFailed ? (
                  <RefreshCw size={13} />
                ) : (
                  <CornerDownRight size={13} />
                )}
                {message.hasFailed ? "Retry" : "Steer"}
              </button>
              <button
                aria-expanded={menuMessageId === message.id}
                aria-haspopup="menu"
                aria-label="Queued message options"
                disabled={message.isDispatching}
                onClick={(event) => {
                  const queueBounds = event.currentTarget
                    .closest(".gyro-chat-message-queue")
                    ?.getBoundingClientRect();
                  const buttonBounds =
                    event.currentTarget.getBoundingClientRect();
                  const placement =
                    queueBounds && queueBounds.bottom - buttonBounds.bottom < 76
                      ? "up"
                      : "down";
                  setMenuState((current) =>
                    current?.messageId === message.id
                      ? undefined
                      : { messageId: message.id, placement },
                  );
                }}
                title={message.isDispatching ? "Message is sending" : "More"}
                type="button"
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
            {menuMessageId === message.id ? (
              <div
                aria-label={`Options for queue position ${index + 1}`}
                className={`gyro-chat-message-queue-menu is-${menuState?.placement ?? "down"}`}
                role="menu"
              >
                <button
                  onClick={() => {
                    setMenuState(undefined);
                    onEditMessage?.(message.id);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Edit3 size={13} />
                  <span>Edit</span>
                </button>
                <button
                  className="is-danger"
                  onClick={() => {
                    setMenuState(undefined);
                    onRemoveMessage?.(message.id);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Trash2 size={13} />
                  <span>Delete</span>
                </button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function ChatSurfaceControls({
  activePanel,
  isToolPanelOpen,
  onCloseChat,
  onToggleToolPanel,
  onToggleEnvironmentRail,
  onTogglePlanPanel,
  planItemCount,
}: {
  activePanel?: ChatSidePanelId;
  isToolPanelOpen: boolean;
  onCloseChat?: () => void;
  onToggleToolPanel?: () => void;
  onToggleEnvironmentRail?: () => void;
  onTogglePlanPanel?: () => void;
  planItemCount: number;
}) {
  return (
    <div className="gyro-chat-surface-controls" aria-label="Chat surfaces">
      <button
        aria-label={
          isToolPanelOpen ? "Close bottom drawer" : "Open bottom drawer"
        }
        aria-pressed={isToolPanelOpen}
        className={[
          "gyro-chat-surface-button",
          isToolPanelOpen ? "is-active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={onToggleToolPanel}
        title="Bottom drawer"
        type="button"
      >
        <PanelBottom size={15} />
      </button>
      <button
        aria-label={
          activePanel ? "Close right side panel" : "Open right side panel"
        }
        aria-pressed={Boolean(activePanel)}
        className={["gyro-chat-surface-button", activePanel ? "is-active" : ""]
          .filter(Boolean)
          .join(" ")}
        onClick={onToggleEnvironmentRail}
        title="Right side panel"
        type="button"
      >
        <PanelRight size={15} />
      </button>
      <button
        aria-label={
          activePanel === "plan"
            ? "Close plan checklist"
            : "Open plan checklist"
        }
        aria-pressed={activePanel === "plan"}
        className={[
          "gyro-chat-surface-button",
          activePanel === "plan" ? "is-active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={onTogglePlanPanel}
        title="Plan checklist"
        type="button"
      >
        <ListChecks size={15} />
        {planItemCount > 0 ? (
          <span className="gyro-chat-surface-count">{planItemCount}</span>
        ) : null}
      </button>
      {onCloseChat ? (
        <button
          aria-label="Close chat"
          className="gyro-chat-surface-button"
          onClick={onCloseChat}
          title="Close chat"
          type="button"
        >
          <X size={15} />
        </button>
      ) : null}
    </div>
  );
}

function ChatSidePanel({
  activePanel,
  browserPreview,
  capabilityActivities = [],
  capabilityPolicy,
  diffReview,
  sourceControl,
  onPlanItemStatusChange,
  onPlanAction,
  onGoalAction,
  editorRequest,
  onEditorRequestHandled,
  onClose,
  onComposerAction,
  onOpenToolPanel,
  onTogglePlanPanel,
  sessionPlan,
  sessionGoal,
  terminalPanes = [],
  workspacePath,
}: {
  activePanel: ChatSidePanelId;
  branchName?: string;
  browserPreview?: BrowserPreview;
  capabilityActivities?: CapabilityActivity[];
  capabilityPolicy?: ProjectCapabilityPolicy;
  diffReview?: DiffReview;
  sourceControl?: SourceControlState;
  onPlanItemStatusChange?: (
    itemId: string,
    status: SessionPlanItemStatus,
  ) => void;
  onPlanAction?: (
    action: "add" | "edit" | "remove" | "move-up" | "move-down",
    itemId?: string,
    value?: string,
  ) => void;
  onGoalAction?: (
    action: "set" | "edit" | "complete" | "reopen" | "clear",
    value?: string,
  ) => void;
  editorRequest?: {
    kind: "goal" | "item";
    token: number;
  };
  onEditorRequestHandled?: () => void;
  onClose?: () => void;
  onComposerAction?: (action: string) => void;
  onOpenToolPanel?: (tab: WorkbenchPaneTab) => void;
  onTogglePlanPanel?: () => void;
  sessionPlan?: SessionPlan;
  sessionGoal?: SessionGoal;
  promptHistory?: string[];
  terminalPanes?: TerminalPane[];
  workspaceMode?: WorkbenchMode;
  workspacePath?: string;
  worktreeName?: string;
}) {
  const [planEditor, setPlanEditor] = useState<{
    mode: "add" | "edit";
    itemId?: string;
    value: string;
  }>();
  const [goalEditor, setGoalEditor] = useState<string>();
  const handledEditorRequestTokenRef = useRef<number>();
  useEffect(() => {
    if (
      activePanel !== "plan" ||
      !editorRequest ||
      handledEditorRequestTokenRef.current === editorRequest.token
    ) {
      return;
    }
    handledEditorRequestTokenRef.current = editorRequest.token;
    if (editorRequest.kind === "goal") {
      setPlanEditor(undefined);
      setGoalEditor(sessionGoal?.text ?? "");
    } else {
      setGoalEditor(undefined);
      setPlanEditor({ mode: "add", value: "" });
    }
    onEditorRequestHandled?.();
  }, [activePanel, editorRequest, onEditorRequestHandled, sessionGoal?.text]);
  const submitPlanEditor = () => {
    const title = planEditor?.value.trim();
    if (!planEditor || !title) return;
    onPlanAction?.(planEditor.mode, planEditor.itemId, title);
    setPlanEditor(undefined);
  };
  const submitGoalEditor = () => {
    const text = goalEditor?.trim();
    if (goalEditor === undefined || !text) return;
    onGoalAction?.(sessionGoal?.text ? "edit" : "set", text);
    setGoalEditor(undefined);
  };

  const pendingDiffs =
    diffReview?.files.filter((file) => file.state === "pending").length ?? 0;
  const changedFiles =
    sourceControl?.files.length ?? diffReview?.files.length ?? 0;
  const runningPanes = terminalPanes.filter(terminalPaneHasActiveWork).length;
  const planItemCount = sessionPlan?.items.length ?? 0;
  const changesLabel =
    pendingDiffs > 0
      ? `${pendingDiffs} pending`
      : changedFiles > 0
        ? `${changedFiles} ${changedFiles === 1 ? "file" : "files"}`
        : "No changes";
  const terminalLabel =
    runningPanes > 0
      ? `${runningPanes} running`
      : terminalPanes.length > 0
        ? `${terminalPanes.length} saved`
        : "Ready";
  const browserLabel = chatToolBrowserStatusLabel(browserPreview);
  const planLabel =
    planItemCount > 0
      ? `${planItemCount} ${planItemCount === 1 ? "item" : "items"}`
      : "No items";
  const completedPlanItems =
    sessionPlan?.items.filter((item) => item.status === "complete").length ?? 0;
  const planProgress =
    planItemCount > 0
      ? Math.round((completedPlanItems / planItemCount) * 100)
      : 0;
  const openTool = (tab: WorkbenchPaneTab) => {
    onClose?.();
    onOpenToolPanel?.(tab);
  };

  if (activePanel === "plan" && sessionPlan?.content) {
    return (
      <aside className="gyro-plan-rail is-document" aria-label="Plan document">
        <header>
          <div>
            <Lightbulb aria-hidden="true" size={15} />
            <strong>Plan</strong>
          </div>
          <button
            aria-label="Close plan document"
            className="gyro-chat-tool-close"
            onClick={onClose}
            type="button"
          >
            <X size={14} />
          </button>
        </header>
        <PlanDocument content={sessionPlan.content} title={sessionPlan.title} />
      </aside>
    );
  }

  if (activePanel === "plan") {
    return (
      <aside
        className="gyro-environment-rail gyro-chat-tool-rail has-plan"
        aria-label="Environment"
      >
        <header>
          <div className="gyro-chat-tool-title">
            <HardDrive aria-hidden="true" size={15} />
            <div>
              <strong>Environment</strong>
              <span>{workspaceName(workspacePath)}</span>
            </div>
          </div>
          <button
            aria-label="Close environment"
            className="gyro-chat-tool-close"
            onClick={onClose}
            type="button"
          >
            <X size={14} />
          </button>
        </header>
        <ChatEnvironmentLauncher
          browserLabel={browserLabel}
          browserPreview={browserPreview}
          changedFiles={changedFiles}
          changesLabel={changesLabel}
          onOpenFiles={() => {
            onClose?.();
            onComposerAction?.("open-files");
          }}
          onOpenTool={openTool}
          onTogglePlan={onTogglePlanPanel}
          pendingDiffs={pendingDiffs}
          planExpanded
          planItemCount={planItemCount}
          planLabel={planLabel}
          runningPanes={runningPanes}
          terminalLabel={terminalLabel}
          workspacePath={workspacePath}
        />
        <section className="gyro-plan-harness" aria-label="Plan harness">
          <header>
            <div className="gyro-plan-harness-title">
              <Lightbulb size={15} />
              <div>
                <strong>{sessionPlan?.title ?? "Plan"}</strong>
                <span>{planLabel} · model-managed checklist</span>
              </div>
            </div>
            {planItemCount > 0 ? (
              <strong className="gyro-plan-progress-label">
                {completedPlanItems}/{planItemCount}
              </strong>
            ) : null}
          </header>
          {planItemCount > 0 ? (
            <div
              aria-label={`${planProgress}% of plan complete`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={planProgress}
              className="gyro-plan-progress"
              role="progressbar"
            >
              <span style={{ width: `${planProgress}%` }} />
            </div>
          ) : null}
          <div className="gyro-rail-section">
            {goalEditor !== undefined ? (
              <form
                className="gyro-plan-inline-editor is-goal"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitGoalEditor();
                }}
              >
                <input
                  aria-label="Session goal"
                  autoFocus
                  maxLength={240}
                  onChange={(event) => setGoalEditor(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setGoalEditor(undefined);
                  }}
                  placeholder="Define the outcome for this chat"
                  value={goalEditor}
                />
                <button
                  aria-label="Save session goal"
                  disabled={!goalEditor.trim()}
                  title="Save session goal"
                  type="submit"
                >
                  <Check size={13} />
                </button>
                <button
                  aria-label="Cancel session goal"
                  onClick={() => setGoalEditor(undefined)}
                  title="Cancel"
                  type="button"
                >
                  <X size={13} />
                </button>
              </form>
            ) : sessionGoal?.text ? (
              <article className={`gyro-session-goal is-${sessionGoal.status}`}>
                <Goal size={15} />
                <div>
                  <small>Session goal</small>
                  <strong>{sessionGoal.text}</strong>
                </div>
                <div className="gyro-plan-item-actions">
                  <button
                    aria-label="Edit goal"
                    onClick={() => setGoalEditor(sessionGoal.text)}
                    type="button"
                  >
                    <Edit3 size={12} />
                  </button>
                  <button
                    aria-label={
                      sessionGoal.status === "complete"
                        ? "Reopen goal"
                        : "Complete goal"
                    }
                    onClick={() =>
                      onGoalAction?.(
                        sessionGoal.status === "complete"
                          ? "reopen"
                          : "complete",
                      )
                    }
                    title={
                      sessionGoal.status === "complete"
                        ? "Reopen goal"
                        : "Complete goal"
                    }
                    type="button"
                  >
                    {sessionGoal.status === "complete" ? (
                      <RefreshCw size={12} />
                    ) : (
                      <Check size={12} />
                    )}
                  </button>
                  <button
                    aria-label="Clear goal"
                    onClick={() => onGoalAction?.("clear")}
                    type="button"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </article>
            ) : (
              <button
                className="gyro-rail-row is-action"
                onClick={() => onComposerAction?.("add-goal")}
                type="button"
              >
                <Goal size={14} />
                <span>Set session goal</span>
              </button>
            )}
            {planEditor?.mode === "add" ? (
              <form
                className="gyro-plan-inline-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitPlanEditor();
                }}
              >
                <input
                  aria-label="Plan item title"
                  autoFocus
                  maxLength={160}
                  onChange={(event) =>
                    setPlanEditor((current) =>
                      current
                        ? { ...current, value: event.target.value }
                        : current,
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setPlanEditor(undefined);
                  }}
                  placeholder="Describe the next step"
                  value={planEditor.value}
                />
                <button
                  aria-label="Save plan item"
                  disabled={!planEditor.value.trim()}
                  title="Save plan item"
                  type="submit"
                >
                  <Check size={13} />
                </button>
                <button
                  aria-label="Cancel plan item"
                  onClick={() => setPlanEditor(undefined)}
                  title="Cancel"
                  type="button"
                >
                  <X size={13} />
                </button>
              </form>
            ) : (
              <button
                className="gyro-rail-row is-action"
                onClick={() =>
                  setPlanEditor({ mode: "add", value: "", itemId: undefined })
                }
                type="button"
              >
                <Plus size={14} />
                <span>Add plan item</span>
              </button>
            )}
            {sessionPlan && sessionPlan.items.length > 0 ? (
              sessionPlan.items.map((item) => (
                <article className="gyro-plan-item" key={item.id}>
                  <button
                    aria-label={`Mark ${item.title} ${nextPlanStatus(item.status)}`}
                    className={`gyro-plan-check is-${item.status}`}
                    onClick={() =>
                      onPlanItemStatusChange?.(
                        item.id,
                        nextPlanStatus(item.status),
                      )
                    }
                    title={`Mark ${nextPlanStatus(item.status)}`}
                    type="button"
                  >
                    {item.status === "complete" ? (
                      <Check size={13} />
                    ) : item.status === "blocked" ? (
                      <X size={13} />
                    ) : (
                      <CircleDashed size={13} />
                    )}
                  </button>
                  {planEditor?.mode === "edit" &&
                  planEditor.itemId === item.id ? (
                    <form
                      className="gyro-plan-inline-editor is-item"
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitPlanEditor();
                      }}
                    >
                      <input
                        aria-label={`Edit ${item.title}`}
                        autoFocus
                        maxLength={160}
                        onChange={(event) =>
                          setPlanEditor((current) =>
                            current
                              ? { ...current, value: event.target.value }
                              : current,
                          )
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setPlanEditor(undefined);
                        }}
                        value={planEditor.value}
                      />
                      <button
                        aria-label={`Save ${item.title}`}
                        disabled={!planEditor.value.trim()}
                        title="Save"
                        type="submit"
                      >
                        <Check size={13} />
                      </button>
                      <button
                        aria-label={`Cancel editing ${item.title}`}
                        onClick={() => setPlanEditor(undefined)}
                        title="Cancel"
                        type="button"
                      >
                        <X size={13} />
                      </button>
                    </form>
                  ) : (
                    <>
                      <div>
                        <strong>{item.title}</strong>
                        {item.detail ? <span>{item.detail}</span> : null}
                      </div>
                      <small>{planStatusLabel(item.status)}</small>
                      <div className="gyro-plan-item-actions">
                        <button
                          aria-label={`Move ${item.title} up`}
                          onClick={() => onPlanAction?.("move-up", item.id)}
                          type="button"
                        >
                          <ArrowUp size={11} />
                        </button>
                        <button
                          aria-label={`Move ${item.title} down`}
                          onClick={() => onPlanAction?.("move-down", item.id)}
                          type="button"
                        >
                          <ChevronDown size={11} />
                        </button>
                        <button
                          aria-label={`Edit ${item.title}`}
                          onClick={() =>
                            setPlanEditor({
                              mode: "edit",
                              itemId: item.id,
                              value: item.title,
                            })
                          }
                          type="button"
                        >
                          <Edit3 size={11} />
                        </button>
                        <button
                          aria-label={`Remove ${item.title}`}
                          onClick={() => onPlanAction?.("remove", item.id)}
                          type="button"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </>
                  )}
                </article>
              ))
            ) : (
              <div className="gyro-plan-empty">
                <ListChecks size={18} />
                <strong>No plan yet</strong>
                <span>
                  Add steps here or let Gyro build the plan while it works.
                </span>
              </div>
            )}
          </div>
        </section>
      </aside>
    );
  }

  return (
    <aside
      className="gyro-environment-rail gyro-chat-tool-rail"
      aria-label="Environment"
    >
      <header>
        <div className="gyro-chat-tool-title">
          <HardDrive aria-hidden="true" size={15} />
          <div>
            <strong>Environment</strong>
            <span>{workspaceName(workspacePath)}</span>
          </div>
        </div>
        <button
          aria-label="Close environment"
          className="gyro-chat-tool-close"
          onClick={onClose}
          type="button"
        >
          <X size={14} />
        </button>
      </header>
      <ChatEnvironmentLauncher
        browserLabel={browserLabel}
        browserPreview={browserPreview}
        changedFiles={changedFiles}
        changesLabel={changesLabel}
        onOpenFiles={() => {
          onClose?.();
          onComposerAction?.("open-files");
        }}
        onOpenTool={openTool}
        onTogglePlan={onTogglePlanPanel}
        pendingDiffs={pendingDiffs}
        planExpanded={false}
        planItemCount={planItemCount}
        planLabel={planLabel}
        runningPanes={runningPanes}
        terminalLabel={terminalLabel}
        workspacePath={workspacePath}
      />
      {capabilityPolicy ? (
        <section
          className="gyro-capability-policy-summary"
          aria-label="Model capabilities"
        >
          <header>
            <ShieldCheck size={14} />
            <strong>Model capabilities</strong>
            <small>
              {capabilityActivities.filter((item) =>
                ["requested", "waiting", "running"].includes(item.status),
              ).length
                ? `${capabilityActivities.filter((item) => ["requested", "waiting", "running"].includes(item.status)).length} active`
                : `Policy ${capabilityPolicy.revision}`}
            </small>
          </header>
          <div>
            <span>Workspace</span>
            <strong>{capabilityPolicy.classes["workspace-inspect"]}</strong>
          </div>
          <div>
            <span>Terminal</span>
            <strong>{capabilityPolicy.classes["terminal-execute"]}</strong>
          </div>
          <div>
            <span>Local browser</span>
            <strong>{capabilityPolicy.classes["browser-navigate"]}</strong>
          </div>
        </section>
      ) : null}
    </aside>
  );
}

function ChatEnvironmentLauncher({
  browserLabel,
  browserPreview,
  changedFiles,
  changesLabel,
  onOpenFiles,
  onOpenTool,
  onTogglePlan,
  pendingDiffs,
  planExpanded,
  planItemCount,
  planLabel,
  runningPanes,
  terminalLabel,
  workspacePath,
}: {
  browserLabel: string;
  browserPreview?: BrowserPreview;
  changedFiles: number;
  changesLabel: string;
  onOpenFiles: () => void;
  onOpenTool: (tab: WorkbenchPaneTab) => void;
  onTogglePlan?: () => void;
  pendingDiffs: number;
  planExpanded: boolean;
  planItemCount: number;
  planLabel: string;
  runningPanes: number;
  terminalLabel: string;
  workspacePath?: string;
}) {
  return (
    <nav className="gyro-chat-tool-launcher" aria-label="Environment tools">
      <span className="gyro-chat-tool-section-label">Workspace tools</span>
      <button
        aria-label={`Open Changes, ${changesLabel}`}
        onClick={() => onOpenTool("diff")}
        className={
          pendingDiffs > 0 || changedFiles > 0 ? "has-activity" : undefined
        }
        type="button"
      >
        <GitPullRequest size={15} />
        <span>Changes</span>
        <small>{changesLabel}</small>
      </button>
      <button
        aria-label={`Open Terminal, ${terminalLabel}`}
        onClick={() => onOpenTool("terminal")}
        className={runningPanes > 0 ? "has-activity" : undefined}
        type="button"
      >
        <Terminal size={15} />
        <span>Terminal</span>
        <small>{terminalLabel}</small>
      </button>
      <button
        aria-label={`Open Browser, ${browserLabel}`}
        className={
          browserPreview?.status === "console-error" ||
          browserPreview?.status === "verification-failed"
            ? "has-warning"
            : browserPreview?.status === "loading"
              ? "has-activity"
              : undefined
        }
        onClick={() => onOpenTool("browser")}
        type="button"
      >
        <Globe2 size={15} />
        <span>Browser</span>
        <small>{browserLabel}</small>
      </button>
      <button
        aria-label={`Open files in Workspace, ${workspaceName(workspacePath)}`}
        onClick={onOpenFiles}
        type="button"
      >
        <Folder size={15} />
        <span>Files</span>
        <small>Open Workspace</small>
      </button>
      <button
        aria-expanded={planExpanded}
        aria-label={`${planExpanded ? "Collapse" : "Open"} Plan, ${planLabel}`}
        onClick={onTogglePlan}
        className={[
          planItemCount > 0 ? "has-activity" : "",
          planExpanded ? "is-active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        type="button"
      >
        <ListChecks size={15} />
        <span>Plan</span>
        <small>{planLabel}</small>
      </button>
    </nav>
  );
}

function chatToolBrowserStatusLabel(browserPreview?: BrowserPreview) {
  switch (browserPreview?.status) {
    case "loading":
      return "Loading";
    case "verification-passed":
      return "Verified";
    case "console-error": {
      const count = browserPreview.consoleErrors;
      return count > 0
        ? `${count} console ${count === 1 ? "error" : "errors"}`
        : "Console issue";
    }
    case "verification-failed":
      return "Needs attention";
    case "idle":
    case "ready":
    default:
      return "Ready";
  }
}

function nextPlanStatus(status: SessionPlanItemStatus): SessionPlanItemStatus {
  if (status === "todo") {
    return "in-progress";
  }
  if (status === "in-progress") {
    return "complete";
  }
  if (status === "complete") {
    return "todo";
  }
  return "todo";
}

function formatAttachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function planStatusLabel(status: SessionPlanItemStatus) {
  switch (status) {
    case "in-progress":
      return "doing";
    case "complete":
      return "done";
    case "blocked":
      return "blocked";
    case "todo":
    default:
      return "todo";
  }
}

type CliWorkspaceSurfaceProps = {
  files: WorkspaceFile[];
  selectedPath?: string;
  profiles: CommandProfile[];
  activeProfileId: string;
  activePaneTab: WorkbenchPaneTab;
  terminalPanes?: TerminalPane[];
  selectedTerminalPaneId?: string;
  terminalTemplate?: TerminalTemplate;
  tasks?: Task[];
  diffReview?: DiffReview;
  browserPreview?: BrowserPreview;
  terminalOutput: string;
  onSelectFile: (path: string) => void;
  onProfileChange: (profileId: string) => void;
  onPaneTabChange: (tab: WorkbenchPaneTab) => void;
  onRunProfile: () => void;
  onAddTerminalPane?: () => void;
  onOpenCommandPalette?: () => void;
  onSplitTerminalPane?: (template: TerminalTemplate) => void;
  onSelectTerminalPane?: (paneId: string) => void;
  onRenameTerminalPane?: (paneId: string) => void;
  onRestartTerminalPane?: (paneId: string) => void;
  onKillTerminalPane?: (paneId: string) => void;
  onTerminalTemplateChange?: (template: TerminalTemplate) => void;
  onTerminalUtilityAction?: (action: string) => void;
  onWriteTerminalInput?: (input: string) => void;
  onDispatchTask?: (taskId: string) => void;
  onSelectDiffFile?: (path: string) => void;
  onToggleDiffDirectory?: (directory: string) => void;
  onRunGitReviewAction?: (actionId: GitReviewActionId) => void;
  onAcceptDiffFile?: (path: string) => void;
  onRejectDiffFile?: (path: string) => void;
  onAcceptAllDiffs?: () => void;
  onRejectAllDiffs?: () => void;
  onUndoDiff?: () => void;
  onCommentDiff?: (path: string) => void;
  onOpenDiffInEditor?: (
    path: string,
    lineNumber?: number,
    column?: number,
  ) => void;
  onBrowserBack?: () => void;
  onBrowserForward?: () => void;
  onBrowserReload?: () => void;
  onBrowserUrlChange?: (url: string) => void;
  onBrowserNavigate?: (url: string) => void;
  onBrowserDeviceChange?: (device: BrowserPreviewDevice) => void;
  onBrowserScreenshot?: (action?: BrowserScreenshotAction) => void;
  onBrowserOpenExternal?: () => void;
};

export function CliWorkspaceSurface({
  files,
  selectedPath,
  profiles,
  activeProfileId,
  activePaneTab,
  terminalPanes,
  selectedTerminalPaneId,
  terminalTemplate = 4,
  tasks = [],
  diffReview,
  browserPreview,
  terminalOutput,
  onSelectFile,
  onProfileChange,
  onPaneTabChange,
  onRunProfile,
  onAddTerminalPane,
  onSplitTerminalPane,
  onSelectTerminalPane,
  onRenameTerminalPane,
  onRestartTerminalPane,
  onKillTerminalPane,
  onTerminalTemplateChange,
  onTerminalUtilityAction,
  onWriteTerminalInput,
  onDispatchTask,
  onSelectDiffFile,
  onToggleDiffDirectory,
  onRunGitReviewAction,
  onAcceptDiffFile,
  onRejectDiffFile,
  onAcceptAllDiffs,
  onRejectAllDiffs,
  onUndoDiff,
  onCommentDiff,
  onOpenDiffInEditor,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  onBrowserUrlChange,
  onBrowserNavigate,
  onBrowserDeviceChange,
  onBrowserScreenshot,
  onBrowserOpenExternal,
}: CliWorkspaceSurfaceProps) {
  const terminalProfiles = commandProfilesWithDefaults(profiles);
  const visibleTasks = tasks.length > 0 ? tasks : [];
  const panes = terminalPanes ?? [];
  const activePanes = panes.filter(terminalPaneHasActiveWork);

  return (
    <div className="gyro-cli-surface">
      <section className="gyro-cli-chat-pane" aria-label="CLI command rail">
        <header>
          <div>
            <strong>Terminal grid</strong>
            <span>
              {panes.length}/16 panes · {workspaceName(selectedPath)}
            </span>
          </div>
          <span
            className={
              activePanes.length > 0
                ? "gyro-live-pill is-running"
                : "gyro-live-pill"
            }
          >
            {activePanes.length > 0 ? "running" : "idle"}
          </span>
        </header>

        <div className="gyro-cli-context-stack">
          <div className="gyro-cli-status-card">
            <Terminal size={18} />
            <div>
              <strong>Command center</strong>
              <span>Repo: {workspaceName(selectedPath) || "Gyro"}</span>
            </div>
          </div>
          <div className="gyro-context-grid">
            <ContextMetric label="Agent" value="Codex CLI" tone="slate" />
            <ContextMetric label="Branch" value="not attached" />
            <ContextMetric label="Panes" value={`${panes.length}/16`} />
            <ContextMetric label="Approval" value="required" tone="amber" />
          </div>
          <div className="gyro-compact-section">
            <div className="gyro-mini-heading">Recent tasks</div>
            {visibleTasks.length > 0 ? (
              visibleTasks.slice(0, 3).map((task) => (
                <button
                  className="gyro-task-row-mini"
                  key={task.id}
                  onClick={() => onDispatchTask?.(task.id)}
                  type="button"
                >
                  <Activity size={14} />
                  <span>{task.title}</span>
                  <small>{task.status}</small>
                </button>
              ))
            ) : (
              <div className="gyro-empty-row">No CLI tasks yet</div>
            )}
          </div>
          <div className="gyro-compact-section">
            <div className="gyro-mini-heading">Running sessions</div>
            {panes.length > 0 ? (
              panes.map((session) => (
                <button
                  className={
                    session.id === selectedTerminalPaneId
                      ? "gyro-session-state-row is-active"
                      : "gyro-session-state-row"
                  }
                  key={session.id}
                  onClick={() => onSelectTerminalPane?.(session.id)}
                  type="button"
                >
                  <span className={`gyro-ring is-${session.status}`} />
                  <div>
                    <strong>{session.title}</strong>
                    <span>{session.profileId}</span>
                  </div>
                  <small>{session.status}</small>
                </button>
              ))
            ) : (
              <button
                className="gyro-empty-action-row"
                onClick={onAddTerminalPane}
                type="button"
              >
                <Plus size={14} />
                <span>Create first terminal</span>
              </button>
            )}
          </div>
          <div className="gyro-mini-file-list">
            <div className="gyro-mini-heading">Workspace files</div>
            {files.length === 0 ? (
              <div className="gyro-muted-note">
                Open a workspace to show files here.
              </div>
            ) : (
              files.slice(0, 7).map((file) => (
                <button
                  className={
                    file.path === selectedPath
                      ? "gyro-mini-file-row is-active"
                      : "gyro-mini-file-row"
                  }
                  key={file.path}
                  onClick={() => onSelectFile(file.path)}
                  type="button"
                >
                  {file.kind === "directory" ? (
                    <Folder size={14} />
                  ) : (
                    <FileText size={14} />
                  )}
                  <span>{file.path}</span>
                </button>
              ))
            )}
          </div>
          <div className="gyro-compact-section">
            <div className="gyro-mini-heading">Grid templates</div>
            <div className="gyro-template-picker" aria-label="Pane templates">
              {([1, 2, 4, 6, 8, 12, 16] as TerminalTemplate[]).map((count) => (
                <button
                  className={count === terminalTemplate ? "is-active" : ""}
                  key={count}
                  onClick={() => onTerminalTemplateChange?.(count)}
                  type="button"
                >
                  {count}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="gyro-workbench-pane" aria-label="Workbench panes">
        <WorkbenchPaneTabs
          activeTab={activePaneTab}
          onAddPane={onAddTerminalPane}
          onTabChange={onPaneTabChange}
        />
        <WorkbenchPaneContent
          activePaneTab={activePaneTab}
          activeProfileId={activeProfileId}
          browserPreview={browserPreview}
          diffReview={diffReview}
          selectedTerminalPaneId={selectedTerminalPaneId}
          terminalPanes={terminalPanes}
          terminalTemplate={terminalTemplate}
          onAcceptAllDiffs={onAcceptAllDiffs}
          onAcceptDiffFile={onAcceptDiffFile}
          onProfileChange={onProfileChange}
          onRunProfile={onRunProfile}
          onAddTerminalPane={onAddTerminalPane}
          onBrowserBack={onBrowserBack}
          onBrowserDeviceChange={onBrowserDeviceChange}
          onBrowserForward={onBrowserForward}
          onBrowserNavigate={onBrowserNavigate}
          onBrowserOpenExternal={onBrowserOpenExternal}
          onBrowserReload={onBrowserReload}
          onBrowserScreenshot={onBrowserScreenshot}
          onBrowserUrlChange={onBrowserUrlChange}
          onCommentDiff={onCommentDiff}
          onKillTerminalPane={onKillTerminalPane}
          onOpenDiffInEditor={onOpenDiffInEditor}
          profiles={terminalProfiles}
          onRejectAllDiffs={onRejectAllDiffs}
          onRejectDiffFile={onRejectDiffFile}
          onRenameTerminalPane={onRenameTerminalPane}
          onRestartTerminalPane={onRestartTerminalPane}
          onSelectDiffFile={onSelectDiffFile}
          onToggleDiffDirectory={onToggleDiffDirectory}
          onRunGitReviewAction={onRunGitReviewAction}
          onSelectTerminalPane={onSelectTerminalPane}
          onSplitTerminalPane={onSplitTerminalPane}
          onTerminalUtilityAction={onTerminalUtilityAction}
          onWriteTerminalInput={onWriteTerminalInput}
          onUndoDiff={onUndoDiff}
          terminalOutput={terminalOutput}
        />
      </section>
    </div>
  );
}

type IdeSurfaceProps = {
  files: WorkspaceFile[];
  ide?: IdeState;
  workspacePath?: string;
  selectedPath?: string;
  fileContent?: WorkspaceFileContent;
  fileError?: string;
  fileLoadState?: "idle" | "loading" | "ready" | "error";
  editorTabs?: EditorTab[];
  activeBuffer?: EditorBuffer;
  editorSelection?: EditorSelection;
  editorRevealTarget?: EditorRevealTarget;
  onOpenWorkspace?: () => void;
  onSelectFile: (path: string) => void;
  onPinEditorTab?: (path: string) => void;
  onSelectEditorGroup?: (groupId: string) => void;
  onMoveEditorTab?: (
    path: string,
    toGroupId: string,
    fromGroupId?: string,
  ) => void;
  onSplitEditorGroup?: (direction: "right" | "down") => void;
  onCloseEditorGroup?: (groupId: string) => void;
  onToggleMinimap?: () => void;
  onToggleAssistant?: () => void;
  onCloseEditorTab?: (path: string, groupId?: string) => void;
  onEditorChange?: (path: string, content: string) => void;
  onEditorSave?: (path: string) => void;
  onEditorRevert?: (path: string) => void;
  onEditorSelectionChange?: (selection?: EditorSelection) => void;
  onAssistantAction?: (action: IdeAssistantAction, instruction: string) => void;
  renderEditor?: (props: {
    buffer?: EditorBuffer;
    fileContent?: WorkspaceFileContent;
    loadState: "idle" | "loading" | "ready" | "error";
    path?: string;
    onChange: (value: string) => void;
    onSelectionChange: (selection?: EditorSelection) => void;
    minimapEnabled: boolean;
    revealTarget?: EditorRevealTarget;
  }) => ReactNode;
  terminalOutput: string;
  activePaneTab: WorkbenchPaneTab;
  terminalPanes?: TerminalPane[];
  selectedTerminalPaneId?: string;
  terminalTemplate?: TerminalTemplate;
  diffReview?: DiffReview;
  browserPreview?: BrowserPreview;
  showEmbeddedPanel?: boolean;
  onPaneTabChange: (tab: WorkbenchPaneTab) => void;
  onSelectTerminalPane?: (paneId: string) => void;
  onRenameTerminalPane?: (paneId: string) => void;
  onAddTerminalPane?: () => void;
  onSplitTerminalPane?: (template: TerminalTemplate) => void;
  onRestartTerminalPane?: (paneId: string) => void;
  onKillTerminalPane?: (paneId: string) => void;
  onTerminalUtilityAction?: (action: string) => void;
  onWriteTerminalInput?: (input: string) => void;
  onSelectDiffFile?: (path: string) => void;
  onToggleDiffDirectory?: (directory: string) => void;
  onRunGitReviewAction?: (actionId: GitReviewActionId) => void;
  onAcceptDiffFile?: (path: string) => void;
  onRejectDiffFile?: (path: string) => void;
  onAcceptAllDiffs?: () => void;
  onRejectAllDiffs?: () => void;
  onUndoDiff?: () => void;
  onCommentDiff?: (path: string) => void;
  onOpenDiffInEditor?: (
    path: string,
    lineNumber?: number,
    column?: number,
  ) => void;
  onBrowserBack?: () => void;
  onBrowserForward?: () => void;
  onBrowserReload?: () => void;
  onBrowserUrlChange?: (url: string) => void;
  onBrowserNavigate?: (url: string) => void;
  onBrowserDeviceChange?: (device: BrowserPreviewDevice) => void;
  onBrowserScreenshot?: (action?: BrowserScreenshotAction) => void;
  onBrowserOpenExternal?: () => void;
};

export function IdeSurface({
  files,
  ide,
  workspacePath,
  selectedPath,
  fileContent,
  fileError = "",
  fileLoadState = "idle",
  editorTabs,
  activeBuffer,
  editorSelection,
  editorRevealTarget,
  onOpenWorkspace,
  onSelectFile,
  onPinEditorTab,
  onSelectEditorGroup,
  onMoveEditorTab,
  onSplitEditorGroup,
  onCloseEditorGroup,
  onToggleMinimap,
  onToggleAssistant,
  onCloseEditorTab,
  onEditorChange,
  onEditorSave,
  onEditorRevert,
  onEditorSelectionChange,
  onAssistantAction,
  renderEditor,
  terminalOutput,
  activePaneTab,
  terminalPanes,
  selectedTerminalPaneId,
  terminalTemplate,
  diffReview,
  browserPreview,
  showEmbeddedPanel = true,
  onPaneTabChange,
  onSelectTerminalPane,
  onRenameTerminalPane,
  onAddTerminalPane,
  onSplitTerminalPane,
  onRestartTerminalPane,
  onKillTerminalPane,
  onTerminalUtilityAction,
  onWriteTerminalInput,
  onSelectDiffFile,
  onToggleDiffDirectory,
  onRunGitReviewAction,
  onAcceptDiffFile,
  onRejectDiffFile,
  onAcceptAllDiffs,
  onRejectAllDiffs,
  onUndoDiff,
  onCommentDiff,
  onOpenDiffInEditor,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  onBrowserUrlChange,
  onBrowserNavigate,
  onBrowserDeviceChange,
  onBrowserScreenshot,
  onBrowserOpenExternal,
}: IdeSurfaceProps) {
  const fallbackGroup: EditorGroup = {
    id: "group-main",
    title: "Main",
    activePath: selectedPath,
    tabs: editorTabs ?? [],
    panes: [{ id: "group-main-pane", path: selectedPath }],
  };
  const editorGroups = ide?.layout.groups.length
    ? ide.layout.groups
    : [fallbackGroup];
  const activeGroupId = ide?.layout.activeGroupId ?? editorGroups[0]?.id;
  const [assistantDraft, setAssistantDraft] = useState("");

  if (!workspacePath) {
    return (
      <div className="gyro-ide-surface is-workspace-shell is-project-empty">
        <section
          aria-labelledby="gyro-ide-project-empty-title"
          className="gyro-ide-project-empty"
        >
          <span className="gyro-ide-project-empty-eyebrow">
            <Sparkles size={12} />
            Workspace
          </span>
          <div aria-hidden="true" className="gyro-ide-project-empty-icon">
            <Folder size={22} />
          </div>
          <div className="gyro-ide-project-empty-copy">
            <h1 id="gyro-ide-project-empty-title">
              Open a project to start coding
            </h1>
            <p>
              Gyro keeps files, Git state, terminals, and agent context tied to
              one local project.
            </p>
          </div>
          <button onClick={onOpenWorkspace} type="button">
            <Folder size={15} />
            Open a project
          </button>
          <div
            className="gyro-ide-project-empty-features"
            aria-label="Local workspace · guarded edits · reviewable changes"
          >
            <span>
              <HardDrive size={12} /> Local files
            </span>
            <span>
              <ShieldCheck size={12} /> Guarded edits
            </span>
            <span>
              <GitPullRequest size={12} /> Reviewable changes
            </span>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div
      className={[
        "gyro-ide-surface",
        showEmbeddedPanel ? "is-embedded" : "is-workspace-shell",
      ].join(" ")}
    >
      {showEmbeddedPanel ? (
        <nav className="gyro-ide-activitybar" aria-label="Workspace views">
          <button
            aria-current="page"
            className="is-active"
            disabled
            title="Explorer"
            type="button"
          >
            <FileText size={17} />
          </button>
          <button
            onClick={() => onPaneTabChange("diff")}
            title="Diff"
            type="button"
          >
            <GitPullRequest size={17} />
          </button>
          <button
            onClick={() => onPaneTabChange("terminal")}
            title="Terminal"
            type="button"
          >
            <Terminal size={17} />
          </button>
          <button
            onClick={() => onPaneTabChange("browser")}
            title="Preview"
            type="button"
          >
            <Globe2 size={17} />
          </button>
        </nav>
      ) : null}
      {showEmbeddedPanel ? (
        <FileTree
          files={files}
          onSelectFile={onSelectFile}
          selectedPath={selectedPath}
        />
      ) : null}
      <div
        className={[
          "gyro-ide-editor-stack",
          showEmbeddedPanel ? "" : "is-editor-only",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div
          className={`gyro-editor-groups is-split-${ide?.layout.splitDirection ?? "right"}`}
          data-group-count={editorGroups.length}
        >
          {editorGroups.map((group) => {
            const groupPath =
              group.activePath ??
              (group.id === activeGroupId ? selectedPath : undefined);
            const groupBuffer = groupPath
              ? (ide?.buffers[groupPath] ??
                (groupPath === activeBuffer?.path ? activeBuffer : undefined))
              : undefined;
            return (
              <EditorGroupPane
                activeBuffer={groupBuffer}
                activePath={groupPath}
                fileContent={
                  fileContent?.path === groupPath ? fileContent : undefined
                }
                fileError={fileError}
                fileLoadState={
                  groupBuffer
                    ? "ready"
                    : groupPath === selectedPath
                      ? fileLoadState
                      : "idle"
                }
                filesAvailable={files.length > 0}
                group={group}
                groupCount={editorGroups.length}
                isActive={group.id === activeGroupId}
                key={group.id}
                minimapEnabled={ide?.layout.minimapEnabled !== false}
                onActivate={() => onSelectEditorGroup?.(group.id)}
                onAssistantAction={onAssistantAction}
                onCloseGroup={() => onCloseEditorGroup?.(group.id)}
                onCloseTab={(path) => onCloseEditorTab?.(path, group.id)}
                onEditorChange={onEditorChange}
                onEditorRevert={onEditorRevert}
                onEditorSave={onEditorSave}
                onEditorSelectionChange={onEditorSelectionChange}
                onMoveTab={(path, fromGroupId) =>
                  onMoveEditorTab?.(path, group.id, fromGroupId)
                }
                onPinTab={onPinEditorTab}
                onSelectFile={(path) => {
                  onSelectEditorGroup?.(group.id);
                  onSelectFile(path);
                }}
                onSplitEditorGroup={onSplitEditorGroup}
                onToggleAssistant={onToggleAssistant}
                onToggleMinimap={onToggleMinimap}
                renderEditor={renderEditor}
                revealTarget={
                  editorRevealTarget?.path === groupPath
                    ? editorRevealTarget
                    : undefined
                }
                selection={
                  editorSelection?.path === groupPath
                    ? editorSelection
                    : undefined
                }
              />
            );
          })}
        </div>
        {!showEmbeddedPanel && ide?.layout.rightAssistantOpen ? (
          <aside
            className="gyro-ide-assistant"
            aria-label="Editor AI companion"
          >
            <header>
              <div>
                <Bot size={15} />
                <strong>AI Companion</strong>
              </div>
              <button
                aria-label="Close AI companion"
                onClick={onToggleAssistant}
                type="button"
              >
                <X size={14} />
              </button>
            </header>
            <div className="gyro-ide-assistant-context">
              <span>Context</span>
              <strong>{selectedPath ?? "No active file"}</strong>
              <small>
                {editorSelection?.text
                  ? `${editorSelection.text.length} selected characters`
                  : `${editorTabs?.length ?? 0} open files`}
              </small>
            </div>
            <div className="gyro-ide-assistant-history">
              {ide.lastAssistantRequest ? (
                <div>
                  <Sparkles size={14} />
                  <span>
                    {ide.lastAssistantRequest.action.replaceAll("-", " ")}
                  </span>
                  <small>Sent to the session timeline</small>
                </div>
              ) : (
                <p>Ask about the active file or selected code.</p>
              )}
              {ide.aiToolCalls.slice(-4).map((toolCall) => (
                <div key={toolCall.id}>
                  <Activity size={14} />
                  <span>{toolCall.name}</span>
                  <small>{toolCall.status}</small>
                </div>
              ))}
            </div>
            <form
              className="gyro-ide-assistant-composer"
              onSubmit={(event) => {
                event.preventDefault();
                const instruction = assistantDraft.trim();
                if (!instruction) {
                  return;
                }
                onAssistantAction?.(
                  editorSelection?.text
                    ? "explain-selection"
                    : "ask-about-file",
                  instruction,
                );
                setAssistantDraft("");
              }}
            >
              <textarea
                aria-label="Ask AI about editor context"
                onChange={(event) => setAssistantDraft(event.target.value)}
                placeholder="Ask about this code"
                rows={4}
                value={assistantDraft}
              />
              <div>
                <button
                  disabled={!selectedPath || !assistantDraft.trim()}
                  type="submit"
                >
                  <Sparkles size={14} />
                  Ask
                </button>
                <button
                  disabled={!editorSelection?.text}
                  onClick={() =>
                    onAssistantAction?.(
                      "fix-selection",
                      assistantDraft.trim() ||
                        "Fix the selected code and propose a reviewable diff.",
                    )
                  }
                  type="button"
                >
                  <Edit3 size={14} />
                  Propose fix
                </button>
              </div>
            </form>
          </aside>
        ) : null}
        {showEmbeddedPanel ? (
          <section
            className="gyro-workbench-pane is-compact"
            aria-label="Workspace panel"
          >
            <IdeRailTabs
              activeTab={activePaneTab}
              onTabChange={onPaneTabChange}
            />
            <WorkbenchPaneContent
              activePaneTab={activePaneTab}
              activeProfileId="shell"
              browserPreview={browserPreview}
              diffReview={diffReview}
              ide={ide}
              selectedTerminalPaneId={selectedTerminalPaneId}
              terminalPanes={terminalPanes}
              terminalTemplate={terminalTemplate}
              onAcceptAllDiffs={onAcceptAllDiffs}
              onAcceptDiffFile={onAcceptDiffFile}
              onAddTerminalPane={onAddTerminalPane}
              onBrowserBack={onBrowserBack}
              onBrowserDeviceChange={onBrowserDeviceChange}
              onBrowserForward={onBrowserForward}
              onBrowserNavigate={onBrowserNavigate}
              onBrowserOpenExternal={onBrowserOpenExternal}
              onBrowserReload={onBrowserReload}
              onBrowserScreenshot={onBrowserScreenshot}
              onBrowserUrlChange={onBrowserUrlChange}
              onCommentDiff={onCommentDiff}
              onKillTerminalPane={onKillTerminalPane}
              onOpenDiffInEditor={onOpenDiffInEditor}
              onProfileChange={() => undefined}
              onRejectAllDiffs={onRejectAllDiffs}
              onRejectDiffFile={onRejectDiffFile}
              onRenameTerminalPane={onRenameTerminalPane}
              onRestartTerminalPane={onRestartTerminalPane}
              onRunProfile={() => undefined}
              onSelectDiffFile={onSelectDiffFile}
              onSelectTerminalPane={onSelectTerminalPane}
              onSplitTerminalPane={onSplitTerminalPane}
              onTerminalUtilityAction={onTerminalUtilityAction}
              onToggleDiffDirectory={onToggleDiffDirectory}
              onUndoDiff={onUndoDiff}
              onWriteTerminalInput={onWriteTerminalInput}
              profiles={[]}
              terminalOutput={terminalOutput}
            />
          </section>
        ) : null}
        {showEmbeddedPanel ? (
          <IdeStatusBar
            activeBuffer={activeBuffer}
            editorSelection={editorSelection}
            fileContent={fileContent}
            fileLoadState={fileLoadState}
            groupCount={editorGroups.length}
            ide={ide}
            selectedPath={selectedPath}
          />
        ) : null}
      </div>
    </div>
  );
}

export function IdeStatusBar({
  ide,
  activeBuffer,
  editorSelection,
  fileContent,
  fileLoadState = "idle",
  groupCount = 1,
  selectedPath,
}: {
  ide?: IdeState;
  activeBuffer?: EditorBuffer;
  editorSelection?: EditorSelection;
  fileContent?: WorkspaceFileContent;
  fileLoadState?: "idle" | "loading" | "ready" | "error";
  groupCount?: number;
  selectedPath?: string;
}) {
  const diagnosticsCount = ide?.diagnostics.length ?? 0;
  const languageServer = ide?.languageServers?.find(
    (server) => server.activePath === selectedPath,
  );
  const fileSize = activeBuffer
    ? `${formatBytes(activeBuffer.sizeBytes)}${activeBuffer.truncated ? " preview" : ""}`
    : fileContent
      ? `${formatBytes(fileContent.sizeBytes)}${fileContent.truncated ? " preview" : ""}`
      : selectedPath
        ? "No preview"
        : "No file";

  return (
    <footer className="gyro-editor-statusbar" aria-label="Workspace status">
      <div className="gyro-editor-statusbar-group is-primary">
        <span title="Current Git branch">
          <GitBranch size={12} />
          {ide?.sourceControl.branch ?? "No branch"}
        </span>
        <span
          className="gyro-editor-buffer-state"
          data-state={activeBuffer?.status ?? fileLoadState}
        >
          {activeBuffer?.status ?? fileLoadState}
        </span>
        <span title={`${diagnosticsCount} workspace diagnostics`}>
          <CircleDashed size={11} />
          {diagnosticsCount} {diagnosticsCount === 1 ? "problem" : "problems"}
        </span>
      </div>
      <div className="gyro-editor-statusbar-group is-secondary">
        {groupCount > 1 ? <span>{groupCount} groups</span> : null}
        <span>{fileSize}</span>
        {editorSelection?.text ? (
          <span>{editorSelection.text.length} selected</span>
        ) : null}
        {languageServer ? <span>{languageServer.status} LSP</span> : null}
        <span>UTF-8</span>
      </div>
    </footer>
  );
}

type EditorGroupPaneProps = {
  group: EditorGroup;
  groupCount: number;
  isActive: boolean;
  activePath?: string;
  activeBuffer?: EditorBuffer;
  selection?: EditorSelection;
  revealTarget?: EditorRevealTarget;
  fileContent?: WorkspaceFileContent;
  fileError: string;
  fileLoadState: "idle" | "loading" | "ready" | "error";
  filesAvailable: boolean;
  minimapEnabled: boolean;
  onActivate: () => void;
  onSelectFile: (path: string) => void;
  onMoveTab?: (path: string, fromGroupId?: string) => void;
  onPinTab?: (path: string) => void;
  onCloseTab?: (path: string) => void;
  onCloseGroup: () => void;
  onSplitEditorGroup?: (direction: "right" | "down") => void;
  onToggleMinimap?: () => void;
  onToggleAssistant?: () => void;
  onEditorChange?: (path: string, content: string) => void;
  onEditorSave?: (path: string) => void;
  onEditorRevert?: (path: string) => void;
  onEditorSelectionChange?: (selection?: EditorSelection) => void;
  onAssistantAction?: (action: IdeAssistantAction, instruction: string) => void;
  renderEditor?: IdeSurfaceProps["renderEditor"];
};

function EditorGroupPane({
  group,
  groupCount,
  isActive,
  activePath,
  activeBuffer,
  selection,
  revealTarget,
  fileContent,
  fileError,
  fileLoadState,
  filesAvailable,
  minimapEnabled,
  onActivate,
  onSelectFile,
  onMoveTab,
  onPinTab,
  onCloseTab,
  onCloseGroup,
  onSplitEditorGroup,
  onToggleMinimap,
  onToggleAssistant,
  onEditorChange,
  onEditorSave,
  onEditorRevert,
  onEditorSelectionChange,
  onAssistantAction,
  renderEditor,
}: EditorGroupPaneProps) {
  const canSave = activeBuffer?.status === "dirty";
  const selectedText = selection?.text.trim();

  return (
    <section
      aria-label={`Editor group ${group.title}`}
      className={`gyro-editor-pane ${isActive ? "is-active-group" : ""}`}
      onMouseDown={onActivate}
    >
      <div
        className="gyro-editor-tabs"
        onDragOver={(event) => {
          if (
            event.dataTransfer.types.includes("application/x-gyro-editor-tab")
          ) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(event) => {
          const path = event.dataTransfer.getData(
            "application/x-gyro-editor-tab",
          );
          if (!path) {
            return;
          }
          event.preventDefault();
          onMoveTab?.(
            path,
            event.dataTransfer.getData("application/x-gyro-editor-group") ||
              undefined,
          );
        }}
      >
        {group.tabs.length > 0 ? (
          group.tabs.map((tab) => (
            <button
              className={[
                activePath === tab.path ? "is-active" : "",
                tab.dirty ? "is-dirty" : "",
                tab.preview && !tab.pinned ? "is-preview" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              draggable
              key={tab.path}
              onClick={() => onSelectFile(tab.path)}
              onDoubleClick={() => onPinTab?.(tab.path)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(
                  "application/x-gyro-editor-tab",
                  tab.path,
                );
                event.dataTransfer.setData(
                  "application/x-gyro-editor-group",
                  group.id,
                );
              }}
              type="button"
            >
              <FileCode2 size={14} />
              <span>{tab.title || workspaceName(tab.path)}</span>
              <span
                aria-label={`Close ${tab.title || workspaceName(tab.path)}`}
                className="gyro-editor-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab?.(tab.path);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseTab?.(tab.path);
                }}
                role="button"
                tabIndex={0}
              >
                <X size={12} />
                {tab.dirty ? <i aria-hidden="true" /> : null}
              </span>
            </button>
          ))
        ) : (
          <button className="is-active" disabled type="button">
            <FileCode2 size={14} />
            <span>No file selected</span>
          </button>
        )}
        {groupCount > 1 ? (
          <span className="gyro-preview-tag">{group.title}</span>
        ) : null}
        <div className="gyro-editor-tab-actions">
          <button
            aria-label="Split editor right"
            disabled={!activePath}
            onClick={() => onSplitEditorGroup?.("right")}
            title="Split editor right"
            type="button"
          >
            <PanelRight size={14} />
          </button>
          <button
            aria-label="Split editor down"
            disabled={!activePath}
            onClick={() => onSplitEditorGroup?.("down")}
            title="Split editor down"
            type="button"
          >
            <PanelBottom size={14} />
          </button>
          <button
            aria-label="Toggle minimap"
            onClick={onToggleMinimap}
            title="Toggle minimap"
            type="button"
          >
            <Activity size={14} />
          </button>
          <button
            aria-label="Toggle AI companion"
            onClick={onToggleAssistant}
            title="Toggle AI companion"
            type="button"
          >
            <Bot size={14} />
          </button>
          <button
            aria-label="Revert file"
            disabled={!activeBuffer}
            onClick={() => activePath && onEditorRevert?.(activePath)}
            title="Revert file"
            type="button"
          >
            <RefreshCw size={14} />
          </button>
          <button
            aria-label="Save file"
            disabled={!canSave}
            onClick={() => activePath && onEditorSave?.(activePath)}
            title="Save file"
            type="button"
          >
            <Check size={14} />
          </button>
          {groupCount > 1 ? (
            <button
              aria-label={`Close editor group ${group.title}`}
              onClick={onCloseGroup}
              title="Close editor group"
              type="button"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="gyro-editor-contextbar">
        <div className="gyro-breadcrumb-row">
          {activePath ? (
            <>
              {parentSegments(activePath).map((segment) => (
                <span key={segment}>{segment}</span>
              ))}
              {parentSegments(activePath).length > 0 ? (
                <ChevronRight size={13} />
              ) : null}
              <strong>{workspaceName(activePath)}</strong>
            </>
          ) : (
            <strong>No workspace file loaded</strong>
          )}
        </div>
        <div className="gyro-editor-ai-bar" aria-label="Editor AI actions">
          <button
            disabled={!activePath}
            onClick={() =>
              onAssistantAction?.(
                "ask-about-file",
                `Explain ${activePath ?? "this file"} in this workspace.`,
              )
            }
            title="Ask about file"
            type="button"
          >
            <Bot size={13} />
            <span>Ask</span>
          </button>
          <button
            disabled={!selectedText}
            onClick={() =>
              onAssistantAction?.(
                "explain-selection",
                "Explain the selected code and call out important dependencies.",
              )
            }
            title="Explain selection"
            type="button"
          >
            <Sparkles size={13} />
            <span>Explain</span>
          </button>
          <button
            disabled={!selectedText}
            onClick={() =>
              onAssistantAction?.(
                "fix-selection",
                "Fix the selected code and propose a diff for review.",
              )
            }
            title="Fix selection"
            type="button"
          >
            <Edit3 size={13} />
            <span>Fix</span>
          </button>
          <button
            disabled={!activePath}
            onClick={() =>
              onAssistantAction?.(
                "refactor-file",
                "Refactor this file conservatively and propose a diff.",
              )
            }
            title="Refactor file"
            type="button"
          >
            <FileCode2 size={13} />
            <span>Refactor</span>
          </button>
          <button
            disabled={!activePath}
            onClick={() =>
              onAssistantAction?.(
                "generate-tests",
                "Generate or update focused tests for this file.",
              )
            }
            title="Generate tests"
            type="button"
          >
            <ListChecks size={13} />
            <span>Tests</span>
          </button>
        </div>
      </div>
      <div className="gyro-code-surface" role="img" aria-label="Code editor">
        {renderEditor ? (
          renderEditor({
            buffer: activeBuffer,
            fileContent,
            loadState: fileLoadState,
            minimapEnabled,
            path: activePath,
            revealTarget,
            onChange: (value) => {
              if (activePath) {
                onEditorChange?.(activePath, value);
              }
            },
            onSelectionChange: onEditorSelectionChange ?? (() => undefined),
          })
        ) : fileLoadState === "loading" ? (
          <div className="gyro-code-empty">Loading file preview...</div>
        ) : fileLoadState === "error" ? (
          <div className="gyro-code-empty">
            {fileError || "File preview failed."}
          </div>
        ) : activePath && fileContent?.path === activePath ? (
          <pre>
            <code>{fileContent.content}</code>
          </pre>
        ) : (
          <div className="gyro-code-empty">
            {filesAvailable
              ? "Select a workspace file to preview it here."
              : "Open a workspace file to preview it here."}
          </div>
        )}
      </div>
    </section>
  );
}

type FileTreeProps = {
  files: WorkspaceFile[];
  selectedPath?: string;
  onSelectFile: (path: string) => void;
};

export function FileTree({ files, selectedPath, onSelectFile }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const visibleFiles = files.filter((file) => {
    const parents = workspaceAncestorPaths(file.path);
    return parents.every((parent) => expanded.has(parent));
  });
  const toggleDirectory = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <section className="gyro-panel gyro-file-tree" aria-label="Files">
      <header>
        <Folder size={16} />
        <span>Files</span>
      </header>
      <div className="gyro-panel-body">
        {files.length === 0 ? (
          <div className="gyro-empty-row">
            Open a workspace to inspect files
          </div>
        ) : (
          visibleFiles.map((file) => (
            <button
              className={
                file.path === selectedPath
                  ? "gyro-file-row is-active"
                  : "gyro-file-row"
              }
              key={file.path}
              onClick={() =>
                file.kind === "directory"
                  ? toggleDirectory(file.path)
                  : onSelectFile(file.path)
              }
              style={{
                paddingLeft: `${Math.max((file.depth ?? parentSegments(file.path).length + 1) - 1, 0) * 12 + 10}px`,
              }}
              type="button"
            >
              {file.kind === "directory" ? (
                expanded.has(file.path) ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )
              ) : (
                <FileText size={14} />
              )}
              <span>{file.path}</span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

type ChatThreadProps = {
  events: SessionEvent[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
};

export function ChatThread({
  events,
  draft,
  onDraftChange,
  onSend,
}: ChatThreadProps) {
  return (
    <ChatSurface
      config={{
        commandProfiles: [],
        modelProviders: [],
        requireCommandApproval: true,
        requireFileEditApproval: true,
        telemetryEnabled: false,
      }}
      draft={draft}
      events={events}
      onDraftChange={onDraftChange}
      onSend={onSend}
    />
  );
}

type DiffPreviewProps = {
  preview: string;
  pendingApproval: boolean;
  onApprove: () => void;
  onReject: () => void;
};

export function DiffPreview({
  preview,
  pendingApproval,
  onApprove,
  onReject,
}: DiffPreviewProps) {
  return (
    <section className="gyro-panel gyro-diff" aria-label="Diff">
      <header>
        <GitPullRequest size={16} />
        <span>Diff</span>
      </header>
      <pre>{preview || "No proposed file edits yet."}</pre>
      <footer>
        <button
          className="gyro-secondary-button"
          disabled={!pendingApproval}
          onClick={onReject}
          type="button"
        >
          Reject
        </button>
        <button
          className="gyro-primary-button"
          disabled={!pendingApproval}
          onClick={onApprove}
          type="button"
        >
          <Check size={15} />
          Approve
        </button>
      </footer>
    </section>
  );
}

type TerminalPanelProps = {
  profiles: CommandProfile[];
  activeProfileId: string;
  cliLaunchPreset?: CliLaunchPreset;
  isLaunchingCliPreset?: boolean;
  terminalPanes?: TerminalPane[];
  selectedTerminalPaneId?: string;
  terminalTemplate?: TerminalTemplate;
  output: string;
  terminalSourceControl?: SourceControlState;
  isTerminalSourceControlLoading?: boolean;
  onProfileChange: (profileId: string) => void;
  onRunCommandProfile?: (profileId: string) => void;
  onLaunchCliPreset?: () => void;
  onRunProfile: () => void;
  onAddTerminalPane?: () => void;
  onOpenCommandPalette?: () => void;
  onSplitTerminalPane?: (template: TerminalTemplate) => void;
  onSelectTerminalPane?: (paneId: string) => void;
  onMoveTerminalPane?: (sourcePaneId: string, targetPaneId: string) => void;
  onSetTerminalPaneLayout?: (
    paneId: string,
    layout: TerminalPaneLayout,
  ) => void;
  onRenameTerminalPane?: (paneId: string) => void;
  onRestartTerminalPane?: (paneId: string) => void;
  onKillTerminalPane?: (paneId: string) => void;
  onCloseTerminalPane?: (paneId: string) => void;
  onTerminalUtilityAction?: (action: string) => void;
  onRefreshTerminalSourceControl?: () => void;
  onReviewTerminalChanges?: (file?: SourceControlFile) => void;
  onWriteTerminalInput?: (input: string) => void;
  renderTerminalPaneBody?: (pane: TerminalPane) => ReactNode;
};

function TerminalDiffControl({
  isLoading,
  onRefresh,
  onReview,
  sourceControl,
}: {
  isLoading?: boolean;
  onRefresh?: () => void;
  onReview?: (file?: SourceControlFile) => void;
  sourceControl?: SourceControlState;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useOutsidePointerDismiss<HTMLDivElement>(isOpen, () =>
    setIsOpen(false),
  );
  if (!isLoading && !sourceControl?.available) {
    return null;
  }

  const isClean =
    Boolean(sourceControl?.available) &&
    sourceControl?.files.length === 0 &&
    sourceControl.additions === 0 &&
    sourceControl.deletions === 0;
  const files = sourceControl?.files.slice(0, 6) ?? [];
  return (
    <div className="gyro-terminal-diff-control" ref={menuRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={
          isLoading && !sourceControl
            ? "Checking Git changes"
            : isClean
              ? "Working tree clean"
              : `${sourceControl?.additions ?? 0} additions, ${sourceControl?.deletions ?? 0} deletions`
        }
        className={
          isLoading && !sourceControl
            ? "is-loading"
            : isClean
              ? "is-clean"
              : "has-changes"
        }
        onClick={() => setIsOpen((current) => !current)}
        title={sourceControl?.branch ?? "Git changes"}
        type="button"
      >
        {isLoading && !sourceControl ? (
          <CircleDashed className="is-spinning" size={14} />
        ) : isClean ? (
          <Check size={14} />
        ) : (
          <GitBranch size={14} />
        )}
        <span className="gyro-terminal-diff-clean">Clean</span>
        <span className="gyro-terminal-diff-stats">
          <strong>+{sourceControl?.additions ?? 0}</strong>
          <em>-{sourceControl?.deletions ?? 0}</em>
        </span>
      </button>
      {isOpen && sourceControl ? (
        <section
          aria-label="Terminal workspace changes"
          className="gyro-terminal-diff-popover"
          role="dialog"
        >
          <header>
            <div>
              <strong>Changes</strong>
              <span>{sourceControl.branch ?? "Git workspace"}</span>
            </div>
            <button
              aria-label="Refresh changes"
              disabled={isLoading}
              onClick={onRefresh}
              title="Refresh changes"
              type="button"
            >
              <RefreshCw className={isLoading ? "is-spinning" : ""} size={14} />
            </button>
          </header>
          <div className="gyro-terminal-diff-summary">
            <span>{sourceControl.files.length} files</span>
            <strong>+{sourceControl.additions}</strong>
            <em>-{sourceControl.deletions}</em>
            {sourceControl.statsPartial ? <small>partial</small> : null}
          </div>
          <div className="gyro-terminal-diff-files">
            {files.length > 0 ? (
              files.map((file) => (
                <button
                  key={`${file.path}:${file.staged}`}
                  onClick={() => {
                    onReview?.(file);
                    setIsOpen(false);
                  }}
                  title={file.path}
                  type="button"
                >
                  <span>{workspaceName(file.path)}</span>
                  <small>{file.state}</small>
                  <strong>+{file.additions}</strong>
                  <em>-{file.deletions}</em>
                </button>
              ))
            ) : (
              <div className="gyro-terminal-diff-empty">Working tree clean</div>
            )}
          </div>
          {sourceControl.files.length > files.length ? (
            <small className="gyro-terminal-diff-more">
              +{sourceControl.files.length - files.length} more
            </small>
          ) : null}
          <footer>
            <button
              disabled={!sourceControl.available}
              onClick={() => {
                onReview?.();
                setIsOpen(false);
              }}
              type="button"
            >
              Review in Workspace
              <ArrowRight size={13} />
            </button>
          </footer>
        </section>
      ) : null}
    </div>
  );
}

function cliLaunchPresetPaneCount(preset: CliLaunchPreset) {
  return preset.entries.reduce((total, entry) => total + entry.count, 0);
}

function cliLaunchPresetLabel(
  preset: CliLaunchPreset,
  profiles: CommandProfile[],
) {
  if (preset.label) {
    return preset.label;
  }
  if (preset.entries.length === 1) {
    const [entry] = preset.entries;
    const profile = profiles.find((item) => item.id === entry?.profileId);
    const profileLabel = profile?.displayName ?? "preset";
    if (entry?.profileId === "shell" && entry.count === 1) {
      return "New Terminal";
    }
    return entry && entry.count > 1
      ? `Start ${profileLabel} x${entry.count}`
      : `Start ${profileLabel}`;
  }
  return "Start preset";
}

function cliProfileShortLabel(profile: CommandProfile) {
  const compactLabels: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    cursor: "Cursor",
    gemini: "Gemini",
  };
  if (compactLabels[profile.id]) {
    return compactLabels[profile.id];
  }
  return profile.displayName;
}

function AgentLauncherMenu({
  profiles,
  activeProfileId,
  onProfileChange,
  onRunCommandProfile,
}: {
  profiles: CommandProfile[];
  activeProfileId: string;
  onProfileChange: (profileId: string) => void;
  onRunCommandProfile?: (profileId: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useOutsidePointerDismiss<HTMLDivElement>(isOpen, () =>
    setIsOpen(false),
  );

  return (
    <div className="gyro-agent-launcher" ref={menuRef}>
      <button
        aria-label="Quick Start"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        className="gyro-terminal-agent-button"
        onClick={() => setIsOpen((current) => !current)}
        title="Start a CLI"
        type="button"
      >
        <Terminal size={14} />
        <span>Quick Start</span>
        <ChevronDown size={13} />
      </button>
      {isOpen ? (
        <div className="gyro-agent-launcher-menu" role="menu">
          {profiles.map((profile) => {
            const readiness = profile.readiness ?? "ready";
            const isBlocked = readiness === "blocked";
            const readinessLabel = isBlocked
              ? "Unavailable"
              : readiness === "waiting"
                ? "Setup needed"
                : "Ready";
            const shortLabel = cliProfileShortLabel(profile);
            return (
              <button
                aria-label={`${shortLabel}: ${readinessLabel}`}
                className={profile.id === activeProfileId ? "is-active" : ""}
                disabled={isBlocked}
                key={profile.id}
                onClick={() => {
                  onProfileChange(profile.id);
                  onRunCommandProfile?.(profile.id);
                  setIsOpen(false);
                }}
                role="menuitem"
                title={`${profile.displayName}: ${readinessLabel}`}
                type="button"
              >
                <Terminal size={14} />
                <strong>{shortLabel}</strong>
                <span
                  aria-hidden="true"
                  className={`gyro-profile-readiness-dot is-${readiness}`}
                />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function TerminalActionsMenu({
  paneId,
  paneIsWide,
  canMoveToStart,
  canMoveToEnd,
  onRename,
  onRefresh,
  onRestart,
  onClose,
  onMoveToStart,
  onMoveToEnd,
  onSetLayout,
}: {
  paneId?: string;
  paneIsWide?: boolean;
  canMoveToStart?: boolean;
  canMoveToEnd?: boolean;
  onRename?: (paneId: string) => void;
  onRefresh?: () => void;
  onRestart?: (paneId: string) => void;
  onClose?: (paneId: string) => void;
  onMoveToStart?: (paneId: string) => void;
  onMoveToEnd?: (paneId: string) => void;
  onSetLayout?: (paneId: string, layout: TerminalPaneLayout) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useOutsidePointerDismiss<HTMLDivElement>(isOpen, () =>
    setIsOpen(false),
  );

  const runAction = (action: () => void) => {
    action();
    setIsOpen(false);
  };

  return (
    <div className="gyro-terminal-actions" ref={menuRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label="More terminal actions"
        disabled={!paneId}
        onClick={() => setIsOpen((current) => !current)}
        title="Terminal actions"
        type="button"
      >
        <MoreHorizontal size={15} />
      </button>
      {isOpen && paneId ? (
        <div className="gyro-terminal-actions-menu" role="menu">
          <button
            onClick={() =>
              runAction(() =>
                onSetLayout?.(paneId, paneIsWide ? "compact" : "wide"),
              )
            }
            role="menuitem"
            type="button"
          >
            {paneIsWide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            {paneIsWide ? "Fit to grid" : "Expand row"}
          </button>
          <button
            disabled={!canMoveToStart}
            onClick={() => runAction(() => onMoveToStart?.(paneId))}
            role="menuitem"
            type="button"
          >
            <ArrowLeft size={14} />
            Move first
          </button>
          <button
            disabled={!canMoveToEnd}
            onClick={() => runAction(() => onMoveToEnd?.(paneId))}
            role="menuitem"
            type="button"
          >
            <ArrowRight size={14} />
            Move last
          </button>
          <div className="gyro-terminal-actions-separator" role="separator" />
          <button
            onClick={() => runAction(() => onRename?.(paneId))}
            role="menuitem"
            type="button"
          >
            <FileText size={14} />
            Rename
          </button>
          <button
            onClick={() => runAction(() => onRefresh?.())}
            role="menuitem"
            type="button"
          >
            <RefreshCw size={14} />
            Refresh output
          </button>
          <button
            onClick={() => runAction(() => onRestart?.(paneId))}
            role="menuitem"
            type="button"
          >
            <RefreshCw size={14} />
            Restart
          </button>
          <button
            className="is-danger"
            onClick={() => runAction(() => onClose?.(paneId))}
            role="menuitem"
            type="button"
          >
            <X size={14} />
            Close pane
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function TerminalPanel({
  profiles,
  activeProfileId,
  cliLaunchPreset = defaultCliLaunchPreset(),
  isLaunchingCliPreset,
  terminalPanes,
  selectedTerminalPaneId,
  terminalTemplate = 4,
  terminalSourceControl,
  isTerminalSourceControlLoading,
  onProfileChange,
  onRunCommandProfile,
  onLaunchCliPreset,
  onRunProfile,
  onAddTerminalPane,
  onOpenCommandPalette,
  onSplitTerminalPane,
  onSelectTerminalPane,
  onMoveTerminalPane,
  onSetTerminalPaneLayout,
  onRenameTerminalPane,
  onRestartTerminalPane,
  onKillTerminalPane,
  onCloseTerminalPane,
  onTerminalUtilityAction,
  onRefreshTerminalSourceControl,
  onReviewTerminalChanges,
  renderTerminalPaneBody,
}: TerminalPanelProps) {
  const panes = terminalPanes ?? [];
  const hasPanes = panes.length > 0;
  const activePaneId = selectedTerminalPaneId ?? panes[0]?.id;
  const activePane = panes.find((pane) => pane.id === activePaneId);
  const activePaneIndex = panes.findIndex((pane) => pane.id === activePaneId);
  const activePaneIsWide = Boolean(
    activePane &&
    (activePane.layout === "wide" ||
      (activePane.layout !== "compact" &&
        panes.length % 2 === 1 &&
        activePaneIndex === panes.length - 1)),
  );
  const canStopActivePane =
    activePane?.status === "running" || activePane?.status === "waiting";
  const waitingPanes = panes.filter((pane) => pane.attention === "waiting");
  const failedPanes = panes.filter((pane) => pane.attention === "failed");
  const presetLabel = cliLaunchPreset
    ? cliLaunchPresetLabel(cliLaunchPreset, profiles)
    : "Start preset";
  const presetCount = cliLaunchPreset
    ? cliLaunchPresetPaneCount(cliLaunchPreset)
    : 0;
  const canLaunchPreset =
    Boolean(onLaunchCliPreset) &&
    presetCount > 0 &&
    presetCount <= CLI_LAUNCH_PRESET_MAX_PANES &&
    !isLaunchingCliPreset;
  const [draggedPaneId, setDraggedPaneId] = useState<string | undefined>();
  const movePaneByKeyboard = (paneId: string, direction: -1 | 1) => {
    const index = panes.findIndex((pane) => pane.id === paneId);
    const target = panes[index + direction];
    if (target) {
      onMoveTerminalPane?.(paneId, target.id);
    }
  };
  return (
    <div
      className={
        hasPanes
          ? "gyro-terminal-workspace"
          : "gyro-terminal-workspace is-empty"
      }
    >
      <div
        className={
          hasPanes ? "gyro-terminal-toolbar" : "gyro-terminal-toolbar is-empty"
        }
      >
        <AgentLauncherMenu
          activeProfileId={activeProfileId}
          onProfileChange={onProfileChange}
          onRunCommandProfile={onRunCommandProfile}
          profiles={profiles}
        />
        <button
          aria-label={`Launch ${presetLabel}`}
          className="gyro-terminal-preset-button"
          disabled={!canLaunchPreset}
          onClick={onLaunchCliPreset}
          title={`Launch ${presetLabel}`}
          type="button"
        >
          <Plus size={14} />
          <span>{isLaunchingCliPreset ? "Starting" : presetLabel}</span>
        </button>
        <span className="gyro-terminal-toolbar-spacer" />
        {hasPanes ? (
          <div className="gyro-terminal-awareness" aria-label="CLI awareness">
            <TerminalDiffControl
              isLoading={isTerminalSourceControlLoading}
              onRefresh={onRefreshTerminalSourceControl}
              onReview={onReviewTerminalChanges}
              sourceControl={terminalSourceControl}
            />
            {waitingPanes.length > 0 ? (
              <button
                className="gyro-terminal-attention is-waiting"
                onClick={() => onSelectTerminalPane?.(waitingPanes[0]!.id)}
                title="Focus waiting terminal"
                type="button"
              >
                <CircleDashed size={13} />
                <span>{waitingPanes.length} waiting</span>
              </button>
            ) : null}
            {failedPanes.length > 0 ? (
              <button
                className="gyro-terminal-attention is-failed"
                onClick={() => onSelectTerminalPane?.(failedPanes[0]!.id)}
                title="Focus failed terminal"
                type="button"
              >
                <X size={13} />
                <span>{failedPanes.length} failed</span>
              </button>
            ) : null}
          </div>
        ) : null}
        {hasPanes ? (
          <div className="gyro-terminal-tools">
            <button
              aria-label="Open commands"
              className="gyro-icon-button gyro-terminal-search"
              onClick={onOpenCommandPalette}
              title="Commands"
              type="button"
            >
              <Command size={15} />
            </button>
            <button
              aria-label="Split terminal"
              onClick={() => onSplitTerminalPane?.(2)}
              title="Split terminal"
              type="button"
            >
              <Columns2 size={15} />
            </button>
            {canStopActivePane ? (
              <button
                aria-label="Stop active terminal"
                onClick={() =>
                  activePaneId && onKillTerminalPane?.(activePaneId)
                }
                title="Stop active terminal"
                type="button"
              >
                <Square size={14} />
              </button>
            ) : null}
            <TerminalActionsMenu
              canMoveToEnd={
                activePaneIndex >= 0 && activePaneIndex < panes.length - 1
              }
              canMoveToStart={activePaneIndex > 0}
              onClose={onCloseTerminalPane}
              onMoveToEnd={(paneId) => {
                const lastPane = panes[panes.length - 1];
                if (lastPane) {
                  onMoveTerminalPane?.(paneId, lastPane.id);
                }
              }}
              onMoveToStart={(paneId) => {
                const firstPane = panes[0];
                if (firstPane) {
                  onMoveTerminalPane?.(paneId, firstPane.id);
                }
              }}
              onRefresh={() => onTerminalUtilityAction?.("read-screen")}
              onRename={onRenameTerminalPane}
              onRestart={onRestartTerminalPane}
              onSetLayout={onSetTerminalPaneLayout}
              paneId={activePaneId}
              paneIsWide={activePaneIsWide}
            />
          </div>
        ) : null}
      </div>
      <div className="gyro-terminal-grid" aria-label="Terminal grid">
        {panes.length > 0 ? (
          panes.map((pane) => (
            <TerminalPaneView
              command={pane.command}
              draggedPaneId={draggedPaneId}
              isActive={pane.id === activePaneId}
              key={pane.id}
              onDragEnd={() => setDraggedPaneId(undefined)}
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDragStart={() => setDraggedPaneId(pane.id)}
              onDrop={() => {
                if (draggedPaneId) {
                  onMoveTerminalPane?.(draggedPaneId, pane.id);
                }
                setDraggedPaneId(undefined);
              }}
              onMoveBackward={() => movePaneByKeyboard(pane.id, -1)}
              onMoveForward={() => movePaneByKeyboard(pane.id, 1)}
              onClose={() => onCloseTerminalPane?.(pane.id)}
              onSelect={() => onSelectTerminalPane?.(pane.id)}
              output={pane.output}
              branch={pane.branch}
              pane={pane}
              renderBody={renderTerminalPaneBody}
              status={pane.status}
              title={pane.title}
              workspaceMode={pane.workspaceMode}
              worktreeName={pane.worktreeName}
            />
          ))
        ) : (
          <div className="gyro-terminal-empty" aria-label="No terminal panes" />
        )}
      </div>
    </div>
  );
}

function WorkbenchPaneTabs({
  activeTab,
  onTabChange,
  onAddPane,
  terminalTitle,
  terminalOnly = false,
}: {
  activeTab: WorkbenchPaneTab;
  onTabChange: (tab: WorkbenchPaneTab) => void;
  onAddPane?: () => void;
  terminalTitle?: string;
  terminalOnly?: boolean;
}) {
  return (
    <div className="gyro-pane-tabs" role="tablist" aria-label="Workbench panes">
      {paneTabs
        .filter((tab) => !terminalOnly || tab.id === "terminal")
        .map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === activeTab;
          const label =
            tab.id === "terminal" && terminalTitle ? terminalTitle : tab.label;
          return (
            <button
              aria-selected={isActive}
              className={isActive ? "is-active" : ""}
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              role="tab"
              type="button"
            >
              <Icon size={15} />
              {label}
            </button>
          );
        })}
      {activeTab === "terminal" && onAddPane ? (
        <button
          aria-label="New terminal"
          className="gyro-pane-add"
          onClick={onAddPane}
          title="New terminal"
          type="button"
        >
          <Plus size={16} />
        </button>
      ) : null}
    </div>
  );
}

function WorkbenchPaneContent({
  activePaneTab,
  profiles,
  activeProfileId,
  cliLaunchPreset = defaultCliLaunchPreset(),
  isLaunchingCliPreset,
  selectedTerminalPaneId,
  terminalPanes,
  terminalTemplate,
  diffReview,
  browserPreview,
  ide,
  terminalOutput,
  terminalSourceControl,
  isTerminalSourceControlLoading,
  onProfileChange,
  onRunCommandProfile,
  onLaunchCliPreset,
  onRunProfile,
  onAddTerminalPane,
  onOpenCommandPalette,
  onSplitTerminalPane,
  onSelectTerminalPane,
  onMoveTerminalPane,
  onSetTerminalPaneLayout,
  onRenameTerminalPane,
  onRestartTerminalPane,
  onKillTerminalPane,
  onCloseTerminalPane,
  onTerminalUtilityAction,
  onRefreshTerminalSourceControl,
  onReviewTerminalChanges,
  onWriteTerminalInput,
  renderTerminalPaneBody,
  onSelectDiffFile,
  onToggleDiffDirectory,
  onRunGitReviewAction,
  onAcceptDiffFile,
  onRejectDiffFile,
  onAcceptAllDiffs,
  onRejectAllDiffs,
  onUndoDiff,
  onCommentDiff,
  onOpenDiffInEditor,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  onBrowserUrlChange,
  onBrowserNavigate,
  onBrowserDeviceChange,
  onBrowserScreenshot,
  onBrowserOpenExternal,
}: {
  activePaneTab: WorkbenchPaneTab;
  profiles: CommandProfile[];
  activeProfileId: string;
  cliLaunchPreset?: CliLaunchPreset;
  isLaunchingCliPreset?: boolean;
  selectedTerminalPaneId?: string;
  terminalPanes?: TerminalPane[];
  terminalTemplate?: TerminalTemplate;
  diffReview?: DiffReview;
  browserPreview?: BrowserPreview;
  ide?: IdeState;
  terminalOutput: string;
  terminalSourceControl?: SourceControlState;
  isTerminalSourceControlLoading?: boolean;
  onProfileChange: (profileId: string) => void;
  onRunCommandProfile?: (profileId: string) => void;
  onLaunchCliPreset?: () => void;
  onRunProfile: () => void;
  onAddTerminalPane?: () => void;
  onOpenCommandPalette?: () => void;
  onSplitTerminalPane?: (template: TerminalTemplate) => void;
  onSelectTerminalPane?: (paneId: string) => void;
  onMoveTerminalPane?: (sourcePaneId: string, targetPaneId: string) => void;
  onSetTerminalPaneLayout?: (
    paneId: string,
    layout: TerminalPaneLayout,
  ) => void;
  onRenameTerminalPane?: (paneId: string) => void;
  onRestartTerminalPane?: (paneId: string) => void;
  onKillTerminalPane?: (paneId: string) => void;
  onCloseTerminalPane?: (paneId: string) => void;
  onTerminalUtilityAction?: (action: string) => void;
  onRefreshTerminalSourceControl?: () => void;
  onReviewTerminalChanges?: (file?: SourceControlFile) => void;
  onWriteTerminalInput?: (input: string) => void;
  renderTerminalPaneBody?: (pane: TerminalPane) => ReactNode;
  onSelectDiffFile?: (path: string) => void;
  onToggleDiffDirectory?: (directory: string) => void;
  onRunGitReviewAction?: (actionId: GitReviewActionId) => void;
  onAcceptDiffFile?: (path: string) => void;
  onRejectDiffFile?: (path: string) => void;
  onAcceptAllDiffs?: () => void;
  onRejectAllDiffs?: () => void;
  onUndoDiff?: () => void;
  onCommentDiff?: (path: string) => void;
  onOpenDiffInEditor?: (
    path: string,
    lineNumber?: number,
    column?: number,
  ) => void;
  onBrowserBack?: () => void;
  onBrowserForward?: () => void;
  onBrowserReload?: () => void;
  onBrowserUrlChange?: (url: string) => void;
  onBrowserNavigate?: (url: string) => void;
  onBrowserDeviceChange?: (device: BrowserPreviewDevice) => void;
  onBrowserScreenshot?: (action?: BrowserScreenshotAction) => void;
  onBrowserOpenExternal?: () => void;
}) {
  if (activePaneTab === "diff") {
    return (
      <DiffReviewSurface
        compact
        diffReview={diffReview}
        onAcceptAll={onAcceptAllDiffs}
        onAcceptFile={onAcceptDiffFile}
        onComment={onCommentDiff}
        onOpenInEditor={onOpenDiffInEditor}
        onRejectAll={onRejectAllDiffs}
        onRejectFile={onRejectDiffFile}
        onSelectFile={onSelectDiffFile}
        onToggleDirectory={onToggleDiffDirectory}
        onRunGitAction={onRunGitReviewAction}
        onUndo={onUndoDiff}
      />
    );
  }

  if (activePaneTab === "browser") {
    return (
      <BrowserPreviewSurface
        browserPreview={browserPreview}
        compact
        onBack={onBrowserBack}
        onDeviceChange={onBrowserDeviceChange}
        onForward={onBrowserForward}
        onNavigate={onBrowserNavigate}
        onOpenExternal={onBrowserOpenExternal}
        onReload={onBrowserReload}
        onScreenshot={onBrowserScreenshot}
        onUrlChange={onBrowserUrlChange}
      />
    );
  }

  if (activePaneTab === "problems") {
    return (
      <section className="gyro-problems-pane" aria-label="Problems">
        <header>
          <CircleDashed size={15} />
          <span>{ide?.diagnostics.length ?? 0} problems</span>
        </header>
        <div className="gyro-problems-list">
          {(ide?.diagnostics ?? []).length > 0 ? (
            ide?.diagnostics.map((diagnostic) => (
              <button
                className={`gyro-problem-row is-${diagnostic.severity}`}
                key={diagnostic.id}
                onClick={() =>
                  onOpenDiffInEditor?.(
                    diagnostic.path,
                    diagnostic.startLineNumber,
                    diagnostic.startColumn,
                  )
                }
                type="button"
              >
                <strong>{diagnostic.message}</strong>
                <span>
                  {diagnostic.path}:{diagnostic.startLineNumber}
                  {diagnostic.source ? ` · ${diagnostic.source}` : ""}
                </span>
              </button>
            ))
          ) : (
            <div className="gyro-panel-empty">
              No diagnostics yet. Language server status will appear here when
              configured.
            </div>
          )}
        </div>
      </section>
    );
  }

  if (activePaneTab === "output") {
    const activeChannel =
      ide?.outputChannels.find(
        (channel) => channel.id === ide.activeOutputChannelId,
      ) ?? ide?.outputChannels[0];
    return (
      <section className="gyro-output-pane" aria-label="Output">
        <header>
          <FileText size={15} />
          <span>{activeChannel?.label ?? "Output"}</span>
        </header>
        <pre>
          {(activeChannel?.lines ?? ["No output channel selected."]).join("\n")}
        </pre>
      </section>
    );
  }

  return (
    <TerminalPanel
      activeProfileId={activeProfileId}
      cliLaunchPreset={cliLaunchPreset}
      isLaunchingCliPreset={isLaunchingCliPreset}
      isTerminalSourceControlLoading={isTerminalSourceControlLoading}
      selectedTerminalPaneId={selectedTerminalPaneId}
      terminalPanes={terminalPanes}
      terminalSourceControl={terminalSourceControl}
      terminalTemplate={terminalTemplate}
      onAddTerminalPane={onAddTerminalPane}
      onCloseTerminalPane={onCloseTerminalPane}
      onKillTerminalPane={onKillTerminalPane}
      onMoveTerminalPane={onMoveTerminalPane}
      onSetTerminalPaneLayout={onSetTerminalPaneLayout}
      onOpenCommandPalette={onOpenCommandPalette}
      onProfileChange={onProfileChange}
      onRunCommandProfile={onRunCommandProfile}
      onLaunchCliPreset={onLaunchCliPreset}
      onRunProfile={onRunProfile}
      onRestartTerminalPane={onRestartTerminalPane}
      onRenameTerminalPane={onRenameTerminalPane}
      onSelectTerminalPane={onSelectTerminalPane}
      onSplitTerminalPane={onSplitTerminalPane}
      onTerminalUtilityAction={onTerminalUtilityAction}
      onRefreshTerminalSourceControl={onRefreshTerminalSourceControl}
      onReviewTerminalChanges={onReviewTerminalChanges}
      onWriteTerminalInput={onWriteTerminalInput}
      output={terminalOutput}
      profiles={profiles}
      renderTerminalPaneBody={renderTerminalPaneBody}
    />
  );
}

type WorkspaceToolPanelProps = {
  activePaneTab: WorkbenchPaneTab;
  profiles: CommandProfile[];
  activeProfileId: string;
  cliLaunchPreset: CliLaunchPreset;
  isLaunchingCliPreset?: boolean;
  selectedTerminalPaneId?: string;
  terminalPanes?: TerminalPane[];
  terminalTemplate?: TerminalTemplate;
  diffReview?: DiffReview;
  browserPreview?: BrowserPreview;
  ide?: IdeState;
  terminalOutput: string;
  terminalSourceControl?: SourceControlState;
  isTerminalSourceControlLoading?: boolean;
  isPrimary?: boolean;
  isResizable?: boolean;
  terminalOnly?: boolean;
  height?: number;
  onClose?: () => void;
  onHeightChange?: (height: number) => void;
  onCollapse?: () => void;
  onPaneTabChange: (tab: WorkbenchPaneTab) => void;
  onProfileChange: (profileId: string) => void;
  onRunCommandProfile?: (profileId: string) => void;
  onLaunchCliPreset?: () => void;
  onRunProfile: () => void;
  onAddTerminalPane?: () => void;
  onOpenCommandPalette?: () => void;
  onSplitTerminalPane?: (template: TerminalTemplate) => void;
  onSelectTerminalPane?: (paneId: string) => void;
  onMoveTerminalPane?: (sourcePaneId: string, targetPaneId: string) => void;
  onSetTerminalPaneLayout?: (
    paneId: string,
    layout: TerminalPaneLayout,
  ) => void;
  onRenameTerminalPane?: (paneId: string) => void;
  onRestartTerminalPane?: (paneId: string) => void;
  onKillTerminalPane?: (paneId: string) => void;
  onCloseTerminalPane?: (paneId: string) => void;
  onTerminalUtilityAction?: (action: string) => void;
  onRefreshTerminalSourceControl?: () => void;
  onReviewTerminalChanges?: (file?: SourceControlFile) => void;
  onWriteTerminalInput?: (input: string) => void;
  renderTerminalPaneBody?: (pane: TerminalPane) => ReactNode;
  onSelectDiffFile?: (path: string) => void;
  onToggleDiffDirectory?: (directory: string) => void;
  onRunGitReviewAction?: (actionId: GitReviewActionId) => void;
  onAcceptDiffFile?: (path: string) => void;
  onRejectDiffFile?: (path: string) => void;
  onAcceptAllDiffs?: () => void;
  onRejectAllDiffs?: () => void;
  onUndoDiff?: () => void;
  onCommentDiff?: (path: string) => void;
  onOpenDiffInEditor?: (
    path: string,
    lineNumber?: number,
    column?: number,
  ) => void;
  onBrowserBack?: () => void;
  onBrowserForward?: () => void;
  onBrowserReload?: () => void;
  onBrowserUrlChange?: (url: string) => void;
  onBrowserNavigate?: (url: string) => void;
  onBrowserDeviceChange?: (device: BrowserPreviewDevice) => void;
  onBrowserScreenshot?: (action?: BrowserScreenshotAction) => void;
  onBrowserOpenExternal?: () => void;
};

export function WorkspaceToolPanel({
  activePaneTab,
  profiles,
  activeProfileId,
  cliLaunchPreset = defaultCliLaunchPreset(),
  isLaunchingCliPreset,
  selectedTerminalPaneId,
  terminalPanes,
  terminalTemplate,
  diffReview,
  browserPreview,
  ide,
  terminalOutput,
  terminalSourceControl,
  isTerminalSourceControlLoading,
  isPrimary = false,
  isResizable = false,
  terminalOnly = false,
  height,
  onClose,
  onHeightChange,
  onCollapse,
  onPaneTabChange,
  onProfileChange,
  onRunCommandProfile,
  onLaunchCliPreset,
  onRunProfile,
  onAddTerminalPane,
  onOpenCommandPalette,
  onSplitTerminalPane,
  onSelectTerminalPane,
  onMoveTerminalPane,
  onSetTerminalPaneLayout,
  onRenameTerminalPane,
  onRestartTerminalPane,
  onKillTerminalPane,
  onCloseTerminalPane,
  onTerminalUtilityAction,
  onRefreshTerminalSourceControl,
  onReviewTerminalChanges,
  onWriteTerminalInput,
  renderTerminalPaneBody,
  onSelectDiffFile,
  onToggleDiffDirectory,
  onRunGitReviewAction,
  onAcceptDiffFile,
  onRejectDiffFile,
  onAcceptAllDiffs,
  onRejectAllDiffs,
  onUndoDiff,
  onCommentDiff,
  onOpenDiffInEditor,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  onBrowserUrlChange,
  onBrowserNavigate,
  onBrowserDeviceChange,
  onBrowserScreenshot,
  onBrowserOpenExternal,
}: WorkspaceToolPanelProps) {
  const [isResizing, setIsResizing] = useState(false);
  const canResize = isResizable && !isPrimary;
  const effectivePaneTab = terminalOnly ? "terminal" : activePaneTab;
  const activeTerminalPane =
    terminalPanes?.find((pane) => pane.id === selectedTerminalPaneId) ??
    terminalPanes?.[0];

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!canResize || !onHeightChange) {
      return;
    }
    event.preventDefault();
    const panel = event.currentTarget.closest(
      ".gyro-workspace-tool-panel",
    ) as HTMLElement | null;
    const startHeight =
      height ??
      panel?.getBoundingClientRect().height ??
      TOOL_PANEL_DEFAULT_HEIGHT;
    const startY = event.clientY;
    const maxHeight = maxToolPanelHeight();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    setIsResizing(true);

    const cleanup = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setIsResizing(false);
    };

    const nextHeightForY = (clientY: number) => startHeight + startY - clientY;

    const handleMove = (moveEvent: PointerEvent) => {
      const nextHeight = nextHeightForY(moveEvent.clientY);
      onHeightChange(
        clampToolPanelHeight(nextHeight, TOOL_PANEL_COLLAPSE_HEIGHT, maxHeight),
      );
    };

    const handleUp = (upEvent: PointerEvent) => {
      const nextHeight = nextHeightForY(upEvent.clientY);
      cleanup();
      if (nextHeight <= TOOL_PANEL_COLLAPSE_HEIGHT) {
        onCollapse?.();
        return;
      }
      onHeightChange(clampToolPanelHeight(nextHeight, TOOL_PANEL_MIN_HEIGHT));
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  };

  const handleResizeKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (!canResize || !onHeightChange) {
      return;
    }
    const currentHeight = height ?? TOOL_PANEL_DEFAULT_HEIGHT;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onHeightChange(clampToolPanelHeight(currentHeight + 32));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onHeightChange(clampToolPanelHeight(currentHeight - 32));
    } else if (event.key === "Home") {
      event.preventDefault();
      onHeightChange(maxToolPanelHeight());
    } else if (event.key === "End") {
      event.preventDefault();
      onCollapse?.();
    }
  };

  const panelClassName = [
    "gyro-workspace-tool-panel",
    isPrimary ? "is-primary" : "",
    canResize ? "is-resizable" : "",
    isResizing ? "is-resizing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section
      className={panelClassName}
      style={canResize && height ? { height } : undefined}
      aria-label="Workspace tools"
      data-active-tab={effectivePaneTab}
    >
      {canResize ? (
        <button
          aria-label="Resize tool panel"
          className="gyro-tool-panel-resize-handle"
          onClick={() => onHeightChange?.(TOOL_PANEL_DEFAULT_HEIGHT)}
          onKeyDown={handleResizeKeyDown}
          onPointerDown={beginResize}
          title="Resize"
          type="button"
        >
          <span />
        </button>
      ) : null}
      {!isPrimary ? (
        <div className="gyro-workspace-tool-panel-head">
          <WorkbenchPaneTabs
            activeTab={effectivePaneTab}
            onAddPane={onAddTerminalPane}
            onTabChange={onPaneTabChange}
            terminalTitle={activeTerminalPane?.title}
            terminalOnly={terminalOnly}
          />
          <button
            aria-label="Close tool panel"
            className="gyro-icon-button is-subtle"
            onClick={onClose}
            title="Close"
            type="button"
          >
            <X size={15} />
          </button>
        </div>
      ) : null}
      <WorkbenchPaneContent
        activePaneTab={effectivePaneTab}
        activeProfileId={activeProfileId}
        browserPreview={browserPreview}
        cliLaunchPreset={cliLaunchPreset}
        diffReview={diffReview}
        ide={ide}
        isLaunchingCliPreset={isLaunchingCliPreset}
        isTerminalSourceControlLoading={isTerminalSourceControlLoading}
        selectedTerminalPaneId={selectedTerminalPaneId}
        terminalPanes={terminalPanes}
        terminalSourceControl={terminalSourceControl}
        terminalTemplate={terminalTemplate}
        onAcceptAllDiffs={onAcceptAllDiffs}
        onAcceptDiffFile={onAcceptDiffFile}
        onAddTerminalPane={onAddTerminalPane}
        onBrowserBack={onBrowserBack}
        onBrowserDeviceChange={onBrowserDeviceChange}
        onBrowserForward={onBrowserForward}
        onBrowserNavigate={onBrowserNavigate}
        onBrowserOpenExternal={onBrowserOpenExternal}
        onBrowserReload={onBrowserReload}
        onBrowserScreenshot={onBrowserScreenshot}
        onBrowserUrlChange={onBrowserUrlChange}
        onCommentDiff={onCommentDiff}
        onCloseTerminalPane={onCloseTerminalPane}
        onKillTerminalPane={onKillTerminalPane}
        onMoveTerminalPane={onMoveTerminalPane}
        onSetTerminalPaneLayout={onSetTerminalPaneLayout}
        onOpenCommandPalette={onOpenCommandPalette}
        onOpenDiffInEditor={onOpenDiffInEditor}
        onProfileChange={onProfileChange}
        onRunCommandProfile={onRunCommandProfile}
        onLaunchCliPreset={onLaunchCliPreset}
        onRejectAllDiffs={onRejectAllDiffs}
        onRejectDiffFile={onRejectDiffFile}
        onRenameTerminalPane={onRenameTerminalPane}
        onRestartTerminalPane={onRestartTerminalPane}
        onRunGitReviewAction={onRunGitReviewAction}
        onRunProfile={onRunProfile}
        onSelectDiffFile={onSelectDiffFile}
        onSelectTerminalPane={onSelectTerminalPane}
        onSplitTerminalPane={onSplitTerminalPane}
        onTerminalUtilityAction={onTerminalUtilityAction}
        onRefreshTerminalSourceControl={onRefreshTerminalSourceControl}
        onReviewTerminalChanges={onReviewTerminalChanges}
        onToggleDiffDirectory={onToggleDiffDirectory}
        onUndoDiff={onUndoDiff}
        onWriteTerminalInput={onWriteTerminalInput}
        profiles={profiles}
        renderTerminalPaneBody={renderTerminalPaneBody}
        terminalOutput={terminalOutput}
      />
    </section>
  );
}

function clampToolPanelHeight(
  height: number,
  minHeight = TOOL_PANEL_MIN_HEIGHT,
  maxHeight = maxToolPanelHeight(),
) {
  return Math.min(Math.max(Math.round(height), minHeight), maxHeight);
}

function maxToolPanelHeight() {
  if (typeof window === "undefined") {
    return TOOL_PANEL_DEFAULT_HEIGHT;
  }
  return Math.max(TOOL_PANEL_MIN_HEIGHT, Math.round(window.innerHeight * 0.78));
}

export function ToolsSurface({
  taskCount,
  automationCount,
  connectedProviderCount,
  onSelectDestination,
}: {
  taskCount: number;
  automationCount: number;
  connectedProviderCount: number;
  onSelectDestination: (destination: AppDestination) => void;
}) {
  return (
    <div className="gyro-tools-surface">
      <section className="gyro-tools-panel" aria-label="Workspace tools">
        <header className="gyro-tools-head gyro-surface-page-header">
          <div className="gyro-surface-page-title">
            <span className="gyro-surface-page-icon" aria-hidden="true">
              <LayoutPanelLeft size={18} />
            </span>
            <div>
              <span className="gyro-surface-page-eyebrow">Workspace suite</span>
              <h1>Tools</h1>
              <p>Plan work, schedule runs, and manage your agent stack.</p>
            </div>
          </div>
          <span className="gyro-surface-page-badge">3 surfaces</span>
        </header>
        <div className="gyro-tools-grid">
          <button
            className="gyro-tools-card"
            onClick={() => onSelectDestination("tasks")}
            type="button"
          >
            <span className="gyro-tools-card-icon">
              <Activity size={18} />
            </span>
            <span className="gyro-tools-card-copy">
              <strong>Tasks</strong>
              <small>Plan and dispatch focused agent work.</small>
            </span>
            <span className="gyro-tools-card-meta">{taskCount} queued</span>
            <ChevronRight className="gyro-tools-card-arrow" size={15} />
          </button>
          <button
            className="gyro-tools-card"
            onClick={() => onSelectDestination("automations")}
            type="button"
          >
            <span className="gyro-tools-card-icon">
              <CalendarClock size={18} />
            </span>
            <span className="gyro-tools-card-copy">
              <strong>Automations</strong>
              <small>Schedule recurring checks and follow-ups.</small>
            </span>
            <span className="gyro-tools-card-meta">
              {automationCount} scheduled
            </span>
            <ChevronRight className="gyro-tools-card-arrow" size={15} />
          </button>
          <button
            className="gyro-tools-card"
            onClick={() => onSelectDestination("providers")}
            type="button"
          >
            <span className="gyro-tools-card-icon">
              <KeyRound size={18} />
            </span>
            <span className="gyro-tools-card-copy">
              <strong>Providers</strong>
              <small>Configure models, auth, and handoffs.</small>
            </span>
            <span className="gyro-tools-card-meta">
              {connectedProviderCount} connected
            </span>
            <ChevronRight className="gyro-tools-card-arrow" size={15} />
          </button>
        </div>
      </section>
    </div>
  );
}

export function TaskBoardSurface({
  tasks = [],
  selectedTaskId,
  onCreateTask,
  onDispatchTask,
  onMoveTask,
  onSelectTask,
}: {
  tasks?: Task[];
  selectedTaskId?: string;
  onCreateTask?: () => void;
  onDispatchTask?: (taskId: string) => void;
  onMoveTask?: (taskId: string, status: TaskStatus) => void;
  onSelectTask?: (taskId: string) => void;
}) {
  const visibleTasks = tasks.length > 0 ? tasks : [];
  const columns: Array<{ status: TaskStatus; title: string; tasks: Task[] }> = [
    {
      status: "todo",
      title: "Todo",
      tasks: visibleTasks.filter((task) => task.status === "todo"),
    },
    {
      status: "in-progress",
      title: "In Progress",
      tasks: visibleTasks.filter((task) => task.status === "in-progress"),
    },
    {
      status: "in-review",
      title: "In Review",
      tasks: visibleTasks.filter((task) => task.status === "in-review"),
    },
    {
      status: "complete",
      title: "Complete",
      tasks: visibleTasks.filter((task) => task.status === "complete"),
    },
  ];
  const statusOptions: Array<{
    status: TaskStatus;
    label: string;
    icon: IconComponent;
  }> = [
    { status: "todo", label: "Move to todo", icon: CircleDashed },
    { status: "in-progress", label: "Start task", icon: Play },
    { status: "in-review", label: "Move to review", icon: Search },
    { status: "complete", label: "Complete task", icon: Check },
  ];

  return (
    <div className="gyro-board-surface">
      <header className="gyro-board-toolbar gyro-surface-page-header">
        <div className="gyro-surface-page-title">
          <span className="gyro-surface-page-icon" aria-hidden="true">
            <ListChecks size={18} />
          </span>
          <div>
            <span className="gyro-surface-page-eyebrow">Workspace plan</span>
            <h1>Tasks</h1>
            <p>Dispatch focused work into app-hosted agent sessions.</p>
          </div>
        </div>
        <div className="gyro-board-actions">
          <button
            className="gyro-secondary-button"
            disabled={!selectedTaskId}
            onClick={() => selectedTaskId && onDispatchTask?.(selectedTaskId)}
            type="button"
          >
            <Terminal size={15} />
            Dispatch agent
          </button>
          <button
            className="gyro-primary-button"
            onClick={onCreateTask}
            type="button"
          >
            <Plus size={15} />
            Create task
          </button>
        </div>
      </header>
      <div className="gyro-kanban-grid">
        {columns.map((column) => (
          <section className="gyro-kanban-column" key={column.title}>
            <header>
              <strong>{column.title}</strong>
              <span>{column.tasks.length}</span>
            </header>
            <div className="gyro-kanban-list">
              {column.tasks.length === 0 ? (
                <div className="gyro-empty-row">No tasks in this lane</div>
              ) : null}
              {column.tasks.map((task) => (
                <article
                  className={[
                    "gyro-task-card",
                    task.attentionNeeded ? "needs-attention" : "",
                    task.id === selectedTaskId ? "is-active" : "",
                  ].join(" ")}
                  key={task.id}
                  onClick={() => onSelectTask?.(task.id)}
                >
                  <div className="gyro-task-card-head">
                    <strong>{task.title}</strong>
                    <div className="gyro-task-badges">
                      <span className={`is-${task.workspaceMode}`}>
                        {task.workspaceMode}
                      </span>
                      {task.attentionNeeded ? <span>attention</span> : null}
                    </div>
                  </div>
                  <div className="gyro-task-meta-grid">
                    <span>{task.repo}</span>
                    <span>{task.agent}</span>
                    <span>{task.branch}</span>
                    <span>{task.worktreeName ?? task.timeRunning}</span>
                  </div>
                  <div className="gyro-task-event">{task.lastEvent}</div>
                  <div className="gyro-task-foot">
                    <small>{task.diffStatus}</small>
                    <small>{task.testStatus}</small>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        onDispatchTask?.(task.id);
                      }}
                      type="button"
                    >
                      {task.terminalPaneId ? "Open pane" : "Start"}
                    </button>
                  </div>
                  <div className="gyro-task-transition-row">
                    {statusOptions.map(
                      ({ status, label, icon: StatusIcon }) => (
                        <button
                          aria-label={label}
                          className={status === task.status ? "is-active" : ""}
                          key={status}
                          onClick={(event) => {
                            event.stopPropagation();
                            onMoveTask?.(task.id, status);
                          }}
                          title={label}
                          type="button"
                        >
                          <StatusIcon size={13} />
                        </button>
                      ),
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function AutomationsSurface({
  automations = [],
  selectedAutomationId,
  onArchiveAutomation,
  onCreateAutomation,
  onRunAutomation,
  onSelectAutomation,
  onToggleAutomation,
}: {
  automations?: Automation[];
  selectedAutomationId?: string;
  onArchiveAutomation?: (automationId: string) => void;
  onCreateAutomation?: () => void;
  onRunAutomation?: (automationId: string) => void;
  onSelectAutomation?: (automationId: string) => void;
  onToggleAutomation?: (automationId: string) => void;
}) {
  const selectedAutomation =
    automations.find((automation) => automation.id === selectedAutomationId) ??
    automations[0];
  const currentCount = automations.filter(
    (automation) => automation.status === "current",
  ).length;
  const pausedCount = automations.filter(
    (automation) => automation.status === "paused",
  ).length;
  const reviewCount = automations.filter(
    (automation) => automation.triageState === "needs-review",
  ).length;
  const selectedAutomationRunning = Boolean(
    selectedAutomation?.leaseOwner ||
    selectedAutomation?.runHistory[0]?.status === "running",
  );
  const selectedAutomationCanRun = Boolean(
    selectedAutomation?.status === "current" && !selectedAutomationRunning,
  );

  return (
    <div className="gyro-automations-surface">
      <header className="gyro-automation-toolbar gyro-surface-page-header">
        <div className="gyro-surface-page-title">
          <span className="gyro-surface-page-icon" aria-hidden="true">
            <CalendarClock size={18} />
          </span>
          <div>
            <span className="gyro-surface-page-eyebrow">Scheduled work</span>
            <h1>Automations</h1>
            <p>
              Run recurring agent work with local triage and stop conditions.
            </p>
          </div>
        </div>
        <div className="gyro-board-actions">
          <button
            className="gyro-secondary-button"
            disabled={!selectedAutomationCanRun}
            onClick={() =>
              selectedAutomation && onRunAutomation?.(selectedAutomation.id)
            }
            type="button"
          >
            <Play size={15} />
            {selectedAutomationRunning ? "Running" : "Run now"}
          </button>
          <button
            className="gyro-primary-button"
            onClick={onCreateAutomation}
            type="button"
          >
            <Plus size={15} />
            New automation
          </button>
        </div>
      </header>

      <div className="gyro-automation-summary">
        <AutomationMetric label="Current" value={currentCount} />
        <AutomationMetric label="Paused" value={pausedCount} />
        <AutomationMetric label="Needs review" value={reviewCount} />
      </div>

      {automations.length === 0 ? (
        <section className="gyro-automation-empty">
          <div className="gyro-pane-empty-icon">
            <CalendarClock size={22} />
          </div>
          <strong>No scheduled work yet</strong>
          <span>
            Create a local automation for recurring checks, heartbeat prompts,
            or follow-up agent runs.
          </span>
          <button
            className="gyro-primary-button"
            onClick={onCreateAutomation}
            type="button"
          >
            <Plus size={15} />
            Create automation
          </button>
        </section>
      ) : (
        <div className="gyro-automation-layout">
          <section className="gyro-automation-list" aria-label="Automations">
            {automations.map((automation) => (
              <button
                className={
                  automation.id === selectedAutomation?.id
                    ? "gyro-automation-row is-active"
                    : "gyro-automation-row"
                }
                key={automation.id}
                onClick={() => onSelectAutomation?.(automation.id)}
                type="button"
              >
                <div>
                  <strong>{automation.title}</strong>
                  <span>{automation.prompt}</span>
                </div>
                <small>{automation.schedule}</small>
                <small className={`is-${automation.status}`}>
                  {automation.status}
                </small>
                {automation.unreadResults > 0 ? (
                  <b>{automation.unreadResults}</b>
                ) : null}
              </button>
            ))}
          </section>

          {selectedAutomation ? (
            <AutomationDetail
              automation={selectedAutomation}
              onArchive={() => onArchiveAutomation?.(selectedAutomation.id)}
              onRun={() => onRunAutomation?.(selectedAutomation.id)}
              onToggle={() => onToggleAutomation?.(selectedAutomation.id)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function AutomationMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="gyro-automation-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function AutomationDetail({
  automation,
  onArchive,
  onRun,
  onToggle,
}: {
  automation: Automation;
  onArchive: () => void;
  onRun: () => void;
  onToggle: () => void;
}) {
  const running = Boolean(
    automation.leaseOwner || automation.runHistory[0]?.status === "running",
  );
  const canRun = automation.status === "current" && !running;
  return (
    <section className="gyro-automation-detail">
      <header>
        <div>
          <strong>{automation.title}</strong>
          <span>
            {automation.project} · {automation.provider}
          </span>
        </div>
        <div className="gyro-board-actions">
          <button
            className="gyro-secondary-button"
            onClick={onToggle}
            type="button"
          >
            {automation.status === "completed" ? (
              <RefreshCw size={15} />
            ) : automation.status === "paused" ? (
              <Play size={15} />
            ) : (
              <PauseCircle size={15} />
            )}
            {automation.status === "completed"
              ? "Reactivate"
              : automation.status === "paused"
                ? "Resume"
                : "Pause"}
          </button>
          <button
            className="gyro-primary-button"
            disabled={!canRun}
            onClick={onRun}
            type="button"
          >
            <Play size={15} />
            {running ? "Running" : "Run"}
          </button>
        </div>
      </header>

      <div className="gyro-automation-detail-grid">
        <AutomationFact label="Schedule" value={automation.schedule} />
        <AutomationFact
          label="Next run"
          value={
            automation.nextRunAt
              ? relativeFutureTime(automation.nextRunAt)
              : "manual"
          }
        />
        <AutomationFact label="Branch" value={automation.branch} />
        <AutomationFact
          label="Workspace"
          value={
            automation.worktreeName ??
            automation.execution?.workspacePath ??
            automation.workspaceMode
          }
        />
        <AutomationFact
          label="Model"
          value={
            automation.execution?.modelLabel ??
            automation.execution?.modelId ??
            "Provider default"
          }
        />
        <AutomationFact
          label="Lease"
          value={
            automation.leaseOwner
              ? `${automation.leaseOwner} · ${
                  automation.leaseExpiresAt
                    ? relativeFutureTime(automation.leaseExpiresAt)
                    : "active"
                }`
              : "available"
          }
        />
      </div>

      <div className="gyro-automation-prompt">
        <span>Prompt</span>
        <p>{automation.prompt}</p>
      </div>

      <div className="gyro-automation-stop">
        <Check size={15} />
        <span>{automation.stopCondition ?? "No automatic stop condition"}</span>
      </div>

      <div className="gyro-automation-result">
        <div>
          <strong>Latest result</strong>
          <span>{automation.lastResult}</span>
        </div>
        <button
          className="gyro-secondary-button"
          disabled={automation.triageState !== "needs-review"}
          onClick={onArchive}
          type="button"
        >
          <Archive size={15} />
          Archive
        </button>
      </div>

      <div className="gyro-automation-history">
        <strong>Run history</strong>
        {automation.runHistory.length === 0 ? (
          <div className="gyro-empty-row">No runs recorded yet</div>
        ) : null}
        {automation.runHistory.map((run) => (
          <div className="gyro-automation-run" key={run.id}>
            <span className={`is-${run.status}`}>{run.status}</span>
            <strong>{run.summary}</strong>
            <small>
              {run.stopConditionMet === true
                ? "Stop condition met · "
                : run.stopConditionMet === false
                  ? "Condition not met · "
                  : ""}
              {relativeSessionTime(run.startedAt)}
            </small>
          </div>
        ))}
      </div>
    </section>
  );
}

function AutomationFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="gyro-automation-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function relativeFutureTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "";
  }
  const minutes = Math.max(0, Math.round((timestamp - Date.now()) / 60_000));
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `in ${hours}h`;
  }
  return `in ${Math.round(hours / 24)}d`;
}

export function ProvidersSurface({
  config,
  providerStatuses,
  providerSessions = [],
  providerHandoffs = [],
  onToggleProvider,
  onTestProvider,
  onQueueProviderHandoff,
  onAddCustomProfile,
}: {
  config: GyroConfig;
  providerStatuses?: ProviderStatus[];
  providerSessions?: ProviderSession[];
  providerHandoffs?: ProviderHandoff[];
  onToggleProvider?: (providerId: string) => void;
  onTestProvider?: (providerId: string) => void;
  onQueueProviderHandoff?: (request: {
    fromProviderId: string;
    toProviderId: string;
    contextSummary: string;
  }) => void;
  onAddCustomProfile?: () => void;
}) {
  const providerConfigs = providersForConfig(config);
  const commandProfiles = commandProfilesWithDefaults(config.commandProfiles);
  const statuses =
    providerStatuses && providerStatuses.length > 0
      ? providerStatuses
      : defaultProviderStatuses();
  const [fromProviderId, setFromProviderId] = useState<string>(
    providerConfigs[0]?.id ?? "openai",
  );
  const [toProviderId, setToProviderId] = useState<string>(
    providerConfigs[1]?.id ?? providerConfigs[0]?.id ?? "anthropic",
  );
  const [handoffSummary, setHandoffSummary] = useState(
    "Carry the current thread, workspace mode, branch, diff state, and terminal notes.",
  );
  const canQueueHandoff = Boolean(
    fromProviderId &&
    toProviderId &&
    fromProviderId !== toProviderId &&
    handoffSummary.trim(),
  );
  const enabledProviderCount = providerConfigs.filter(
    (provider) => provider.authStatus === "connected",
  ).length;

  return (
    <div className="gyro-providers-surface">
      <header className="gyro-provider-hero gyro-surface-page-header">
        <div className="gyro-surface-page-title">
          <span className="gyro-surface-page-icon" aria-hidden="true">
            <KeyRound size={18} />
          </span>
          <div>
            <span className="gyro-surface-page-eyebrow">Agent stack</span>
            <h1>Agents &amp; Providers</h1>
            <p>
              Gyro local access stays separate from provider CLI, SDK, and env
              auth. Manage models without blurring local trust boundaries.
            </p>
          </div>
        </div>
        <span className="gyro-live-pill">{enabledProviderCount} connected</span>
      </header>

      <section className="gyro-provider-boundary" aria-label="Auth boundary">
        <div>
          <strong>Gyro local access</strong>
          <span>
            Device sessions, workspace access, app bridge state, and revocation
            stay Gyro-owned.
          </span>
        </div>
        <div>
          <strong>Provider accounts</strong>
          <span>
            OpenAI, Anthropic, xAI, and Gemini credentials stay in official
            CLIs, SDK stores, Keychain entries, or env vars.
          </span>
        </div>
        <div>
          <strong>Diagnostics</strong>
          <span>
            Provider event logs are sensitive and opt-in; health output is
            redacted before it appears in Gyro.
          </span>
        </div>
      </section>

      <section className="gyro-provider-card-grid" aria-label="Providers">
        {providerConfigs.map((provider) => (
          <article className="gyro-provider-card" key={provider.id}>
            {(() => {
              const status = statuses.find((item) => item.id === provider.id);
              return (
                <>
                  <div className="gyro-provider-card-head">
                    <div className="gyro-provider-icon">
                      <ProviderLogo providerId={provider.id} />
                    </div>
                    <div>
                      <strong>{provider.displayName}</strong>
                      <span>
                        {provider.authMode.toUpperCase()} ·{" "}
                        {providerConnectionLabel(provider)} ·{" "}
                        {status?.runtimeStatus ??
                          status?.connectionStatus ??
                          "unknown"}
                      </span>
                    </div>
                    <span
                      className={
                        provider.authStatus === "connected"
                          ? "gyro-provider-state is-enabled"
                          : "gyro-provider-state"
                      }
                    >
                      {provider.authStatus === "connected"
                        ? "on"
                        : provider.authStatus === "connecting"
                          ? "connecting"
                          : "off"}
                    </span>
                  </div>
                  <div className="gyro-provider-card-body">
                    <SettingsRow
                      detail={providerAuthSummary(provider.id)}
                      label="Auth"
                      value={providerAuthOwnerLabel(
                        status?.authOwner ?? status?.healthDetails?.authOwner,
                      )}
                    />
                    <SettingsRow
                      detail={providerCredentialSummary(
                        status?.healthDetails?.secretStorage,
                      )}
                      label="Storage"
                      value={provider.apiKeyRef}
                    />
                    <div className="gyro-provider-health">
                      <span
                        className={`is-${status?.connectionStatus ?? "not-configured"}`}
                      />
                      <div>
                        <strong>Health</strong>
                        <small>
                          {status?.healthSummary ??
                            (provider.authStatus === "connected"
                              ? providerConnectedHealthCopy(provider)
                              : "Connect before checking.")}
                        </small>
                      </div>
                      <em>
                        {status?.healthCheckedAt
                          ? relativeSessionTime(status.healthCheckedAt)
                          : (status?.connectionStatus ?? "not-configured")}
                      </em>
                    </div>
                    <div className="gyro-provider-health-meta">
                      <span>Runtime: {status?.runtimeStatus ?? "unknown"}</span>
                      <span>
                        Logs:{" "}
                        {status?.healthDetails?.diagnosticsOptIn
                          ? "opted in"
                          : "off by default"}
                      </span>
                      {status?.healthDetails?.subscriptionLabel ? (
                        <span>
                          Plan: {status.healthDetails.subscriptionLabel}
                        </span>
                      ) : null}
                      {status?.healthDetails?.providerMode ? (
                        <span>Mode: {status.healthDetails.providerMode}</span>
                      ) : null}
                    </div>
                    <div className="gyro-provider-actions">
                      <button
                        className="gyro-secondary-button"
                        disabled={provider.authStatus === "connecting"}
                        onClick={() => onToggleProvider?.(provider.id)}
                        type="button"
                      >
                        {providerPrimaryActionLabel(provider)}
                      </button>
                      <button
                        className="gyro-secondary-button"
                        onClick={() => onTestProvider?.(provider.id)}
                        type="button"
                      >
                        {providerTestActionLabel(provider)}
                      </button>
                    </div>
                  </div>
                </>
              );
            })()}
          </article>
        ))}
      </section>

      <section className="gyro-provider-handoff-panel">
        <header>
          <div>
            <strong>Provider sessions</strong>
            <span>
              Queue handoffs between local provider profiles without losing
              thread context.
            </span>
          </div>
          <span className="gyro-live-pill">
            {providerSessions.length} local
          </span>
        </header>
        <div className="gyro-provider-handoff-form">
          <label>
            <span>From</span>
            <select
              onChange={(event) => setFromProviderId(event.target.value)}
              value={fromProviderId}
            >
              {providerConfigs.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>To</span>
            <select
              onChange={(event) => setToProviderId(event.target.value)}
              value={toProviderId}
            >
              {providerConfigs.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="is-wide">
            <span>Context</span>
            <input
              onChange={(event) => setHandoffSummary(event.target.value)}
              value={handoffSummary}
            />
          </label>
          <button
            className="gyro-primary-button"
            disabled={!canQueueHandoff}
            onClick={() =>
              onQueueProviderHandoff?.({
                fromProviderId,
                toProviderId,
                contextSummary: handoffSummary.trim(),
              })
            }
            type="button"
          >
            <ChevronRight size={15} />
            Queue handoff
          </button>
        </div>
        <div className="gyro-provider-handoff-grid">
          <div>
            <strong>Active sessions</strong>
            <div className="gyro-provider-session-list">
              {providerSessions.length === 0 ? (
                <div className="gyro-empty-row">No provider sessions yet</div>
              ) : null}
              {providerSessions.slice(0, 4).map((session) => (
                <div className="gyro-provider-session-row" key={session.id}>
                  <span className={`is-${session.status}`}>
                    {session.status}
                  </span>
                  <div>
                    <strong>{session.displayName}</strong>
                    <small>{session.sessionTitle}</small>
                  </div>
                  <em>{session.lastEvent}</em>
                </div>
              ))}
            </div>
          </div>
          <div>
            <strong>Recent handoffs</strong>
            <div className="gyro-provider-session-list">
              {providerHandoffs.length === 0 ? (
                <div className="gyro-empty-row">No handoffs queued yet</div>
              ) : null}
              {providerHandoffs.slice(0, 4).map((handoff) => (
                <div className="gyro-provider-session-row" key={handoff.id}>
                  <span className={`is-${handoff.status}`}>
                    {handoff.status}
                  </span>
                  <div>
                    <strong>
                      {handoff.fromLabel} to {handoff.toLabel}
                    </strong>
                    <small>{handoff.contextSummary}</small>
                  </div>
                  <em>{relativeSessionTime(handoff.createdAt)}</em>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="gyro-profile-mapping">
        <header>
          <div>
            <strong>Command profile mapping</strong>
            <span>
              Name, command, args, working directory, env, and detection.
            </span>
          </div>
          <button
            className="gyro-secondary-button"
            onClick={onAddCustomProfile}
            type="button"
          >
            <Plus size={15} />
            Add custom
          </button>
        </header>
        <div className="gyro-profile-table">
          <div className="gyro-profile-table-head">
            <span>Name</span>
            <span>Command</span>
            <span>Directory</span>
            <span>Detection</span>
          </div>
          {commandProfiles.map((profile) => (
            <div className="gyro-profile-table-row" key={profile.id}>
              <strong>{profile.displayName}</strong>
              <code>
                {profile.command} {profile.args.join(" ")}
              </code>
              <span>{profile.workingDirectory ?? "Workspace"}</span>
              <span>waiting/done/failed</span>
            </div>
          ))}
        </div>
      </section>

      <section className="gyro-provider-policy">
        <SettingsSection
          description="Default tool and permission boundaries for agent sessions."
          icon={ShieldCheck}
          title="Approval policy"
        >
          <SettingsRow
            detail="Command execution requests stay visible before they run."
            label="Terminal commands"
            value={config.requireCommandApproval ? "Ask" : "Allow"}
          />
          <SettingsRow
            detail="Agent-generated changes route through diff review."
            label="File edits"
            value={config.requireFileEditApproval ? "Ask" : "Allow"}
          />
          <SettingsRow
            detail="Shell, files, browser preview, tests, and git can be scoped."
            label="Allowed tools"
            value="Scoped"
          />
        </SettingsSection>
      </section>
    </div>
  );
}

export function DiffReviewSurface({
  compact = false,
  diffReview,
  onSelectFile,
  onToggleDirectory,
  onAcceptFile,
  onRejectFile,
  onAcceptAll,
  onRejectAll,
  onUndo,
  onComment,
  onOpenInEditor,
  onRunGitAction,
}: {
  compact?: boolean;
  diffReview?: DiffReview;
  onSelectFile?: (path: string) => void;
  onToggleDirectory?: (directory: string) => void;
  onAcceptFile?: (path: string) => void;
  onRejectFile?: (path: string) => void;
  onAcceptAll?: () => void;
  onRejectAll?: () => void;
  onUndo?: () => void;
  onComment?: (path: string) => void;
  onOpenInEditor?: (path: string) => void;
  onRunGitAction?: (actionId: GitReviewActionId) => void;
}) {
  const review = diffReview ?? {
    files: [
      {
        path: "packages/ui/src/surfaces.tsx",
        additions: 312,
        deletions: 64,
        source: "agent-generated" as const,
        state: "pending" as const,
        comments: 0,
        lines: [
          { number: 118, kind: "context" as const, content: "return (" },
          {
            number: 119,
            kind: "removed" as const,
            content: '<div className="gyro-static-pane">',
          },
          {
            number: 119,
            kind: "added" as const,
            content: "<DiffReviewSurface compact />",
          },
        ],
      },
    ],
    selectedPath: "packages/ui/src/surfaces.tsx",
    approvalState: "pending" as const,
    commitMessage: "Upgrade Gyro agent workbench UI surfaces",
    collapsedDirectories: [],
    gitActions: [],
    lastAction: "waiting for review",
  };
  const selectedFile =
    review.files.find((file) => file.path === review.selectedPath) ??
    review.files[0];
  const additions = review.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = review.files.reduce((sum, file) => sum + file.deletions, 0);
  const collapsedDirectories = new Set(review.collapsedDirectories);
  const diffTree = buildDiffFileTree(review.files);
  const hasFiles = review.files.length > 0;

  return (
    <div
      className={compact ? "gyro-diff-review is-compact" : "gyro-diff-review"}
    >
      <aside className="gyro-diff-file-list" aria-label="Changed files">
        <header>
          <strong>Changed files</strong>
          <span>
            +{additions} -{deletions}
          </span>
        </header>
        <div className="gyro-diff-tree" role="tree">
          {diffTree.length === 0 ? (
            <div className="gyro-diff-tree-empty">No file changes yet.</div>
          ) : (
            diffTree.map((node) =>
              renderDiffTreeNode({
                collapsedDirectories,
                node,
                onSelectFile,
                onToggleDirectory,
                selectedPath: review.selectedPath,
              }),
            )
          )}
        </div>
      </aside>
      <section className="gyro-diff-main" aria-label="Diff review">
        <div className="gyro-diff-review-toolbar">
          <div>
            <strong>{selectedFile?.path ?? "No file selected"}</strong>
            {selectedFile ? (
              <span>
                Safety: {selectedFile.source} · {review.approvalState} ·{" "}
                {review.lastAction}
              </span>
            ) : (
              <span>No changes proposed</span>
            )}
          </div>
          <div className="gyro-diff-actions">
            <button
              className="gyro-secondary-button"
              disabled={!selectedFile}
              onClick={() =>
                selectedFile && onOpenInEditor?.(selectedFile.path)
              }
              type="button"
            >
              <FileCode2 size={15} />
              Open editor
            </button>
            <button
              className="gyro-secondary-button"
              disabled={!hasFiles}
              onClick={onUndo}
              type="button"
            >
              <RefreshCw size={15} />
              Undo
            </button>
            <button
              className="gyro-secondary-button"
              disabled={!selectedFile}
              onClick={() => selectedFile && onRejectFile?.(selectedFile.path)}
              type="button"
            >
              <X size={15} />
              Reject file
            </button>
            <button
              className="gyro-primary-button"
              disabled={!selectedFile}
              onClick={() => selectedFile && onAcceptFile?.(selectedFile.path)}
              type="button"
            >
              <Check size={15} />
              Accept file
            </button>
          </div>
        </div>
        <div className="gyro-inline-diff">
          {selectedFile ? (
            <>
              {selectedFile.lines.map((line, index) => (
                <div className={`gyro-diff-line is-${line.kind}`} key={index}>
                  <span>{line.number}</span>
                  <code>{line.content}</code>
                </div>
              ))}
              <button
                className="gyro-diff-comment"
                onClick={() => onComment?.(selectedFile.path)}
                type="button"
              >
                <Plus size={14} />
                Comment on this hunk
                {selectedFile.comments ? ` (${selectedFile.comments})` : ""}
              </button>
            </>
          ) : (
            <div className="gyro-diff-empty-state">
              <GitPullRequest size={18} />
              <strong>No changes to review</strong>
              <span>Proposed file edits will appear here before approval.</span>
            </div>
          )}
        </div>
        <footer className="gyro-diff-review-footer">
          <div>
            <strong>Commit message preview</strong>
            <span>{review.commitMessage}</span>
          </div>
          <div className="gyro-git-action-strip" aria-label="Git actions">
            {review.gitActions.map((action) => {
              const Icon = gitReviewActionIcon(action.id);
              const gitActionStatus = hasFiles ? action.status : "blocked";
              return (
                <button
                  className={`is-${gitActionStatus}`}
                  disabled={gitActionStatus !== "ready"}
                  key={action.id}
                  onClick={() => onRunGitAction?.(action.id)}
                  title={action.detail}
                  type="button"
                >
                  <Icon size={14} />
                  <span>{action.label}</span>
                  <small>{gitActionStatus}</small>
                </button>
              );
            })}
          </div>
          <div>
            <button
              className="gyro-secondary-button"
              disabled={!hasFiles}
              onClick={onRejectAll}
              type="button"
            >
              Reject all
            </button>
            <button
              className="gyro-primary-button"
              disabled={!hasFiles}
              onClick={onAcceptAll}
              type="button"
            >
              Approve changes
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function gitReviewActionIcon(actionId: GitReviewActionId): IconComponent {
  if (actionId === "create-branch") {
    return GitBranch;
  }
  if (actionId === "commit") {
    return Check;
  }
  if (actionId === "push") {
    return ArrowUp;
  }
  return GitPullRequest;
}

type DiffTreeNode = DiffTreeDirectoryNode | DiffTreeFileNode;

type DiffTreeDirectoryNode = {
  kind: "directory";
  name: string;
  path: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  pendingFiles: number;
  children: DiffTreeNode[];
};

type DiffTreeFileNode = {
  kind: "file";
  name: string;
  path: string;
  file: DiffFile;
};

function buildDiffFileTree(files: DiffFile[]): DiffTreeNode[] {
  const root: DiffTreeNode[] = [];
  const directories = new Map<string, DiffTreeDirectoryNode>();

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    const fileName = parts.at(-1) ?? file.path;
    const directoriesForFile = parts.slice(0, -1);
    let children = root;

    directoriesForFile.forEach((directoryName, index) => {
      const directoryPath = directoriesForFile.slice(0, index + 1).join("/");
      let directory = directories.get(directoryPath);
      if (!directory) {
        directory = {
          additions: 0,
          changedFiles: 0,
          children: [],
          deletions: 0,
          kind: "directory",
          name: directoryName,
          path: directoryPath,
          pendingFiles: 0,
        };
        directories.set(directoryPath, directory);
        children.push(directory);
      }
      children = directory.children;
    });

    children.push({
      file,
      kind: "file",
      name: fileName,
      path: file.path,
    });
  }

  aggregateDiffTree(root);
  return root;
}

function aggregateDiffTree(nodes: DiffTreeNode[]) {
  nodes.sort((first, second) => {
    if (first.kind !== second.kind) {
      return first.kind === "directory" ? -1 : 1;
    }
    return first.name.localeCompare(second.name);
  });

  for (const node of nodes) {
    if (node.kind === "file") {
      continue;
    }
    aggregateDiffTree(node.children);
    node.additions = node.children.reduce(
      (sum, child) =>
        sum +
        (child.kind === "directory" ? child.additions : child.file.additions),
      0,
    );
    node.deletions = node.children.reduce(
      (sum, child) =>
        sum +
        (child.kind === "directory" ? child.deletions : child.file.deletions),
      0,
    );
    node.changedFiles = node.children.reduce(
      (sum, child) =>
        sum + (child.kind === "directory" ? child.changedFiles : 1),
      0,
    );
    node.pendingFiles = node.children.reduce(
      (sum, child) =>
        sum +
        (child.kind === "directory"
          ? child.pendingFiles
          : child.file.state === "pending"
            ? 1
            : 0),
      0,
    );
  }
}

function renderDiffTreeNode({
  collapsedDirectories,
  depth = 0,
  node,
  onSelectFile,
  onToggleDirectory,
  selectedPath,
}: {
  collapsedDirectories: Set<string>;
  depth?: number;
  node: DiffTreeNode;
  onSelectFile?: (path: string) => void;
  onToggleDirectory?: (directory: string) => void;
  selectedPath: string;
}): ReactNode {
  if (node.kind === "file") {
    const file = node.file;
    return (
      <button
        className={
          file.path === selectedPath
            ? "gyro-diff-tree-file is-active"
            : "gyro-diff-tree-file"
        }
        key={file.path}
        onClick={() => onSelectFile?.(file.path)}
        role="treeitem"
        style={{ paddingLeft: `${10 + depth * 12}px` }}
        type="button"
      >
        <FileText size={14} />
        <span>{node.name}</span>
        <small>
          +{file.additions} -{file.deletions} · {file.state}
        </small>
      </button>
    );
  }

  const isExpanded = !collapsedDirectories.has(node.path);

  return (
    <div className="gyro-diff-tree-group" key={node.path} role="none">
      <button
        aria-expanded={isExpanded}
        className="gyro-diff-tree-directory"
        onClick={() => onToggleDirectory?.(node.path)}
        role="treeitem"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        type="button"
      >
        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Folder size={14} />
        <span>{node.name}</span>
        <small>
          {node.changedFiles} · +{node.additions} -{node.deletions}
          {node.pendingFiles > 0 ? ` · ${node.pendingFiles} pending` : ""}
        </small>
      </button>
      {isExpanded ? (
        <div className="gyro-diff-tree-children" role="group">
          {node.children.map((child) =>
            renderDiffTreeNode({
              collapsedDirectories,
              depth: depth + 1,
              node: child,
              onSelectFile,
              onToggleDirectory,
              selectedPath,
            }),
          )}
        </div>
      ) : null}
    </div>
  );
}

export function BrowserPreviewSurface({
  compact = false,
  browserPreview,
  onBack,
  onForward,
  onReload,
  onUrlChange,
  onNavigate,
  onDeviceChange,
  onScreenshot,
  onOpenExternal,
}: {
  compact?: boolean;
  browserPreview?: BrowserPreview;
  onBack?: () => void;
  onForward?: () => void;
  onReload?: () => void;
  onUrlChange?: (url: string) => void;
  onNavigate?: (url: string) => void;
  onDeviceChange?: (device: BrowserPreviewDevice) => void;
  onScreenshot?: (action?: BrowserScreenshotAction) => void;
  onOpenExternal?: () => void;
}) {
  const preview =
    browserPreview ??
    ({
      url: "http://localhost:1420",
      history: ["http://localhost:1420"],
      historyIndex: 0,
      device: "desktop",
      consoleErrors: 0,
      diagnostics: [],
      diagnosticsSupported: false,
      diagnosticsCaptured: false,
      captureStatus: "idle",
      status: "verification-passed",
      verificationMessage: "Agent verification passed",
    } satisfies BrowserPreview);
  const canGoBack = preview.historyIndex > 0;
  const canGoForward = preview.historyIndex < preview.history.length - 1;
  const [frameRevision, setFrameRevision] = useState(0);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const frameUrl = normalizedBrowserPreviewUrl(preview.url);
  const hasDiagnostics = preview.consoleErrors !== 0;
  const canCapturePreview = isLoopbackBrowserPreviewUrl(frameUrl);

  return (
    <div
      className={
        compact ? "gyro-browser-preview is-compact" : "gyro-browser-preview"
      }
    >
      <div className="gyro-browser-preview-toolbar">
        <button
          aria-label="Back"
          disabled={!canGoBack}
          onClick={onBack}
          type="button"
        >
          <ChevronRight className="is-back" size={16} />
        </button>
        <button
          aria-label="Forward"
          disabled={!canGoForward}
          onClick={onForward}
          type="button"
        >
          <ChevronRight size={16} />
        </button>
        <button
          aria-label="Reload"
          onClick={() => {
            setFrameRevision((revision) => revision + 1);
            onReload?.();
          }}
          type="button"
        >
          <RefreshCw size={15} />
        </button>
        <form
          className="gyro-url-bar"
          onSubmit={(event) => {
            event.preventDefault();
            onNavigate?.(frameUrl);
          }}
        >
          <Globe2 size={14} />
          <input
            aria-label="Preview URL"
            onChange={(event) => onUrlChange?.(event.target.value)}
            value={preview.url}
          />
          <small>
            {preview.url.includes("localhost") ? "localhost" : "web"}
          </small>
        </form>
        <select
          aria-label="Device size"
          onChange={(event) =>
            onDeviceChange?.(event.target.value as BrowserPreviewDevice)
          }
          value={preview.device}
        >
          <option value="desktop">Desktop 1440</option>
          <option value="tablet">Tablet 834</option>
          <option value="mobile">Mobile 390</option>
        </select>
        <button
          aria-label="Capture preview screenshot"
          className={`gyro-browser-capture-button${
            preview.captureStatus === "capturing" ? " is-capturing" : ""
          }`}
          disabled={preview.captureStatus === "capturing" || !canCapturePreview}
          onClick={() => onScreenshot?.("capture")}
          title={
            preview.captureStatus === "capturing"
              ? "Capturing preview"
              : canCapturePreview
                ? "Capture screenshot"
                : "Screenshots are available for local previews"
          }
          type="button"
        >
          <Camera size={15} />
        </button>
        <button
          aria-label="Open preview in browser"
          className="gyro-browser-external-button"
          onClick={onOpenExternal}
          title="Open in browser"
          type="button"
        >
          <Globe2 size={15} />
        </button>
      </div>
      <div className="gyro-browser-frame">
        <div
          className={`gyro-browser-page is-${preview.device}`}
          data-device-label={deviceLabel(preview.device)}
        >
          <iframe
            key={`${frameUrl}:${frameRevision}`}
            referrerPolicy="no-referrer"
            src={frameUrl}
            title="Local browser preview"
          />
        </div>
      </div>
      <div className="gyro-browser-statusbar">
        <div>
          <span
            className={
              preview.status === "verification-failed" ||
              preview.status === "console-error"
                ? "gyro-ring is-failed"
                : preview.status === "loading"
                  ? "gyro-ring is-running"
                  : "gyro-ring is-done"
            }
          />
          <span>
            {preview.verificationMessage} · {deviceLabel(preview.device)}
          </span>
        </div>
        {preview.captureStatus !== "idle" ? (
          <button
            className={
              preview.captureStatus === "failed" ? "has-errors" : undefined
            }
            disabled={preview.captureStatus !== "captured"}
            onClick={() => onScreenshot?.("reveal")}
            title={
              preview.captureStatus === "failed"
                ? preview.captureError
                : preview.latestCapture?.path
            }
            type="button"
          >
            <Camera size={13} />
            {preview.captureStatus === "capturing"
              ? "Capturing..."
              : preview.captureStatus === "failed"
                ? "Capture failed"
                : `${preview.latestCapture?.width ?? 0} x ${preview.latestCapture?.height ?? 0}`}
          </button>
        ) : null}
        <button
          aria-expanded={isDiagnosticsOpen}
          className={hasDiagnostics ? "has-errors" : ""}
          disabled={!preview.diagnosticsCaptured || !hasDiagnostics}
          onClick={() => setIsDiagnosticsOpen((open) => !open)}
          type="button"
        >
          <TriangleAlert size={13} />
          {preview.diagnosticsCaptured
            ? preview.consoleErrors === 0
              ? "No page errors"
              : `${preview.consoleErrors} issue${preview.consoleErrors === 1 ? "" : "s"}`
            : preview.diagnosticsSupported
              ? "Diagnostics unavailable"
              : "HTTP check only"}
        </button>
      </div>
      {isDiagnosticsOpen && preview.diagnostics.length > 0 ? (
        <div
          aria-label="Browser preview diagnostics"
          className="gyro-browser-diagnostics"
          role="log"
        >
          {preview.diagnostics.map((diagnostic, index) => (
            <div
              key={`${diagnostic.kind}:${diagnostic.source ?? "page"}:${index}`}
            >
              <TriangleAlert aria-hidden="true" size={14} />
              <span>
                <strong>{browserDiagnosticLabel(diagnostic.kind)}</strong>
                <small>{diagnostic.message}</small>
              </span>
              {diagnostic.source ? (
                <code>
                  {diagnostic.source}
                  {diagnostic.line ? `:${diagnostic.line}` : ""}
                  {diagnostic.column ? `:${diagnostic.column}` : ""}
                </code>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function browserDiagnosticLabel(
  kind: BrowserPreview["diagnostics"][number]["kind"],
) {
  switch (kind) {
    case "console-error":
      return "Console error";
    case "unhandled-rejection":
      return "Unhandled promise";
    case "page-error":
      return "Page error";
  }
}

function normalizedBrowserPreviewUrl(value: string) {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "about:blank";
  }
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : "about:blank";
  } catch {
    return "about:blank";
  }
}

function isLoopbackBrowserPreviewUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

type GlobalSearchAction = {
  id: string;
  label: string;
  meta: string;
  destination?: AppDestination;
  layout?: WorkspaceLayoutId;
  toolTab?: WorkbenchPaneTab;
  icon: IconComponent;
  keywords?: string;
  shortcut?: { mac: string; other: string };
};

type GlobalSearchEntry = {
  id: string;
  label: string;
  detail: string;
  icon: IconComponent;
  selection: GlobalSearchSelection;
  shortcut?: string;
  searchText: string;
  priority: number;
  action?: GlobalSearchAction;
};

type GlobalSearchGroup = {
  id: string;
  label: string;
  entries: GlobalSearchEntry[];
};

const globalSearchActions: GlobalSearchAction[] = [
  {
    id: "new-chat",
    label: "New chat",
    meta: "Start a desktop session",
    destination: "workspace",
    layout: "thread",
    icon: MessageSquare,
    keywords: "thread conversation",
    shortcut: { mac: "⌘N", other: "Ctrl N" },
  },
  {
    id: "open-workspace",
    label: "Open project",
    meta: "Choose a local folder",
    destination: "workspace",
    layout: "thread",
    icon: Folder,
    keywords: "workspace folder add",
  },
  {
    id: "new-terminal",
    label: "New terminal",
    meta: "Open a local shell pane",
    destination: "workspace",
    layout: "terminal-grid",
    toolTab: "terminal",
    icon: Terminal,
    shortcut: { mac: "⌘T", other: "Ctrl T" },
  },
  {
    id: "search-files",
    label: "Search files",
    meta: "Search workspace content",
    destination: "workspace",
    layout: "code",
    icon: Search,
    keywords: "code find",
    shortcut: { mac: "⇧⌘F", other: "Ctrl Shift F" },
  },
  {
    id: "open-settings",
    label: "Open settings",
    meta: "Preferences",
    destination: "settings",
    icon: Settings,
    shortcut: { mac: "⌘,", other: "Ctrl ," },
  },
  {
    id: "toggle-theme",
    label: "Toggle theme",
    meta: "Switch between dark and light",
    icon: Palette,
    keywords: "appearance color",
  },
  {
    id: "run-codex",
    label: "Start Codex CLI",
    meta: "Open Codex in a terminal pane",
    destination: "workspace",
    layout: "terminal-grid",
    toolTab: "terminal",
    icon: Bot,
  },
  {
    id: "run-claude",
    label: "Start Claude Code",
    meta: "Open Claude in a terminal pane",
    destination: "workspace",
    layout: "terminal-grid",
    toolTab: "terminal",
    icon: Bot,
  },
  {
    id: "split-terminal",
    label: "Split terminal",
    meta: "Choose a pane template",
    destination: "workspace",
    layout: "terminal-grid",
    toolTab: "terminal",
    icon: PanelRight,
    shortcut: { mac: "⌘\\", other: "Ctrl \\" },
  },
  {
    id: "configure-cli-launcher",
    label: "Set CLI launch preset",
    meta: "Choose agents and pane counts",
    destination: "settings",
    icon: SlidersHorizontal,
  },
  {
    id: "open-browser-preview",
    label: "Open browser preview",
    meta: "Inspect a local web app",
    destination: "workspace",
    toolTab: "browser",
    icon: Globe2,
  },
  {
    id: "show-diffs",
    label: "Show diffs",
    meta: "Review workspace changes",
    destination: "workspace",
    toolTab: "diff",
    icon: GitPullRequest,
  },
  {
    id: "run-tests",
    label: "Run tests",
    meta: "Send the test command to a terminal",
    destination: "workspace",
    layout: "terminal-grid",
    toolTab: "terminal",
    icon: Play,
  },
  {
    id: "create-task",
    label: "Create task",
    meta: "Add an item to the plan board",
    destination: "tasks",
    icon: Activity,
  },
  {
    id: "open-automations",
    label: "Open automations",
    meta: "View scheduled local runs",
    destination: "automations",
    icon: CalendarClock,
  },
  {
    id: "create-automation",
    label: "Create automation",
    meta: "Schedule an agent check",
    destination: "automations",
    icon: CalendarClock,
  },
  {
    id: "run-automation",
    label: "Run automation",
    meta: "Queue the selected automation",
    destination: "automations",
    icon: Play,
  },
  {
    id: "open-providers",
    label: "Open providers",
    meta: "Profiles, health, and handoffs",
    destination: "providers",
    icon: KeyRound,
  },
];

function isMacPlatform() {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  );
}

function primaryGlobalSearchShortcut() {
  return isMacPlatform() ? "⌘K" : "Ctrl K";
}

export function CommandPaletteOverlay({
  onClose,
  onSelectDestination,
  onSelectWorkspaceLayout,
  onOpenToolPanel,
  recents = [],
  sessions = [],
  projects = [],
  pinnedSessionIds = [],
  query = "",
  onQueryChange,
  onCommand,
  onSelectSession,
  onSelectProject,
}: {
  onClose: () => void;
  onSelectDestination: (destination: AppDestination) => void;
  onSelectWorkspaceLayout: (layout: WorkspaceLayoutId) => void;
  onOpenToolPanel: (tab: WorkbenchPaneTab) => void;
  recents?: string[];
  sessions?: Session[];
  projects?: GlobalSearchProject[];
  pinnedSessionIds?: string[];
  query?: string;
  onQueryChange?: (query: string) => void;
  onCommand?: (commandId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onSelectProject?: (path: string) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const normalizedQuery = normalizedGlobalSearchText(query);
  const platformShortcut = (shortcut?: GlobalSearchAction["shortcut"]) =>
    shortcut ? (isMacPlatform() ? shortcut.mac : shortcut.other) : undefined;
  const actionEntries = useMemo(
    () =>
      globalSearchActions.map<GlobalSearchEntry>((action, index) => ({
        id: `action:${action.id}`,
        label: action.label,
        detail: action.meta,
        icon: action.icon,
        selection: { kind: "action", id: action.id },
        shortcut: platformShortcut(action.shortcut),
        searchText: `${action.label} ${action.meta} ${action.keywords ?? ""}`,
        priority:
          recents.indexOf(action.id) >= 0
            ? recents.indexOf(action.id)
            : 100 + index,
        action,
      })),
    [recents],
  );
  const sessionEntries = useMemo(() => {
    const pinned = new Set(pinnedSessionIds);
    return [...sessions]
      .sort(
        (first, second) =>
          Number(pinned.has(second.id)) - Number(pinned.has(first.id)) ||
          new Date(second.updatedAt).getTime() -
            new Date(first.updatedAt).getTime(),
      )
      .map<GlobalSearchEntry>((session, index) => ({
        id: `session:${session.id}`,
        label: session.title || "Untitled session",
        detail:
          session.summary ||
          `${workspaceName(session.workspacePath)}${session.providerLabel ? ` · ${session.providerLabel}` : ""}`,
        icon: pinned.has(session.id) ? Pin : MessageSquare,
        selection: { kind: "session", sessionId: session.id },
        searchText: `${session.title} ${session.summary ?? ""} ${session.workspacePath} ${session.providerLabel ?? ""}`,
        priority: (pinned.has(session.id) ? 0 : 100) + index,
      }));
  }, [pinnedSessionIds, sessions]);
  const projectEntries = useMemo(
    () =>
      projects.map<GlobalSearchEntry>((project, index) => ({
        id: `project:${project.path}`,
        label: project.label,
        detail: project.current
          ? "Current project"
          : project.detail || project.path,
        icon: project.current ? Folder : HardDrive,
        selection: { kind: "project", path: project.path },
        searchText: `${project.label} ${project.path} ${project.detail ?? ""}`,
        priority: (project.current ? 0 : 100) + index,
      })),
    [projects],
  );
  const groups = useMemo<GlobalSearchGroup[]>(() => {
    if (!normalizedQuery) {
      return [
        {
          id: "suggested",
          label: "Suggested",
          entries: actionEntries.slice(0, 6),
        },
        {
          id: "recent-sessions",
          label: "Recent sessions",
          entries: sessionEntries.slice(0, 5),
        },
        {
          id: "projects",
          label: "Projects",
          entries: projectEntries.slice(0, 4),
        },
      ].filter((group) => group.entries.length > 0);
    }
    const ranked = (entries: GlobalSearchEntry[]) =>
      entries
        .map((entry) => ({
          entry,
          score: globalSearchMatchScore(query, entry.label, entry.searchText),
        }))
        .filter(({ score }) => Number.isFinite(score))
        .sort(
          (first, second) =>
            first.score - second.score ||
            first.entry.priority - second.entry.priority ||
            first.entry.label.localeCompare(second.entry.label),
        )
        .slice(0, 8)
        .map(({ entry }) => entry);
    return [
      { id: "projects", label: "Projects", entries: ranked(projectEntries) },
      { id: "sessions", label: "Sessions", entries: ranked(sessionEntries) },
      { id: "actions", label: "Actions", entries: ranked(actionEntries) },
    ].filter((group) => group.entries.length > 0);
  }, [actionEntries, normalizedQuery, projectEntries, query, sessionEntries]);
  const visibleEntries = groups.flatMap((group) => group.entries);
  const activeEntry = visibleEntries[selectedIndex];

  useEffect(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => returnFocusRef.current?.focus();
  }, []);
  useEffect(() => setSelectedIndex(0), [query]);
  useEffect(() => {
    if (selectedIndex >= visibleEntries.length) {
      setSelectedIndex(Math.max(0, visibleEntries.length - 1));
    }
  }, [selectedIndex, visibleEntries.length]);

  const activateEntry = (entry?: GlobalSearchEntry) => {
    if (!entry) return;
    if (entry.selection.kind === "session") {
      onSelectSession?.(entry.selection.sessionId);
      onClose();
      return;
    }
    if (entry.selection.kind === "project") {
      onSelectProject?.(entry.selection.path);
      onClose();
      return;
    }
    const command = entry.action;
    if (!command) return;
    onCommand?.(command.id);
    if (command.destination) onSelectDestination(command.destination);
    if (command.layout) onSelectWorkspaceLayout(command.layout);
    if (command.toolTab) onOpenToolPanel(command.toolTab);
    onClose();
  };

  return (
    <div
      aria-modal="true"
      className="gyro-command-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      role="dialog"
    >
      <div
        aria-label="Search Gyro"
        className="gyro-command-palette is-global-search"
      >
        <header>
          <Search size={17} />
          <input
            aria-activedescendant={activeEntry?.id}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-label="Search projects, sessions, and actions"
            onChange={(event) => onQueryChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (visibleEntries.length === 0) return;
                const direction = event.key === "ArrowDown" ? 1 : -1;
                setSelectedIndex(
                  (current) =>
                    (current + direction + visibleEntries.length) %
                    visibleEntries.length,
                );
              } else if (event.key === "Home") {
                event.preventDefault();
                setSelectedIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setSelectedIndex(Math.max(0, visibleEntries.length - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                activateEntry(activeEntry);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder="Search projects, sessions, and actions"
            ref={inputRef}
            role="combobox"
            value={query}
          />
          <kbd>{primaryGlobalSearchShortcut()}</kbd>
        </header>
        <div
          aria-label="Search results"
          className="gyro-command-list"
          id={listboxId}
          role="listbox"
        >
          {visibleEntries.length === 0 ? (
            <div className="gyro-global-search-empty">
              <Search size={18} />
              <strong>No results for “{query.trim()}”</strong>
              <span>Try a project, session title, or Gyro action.</span>
            </div>
          ) : null}
          {groups.map((group) => (
            <section className="gyro-global-search-group" key={group.id}>
              <div className="gyro-global-search-heading">{group.label}</div>
              {group.entries.map((entry) => {
                const Icon = entry.icon;
                const index = visibleEntries.indexOf(entry);
                return (
                  <button
                    aria-selected={index === selectedIndex}
                    className={index === selectedIndex ? "is-active" : ""}
                    id={entry.id}
                    key={entry.id}
                    onClick={() => activateEntry(entry)}
                    onPointerDown={(event) => event.preventDefault()}
                    onPointerMove={() => setSelectedIndex(index)}
                    role="option"
                    type="button"
                  >
                    <span className="gyro-global-search-icon">
                      <Icon size={16} />
                    </span>
                    <span className="gyro-global-search-copy">
                      <strong>{entry.label}</strong>
                      <small>{entry.detail}</small>
                    </span>
                    {entry.shortcut ? <kbd>{entry.shortcut}</kbd> : null}
                  </button>
                );
              })}
            </section>
          ))}
          <span aria-live="polite" className="gyro-sr-only">
            {visibleEntries.length} results
          </span>
        </div>
        <footer className="gyro-global-search-footer">
          <span>Search stays local to this Mac.</span>
          <span>
            <kbd>↑↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}

type ModelStandardPromptOverlayProps = {
  modelLabel: string;
  providerId: ProviderId;
  providerLabel: string;
  selectionCount: number;
  onAccept: () => void;
  onDismiss: () => void;
};

export function ModelStandardPromptOverlay({
  modelLabel,
  providerId,
  providerLabel,
  selectionCount,
  onAccept,
  onDismiss,
}: ModelStandardPromptOverlayProps) {
  return (
    <div
      aria-modal="true"
      className="gyro-model-standard-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onDismiss();
        }
      }}
      role="dialog"
    >
      <section
        aria-label={`Make ${modelLabel} standard`}
        className="gyro-model-standard-card"
      >
        <div className="gyro-model-standard-head">
          <div className="gyro-model-standard-icon">
            <ProviderLogo providerId={providerId} />
          </div>
          <div>
            <span>{providerLabel}</span>
            <h2>You use {modelLabel} a lot.</h2>
          </div>
        </div>
        <p>
          Make it the model Gyro starts with for new chats and provider
          handoffs?
        </p>
        <div className="gyro-model-standard-meta">
          Selected {selectionCount} times
        </div>
        <div className="gyro-model-standard-actions">
          <button
            className="gyro-secondary-button"
            onClick={onDismiss}
            type="button"
          >
            No, not now
          </button>
          <button
            className="gyro-primary-button"
            onClick={onAccept}
            type="button"
          >
            Yes, make standard
          </button>
        </div>
      </section>
    </div>
  );
}

type ProjectRemoveConfirmOverlayProps = {
  projectLabel: string;
  projectPath?: string;
  sessionCount?: number;
  onKeep: () => void;
  onRemove: () => void;
};

export function ProjectRemoveConfirmOverlay({
  projectLabel,
  projectPath,
  sessionCount = 0,
  onKeep,
  onRemove,
}: ProjectRemoveConfirmOverlayProps) {
  const sessionCopy =
    sessionCount > 0
      ? `${sessionCount} chat${sessionCount === 1 ? "" : "s"} will be hidden in the app.`
      : "This project will be hidden from the app.";
  return (
    <div
      aria-modal="true"
      className="gyro-project-remove-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onKeep();
        }
      }}
      role="dialog"
    >
      <section
        aria-label={`Remove ${projectLabel} from Gyro app`}
        className="gyro-project-remove-card"
      >
        <h2>Remove from Gyro app?</h2>
        <p>
          Remove <strong>{projectLabel}</strong> from the Gyro app.{" "}
          {sessionCopy}
        </p>
        <p className="gyro-project-remove-note">
          Nothing will be deleted from your Mac.
        </p>
        {projectPath ? <code>{projectPath}</code> : null}
        <div className="gyro-project-remove-actions">
          <button
            autoFocus
            className="gyro-project-remove-keep"
            onClick={onKeep}
            type="button"
          >
            Keep
          </button>
          <button
            className="gyro-project-remove-confirm"
            onClick={onRemove}
            type="button"
          >
            Remove from app
          </button>
        </div>
      </section>
    </div>
  );
}

type TerminalTerminateConfirmOverlayProps = {
  terminalLabel: string;
  onCancel: () => void;
  onTerminate: () => void;
};

export function TerminalTerminateConfirmOverlay({
  terminalLabel,
  onCancel,
  onTerminate,
}: TerminalTerminateConfirmOverlayProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div
      aria-modal="true"
      className="gyro-terminal-terminate-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
      role="alertdialog"
    >
      <section
        aria-label={`Terminate ${terminalLabel}`}
        className="gyro-terminal-terminate-card"
      >
        <div className="gyro-terminal-terminate-heading">
          <Terminal size={16} />
          <h2>Terminate terminal?</h2>
        </div>
        <p>
          <strong>{terminalLabel}</strong> is still running. Its process will
          stop and the pane will close.
        </p>
        <div className="gyro-terminal-terminate-actions">
          <button autoFocus onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="is-danger" onClick={onTerminate} type="button">
            Terminate
          </button>
        </div>
      </section>
    </div>
  );
}

type SettingsPanelProps = {
  config: GyroConfig;
};

function notificationPermissionDetail(permission: NotificationPermissionState) {
  switch (permission) {
    case "granted":
      return "Enabled by macOS for background automation outcomes.";
    case "denied":
      return "Blocked by macOS. Change Gyro's notification access in System Settings.";
    case "prompt-with-rationale":
    case "prompt":
      return "Not enabled yet. Gyro asks only when you run the test.";
  }
}

type SettingsSurfaceProps = {
  config: GyroConfig;
  cliLaunchPreset?: CliLaunchPreset;
  themeMode: ThemeMode;
  density?: WorkbenchDensity;
  showMenuBarIcon?: boolean;
  activeSection?: SettingsSectionId;
  onThemeChange: (mode: ThemeMode) => void;
  onDensityChange?: (density: WorkbenchDensity) => void;
  onMenuBarVisibilityChange?: (visible: boolean) => void;
  onSectionChange?: (section: SettingsSectionId) => void;
  onConfigChange?: (config: GyroConfig) => void;
  onCheckForUpdates?: () => void;
  onCliLaunchPresetChange?: (preset: CliLaunchPreset) => void;
  onResetUiState?: () => void;
  onExportDiagnostics?: () => void;
  notificationPermission?: NotificationPermissionState;
  isTestingNotification?: boolean;
  onTestNotification?: () => void;
  onToggleProvider?: (providerId: string) => void;
  onTestProvider?: (providerId: string) => void;
  selectedUsageProviderId?: ProviderId;
  usageVisualization?: "bars" | "wheels";
  providerUsage?: ProviderUsageState;
  onUsageProviderChange?: (providerId: ProviderId) => void;
  onUsageVisualizationChange?: (visualization: "bars" | "wheels") => void;
  onRefreshProviderUsage?: (providerId: ProviderId) => void;
  updateState?: UpdateState;
};

function CliLaunchPresetEditor({
  onChange,
  preset,
  profiles,
}: {
  onChange?: (preset: CliLaunchPreset) => void;
  preset: CliLaunchPreset;
  profiles: CommandProfile[];
}) {
  const total = cliLaunchPresetPaneCount(preset);
  const updateEntry = (
    index: number,
    patch: Partial<CliLaunchPreset["entries"][number]>,
  ) => {
    const entries = preset.entries.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, ...patch } : entry,
    );
    onChange?.({ ...preset, entries });
  };
  const removeEntry = (index: number) => {
    const entries = preset.entries.filter(
      (_, entryIndex) => entryIndex !== index,
    );
    onChange?.({
      ...preset,
      entries:
        entries.length > 0 ? entries : [{ profileId: "shell", count: 1 }],
    });
  };
  const addEntry = () => {
    const profileId = profiles[0]?.id ?? "shell";
    onChange?.({
      ...preset,
      entries: [...preset.entries, { profileId, count: 1 }],
    });
  };

  return (
    <div className="gyro-cli-launch-preset">
      <header>
        <div>
          <strong>Launch preset</strong>
          <span>{cliLaunchPresetLabel(preset, profiles)}</span>
        </div>
        <small>
          {total}/{CLI_LAUNCH_PRESET_MAX_PANES} panes
        </small>
      </header>
      <div className="gyro-cli-launch-preset-rows">
        {preset.entries.map((entry, index) => {
          const canIncrease = total < CLI_LAUNCH_PRESET_MAX_PANES;
          return (
            <div
              className="gyro-cli-launch-preset-row"
              key={`${entry.profileId}-${index}`}
            >
              <select
                aria-label="Preset profile"
                onChange={(event) =>
                  updateEntry(index, { profileId: event.target.value })
                }
                value={entry.profileId}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.displayName}
                  </option>
                ))}
              </select>
              <div className="gyro-cli-launch-stepper">
                <button
                  aria-label="Decrease pane count"
                  disabled={entry.count <= 1}
                  onClick={() =>
                    updateEntry(index, { count: Math.max(1, entry.count - 1) })
                  }
                  type="button"
                >
                  <Minus size={13} />
                </button>
                <span>{entry.count}</span>
                <button
                  aria-label="Increase pane count"
                  disabled={!canIncrease}
                  onClick={() => updateEntry(index, { count: entry.count + 1 })}
                  type="button"
                >
                  <Plus size={13} />
                </button>
              </div>
              <button
                aria-label="Remove preset profile"
                className="gyro-icon-button is-subtle"
                onClick={() => removeEntry(index)}
                type="button"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <footer>
        <button
          className="gyro-secondary-button"
          disabled={total >= CLI_LAUNCH_PRESET_MAX_PANES}
          onClick={addEntry}
          type="button"
        >
          <Plus size={14} />
          Add profile
        </button>
        <div
          className="gyro-cli-launch-focus"
          role="group"
          aria-label="Focus pane"
        >
          <span>Focus after launch</span>
          <button
            className={preset.focus === "first" ? "is-active" : ""}
            onClick={() => onChange?.({ ...preset, focus: "first" })}
            type="button"
          >
            First
          </button>
          <button
            className={preset.focus === "last" ? "is-active" : ""}
            onClick={() => onChange?.({ ...preset, focus: "last" })}
            type="button"
          >
            Last
          </button>
        </div>
      </footer>
    </div>
  );
}

export function SettingsSurface({
  config,
  cliLaunchPreset = defaultCliLaunchPreset(),
  themeMode,
  density = "compact",
  showMenuBarIcon = true,
  activeSection = "general",
  onThemeChange,
  onDensityChange,
  onMenuBarVisibilityChange,
  onSectionChange,
  onConfigChange,
  onCheckForUpdates,
  onCliLaunchPresetChange,
  onResetUiState,
  onExportDiagnostics,
  notificationPermission = "prompt",
  isTestingNotification = false,
  onTestNotification,
  onToggleProvider,
  onTestProvider,
  selectedUsageProviderId,
  usageVisualization = "bars",
  providerUsage,
  onUsageProviderChange,
  onUsageVisualizationChange,
  onRefreshProviderUsage,
  updateState,
}: SettingsSurfaceProps) {
  const providerConfigs = providersForConfig(config);
  const enabledProviders = providerConfigs.filter(
    (provider) => provider.authStatus === "connected",
  );
  const disabledProviders = providerConfigs.filter(
    (provider) => provider.authStatus !== "connected",
  );
  const commandProfiles = commandProfilesWithDefaults(config.commandProfiles);
  const permissionCopy = providerApprovalCopy(
    config.selectedProviderId,
    config,
  );
  const usageProvider =
    providerConfigs.find(
      (provider) => provider.id === selectedUsageProviderId,
    ) ??
    enabledProviders[0] ??
    providerConfigs[0];
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);

  return (
    <div className="gyro-settings-surface">
      <section className="gyro-settings-content" aria-label="Settings">
        {activeSection === "general" ? (
          <SettingsSection
            icon={SlidersHorizontal}
            title="General"
            description="Workspace startup, local sessions, and default surfaces."
          >
            <SettingsGroup label="Startup">
              <SettingsRow
                label="Startup behavior"
                value="Open last workspace"
                detail="Gyro keeps local sessions available across app and CLI."
              />
              <SettingsRow
                label="Default workspace"
                value="Ask on launch"
                detail="Choose a folder only when the session needs filesystem access."
              />
              <SettingsRow
                label="Default surface"
                value="Sessions"
                detail="Chat and CLI sessions share one destination; Workspace remains one click away."
              />
              <SettingsRow
                label="Menu bar"
                detail="Keep Gyro's logo visible while chats and automations work in the background."
              >
                <SettingsSwitch
                  checked={showMenuBarIcon}
                  label="Show Gyro in menu bar"
                  onChange={(visible) => onMenuBarVisibilityChange?.(visible)}
                />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup label="Session behavior">
              <SettingsRow
                label="Session restore"
                value="Enabled by Gyro"
                detail="Terminal layouts and app sessions come back after restart."
              />
              <SettingsRow
                label="Continue sessions from CLI"
                value="Available"
                detail="CLI-origin sessions can attach back into the desktop app."
              />
            </SettingsGroup>
          </SettingsSection>
        ) : null}

        {activeSection === "appearance" ? (
          <SettingsSection
            icon={Palette}
            title="Appearance"
            description="Choose the interface mode used by every Gyro surface."
          >
            <SettingsGroup label="Interface">
              <div
                className="gyro-theme-picker"
                data-setting-key="theme"
                role="group"
                aria-label="Theme"
                tabIndex={-1}
              >
                <button
                  aria-pressed={themeMode === "dark"}
                  className={themeMode === "dark" ? "is-active" : ""}
                  onClick={() => onThemeChange("dark")}
                  type="button"
                >
                  <Moon size={17} />
                  <span>Dark</span>
                </button>
                <button
                  aria-pressed={themeMode === "light"}
                  className={themeMode === "light" ? "is-active" : ""}
                  onClick={() => onThemeChange("light")}
                  type="button"
                >
                  <Sun size={17} />
                  <span>Light</span>
                </button>
              </div>
              <SettingsRow
                label="Density"
                detail="Optimized for terminal grids and dense developer panes."
              >
                <SettingsSegmented
                  label="Interface density"
                  value={density}
                  options={[
                    { label: "Compact", value: "compact" },
                    { label: "Comfortable", value: "comfortable" },
                  ]}
                  onChange={(value) => onDensityChange?.(value)}
                />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup label="System">
              <SettingsRow
                label="Terminal font"
                value="SF Mono"
                detail="Applied across command blocks, CLI panes, and logs."
              />
              <SettingsRow
                label="Reduce motion"
                value="System"
                detail="Activity rings and transitions follow macOS preferences."
              />
            </SettingsGroup>
          </SettingsSection>
        ) : null}

        {activeSection === "usage-limits" ? (
          <SettingsSection
            icon={Gauge}
            title="Usage Limits"
            description="Local guardrails for agent runs, command output, and provider spend."
          >
            {usageProvider ? (
              <div className="gyro-usage-dashboard">
                <label className="gyro-usage-provider-select">
                  <span>Provider</span>
                  <select
                    aria-label="Usage provider"
                    value={usageProvider.id}
                    onChange={(event) =>
                      onUsageProviderChange?.(event.target.value as ProviderId)
                    }
                  >
                    {providerConfigs.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName} ·{" "}
                        {providerConnectionLabel(provider)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="gyro-usage-toolbar">
                  <div>
                    <strong>{usageProvider.displayName} allowance</strong>
                    <span>
                      {providerUsage?.fetchedAt
                        ? `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(providerUsage.fetchedAt))}${providerUsage.stale ? " · stale" : ""}`
                        : "Provider-reported usage only"}
                    </span>
                  </div>
                  <div className="gyro-usage-toolbar-actions">
                    <SettingsSegmented
                      label="Usage visualization"
                      value={usageVisualization}
                      options={[
                        { label: "Bars", value: "bars" },
                        { label: "Wheels", value: "wheels" },
                      ]}
                      onChange={(value) => onUsageVisualizationChange?.(value)}
                    />
                    <button
                      aria-label="Refresh provider usage"
                      className="gyro-icon-button is-subtle"
                      disabled={providerUsage?.status === "loading"}
                      onClick={() => onRefreshProviderUsage?.(usageProvider.id)}
                      title="Refresh provider usage"
                      type="button"
                    >
                      <RefreshCw
                        className={
                          providerUsage?.status === "loading"
                            ? "is-spinning"
                            : ""
                        }
                        size={14}
                      />
                    </button>
                  </div>
                </div>
                {providerUsage?.status === "available" ? (
                  <div className="gyro-usage-cards">
                    <UsageCard
                      window={providerUsage.windows.find(
                        (window) => window.id === "five-hour",
                      )}
                      visualization={usageVisualization}
                    />
                    <UsageCard
                      window={providerUsage.windows.find(
                        (window) => window.id === "weekly",
                      )}
                      visualization={usageVisualization}
                    />
                  </div>
                ) : (
                  <div className="gyro-usage-empty" role="status">
                    <Gauge size={22} />
                    <div>
                      <strong>
                        {providerUsage?.status === "loading"
                          ? "Loading provider usage…"
                          : providerUsage?.status === "error"
                            ? "Provider usage could not be loaded"
                            : "Usage unavailable from this provider"}
                      </strong>
                      <span>
                        {providerUsage?.error ??
                          "Gyro does not estimate allowance from local activity."}
                      </span>
                    </div>
                    <button
                      className="gyro-secondary-button"
                      disabled={providerUsage?.status === "loading"}
                      onClick={() => onRefreshProviderUsage?.(usageProvider.id)}
                      type="button"
                    >
                      <RefreshCw size={14} />
                      Refresh
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="gyro-usage-empty">
                <Gauge size={22} />
                <div>
                  <strong>No providers configured</strong>
                  <span>Connect a provider to inspect reported usage.</span>
                </div>
              </div>
            )}
            <SettingsGroup label="Provider limits">
              <SettingsRow
                label="Provider spend"
                value="Manual"
                detail="Provider billing and allowance controls remain provider-owned."
              />
              <SettingsRow
                label="Parallel agents"
                value="Ask first"
                detail="Multiple CLI agents stay explicit until provider health is stable."
              />
            </SettingsGroup>
            <SettingsGroup label="Local guardrails">
              <SettingsRow
                label="Command output"
                value="Bounded"
                detail="Large terminal output is summarized into readable command blocks."
              />
              <SettingsRow
                label="Approval budget"
                value="Strict"
                detail="File edits and command escalation remain gated by default."
              />
            </SettingsGroup>
          </SettingsSection>
        ) : null}

        {activeSection === "providers" ? (
          <SettingsSection
            icon={KeyRound}
            title="Providers"
            description="Connect model providers separately from local Gyro access; credentials stay in provider CLI, SDK, Keychain, or env storage."
          >
            <div className="gyro-provider-table is-native-list">
              <div className="gyro-provider-table-head">
                <span>Provider</span>
                <span>Connection</span>
                <span>Capability</span>
                <span>Actions</span>
              </div>
              {[...enabledProviders, ...disabledProviders].map((provider) => {
                const capabilities = providerCapabilities(provider.id);
                return (
                  <div
                    className={`gyro-provider-row${capabilities?.executable ? "" : " is-readiness-only"}`}
                    key={provider.id}
                  >
                    <div className="gyro-provider-identity">
                      <ProviderLogo providerId={provider.id} />
                      <div>
                        <strong>{provider.displayName}</strong>
                        <span>{selectedModelLabel(provider)}</span>
                      </div>
                    </div>
                    <SettingsStatus
                      status={
                        provider.authStatus === "connected"
                          ? "good"
                          : provider.authStatus === "connecting"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {providerConnectionLabel(provider)}
                    </SettingsStatus>
                    <div className="gyro-provider-capability">
                      <strong>
                        {capabilities?.executable
                          ? provider.id === "openai" ||
                            provider.id === "anthropic"
                            ? "Runs + Gyro tools"
                            : "Runs · tools unavailable"
                          : "Readiness only"}
                      </strong>
                      <span>{providerAuthSummary(provider.id)}</span>
                    </div>
                    <div className="gyro-settings-provider-actions">
                      <button
                        className="gyro-primary-button"
                        disabled={
                          provider.authStatus === "connecting" ||
                          provider.authStatus === "connected"
                        }
                        onClick={() => onToggleProvider?.(provider.id)}
                        type="button"
                      >
                        {provider.authStatus === "connected"
                          ? "Connected"
                          : provider.authMode === "env"
                            ? "Check environment"
                            : providerPrimaryActionLabel(provider)}
                      </button>
                      <button
                        className="gyro-secondary-button"
                        disabled={provider.authStatus === "connecting"}
                        onClick={() => onTestProvider?.(provider.id)}
                        type="button"
                      >
                        {providerTestActionLabel(provider)}
                      </button>
                      <details className="gyro-provider-details">
                        <summary aria-label={`${provider.displayName} details`}>
                          <MoreHorizontal size={16} />
                        </summary>
                        <div>
                          <strong>Technical details</strong>
                          <code>{provider.apiKeyRef}</code>
                          <span>
                            {provider.authMode.toUpperCase()} authentication
                          </span>
                          {provider.authStatus === "connected" ? (
                            <button
                              className="gyro-danger-button"
                              onClick={() => onToggleProvider?.(provider.id)}
                              type="button"
                            >
                              Disable in Gyro
                            </button>
                          ) : null}
                        </div>
                      </details>
                    </div>
                  </div>
                );
              })}
            </div>
          </SettingsSection>
        ) : null}

        {activeSection === "cli-profiles" ? (
          <SettingsSection
            icon={Terminal}
            title="CLI Profiles"
            description="Built-in and custom commands that can run in workbench panes."
          >
            <SettingsGroup label="Launch preset">
              <CliLaunchPresetEditor
                onChange={onCliLaunchPresetChange}
                preset={cliLaunchPreset}
                profiles={commandProfiles}
              />
            </SettingsGroup>
            <SettingsGroup label="Saved profiles">
              <div className="gyro-cli-profile-list">
                {commandProfiles.slice(0, 7).map((profile) => (
                  <div className="gyro-provider-row" key={profile.id}>
                    <div>
                      <strong>{profile.displayName}</strong>
                      <span>
                        {profile.workingDirectory ?? "Workspace root"}
                      </span>
                    </div>
                    <code>
                      {profile.command} {profile.args.join(" ")}
                    </code>
                  </div>
                ))}
              </div>
            </SettingsGroup>
            <SettingsGroup label="Notifications">
              <SettingsRow
                label="Hook notifications"
                value="Subtle"
                detail="Done, waiting, failed, and approval states show in app chrome."
              />
            </SettingsGroup>
          </SettingsSection>
        ) : null}

        {activeSection === "permissions" ? (
          <SettingsSection
            icon={LockKeyhole}
            title={permissionCopy.title}
            description={permissionCopy.settingsDetail}
          >
            <SettingsGroup label="Agent approvals">
              <SettingsRow
                label="Command policy"
                detail={permissionCopy.commandDetail}
              >
                <SettingsSwitch
                  label="Require command approval"
                  checked={config.requireCommandApproval}
                  onChange={(checked) =>
                    onConfigChange?.({
                      ...config,
                      requireCommandApproval: checked,
                      fullAccess: false,
                    })
                  }
                />
              </SettingsRow>
              <SettingsRow
                label="File edit policy"
                detail={permissionCopy.editDetail}
              >
                <SettingsSwitch
                  label="Require file edit approval"
                  checked={config.requireFileEditApproval}
                  onChange={(checked) =>
                    onConfigChange?.({
                      ...config,
                      requireFileEditApproval: checked,
                      fullAccess: false,
                    })
                  }
                />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup label="Workspace protection">
              <SettingsRow
                label="Workspace boundary"
                value="Current folder"
                detail="Agents need approval before reading outside the opened workspace."
              />
              <SettingsRow
                label="Network access"
                value="Ask"
                detail="External calls can be gated per provider or CLI profile."
              />
              <SettingsRow
                label="Secrets redaction"
                value="On"
                detail="Detected secrets are masked in prompts, logs, and diagnostics."
              />
            </SettingsGroup>
            <SettingsGroup label="System notifications">
              <SettingsRow
                label="Automation outcomes"
                detail={notificationPermissionDetail(notificationPermission)}
              >
                <button
                  className="gyro-secondary-button"
                  disabled={isTestingNotification || !onTestNotification}
                  onClick={onTestNotification}
                  type="button"
                >
                  {isTestingNotification ? "Sending..." : "Test notification"}
                </button>
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>
        ) : null}

        {activeSection === "updates" ? (
          <SettingsSection
            icon={RefreshCw}
            title="Updates"
            description="Public Alpha updates verified with Gyro's updater signature."
          >
            <div className="gyro-update-summary">
              <div>
                <span>Installed</span>
                <strong>{updateState?.currentVersion ?? "Unknown"}</strong>
              </div>
              <div>
                <span>Channel</span>
                <strong>Public Alpha</strong>
              </div>
              <div>
                <span>Status</span>
                <strong>{updateState?.status ?? "Unavailable"}</strong>
              </div>
            </div>
            <SettingsGroup label="Update preferences">
              <SettingsRow
                label="Update source"
                value="GitHub Releases"
                detail="Published public Alpha updater archives signed by Gyro's updater key."
              />
              <SettingsRow
                label="Automatic checks"
                detail="Checks after launch and occasionally when Gyro regains focus. Downloads still require a click."
              >
                <SettingsSwitch
                  label="Automatic update checks"
                  checked={config.automaticUpdateChecks !== false}
                  onChange={(checked) =>
                    onConfigChange?.({
                      ...config,
                      automaticUpdateChecks: checked,
                    })
                  }
                />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup label="Update status">
              <SettingsRow
                label="Last checked"
                detail={updateSettingsDetail(updateState)}
              >
                <button
                  className="gyro-secondary-button"
                  disabled={updateState?.status === "checking"}
                  onClick={onCheckForUpdates}
                  type="button"
                >
                  <RefreshCw
                    className={
                      updateState?.status === "checking" ? "is-spinning" : ""
                    }
                    size={14}
                  />
                  {updateState?.status === "checking"
                    ? "Checking…"
                    : "Check for updates"}
                </button>
                <span className="gyro-settings-control-note">
                  {formatUpdateCheckedAt(updateState?.lastCheckedAt)}
                </span>
              </SettingsRow>
              {updateState?.releaseNotes ? (
                <SettingsRow
                  label="What’s new"
                  value={updateState.nextVersion ?? "Available"}
                  detail={updateState.releaseNotes}
                />
              ) : null}
            </SettingsGroup>
          </SettingsSection>
        ) : null}

        {activeSection === "keyboard" ? (
          <SettingsSection
            icon={CommandIcon}
            title="Keyboard"
            description="Keyboard-first shortcuts for common workbench actions."
          >
            {(
              [
                {
                  label: "Navigation",
                  items: [
                    ["Command palette", "Cmd+K"],
                    ["Open settings", "Cmd+,"],
                  ],
                },
                {
                  label: "Sessions",
                  items: [
                    ["New session", "Cmd+N"],
                    ["Switch panes", "Cmd+1-9"],
                  ],
                },
                {
                  label: "Terminal",
                  items: [
                    ["New terminal", "Cmd+T"],
                    ["Split terminal", "Cmd+\\"],
                  ],
                },
                { label: "Search", items: [["Search", "Cmd+F"]] },
              ] as Array<{ label: string; items: Array<[string, string]> }>
            ).map((group) => (
              <SettingsGroup key={group.label} label={group.label}>
                {group.items.map(([label, value]) => (
                  <SettingsRow
                    detail="Built-in shortcut"
                    key={label}
                    label={label}
                  >
                    <kbd className="gyro-settings-key">{value}</kbd>
                  </SettingsRow>
                ))}
              </SettingsGroup>
            ))}
          </SettingsSection>
        ) : null}

        {activeSection === "advanced" ? (
          <SettingsSection
            icon={Settings}
            title="Advanced"
            description="Local sockets, files, diagnostics, and state reset."
          >
            <SettingsGroup label="Local runtime">
              <SettingsRow
                label="Local socket"
                value="ready"
                detail="CLI agents can attach to the desktop app through the local bridge."
              />
            </SettingsGroup>
            <SettingsGroup label="Storage and diagnostics">
              <SettingsRow
                label="Session store"
                detail="All sessions and terminal layouts are stored on this Mac."
              >
                <button
                  className="gyro-copy-value"
                  onClick={() =>
                    void navigator.clipboard?.writeText(
                      "Application Support/Gyro",
                    )
                  }
                  type="button"
                >
                  <code>Application Support/Gyro</code>
                  <Copy size={13} />
                </button>
              </SettingsRow>
              <SettingsRow
                label="Logs path"
                detail="Diagnostics are local until explicitly exported."
              >
                <button
                  className="gyro-copy-value"
                  onClick={() =>
                    void navigator.clipboard?.writeText("Logs/Gyro")
                  }
                  type="button"
                >
                  <code>Logs/Gyro</code>
                  <Copy size={13} />
                </button>
              </SettingsRow>
              <SettingsRow
                label="Export diagnostics"
                detail="Creates a redacted bundle for issue reports."
              >
                <button
                  className="gyro-secondary-button"
                  onClick={onExportDiagnostics}
                  type="button"
                >
                  Export diagnostics
                </button>
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup label="Reset">
              <SettingsRow
                label="Reset UI state"
                detail="Clears layout preferences without touching workspace files or provider credentials."
                tone="danger"
              >
                <button
                  className="gyro-danger-button"
                  onClick={() => setIsResetConfirmOpen(true)}
                  type="button"
                >
                  Reset UI state
                </button>
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>
        ) : null}

        {activeSection === "about" ? (
          <SettingsSection
            icon={HelpCircle}
            title="Help"
            description="Version, license, release notes, and security policy."
          >
            <div className="gyro-about-summary">
              <div>
                <strong>Gyro</strong>
                <span>Open-source, local-first coding agent workspace.</span>
              </div>
              <code>
                {updateState?.currentVersion ?? "Version unavailable"}
              </code>
            </div>
            <SettingsGroup label="About">
              <SettingsRow
                label="Version and build"
                value={updateState?.currentVersion ?? "Unknown"}
                detail="Include this value when requesting support."
              />
              <SettingsRow
                label="License"
                value="Apache-2.0"
                detail="Open-source licensing and governance live in the repository."
              />
            </SettingsGroup>
            <SettingsGroup label="Resources">
              <div className="gyro-resource-links">
                <a
                  href="https://github.com/wytzeh197/Gyro"
                  rel="noreferrer"
                  target="_blank"
                >
                  Repository <ArrowRight size={14} />
                </a>
                <a
                  href="https://github.com/wytzeh197/Gyro/releases"
                  rel="noreferrer"
                  target="_blank"
                >
                  Release notes <ArrowRight size={14} />
                </a>
                <a
                  href="https://github.com/wytzeh197/Gyro/blob/main/SECURITY.md"
                  rel="noreferrer"
                  target="_blank"
                >
                  Security policy <ArrowRight size={14} />
                </a>
              </div>
            </SettingsGroup>
          </SettingsSection>
        ) : null}
      </section>
      {isResetConfirmOpen ? (
        <div
          className="gyro-settings-confirm-overlay"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget)
              setIsResetConfirmOpen(false);
          }}
        >
          <section
            aria-label="Reset UI state"
            aria-modal="true"
            role="alertdialog"
          >
            <h2>Reset UI state?</h2>
            <p>
              This clears layout and presentation preferences. Workspace files,
              sessions, and provider credentials stay untouched.
            </p>
            <div>
              <button
                className="gyro-secondary-button"
                onClick={() => setIsResetConfirmOpen(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="gyro-danger-button"
                onClick={() => {
                  setIsResetConfirmOpen(false);
                  onResetUiState?.();
                }}
                type="button"
              >
                Reset UI state
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function formatUpdateCheckedAt(value?: string) {
  if (!value) {
    return "Not checked yet";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function updateSettingsDetail(state?: UpdateState) {
  if (!state) {
    return "Updater status is unavailable.";
  }
  if (state.status === "development") {
    return "Updater disabled in development. Production endpoints are not contacted.";
  }
  if (state.status === "checking") {
    return "Checking the signed update channel…";
  }
  if (state.status === "current") {
    return "Gyro is up to date.";
  }
  if (state.status === "failed") {
    return state.error ?? "The update check failed. Select this row to retry.";
  }
  if (state.status === "ready") {
    return "The downloaded update passed signature verification.";
  }
  return state.nextVersion
    ? `Signed update ${state.nextVersion} is ${state.status}.`
    : `Updater status: ${state.status}.`;
}

export function SettingsPanel({ config }: SettingsPanelProps) {
  return (
    <section className="gyro-panel gyro-settings" aria-label="Settings">
      <header>
        <ShieldCheck size={16} />
        <span>Settings</span>
      </header>
      <div className="gyro-settings-grid">
        <div>
          <CircleDashed size={15} />
          <span>Updates</span>
          <strong>GitHub</strong>
        </div>
        <div>
          <ShieldCheck size={15} />
          <span>Approvals</span>
          <strong>
            {config.requireCommandApproval && config.requireFileEditApproval
              ? "required"
              : "custom"}
          </strong>
        </div>
        <div>
          <KeyRound size={15} />
          <span>Providers</span>
          <strong>
            {
              providersForConfig(config).filter(
                (provider) => provider.authStatus === "connected",
              ).length
            }{" "}
            connected
          </strong>
        </div>
      </div>
    </section>
  );
}

function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: IconComponent;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      className="gyro-settings-section"
      data-setting-key={settingsSearchKey(title)}
      tabIndex={-1}
    >
      <header>
        <div>
          <h1>
            <Icon aria-hidden="true" size={18} />
            {title}
          </h1>
          <span>{description}</span>
        </div>
      </header>
      <div className="gyro-settings-section-body">{children}</div>
    </section>
  );
}

function SettingsRow({
  label,
  value,
  detail,
  onClick,
  children,
  tone,
}: {
  label: string;
  value?: string;
  detail: string;
  onClick?: () => void;
  children?: ReactNode;
  tone?: "danger";
}) {
  const content = (
    <>
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <div className="gyro-settings-control-column">
        {children ?? <span className="gyro-settings-info-value">{value}</span>}
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        className={`gyro-settings-row${tone ? ` is-${tone}` : ""}`}
        data-setting-key={settingsSearchKey(label)}
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className="gyro-settings-row"
      data-setting-key={settingsSearchKey(label)}
      tabIndex={-1}
    >
      {content}
    </div>
  );
}

function SettingsGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="gyro-settings-group">
      <h2>{label}</h2>
      <div className="gyro-settings-group-rows">{children}</div>
    </section>
  );
}

function SettingsSwitch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={`gyro-settings-switch${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span />
    </button>
  );
}

function SettingsSegmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ label: string; value: T }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div aria-label={label} className="gyro-settings-segmented" role="group">
      {options.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={value === option.value ? "is-active" : ""}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SettingsStatus({
  status,
  children,
}: {
  status: "good" | "warning" | "critical" | "neutral";
  children: ReactNode;
}) {
  return (
    <span className={`gyro-settings-status is-${status}`}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

function formatUsageReset(value?: string) {
  if (!value) return "Reset time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  const relativeMs = date.getTime() - Date.now();
  if (relativeMs > 0 && relativeMs < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(relativeMs / 3_600_000);
    const minutes = Math.max(1, Math.round((relativeMs % 3_600_000) / 60_000));
    return `Resets in ${hours ? `${hours}h ` : ""}${minutes}m`;
  }
  return `Resets ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
}

function UsageCard({
  window,
  visualization,
}: {
  window?: ProviderUsageState["windows"][number];
  visualization: "bars" | "wheels";
}) {
  if (!window) return null;
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const remaining = 100 - used;
  const severity =
    remaining <= 10 ? "critical" : remaining <= 25 ? "warning" : "normal";
  return (
    <article className={`gyro-usage-card is-${severity}`}>
      <header>
        <strong>{window.label}</strong>
        <span>
          {remaining <= 10
            ? "Critical"
            : remaining <= 25
              ? "Low"
              : "Within limit"}
        </span>
      </header>
      {visualization === "wheels" ? (
        <div
          className="gyro-usage-wheel"
          style={{ "--usage": `${remaining * 3.6}deg` } as CSSProperties}
        >
          <span>
            <strong>{remaining}%</strong>
            <small>remaining</small>
          </span>
        </div>
      ) : (
        <div
          className="gyro-usage-bar"
          aria-label={`${remaining}% remaining`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={remaining}
        >
          <span style={{ width: `${remaining}%` }} />
        </div>
      )}
      <div className="gyro-usage-card-meta">
        <strong>{remaining}% available</strong>
        <span>{formatUsageReset(window.resetsAt)}</span>
      </div>
    </article>
  );
}

type ComposerPopoverId =
  | "approval"
  | "branch"
  | "context"
  | "effort"
  | "project"
  | "provider"
  | "workspace-mode";

type ComposerPopoverItem = {
  label: string;
  detail?: string;
  tooltip?: string;
  action?: string;
  removeAction?: string;
  icon: IconComponent;
  kind?:
    | "effort"
    | "model"
    | "permission-direct"
    | "project"
    | "provider"
    | "warning";
  sectionLabel?: string;
  providerId?: ProviderId;
  active?: boolean;
  disabled?: boolean;
  showChevron?: boolean;
  trailingLabel?: string;
  hideIcon?: boolean;
};

type ComposerSlashCommand = {
  command: string;
  label: string;
  detail: string;
  icon: IconComponent;
  action?: string;
  popover?: Extract<ComposerPopoverId, "approval" | "provider">;
};

function branchPopoverItems({
  branchCatalog,
  branchName,
  isDisabled,
  isLoading,
  workspaceMode,
  workspacePath,
}: {
  branchCatalog?: GitBranchCatalog;
  branchName: string;
  isDisabled?: boolean;
  isLoading?: boolean;
  workspaceMode: WorkbenchMode;
  workspacePath?: string;
}): ComposerPopoverItem[] {
  if (!workspacePath) {
    return [
      {
        action: "select-workspace",
        detail: "Choose a Git repository first",
        icon: Folder,
        label: "Choose folder",
      },
    ];
  }
  if (isLoading && !branchCatalog) {
    return [
      {
        disabled: true,
        detail: "Reading local branches",
        icon: CircleDashed,
        label: "Loading branches",
      },
    ];
  }
  if (!branchCatalog?.available) {
    return [
      {
        disabled: true,
        detail: branchCatalog?.error ?? "No local branches are available",
        icon: TriangleAlert,
        label: "Branches unavailable",
      },
    ];
  }
  if (branchCatalog.branches.length === 0) {
    return [
      {
        disabled: true,
        detail: "Create the repository's first commit before switching",
        icon: GitBranch,
        label: "No local branches yet",
      },
    ];
  }
  if (workspaceMode === "worktree") {
    return [
      {
        active: true,
        disabled: true,
        detail: "This isolated chat keeps its worktree branch",
        icon: GitBranch,
        label: branchName,
      },
    ];
  }
  return branchCatalog.branches.map((branch) => ({
    action: `select-branch:${encodeURIComponent(branch)}`,
    active: branch === branchCatalog.current,
    disabled: isDisabled,
    detail: isDisabled
      ? "Wait for the active turn to finish"
      : branch === branchCatalog.current
        ? "Current workspace branch"
        : "Switch this clean workspace",
    icon: GitBranch,
    label: branch,
  }));
}

function ComposerPopover({
  align = "start",
  className,
  id,
  items,
  onAction,
  onItemPreview,
  placement = "up",
  title,
}: {
  align?: "start" | "end";
  className?: string;
  id: string;
  items: ComposerPopoverItem[];
  onAction: (action?: string, item?: ComposerPopoverItem) => void;
  onItemPreview?: (item: ComposerPopoverItem) => void;
  placement?: "up" | "down";
  title?: string;
}) {
  return (
    <div
      aria-label={title ?? "Menu"}
      className={["gyro-composer-popover", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      data-align={align}
      data-placement={placement}
      id={id}
      role="menu"
    >
      {title ? (
        <div className="gyro-composer-popover-title">{title}</div>
      ) : null}
      {items.map((item, index) => {
        const Icon = item.icon;
        const itemClassName = [
          "gyro-composer-menu-item",
          item.active ? "is-active" : "",
          item.removeAction ? "has-remove" : "",
          item.hideIcon ? "has-no-icon" : "",
          item.kind ? `is-${item.kind}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        const itemContent = (
          <>
            {item.hideIcon ? null : item.providerId ? (
              <ProviderLogo providerId={item.providerId} />
            ) : (
              <Icon size={14} />
            )}
            <span>
              <strong>{item.label}</strong>
              {item.detail ? <small>{item.detail}</small> : null}
            </span>
            {item.trailingLabel ? (
              <em className="gyro-composer-menu-trailing">
                {item.trailingLabel}
              </em>
            ) : item.active ? (
              <Check size={13} />
            ) : item.providerId && item.showChevron !== false ? (
              <ChevronRight size={13} />
            ) : null}
          </>
        );
        if (item.removeAction) {
          return (
            <Fragment key={`${item.label}-${index}`}>
              {item.sectionLabel ? (
                <div className="gyro-composer-popover-section-title">
                  {item.sectionLabel}
                </div>
              ) : null}
              <div className={itemClassName}>
                <button
                  className="gyro-composer-menu-primary"
                  disabled={item.disabled}
                  onClick={() => onAction(item.action, item)}
                  onFocus={() => {
                    if (!item.disabled) {
                      onItemPreview?.(item);
                    }
                  }}
                  onPointerEnter={() => {
                    if (!item.disabled) {
                      onItemPreview?.(item);
                    }
                  }}
                  role="menuitem"
                  title={item.tooltip}
                  type="button"
                >
                  {itemContent}
                </button>
                <button
                  aria-label={`Remove ${item.label}`}
                  className="gyro-composer-menu-remove"
                  disabled={item.disabled}
                  onClick={() => onAction(item.removeAction, item)}
                  title="Remove"
                  type="button"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </Fragment>
          );
        }
        return (
          <Fragment key={`${item.label}-${index}`}>
            {item.sectionLabel ? (
              <div className="gyro-composer-popover-section-title">
                {item.sectionLabel}
              </div>
            ) : null}
            <button
              className={itemClassName}
              disabled={item.disabled}
              onClick={() => onAction(item.action, item)}
              onFocus={() => {
                if (!item.disabled) {
                  onItemPreview?.(item);
                }
              }}
              onPointerEnter={() => {
                if (!item.disabled) {
                  onItemPreview?.(item);
                }
              }}
              role="menuitem"
              title={item.tooltip}
              type="button"
            >
              {itemContent}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

function providerAuthOwnerLabel(owner?: ProviderStatus["authOwner"]) {
  if (owner === "provider-env") {
    return "Provider env";
  }
  if (owner === "provider-sdk") {
    return "Provider SDK";
  }
  return "Provider CLI";
}

function reasoningEffortLabel(effort: ReasoningEffort) {
  if (effort === "xhigh") {
    return "XHigh";
  }
  return `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
}

function providerAuthOwnershipDetail(providerId: ProviderId) {
  if (providerId === "openai") {
    return "Uses your existing local Codex sign-in with ChatGPT for subscription access. Gyro does not store OpenAI tokens.";
  }
  if (providerId === "anthropic") {
    return "Uses Claude Code login and claude auth status so Pro, Max, Team, or Enterprise subscriptions stay Anthropic-owned.";
  }
  if (providerId === "kimi") {
    return "Uses the local Kimi Code OAuth session. Kimi tokens and account data stay in Kimi-owned storage.";
  }
  if (providerId === "xai") {
    return "Uses XAI_API_KEY from the local environment; Grok API keys and team billing stay with xAI.";
  }
  if (providerId === "gemini") {
    return "Uses Gemini environment credentials or Google-owned tooling; plan access stays with Google.";
  }
  return "Uses provider-owned credential storage; Gyro stores readiness only.";
}

function providerAuthSummary(providerId: ProviderId) {
  if (providerId === "openai") {
    return "Codex sign-in";
  }
  if (providerId === "anthropic") {
    return "Claude Code auth";
  }
  if (providerId === "kimi") {
    return "Kimi Code sign-in";
  }
  if (providerId === "xai") {
    return "XAI_API_KEY";
  }
  if (providerId === "gemini") {
    return "Gemini env";
  }
  return "Provider-owned";
}

function providerCredentialSummary(secretStorage?: string) {
  if (secretStorage?.trim()) {
    return secretStorage.replace(/;.*$/, ".");
  }
  return "Gyro stores readiness only.";
}

function providerConnectionLabel(provider: {
  authStatus: string;
  id: ProviderId;
}) {
  if (provider.authStatus === "connected" && provider.id === "openai") {
    return "verified via Codex";
  }
  if (provider.authStatus === "connected" && provider.id === "anthropic") {
    return "verified via Claude Code";
  }
  if (provider.authStatus === "connected" && provider.id === "kimi") {
    return "verified via Kimi Code";
  }
  if (provider.authStatus === "connected") {
    return "verified";
  }
  return provider.authStatus.replace("-", " ");
}

function providerConnectedHealthCopy(provider: { id: ProviderId }) {
  if (provider.id === "openai") {
    return "OpenAI is available through the local Codex/ChatGPT sign-in on this Mac.";
  }
  if (provider.id === "anthropic") {
    return "Anthropic is available through the local Claude Code sign-in on this Mac.";
  }
  if (provider.id === "kimi") {
    return "Kimi is available through the local Kimi Code sign-in on this Mac.";
  }
  return "Provider-owned credentials were verified on this Mac.";
}

function providerPrimaryActionLabel(provider: {
  authMode: string;
  authStatus: string;
  id: ProviderId;
}) {
  if (provider.authStatus === "connected") {
    return provider.authMode === "cli" ? "Disable in Gyro" : "Disconnect";
  }
  if (provider.authStatus === "connecting") {
    return "Connecting";
  }
  if (provider.id === "openai") {
    return "Use Codex sign-in";
  }
  if (provider.id === "kimi") {
    return "Use Kimi sign-in";
  }
  if (provider.authMode === "cli") {
    return "Start CLI sign-in";
  }
  if (provider.authMode === "env") {
    return "Check env";
  }
  return "Connect";
}

function providerTestActionLabel(provider: {
  authMode: string;
  id: ProviderId;
}) {
  if (provider.id === "openai") {
    return "Test Codex";
  }
  if (provider.id === "kimi") {
    return "Test Kimi";
  }
  if (provider.authMode === "cli") {
    return "Test CLI";
  }
  if (provider.authMode === "env") {
    return "Test env";
  }
  return "Test";
}

function ProviderLogo({ providerId }: { providerId: ProviderId }) {
  if (providerId === "openai") {
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-openai"
        title="OpenAI"
      >
        <svg viewBox="0 0 24 24">
          <path
            d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
            fill="currentColor"
          />
        </svg>
      </span>
    );
  }

  if (providerId === "anthropic") {
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-anthropic"
        title="Anthropic"
      >
        <svg viewBox="0 0 24 24">
          <path
            d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"
            fill="currentColor"
          />
        </svg>
      </span>
    );
  }

  if (providerId === "kimi") {
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-kimi"
        title="Kimi"
      >
        <span>K</span>
      </span>
    );
  }

  if (providerId === "xai") {
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-xai"
        title="xAI"
      >
        <svg viewBox="0 0 24 24">
          <path
            d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"
            fill="currentColor"
          />
        </svg>
      </span>
    );
  }

  if (providerId === "gemini") {
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-gemini"
        title="Gemini"
      >
        <svg viewBox="0 0 24 24">
          <path
            d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"
            fill="currentColor"
          />
        </svg>
      </span>
    );
  }

  const initials = providerId === "cursor" ? "Cu" : "Oc";

  return (
    <span
      aria-hidden="true"
      className={`gyro-provider-logo is-${providerId}`}
      title={providerId}
    >
      <span>{initials}</span>
    </span>
  );
}

type ApprovalCopy = {
  chipLabel: string;
  title: string;
  gatedLabel: string;
  gatedDetail: string;
  autoLabel: string;
  autoDetail: string;
  directLabel: string;
  directDetail: string;
  settingsDetail: string;
  commandValue: string;
  commandDetail: string;
  editValue: string;
  editDetail: string;
};

function approvalModeForConfig(config: GyroConfig) {
  if (config.fullAccess) {
    return "direct";
  }
  if (config.requireCommandApproval && config.requireFileEditApproval) {
    return "gated";
  }
  if (!config.requireCommandApproval && !config.requireFileEditApproval) {
    return "auto";
  }
  return "custom";
}

function approvalBackendSummary(config: GyroConfig) {
  if (config.fullAccess) {
    return "full access · sandbox bypassed";
  }
  if (!config.requireCommandApproval && !config.requireFileEditApproval) {
    return "auto approve · provider boundary retained";
  }
  const command = config.requireCommandApproval
    ? "commands ask"
    : "commands allow";
  const edits = config.requireFileEditApproval ? "edits ask" : "edits allow";
  return `${command} · ${edits}`;
}

function providerApprovalCopy(
  providerId: ProviderId | undefined,
  config: GyroConfig,
): ApprovalCopy {
  const mode = approvalModeForConfig(config);
  const backendSummary = approvalBackendSummary(config);
  const isAnthropic = providerId === "anthropic";
  const providerTitle =
    providerId === "anthropic"
      ? "Anthropic permissions"
      : providerId === "kimi"
        ? "Kimi permissions"
        : providerId === "xai"
          ? "xAI permissions"
          : providerId === "gemini"
            ? "Gemini permissions"
            : "OpenAI permissions";
  const agentName =
    providerId === "anthropic"
      ? "Claude"
      : providerId === "kimi"
        ? "Kimi"
        : providerId === "xai"
          ? "Grok"
          : providerId === "gemini"
            ? "Gemini"
            : "Codex";
  const base = isAnthropic
    ? {
        title: providerTitle,
        gatedLabel: "Ask Before Executing",
        gatedDetail: "Claude asks before tools and edits",
        autoLabel: "Auto Approve",
        autoDetail: "Claude can work without prompts inside its boundary",
        directLabel: "Full Access",
        directDetail: "Claude can use Git, network, and user tools directly",
        commandValue: config.requireCommandApproval ? "Ask first" : "Allow",
        commandDetail: "Claude tool calls use the backend command policy.",
        editValue: config.requireFileEditApproval ? "Review" : "Auto-accept",
        editDetail: "Claude edits follow the backend diff policy.",
      }
    : {
        title: providerTitle,
        gatedLabel: "Ask Before Executing",
        gatedDetail: `${agentName} asks before commands and file edits`,
        autoLabel: "Auto Approve",
        autoDetail: `${agentName} works without prompts inside its provider boundary`,
        directLabel: "Full Access",
        directDetail: `${agentName} can use Git, network, and user tools directly`,
        commandValue: config.requireCommandApproval ? "Ask" : "Allow",
        commandDetail: "Codex command execution uses the backend policy.",
        editValue: config.requireFileEditApproval ? "Review" : "Auto-apply",
        editDetail: "Codex file edits follow the backend diff policy.",
      };

  return {
    ...base,
    chipLabel:
      mode === "direct"
        ? base.directLabel
        : mode === "auto"
          ? base.autoLabel
          : base.gatedLabel,
    settingsDetail: `Backend: ${backendSummary}`,
  };
}

function Composer({
  attachments = [],
  chatMode = "normal",
  constrainToParent = false,
  draft,
  branchName,
  branchCatalog,
  onDraftChange,
  onRemoveAttachment,
  onAttachMediaFiles,
  onSend,
  onStop,
  worktreeName,
  workspacePath,
  workspaceMode = "local",
  config,
  providerReadiness,
  providerUsage,
  onComposerAction,
  onCancelGoalComposer,
  sessionModel,
  sessionGoal,
  promptHistory = [],
  contextUsage,
  isGoalComposerActive = false,
  savedProjects = [],
  surfaceControls,
  isSending = false,
  isBranchLoading,
  maxDraftLength,
  popoverPlacement,
  showContextRow,
  variant = "thread",
}: {
  attachments?: ChatAttachment[];
  chatMode?: ChatMode;
  constrainToParent?: boolean;
  draft: string;
  branchName?: string;
  branchCatalog?: GitBranchCatalog;
  onDraftChange: (value: string) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  onAttachMediaFiles?: (files: File[]) => void;
  onSend: () => void;
  onStop?: () => void;
  worktreeName?: string;
  workspacePath?: string;
  workspaceMode?: WorkbenchMode;
  config: GyroConfig;
  providerReadiness?: ProviderReadiness;
  providerUsage?: ProviderUsageState;
  onComposerAction?: (action: string) => void;
  onCancelGoalComposer?: () => void;
  sessionModel?: {
    modelId?: string;
    modelLabel?: string;
    providerId?: ProviderId;
    providerLabel?: string;
    reasoningEffort?: ReasoningEffort;
  };
  sessionGoal?: SessionGoal;
  promptHistory?: string[];
  contextUsage?: ComposerContextUsage;
  isGoalComposerActive?: boolean;
  savedProjects?: Array<{
    path: string;
    label: string;
    detail: string;
    sessionCount: number;
  }>;
  surfaceControls?: ReactNode;
  isSending?: boolean;
  isBranchLoading?: boolean;
  maxDraftLength?: number;
  popoverPlacement?: "down" | "up";
  showContextRow?: boolean;
  variant?: "thread" | "hero";
}) {
  const [activePopover, setActivePopover] = useState<ComposerPopoverId | null>(
    null,
  );
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [modelPickerProviderId, setModelPickerProviderId] = useState<
    ProviderId | undefined
  >(undefined);
  const [modelFlyoutSide, setModelFlyoutSide] = useState<"left" | "right">(
    "right",
  );
  const [modelFlyoutVertical, setModelFlyoutVertical] = useState<"down" | "up">(
    "down",
  );
  const [historyIndex, setHistoryIndex] = useState<number>();
  const [activeSlashCommandIndex, setActiveSlashCommandIndex] = useState(0);
  const [isSlashMenuDismissed, setIsSlashMenuDismissed] = useState(false);
  const slashCommandRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const providerPickerRef = useRef<HTMLDivElement | null>(null);
  const popoverScopeRef = useOutsidePointerDismiss<HTMLDivElement>(
    Boolean(activePopover),
    () => {
      setActivePopover(null);
      setModelPickerProviderId(undefined);
    },
  );
  const popoverBaseId = useId();
  useEffect(() => {
    if (isGoalComposerActive) {
      composerTextareaRef.current?.focus();
    }
  }, [isGoalComposerActive]);
  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 52), 148);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 148 ? "auto" : "hidden";
  }, [draft]);
  const providerConfigs = providersForConfig(config);
  const selectedProvider = providerConfigs.find(
    (provider) => provider.id === config.selectedProviderId,
  );
  const sessionProvider =
    sessionModel?.providerId && sessionModel.modelLabel
      ? providerConfigs.find(
          (provider) => provider.id === sessionModel.providerId,
        )
      : undefined;
  const displayProvider = selectedProvider ?? sessionProvider;
  const previewedProviderId = modelPickerProviderId;
  const modelPickerProvider = providerConfigs.find(
    (provider) =>
      provider.id === previewedProviderId &&
      provider.authStatus === "connected",
  );
  const hasSelectedProvider = Boolean(
    selectedProvider ?? sessionModel?.modelLabel,
  );
  const hasReadyProvider = Boolean(
    selectedProvider?.authStatus === "connected" ||
    sessionProvider?.authStatus === "connected",
  );
  const providerModelLabel = selectedProvider
    ? selectedModelLabel(selectedProvider)
    : (sessionModel?.modelLabel ?? "Select provider");
  const modelChipLabel = hasSelectedProvider
    ? providerModelLabel
    : "Choose model";
  const providerReasoningEffort = selectedProvider
    ? selectedReasoningEffort(selectedProvider)
    : sessionModel?.reasoningEffort;
  const approvalMode = approvalModeForConfig(config);
  const approvalCopy = providerApprovalCopy(selectedProvider?.id, config);
  const approvalChipClassName =
    approvalMode === "direct"
      ? "gyro-composer-chip is-warning"
      : "gyro-composer-chip";
  const isStopAction = Boolean(
    !isGoalComposerActive && isSending && onStop && draft.trim().length === 0,
  );
  const workspaceModeLabel =
    workspaceMode === "worktree" ? "Worktree" : "Local";
  const hasUserWorkspace = Boolean(isUserSelectedWorkspacePath(workspacePath));
  const canSubmitChat = canSendChat(hasReadyProvider, workspacePath);
  const canSubmitComposer = isGoalComposerActive || canSubmitChat;
  const projectLabel = composerProjectLabel(workspacePath);
  const savedProjectItems: ComposerPopoverItem[] = savedProjects
    .filter((project) => project.path)
    .slice(0, 6)
    .map((project) => ({
      action: `select-saved-project:${encodeURIComponent(project.path)}`,
      active: project.path === workspacePath,
      detail: project.detail,
      icon: Folder,
      kind: "project" as const,
      label: project.label,
      removeAction: `remove-saved-project:${encodeURIComponent(project.path)}`,
    }));
  const branchLabel =
    branchName ??
    (workspaceMode === "worktree" ? "New worktree branch" : "main");
  const branchItems = branchPopoverItems({
    branchCatalog,
    branchName: branchLabel,
    isDisabled: isSending,
    isLoading: isBranchLoading,
    workspaceMode,
    workspacePath,
  });
  const isHero = variant === "hero";
  const shouldShowContextRow = showContextRow ?? isHero;
  const providerErrorMessage =
    providerReadiness?.status === "blocked"
      ? providerReadiness.message
      : undefined;
  const providerItems: ComposerPopoverItem[] = [
    ...(providerErrorMessage
      ? [
          {
            disabled: true,
            detail: providerErrorMessage,
            icon: ShieldCheck,
            kind: "warning" as const,
            label: "Provider needs attention",
          },
        ]
      : []),
    ...providerConfigs
      .filter((provider) => isProviderExecutable(provider.id))
      .map((provider) => {
        const isConnected = provider.authStatus === "connected";
        return {
          action: isConnected ? `select-provider:${provider.id}` : undefined,
          active: isConnected && provider.id === config.selectedProviderId,
          disabled: !isConnected,
          icon: isConnected ? Bot : KeyRound,
          kind: "provider" as const,
          label: provider.displayName,
          providerId: provider.id,
          showChevron: isConnected,
          trailingLabel: isConnected ? undefined : "Unavailable",
        };
      }),
  ];
  const providerModelItems: ComposerPopoverItem[] = [
    ...(modelPickerProvider
      ? [
          ...modelPickerProvider.models.map((model) => ({
            action: `select-provider-model:${modelPickerProvider.id}:${model.id}`,
            active:
              modelPickerProvider.id === config.selectedProviderId &&
              model.id === modelPickerProvider.selectedModelId,
            icon: Sparkles,
            hideIcon: true,
            kind: "model" as const,
            label: model.displayName,
          })),
        ]
      : []),
  ];
  const effortItems: ComposerPopoverItem[] = selectedProvider
    ? (getProviderModel(selectedProvider)?.supportedReasoningEfforts ?? []).map(
        (effort) => ({
          action: `select-provider-effort:${selectedProvider.id}:${effort}`,
          active: effort === selectedReasoningEffort(selectedProvider),
          hideIcon: true,
          icon: Gauge,
          kind: "effort" as const,
          label: reasoningEffortLabel(effort),
        }),
      )
    : [];
  const contextItems: ComposerPopoverItem[] = [
    {
      action: "attach-editor-snapshot",
      icon: FileCode2,
      label: "Editor",
      sectionLabel: "Context",
      tooltip: "Capture saved or unsaved editor text",
    },
    {
      action: "select-media",
      icon: ImagePlus,
      label: "Image",
    },
    {
      action: "select-file",
      icon: Paperclip,
      label: "File",
    },
    {
      action: "select-folder",
      icon: Folder,
      label: "Folder",
    },
    {
      action: "search-workspace",
      icon: Search,
      label: "Search",
      sectionLabel: "Tools",
    },
    {
      action: "set-chat-mode-plan",
      icon: Lightbulb,
      label: "Plan",
    },
    {
      action: "add-goal",
      icon: Goal,
      label: "Goal",
    },
  ];
  const slashCommands: ComposerSlashCommand[] = [
    {
      action: "add-goal",
      command: "/goal",
      detail: sessionGoal?.text
        ? "Edit the outcome for this chat"
        : "Define the outcome for this chat",
      icon: Goal,
      label: sessionGoal?.text ? "Edit goal" : "Set goal",
    },
    chatMode === "plan"
      ? {
          action: "set-chat-mode-normal",
          command: "/normal",
          detail: "Return to regular agent execution",
          icon: Play,
          label: "Normal mode",
        }
      : {
          action: "set-chat-mode-plan",
          command: "/plan",
          detail: "Explore and plan without changing files",
          icon: LockKeyhole,
          label: "Plan mode",
        },
    {
      action: "attach-editor-snapshot",
      command: "/editor",
      detail: "Capture an immutable snapshot of the current editor",
      icon: FileCode2,
      label: "Attach editor snapshot",
    },
    {
      action: "select-image",
      command: "/image",
      detail: "Attach an image to your next message",
      icon: ImagePlus,
      label: "Attach image",
    },
    {
      action: "select-video",
      command: "/video",
      detail: "Attach a video to your next message",
      icon: Video,
      label: "Attach video",
    },
    {
      action: "select-file",
      command: "/file",
      detail: "Attach a file from the workspace",
      icon: Paperclip,
      label: "Attach file",
    },
    {
      action: "select-folder",
      command: "/folder",
      detail: "Choose the workspace for this chat",
      icon: Folder,
      label: "Choose folder",
    },
    {
      action: "search-workspace",
      command: "/search",
      detail: "Find a command or workspace file",
      icon: Search,
      label: "Search workspace",
    },
    {
      command: "/model",
      detail: "Choose a provider and model",
      icon: Bot,
      label: "Choose model",
      popover: "provider",
    },
    {
      command: "/permissions",
      detail: "Choose whether Gyro asks before acting",
      icon: ShieldCheck,
      label: "Change permissions",
      popover: "approval",
    },
    {
      action: "new-chat",
      command: "/new",
      detail: "Start a fresh chat in this workspace",
      icon: Edit3,
      label: "New chat",
    },
  ];
  const slashMatch = isGoalComposerActive ? null : draft.match(/^\/([^\s/]*)$/);
  const slashQuery = slashMatch?.[1]?.toLocaleLowerCase();
  const filteredSlashCommands =
    slashQuery === undefined
      ? []
      : slashCommands.filter((command) => {
          const commandName = command.command.slice(1).toLocaleLowerCase();
          const labelWords = command.label.toLocaleLowerCase().split(/\s+/);
          return (
            commandName.startsWith(slashQuery) ||
            labelWords.some((word) => word.startsWith(slashQuery))
          );
        });
  const isSlashMenuOpen =
    !isSlashMenuDismissed && filteredSlashCommands.length > 0;
  const selectedSlashCommandIndex = Math.min(
    activeSlashCommandIndex,
    Math.max(0, filteredSlashCommands.length - 1),
  );

  const togglePopover = (popover: ComposerPopoverId) => {
    setActivePopover((current) => (current === popover ? null : popover));
  };
  const toggleProviderPopover = () => {
    setModelPickerProviderId(undefined);
    togglePopover("provider");
  };
  const runPopoverAction = (action?: string, item?: ComposerPopoverItem) => {
    if (item?.providerId) {
      setModelPickerProviderId(item.providerId);
      setActivePopover("provider");
      if (action) {
        onComposerAction?.(action);
      }
      return;
    }

    setActivePopover(null);
    if (action) {
      onComposerAction?.(action);
    }
  };
  const runSlashCommand = (command: ComposerSlashCommand) => {
    setIsSlashMenuDismissed(true);
    setHistoryIndex(undefined);
    onDraftChange("");
    if (command.popover) {
      setModelPickerProviderId(undefined);
      setActivePopover(command.popover);
      composerTextareaRef.current?.focus();
      return;
    }
    setActivePopover(null);
    if (command.action) {
      onComposerAction?.(command.action);
    }
  };
  const menuProps = (popover: ComposerPopoverId) => ({
    "aria-controls":
      activePopover === popover ? `${popoverBaseId}-${popover}` : undefined,
    "aria-expanded": activePopover === popover,
    "aria-haspopup": "menu" as const,
  });
  const providerPopoverPlacement = popoverPlacement ?? (isHero ? "down" : "up");

  useEffect(() => {
    if (!modelPickerProvider || !providerPickerRef.current) {
      setModelFlyoutSide("right");
      setModelFlyoutVertical("down");
      return;
    }
    const rect = providerPickerRef.current.getBoundingClientRect();
    const modelFlyoutWidth = 208;
    const modelFlyoutHeight =
      providerPickerRef.current.querySelector<HTMLElement>(
        ".gyro-provider-model-flyout",
      )?.scrollHeight ?? 420;
    const availableRight = window.innerWidth - rect.right;
    const availableLeft = rect.left;
    setModelFlyoutSide(
      availableRight < modelFlyoutWidth + 8 && availableLeft > availableRight
        ? "left"
        : "right",
    );
    setModelFlyoutVertical(
      rect.top + modelFlyoutHeight > window.innerHeight - 16 ? "up" : "down",
    );
  }, [modelPickerProvider]);

  useEffect(() => {
    setActiveSlashCommandIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (activeSlashCommandIndex >= filteredSlashCommands.length) {
      setActiveSlashCommandIndex(0);
    }
  }, [activeSlashCommandIndex, filteredSlashCommands.length]);

  useEffect(() => {
    if (isSlashMenuOpen) {
      slashCommandRefs.current[selectedSlashCommandIndex]?.scrollIntoView({
        block: "nearest",
      });
    }
  }, [isSlashMenuOpen, selectedSlashCommandIndex]);

  return (
    <div
      className={[
        "gyro-composer-shell",
        isHero ? "is-hero" : "",
        hasSelectedProvider || isHero
          ? "has-provider"
          : "is-provider-collapsed",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        isHero
          ? {
              justifySelf: constrainToParent ? "stretch" : "center",
              maxWidth: "820px",
              width: constrainToParent ? "100%" : "min(820px, 100%)",
            }
          : undefined
      }
      ref={popoverScopeRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && activePopover) {
          event.stopPropagation();
          setActivePopover(null);
          setModelPickerProviderId(undefined);
        }
      }}
    >
      {attachments.length > 0 ? (
        <div className="gyro-composer-attachments" aria-label="Attachments">
          {attachments.map((attachment) => (
            <div
              className={`gyro-composer-attachment is-${attachment.kind}${attachment.kind === "video" ? " is-image" : ""}`}
              key={attachment.id}
              title={`${attachment.name} · ${formatAttachmentSize(attachment.size)}`}
            >
              {attachment.kind === "image" || attachment.kind === "video" ? (
                <ComposerMediaPreview attachment={attachment} />
              ) : (
                <FileText size={15} />
              )}
              <span>
                <strong>{attachment.name}</strong>
                <small>{formatAttachmentSize(attachment.size)}</small>
              </span>
              <button
                aria-label={`Remove ${attachment.name}`}
                onClick={() => onRemoveAttachment?.(attachment.id)}
                title={`Remove ${attachment.name}`}
                type="button"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {isSlashMenuOpen ? (
        <div
          aria-label="Chat commands"
          className="gyro-composer-slash-menu"
          id={`${popoverBaseId}-slash-menu`}
          role="menu"
        >
          <div className="gyro-composer-slash-menu-title">
            <span>Commands</span>
            <small>Type to filter</small>
          </div>
          <div className="gyro-composer-slash-menu-items">
            {filteredSlashCommands.map((command, index) => {
              const Icon = command.icon;
              return (
                <button
                  aria-current={
                    index === selectedSlashCommandIndex ? "true" : undefined
                  }
                  className={
                    index === selectedSlashCommandIndex ? "is-selected" : ""
                  }
                  id={`${popoverBaseId}-slash-command-${index}`}
                  key={command.command}
                  onClick={() => runSlashCommand(command)}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerEnter={() => setActiveSlashCommandIndex(index)}
                  ref={(element) => {
                    slashCommandRefs.current[index] = element;
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Icon size={15} />
                  <span>
                    <strong>{command.label}</strong>
                    <small>{command.detail}</small>
                  </span>
                  <code>{command.command}</code>
                </button>
              );
            })}
          </div>
          <div className="gyro-composer-slash-menu-hint">
            <span>↑↓ Navigate</span>
            <span>↵ Select</span>
            <span>Esc Close</span>
          </div>
        </div>
      ) : null}
      <textarea
        ref={composerTextareaRef}
        aria-label={isGoalComposerActive ? "Set session goal" : "Message Gyro"}
        aria-controls={
          isSlashMenuOpen ? `${popoverBaseId}-slash-menu` : undefined
        }
        aria-activedescendant={
          isSlashMenuOpen
            ? `${popoverBaseId}-slash-command-${selectedSlashCommandIndex}`
            : undefined
        }
        aria-expanded={isSlashMenuOpen}
        aria-haspopup="menu"
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files).filter(
            (file) =>
              /^(?:image|video)\//.test(file.type) ||
              /\.(?:png|jpe?g|webp|mp4|m4v|mov|webm)$/i.test(file.name),
          );
          if (files.length) {
            event.preventDefault();
            onAttachMediaFiles?.(files);
          }
        }}
        onFocus={() => {
          setActivePopover(null);
          setIsSlashMenuDismissed(false);
        }}
        maxLength={isGoalComposerActive ? 240 : maxDraftLength}
        onChange={(event) => {
          setIsSlashMenuDismissed(false);
          onDraftChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (isGoalComposerActive && event.key === "Escape") {
            event.preventDefault();
            onCancelGoalComposer?.();
            return;
          }
          if (isSlashMenuOpen) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActiveSlashCommandIndex(
                (current) =>
                  (current + direction + filteredSlashCommands.length) %
                  filteredSlashCommands.length,
              );
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setIsSlashMenuDismissed(true);
              return;
            }
            if (
              (event.key === "Enter" || event.key === "Tab") &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              const command =
                filteredSlashCommands[selectedSlashCommandIndex] ??
                filteredSlashCommands[0];
              if (command) {
                event.preventDefault();
                runSlashCommand(command);
                return;
              }
            }
          }
          if (
            !isGoalComposerActive &&
            (event.key === "ArrowUp" || event.key === "ArrowDown") &&
            !event.shiftKey &&
            (draft.length === 0 || historyIndex !== undefined)
          ) {
            const next =
              event.key === "ArrowUp"
                ? Math.min(promptHistory.length - 1, (historyIndex ?? -1) + 1)
                : Math.max(-1, (historyIndex ?? 0) - 1);
            if (promptHistory.length > 0 && next >= 0) {
              event.preventDefault();
              setHistoryIndex(next);
              onDraftChange(
                promptHistory[promptHistory.length - 1 - next] ?? "",
              );
              return;
            }
            if (next < 0 && historyIndex !== undefined) {
              event.preventDefault();
              setHistoryIndex(undefined);
              onDraftChange("");
              return;
            }
          }
          const shouldSend =
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing;
          if (shouldSend) {
            event.preventDefault();
            setActivePopover(null);
            if (canSubmitComposer && draft.trim().length > 0) {
              setHistoryIndex(undefined);
              onSend();
            }
          }
        }}
        placeholder={
          isGoalComposerActive
            ? "Define the outcome for this chat"
            : variant === "hero"
              ? "Ask for follow-up changes or attach images"
              : "Ask for follow-up changes or attach context"
        }
        value={draft}
      />
      <div className="gyro-composer-bar">
        {hasSelectedProvider || isHero ? (
          <>
            <div className="gyro-composer-control gyro-composer-reveal">
              <button
                aria-label="Add context"
                className="gyro-composer-tool"
                onClick={() => togglePopover("context")}
                title="Add context"
                type="button"
                {...menuProps("context")}
              >
                <Plus size={17} />
              </button>
              {activePopover === "context" ? (
                <ComposerPopover
                  className="gyro-context-picker"
                  id={`${popoverBaseId}-context`}
                  items={contextItems}
                  onAction={runPopoverAction}
                />
              ) : null}
            </div>
            <div className="gyro-composer-control gyro-composer-control-approval gyro-composer-reveal">
              <button
                className={approvalChipClassName}
                onClick={() => togglePopover("approval")}
                type="button"
                {...menuProps("approval")}
              >
                <ShieldCheck size={14} />
                <span className="gyro-composer-label">
                  {approvalCopy.chipLabel}
                </span>
                <ChevronDown size={13} />
              </button>
              {activePopover === "approval" ? (
                <ComposerPopover
                  className="gyro-approval-picker"
                  id={`${popoverBaseId}-approval`}
                  items={[
                    {
                      action: "set-approval-gated",
                      active: approvalMode === "gated",
                      icon: ShieldCheck,
                      label: approvalCopy.gatedLabel,
                    },
                    {
                      action: "set-approval-auto",
                      active: approvalMode === "auto",
                      icon: ShieldCheck,
                      label: approvalCopy.autoLabel,
                    },
                    {
                      action: "set-approval-direct",
                      active: approvalMode === "direct",
                      icon: ShieldCheck,
                      kind: "permission-direct",
                      label: approvalCopy.directLabel,
                    },
                  ]}
                  onAction={runPopoverAction}
                />
              ) : null}
            </div>
          </>
        ) : null}
        {surfaceControls}
        {isGoalComposerActive ? (
          <button
            aria-label="Cancel setting goal"
            aria-pressed="true"
            className="gyro-composer-chip is-goal"
            onClick={onCancelGoalComposer}
            title="Cancel setting goal"
            type="button"
          >
            <Goal size={13} />
            <span className="gyro-composer-label">Goal</span>
            <X
              aria-hidden="true"
              className="gyro-composer-chip-remove"
              size={12}
            />
          </button>
        ) : chatMode === "plan" ? (
          <button
            aria-label="Remove Plan mode"
            aria-pressed="true"
            className="gyro-composer-chip is-plan"
            onClick={() => onComposerAction?.("set-chat-mode-normal")}
            title="Remove Plan mode"
            type="button"
          >
            <LockKeyhole size={13} />
            <span className="gyro-composer-label">Plan</span>
            <X
              aria-hidden="true"
              className="gyro-composer-chip-remove"
              size={12}
            />
          </button>
        ) : sessionGoal?.text ? (
          <button
            className="gyro-composer-chip is-goal"
            onClick={() => onComposerAction?.("add-goal")}
            title={sessionGoal.text}
            type="button"
          >
            <Goal size={13} />
            <span className="gyro-composer-label">Goal</span>
          </button>
        ) : null}
        <div className="gyro-composer-spacer" />
        {contextUsage ? (
          <div className="gyro-composer-context-meter">
            <div
              aria-describedby={`${popoverBaseId}-context-usage-tooltip`}
              aria-label={contextUsage.label}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={contextUsage.percent}
              className="gyro-composer-context-wheel"
              role="progressbar"
              style={
                {
                  "--context-usage": `${contextUsage.percent * 3.6}deg`,
                } as CSSProperties
              }
              tabIndex={0}
            >
              <span />
            </div>
            <div
              className="gyro-composer-context-tooltip"
              id={`${popoverBaseId}-context-usage-tooltip`}
              role="tooltip"
            >
              <header>
                <strong>Context</strong>
                <span>{contextUsage.percentLabel}</span>
              </header>
              <div className="gyro-composer-context-value">
                <strong>{contextUsage.usedLabel}</strong>
                <span>
                  of {contextUsage.windowLabel} · {contextUsage.remainingLabel}{" "}
                  remaining
                </span>
              </div>
              <div
                aria-label="Context window used"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={contextUsage.percent}
                className="gyro-composer-context-bar"
                role="progressbar"
              >
                <span style={{ width: `${contextUsage.percent}%` }} />
              </div>
              {providerUsage ? (
                <div
                  aria-label="Provider usage limits"
                  className="gyro-composer-limit-summary"
                >
                  <span className="gyro-composer-limit-title">Limits</span>
                  {providerUsage.windows.length > 0 ? (
                    providerUsage.windows.map((window) => {
                      const remaining = Math.max(
                        0,
                        Math.min(100, 100 - window.usedPercent),
                      );
                      return (
                        <span key={window.id}>
                          <small>{window.label}</small>
                          <strong>{remaining}% left</strong>
                        </span>
                      );
                    })
                  ) : (
                    <small>
                      {providerUsage.status === "loading"
                        ? "Updating…"
                        : "Unavailable"}
                    </small>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="gyro-composer-control gyro-composer-control-model">
          <button
            className="gyro-composer-chip gyro-model-chip"
            onClick={toggleProviderPopover}
            type="button"
            {...menuProps("provider")}
          >
            {displayProvider ? (
              <ProviderLogo providerId={displayProvider.id} />
            ) : null}
            <span className="gyro-composer-label">{modelChipLabel}</span>
            <ChevronDown size={13} />
          </button>
          {activePopover === "provider" ? (
            <div
              className={[
                "gyro-provider-picker",
                modelPickerProvider ? "has-flyout" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-align="end"
              data-flyout-side={modelFlyoutSide}
              data-flyout-vertical={modelFlyoutVertical}
              data-placement={providerPopoverPlacement}
              id={`${popoverBaseId}-provider`}
              ref={providerPickerRef}
            >
              <ComposerPopover
                className="gyro-provider-picker-menu"
                id={`${popoverBaseId}-provider-menu`}
                items={providerItems}
                onAction={runPopoverAction}
                onItemPreview={(item) => {
                  if (item.providerId && !item.disabled) {
                    setModelPickerProviderId(item.providerId);
                  }
                }}
                placement={providerPopoverPlacement}
                title="Provider"
              />
              {modelPickerProvider ? (
                <ComposerPopover
                  className="gyro-provider-model-flyout"
                  id={`${popoverBaseId}-provider-models`}
                  items={providerModelItems}
                  onAction={runPopoverAction}
                  placement={providerPopoverPlacement}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {providerReasoningEffort && effortItems.length > 0 ? (
          <div className="gyro-composer-control gyro-composer-control-effort">
            <button
              className="gyro-composer-chip gyro-effort-chip"
              onClick={() => togglePopover("effort")}
              type="button"
              {...menuProps("effort")}
            >
              <span className="gyro-composer-label">
                {reasoningEffortLabel(providerReasoningEffort)}
              </span>
              <ChevronDown size={13} />
            </button>
            {activePopover === "effort" ? (
              <ComposerPopover
                align="end"
                className="gyro-effort-picker"
                id={`${popoverBaseId}-effort`}
                items={effortItems}
                onAction={runPopoverAction}
                placement={providerPopoverPlacement}
              />
            ) : null}
          </div>
        ) : null}
        <button
          aria-label={
            isStopAction
              ? "Stop response"
              : isGoalComposerActive
                ? "Set goal"
                : isSending
                  ? "Queue message"
                  : "Send message"
          }
          aria-busy={false}
          className="gyro-send-button"
          disabled={
            !isStopAction && (!canSubmitComposer || draft.trim().length === 0)
          }
          onClick={() => {
            setActivePopover(null);
            if (isStopAction) {
              onStop?.();
              return;
            }
            onSend();
          }}
          title={
            isStopAction
              ? "Stop response"
              : isGoalComposerActive
                ? "Set goal"
                : !hasUserWorkspace
                  ? "Choose a folder before sending"
                  : !hasReadyProvider
                    ? "Connect a provider before sending"
                    : isSending
                      ? "Queue message"
                      : "Send"
          }
          type="button"
        >
          {isStopAction ? (
            <Square fill="currentColor" size={10} strokeWidth={0} />
          ) : (
            <ArrowUp size={17} />
          )}
        </button>
      </div>
      {shouldShowContextRow ? (
        <div className="gyro-composer-context-row gyro-composer-reveal">
          <div className="gyro-composer-control">
            <button
              className="gyro-composer-chip"
              onClick={() => togglePopover("project")}
              type="button"
              {...menuProps("project")}
            >
              {hasUserWorkspace ? (
                <Folder size={14} />
              ) : (
                <HardDrive size={14} />
              )}
              {projectLabel}
              <ChevronDown size={13} />
            </button>
            {activePopover === "project" ? (
              <ComposerPopover
                id={`${popoverBaseId}-project`}
                items={[
                  {
                    action: hasUserWorkspace
                      ? `select-saved-project:${encodeURIComponent(workspacePath ?? "")}`
                      : "select-workspace",
                    active: hasUserWorkspace,
                    detail:
                      hasUserWorkspace && workspacePath
                        ? workspacePath
                        : "Select the folder Gyro should use",
                    icon: hasUserWorkspace ? Folder : HardDrive,
                    label: projectLabel,
                    removeAction:
                      hasUserWorkspace && workspacePath
                        ? `remove-saved-project:${encodeURIComponent(workspacePath)}`
                        : undefined,
                  },
                  ...savedProjectItems.filter(
                    (project) =>
                      project.action !==
                      `select-saved-project:${encodeURIComponent(workspacePath ?? "")}`,
                  ),
                  {
                    action: "select-workspace",
                    icon: Folder,
                    label: hasUserWorkspace ? "Change folder" : "Select folder",
                  },
                  {
                    action: "search-workspace",
                    disabled: !hasUserWorkspace,
                    icon: Search,
                    label: "Search workspace",
                  },
                ]}
                onAction={runPopoverAction}
                placement="down"
                title="Project"
              />
            ) : null}
          </div>
          <div className="gyro-composer-control">
            <button
              className="gyro-composer-chip"
              onClick={() => togglePopover("workspace-mode")}
              type="button"
              {...menuProps("workspace-mode")}
            >
              <Laptop size={14} />
              {workspaceModeLabel}
              <ChevronDown size={13} />
            </button>
            {activePopover === "workspace-mode" ? (
              <ComposerPopover
                id={`${popoverBaseId}-workspace-mode`}
                items={[
                  {
                    action: "set-workspace-mode:local",
                    active: workspaceMode === "local",
                    detail: "Run against the current workspace",
                    icon: Laptop,
                    label: "Work locally",
                  },
                  {
                    action: "set-workspace-mode:worktree",
                    active: workspaceMode === "worktree",
                    detail: workspacePath
                      ? "Create an isolated worktree when the chat starts"
                      : "Choose a workspace first",
                    icon: GitBranch,
                    label: "Use worktree",
                  },
                ]}
                onAction={runPopoverAction}
                placement="down"
                title="Workspace mode"
              />
            ) : null}
          </div>
          <div className="gyro-composer-control">
            <button
              className="gyro-composer-chip"
              onClick={() => togglePopover("branch")}
              type="button"
              {...menuProps("branch")}
            >
              <GitBranch size={14} />
              {branchLabel}
              <ChevronDown size={13} />
            </button>
            {activePopover === "branch" ? (
              <ComposerPopover
                className="gyro-composer-branch-picker"
                id={`${popoverBaseId}-branch`}
                items={branchItems}
                onAction={runPopoverAction}
                placement="down"
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ComposerMediaPreview({ attachment }: { attachment: ChatAttachment }) {
  const [hasFailed, setHasFailed] = useState(false);
  if (!attachment.previewUrl || hasFailed) {
    return attachment.kind === "video" ? (
      <Video
        aria-hidden="true"
        className="gyro-composer-image-fallback"
        size={20}
      />
    ) : (
      <ImagePlus
        aria-hidden="true"
        className="gyro-composer-image-fallback"
        size={20}
      />
    );
  }
  if (attachment.kind === "video") {
    return (
      <video
        aria-hidden="true"
        muted
        onError={() => setHasFailed(true)}
        playsInline
        preload="metadata"
        src={attachment.previewUrl}
      />
    );
  }
  return (
    <img
      alt={attachment.name}
      onError={() => setHasFailed(true)}
      src={attachment.previewUrl}
    />
  );
}

const ChatEvent = memo(function ChatEvent({
  event,
  onMutationApprovalAction,
  onProviderApprovalAction,
  onProviderStatusAction,
  onReusePrompt,
}: {
  event: SessionEvent;
  onMutationApprovalAction?: (
    proposalId: string,
    decision: "approve" | "reject",
  ) => void;
  onProviderApprovalAction?: (
    approvalId: string,
    decision: "approve" | "reject" | "allow-project",
  ) => void;
  onProviderStatusAction?: (action: string, event: SessionEvent) => void;
  onReusePrompt?: (message: string) => void;
}) {
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const providerStatus = providerStatusFromEvent(event);
  if (providerStatus) {
    return (
      <article
        className={`gyro-provider-status-row is-${providerStatus.status}`}
      >
        <div className="gyro-provider-status-icon">
          {providerStatus.status === "failed" ? (
            <X size={15} />
          ) : providerStatus.status === "blocked" ||
            providerStatus.status === "cancelled" ? (
            <X size={15} />
          ) : providerStatus.status === "ready" ||
            providerStatus.status === "done" ? (
            <Check size={15} />
          ) : (
            <CircleDashed size={15} />
          )}
        </div>
        <div>
          <strong>{event.message}</strong>
          <span>
            {providerStatus.modelLabel
              ? `${providerStatus.providerLabel} · ${providerStatus.modelLabel}`
              : providerStatus.providerLabel}
          </span>
          {providerStatus.recoveryMessage || providerStatus.error ? (
            <small>
              {providerStatus.recoveryMessage ?? providerStatus.error}
            </small>
          ) : null}
        </div>
        <div className="gyro-provider-status-actions">
          {providerStatus.status === "failed" ||
          providerStatus.status === "cancelled" ? (
            <>
              <button
                onClick={() => onProviderStatusAction?.("retry-send", event)}
                type="button"
              >
                Retry
              </button>
              {providerStatus.status === "failed" &&
              providerStatus.recoveryKind === "authentication" ? (
                <button
                  onClick={() =>
                    onProviderStatusAction?.("reconnect-provider", event)
                  }
                  type="button"
                >
                  Reconnect
                </button>
              ) : null}
            </>
          ) : providerStatus.status === "blocked" ? (
            <button
              onClick={() =>
                onProviderStatusAction?.("reconnect-provider", event)
              }
              type="button"
            >
              Setup
            </button>
          ) : null}
          <button
            onClick={() => onProviderStatusAction?.("open-providers", event)}
            type="button"
          >
            Providers
          </button>
        </div>
      </article>
    );
  }
  const mutationApproval = mutationApprovalFromEvent(event);
  if (mutationApproval) {
    return (
      <MutationApprovalCard
        approval={mutationApproval}
        onAction={onMutationApprovalAction}
      />
    );
  }
  const providerApproval = providerApprovalFromEvent(event);
  if (providerApproval) {
    return (
      <ProviderToolApprovalCard
        approval={providerApproval}
        onAction={onProviderApprovalAction}
      />
    );
  }
  const capabilityCall = capabilityCallFromEvent(event);
  if (capabilityCall) {
    return (
      <CapabilityActivityCard
        activity={capabilityCall}
        event={event}
        onAction={onProviderStatusAction}
      />
    );
  }
  const isUser = event.kind === "user-message";
  const isAssistant = event.kind === "assistant-message";
  const isSystem =
    event.kind === "system-event" ||
    event.kind === "approval-requested" ||
    event.kind === "plan-updated";
  const canInspect = isInspectableEvent(event);
  const detailRef = useOutsidePointerDismiss<HTMLDivElement>(
    canInspect && isDetailOpen,
    () => setIsDetailOpen(false),
  );
  return (
    <article
      className={[
        "gyro-message",
        isUser ? "is-user" : "",
        isAssistant ? "is-assistant" : "",
        isSystem ? "is-system" : "",
      ].join(" ")}
    >
      <div className="gyro-message-avatar">
        {isUser ? <UserCircle size={17} /> : <Bot size={17} />}
      </div>
      <div
        className={isUser ? "gyro-user-message-content" : undefined}
        ref={detailRef}
      >
        {isUser || isAssistant ? null : (
          <div className="gyro-message-meta">
            {event.kind.replaceAll("-", " ")}
          </div>
        )}
        {isAssistant ? (
          <AssistantResponse event={event} />
        ) : isUser ? (
          <div className="gyro-user-message-bubble">
            <TranscriptAttachments event={event} />
            <p>{event.message}</p>
          </div>
        ) : (
          <p>{event.message}</p>
        )}
        {isUser ? (
          <footer className="gyro-user-message-meta">
            {onReusePrompt ? (
              <button
                aria-label="Use prompt again"
                className="gyro-use-again"
                onClick={() => onReusePrompt(event.message)}
                title="Use prompt again"
                type="button"
              >
                <RefreshCw aria-hidden="true" size={14} />
              </button>
            ) : null}
            <time dateTime={event.createdAt}>
              {formatMessageTime(event.createdAt)}
            </time>
            <button
              aria-label="Copy message"
              className="gyro-copy-user-message"
              onClick={() => copyAssistantResponse(event.message)}
              title="Copy message"
              type="button"
            >
              <Copy aria-hidden="true" size={15} />
            </button>
          </footer>
        ) : null}
        {canInspect ? (
          <button
            aria-expanded={isDetailOpen}
            className="gyro-tool-detail-trigger"
            onClick={() => setIsDetailOpen((current) => !current)}
            type="button"
          >
            {isDetailOpen ? "Hide details" : "Inspect"}
          </button>
        ) : null}
        {canInspect && isDetailOpen ? (
          <div
            aria-label={`${event.kind.replaceAll("-", " ")} details`}
            className="gyro-tool-detail-panel"
            role="dialog"
          >
            <div className="gyro-tool-detail-header">
              {toolDetailIcon(event)}
              <div>
                <strong>{toolDetailTitle(event)}</strong>
                <span>{new Date(event.createdAt).toLocaleString()}</span>
              </div>
              <button
                aria-label="Close details"
                className="gyro-tool-detail-close"
                onClick={() => setIsDetailOpen(false)}
                type="button"
              >
                <X size={14} />
              </button>
            </div>
            <div className="gyro-tool-detail-grid">
              <ToolDetailFact label="Event" value={event.kind} />
              <ToolDetailFact label="Turn" value={event.turnId ?? "none"} />
              <ToolDetailFact label="Session" value={event.sessionId} />
            </div>
            <pre>{formatEventPayload(event)}</pre>
          </div>
        ) : null}
      </div>
    </article>
  );
});

type MutationApproval = {
  proposalId: string;
  operation: "create" | "update";
  path: string;
  scope: string;
  risk: string;
  effect: string;
  status: "pending" | "applied" | "rejected" | "failed";
  error?: string;
};

type ProviderToolApproval = {
  approvalId: string;
  approvalType: "command" | "file-change" | "permissions" | "capability";
  providerLabel: string;
  capabilityId?: string;
  scope?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  error?: string;
  risk: string;
  changes: Array<{ path: string; diff?: string }>;
  status:
    "pending" | "approved" | "applied" | "rejected" | "cancelled" | "failed";
};

function MutationApprovalCard({
  approval,
  onAction,
}: {
  approval: MutationApproval;
  onAction?: (proposalId: string, decision: "approve" | "reject") => void;
}) {
  const isPending = approval.status === "pending";
  const statusLabel =
    approval.status === "applied"
      ? "Applied"
      : approval.status === "rejected"
        ? "Rejected"
        : approval.status === "failed"
          ? approval.error?.includes("expired")
            ? "Expired"
            : "Needs review"
          : "Approval required";
  return (
    <article
      aria-label={`File ${approval.operation} approval for ${approval.path}`}
      className={`gyro-mutation-approval is-${approval.status}`}
    >
      <div className="gyro-mutation-approval-heading">
        <span>
          <ShieldCheck size={15} />
        </span>
        <div>
          <strong>
            {approval.operation === "create" ? "Create file" : "Update file"}
          </strong>
          <code>{approval.path}</code>
        </div>
        <small>{statusLabel}</small>
      </div>
      <div className="gyro-mutation-approval-facts">
        <span>
          <small>Effect</small>
          {approval.effect}
        </span>
        <span>
          <small>Scope</small>
          {approval.scope === "workspace-file"
            ? "Selected project only"
            : approval.scope}
        </span>
      </div>
      {approval.error ? (
        <p className="gyro-mutation-approval-error">{approval.error}</p>
      ) : (
        <p className="gyro-mutation-approval-risk">{approval.risk}</p>
      )}
      {isPending ? (
        <div className="gyro-mutation-approval-actions">
          <button
            className="is-secondary"
            onClick={() => onAction?.(approval.proposalId, "reject")}
            type="button"
          >
            Reject
          </button>
          <button
            className="is-primary"
            onClick={() => onAction?.(approval.proposalId, "approve")}
            type="button"
          >
            Approve change
          </button>
        </div>
      ) : null}
    </article>
  );
}

function ProviderToolApprovalCard({
  approval,
  onAction,
}: {
  approval: ProviderToolApproval;
  onAction?: (
    approvalId: string,
    decision: "approve" | "reject" | "allow-project",
  ) => void;
}) {
  const isPending = approval.status === "pending";
  const title =
    approval.approvalType === "command"
      ? "Run command"
      : approval.approvalType === "file-change"
        ? "Apply file changes"
        : approval.approvalType === "capability"
          ? `Allow ${approval.capabilityId?.replaceAll("-", " ") ?? "model capability"}`
          : "Expand permissions";
  const statusLabel =
    approval.status === "applied"
      ? "Applied"
      : approval.status === "approved"
        ? "Approved"
        : approval.status === "rejected"
          ? "Rejected"
          : approval.status === "cancelled"
            ? "Cancelled"
            : approval.status === "failed"
              ? "Unavailable"
              : "Approval required";
  return (
    <article
      aria-label={`${title} approval`}
      className={`gyro-provider-tool-approval is-${approval.status}`}
    >
      <div className="gyro-provider-tool-approval-heading">
        <span>
          {approval.approvalType === "command" ? (
            <Terminal size={15} />
          ) : approval.approvalType === "file-change" ? (
            <FileCode2 size={15} />
          ) : approval.approvalType === "capability" ? (
            <Sparkles size={15} />
          ) : (
            <ShieldCheck size={15} />
          )}
        </span>
        <div>
          <strong>{title}</strong>
          <small>{approval.providerLabel}</small>
        </div>
        <small>{statusLabel}</small>
      </div>
      {approval.command ? (
        <code className="gyro-provider-tool-approval-command">
          {approval.command}
        </code>
      ) : null}
      {approval.changes.length ? (
        <div className="gyro-provider-tool-approval-files">
          {approval.changes.slice(0, 4).map((change) => (
            <span key={change.path}>
              <FileText size={13} />
              {change.path}
            </span>
          ))}
        </div>
      ) : null}
      <p>{approval.error ?? approval.reason ?? approval.risk}</p>
      {approval.scope ? <small>Scope: {approval.scope}</small> : null}
      {approval.cwd ? <small>In {approval.cwd}</small> : null}
      {isPending ? (
        <div className="gyro-provider-tool-approval-actions">
          <button
            className="is-secondary"
            onClick={() => onAction?.(approval.approvalId, "reject")}
            type="button"
          >
            Reject
          </button>
          {approval.approvalType === "capability" ? (
            <>
              <button
                onClick={() => onAction?.(approval.approvalId, "allow-project")}
                type="button"
              >
                Allow for project
              </button>
              <button
                className="is-primary"
                onClick={() => onAction?.(approval.approvalId, "approve")}
                type="button"
              >
                Allow once
              </button>
            </>
          ) : (
            <button
              className="is-primary"
              onClick={() => onAction?.(approval.approvalId, "approve")}
              type="button"
            >
              {approval.approvalType === "command" ? "Run command" : "Approve"}
            </button>
          )}
        </div>
      ) : null}
    </article>
  );
}

function CapabilityActivityCard({
  activity,
  event,
  onAction,
}: {
  activity: CapabilityCallEvent;
  event: SessionEvent;
  onAction?: (action: string, event: SessionEvent) => void;
}) {
  const isBusy = ["requested", "waiting", "running"].includes(activity.status);
  const icon =
    activity.resource?.kind === "terminal" ? (
      <Terminal size={15} />
    ) : activity.resource?.kind === "browser" ? (
      <Globe2 size={15} />
    ) : activity.resource?.kind === "ide" ? (
      <FileCode2 size={15} />
    ) : (
      <Search size={15} />
    );
  return (
    <article
      className={`gyro-capability-activity is-${activity.status}`}
      aria-label={`${activity.capabilityId.replaceAll("-", " ")} ${activity.status}`}
    >
      <span className="gyro-capability-activity-icon">{icon}</span>
      <div>
        <strong>{activity.capabilityId.replaceAll("-", " ")}</strong>
        <span>{activity.summary}</span>
        {activity.resource ? <small>{activity.resource.label}</small> : null}
      </div>
      <div className="gyro-capability-activity-actions">
        <small>{isBusy ? "Working" : activity.status}</small>
        {activity.resource && activity.status !== "inactive" ? (
          <button
            onClick={() => onAction?.("show-capability", event)}
            type="button"
          >
            Show
          </button>
        ) : null}
        {activity.resource?.kind === "terminal" &&
        activity.status === "completed" ? (
          <button
            onClick={() => onAction?.("stop-capability", event)}
            type="button"
          >
            Stop
          </button>
        ) : null}
      </div>
    </article>
  );
}

type ChatTranscriptTurn = {
  id: string;
  user?: SessionEvent;
  timelineEvents: SessionEvent[];
  statusEvent?: SessionEvent;
  startedAt: string;
  runStartedAt?: string;
  completedAt?: string;
  durationMs?: number;
  runStatus?: string;
  runUpdatedAtMs?: number;
};

function TranscriptAttachments({ event }: { event: SessionEvent }) {
  const payload = eventPayloadRecord(event) ?? {};
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.filter((item): item is ChatAttachment => {
        const record =
          item && typeof item === "object"
            ? (item as Partial<ChatAttachment>)
            : undefined;
        return (
          typeof record?.id === "string" &&
          typeof record.name === "string" &&
          typeof record.kind === "string"
        );
      })
    : [];
  if (!attachments.length) return null;
  return (
    <div className="gyro-transcript-attachments">
      {attachments.map((attachment) => (
        <div
          className={`gyro-transcript-attachment is-${attachment.kind}`}
          key={attachment.id}
        >
          {attachment.kind === "image" && attachment.previewUrl ? (
            <img alt="" src={attachment.previewUrl} />
          ) : attachment.kind === "image" ? (
            <ImagePlus size={14} />
          ) : attachment.kind === "video" ? (
            <Video size={14} />
          ) : (
            <FileText size={14} />
          )}
          <span>
            <strong>{attachment.name}</strong>
            <small>{formatAttachmentSize(attachment.size)}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

function deriveTranscriptState(events: SessionEvent[]) {
  const mutationDecisions = new Map<string, Record<string, unknown>>();
  const providerApprovalDecisions = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    const payload = eventPayloadRecord(event);
    if (
      event.kind === "system-event" &&
      stringFromEventPayload(payload, "kind") === "mutation-approval"
    ) {
      const proposalId = stringFromEventPayload(payload, "proposalId");
      const status = stringFromEventPayload(payload, "status");
      if (proposalId && status && status !== "pending") {
        mutationDecisions.set(proposalId, payload ?? {});
      }
    }
    if (
      event.kind === "system-event" &&
      stringFromEventPayload(payload, "kind") === "provider-tool-approval"
    ) {
      const approvalId = stringFromEventPayload(payload, "approvalId");
      const status = stringFromEventPayload(payload, "status");
      if (approvalId && status && status !== "pending") {
        providerApprovalDecisions.set(approvalId, payload ?? {});
      }
    }
  }
  const looseEvents: SessionEvent[] = [];
  const turns: ChatTranscriptTurn[] = [];
  const turnsById = new Map<string, ChatTranscriptTurn>();
  const ensureTurn = (turnId: string, startedAt: string) => {
    let turn = turnsById.get(turnId);
    if (!turn) {
      turn = {
        id: turnId,
        timelineEvents: [],
        startedAt,
      };
      turns.push(turn);
      turnsById.set(turnId, turn);
    }
    return turn;
  };
  for (const originalEvent of events) {
    const originalApproval = mutationApprovalFromEvent(originalEvent);
    const originalProviderApproval = providerApprovalFromEvent(originalEvent);
    const decision = originalApproval
      ? mutationDecisions.get(originalApproval.proposalId)
      : originalProviderApproval
        ? providerApprovalDecisions.get(originalProviderApproval.approvalId)
        : undefined;
    const event = decision
      ? {
          ...originalEvent,
          payload: {
            ...(eventPayloadRecord(originalEvent) ?? {}),
            status: decision.status,
            error: decision.error,
          },
        }
      : originalEvent;
    const turnId = turnKeyFromEvent(event);
    const payload = eventPayloadRecord(event);
    const payloadKind = stringFromEventPayload(payload, "kind");
    if (
      event.turnId &&
      (payloadKind === "provider-diagnostics" || payloadKind === "provider-run")
    ) {
      const turn = ensureTurn(turnId, event.createdAt);
      const status = stringFromEventPayload(payload, "status");
      const payloadStartedAt = stringFromEventPayload(payload, "startedAt");
      const payloadCompletedAt = stringFromEventPayload(payload, "completedAt");
      const durationMs = numberFromEventPayload(payload, "durationMs");
      const runUpdatedAtMs = timestampMs(
        payloadCompletedAt ?? payloadStartedAt ?? event.createdAt,
      );
      if (
        runUpdatedAtMs === undefined ||
        turn.runUpdatedAtMs === undefined ||
        runUpdatedAtMs >= turn.runUpdatedAtMs
      ) {
        turn.runUpdatedAtMs = runUpdatedAtMs ?? turn.runUpdatedAtMs;
        if (status) {
          turn.runStatus = status;
        }
        if (payloadStartedAt) {
          turn.runStartedAt = payloadStartedAt;
        } else if (status === "running") {
          turn.runStartedAt = event.createdAt;
        }
        if (payloadCompletedAt) {
          turn.completedAt = payloadCompletedAt;
        } else if (status && isTerminalRunStatus(status)) {
          turn.completedAt = event.createdAt;
        }
        if (durationMs !== undefined) {
          turn.durationMs = durationMs;
        }
      }
    }
    if (isHiddenTranscriptEvent(event)) {
      continue;
    }
    if (event.kind === "user-message") {
      const turn = ensureTurn(turnId, event.createdAt);
      turn.user = event;
      turn.startedAt = event.createdAt;
      continue;
    }
    const belongsToTurn = event.turnId || providerStatusFromEvent(event);
    if (!belongsToTurn) {
      looseEvents.push(event);
      continue;
    }
    const turn = ensureTurn(turnId, event.createdAt);
    if (event.kind === "assistant-message") {
      turn.timelineEvents.push(event);
    } else if (mutationApprovalFromEvent(event)) {
      turn.timelineEvents.push(event);
    } else if (providerApprovalFromEvent(event)) {
      turn.timelineEvents.push(event);
    } else if (providerActivityFromEvent(event)) {
      turn.timelineEvents.push(event);
    } else if (providerStatusFromEvent(event)) {
      turn.statusEvent = event;
      const providerStatus = providerStatusFromEvent(event);
      if (providerStatus) {
        const statusStartedAt = stringFromEventPayload(payload, "startedAt");
        const statusCompletedAt = stringFromEventPayload(
          payload,
          "completedAt",
        );
        const durationMs = numberFromEventPayload(payload, "durationMs");
        const runUpdatedAtMs = timestampMs(
          statusCompletedAt ?? statusStartedAt ?? event.createdAt,
        );
        if (
          runUpdatedAtMs === undefined ||
          turn.runUpdatedAtMs === undefined ||
          runUpdatedAtMs >= turn.runUpdatedAtMs
        ) {
          turn.runUpdatedAtMs = runUpdatedAtMs ?? turn.runUpdatedAtMs;
          turn.runStatus = providerStatus.status;
          if (isActiveRunStatus(providerStatus.status)) {
            turn.runStartedAt = statusStartedAt ?? event.createdAt;
            turn.completedAt = undefined;
            turn.durationMs = undefined;
          } else if (isTerminalRunStatus(providerStatus.status)) {
            turn.completedAt = statusCompletedAt ?? event.createdAt;
            if (statusStartedAt) {
              turn.runStartedAt = statusStartedAt;
            }
            if (durationMs !== undefined) {
              turn.durationMs = durationMs;
            }
          }
        }
      }
    } else {
      looseEvents.push(event);
    }
  }
  for (const turn of turns) {
    turn.timelineEvents = orderedChatTimelineEvents(turn.timelineEvents);
  }
  // First-seen provider sequences survive streaming updates and persistence,
  // so completion timing cannot move an early item below later activity.
  turns.sort((first, second) =>
    compareIsoTimestamps(first.startedAt, second.startedAt),
  );
  looseEvents.sort(compareTranscriptEvents);
  return { looseEvents, turns };
}

function compareTranscriptEvents(first: SessionEvent, second: SessionEvent) {
  return compareIsoTimestamps(first.createdAt, second.createdAt);
}

function compareIsoTimestamps(first: string, second: string) {
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  if (!Number.isFinite(firstMs) || !Number.isFinite(secondMs)) {
    return 0;
  }
  return firstMs - secondMs;
}

function isActiveRunStatus(status: string) {
  return ["queued", "running", "waiting"].includes(status);
}

function isTerminalRunStatus(status: string) {
  return ["blocked", "done", "failed", "cancelled"].includes(status);
}

function timestampMs(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function activeTranscriptTurnId(turns: ChatTranscriptTurn[]) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn && turn.runStatus && isActiveRunStatus(turn.runStatus)) {
      return turn.id;
    }
  }
  return undefined;
}

function turnKeyFromEvent(event: SessionEvent) {
  return (
    event.turnId ??
    stringFromEventPayload(eventPayloadRecord(event), "turnId") ??
    event.id
  );
}

function ChatTurn({
  artifactActions,
  isActive,
  onLoadChangeDiff,
  onOpenChanges,
  onMutationApprovalAction,
  onProviderApprovalAction,
  onProviderStatusAction,
  onReusePrompt,
  onContinueChat,
  onOpenPlan,
  onPlanDecision,
  plan,
  isPlanDecisionPending,
  isPlanPanelOpen,
  isPlanReadyForDecision,
  sourceControl,
  sourceControlBaseline,
  turn,
}: {
  artifactActions?: ChatArtifactActions;
  isActive: boolean;
  onLoadChangeDiff?: (path: string) => Promise<string>;
  onOpenChanges?: () => void;
  onMutationApprovalAction?: (
    proposalId: string,
    decision: "approve" | "reject",
  ) => void;
  onProviderApprovalAction?: (
    approvalId: string,
    decision: "approve" | "reject" | "allow-project",
  ) => void;
  onProviderStatusAction?: (action: string, event: SessionEvent) => void;
  onReusePrompt?: (message: string) => void;
  onContinueChat?: () => void;
  onOpenPlan?: () => void;
  onPlanDecision?: (decision: "approve" | "reject") => void;
  plan?: SessionPlan;
  isPlanDecisionPending: boolean;
  isPlanPanelOpen?: boolean;
  isPlanReadyForDecision: boolean;
  sourceControl?: SourceControlState;
  sourceControlBaseline?: Record<
    string,
    { additions: number; deletions: number }
  >;
  turn: ChatTranscriptTurn;
}) {
  const providerStatus = turn.statusEvent
    ? providerStatusFromEvent(turn.statusEvent)
    : undefined;
  const wasInterrupted = Boolean(
    !isActive &&
    providerStatus &&
    ["queued", "running", "waiting"].includes(providerStatus.status),
  );
  const isRunning = isActive;
  const [isThoughtCollapsed, setIsThoughtCollapsed] = useState(!isRunning);
  useEffect(() => {
    setIsThoughtCollapsed(!isRunning);
  }, [isRunning]);
  const completedAt = !isRunning
    ? (turn.completedAt ?? turn.statusEvent?.createdAt)
    : undefined;
  const hasResponse = turn.timelineEvents.some(
    (event) =>
      event.kind === "assistant-message" && event.message.trim().length > 0,
  );
  const isPlanResponseTurn = Boolean(
    plan?.content && plan.sourceTurnId === turn.id,
  );
  const timelineItems = interleavedChatTimelineItems(turn.timelineEvents);
  const hasWorkActivity = timelineItems.some(
    (item) => item.kind !== "event" || item.event.kind !== "assistant-message",
  );
  const canCollapseThought = !isRunning && hasWorkActivity;
  const workTimelineItems = timelineItems.filter(
    (item) => item.kind !== "event" || item.event.kind !== "assistant-message",
  );
  const responseTimelineItems = timelineItems.filter(
    (item) => item.kind === "event" && item.event.kind === "assistant-message",
  );
  const visibleWorkTimelineItems =
    isRunning || !isThoughtCollapsed ? workTimelineItems : [];
  const completionArtifacts = useMemo(
    () => derivedCompletionArtifacts(turn, isRunning),
    [isRunning, turn],
  );
  return (
    <section className="gyro-chat-turn" data-turn-id={turn.id}>
      {turn.user ? (
        <ChatEvent
          event={turn.user}
          onProviderApprovalAction={onProviderApprovalAction}
          onReusePrompt={onReusePrompt}
        />
      ) : null}
      <div className="gyro-chat-run">
        <div className="gyro-chat-run-work">
          <ChatRunHeader
            completedAt={completedAt}
            durationMs={turn.durationMs}
            isCollapsed={isThoughtCollapsed}
            isCollapsible={canCollapseThought}
            isRunning={isRunning}
            onToggle={() => setIsThoughtCollapsed((current) => !current)}
            startedAt={turn.runStartedAt ?? turn.startedAt}
          >
            {!isRunning && hasResponse && onContinueChat ? (
              <button onClick={onContinueChat} type="button">
                Continue
              </button>
            ) : null}
          </ChatRunHeader>
          {isRunning && turn.timelineEvents.length === 0 ? (
            <div className="gyro-chat-run-thinking" role="status">
              Thinking
            </div>
          ) : null}
          {visibleWorkTimelineItems.length > 0 ? (
            <div className="gyro-chat-run-sequence" aria-label="Work timeline">
              {visibleWorkTimelineItems.map((item) => {
                if (item.kind === "file-summary") {
                  return (
                    <ChatTurnChangeSummary
                      changeSummary={chatTurnChangeSummary(
                        item.events,
                        sourceControl,
                        sourceControlBaseline,
                      )}
                      isRunning={isRunning}
                      key={item.id}
                      onLoadChangeDiff={onLoadChangeDiff}
                      onOpenChanges={onOpenChanges}
                    />
                  );
                }
                if (item.kind === "activity-group") {
                  return (
                    <ProviderActivityGroup events={item.events} key={item.id} />
                  );
                }
                const event = item.event;
                return mutationApprovalFromEvent(event) ||
                  providerApprovalFromEvent(event) ||
                  capabilityCallFromEvent(event) ? (
                  <ChatEvent
                    event={event}
                    key={event.id}
                    onMutationApprovalAction={onMutationApprovalAction}
                    onProviderApprovalAction={onProviderApprovalAction}
                  />
                ) : (
                  <ProviderActivityRow
                    event={event}
                    key={event.id}
                    onOpenChanges={onOpenChanges}
                    sourceControl={sourceControl}
                    sourceControlBaseline={sourceControlBaseline}
                  />
                );
              })}
            </div>
          ) : null}
        </div>
        {responseTimelineItems.length > 0 ? (
          <div className="gyro-chat-run-sequence" aria-label="Final response">
            {responseTimelineItems.map((item) => {
              if (item.kind !== "event") {
                return null;
              }
              const event = item.event;
              return (
                <div
                  aria-label={isRunning ? "Assistant update" : "Final response"}
                  className="gyro-chat-run-timeline is-final-response"
                  key={event.id}
                >
                  <article className="gyro-message is-assistant">
                    <div>
                      {isPlanResponseTurn ? (
                        <PlanArtifactCard
                          content={plan?.content ?? event.message}
                          isOpen={Boolean(isPlanPanelOpen)}
                          isPending={isPlanDecisionPending}
                          onOpen={onOpenPlan}
                          onPlanDecision={onPlanDecision}
                          showDecision={false}
                          title={plan?.title ?? "Implementation plan"}
                        />
                      ) : (
                        <AssistantResponse
                          actions={artifactActions}
                          additionalArtifacts={completionArtifacts}
                          event={event}
                        />
                      )}
                    </div>
                  </article>
                </div>
              );
            })}
          </div>
        ) : null}
        {providerStatus &&
        (["failed", "blocked", "cancelled"].includes(providerStatus.status) ||
          wasInterrupted) &&
        turn.statusEvent ? (
          <div className="gyro-chat-run-error">
            <div>
              <strong>
                {wasInterrupted
                  ? "Previous send was interrupted"
                  : turn.statusEvent.message}
              </strong>
              {wasInterrupted ? (
                <span>
                  Gyro restarted or lost the provider process before this turn
                  finished. Retry continues the same message.
                </span>
              ) : providerStatus.recoveryMessage || providerStatus.error ? (
                <span>
                  {providerStatus.recoveryMessage ?? providerStatus.error}
                </span>
              ) : null}
            </div>
            <div>
              {providerStatus.status === "failed" ||
              providerStatus.status === "cancelled" ||
              wasInterrupted ? (
                <button
                  onClick={() =>
                    onProviderStatusAction?.("retry-send", turn.statusEvent!)
                  }
                  type="button"
                >
                  Retry
                </button>
              ) : null}
              {providerStatus.status !== "cancelled" &&
              (providerStatus.status === "blocked" ||
                providerStatus.recoveryKind === "authentication") ? (
                <button
                  onClick={() =>
                    onProviderStatusAction?.(
                      "reconnect-provider",
                      turn.statusEvent!,
                    )
                  }
                  type="button"
                >
                  Reconnect
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ChangeSummaryFile({
  additions,
  deletions,
  onLoadDiff,
  path,
}: {
  additions?: number;
  deletions?: number;
  onLoadDiff?: (path: string) => Promise<string>;
  path: string;
}) {
  const panelId = useId();
  const [isExpanded, setIsExpanded] = useState(false);
  const [diffState, setDiffState] = useState<{
    content?: string;
    error?: string;
    status: "idle" | "loading" | "ready" | "error";
  }>({ status: "idle" });

  const toggleDiff = () => {
    const shouldExpand = !isExpanded;
    setIsExpanded(shouldExpand);
    if (!shouldExpand || diffState.status !== "idle") return;
    if (!onLoadDiff) {
      setDiffState({
        error: "Inline diff is unavailable for this workspace.",
        status: "error",
      });
      return;
    }
    setDiffState({ status: "loading" });
    void onLoadDiff(path)
      .then((content) =>
        setDiffState({
          content: content.trimEnd() || "No changes to display.",
          status: "ready",
        }),
      )
      .catch((error) =>
        setDiffState({ error: String(error), status: "error" }),
      );
  };

  return (
    <div className="gyro-change-summary-file">
      <button
        aria-controls={panelId}
        aria-expanded={isExpanded}
        onClick={toggleDiff}
        title={path}
        type="button"
      >
        <span>{path}</span>
        <small>
          {additions !== undefined && deletions !== undefined ? (
            <>
              <em className="is-added">+{additions}</em>
              <em className="is-removed">-{deletions}</em>
            </>
          ) : null}
          {isExpanded ? (
            <ChevronDown aria-hidden="true" size={13} />
          ) : (
            <ChevronRight aria-hidden="true" size={13} />
          )}
        </small>
      </button>
      {isExpanded ? (
        <div className="gyro-change-summary-diff" id={panelId}>
          {diffState.status === "loading" ? (
            <div className="gyro-change-summary-diff-status" role="status">
              Loading changes…
            </div>
          ) : diffState.status === "error" ? (
            <div
              className="gyro-change-summary-diff-status is-error"
              role="alert"
            >
              {diffState.error}
            </div>
          ) : (
            <div
              aria-label={`Changes in ${path}`}
              className="gyro-change-summary-diff-scroll"
              role="region"
              tabIndex={0}
            >
              <code>
                {(diffState.content ?? "").split("\n").map((line, index) => (
                  <span
                    className={changeSummaryDiffLineClass(line)}
                    key={`${index}:${line}`}
                  >
                    {line || " "}
                  </span>
                ))}
              </code>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function changeSummaryDiffLineClass(line: string) {
  if (line.startsWith("+") && !line.startsWith("+++")) return "is-added";
  if (line.startsWith("-") && !line.startsWith("---")) return "is-removed";
  if (line.startsWith("@@")) return "is-hunk";
  if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) return "is-meta";
  return undefined;
}

function ChatRunHeader({
  children,
  completedAt,
  durationMs,
  isCollapsed,
  isCollapsible,
  isRunning,
  onToggle,
  startedAt,
}: {
  children?: ReactNode;
  completedAt?: string;
  durationMs?: number;
  isCollapsed: boolean;
  isCollapsible: boolean;
  isRunning: boolean;
  onToggle: () => void;
  startedAt: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isRunning]);
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : now;
  const elapsedSeconds =
    !isRunning && durationMs !== undefined
      ? Math.max(0, Math.round(durationMs / 1_000))
      : Number.isFinite(start)
        ? Math.max(0, Math.round((end - start) / 1_000))
        : 0;
  const label = `${isRunning ? "Working" : "Worked"} for ${formatThoughtDuration(elapsedSeconds)}`;
  return (
    <div className="gyro-chat-run-header">
      {isCollapsible ? (
        <button
          aria-expanded={!isCollapsed}
          className="gyro-chat-run-toggle"
          onClick={onToggle}
          type="button"
        >
          <span>{label}</span>
          {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : (
        <span>{label}</span>
      )}
      {children ? (
        <div className="gyro-chat-run-controls">{children}</div>
      ) : null}
    </div>
  );
}

function formatThoughtDuration(elapsedSeconds: number) {
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return [
    hours > 0 ? `${hours}h` : undefined,
    minutes % 60 > 0 ? `${minutes % 60}m` : undefined,
    seconds > 0 || elapsedSeconds === 0 ? `${seconds}s` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function formatMessageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function providerActivityPathsMatch(first: string, second: string) {
  const normalize = (path: string) =>
    path.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "");
  const firstPath = normalize(first);
  const secondPath = normalize(second);
  return (
    firstPath === secondPath ||
    firstPath.endsWith(`/${secondPath}`) ||
    secondPath.endsWith(`/${firstPath}`)
  );
}

function ProviderActivityRow({
  count = 1,
  event,
  onOpenChanges,
  sourceControl,
  sourceControlBaseline,
}: {
  count?: number;
  event: SessionEvent;
  onOpenChanges?: () => void;
  sourceControl?: SourceControlState;
  sourceControlBaseline?: Record<
    string,
    { additions: number; deletions: number }
  >;
}) {
  const activity = providerActivityFromEvent(event);
  if (!activity) {
    return null;
  }
  if (activity.kind === "commentary") {
    return (
      <article className="gyro-chat-run-commentary">
        <div>
          {structuredCommentaryBlocks(activity.label).map((block, index) => (
            <p key={`${block}-${index}`}>
              {renderAssistantInlineContent(block)}
            </p>
          ))}
        </div>
      </article>
    );
  }
  const compactedLabel =
    count > 1
      ? activity.kind === "command"
        ? `Ran ${count} commands`
        : activity.kind === "search"
          ? `Searched ${count} times`
          : `Used ${count} tools`
      : activity.label;
  if (activity.kind === "file") {
    const path = providerActivityFilePath(event);
    const file = path
      ? sourceControlFileForActivityPath(path, sourceControl)
      : undefined;
    const fileDelta = file
      ? sourceControlFileDelta(
          file,
          sourceControlStatsForActivityPath(
            path ?? file.path,
            sourceControlBaseline,
          ),
        )
      : undefined;
    const statusLabel =
      activity.status === "running"
        ? "Editing"
        : activity.status === "failed"
          ? "Edit failed"
          : "Edited";
    return (
      <button
        className={`gyro-chat-run-activity is-file is-${activity.status}`}
        onClick={onOpenChanges}
        title={path ?? activity.label}
        type="button"
      >
        <FileCode2 size={13} />
        <span>
          <strong>{statusLabel}</strong>
          <code>{path ?? activity.label.replace(/^Updated\s+/, "")}</code>
        </span>
        {fileDelta ? (
          <small>
            <em className="is-added">+{fileDelta.additions}</em>
            <em className="is-removed">-{fileDelta.deletions}</em>
          </small>
        ) : null}
        {activity.status === "running" ? (
          <CircleDashed className="is-spinning" size={12} />
        ) : (
          <ChevronRight size={12} />
        )}
      </button>
    );
  }
  return (
    <div
      className={`gyro-chat-run-activity is-${activity.status}`}
      title={
        count > 1
          ? `${compactedLabel}. Includes ${activity.label}`
          : (activity.detail ?? activity.label)
      }
    >
      {activity.kind === "command" ? (
        <Terminal size={13} />
      ) : activity.kind === "tool" ? (
        <Sparkles size={13} />
      ) : activity.kind === "context" ? (
        <Minimize2 size={13} />
      ) : (
        <Search size={13} />
      )}
      <span>{compactedLabel}</span>
      {activity.status === "running" ? (
        <CircleDashed className="is-spinning" size={12} />
      ) : (
        <ChevronRight size={12} />
      )}
    </div>
  );
}

function ProviderActivityGroup({ events }: { events: SessionEvent[] }) {
  const activity = providerActivityFromEvent(events[0] as SessionEvent);
  const [visibility, setVisibility] = useState<
    "collapsed" | "preview" | "expanded"
  >("collapsed");
  if (!activity) return null;
  const isOpen = visibility !== "collapsed";
  const visibleEvents =
    visibility === "expanded"
      ? events
      : visibility === "preview"
        ? events.slice(0, 3)
        : [];
  const label =
    activity.kind === "command"
      ? events.length === 1
        ? "Ran command"
        : `Ran ${events.length} commands`
      : activity.kind === "search"
        ? events.length === 1
          ? "Searched"
          : `Searched ${events.length} times`
        : events.length === 1
          ? "Used tool"
          : `Used ${events.length} tools`;
  const Icon =
    activity.kind === "command"
      ? Terminal
      : activity.kind === "search"
        ? Search
        : Sparkles;
  return (
    <section className="gyro-chat-run-activity-group">
      <button
        aria-expanded={isOpen}
        className="gyro-chat-run-activity-group-toggle"
        onClick={() =>
          setVisibility((current) =>
            current === "collapsed"
              ? events.length > 3
                ? "preview"
                : "expanded"
              : current === "preview"
                ? "expanded"
                : "collapsed",
          )
        }
        type="button"
      >
        <Icon size={14} />
        <span>{label}</span>
        {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {isOpen ? (
        <div className="gyro-chat-run-activity-group-items">
          {visibleEvents.map((event) => (
            <ProviderActivityRow event={event} key={event.id} />
          ))}
          {visibility === "preview" ? (
            <span className="gyro-chat-run-activity-group-more">
              {events.length - visibleEvents.length} more — click again to show
              all
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ChatTurnChangeSummary({
  changeSummary,
  isRunning,
  onLoadChangeDiff,
  onOpenChanges,
}: {
  changeSummary: ReturnType<typeof chatTurnChangeSummary>;
  isRunning: boolean;
  onLoadChangeDiff?: (path: string) => Promise<string>;
  onOpenChanges?: () => void;
}) {
  const fileCount = changeSummary.fileCount;
  const action = isRunning ? "Editing" : "Edited";
  const label = fileCount
    ? `${action} ${fileCount} ${fileCount === 1 ? "file" : "files"}`
    : `${action} files`;
  return (
    <section
      aria-label={label}
      aria-live="polite"
      className={`gyro-chat-run-change-summary ${isRunning ? "is-running" : "is-complete"}`}
    >
      <header>
        <span className="gyro-change-summary-icon">
          <FileCode2 size={15} />
        </span>
        <div>
          <strong>{label}</strong>
          {changeSummary.hasStats ? (
            <small>
              <em className="is-added">+{changeSummary.additions}</em>
              <em className="is-removed">-{changeSummary.deletions}</em>
            </small>
          ) : (
            <small>Stats unavailable</small>
          )}
        </div>
        {!isRunning ? (
          <div className="gyro-change-summary-actions">
            <button onClick={onOpenChanges} type="button">
              Review
            </button>
          </div>
        ) : null}
      </header>
      {changeSummary.fileChanges.length > 0 ? (
        <div className="gyro-change-summary-files">
          {changeSummary.fileChanges.map((file) => (
            <ChangeSummaryFile
              additions={file.additions}
              deletions={file.deletions}
              key={file.path}
              onLoadDiff={onLoadChangeDiff}
              path={file.path}
            />
          ))}
        </div>
      ) : (
        <button
          className="gyro-chat-run-live-files-review"
          onClick={onOpenChanges}
          type="button"
        >
          Changes are still syncing. Open Source Control
        </button>
      )}
    </section>
  );
}

function providerActivityFilePath(event: SessionEvent) {
  const activity = providerActivityFromEvent(event);
  if (!activity || activity.kind !== "file") {
    return undefined;
  }
  const detail = activity.detail?.trim();
  if (detail && detail !== "workspace files") {
    return detail;
  }
  const labelPath = activity.label
    .replace(/^(?:Editing|Edited|Updated)\s+/, "")
    .trim();
  return labelPath && !["file", "files", "workspace files"].includes(labelPath)
    ? labelPath
    : undefined;
}

function sourceControlFileForActivityPath(
  activityPath: string,
  sourceControl?: SourceControlState,
) {
  return sourceControl?.files.find((file) =>
    providerActivityPathsMatch(activityPath, file.path),
  );
}

function chatTurnChangeSummary(
  events: SessionEvent[],
  sourceControl?: SourceControlState,
  sourceControlBaseline?: Record<
    string,
    { additions: number; deletions: number }
  >,
) {
  const activityPaths = events.reduce<string[]>((uniquePaths, event) => {
    const path = providerActivityFilePath(event);
    if (
      path &&
      !uniquePaths.some((existing) =>
        providerActivityPathsMatch(path, existing),
      )
    ) {
      uniquePaths.push(path);
    }
    return uniquePaths;
  }, []);
  const hasGenericFileActivity = events.some((event) => {
    const activity = providerActivityFromEvent(event);
    return activity?.kind === "file" && !providerActivityFilePath(event);
  });
  const inferredPaths = hasGenericFileActivity
    ? (sourceControl?.files ?? [])
        .filter((file) =>
          sourceControlFileChangedSinceBaseline(file, sourceControlBaseline),
        )
        .map((file) => file.path)
    : [];
  const paths = [...activityPaths];
  for (const path of inferredPaths) {
    if (!paths.some((existing) => providerActivityPathsMatch(path, existing))) {
      paths.push(path);
    }
  }
  const files = paths
    .map((path) => sourceControlFileForActivityPath(path, sourceControl))
    .filter((file): file is SourceControlFile => Boolean(file));
  const deltas = files.map((file) =>
    sourceControlFileDelta(
      file,
      sourceControlStatsForActivityPath(file.path, sourceControlBaseline),
    ),
  );
  const fileChanges = paths.map((path) => {
    const file = sourceControlFileForActivityPath(path, sourceControl);
    const delta = file
      ? sourceControlFileDelta(
          file,
          sourceControlStatsForActivityPath(file.path, sourceControlBaseline),
        )
      : undefined;
    return {
      additions: delta?.additions,
      deletions: delta?.deletions,
      path: file?.path ?? path,
    };
  });
  return {
    additions: deltas.reduce((total, file) => total + file.additions, 0),
    deletions: deltas.reduce((total, file) => total + file.deletions, 0),
    hasStats: paths.length > 0 && files.length === paths.length,
    fileChanges,
    fileCount: Math.max(paths.length, hasGenericFileActivity ? 1 : 0),
    paths,
  };
}

function sourceControlFileChangedSinceBaseline(
  file: SourceControlFile,
  baseline?: Record<string, { additions: number; deletions: number }>,
) {
  if (!baseline) {
    return true;
  }
  const previous = sourceControlStatsForActivityPath(file.path, baseline);
  return (
    !previous ||
    previous.additions !== file.additions ||
    previous.deletions !== file.deletions
  );
}

function sourceControlStatsForActivityPath(
  activityPath: string,
  stats?: Record<string, { additions: number; deletions: number }>,
) {
  return Object.entries(stats ?? {}).find(([path]) =>
    providerActivityPathsMatch(activityPath, path),
  )?.[1];
}

function sourceControlFileDelta(
  current: Pick<SourceControlFile, "additions" | "deletions">,
  baseline?: { additions: number; deletions: number },
) {
  if (!baseline) {
    return {
      additions: current.additions,
      deletions: current.deletions,
    };
  }
  const additionsDelta = current.additions - baseline.additions;
  const deletionsDelta = current.deletions - baseline.deletions;
  return {
    additions: Math.max(0, additionsDelta) + Math.max(0, -deletionsDelta),
    deletions: Math.max(0, deletionsDelta) + Math.max(0, -additionsDelta),
  };
}

type AssistantResponseBlock =
  | { kind: "code"; content: string }
  | { kind: "commands"; items: string[] }
  | { kind: "heading"; content: string }
  | { kind: "list"; items: string[] }
  | { kind: "ordered-list"; items: string[] }
  | { kind: "paragraph"; content: string };

const ASSISTANT_RESPONSE_RICH_PARSE_MAX_CHARS = 12_000;

function derivedCompletionArtifacts(
  turn: ChatTranscriptTurn,
  isRunning: boolean,
): ChatArtifact[] {
  if (isRunning) return [];
  const workEvents = turn.timelineEvents.filter(
    (event) => event.kind !== "assistant-message",
  );
  if (!workEvents.length) return [];
  const changedFiles = Array.from(
    new Set(workEvents.map(providerActivityFilePath).filter(Boolean)),
  ) as string[];
  const commandCount = workEvents.filter((event) => {
    const payload = eventPayloadRecord(event);
    return (
      payload?.kind === "provider-activity" &&
      payload.activityKind === "command"
    );
  }).length;
  const failed = ["failed", "blocked", "cancelled"].includes(
    turn.runStatus ?? "",
  );
  const items: Extract<ChatArtifact, { kind: "completion" }>["items"] = [
    {
      label: failed ? "Turn needs attention" : "Response completed",
      status: failed ? "failed" : "passed",
    },
  ];
  if (commandCount > 0) {
    items.push({
      label: `${commandCount} ${commandCount === 1 ? "command" : "commands"}`,
      status: failed ? "failed" : "passed",
    });
  }
  if (changedFiles.length > 0) {
    items.push({
      label: `${changedFiles.length} changed ${changedFiles.length === 1 ? "file" : "files"}`,
      status: "changed",
    });
  }
  return [
    {
      id: `${turn.id}-completion`,
      kind: "completion",
      title: failed ? "Work needs attention" : "Work completed",
      status: failed ? "failed" : "completed",
      summary: failed
        ? "The turn ended before all work completed. Review the details above before continuing."
        : changedFiles.length > 0
          ? "The requested work finished with workspace changes ready to review."
          : "The requested work finished successfully.",
      items,
      files: changedFiles,
    },
  ];
}

function AssistantResponse({
  actions,
  additionalArtifacts = [],
  event,
}: {
  actions?: ChatArtifactActions;
  additionalArtifacts?: ChatArtifact[];
  event: SessionEvent;
}) {
  const visibleMessage = stripHiddenSessionTitleMarker(event.message);
  const artifacts = useMemo(() => {
    const emitted = chatArtifactsFromEvent(event);
    return [
      ...emitted,
      ...additionalArtifacts.filter(
        (artifact) => !emitted.some((item) => item.kind === artifact.kind),
      ),
    ];
  }, [additionalArtifacts, event]);
  const isStreaming = isStreamingAssistantEvent(event);
  const shouldUsePlainText =
    isStreaming ||
    visibleMessage.length > ASSISTANT_RESPONSE_RICH_PARSE_MAX_CHARS;
  const blocks = useMemo(
    () => (shouldUsePlainText ? [] : assistantResponseBlocks(visibleMessage)),
    [shouldUsePlainText, visibleMessage],
  );
  const body = shouldUsePlainText ? (
    <p className="gyro-response-streaming-text">{visibleMessage}</p>
  ) : (
    blocks.map((block, index) => (
      <AssistantResponseBlockView
        block={block}
        key={`${block.kind}-${index}`}
      />
    ))
  );
  return (
    <div className="gyro-response">
      <div className="gyro-response-body">{body}</div>
      <ChatArtifacts actions={actions} artifacts={artifacts} />
      <footer className="gyro-response-actions">
        <button
          aria-label="Copy response"
          onClick={() => copyAssistantResponse(visibleMessage)}
          title="Copy response"
          type="button"
        >
          <Copy size={15} />
        </button>
      </footer>
    </div>
  );
}

function AssistantResponseBlockView({
  block,
}: {
  block: AssistantResponseBlock;
}) {
  if (block.kind === "heading") {
    return <h3>{renderAssistantInlineContent(block.content)}</h3>;
  }
  if (block.kind === "list") {
    return (
      <ul>
        {block.items.map((item, index) => (
          <li key={`${item}-${index}`}>{renderAssistantInlineContent(item)}</li>
        ))}
      </ul>
    );
  }
  if (block.kind === "ordered-list") {
    return (
      <ol>
        {block.items.map((item, index) => (
          <li key={`${item}-${index}`}>{renderAssistantInlineContent(item)}</li>
        ))}
      </ol>
    );
  }
  if (block.kind === "commands") {
    return (
      <div className="gyro-response-command-list">
        {block.items.map((item, index) => (
          <code key={`${item}-${index}`}>{item}</code>
        ))}
      </div>
    );
  }
  if (block.kind === "code") {
    return (
      <pre className="gyro-response-code-block">
        <code>{block.content}</code>
      </pre>
    );
  }
  return <p>{renderAssistantInlineContent(block.content)}</p>;
}

function assistantResponseBlocks(message: string): AssistantResponseBlock[] {
  const blocks: AssistantResponseBlock[] = [];
  const paragraphLines: string[] = [];
  const listItems: string[] = [];
  const orderedListItems: string[] = [];
  const commandItems: string[] = [];
  const codeLines: string[] = [];
  let isInCodeBlock = false;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push({
      kind: "paragraph",
      content: paragraphLines.join(" ").replace(/\s+/g, " ").trim(),
    });
    paragraphLines.length = 0;
  };
  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }
    blocks.push({ kind: "list", items: [...listItems] });
    listItems.length = 0;
  };
  const flushOrderedList = () => {
    if (orderedListItems.length === 0) {
      return;
    }
    blocks.push({ kind: "ordered-list", items: [...orderedListItems] });
    orderedListItems.length = 0;
  };
  const flushCommands = () => {
    if (commandItems.length === 0) {
      return;
    }
    blocks.push({ kind: "commands", items: [...commandItems] });
    commandItems.length = 0;
  };
  const flushCode = () => {
    if (codeLines.length === 0) {
      return;
    }
    blocks.push({ kind: "code", content: codeLines.join("\n") });
    codeLines.length = 0;
  };
  const flushOpenBlocks = () => {
    flushParagraph();
    flushList();
    flushOrderedList();
    flushCommands();
  };

  for (const line of message.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (isInCodeBlock) {
        flushCode();
        isInCodeBlock = false;
      } else {
        flushOpenBlocks();
        isInCodeBlock = true;
      }
      continue;
    }
    if (isInCodeBlock) {
      codeLines.push(line);
      continue;
    }
    if (trimmed === "") {
      flushOpenBlocks();
      continue;
    }

    const heading = trimmed.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flushOpenBlocks();
      blocks.push({ kind: "heading", content: heading[1] ?? "" });
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      flushOrderedList();
      flushCommands();
      listItems.push(bullet[1] ?? "");
      continue;
    }

    const orderedItem = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (orderedItem) {
      flushParagraph();
      flushList();
      flushCommands();
      orderedListItems.push(orderedItem[1] ?? "");
      continue;
    }

    const codeOnly = trimmed.match(/^`([^`]+)`$/);
    if (codeOnly) {
      flushParagraph();
      flushList();
      flushOrderedList();
      commandItems.push(codeOnly[1] ?? "");
      continue;
    }

    flushList();
    flushOrderedList();
    flushCommands();
    paragraphLines.push(trimmed);
  }

  if (isInCodeBlock) {
    flushCode();
  }
  flushOpenBlocks();

  return blocks.length > 0 ? blocks : [{ kind: "paragraph", content: message }];
}

function renderAssistantInlineContent(value: string): ReactNode[] {
  return value
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("`") && part.endsWith("`")) {
        return (
          <code className="gyro-response-inline-code" key={`${part}-${index}`}>
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>;
      }
      const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        return (
          <a
            className="gyro-response-link"
            href={link[2]}
            key={`${part}-${index}`}
          >
            {link[1]}
          </a>
        );
      }
      return <span key={`${part}-${index}`}>{part}</span>;
    });
}

function copyAssistantResponse(message: string) {
  void navigator.clipboard?.writeText(message).catch(() => undefined);
}

function stripHiddenSessionTitleMarker(message: string) {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  return lines
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith("GYRO_SESSION_TITLE:") &&
        !trimmed.startsWith("GYRO_ARTIFACTS:")
      );
    })
    .join("\n")
    .trim();
}

function isStreamingAssistantEvent(event: SessionEvent) {
  const payload = eventPayloadRecord(event);
  return (
    event.kind === "assistant-message" &&
    payload?.kind === "provider-stream" &&
    payload.streaming === true
  );
}

function providerStatusFromEvent(event: SessionEvent) {
  const payload = eventPayloadRecord(event);
  if (event.kind !== "system-event" || payload?.kind !== "provider-status") {
    return undefined;
  }
  const status = stringFromEventPayload(payload, "status") ?? "queued";
  return {
    error: stringFromEventPayload(payload, "error"),
    modelLabel: stringFromEventPayload(payload, "modelLabel"),
    providerId: stringFromEventPayload(payload, "providerId"),
    providerLabel:
      stringFromEventPayload(payload, "providerLabel") ?? "Provider",
    recoveryKind: stringFromEventPayload(payload, "recoveryKind"),
    recoveryMessage: stringFromEventPayload(payload, "recoveryMessage"),
    status,
    messagePreview:
      stringFromEventPayload(payload, "messagePreview") ??
      stringFromEventPayload(payload, "userMessage"),
  };
}

function providerActivityFromEvent(event: SessionEvent) {
  const payload = eventPayloadRecord(event);
  if (event.kind !== "system-event" || payload?.kind !== "provider-activity") {
    return undefined;
  }
  return {
    detail: stringFromEventPayload(payload, "detail"),
    kind: stringFromEventPayload(payload, "activityKind") ?? "tool",
    label: stringFromEventPayload(payload, "label") ?? event.message,
    status: stringFromEventPayload(payload, "status") ?? "done",
  };
}

function isHiddenSessionTitleActivity(event: SessionEvent) {
  const payload = eventPayloadRecord(event);
  return (
    event.kind === "system-event" &&
    payload?.kind === "provider-activity" &&
    stringFromEventPayload(payload, "activityKind") === "commentary" &&
    (stringFromEventPayload(payload, "label") ?? event.message).includes(
      "GYRO_SESSION_TITLE:",
    )
  );
}

function isHiddenTranscriptEvent(event: SessionEvent) {
  if (isHiddenSessionTitleActivity(event)) {
    return true;
  }
  if (event.kind === "user-message" || event.kind === "assistant-message") {
    return false;
  }
  if (
    event.kind === "plan-updated" ||
    event.kind === "goal-updated" ||
    event.kind === "chat-mode-changed" ||
    event.kind === "session-created"
  ) {
    return true;
  }
  if (providerStatusFromEvent(event)) {
    return false;
  }
  if (providerActivityFromEvent(event)) {
    return false;
  }
  const payload = eventPayloadRecord(event);
  const payloadKind = stringFromEventPayload(payload, "kind");
  const payloadSchema = stringFromEventPayload(payload, "schema");
  if (
    payloadKind === "mutation-approval" &&
    event.kind !== "approval-requested"
  ) {
    return true;
  }
  if (
    payloadKind === "provider-tool-approval" &&
    event.kind !== "approval-requested"
  ) {
    return true;
  }
  return (
    event.kind === "system-event" &&
    payloadSchema === "gyro.harness.v1" &&
    (payloadKind === "provider-diagnostics" || payloadKind === "provider-run")
  );
}

function mutationApprovalFromEvent(
  event: SessionEvent,
): MutationApproval | undefined {
  if (event.kind !== "approval-requested") {
    return undefined;
  }
  const payload = eventPayloadRecord(event);
  if (stringFromEventPayload(payload, "kind") !== "mutation-approval") {
    return undefined;
  }
  const proposalId = stringFromEventPayload(payload, "proposalId");
  const path = stringFromEventPayload(payload, "path");
  const operation = stringFromEventPayload(payload, "operation");
  const status = stringFromEventPayload(payload, "status");
  if (
    !proposalId ||
    !path ||
    (operation !== "create" && operation !== "update")
  ) {
    return undefined;
  }
  return {
    proposalId,
    operation,
    path,
    scope: stringFromEventPayload(payload, "scope") ?? "workspace-file",
    risk:
      stringFromEventPayload(payload, "risk") ??
      "Writes one file inside the selected project",
    effect:
      stringFromEventPayload(payload, "effect") ??
      `${operation === "create" ? "Create" : "Update"} this file on disk`,
    status:
      status === "applied" || status === "rejected" || status === "failed"
        ? status
        : "pending",
    error: stringFromEventPayload(payload, "error"),
  };
}

function providerApprovalFromEvent(
  event: SessionEvent,
): ProviderToolApproval | undefined {
  if (event.kind !== "approval-requested") return undefined;
  const payload = eventPayloadRecord(event);
  const payloadKind = stringFromEventPayload(payload, "kind");
  if (payloadKind === "capability-approval") {
    const approvalId = stringFromEventPayload(payload, "approvalId");
    const capabilityId = stringFromEventPayload(payload, "capabilityId");
    if (!approvalId || !capabilityId) return undefined;
    const scopeKind = stringFromEventPayload(payload, "scopeKind");
    const scopeValue = stringFromEventPayload(payload, "scopeValue");
    return {
      approvalId,
      approvalType: "capability",
      providerLabel:
        stringFromEventPayload(payload, "providerId") ?? "Model capability",
      capabilityId,
      scope: [scopeKind, scopeValue].filter(Boolean).join(" · "),
      reason: `The model requested ${capabilityId.replaceAll("-", " ")}.`,
      risk: "This capability is restricted to the owning Chat and project.",
      changes: [],
      status: "pending",
    };
  }
  if (payloadKind !== "provider-tool-approval") {
    return undefined;
  }
  const approvalId = stringFromEventPayload(payload, "approvalId");
  const approvalType = stringFromEventPayload(payload, "approvalType");
  if (
    !approvalId ||
    !["command", "file-change", "permissions"].includes(approvalType ?? "")
  ) {
    return undefined;
  }
  const status = stringFromEventPayload(payload, "status");
  const details = recordFromUnknown(payload?.details);
  const patch = recordFromUnknown(details?.patch);
  const changes = Array.isArray(patch?.changes)
    ? patch.changes.flatMap((item) => {
        const change = recordFromUnknown(item);
        const path = stringFromRecord(change, "path");
        return path ? [{ path, diff: stringFromRecord(change, "diff") }] : [];
      })
    : [];
  return {
    approvalId,
    approvalType: approvalType as ProviderToolApproval["approvalType"],
    providerLabel:
      stringFromEventPayload(payload, "providerLabel") ?? "Provider",
    command: stringFromEventPayload(payload, "command"),
    cwd: stringFromEventPayload(payload, "cwd"),
    reason: stringFromEventPayload(payload, "reason"),
    error: stringFromEventPayload(payload, "error"),
    risk:
      stringFromEventPayload(payload, "risk") ??
      "This action changes the selected project",
    changes,
    status:
      status === "approved" ||
      status === "applied" ||
      status === "rejected" ||
      status === "cancelled" ||
      status === "failed"
        ? status
        : "pending",
  };
}

function capabilityCallFromEvent(
  event: SessionEvent,
): CapabilityCallEvent | undefined {
  const payload = eventPayloadRecord(event);
  if (
    stringFromEventPayload(payload, "schema") !== "gyro.capability.v1" ||
    stringFromEventPayload(payload, "kind") !== "capability-call"
  ) {
    return undefined;
  }
  const callId = stringFromEventPayload(payload, "callId");
  const capabilityId = stringFromEventPayload(payload, "capabilityId");
  const status = stringFromEventPayload(payload, "status");
  const providerId = stringFromEventPayload(payload, "providerId");
  const summary = stringFromEventPayload(payload, "summary");
  const policyRevision = numberFromEventPayload(payload, "policyRevision");
  if (
    !callId ||
    !capabilityId ||
    !status ||
    !providerId ||
    !summary ||
    policyRevision === undefined
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
          kind: resourceKind as "workspace" | "ide" | "terminal" | "browser",
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
  };
}

function eventPayloadRecord(event: SessionEvent) {
  if (
    event.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
  ) {
    return event.payload as Record<string, unknown>;
  }
  return undefined;
}

function recordFromUnknown(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function stringFromEventPayload(
  payload: Record<string, unknown> | undefined,
  key: string,
) {
  const value = payload?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberFromEventPayload(
  payload: Record<string, unknown> | undefined,
  key: string,
) {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isInspectableEvent(event: SessionEvent) {
  return [
    "command-requested",
    "command-output",
    "file-edit-proposed",
    "approval-requested",
    "plan-updated",
    "system-event",
  ].includes(event.kind);
}

function toolDetailIcon(event: SessionEvent) {
  if (event.kind === "command-requested" || event.kind === "command-output") {
    return <Terminal size={15} />;
  }
  if (event.kind === "file-edit-proposed") {
    return <FileCode2 size={15} />;
  }
  if (event.kind === "approval-requested") {
    return <ShieldCheck size={15} />;
  }
  if (event.kind === "plan-updated") {
    return <ListChecks size={15} />;
  }
  return <CircleDashed size={15} />;
}

function toolDetailTitle(event: SessionEvent) {
  if (event.kind === "command-requested") {
    return "Command request";
  }
  if (event.kind === "command-output") {
    return "Command output";
  }
  if (event.kind === "file-edit-proposed") {
    return "Proposed file change";
  }
  if (event.kind === "approval-requested") {
    return "Approval request";
  }
  if (event.kind === "plan-updated") {
    return "Plan update";
  }
  return "System event";
}

function formatEventPayload(event: SessionEvent) {
  const payload = {
    message: event.message,
    payload: event.payload,
  };
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return event.message;
  }
}

function ToolDetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

type TerminalStatus = "restored" | "running" | "waiting" | "done" | "failed";

function TerminalPaneView({
  pane,
  draggedPaneId,
  isActive,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onMoveBackward,
  onMoveForward,
  onClose,
  onSelect,
  renderBody,
}: {
  title: string;
  command: string;
  output: string;
  status: TerminalStatus;
  workspaceMode: WorkbenchMode;
  branch: string;
  worktreeName?: string;
  draggedPaneId?: string;
  isActive?: boolean;
  onDragEnd?: () => void;
  onDragOver?: (event: ReactDragEvent<HTMLElement>) => void;
  onDragStart?: () => void;
  onDrop?: () => void;
  onMoveBackward?: () => void;
  onMoveForward?: () => void;
  onClose?: () => void;
  onSelect?: () => void;
  pane: TerminalPane;
  renderBody?: (pane: TerminalPane) => ReactNode;
}) {
  const {
    title,
    command,
    output,
    status,
    workspaceMode,
    branch,
    worktreeName,
  } = pane;
  const contextLabel =
    workspaceMode === "worktree" && worktreeName
      ? `${worktreeName} · ${branch}`
      : branch;
  const isDropTarget = Boolean(draggedPaneId && draggedPaneId !== pane.id);
  const className = [
    "gyro-terminal-pane",
    isActive ? "is-active" : "",
    isDropTarget ? "is-drop-target" : "",
    pane.attention ? `needs-${pane.attention}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const handleMoveKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      onMoveBackward?.();
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      onMoveForward?.();
    }
  };

  return (
    <section
      className={className}
      data-layout={pane.layout ?? "auto"}
      draggable
      data-dragging={draggedPaneId === pane.id ? "true" : undefined}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", pane.id);
        onDragStart?.();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop?.();
      }}
      onClick={onSelect}
    >
      <header>
        <button
          aria-label={`Move ${title}`}
          className="gyro-terminal-drag-handle"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleMoveKeyDown}
          title="Drag to move"
          type="button"
        >
          <GripVertical size={14} />
        </button>
        <div className="gyro-terminal-pane-title">
          <span className={`gyro-ring is-${pane.attention ?? status}`} />
          <strong>{title}</strong>
          <span>{pane.attention ?? status}</span>
        </div>
        <small>
          {pane.profileId} · {contextLabel || workspaceMode}
        </small>
        {onClose ? (
          <button
            aria-label={`Close ${title}`}
            className="gyro-terminal-pane-close"
            draggable={false}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            onDragStart={(event) => event.preventDefault()}
            title={`Close ${title}`}
            type="button"
          >
            <X size={13} />
          </button>
        ) : null}
      </header>
      <div className="gyro-terminal-live-body">
        {renderBody ? (
          renderBody(pane)
        ) : (
          <>
            <div className="gyro-command-block">
              <span>$</span>
              <code>{command}</code>
            </div>
            <pre>{output}</pre>
          </>
        )}
      </div>
    </section>
  );
}

function ContextMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "slate" | "amber";
}) {
  return (
    <div
      className={
        tone ? `gyro-context-metric is-${tone}` : "gyro-context-metric"
      }
    >
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function IdeRailTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: WorkbenchPaneTab;
  onTabChange: (tab: WorkbenchPaneTab) => void;
}) {
  const tabs: Array<{
    id: WorkbenchPaneTab | "agent" | "outline";
    label: string;
    icon: IconComponent;
  }> = [
    { id: "agent", label: "Agent", icon: Bot },
    { id: "diff", label: "Diff", icon: GitPullRequest },
    { id: "terminal", label: "Terminal", icon: Terminal },
    { id: "browser", label: "Browser", icon: Globe2 },
    { id: "outline", label: "Outline", icon: FileCode2 },
  ];

  return (
    <div className="gyro-pane-tabs" role="tablist" aria-label="Workspace rail">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = tab.id === activeTab;
        return (
          <button
            aria-selected={isActive}
            className={isActive ? "is-active" : ""}
            key={tab.id}
            onClick={() => {
              if (
                tab.id === "diff" ||
                tab.id === "terminal" ||
                tab.id === "browser"
              ) {
                onTabChange(tab.id);
              }
            }}
            role="tab"
            type="button"
          >
            <Icon size={15} />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function OnboardingSteps({
  onboarding,
  onSelectStep,
  onCompleteStep,
}: {
  onboarding?: OnboardingState;
  onSelectStep?: (step: OnboardingState["activeStep"]) => void;
  onCompleteStep?: (step: OnboardingState["activeStep"]) => void;
}) {
  const steps: Array<{
    id: OnboardingState["activeStep"];
    label: string;
  }> = [
    { id: "account", label: "Allow this device" },
    { id: "welcome", label: "Welcome to Gyro" },
    { id: "theme", label: "Choose theme" },
    { id: "workspace", label: "Open workspace" },
    { id: "provider", label: "Configure provider or CLI" },
    { id: "approval", label: "Confirm approval policy" },
    { id: "first-session", label: "Start first session" },
  ];

  return (
    <div className="gyro-onboarding-steps" aria-label="First run flow">
      {steps.map((step, index) => (
        <button
          className={[
            onboarding?.activeStep === step.id || (!onboarding && index === 0)
              ? "is-active"
              : "",
            onboarding?.completedSteps.includes(step.id) ? "is-complete" : "",
          ].join(" ")}
          key={step.id}
          onClick={() => {
            onSelectStep?.(step.id);
            if (onboarding?.activeStep === step.id) {
              onCompleteStep?.(step.id);
            }
          }}
          type="button"
        >
          <span>{index + 1}</span>
          <strong>{step.label}</strong>
        </button>
      ))}
    </div>
  );
}

function commandProfilesWithDefaults(
  profiles: CommandProfile[],
): CommandProfile[] {
  if (profiles.length > 0) {
    return profiles;
  }

  return [
    {
      id: "shell",
      displayName: "Shell",
      command: "zsh",
      args: ["-il"],
      workingDirectory: "Workspace",
    },
    {
      id: "codex",
      displayName: "Codex",
      command: "codex",
      args: ["--sandbox", "workspace-write"],
      workingDirectory: "Workspace",
    },
    {
      id: "claude",
      displayName: "Claude Code",
      command: "claude",
      args: ["--continue"],
      workingDirectory: "Workspace",
    },
    {
      id: "kimi-code",
      displayName: "Kimi Code",
      command: "kimi",
      args: [],
      workingDirectory: "Workspace",
      providerId: "kimi",
      defaultModel: "k3",
    },
    {
      id: "cursor",
      displayName: "Cursor Agent",
      command: "cursor-agent",
      args: ["run"],
      workingDirectory: "Workspace",
    },
    {
      id: "gemini",
      displayName: "Gemini CLI",
      command: "gemini",
      args: ["--yolo=false"],
      workingDirectory: "Workspace",
    },
    {
      id: "opencode",
      displayName: "OpenCode",
      command: "opencode",
      args: ["run"],
      workingDirectory: "Workspace",
    },
    {
      id: "custom",
      displayName: "Custom",
      command: "./agent.sh",
      args: [],
      workingDirectory: "Workspace",
    },
  ];
}

function defaultTerminalOutput(profileName?: string) {
  return `Gyro ${profileName ?? "Shell"}\n~/Documents/Gyro\n\n$ gyro doctor\n✓ workspace store ready\n✓ CLI attach socket ready\n✓ approvals required\n\n$ gyro run \"inspect this repo\"\nWorking locally. Command execution will require approval.`;
}

function workspaceName(path?: string) {
  if (!path) {
    return "No workspace";
  }
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function workspaceParentFolder(path?: string) {
  if (!path) return "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function isGeneratedGyroWorkspace(path?: string) {
  return Boolean(path && !isUserSelectedWorkspacePath(path));
}

function composerProjectLabel(path?: string) {
  if (!path || isGeneratedGyroWorkspace(path)) {
    return "Choose folder";
  }
  return workspaceName(path);
}

function projectSidebarName(path?: string) {
  const name = workspaceName(path);
  if (name === "No workspace" || /^gyro(?:-|$)/i.test(name)) {
    return "Gyro";
  }
  return name;
}

function parentSegments(path: string) {
  return path.split(/[\\/]/).filter(Boolean).slice(0, -1);
}

function workspaceAncestorPaths(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts
    .slice(0, -1)
    .map((_, index) => parts.slice(0, index + 1).join("/"));
}

function deviceLabel(device: BrowserPreviewDevice) {
  switch (device) {
    case "desktop":
      return "1440 x 900";
    case "tablet":
      return "834 x 1112";
    case "mobile":
      return "390 x 844";
  }
}

function relativeSessionTime(value: string) {
  const updated = new Date(value).getTime();
  if (Number.isNaN(updated)) {
    return "";
  }
  const minutes = Math.max(0, Math.round((Date.now() - updated) / 60_000));
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
