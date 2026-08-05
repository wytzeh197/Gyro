import {
  Activity,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Atom,
  Binary,
  Blocks,
  Braces,
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
  Database,
  Download,
  Edit3,
  FileArchive,
  FileCode2,
  FileText,
  FileType,
  Folder,
  Gauge,
  GitBranch,
  GitBranchPlus,
  GitPullRequest,
  Globe2,
  Goal,
  GripVertical,
  HardDrive,
  Hash,
  HelpCircle,
  Image as ImageIcon,
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
  Monitor,
  Palette,
  PanelBottom,
  PanelLeftClose,
  PanelRight,
  Paperclip,
  PauseCircle,
  Pin,
  Pause as PauseIcon,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  RotateCcw,
  ScrollText,
  Sparkles,
  Square,
  Sun,
  Tablet,
  Target,
  Terminal,
  TriangleAlert,
  Trash2,
  UserCircle,
  Users,
  Video,
  X,
  XCircle,
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
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import gyroLogoTransparentDark from "./assets/gyro-logo-transparent-dark.png";
import gyroLogoTransparentLight from "./assets/gyro-logo-transparent.png";
import { structuredCommentaryBlocks } from "./chat-commentary";
import { buildRunModel, elapsedMsBetween } from "./chat-run";
import { ChatRun } from "./chat-run-view";
import {
  ChatArtifacts,
  chatArtifactsFromEvent,
  type ChatArtifactActions,
} from "./chat-artifacts";
import { orderedChatTimelineEvents } from "./chat-timeline";
import {
  composerLimitWindows,
  estimateComposerContextUsage,
  type ComposerContextUsage,
  type ComposerLimitWindow,
} from "./context-usage";
import {
  estimateTurnCost,
  formatTokenCount,
  summarizeSessionCost,
  summarizeUsageSafety,
} from "./usage-ledger";
import {
  createGlobalSearchTarget,
  GlobalSearchRanker,
  normalizedGlobalSearchText,
  type GlobalSearchMatch,
  type GlobalSearchRange,
  type GlobalSearchTarget,
} from "./global-search";
import {
  workspaceCommandRegistry,
  workspacePanelContributions,
  workspaceViewContainers,
  type WorkspaceShellIcon,
} from "./workspace-shell";
import {
  workspaceSearchGlobs,
  workspaceSearchGlobText,
} from "./workspace-search";
import {
  workspaceModeDetail,
  workspaceModeLabel,
  workspaceModePopoverLabel,
  workspaceModeShortLabel,
  workspaceModeTechnicalHint,
} from "./workspace-mode";
import type {
  AppDestination,
  Automation,
  BrowserPreview,
  BrowserPreviewDevice,
  CapabilityActivity,
  CapabilityCallEvent,
  ChatAttachment,
  ChatGridArrangement,
  ChatPaneRef,
  ChatProjectLayout,
  ChatMode,
  CouncilActionRequest,
  CouncilResponsePayload,
  CouncilSeatSummary,
  CouncilSynthesis,
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
  IdeContribution,
  IdeState,
  IdeViewId,
  LanguageServerState,
  GitReviewActionId,
  GithubRunState,
  GithubState,
  IdeAssistantReply,
  GlobalSearchProject,
  GlobalSearchSelection,
  GitBranchCatalog,
  GyroConfig,
  ModelFocus,
  ModelFollowMode,
  ModelProviderConfig,
  Notification,
  NotificationPermissionState,
  OnboardingState,
  ProviderId,
  ProviderModel,
  ProviderLedgerSummary,
  ProviderUsageState,
  SessionUsageTotals,
  UsageSafetySnapshot,
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
  WorkspaceSearchQuery,
  WorkspaceKeybinding,
  WorkspaceScopedSettings,
  WorkspaceSettingScope,
} from "./types";
import {
  CLI_LAUNCH_PRESET_MAX_PANES,
  canSendChat,
  defaultCliLaunchPreset,
  defaultCommandProfiles,
  defaultProviderStatuses,
  isUserSelectedWorkspacePath,
  resolveChatGridDropSlot,
} from "./workbench-state";
import {
  preferredCleanMachineConnectProvider,
  resolveCleanMachinePath,
} from "./clean-machine-path";
import {
  defaultModelLabel,
  getProviderModel,
  isProviderExecutable,
  providerCapabilities,
  providerDefaultModelId,
  providerNeedsSignInRepair,
  providersForConfig,
  selectedModelLabel,
  selectedReasoningEffort,
} from "./provider-catalog";
import {
  councilPreflightLabel,
  COUNCIL_COMING_SOON,
  COUNCIL_COMING_SOON_LABEL,
  normalizedCouncilConfig,
  readyCouncilProviders,
  resolveCouncilSeatRequests,
} from "./council";

type BrowserScreenshotAction = "capture" | "reveal";
import {
  shouldShowSidebarUpdate,
  updateSidebarLabel,
  updateSizeLabel,
  updateVersionTag,
} from "./update-state";

type IconComponent = typeof MessageSquare;
const CommandIcon = Command;
const workspaceShellIcons: Record<WorkspaceShellIcon, IconComponent> = {
  ai: Sparkles,
  browser: Globe2,
  diff: GitPullRequest,
  explorer: FileText,
  output: FileText,
  problems: CircleDashed,
  "run-test": Play,
  search: Search,
  settings: Settings,
  "source-control": GitPullRequest,
  terminal: Terminal,
};
const CHAT_SESSION_DRAG_MIME = "application/x-gyro-chat-session";
const CHAT_PANE_DRAG_MIME = "application/x-gyro-chat-pane";
const TOOL_PANEL_DEFAULT_HEIGHT = 280;
/** Comfortable height when opening Browser so the iframe is usable. */
const TOOL_PANEL_BROWSER_HEIGHT = 420;
/** Focus mode target (~viewport share applied in App via ratio). */
const TOOL_PANEL_BROWSER_FOCUS_MIN = 480;
const TOOL_PANEL_MIN_HEIGHT = 140;
const TOOL_PANEL_COLLAPSE_HEIGHT = 96;
/** Leave room for editor chrome + status bar; still near full workspace. */
const TOOL_PANEL_MAX_VIEWPORT_RATIO = 0.92;
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

/**
 * Dismisses a popover, dropdown, or menu on the first pointer press that lands
 * outside it. The returned ref goes on the floating surface itself. Pass
 * `triggerRef` when the button that opens the surface sits outside that
 * subtree, so pressing the trigger toggles instead of dismiss-then-reopen.
 */
/**
 * Chat switcher glyph: two left-aligned rules, the upper one longer. Reads as
 * "a list of chats" without borrowing the hamburger's meaning.
 */
function ChatSwitcherIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 16 16"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="currentColor" height="1.8" rx="0.9" width="12" x="2" y="5" />
      <rect
        fill="currentColor"
        height="1.8"
        rx="0.9"
        width="7.5"
        x="2"
        y="9.2"
      />
    </svg>
  );
}

function useOutsidePointerDismiss<T extends HTMLElement>(
  isOpen: boolean,
  onDismiss: () => void,
  triggerRef?: RefObject<HTMLElement | null>,
) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const current = ref.current;
      if (!current) {
        return;
      }
      const path = event.composedPath();
      if (path.includes(current)) {
        return;
      }
      const trigger = triggerRef?.current;
      if (trigger && path.includes(trigger)) {
        return;
      }
      onDismiss();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isOpen, onDismiss, triggerRef]);

  return ref;
}

type AppChromeProps = {
  sessions: Session[];
  commandProfiles: CommandProfile[];
  savedProjects: Array<{ path: string; label: string }>;
  activeSessionId?: string;
  sendingSessionIds?: string[];
  /** Sessions that own a live model terminal (power-relevant even when idle). */
  modelTerminalSessionIds?: string[];
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
  workspaceSidebarHidden?: boolean;
  workspaceSidebarWidth?: number;
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
  /** Backend warm-up still running — show minimal status, keep core chrome usable. */
  isShellOptimizing?: boolean;
  onOpenCommandPalette: () => void;
  onCreateSession: () => void;
  onCreateMission?: () => void;
  onCreateCliSession: (
    profileId: string,
    workspacePath: string,
    options?: { missionSessionId?: string; taskTitle?: string },
  ) => void;
  onSelectSessions: () => void;
  onOpenWorkspace: () => void;
  onAddWorkspaceFolder?: () => void;
  onRemoveWorkspaceFolder?: (path: string) => void;
  onSelectWorkspaceFolder?: (path: string) => void;
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
  onRunWorkspaceSearch?: (query: WorkspaceSearchQuery) => void;
  onApplyWorkspaceReplace?: (
    query: WorkspaceSearchQuery,
    replacement: string,
    paths: string[],
  ) => void | Promise<void>;
  onRefreshSourceControl?: () => void;
  onToggleSourceControlFile?: (
    path: string,
    staged: boolean,
  ) => void | Promise<void>;
  onStageAllSourceControl?: () => void | Promise<void>;
  onDiscardSourceControlFile?: (path: string) => void | Promise<void>;
  onOpenSourceControlDiff?: (path: string, staged: boolean) => void;
  onCommitSourceControl?: (message: string) => void;
  branchCatalog?: GitBranchCatalog;
  isBranchLoading?: boolean;
  onSelectWorkspaceBranch?: (branch: string) => void;
  onCreateWorkspaceBranch?: (startPoint?: string) => void;
  onRefreshGithub?: () => void | Promise<void>;
  onSelectGithubRun?: (runId: number) => void | Promise<void>;
  onViewGithubRunLogs?: (runId: number) => void | Promise<void>;
  onRerunGithubRun?: (
    runId: number,
    failedOnly: boolean,
  ) => void | Promise<void>;
  onOpenGithubUrl?: (url: string) => void | Promise<void>;
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
  settingsBackLabel?: string;
  onUpdateAction?: (state: UpdateState) => void;
  onWorkspaceSidebarHiddenChange?: (hidden: boolean) => void;
  onWorkspaceSidebarWidthChange?: (width?: number) => void;
  onRetryWorkspacePreparation?: () => void;
  /**
   * The AI view is the workspace's chat: the sidebar renders the same
   * ChatSurface the Sessions destination does, at sidebar width.
   */
  renderAiChat?: () => ReactNode;
  children: ReactNode;
};

const paneTabs: Array<{
  id: WorkbenchPaneTab;
  label: string;
  icon: IconComponent;
}> = workspacePanelContributions.map((panel) => ({
  id: panel.id,
  label: panel.label,
  icon: workspaceShellIcons[panel.icon],
}));

const settingsSidebarItems: Array<{
  id: SettingsSectionId;
  label: string;
  icon: IconComponent;
  group: "Preferences" | "AI & Agents" | "Workspace" | "System";
}> = [
  {
    id: "general",
    label: "General",
    icon: SlidersHorizontal,
    group: "Preferences",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    group: "Preferences",
  },
  {
    id: "keyboard",
    label: "Keyboard",
    icon: CommandIcon,
    group: "Preferences",
  },
  {
    id: "usage-limits",
    label: "Usage Limits",
    icon: Gauge,
    group: "AI & Agents",
  },
  {
    id: "providers",
    label: "Providers",
    icon: KeyRound,
    group: "AI & Agents",
  },
  {
    id: "cli-profiles",
    label: "CLI Profiles",
    icon: Terminal,
    group: "AI & Agents",
  },
  {
    id: "permissions",
    label: "Permissions",
    icon: LockKeyhole,
    group: "AI & Agents",
  },
  {
    id: "editor-workspace",
    label: "Editor & Search",
    icon: FileText,
    group: "Workspace",
  },
  {
    id: "tools-contributions",
    label: "Tools & Contributions",
    icon: Blocks,
    group: "Workspace",
  },
  { id: "updates", label: "Updates", icon: RefreshCw, group: "System" },
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
    section: "editor-workspace",
    label: "Editor & Search",
    detail: "Editor, Explorer, and search behavior by workspace scope",
    keywords: "workspace folder minimap exclude maximum results",
  },
  {
    section: "tools-contributions",
    label: "Tools & Contributions",
    detail: "Language servers, workspace commands, and local contributions",
    keywords: "extensions manifests keybindings lsp",
  },
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
    label: "Model Council",
    detail: "Parallel multi-provider synthesis — coming soon",
    keywords: "council multi model ensemble synthesize preset coming soon",
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

/**
 * Pending work on a view container, shown as a count on its rail icon.
 * `description` carries the phrasing for assistive tech ("12 changes").
 */
type ActivityRailBadge = { count: number; description: string };

/** VS Code caps its activity bar badges at 99; anything more reads "99+". */
function activityBadgeLabel(count: number) {
  return count > 99 ? "99+" : String(count);
}

/**
 * Badge the Source Control icon with the number of change rows, counting the
 * staged and unstaged sides separately exactly as the panel lists them.
 */
function sourceControlRailBadge(
  sourceControl?: SourceControlState,
): Partial<Record<IdeViewId, ActivityRailBadge>> | undefined {
  const count = sourceControl?.available ? sourceControl.files.length : 0;
  if (count === 0) {
    return undefined;
  }
  return {
    "source-control": {
      count,
      description: `${count} change${count === 1 ? "" : "s"}`,
    },
  };
}

function WorkspaceActivityRail({
  activeView,
  badges,
  hasWorkspace,
  isVisible,
  isSidebarHidden,
  isSidebarCollapsible = true,
  onOpenSettings,
  onSelectView,
  onToggleSidebar,
}: {
  activeView: IdeViewId;
  badges?: Partial<Record<IdeViewId, ActivityRailBadge>>;
  hasWorkspace: boolean;
  isVisible: boolean;
  isSidebarHidden: boolean;
  /** When false, re-clicking the active view does not hide the sidebar. */
  isSidebarCollapsible?: boolean;
  onOpenSettings?: () => void;
  onSelectView?: (view: IdeViewId) => void;
  onToggleSidebar: () => void;
}) {
  const renderView = (view: (typeof workspaceViewContainers)[number]) => {
    const Icon = workspaceShellIcons[view.icon];
    const isActive = activeView === view.id;
    const isDisabled = view.requiresWorkspace && !hasWorkspace;
    const badge = badges?.[view.id];
    const badgeCount = isDisabled ? 0 : (badge?.count ?? 0);
    const badgeDescription = badgeCount === 0 ? undefined : badge?.description;
    const railLabel = badgeDescription
      ? `${view.label}, ${badgeDescription}`
      : view.label;
    const railTitle = isDisabled
      ? `Open a project to use ${view.label}`
      : badgeDescription
        ? `${view.label} — ${badgeDescription}`
        : view.label;
    return (
      <button
        aria-label={railLabel}
        aria-pressed={isActive && !isSidebarHidden}
        className={isActive ? "is-active" : ""}
        disabled={isDisabled}
        key={view.id}
        onClick={() => {
          if (view.id === "settings") {
            onOpenSettings?.();
            return;
          }
          if (isActive && !isSidebarHidden) {
            if (isSidebarCollapsible) {
              onToggleSidebar();
            }
            return;
          }
          if (isSidebarHidden && isSidebarCollapsible) {
            onToggleSidebar();
          }
          onSelectView?.(view.id);
        }}
        title={railTitle}
        tabIndex={isVisible ? undefined : -1}
        type="button"
      >
        <Icon size={18} />
        {badgeCount > 0 ? (
          <span aria-hidden="true" className="gyro-activity-rail-badge">
            {activityBadgeLabel(badgeCount)}
          </span>
        ) : null}
      </button>
    );
  };
  const primaryViews = workspaceViewContainers.filter(
    (view) => view.placement === "primary",
  );
  const secondaryViews = workspaceViewContainers.filter(
    (view) => view.placement === "secondary",
  );

  return (
    <nav
      aria-hidden={!isVisible}
      aria-label={isVisible ? "Workspace views" : undefined}
      className="gyro-workspace-activity-rail"
      data-visible={isVisible}
    >
      <div aria-hidden="true" className="gyro-workspace-activity-rail-drag" />
      <div className="gyro-workspace-activity-rail-group">
        {primaryViews.map(renderView)}
      </div>
      <div className="gyro-workspace-activity-rail-group is-secondary">
        {secondaryViews.map(renderView)}
      </div>
    </nav>
  );
}

export function AppChrome({
  sessions,
  commandProfiles,
  savedProjects,
  activeSessionId,
  sendingSessionIds = [],
  modelTerminalSessionIds = [],
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
  workspaceSidebarHidden,
  workspaceSidebarWidth,
  onSelectSession,
  onAddSessionToGrid,
  onSelectWorkspaceLayout,
  onSelectDestination,
  onOpenToolPanel,
  onDeleteSession,
  onDismissNotification,
  onOpenSettings,
  onOpenSettingsSection,
  isShellOptimizing = false,
  onOpenCommandPalette,
  onCreateSession,
  onCreateMission,
  onCreateCliSession,
  onSelectSessions,
  onOpenWorkspace,
  onAddWorkspaceFolder,
  onRemoveWorkspaceFolder,
  onSelectWorkspaceFolder,
  onOpenWorkspaceFile,
  onPinEditorTab,
  onRefreshWorkspace,
  onCreateWorkspacePath,
  onRenameWorkspacePath,
  onDeleteWorkspacePath,
  onSelectIdeView,
  onRunWorkspaceSearch,
  onApplyWorkspaceReplace,
  onRefreshSourceControl,
  onToggleSourceControlFile,
  onStageAllSourceControl,
  onDiscardSourceControlFile,
  onOpenSourceControlDiff,
  onCommitSourceControl,
  branchCatalog,
  isBranchLoading = false,
  onSelectWorkspaceBranch,
  onCreateWorkspaceBranch,
  onRefreshGithub,
  onSelectGithubRun,
  onViewGithubRunLogs,
  onRerunGithubRun,
  onOpenGithubUrl,
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
  settingsBackLabel = "Workspace",
  onUpdateAction,
  onWorkspaceSidebarHiddenChange,
  onWorkspaceSidebarWidthChange,
  workspacePreparation,
  onRetryWorkspacePreparation,
  renderAiChat,
  children,
}: AppChromeProps) {
  const isIdeSurface =
    activeDestination === "workspace" && activeWorkspaceLayout === "code";
  const [localSidebarHidden, setLocalSidebarHidden] = useState(false);
  // Workspace (code) always keeps the sidebar. Hide/show only exists on
  // Sessions and other non-IDE shells — the restore control never landed
  // cleanly under the traffic lights in Workspace.
  const isSidebarHidden = isIdeSurface ? false : localSidebarHidden;
  const setIsSidebarHidden = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      if (isIdeSurface) {
        // Ignore hide attempts while Workspace code is active.
        setLocalSidebarHidden(false);
        onWorkspaceSidebarHiddenChange?.(false);
        return;
      }
      const resolved =
        typeof next === "function" ? next(isSidebarHidden) : next;
      setLocalSidebarHidden(resolved);
    },
    [isIdeSurface, isSidebarHidden, onWorkspaceSidebarHiddenChange],
  );

  useEffect(() => {
    if (!isIdeSurface) {
      return;
    }
    // Entering Workspace with a leftover hidden preference would leave the
    // shell with no explorer — force visible.
    setLocalSidebarHidden(false);
    if (workspaceSidebarHidden) {
      onWorkspaceSidebarHiddenChange?.(false);
    }
  }, [isIdeSurface, onWorkspaceSidebarHiddenChange, workspaceSidebarHidden]);
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
  const [ideSidebarWidth, setIdeSidebarWidth] = useState(
    () => workspaceSidebarWidth ?? restingSidebarWidth(),
  );
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
  const ideSidebarMaximumWidth = ideSidebarMinimumWidth * 2;
  /**
   * The AI view holds a full chat, which needs more room than a file tree.
   * Widen for it unless the user has already dragged the sidebar wider.
   */
  const AI_VIEW_SIDEBAR_WIDTH = 360;
  const effectiveIdeSidebarWidth =
    ide?.activeView === "ai"
      ? Math.min(
          Math.max(ideSidebarWidth, AI_VIEW_SIDEBAR_WIDTH),
          Math.max(ideSidebarMaximumWidth, AI_VIEW_SIDEBAR_WIDTH),
        )
      : ideSidebarWidth;
  const showSidebarUpdate = updateState
    ? shouldShowSidebarUpdate(updateState)
    : false;

  useEffect(() => {
    if (isIdeSurface) {
      return;
    }
    const shell = appShellRef.current;
    const rail = shell?.querySelector<HTMLElement>(
      ".gyro-workspace-activity-rail",
    );
    if (!rail?.contains(document.activeElement)) {
      return;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      const focusTarget =
        shell?.querySelector<HTMLButtonElement>(
          '[data-sidebar-mode="sessions"]',
        ) ?? shell?.querySelector<HTMLElement>(".gyro-main");
      focusTarget?.focus();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [isIdeSurface]);

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
    const restingWidth = restingSidebarWidth();
    const maximumWidth = restingWidth * 2;
    const requestedWidth = isIdeSurface
      ? (workspaceSidebarWidth ?? restingWidth)
      : restingWidth;
    const nextWidth = Math.min(
      maximumWidth,
      Math.max(restingWidth, requestedWidth),
    );
    const resize = ideSidebarResizeRef.current;
    if (resize?.animationFrame !== undefined) {
      cancelAnimationFrame(resize.animationFrame);
    }
    ideSidebarResizeRef.current = undefined;
    appShellRef.current?.style.setProperty(
      "--gyro-ide-sidebar-width",
      `${nextWidth}px`,
    );
    setIsIdeSidebarResizing(false);
    setIsIdeSidebarCustomized(nextWidth !== restingWidth);
    setIdeSidebarMinimumWidth(restingWidth);
    setIdeSidebarWidth(nextWidth);
  }, [isIdeSurface, workspaceSidebarWidth]);

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
      onWorkspaceSidebarWidthChange?.(
        finalWidth === ideSidebarMinimumWidth ? undefined : finalWidth,
      );
    },
    [ideSidebarMinimumWidth, onWorkspaceSidebarWidthChange],
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
      onWorkspaceSidebarWidthChange?.(
        clampedWidth === ideSidebarMinimumWidth ? undefined : clampedWidth,
      );
    },
    [
      clampIdeSidebarWidth,
      ideSidebarMaximumWidth,
      ideSidebarMinimumWidth,
      ideSidebarWidth,
      onWorkspaceSidebarWidthChange,
    ],
  );

  return (
    <div
      className={`gyro-app-shell is-chat-shell is-workspace-shell ${
        activeDestination === "workspace" && activeWorkspaceLayout === "thread"
          ? "is-thread-layout"
          : ""
      } ${isIdeSurface ? "is-workspace-chrome-active" : ""} ${
        isSidebarHidden ? "is-sidebar-hidden" : ""
      } ${isIdeSidebarResizing ? "is-ide-sidebar-resizing" : ""}`}
      data-workspace-activity-rail={isIdeSurface ? "visible" : "hidden"}
      style={
        {
          "--gyro-ide-sidebar-width": `${effectiveIdeSidebarWidth}px`,
        } as CSSProperties
      }
      ref={appShellRef}
    >
      <WorkspaceActivityRail
        activeView={ide?.activeView ?? "explorer"}
        badges={sourceControlRailBadge(ide?.sourceControl)}
        hasWorkspace={Boolean(workspacePath)}
        isSidebarCollapsible={false}
        isSidebarHidden={false}
        isVisible={isIdeSurface}
        onOpenSettings={() => {
          if (onOpenSettingsSection) {
            onOpenSettingsSection("editor-workspace");
            return;
          }
          onOpenSettings();
        }}
        onSelectView={onSelectIdeView}
        onToggleSidebar={() => undefined}
      />
      {isSidebarHidden ? (
        <div className="gyro-sidebar-restore-cluster">
          <button
            aria-label="Show sidebar"
            className="gyro-sidebar-restore-button"
            onClick={() => setIsSidebarHidden(false)}
            title="Show sidebar"
            type="button"
          >
            <LayoutPanelLeft size={14} />
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
              backLabel={settingsBackLabel}
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
              renderAiChat={renderAiChat}
              activeDestination={activeDestination}
              activePaneTab={activePaneTab}
              activeSession={activeSession}
              activeSessionId={activeSessionId}
              sendingSessionIds={sendingSessionIds}
              modelTerminalSessionIds={modelTerminalSessionIds}
              activeWorkspaceLayout={activeWorkspaceLayout}
              commandProfiles={commandProfiles}
              files={files}
              canHideSidebar={!isIdeSurface}
              ide={ide}
              isChatsCollapsed={isChatsCollapsed}
              onAddTerminalPane={onAddTerminalPane}
              onCloseTerminalPane={onCloseTerminalPane}
              onCreateSession={onCreateSession}
              onCreateMission={onCreateMission}
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
              onAddWorkspaceFolder={onAddWorkspaceFolder}
              onRemoveWorkspaceFolder={onRemoveWorkspaceFolder}
              onSelectWorkspaceFolder={onSelectWorkspaceFolder}
              onPinSession={onPinSession}
              onRenameSession={onRenameSession}
              onRemoveProject={onRemoveProject}
              onRefreshSourceControl={onRefreshSourceControl}
              onOpenSourceControlDiff={onOpenSourceControlDiff}
              onCommitSourceControl={onCommitSourceControl}
              branchCatalog={branchCatalog}
              isBranchLoading={isBranchLoading}
              onSelectWorkspaceBranch={onSelectWorkspaceBranch}
              onCreateWorkspaceBranch={onCreateWorkspaceBranch}
              onStageAllSourceControl={onStageAllSourceControl}
              onRefreshGithub={onRefreshGithub}
              onSelectGithubRun={onSelectGithubRun}
              onViewGithubRunLogs={onViewGithubRunLogs}
              onRerunGithubRun={onRerunGithubRun}
              onOpenGithubUrl={onOpenGithubUrl}
              onRunIdeTask={onRunIdeTask}
              onStartDebugSession={onStartDebugSession}
              onSendDebugCommand={onSendDebugCommand}
              onStopDebugSession={onStopDebugSession}
              onRunWorkspaceSearch={onRunWorkspaceSearch}
              onApplyWorkspaceReplace={onApplyWorkspaceReplace}
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

          {activeDestination !== "settings" && !isIdeSurface ? (
            <div className="gyro-sidebar-footer">
              <div className="gyro-sidebar-footer-row">
                <button
                  className="gyro-account-button"
                  disabled={isShellOptimizing}
                  onClick={() => {
                    if (isShellOptimizing) {
                      return;
                    }
                    if (onOpenSettingsSection) {
                      onOpenSettingsSection("general");
                      return;
                    }
                    onOpenSettings();
                  }}
                  title={
                    isShellOptimizing
                      ? "Settings unlock when optimization finishes"
                      : "Settings"
                  }
                  type="button"
                >
                  <Settings size={16} />
                  <span className="gyro-account-name">
                    <strong>Settings</strong>
                  </span>
                </button>
                {isShellOptimizing ? (
                  <span
                    className="gyro-shell-optimizing"
                    role="status"
                    aria-live="polite"
                    title="Warming local storage and providers"
                  >
                    <span
                      className="gyro-shell-optimizing-spinner"
                      aria-hidden="true"
                    />
                    <em>Optimizing Gyro</em>
                  </span>
                ) : (
                  <span
                    className="gyro-shell-optimizing is-spacer"
                    aria-hidden="true"
                  />
                )}
              </div>
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
                onWorkspaceSidebarWidthChange?.(undefined);
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
      <main className="gyro-main" tabIndex={-1}>
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

/** Roughly the tooltip's own height — enough to pick a side before it paints. */
const UPDATE_TIP_CLEARANCE = 76;

function SidebarUpdateControl({
  state,
  onAction,
}: {
  state: UpdateState;
  onAction?: (state: UpdateState) => void;
}) {
  const [placement, setPlacement] = useState<"above" | "below">("below");
  const controlRef = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const isBusy = state.status === "downloading" || state.status === "installing";
  const label = updateSidebarLabel(state);
  const tag = updateVersionTag(state);
  const size = updateSizeLabel(state);

  /* The button lives in the titlebar, so the tip drops down unless the window
     is too short for it to land on screen. */
  const measurePlacement = useCallback(() => {
    const rect = controlRef.current?.getBoundingClientRect();
    if (!rect) return;
    const roomBelow = window.innerHeight - rect.bottom;
    setPlacement(
      roomBelow < UPDATE_TIP_CLEARANCE && rect.top > UPDATE_TIP_CLEARANCE
        ? "above"
        : "below",
    );
  }, []);

  return (
    <div
      className="gyro-sidebar-update is-windowbar"
      data-tip-placement={placement}
      onFocus={measurePlacement}
      onPointerEnter={measurePlacement}
      ref={controlRef}
    >
      <button
        aria-busy={isBusy}
        aria-describedby={tipId}
        aria-label={label}
        className="gyro-sidebar-update-button"
        data-status={state.status}
        disabled={isBusy}
        onClick={() => onAction?.(state)}
        type="button"
      >
        {state.status === "downloading" ? (
          <span className="gyro-sidebar-update-percent">
            {state.progressPercent ?? 0}%
          </span>
        ) : state.status === "ready" || state.status === "installing" ? (
          <RefreshCw
            className={state.status === "installing" ? "is-spinning" : ""}
            size={11}
          />
        ) : (
          <Download size={11} />
        )}
      </button>
      <div className="gyro-sidebar-update-tip" id={tipId} role="tooltip">
        <strong>{tag ?? label}</strong>
        <span>{size}</span>
      </div>
    </div>
  );
}

function SettingsSidebarContent({
  activeSection,
  backLabel,
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
  backLabel: string;
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
              aria-label={`Back to ${backLabel}`}
              className="gyro-settings-back-button has-label"
              onClick={onBack}
              title={`Back to ${backLabel}`}
              type="button"
            >
              <ArrowLeft size={13} />
              <span>{backLabel}</span>
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
          <div
            aria-hidden="true"
            className="gyro-sidebar-titlebar-drag-region"
            data-tauri-drag-region
          />
        </div>
      </div>

      <div className="gyro-sidebar-actions is-settings-pages">
        {(["Preferences", "AI & Agents", "Workspace", "System"] as const).map(
          (group) => {
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
          },
        )}
      </div>
    </>
  );
}

type ScmFileBadge = { icon: IconComponent; tone: string };

/**
 * Language badge for a file row: the icon and the colour tone shared by the
 * Explorer and Source Control, so a file reads by colour first and by name
 * second — the way VS Code's views do — and looks the same in both.
 */
const SCM_BADGE_REACT: ScmFileBadge = { icon: Atom, tone: "react" };
const SCM_BADGE_BINARY: ScmFileBadge = { icon: Binary, tone: "binary" };
const SCM_BADGE_JSON: ScmFileBadge = { icon: Braces, tone: "json" };
const SCM_BADGE_STYLESHEET: ScmFileBadge = { icon: Hash, tone: "css" };
const SCM_BADGE_CONFIG: ScmFileBadge = { icon: Settings, tone: "config" };
const SCM_BADGE_TEXT: ScmFileBadge = { icon: FileText, tone: "default" };
const SCM_BADGE_MEDIA: ScmFileBadge = { icon: Video, tone: "media" };
const SCM_BADGE_LOG: ScmFileBadge = { icon: ScrollText, tone: "default" };

const SCM_BADGE_BY_EXTENSION: Record<string, ScmFileBadge> = {
  tsx: SCM_BADGE_REACT,
  jsx: SCM_BADGE_REACT,
  ts: { icon: FileCode2, tone: "typescript" },
  mts: { icon: FileCode2, tone: "typescript" },
  cts: { icon: FileCode2, tone: "typescript" },
  js: { icon: FileCode2, tone: "javascript" },
  mjs: { icon: FileCode2, tone: "javascript" },
  cjs: { icon: FileCode2, tone: "javascript" },
  json: SCM_BADGE_JSON,
  jsonc: SCM_BADGE_JSON,
  css: SCM_BADGE_STYLESHEET,
  scss: SCM_BADGE_STYLESHEET,
  sass: SCM_BADGE_STYLESHEET,
  less: SCM_BADGE_STYLESHEET,
  html: { icon: FileCode2, tone: "html" },
  htm: { icon: FileCode2, tone: "html" },
  vue: { icon: FileCode2, tone: "vue" },
  svelte: { icon: FileCode2, tone: "html" },
  md: { icon: FileText, tone: "markdown" },
  mdx: { icon: FileText, tone: "markdown" },
  txt: SCM_BADGE_TEXT,
  pdf: SCM_BADGE_TEXT,
  log: SCM_BADGE_LOG,
  rs: { icon: FileCode2, tone: "rust" },
  go: { icon: FileCode2, tone: "go" },
  py: { icon: FileCode2, tone: "python" },
  pyi: { icon: FileCode2, tone: "python" },
  rb: { icon: FileCode2, tone: "ruby" },
  swift: { icon: FileCode2, tone: "swift" },
  java: { icon: FileCode2, tone: "java" },
  kt: { icon: FileCode2, tone: "java" },
  kts: { icon: FileCode2, tone: "java" },
  scala: { icon: FileCode2, tone: "java" },
  c: { icon: FileCode2, tone: "cpp" },
  h: { icon: FileCode2, tone: "cpp" },
  cpp: { icon: FileCode2, tone: "cpp" },
  cc: { icon: FileCode2, tone: "cpp" },
  hpp: { icon: FileCode2, tone: "cpp" },
  cs: { icon: FileCode2, tone: "cpp" },
  php: { icon: FileCode2, tone: "php" },
  lua: { icon: FileCode2, tone: "lua" },
  dart: { icon: FileCode2, tone: "dart" },
  ex: { icon: FileCode2, tone: "elixir" },
  exs: { icon: FileCode2, tone: "elixir" },
  graphql: { icon: FileCode2, tone: "graphql" },
  gql: { icon: FileCode2, tone: "graphql" },
  prisma: { icon: Database, tone: "data" },
  patch: { icon: FileCode2, tone: "diff" },
  diff: { icon: FileCode2, tone: "diff" },
  xml: { icon: FileCode2, tone: "html" },
  plist: { icon: FileCode2, tone: "html" },
  toml: SCM_BADGE_CONFIG,
  yaml: SCM_BADGE_CONFIG,
  yml: SCM_BADGE_CONFIG,
  ini: SCM_BADGE_CONFIG,
  conf: SCM_BADGE_CONFIG,
  env: SCM_BADGE_CONFIG,
  tf: SCM_BADGE_CONFIG,
  nix: SCM_BADGE_CONFIG,
  sh: { icon: Terminal, tone: "shell" },
  bash: { icon: Terminal, tone: "shell" },
  zsh: { icon: Terminal, tone: "shell" },
  fish: { icon: Terminal, tone: "shell" },
  ps1: { icon: Terminal, tone: "shell" },
  bat: { icon: Terminal, tone: "shell" },
  cmd: { icon: Terminal, tone: "shell" },
  png: { icon: ImageIcon, tone: "image" },
  jpg: { icon: ImageIcon, tone: "image" },
  jpeg: { icon: ImageIcon, tone: "image" },
  gif: { icon: ImageIcon, tone: "image" },
  webp: { icon: ImageIcon, tone: "image" },
  avif: { icon: ImageIcon, tone: "image" },
  svg: { icon: ImageIcon, tone: "image" },
  ico: { icon: ImageIcon, tone: "image" },
  icns: { icon: ImageIcon, tone: "image" },
  woff: { icon: FileType, tone: "font" },
  woff2: { icon: FileType, tone: "font" },
  ttf: { icon: FileType, tone: "font" },
  otf: { icon: FileType, tone: "font" },
  zip: { icon: FileArchive, tone: "archive" },
  gz: { icon: FileArchive, tone: "archive" },
  tgz: { icon: FileArchive, tone: "archive" },
  tar: { icon: FileArchive, tone: "archive" },
  dmg: { icon: FileArchive, tone: "archive" },
  sql: { icon: Database, tone: "data" },
  db: { icon: Database, tone: "data" },
  sqlite: { icon: Database, tone: "data" },
  csv: { icon: Database, tone: "data" },
  tsv: { icon: Database, tone: "data" },
  mp4: SCM_BADGE_MEDIA,
  mov: SCM_BADGE_MEDIA,
  webm: SCM_BADGE_MEDIA,
  mp3: SCM_BADGE_MEDIA,
  wav: SCM_BADGE_MEDIA,
  bin: SCM_BADGE_BINARY,
  wasm: SCM_BADGE_BINARY,
  exe: SCM_BADGE_BINARY,
  so: SCM_BADGE_BINARY,
  dylib: SCM_BADGE_BINARY,
};

/** Files whose whole name carries the type, so the extension never fires. */
const SCM_BADGE_BY_NAME: Record<string, ScmFileBadge> = {
  dockerfile: SCM_BADGE_CONFIG,
  makefile: SCM_BADGE_CONFIG,
  procfile: SCM_BADGE_CONFIG,
  rakefile: { icon: FileCode2, tone: "ruby" },
  gemfile: { icon: FileCode2, tone: "ruby" },
  license: SCM_BADGE_TEXT,
  notice: SCM_BADGE_TEXT,
  readme: { icon: FileText, tone: "markdown" },
};

function scmFileBadge(path: string): ScmFileBadge {
  const name = path.split("/").filter(Boolean).at(-1)?.toLowerCase() ?? "";
  if (
    name.endsWith(".lock") ||
    name.endsWith("-lock.json") ||
    name.endsWith("-lock.yaml")
  ) {
    return { icon: LockKeyhole, tone: "lock" };
  }
  const named = SCM_BADGE_BY_NAME[name];
  if (named) return named;
  // Dotfiles are configuration by convention — .gitignore, .npmrc, .env.local —
  // and their trailing segment is rarely a type worth reading as one.
  if (name.startsWith(".env")) return SCM_BADGE_CONFIG;
  if (name.startsWith(".") && !name.slice(1).includes(".")) {
    return SCM_BADGE_CONFIG;
  }
  const extension = name.includes(".") ? (name.split(".").at(-1) ?? "") : "";
  return SCM_BADGE_BY_EXTENSION[extension] ?? SCM_BADGE_TEXT;
}

/**
 * Letter and colour tone per resource state, mirroring VS Code's git
 * decorations: M amber, A/U/R mint, D and conflicts red.
 */
const SCM_STATE_DECORATIONS: Record<
  SourceControlFile["state"],
  { letter: string; tone: string; label: string }
> = {
  modified: { letter: "M", tone: "modified", label: "Modified" },
  added: { letter: "A", tone: "added", label: "Added" },
  deleted: { letter: "D", tone: "deleted", label: "Deleted" },
  renamed: { letter: "R", tone: "renamed", label: "Renamed" },
  untracked: { letter: "U", tone: "untracked", label: "Untracked" },
  conflicted: { letter: "C", tone: "conflicted", label: "Conflict" },
  staged: { letter: "S", tone: "staged", label: "Staged" },
};

function scmStateDecoration(state: SourceControlFile["state"]) {
  return SCM_STATE_DECORATIONS[state] ?? SCM_STATE_DECORATIONS.modified;
}

/** Cap per group so a huge working tree cannot stall the sidebar. */
const SCM_GROUP_LIMIT = 60;

/**
 * One VS Code-style change group — "Staged Changes" or "Changes" — with a
 * collapsible header, a count, group actions, and colour-coded rows.
 */
function ScmChangeGroup({
  actions,
  className,
  collapsed,
  emptyCopy,
  files,
  onDiscardFile,
  onOpenDiff,
  onToggleCollapsed,
  onToggleSelected,
  onToggleStage,
  selectedPaths,
  title,
}: {
  actions?: ReactNode;
  className?: string;
  collapsed: boolean;
  emptyCopy?: string;
  files: SourceControlFile[];
  onDiscardFile?: (path: string) => void | Promise<void>;
  onOpenDiff?: (path: string, staged: boolean) => void;
  onToggleCollapsed: () => void;
  onToggleSelected: (path: string) => void;
  onToggleStage?: (path: string, staged: boolean) => void | Promise<void>;
  selectedPaths: Set<string>;
  title: string;
}) {
  const visible = files.slice(0, SCM_GROUP_LIMIT);
  const hidden = files.length - visible.length;
  return (
    <>
      <div
        className={
          className
            ? `gyro-sidebar-scm-group-label ${className}`
            : "gyro-sidebar-scm-group-label"
        }
      >
        <button
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          className="gyro-sidebar-scm-group-toggle"
          onClick={onToggleCollapsed}
          type="button"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <span className="gyro-scm-label-text">{title}</span>
        <small className="gyro-sidebar-scm-count">{files.length}</small>
        {actions ? (
          <div className="gyro-sidebar-scm-batch-actions">{actions}</div>
        ) : (
          <span />
        )}
      </div>
      {collapsed ? null : (
        <>
          {visible.map((file) => {
            const parentFolder = workspaceParentFolder(file.path);
            const decoration = scmStateDecoration(file.state);
            const badge = scmFileBadge(file.path);
            const BadgeIcon = badge.icon;
            const isGone = file.state === "deleted" || file.state === "renamed";
            return (
              <div
                className="gyro-sidebar-scm-row"
                data-state={file.state}
                key={`${file.path}:${file.staged}`}
              >
                <input
                  aria-label={`Select ${file.path}`}
                  checked={selectedPaths.has(file.path)}
                  onChange={() => onToggleSelected(file.path)}
                  type="checkbox"
                />
                <button
                  aria-label={`Open diff for ${file.path}`}
                  className="gyro-sidebar-scm-identity"
                  onClick={() => onOpenDiff?.(file.path, file.staged)}
                  title={`${file.path} — ${decoration.label}${
                    file.staged ? ", staged" : ""
                  }`}
                  type="button"
                >
                  <BadgeIcon
                    aria-hidden="true"
                    className={`gyro-sidebar-scm-file-icon is-${badge.tone}`}
                    size={13}
                  />
                  <span
                    className={
                      isGone
                        ? "gyro-sidebar-scm-filename is-gone"
                        : "gyro-sidebar-scm-filename"
                    }
                  >
                    {workspaceName(file.path)}
                  </span>
                  {parentFolder ? (
                    <small
                      className={
                        isGone
                          ? "gyro-sidebar-scm-directory is-gone"
                          : "gyro-sidebar-scm-directory"
                      }
                    >
                      {parentFolder}
                    </small>
                  ) : null}
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
                      void onDiscardFile?.(file.path);
                    }
                  }}
                  title="Discard changes"
                  type="button"
                >
                  <Trash2 size={11} />
                </button>
                <button
                  aria-label={`${file.staged ? "Unstage" : "Stage"} ${file.path}`}
                  className="gyro-sidebar-scm-stage"
                  onClick={() => void onToggleStage?.(file.path, file.staged)}
                  title={file.staged ? "Unstage changes" : "Stage changes"}
                  type="button"
                >
                  {file.staged ? <Minus size={12} /> : <Plus size={12} />}
                </button>
                <small
                  className={`gyro-sidebar-scm-state is-${decoration.tone}`}
                  title={decoration.label}
                >
                  {decoration.letter}
                </small>
              </div>
            );
          })}
          {hidden > 0 ? (
            <div className="gyro-sidebar-mini-copy">
              {hidden} more file{hidden === 1 ? "" : "s"} not shown
            </div>
          ) : null}
          {files.length === 0 && emptyCopy ? (
            <div className="gyro-sidebar-mini-copy">{emptyCopy}</div>
          ) : null}
        </>
      )}
    </>
  );
}

function WorkspaceSidebarContent({
  sessions,
  commandProfiles,
  savedProjects,
  activeSessionId,
  sendingSessionIds,
  modelTerminalSessionIds = [],
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
  onCreateMission,
  onCreateCliSession,
  onSelectSessions,
  onOpenWorkspace,
  onAddWorkspaceFolder,
  onRemoveWorkspaceFolder,
  onSelectWorkspaceFolder,
  onOpenWorkspaceFile,
  onPinEditorTab,
  onRefreshWorkspace,
  onCreateWorkspacePath,
  onRenameWorkspacePath,
  onDeleteWorkspacePath,
  onOpenCommandPalette,
  onSelectIdeView,
  onRunWorkspaceSearch,
  onApplyWorkspaceReplace,
  onRefreshSourceControl,
  onToggleSourceControlFile,
  onStageAllSourceControl,
  onDiscardSourceControlFile,
  onOpenSourceControlDiff,
  onCommitSourceControl,
  branchCatalog,
  isBranchLoading = false,
  onSelectWorkspaceBranch,
  onCreateWorkspaceBranch,
  onRefreshGithub,
  onSelectGithubRun,
  onViewGithubRunLogs,
  onRerunGithubRun,
  onOpenGithubUrl,
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
  canHideSidebar = true,
  updateState,
  onUpdateAction,
  workspacePreparation,
  isWorkspacePreparationOpen,
  onToggleWorkspacePreparation,
  onCloseWorkspacePreparation,
  onRetryWorkspacePreparation,
  renderAiChat,
  workspacePreparationRef,
}: {
  renderAiChat?: () => ReactNode;
  sessions: Session[];
  commandProfiles: CommandProfile[];
  savedProjects: Array<{ path: string; label: string }>;
  activeSessionId?: string;
  sendingSessionIds: string[];
  modelTerminalSessionIds?: string[];
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
  onCreateMission?: () => void;
  onCreateCliSession: (
    profileId: string,
    workspacePath: string,
    options?: { missionSessionId?: string; taskTitle?: string },
  ) => void;
  onSelectSessions: () => void;
  onOpenWorkspace: () => void;
  onAddWorkspaceFolder?: () => void;
  onRemoveWorkspaceFolder?: (path: string) => void;
  onSelectWorkspaceFolder?: (path: string) => void;
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
  onRunWorkspaceSearch?: (query: WorkspaceSearchQuery) => void;
  onApplyWorkspaceReplace?: (
    query: WorkspaceSearchQuery,
    replacement: string,
    paths: string[],
  ) => void | Promise<void>;
  onRefreshSourceControl?: () => void;
  onToggleSourceControlFile?: (
    path: string,
    staged: boolean,
  ) => void | Promise<void>;
  onStageAllSourceControl?: () => void | Promise<void>;
  onDiscardSourceControlFile?: (path: string) => void | Promise<void>;
  onOpenSourceControlDiff?: (path: string, staged: boolean) => void;
  onCommitSourceControl?: (message: string) => void;
  branchCatalog?: GitBranchCatalog;
  isBranchLoading?: boolean;
  onSelectWorkspaceBranch?: (branch: string) => void;
  onCreateWorkspaceBranch?: (startPoint?: string) => void;
  onRefreshGithub?: () => void | Promise<void>;
  onSelectGithubRun?: (runId: number) => void | Promise<void>;
  onViewGithubRunLogs?: (runId: number) => void | Promise<void>;
  onRerunGithubRun?: (
    runId: number,
    failedOnly: boolean,
  ) => void | Promise<void>;
  onOpenGithubUrl?: (url: string) => void | Promise<void>;
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
  /** When false, the hide control is omitted (Workspace code layout). */
  canHideSidebar?: boolean;
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
  // Hide empty "New chat" / "New mission" shells until something real happens.
  const recentSessions = sessions.filter((session) => {
    if (pinnedSessionIds.includes(session.id)) {
      return false;
    }
    const hasMissionWorkers = terminalPanes.some(
      (pane) => pane.missionSessionId === session.id,
    );
    return sessionHasStartedForSidebar(session, { hasMissionWorkers });
  });
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
  const newCliWorkspacePath = cliProjects[0]?.path ?? "";
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
  const [selectedExplorerPaths, setSelectedExplorerPaths] = useState<
    Set<string>
  >(() => new Set());
  const [explorerContextMenu, setExplorerContextMenu] = useState<{
    path: string;
    x: number;
    y: number;
  }>();
  const explorerContextMenuRef = useOutsidePointerDismiss<HTMLDivElement>(
    Boolean(explorerContextMenu),
    () => setExplorerContextMenu(undefined),
  );
  const selectedExplorerFile = files.find(
    (file) => file.path === selectedExplorerPath,
  );
  const [sourceControlMessage, setSourceControlMessage] = useState("");
  const [selectedSourceControlPaths, setSelectedSourceControlPaths] = useState<
    Set<string>
  >(() => new Set());
  const [collapsedScmGroups, setCollapsedScmGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleScmGroup = useCallback((group: string) => {
    setCollapsedScmGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);
  const toggleSourceControlSelection = useCallback((path: string) => {
    setSelectedSourceControlPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const sourceControlFiles = ide?.sourceControl.files;
  const stagedSourceControlFiles = useMemo(
    () =>
      (sourceControlFiles ?? [])
        .filter((file) => file.staged)
        .sort((first, second) => first.path.localeCompare(second.path)),
    [sourceControlFiles],
  );
  const unstagedSourceControlFiles = useMemo(
    () =>
      (sourceControlFiles ?? [])
        .filter((file) => !file.staged)
        .sort((first, second) => first.path.localeCompare(second.path)),
    [sourceControlFiles],
  );
  const [debugAdapterCommand, setDebugAdapterCommand] = useState("lldb-dap");
  const visibleFiles = useMemo(
    () =>
      files.filter((file) =>
        workspaceAncestorPaths(file.path, file.workspacePath).every(
          (ancestor) => expandedWorkspaceDirectories.has(ancestor),
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
  const [sidebarSearchDetailsOpen, setSidebarSearchDetailsOpen] =
    useState(false);
  const [sidebarReplaceOpen, setSidebarReplaceOpen] = useState(false);
  const [sidebarReplaceDraft, setSidebarReplaceDraft] = useState("");
  const [selectedReplacePaths, setSelectedReplacePaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [sidebarSearchIncludeDraft, setSidebarSearchIncludeDraft] = useState(
    workspaceSearchGlobText(ide?.searchQuery.globs, "include"),
  );
  const [sidebarSearchExcludeDraft, setSidebarSearchExcludeDraft] = useState(
    workspaceSearchGlobText(ide?.searchQuery.globs, "exclude"),
  );
  const workspaceFileRootKey = files
    .filter((file) => file.isWorkspaceRoot)
    .map((file) => file.path)
    .join("\n");
  useEffect(() => {
    setSidebarSearchDraft(ide?.searchQuery.query ?? "");
    setSidebarSearchIncludeDraft(
      workspaceSearchGlobText(ide?.searchQuery.globs, "include"),
    );
    setSidebarSearchExcludeDraft(
      workspaceSearchGlobText(ide?.searchQuery.globs, "exclude"),
    );
  }, [ide?.searchQuery.globs, ide?.searchQuery.query]);
  useEffect(() => {
    if (!sidebarReplaceOpen) return;
    setSelectedReplacePaths(
      new Set((ide?.searchResults ?? []).map((result) => result.path)),
    );
  }, [ide?.searchResults, sidebarReplaceOpen]);
  useEffect(() => {
    const available = new Set(
      (ide?.sourceControl.files ?? []).map((file) => file.path),
    );
    setSelectedSourceControlPaths((current) => {
      const next = new Set([...current].filter((path) => available.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [ide?.sourceControl.files]);
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
    setExpandedWorkspaceDirectories(
      new Set(
        files.filter((file) => file.isWorkspaceRoot).map((file) => file.path),
      ),
    );
    setSelectedExplorerPath(
      ide?.activePath && files.some((file) => file.path === ide.activePath)
        ? ide.activePath
        : undefined,
    );
  }, [workspaceFileRootKey, workspacePath]);
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
            workspaceAncestorPaths(candidate.path, candidate.workspacePath).at(
              -1,
            ) === file.path,
        );
        focusExplorerPath(child?.path);
      }
    } else if (event.key === "ArrowLeft") {
      const parentPath = workspaceAncestorPaths(
        file.path,
        file.workspacePath,
      ).at(-1);
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
      hasModelTerminal={modelTerminalSessionIds.includes(session.id)}
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
        isActive={pane.id === selectedTerminalPaneId}
        key={pane.id}
        label={pane.taskTitle ?? pane.title}
        meta={sidebarTerminalActivityLabel(activity)}
        onClick={() => onSelectTerminalPane?.(pane.id)}
        onClose={() => onCloseTerminalPane?.(pane.id)}
        state={activity}
      />
    );
  };
  /** Mission-owned CLIs nest under their goal chat; free CLIs stay top-level. */
  const renderNavigationItem = (item: SidebarSessionItem) => {
    if (item.kind === "cli") {
      return renderCliPaneRow(item.pane, true);
    }
    const session = item.session;
    const missionWorkers = terminalPanes.filter(
      (pane) => pane.missionSessionId === session.id,
    );
    return (
      <div className="gyro-sidebar-mission-cluster" key={session.id}>
        {renderSessionRow(session, true)}
        {missionWorkers.map((pane) => renderCliPaneRow(pane, true))}
      </div>
    );
  };

  return (
    <>
      <div className="gyro-sidebar-persistent-header">
        <div className="gyro-sidebar-windowbar" aria-label="Window navigation">
          <div className="gyro-sidebar-window-actions">
            {canHideSidebar ? (
              <button
                aria-label="Hide sidebar"
                onClick={onToggleSidebar}
                type="button"
              >
                <PanelLeftClose size={13} />
              </button>
            ) : null}
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
            <SidebarUpdateControl
              onAction={onUpdateAction}
              state={updateState}
            />
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

          {activeIdeView === "explorer" ? (
            <SidebarSection
              grow
              headerActions={
                workspacePath ? (
                  <div className="gyro-sidebar-explorer-toolbar">
                    <button
                      aria-label="Add folder to workspace"
                      onClick={onAddWorkspaceFolder}
                      title="Add folder to workspace"
                      type="button"
                    >
                      <HardDrive size={13} />
                      <Plus size={9} />
                    </button>
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
                      aria-label={
                        selectedExplorerFile?.isWorkspaceRoot
                          ? "Remove folder from workspace"
                          : "Delete selected path"
                      }
                      disabled={!selectedExplorerPath && !ide?.activePath}
                      onClick={() => {
                        const path =
                          selectedExplorerPath ?? ide?.activePath ?? "";
                        if (selectedExplorerFile?.isWorkspaceRoot) {
                          onRemoveWorkspaceFolder?.(
                            selectedExplorerFile.workspacePath ?? path,
                          );
                          return;
                        }
                        onDeleteWorkspacePath?.(path);
                      }}
                      title={
                        selectedExplorerFile?.isWorkspaceRoot
                          ? "Remove folder from workspace"
                          : "Delete selected path"
                      }
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
                  {files.some((file) => file.isWorkspaceRoot) ? null : (
                    <SidebarProjectRow
                      icon={Folder}
                      label={workspaceName(workspacePath)}
                      meta="workspace"
                      onClick={onOpenWorkspace}
                    />
                  )}
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
                              selectedExplorerPaths.has(file.path) ||
                              selectedExplorerPath === file.path ||
                              (!selectedExplorerPath &&
                                ide?.activePath === file.path)
                            }
                            isOpen={Boolean(
                              ide?.tabs.some((tab) => tab.path === file.path),
                            )}
                            key={file.path}
                            kind={file.kind}
                            label={
                              file.isWorkspaceRoot
                                ? workspaceName(file.workspacePath)
                                : workspaceName(file.path)
                            }
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
                            onClick={(event) => {
                              if (event.metaKey || event.ctrlKey) {
                                setSelectedExplorerPaths((current) => {
                                  const next = new Set(current);
                                  if (next.has(file.path))
                                    next.delete(file.path);
                                  else next.add(file.path);
                                  return next;
                                });
                              } else if (
                                event.shiftKey &&
                                selectedExplorerPath
                              ) {
                                const anchor = visibleFiles.findIndex(
                                  (item) => item.path === selectedExplorerPath,
                                );
                                const target = visibleFiles.findIndex(
                                  (item) => item.path === file.path,
                                );
                                const [start, end] =
                                  anchor < target
                                    ? [anchor, target]
                                    : [target, anchor];
                                setSelectedExplorerPaths(
                                  new Set(
                                    visibleFiles
                                      .slice(start, end + 1)
                                      .map((item) => item.path),
                                  ),
                                );
                              } else {
                                setSelectedExplorerPaths(new Set([file.path]));
                              }
                              setSelectedExplorerPath(file.path);
                              if (file.workspacePath) {
                                onSelectWorkspaceFolder?.(file.workspacePath);
                              }
                              if (file.kind === "file") {
                                onOpenWorkspaceFile?.(file.path);
                                return;
                              }
                              toggleWorkspaceDirectory(file.path);
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              setSelectedExplorerPath(file.path);
                              if (!selectedExplorerPaths.has(file.path)) {
                                setSelectedExplorerPaths(new Set([file.path]));
                              }
                              setExplorerContextMenu({
                                path: file.path,
                                x: event.clientX,
                                y: event.clientY,
                              });
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
              {explorerContextMenu ? (
                <div
                  className="gyro-explorer-context-menu"
                  ref={explorerContextMenuRef}
                  role="menu"
                  style={{
                    left: explorerContextMenu.x,
                    top: explorerContextMenu.y,
                  }}
                >
                  <button
                    onClick={() => {
                      const file = files.find(
                        (item) => item.path === explorerContextMenu.path,
                      );
                      if (file?.kind === "file") {
                        onOpenWorkspaceFile?.(file.path);
                      } else {
                        onCreateWorkspacePath?.("file", file?.path);
                      }
                      setExplorerContextMenu(undefined);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {files.find(
                      (item) => item.path === explorerContextMenu.path,
                    )?.kind === "file"
                      ? "Open"
                      : "New File"}
                  </button>
                  <button
                    onClick={() => {
                      onRenameWorkspacePath?.(explorerContextMenu.path);
                      setExplorerContextMenu(undefined);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Rename
                  </button>
                  <button
                    className="is-danger"
                    onClick={() => {
                      const file = files.find(
                        (item) => item.path === explorerContextMenu.path,
                      );
                      if (file?.isWorkspaceRoot) {
                        onRemoveWorkspaceFolder?.(
                          file.workspacePath ?? file.path,
                        );
                      } else {
                        onDeleteWorkspacePath?.(explorerContextMenu.path);
                      }
                      setExplorerContextMenu(undefined);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {files.find(
                      (item) => item.path === explorerContextMenu.path,
                    )?.isWorkspaceRoot
                      ? "Remove Folder from Workspace"
                      : "Delete"}
                  </button>
                </div>
              ) : null}
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
                  const globs = workspaceSearchGlobs(
                    sidebarSearchIncludeDraft,
                    sidebarSearchExcludeDraft,
                  );
                  onRunWorkspaceSearch?.({
                    query: sidebarSearchDraft,
                    globs: globs.length > 0 ? globs : undefined,
                  });
                }}
              >
                <Search size={14} />
                <input
                  // This view greps file contents; finding a file by name is
                  // the palette's job, so the copy has to separate the two.
                  aria-label="Search in files"
                  onChange={(event) => {
                    const draft = event.target.value;
                    setSidebarSearchDraft(draft);
                    // An empty box means an empty result list: matches from the
                    // previous query must not outlive the query itself.
                    if (!draft.trim()) {
                      setSelectedReplacePaths(new Set());
                      onRunWorkspaceSearch?.({ query: "" });
                    }
                  }}
                  placeholder="Search in files"
                  value={sidebarSearchDraft}
                />
                <button
                  aria-expanded={sidebarReplaceOpen}
                  aria-label="Toggle replace preview"
                  className={sidebarReplaceOpen ? "is-active" : ""}
                  onClick={() => setSidebarReplaceOpen((current) => !current)}
                  title="Toggle replace preview"
                  type="button"
                >
                  <Edit3 size={13} />
                </button>
                <button
                  aria-expanded={sidebarSearchDetailsOpen}
                  aria-label="Toggle search details"
                  className={sidebarSearchDetailsOpen ? "is-active" : ""}
                  onClick={() =>
                    setSidebarSearchDetailsOpen((current) => !current)
                  }
                  title="Toggle search details"
                  type="button"
                >
                  <SlidersHorizontal size={13} />
                </button>
                {sidebarReplaceOpen ? (
                  <div className="gyro-sidebar-replace-row">
                    <CornerDownRight size={13} />
                    <input
                      aria-label="Replace workspace matches with"
                      onChange={(event) =>
                        setSidebarReplaceDraft(event.target.value)
                      }
                      placeholder="Replace with"
                      value={sidebarReplaceDraft}
                    />
                  </div>
                ) : null}
                {sidebarSearchDetailsOpen ? (
                  <div className="gyro-sidebar-search-details">
                    <label>
                      <span>Files to include</span>
                      <input
                        aria-label="Files to include"
                        onChange={(event) =>
                          setSidebarSearchIncludeDraft(event.target.value)
                        }
                        placeholder="src/**, *.{ts,tsx}"
                        value={sidebarSearchIncludeDraft}
                      />
                    </label>
                    <label>
                      <span>Files to exclude</span>
                      <input
                        aria-label="Files to exclude"
                        onChange={(event) =>
                          setSidebarSearchExcludeDraft(event.target.value)
                        }
                        placeholder="node_modules/**, dist/**"
                        value={sidebarSearchExcludeDraft}
                      />
                    </label>
                  </div>
                ) : null}
              </form>
              {sidebarReplaceOpen && (ide?.searchResults.length ?? 0) > 0 ? (
                <div className="gyro-sidebar-replace-preview">
                  <div>
                    <strong>Replace preview</strong>
                    <span>
                      {selectedReplacePaths.size} of{" "}
                      {
                        new Set(ide?.searchResults.map((result) => result.path))
                          .size
                      }{" "}
                      files
                    </span>
                  </div>
                  <button
                    disabled={
                      selectedReplacePaths.size === 0 ||
                      !sidebarSearchDraft.trim()
                    }
                    onClick={() =>
                      void onApplyWorkspaceReplace?.(
                        {
                          query: sidebarSearchDraft,
                          globs: workspaceSearchGlobs(
                            sidebarSearchIncludeDraft,
                            sidebarSearchExcludeDraft,
                          ),
                        },
                        sidebarReplaceDraft,
                        [...selectedReplacePaths],
                      )
                    }
                    type="button"
                  >
                    Replace in {selectedReplacePaths.size} files
                  </button>
                </div>
              ) : null}
              {(ide?.searchResults ?? []).length > 0 ? (
                ide?.searchResults.slice(0, 30).map((result) => (
                  <div
                    className="gyro-sidebar-search-result"
                    key={`${result.path}:${result.lineNumber}:${result.line}`}
                  >
                    {sidebarReplaceOpen ? (
                      <input
                        aria-label={`Include ${result.path} in replace`}
                        checked={selectedReplacePaths.has(result.path)}
                        onChange={() =>
                          setSelectedReplacePaths((current) => {
                            const next = new Set(current);
                            if (next.has(result.path)) next.delete(result.path);
                            else next.add(result.path);
                            return next;
                          })
                        }
                        type="checkbox"
                      />
                    ) : null}
                    <button
                      className={
                        ide?.activePath === result.path ? "is-active" : ""
                      }
                      onClick={() =>
                        onOpenWorkspaceFile?.(
                          result.path,
                          result.lineNumber,
                          result.ranges?.[0]?.startColumn ?? 1,
                        )
                      }
                      type="button"
                    >
                      <span>
                        <FileCode2 size={13} />
                        <strong>{workspaceName(result.path)}</strong>
                        <small>:{result.lineNumber}</small>
                      </span>
                      <code>{result.line.trim()}</code>
                    </button>
                  </div>
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
              <div className="gyro-scm-panel">
                <div className="gyro-sidebar-scm-group-label">
                  <span className="gyro-scm-label-text">Repository</span>
                </div>
                {/* Repository and branch read as one line: what you are in,
                    and where in it. They stack again when the sidebar is too
                    narrow to hold both names. */}
                <div className="gyro-sidebar-scm-head">
                  <div className="gyro-sidebar-scm-repository">
                    <HardDrive size={12} aria-hidden="true" />
                    <strong title={workspacePath}>
                      {workspaceName(workspacePath)}
                    </strong>
                    <button
                      aria-label="Refresh source control"
                      onClick={onRefreshSourceControl}
                      title="Refresh"
                      type="button"
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                  <ScmBranchPicker
                    branchCatalog={branchCatalog}
                    currentBranch={
                      ide?.sourceControl.branch ?? branchCatalog?.current
                    }
                    disabled={isBranchLoading}
                    error={
                      ide?.sourceControl.error ??
                      branchCatalog?.error ??
                      (ide?.sourceControl.available === false
                        ? "Git is not ready for this workspace."
                        : undefined)
                    }
                    isLoading={isBranchLoading}
                    onCreateBranch={() =>
                      onCreateWorkspaceBranch?.(
                        ide?.sourceControl.branch ?? branchCatalog?.current,
                      )
                    }
                    onSelectBranch={(branch) =>
                      onSelectWorkspaceBranch?.(branch)
                    }
                  />
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
                    placeholder={`Message (${
                      isMacPlatform() ? "⌘Enter" : "Ctrl+Enter"
                    } to commit${
                      ide?.sourceControl.branch
                        ? ` on "${ide.sourceControl.branch}"`
                        : ""
                    })`}
                    value={sourceControlMessage}
                    onKeyDown={(event) => {
                      if (
                        (event.metaKey || event.ctrlKey) &&
                        event.key === "Enter"
                      ) {
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <div className="gyro-sidebar-commit-actions">
                    <button
                      className="is-secondary"
                      disabled={unstagedSourceControlFiles.length === 0}
                      onClick={() => void onStageAllSourceControl?.()}
                      title="Stage all changes"
                      type="button"
                    >
                      Stage all
                    </button>
                    <button
                      disabled={
                        !sourceControlMessage.trim() ||
                        (stagedSourceControlFiles.length === 0 &&
                          unstagedSourceControlFiles.length === 0)
                      }
                      type="submit"
                      title={
                        stagedSourceControlFiles.length > 0
                          ? "Commit staged changes"
                          : "Stage all changes and commit"
                      }
                    >
                      <Check size={13} />
                      {stagedSourceControlFiles.length > 0
                        ? "Commit"
                        : "Commit all"}
                    </button>
                  </div>
                </form>
                {ide?.sourceControl.error ? (
                  <div className="gyro-sidebar-mini-copy is-error">
                    {ide.sourceControl.error}
                  </div>
                ) : null}
                {ide?.sourceControl.available === false &&
                !ide?.sourceControl.error ? (
                  <div className="gyro-sidebar-mini-copy">
                    Git is not ready for this workspace.
                  </div>
                ) : null}
                {stagedSourceControlFiles.length > 0 ? (
                  <ScmChangeGroup
                    actions={
                      <button
                        aria-label="Unstage all staged changes"
                        onClick={async () => {
                          for (const file of stagedSourceControlFiles) {
                            await onToggleSourceControlFile?.(file.path, true);
                          }
                          onRefreshSourceControl?.();
                        }}
                        title="Unstage all"
                        type="button"
                      >
                        <Minus size={11} />
                      </button>
                    }
                    className="is-staged"
                    collapsed={collapsedScmGroups.has("staged")}
                    files={stagedSourceControlFiles}
                    onDiscardFile={onDiscardSourceControlFile}
                    onOpenDiff={onOpenSourceControlDiff}
                    onToggleCollapsed={() => toggleScmGroup("staged")}
                    onToggleSelected={toggleSourceControlSelection}
                    onToggleStage={onToggleSourceControlFile}
                    selectedPaths={selectedSourceControlPaths}
                    title="Staged Changes"
                  />
                ) : null}
                <ScmChangeGroup
                  actions={
                    <>
                      <button
                        aria-label="Select all source control changes"
                        disabled={unstagedSourceControlFiles.length === 0}
                        onClick={() =>
                          setSelectedSourceControlPaths(
                            new Set(
                              unstagedSourceControlFiles.map(
                                (file) => file.path,
                              ),
                            ),
                          )
                        }
                        title="Select all"
                        type="button"
                      >
                        <ListChecks size={11} />
                      </button>
                      <button
                        aria-label="Stage selected source control changes"
                        disabled={selectedSourceControlPaths.size === 0}
                        onClick={async () => {
                          const selected = unstagedSourceControlFiles.filter(
                            (file) => selectedSourceControlPaths.has(file.path),
                          );
                          for (const file of selected) {
                            await onToggleSourceControlFile?.(file.path, false);
                          }
                          onRefreshSourceControl?.();
                        }}
                        title="Stage selected"
                        type="button"
                      >
                        <Plus size={11} />
                      </button>
                      <button
                        aria-label="Discard selected source control changes"
                        disabled={selectedSourceControlPaths.size === 0}
                        onClick={async () => {
                          if (
                            !window.confirm(
                              `Discard changes in ${selectedSourceControlPaths.size} selected files? This cannot be undone.`,
                            )
                          ) {
                            return;
                          }
                          for (const path of selectedSourceControlPaths) {
                            await onDiscardSourceControlFile?.(path);
                          }
                          setSelectedSourceControlPaths(new Set());
                          onRefreshSourceControl?.();
                        }}
                        title="Discard selected"
                        type="button"
                      >
                        <Trash2 size={11} />
                      </button>
                    </>
                  }
                  className="is-changes"
                  collapsed={collapsedScmGroups.has("changes")}
                  emptyCopy={
                    ide?.sourceControl.available === false
                      ? undefined
                      : stagedSourceControlFiles.length > 0
                        ? "Everything else is staged"
                        : "No changes"
                  }
                  files={unstagedSourceControlFiles}
                  onDiscardFile={onDiscardSourceControlFile}
                  onOpenDiff={onOpenSourceControlDiff}
                  onToggleCollapsed={() => toggleScmGroup("changes")}
                  onToggleSelected={toggleSourceControlSelection}
                  onToggleStage={onToggleSourceControlFile}
                  selectedPaths={selectedSourceControlPaths}
                  title="Changes"
                />
                <GithubSidebarPanel
                  github={ide?.github}
                  branch={ide?.sourceControl.branch}
                  onOpenUrl={onOpenGithubUrl}
                  onRefresh={onRefreshGithub}
                  onRerunRun={onRerunGithubRun}
                  onSelectRun={onSelectGithubRun}
                  onViewLogs={onViewGithubRunLogs}
                />
              </div>
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
            renderAiChat ? (
              // The workspace's only chat lives here now: the same ChatSurface
              // the Sessions destination renders, at sidebar width.
              <div className="gyro-sidebar-ai-chat gyro-ide-assistant-chat">
                {renderAiChat()}
              </div>
            ) : (
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
                    icon={Sparkles}
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
            )
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
                New Session
              </button>
              {newSessionMenuView !== "closed" ? (
                <div
                  aria-label="Create Chat or CLI session"
                  className="gyro-sidebar-new-session-menu is-root"
                  role="menu"
                >
                  <div
                    aria-label="Chat sessions"
                    className="gyro-sidebar-session-group is-chat"
                    role="group"
                  >
                    <span className="gyro-sidebar-session-group-label">
                      Chat
                    </span>
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
                    {onCreateMission ? (
                      <button
                        aria-label="New mission"
                        onClick={() => {
                          setNewSessionMenuView("closed");
                          onCreateMission();
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <Target size={15} />
                        <span>
                          <strong>New mission</strong>
                          <small>Goal chat that owns CLI workers</small>
                        </span>
                      </button>
                    ) : null}
                  </div>
                  <div
                    aria-label="Open CLI sessions"
                    className="gyro-sidebar-session-group is-cli"
                    role="group"
                  >
                    <span className="gyro-sidebar-session-group-label">
                      Open CLI
                    </span>
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
                            <ProviderLogo
                              providerId={profile.providerId as ProviderId}
                            />
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
                {primaryGlobalSearchShortcut("global")}
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
              const timeGroupedSessions = isExpanded
                ? groupSidebarItemsByRecency(visibleProjectSessions)
                : [{ label: null as string | null, items: visibleProjectSessions }];
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
                        timeGroupedSessions.map((group) => (
                          <div key={group.label ?? "recent"}>
                            {group.label ? (
                              <div className="gyro-sidebar-time-group">
                                {group.label}
                              </div>
                            ) : null}
                            {group.items.map(renderNavigationItem)}
                          </div>
                        ))
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
                          aria-expanded={isExpanded}
                          className="gyro-sidebar-more-button"
                          onClick={() => toggleProjectMore(project.key)}
                          type="button"
                        >
                          <ChevronDown aria-hidden="true" size={12} />
                          <span>
                            {isExpanded ? "Show less" : `${hiddenCount} more`}
                          </span>
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
  hasModelTerminal = false,
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
  hasModelTerminal?: boolean;
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
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useOutsidePointerDismiss<HTMLDivElement>(
    isMenuOpen,
    onMenuClose,
    menuTriggerRef,
  );
  const sessionProviderId = providerIdForSession(session);
  const modelTitle =
    session.modelLabel ??
    session.modelId ??
    session.providerLabel ??
    session.providerId ??
    "No model saved";
  const isAgentWorkspace = session.workspaceMode === "worktree";
  const isCliOrigin = session.origin === "cli";
  const badgeLabels = [
    isAgentWorkspace ? "Isolated agent workspace" : undefined,
    isCliOrigin ? "Started from CLI" : undefined,
  ].filter(Boolean);
  const ariaTitle = [session.title, session.summary, ...badgeLabels]
    .filter(Boolean)
    .join(". ");

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
        isAgentWorkspace ? "is-agent-workspace" : "",
      ].join(" ")}
      aria-grabbed={onDragStart ? Boolean(isDragging) : undefined}
      draggable={Boolean(onDragStart)}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
    >
      <button
        aria-label={ariaTitle}
        className={
          sessionProviderId
            ? "gyro-sidebar-thread-main has-model-logo"
            : "gyro-sidebar-thread-main"
        }
        onClick={onSelect}
        title={[session.summary ?? session.title, ...badgeLabels]
          .filter(Boolean)
          .join(" · ")}
        type="button"
      >
        {sessionProviderId ? (
          <span className="gyro-sidebar-model-logo" title={modelTitle}>
            <ProviderLogo providerId={sessionProviderId} />
          </span>
        ) : null}
        <span className="gyro-sidebar-thread-title">
          <span>{session.title}</span>
          {isAgentWorkspace || isCliOrigin ? (
            <span className="gyro-session-badges" aria-hidden="true">
              {isAgentWorkspace ? (
                <span
                  className="gyro-session-badge is-agent-workspace"
                  title="Agent workspace — private branch under Gyro"
                >
                  <GitBranch size={10} />
                  Isolated
                </span>
              ) : null}
              {isCliOrigin ? (
                <span
                  className="gyro-session-badge is-cli"
                  title="Started from the gyro CLI"
                >
                  <Terminal size={10} />
                  CLI
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <small
          aria-label={
            isSending
              ? "Chat working"
              : hasModelTerminal
                ? "Model terminal running"
                : undefined
          }
          className={[
            "gyro-session-time",
            isSending ? "is-working" : "",
            !isSending && hasModelTerminal ? "is-model-terminal" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          title={
            isSending
              ? "Chat working in the background"
              : hasModelTerminal
                ? "Model-owned terminal is still running"
                : undefined
          }
        >
          {isSending ? (
            <CircleDashed aria-hidden="true" size={13} />
          ) : hasModelTerminal ? (
            <Terminal aria-hidden="true" size={12} />
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
          ref={menuTriggerRef}
          title="More"
          type="button"
        >
          <MoreHorizontal size={15} />
        </button>
      </div>
      {isMenuOpen ? (
        <div className="gyro-session-menu" ref={menuRef} role="menu">
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
    // Mission workers render nested under their goal chat, not as peers.
    if (pane.missionSessionId) {
      continue;
    }
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

/** Placeholder titles used before the first real turn or auto-title. */
function isSidebarPlaceholderSessionTitle(title: string) {
  return [
    "new chat",
    "new mission",
    "desktop session",
    "worktree session",
    "agent workspace",
    "cli workspace",
    "worktree cli workspace",
    "agent workspace cli",
  ].includes(title.trim().toLowerCase());
}

/**
 * Whether a chat/mission should list in the Projects sidebar.
 * Unstarted shells (empty New chat / New mission) stay out until activity.
 */
function sessionHasStartedForSidebar(
  session: Session,
  options: { hasMissionWorkers?: boolean } = {},
) {
  // Mission with workers is already real work even without a goal message.
  if (options.hasMissionWorkers) {
    return true;
  }
  if (!isSidebarPlaceholderSessionTitle(session.title)) {
    return true;
  }
  if (session.summary?.trim()) {
    return true;
  }
  // First turn / rename updates `updatedAt` after create.
  const created = Date.parse(session.createdAt);
  const updated = Date.parse(session.updatedAt);
  if (
    Number.isFinite(created) &&
    Number.isFinite(updated) &&
    updated > created + 1_500
  ) {
    return true;
  }
  return false;
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
  onContextMenu,
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
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const badge = kind === "file" ? scmFileBadge(label) : undefined;
  const FileIcon = badge?.icon ?? FileCode2;

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
      data-file-tone={badge?.tone}
      data-open={isOpen || undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
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
        <FileIcon
          aria-hidden="true"
          className="gyro-explorer-file-icon"
          size={13}
        />
      )}
      <span>{label}</span>
      {decoration?.badge ? (
        <small className="gyro-explorer-decoration">{decoration.badge}</small>
      ) : null}
    </button>
  );
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
      aria-pressed={isActive === true}
      className={
        isActive ? "gyro-sidebar-mode-row is-active" : "gyro-sidebar-mode-row"
      }
      data-sidebar-mode={label.toLowerCase()}
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
                  title={workspaceModeTechnicalHint(mode)}
                  type="button"
                >
                  {workspaceModeShortLabel(mode)}
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
          {workspaceName(workspacePath)} · {workspaceModeLabel(workspaceMode)}
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
  children,
  layout,
  maximizedPaneId,
  onDropSession,
  onFocusPane,
  onMovePane,
  onToggleMaximize,
  renderPane,
}: {
  children?: ReactNode;
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
  const arrangement = effectiveChatArrangement(layout, occupiedCount);
  // Light up the tile the chat will actually land on. Grid-position zones can
  // resolve to a different slot when the pointed-at column is full, and a
  // preview that disagrees with the drop is worse than no preview.
  const highlightedZoneId = (() => {
    const hovered = dropZones.find((zone) => zone.id === dropTargetId);
    if (!hovered || hovered.placement) return dropTargetId;
    const { targetIndex } = resolveChatGridDropSlot(slots, hovered.slotIndex);
    return (
      dropZones.find((zone) => zone.slotIndex === targetIndex)?.id ?? hovered.id
    );
  })();

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
      data-arrangement={hasMultiplePanes ? arrangement : undefined}
      style={
        {
          "--gyro-grid-count": occupiedCount,
        } as CSSProperties
      }
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
      {occupiedCount === 0 && children ? (
        <div className="gyro-chat-grid-empty">{children}</div>
      ) : null}
      {slots.map((pane, slotIndex) => {
        const paneMaximized = pane?.paneId === maximizedPaneId;
        const paneFocused = pane?.paneId === focusedPaneId;
        const hiddenByMaximize = isMaximized && !paneMaximized;
        const slotArea =
          arrangement === "grid"
            ? chatGridSlotArea(slots, slotIndex)
            : undefined;
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
            style={slotArea}
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
            data-layout={
              occupiedCount === 0
                ? "full"
                : occupiedCount === 1
                  ? "columns"
                  : "positions"
            }
            data-zone-count={dropZones.length}
          >
            {dropZones.map((zone) => (
              <div
                className={[
                  "gyro-chat-grid-drop-zone",
                  highlightedZoneId === zone.id ? "is-drop-target" : "",
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
                <span
                  aria-label={zone.label}
                  className="gyro-chat-grid-drop-tile"
                />
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
  const occupiedCount = slots.filter(Boolean).length;
  // First chat into an empty grid: a single full-height/full-width target.
  if (occupiedCount === 0) {
    return [{ id: "full", label: "Open here", position: "full", slotIndex: 0 }];
  }
  // Second chat: a full-height Left / Right split — two panes tile side by side.
  if (occupiedCount === 1) {
    const slotIndex = slots.findIndex(Boolean);
    return [
      {
        id: "left",
        label: "Left",
        placement: { insertPosition: "before", splitDirection: "horizontal" },
        position: "left",
        slotIndex: slotIndex < 0 ? 0 : slotIndex,
      },
      {
        id: "right",
        label: "Right",
        placement: { insertPosition: "after", splitDirection: "horizontal" },
        position: "right",
        slotIndex: slotIndex < 0 ? 0 : slotIndex,
      },
    ];
  }
  // Third chat onward: place into a 2×2 grid position (the quadrants fill in).
  const labels = ["Top left", "Top right", "Bottom left", "Bottom right"];
  return labels.map((label, index) => ({
    id: `slot-${index}`,
    label,
    position: `position-${index + 1}`,
    slotIndex: index,
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

// Pin every slot to its own cell of the 2×2 grid, and let a pane whose column
// partner is empty stretch across both rows — three chats then fill the whole
// height instead of leaving a blank quadrant next to a half-height column.
function chatGridSlotArea(
  slots: Array<ChatPaneRef | null>,
  slotIndex: number,
): CSSProperties {
  const partnerIndex = slotIndex < 2 ? slotIndex + 2 : slotIndex - 2;
  return {
    gridColumn: (slotIndex % 2) + 1,
    gridRow: slots[partnerIndex] ? (slotIndex < 2 ? 1 : 2) : "1 / -1",
  };
}

function effectiveChatArrangement(
  layout: ChatProjectLayout,
  occupiedCount: number,
): ChatGridArrangement {
  if (layout.arrangement) {
    // A 2×2 grid needs at least three panes to differ from columns.
    if (layout.arrangement === "grid" && occupiedCount < 3) {
      return "columns";
    }
    return layout.arrangement;
  }
  if (occupiedCount === 2) {
    return layout.splitDirection === "vertical" ? "rows" : "columns";
  }
  return "grid";
}

/**
 * Mission control strip: workers under one goal chat. Phase 1 is manual
 * spawn (same default profile × N); plan-approve-spawn comes later.
 *
 * When the goal chat is already active, hide the empty-state lecture so the
 * board stays a compact control strip rather than a second empty product.
 */
function MissionWorkersBoard({
  defaultProfileLabel,
  goalActive = false,
  onAddWorker,
  onSelectWorker,
  workers,
}: {
  defaultProfileLabel?: string;
  /** True once the mission has chat turns / a live goal run. */
  goalActive?: boolean;
  onAddWorker?: () => void;
  onSelectWorker?: (paneId: string) => void;
  workers: TerminalPane[];
}) {
  const showEmptyHint = workers.length === 0 && !goalActive;
  return (
    <section
      aria-label="Mission workers"
      className={[
        "gyro-mission-workers",
        goalActive ? "is-goal-active" : "",
        workers.length === 0 ? "is-empty" : "has-workers",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="gyro-mission-workers-header">
        <span className="gyro-mission-workers-title">
          <Target aria-hidden="true" size={13} />
          Workers
          {workers.length > 0 ? <em>{workers.length}</em> : null}
        </span>
        {onAddWorker ? (
          <button
            className="gyro-mission-workers-add"
            onClick={onAddWorker}
            type="button"
          >
            <Plus size={13} />
            Add worker
            {defaultProfileLabel ? (
              <small>{defaultProfileLabel}</small>
            ) : null}
          </button>
        ) : null}
      </div>
      {showEmptyHint ? (
        <p className="gyro-mission-workers-empty">
          Optional: add CLI workers for parallel tasks (same runtime by
          default).
        </p>
      ) : null}
      {workers.length > 0 ? (
        <ul className="gyro-mission-workers-list">
          {workers.map((worker) => (
            <li key={worker.id}>
              <button
                className={`gyro-mission-worker is-${worker.status}`}
                onClick={() => onSelectWorker?.(worker.id)}
                type="button"
              >
                <span className="gyro-mission-worker-title">
                  {worker.taskTitle ?? worker.title}
                </span>
                <span className="gyro-mission-worker-meta">
                  {worker.status}
                  {worker.profileId ? ` · ${worker.profileId}` : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
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
  providerStatuses?: ProviderStatus[];
  providerUsageByProvider?: Partial<Record<ProviderId, ProviderUsageState>>;
  /** What this chat has spent, from Gyro's own usage ledger. */
  sessionUsage?: SessionUsageTotals;
  /** The current hold on runs and every configured budget. */
  usageSafety?: UsageSafetySnapshot;
  onResumeUsage?: () => void;
  terminalPanes?: TerminalPane[];
  diffReview?: DiffReview;
  sourceControl?: SourceControlState;
  turnSourceControlBaselines?: Record<
    string,
    Record<string, { additions: number; deletions: number }>
  >;
  browserPreview?: BrowserPreview;
  browserNativeHost?: boolean;
  browserOverlayOccluded?: boolean;
  onBrowserBack?: () => void;
  onBrowserForward?: () => void;
  onBrowserReload?: () => void;
  onBrowserUrlChange?: (url: string) => void;
  onBrowserNavigate?: (url: string) => void;
  onBrowserDeviceChange?: (device: BrowserPreviewDevice) => void;
  onBrowserScreenshot?: (action?: BrowserScreenshotAction) => void;
  onBrowserOpenExternal?: () => void;
  onBrowserHostBoundsChange?: (
    bounds: { x: number; y: number; width: number; height: number } | null,
  ) => void;
  onToggleBrowserPanel?: () => void;
  capabilityActivities?: CapabilityActivity[];
  capabilityPolicy?: ProjectCapabilityPolicy;
  modelFocus?: ModelFocus;
  modelFollow?: ModelFollowMode;
  onLoadModelFocusPeek?: (focus: ModelFocus) => Promise<ModelFocusPeekContent>;
  onOpenModelFocus?: (focus: ModelFocus) => void;
  onboarding?: OnboardingState;
  sessionPlan?: SessionPlan;
  sessionGoal?: SessionGoal;
  isGoalComposerActive?: boolean;
  /** When true, this chat is a mission control plane for CLI workers. */
  isMission?: boolean;
  missionWorkers?: TerminalPane[];
  missionDefaultProfileLabel?: string;
  onAddMissionWorker?: () => void;
  onSelectMissionWorker?: (paneId: string) => void;
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
  /**
   * Recent chats for this project plus a way to start a new one, surfaced from
   * the chat title. Only the workspace AI view passes this: the Sessions
   * surface already lists chats in its own sidebar.
   */
  chatSwitcher?: {
    chats: Array<{ id: string; title: string; meta?: string }>;
    activeChatId?: string;
    onSelect: (sessionId: string) => void;
    onNewChat: () => void;
  };
  workspaceMode?: WorkbenchMode;
  showOnboardingSteps?: boolean;
  isEnvironmentRailOpen?: boolean;
  isToolPanelOpen?: boolean;
  isComposerSending?: boolean;
  /** False while desktop shell warm-up is still running. */
  shellReady?: boolean;
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
  /** Older transcript pages exist before the current window. */
  hasMoreBefore?: boolean;
  isLoadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  onCouncilAction?: (
    action: CouncilActionRequest,
  ) => void | Promise<string | void>;
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
  ) => boolean | void | Promise<boolean | void>;
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
  sessionUsage,
  usageSafety,
  onResumeUsage,
  terminalPanes,
  diffReview,
  sourceControl,
  turnSourceControlBaselines,
  browserPreview,
  browserNativeHost = false,
  browserOverlayOccluded = false,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  onBrowserUrlChange,
  onBrowserNavigate,
  onBrowserDeviceChange,
  onBrowserScreenshot,
  onBrowserOpenExternal,
  onBrowserHostBoundsChange,
  onToggleBrowserPanel,
  capabilityActivities = [],
  capabilityPolicy,
  modelFocus,
  modelFollow = "peek",
  onLoadModelFocusPeek,
  onOpenModelFocus,
  onboarding,
  sessionPlan,
  sessionGoal,
  isGoalComposerActive = false,
  isMission = false,
  missionWorkers = [],
  missionDefaultProfileLabel,
  onAddMissionWorker,
  onSelectMissionWorker,
  promptHistory = [],
  chatMode = "normal",
  attachments = [],
  queuedMessages = [],
  savedProjects = [],
  branchName,
  branchCatalog,
  worktreeName,
  chatSwitcher,
  workspaceMode = "local",
  showOnboardingSteps = false,
  activeChatPanel,
  planEditorRequest,
  isEnvironmentRailOpen,
  isToolPanelOpen,
  isComposerSending,
  shellReady = true,
  isTiled = false,
  isBranchLoading,
  maxDraftLength,
  providerStatuses,
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
  hasMoreBefore = false,
  isLoadingEarlier = false,
  onLoadEarlier,
  onCouncilAction,
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
  const [goalDraft, setGoalDraft] = useState("");
  const wasGoalComposerActiveRef = useRef(false);
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
  const [isChatSwitcherOpen, setIsChatSwitcherOpen] = useState(false);
  const chatSwitcherRef = useOutsidePointerDismiss<HTMLDivElement>(
    isChatSwitcherOpen,
    () => setIsChatSwitcherOpen(false),
  );
  const [activePeek, setActivePeek] = useState<{
    focus: ModelFocus;
    isLoading: boolean;
    content?: ModelFocusPeekContent;
    error?: string;
  }>();
  const visibleModelFocus = modelFollow === "off" ? undefined : modelFocus;
  const isModelFocusBusy = Boolean(
    visibleModelFocus &&
    capabilityActivities.some(
      (activity) =>
        activity.callId === visibleModelFocus.callId &&
        ["requested", "waiting", "running"].includes(activity.status),
    ),
  );
  const openModelFocusPeek = useCallback(
    (focus: ModelFocus) => {
      setActivePeek({ focus, isLoading: Boolean(onLoadModelFocusPeek) });
      if (!onLoadModelFocusPeek) return;
      void onLoadModelFocusPeek(focus)
        .then((content) =>
          setActivePeek((current) =>
            current?.focus.callId === focus.callId
              ? { ...current, content, isLoading: false }
              : current,
          ),
        )
        .catch((error: unknown) =>
          setActivePeek((current) =>
            current?.focus.callId === focus.callId
              ? { ...current, error: String(error), isLoading: false }
              : current,
          ),
        );
    },
    [onLoadModelFocusPeek],
  );
  // A peek is tied to one focus; when the model moves on, close it rather than
  // leaving a stale slice hovering over the thread.
  useEffect(() => {
    setActivePeek((current) =>
      current && current.focus.callId !== modelFocus?.callId
        ? undefined
        : current,
    );
  }, [modelFocus?.callId]);
  useEffect(() => {
    setLocalDraft(draft);
  }, [draft, draftResetToken]);
  useEffect(() => {
    if (isGoalComposerActive && !wasGoalComposerActiveRef.current) {
      setGoalDraft(sessionGoal?.text ?? "");
    } else if (!isGoalComposerActive) {
      setGoalDraft("");
    }
    wasGoalComposerActiveRef.current = isGoalComposerActive;
  }, [isGoalComposerActive, sessionGoal?.text]);
  const handleDraftChange = useCallback(
    (value: string) => {
      setLocalDraft(value);
      onDraftChange?.(value);
    },
    [onDraftChange],
  );
  const handleComposerDraftChange = useCallback(
    (value: string) => {
      if (isGoalComposerActive) {
        setGoalDraft(value);
        return;
      }
      handleDraftChange(value);
    },
    [handleDraftChange, isGoalComposerActive],
  );
  const cancelGoalComposer = useCallback(() => {
    setGoalDraft("");
    onCancelGoalComposer?.();
  }, [onCancelGoalComposer]);
  const handleSend = useCallback(async () => {
    if (isGoalComposerActive) {
      const goal = goalDraft.trim();
      if (!goal) return;
      const result = await onGoalAction?.(
        sessionGoal?.text ? "edit" : "set",
        goal,
      );
      if (result === false) return;
      cancelGoalComposer();
      return;
    }
    onSend(localDraft);
  }, [
    cancelGoalComposer,
    goalDraft,
    isGoalComposerActive,
    localDraft,
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
    // A plan-mode turn that wrote the document but skipped the checklist
    // marker is still approvable; only an empty plan is not.
    if (
      !sessionPlan?.updatedAt ||
      (sessionPlan.items.length === 0 && !sessionPlan.content)
    ) {
      return undefined;
    }
    return [
      sessionPlan.sessionId ?? "session",
      sessionPlan.sourceTurnId ?? "plan",
      sessionPlan.updatedAt,
      sessionPlan.content?.length ?? 0,
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
  // Idle transcripts can lag a frame under React concurrency. A live turn cannot:
  // deferred events made the rail freeze mid-stream while the provider kept
  // working, so streaming and status updates always read from the latest list.
  const deferredEvents = useDeferredValue(events);
  const transcriptEvents = isComposerSending ? events : deferredEvents;
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
  }, [transcriptEvents, updateTranscriptScrollPosition]);
  const contextModel = useMemo(() => {
    // Prefer the chat's own model over the global picker state so split panes
    // keep independent context windows when each thread uses a different model.
    const providers = providersForConfig(config);
    const boundToSession = Boolean(
      sessionModel?.providerId &&
        (sessionModel.modelId || sessionModel.modelLabel),
    );
    const providerId = boundToSession
      ? sessionModel?.providerId
      : (config.selectedProviderId ?? sessionModel?.providerId);
    const provider = providers.find((item) => item.id === providerId);
    const modelId = boundToSession
      ? (sessionModel?.modelId ?? provider?.selectedModelId)
      : (provider?.selectedModelId ?? sessionModel?.modelId);
    const model = provider ? getProviderModel(provider, modelId) : undefined;
    return {
      providerId,
      modelId,
      modelLabel:
        (boundToSession ? sessionModel?.modelLabel : undefined) ??
        model?.displayName ??
        sessionModel?.modelLabel ??
        modelId ??
        undefined,
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
      estimateComposerContextUsage(transcriptEvents, localDraft, contextModel),
    [contextModel, localDraft, transcriptEvents],
  );
  const composerProviderUsage = contextModel.providerId
    ? providerUsageByProvider?.[contextModel.providerId]
    : undefined;
  const composerLimits = useMemo(
    () =>
      composerLimitWindows(
        transcriptEvents,
        contextModel,
        composerProviderUsage?.windows ?? [],
      ),
    [composerProviderUsage?.windows, contextModel, transcriptEvents],
  );
  const transcriptState = useMemo(
    () => deriveTranscriptState(transcriptEvents),
    [transcriptEvents],
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
  // Prefer the turn the provider is still driving. If its status has not landed
  // yet (first paint of a new send), keep the latest turn live so the rail does
  // not settle to "Worked" / "Interrupted" while the backend is still going.
  const activeTurnId = isComposerSending
    ? (activeTranscriptTurnId(turns) ?? turns.at(-1)?.id)
    : undefined;
  const transcriptContent = useMemo(
    () => (
      <>
        {looseEvents.map((event) => (
          <ChatEvent
            event={event}
            key={event.id}
            onCouncilAction={onCouncilAction}
            onMutationApprovalAction={onMutationApprovalAction}
            onProviderApprovalAction={onProviderApprovalAction}
            onProviderStatusAction={onProviderStatusAction}
          />
        ))}
        {turns.map((turn, turnIndex) => (
          <ChatTurn
            artifactActions={{
              onOpenFiles: () => onComposerAction?.("open-files"),
              onOpenTool: onOpenToolPanel,
              onOpenExternalPreview: () => onBrowserOpenExternal?.(),
              onSendPrompt: handleArtifactPrompt,
            }}
            isActive={turn.id === activeTurnId}
            key={turn.id}
            onLoadChangeDiff={onLoadChangeDiff}
            onOpenChanges={() => onOpenToolPanel?.("diff")}
            onCouncilAction={onCouncilAction}
            onMutationApprovalAction={onMutationApprovalAction}
            onProviderApprovalAction={onProviderApprovalAction}
            onProviderStatusAction={onProviderStatusAction}
            onReusePrompt={onReusePrompt}
            onContinueChat={
              // Only the latest turn needs Continue — older ones clutter the rail
              // and imply unfinished work on already-finished messages.
              turnIndex === turns.length - 1 ? onContinueChat : undefined
            }
            onOpenPlan={onTogglePlanPanel}
            onPlanDecision={handlePlanDecision}
            plan={sessionPlan}
            isPlanDecisionPending={isPlanDecisionPending}
            isPlanPanelOpen={activeRailPanel === "plan"}
            isPlanReadyForDecision={isPlanReadyForDecision}
            previewCapture={
              browserPreview?.latestCapture
                ? {
                    src: browserPreview.latestCapture.src,
                    path: browserPreview.latestCapture.path,
                  }
                : undefined
            }
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
      onBrowserOpenExternal,
      onComposerAction,
      onCouncilAction,
      onContinueChat,
      onLoadChangeDiff,
      onOpenToolPanel,
      onProviderApprovalAction,
      onProviderStatusAction,
      handlePlanDecision,
      handleArtifactPrompt,
      browserPreview?.latestCapture?.path,
      browserPreview?.latestCapture?.src,
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
      browserNativeHost={browserNativeHost}
      browserOverlayOccluded={browserOverlayOccluded}
      capabilityActivities={capabilityActivities}
      capabilityPolicy={capabilityPolicy}
      diffReview={diffReview}
      sourceControl={sourceControl}
      onPlanItemStatusChange={onPlanItemStatusChange}
      onPlanAction={onPlanAction}
      onGoalAction={onGoalAction}
      editorRequest={planEditorRequest}
      onEditorRequestHandled={onPlanEditorRequestHandled}
      onClose={
        activeRailPanel === "browser"
          ? onToggleBrowserPanel
          : onToggleEnvironmentRail
      }
      onComposerAction={onComposerAction}
      onOpenToolPanel={onOpenToolPanel}
      onTogglePlanPanel={onTogglePlanPanel}
      onBrowserBack={onBrowserBack}
      onBrowserForward={onBrowserForward}
      onBrowserReload={onBrowserReload}
      onBrowserUrlChange={onBrowserUrlChange}
      onBrowserNavigate={onBrowserNavigate}
      onBrowserDeviceChange={onBrowserDeviceChange}
      onBrowserScreenshot={onBrowserScreenshot}
      onBrowserOpenExternal={onBrowserOpenExternal}
      onBrowserHostBoundsChange={onBrowserHostBoundsChange}
      sessionPlan={sessionPlan}
      sessionGoal={sessionGoal}
      terminalPanes={terminalPanes}
      workspaceMode={workspaceMode}
      workspacePath={workspacePath}
      worktreeName={worktreeName}
    />
  ) : null;
  const missionHasWorkers = missionWorkers.length > 0;
  if (turns.length === 0 && looseEvents.length === 0) {
    return (
      <div
        className={[
          "gyro-chat-surface",
          "is-empty",
          isMission ? "is-mission" : "",
          missionHasWorkers ? "has-mission-workers" : "",
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
          className={[
            "gyro-chat-start",
            isMission ? "is-mission" : "",
            missionHasWorkers ? "is-mission-docked" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label={isMission ? "New mission" : "New Chat"}
          style={{ width: "min(860px, 100%)" }}
        >
          {isMission && missionHasWorkers ? null : (
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
          )}
          <h1>
            {isMission ? (
              startProjectLabel ? (
                <>
                  <span>What&apos;s the mission in </span>
                  <span className="gyro-chat-start-brand-word">
                    {startProjectLabel}?
                  </span>
                </>
              ) : (
                <span>What&apos;s the mission goal?</span>
              )
            ) : startProjectLabel ? (
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
          {isMission ? (
            <MissionWorkersBoard
              defaultProfileLabel={missionDefaultProfileLabel}
              goalActive={false}
              onAddWorker={onAddMissionWorker}
              onSelectWorker={onSelectMissionWorker}
              workers={missionWorkers}
            />
          ) : null}
          <Composer
            attachments={attachments}
            chatMode={chatMode}
            config={config}
            constrainToParent={Boolean(activeRailPanel)}
            draft={isGoalComposerActive ? goalDraft : localDraft}
            branchName={branchName}
            branchCatalog={branchCatalog}
            onDraftChange={handleComposerDraftChange}
            onRemoveAttachment={onRemoveAttachment}
            onAttachMediaFiles={onAttachMediaFiles}
            onSend={handleSend}
            onStop={onStopChat}
            isSending={isComposerSending}
            isBranchLoading={isBranchLoading}
            maxDraftLength={maxDraftLength}
            providerReadiness={providerReadiness}
            providerStatuses={providerStatuses}
            providerUsage={composerProviderUsage}
            limitWindows={composerLimits}
            savedProjects={savedProjects}
            shellReady={shellReady}
            variant="hero"
            workspaceMode={workspaceMode}
            workspacePath={workspacePath}
            worktreeName={worktreeName}
            onComposerAction={onComposerAction}
            sessionModel={sessionModel}
            sessionGoal={sessionGoal}
            isGoalComposerActive={isGoalComposerActive}
            onCancelGoalComposer={cancelGoalComposer}
            promptHistory={turns.flatMap((turn) =>
              turn.user ? [turn.user.message] : [],
            )}
            contextUsage={contextUsage}
            sessionUsage={sessionUsage}
            usageSafety={usageSafety}
            onResumeUsage={onResumeUsage}
          />
          <CleanMachineActivation
            showLegacySteps={showOnboardingSteps}
            onboarding={onboarding}
            onCompleteStep={onCompleteOnboardingStep}
            onSelectStep={onSetOnboardingStep}
          />
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
      detail: "Choose another folder",
      icon: Folder,
      label: "New chat in another folder",
    },
  ];
  const threadWorkspaceModeItems: ComposerPopoverItem[] = [
    {
      active: true,
      disabled: true,
      detail: "Fixed for this chat",
      icon: workspaceMode === "worktree" ? GitBranch : Laptop,
      label: workspaceModeLabel(workspaceMode),
    },
    {
      action:
        workspaceMode === "worktree"
          ? "new-local-chat-select-workspace"
          : "start-new-chat-mode:worktree",
      detail:
        workspaceMode === "local"
          ? "Private branch; main project stays untouched"
          : "Choose a folder for a project-folder chat",
      icon: workspaceMode === "local" ? GitPullRequest : Laptop,
      label:
        workspaceMode === "local"
          ? "New agent workspace chat"
          : "New project-folder chat",
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
  const modeLabel = workspaceModeLabel(workspaceMode);

  return (
    <div
      className={[
        "gyro-chat-surface",
        "is-thread",
        isTiled ? "is-tiled" : "",
        activeRailPanel ? "has-environment" : "",
        activeRailPanel === "plan" && sessionPlan?.content ? "has-plan" : "",
        workspaceMode === "worktree" ? "is-agent-workspace" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onDragOver={handleMediaDragOver}
      onDrop={handleMediaDrop}
    >
      <div className="gyro-chat-thread-topbar">
        <div className="gyro-chat-thread-identity">
          {chatSwitcher ? (
            <div className="gyro-chat-switcher" ref={chatSwitcherRef}>
              <button
                aria-expanded={isChatSwitcherOpen}
                aria-haspopup="menu"
                aria-label="Recent chats"
                className="gyro-chat-switcher-trigger"
                onClick={() => setIsChatSwitcherOpen((open) => !open)}
                title="Recent chats"
                type="button"
              >
                <ChatSwitcherIcon />
              </button>
              {isChatSwitcherOpen ? (
                <div className="gyro-chat-switcher-menu" role="menu">
                  <button
                    className="gyro-chat-switcher-item is-action"
                    onClick={() => {
                      setIsChatSwitcherOpen(false);
                      chatSwitcher.onNewChat();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <Plus size={13} />
                    New chat
                  </button>
                  {chatSwitcher.chats.length > 0 ? (
                    <>
                      <span className="gyro-chat-switcher-label">Recent</span>
                      {chatSwitcher.chats.map((chat) => (
                        <button
                          aria-current={
                            chat.id === chatSwitcher.activeChatId
                              ? "true"
                              : undefined
                          }
                          className={
                            chat.id === chatSwitcher.activeChatId
                              ? "gyro-chat-switcher-item is-active"
                              : "gyro-chat-switcher-item"
                          }
                          key={chat.id}
                          onClick={() => {
                            setIsChatSwitcherOpen(false);
                            chatSwitcher.onSelect(chat.id);
                          }}
                          role="menuitem"
                          title={chat.title}
                          type="button"
                        >
                          <MessageSquare size={13} />
                          <span>{chat.title}</span>
                          {chat.meta ? <small>{chat.meta}</small> : null}
                        </button>
                      ))}
                    </>
                  ) : (
                    <div className="gyro-chat-switcher-empty">
                      No other chats in this project
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          <strong>{sessionTitle ?? "Gyro session"}</strong>
          {workspaceMode === "worktree" ? (
            <span
              className="gyro-thread-mode-badge is-agent-workspace"
              title={workspaceModeTechnicalHint("worktree")}
            >
              <GitBranch aria-hidden="true" size={11} />
              Agent workspace
              {worktreeName ? <em>{worktreeName}</em> : null}
            </span>
          ) : null}
        </div>
        <div className="gyro-thread-topbar-actions">
          <div className="gyro-thread-pills" ref={threadContextMenuRef}>
            <div className="gyro-thread-context-control is-workspace-context">
              <button
                aria-label={`Workspace: ${workspaceName(workspacePath)}, branch ${branchLabel}, ${modeLabel}`}
                aria-controls={
                  activeThreadContextMenu === "workspace"
                    ? "gyro-thread-workspace-menu"
                    : undefined
                }
                aria-expanded={activeThreadContextMenu === "workspace"}
                aria-haspopup="menu"
                className={[
                  "gyro-thread-pill-button",
                  "gyro-thread-workspace-context-button",
                  workspaceMode === "worktree" ? "is-agent-workspace" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => {
                  setActiveThreadContextMenu((current) =>
                    current === "workspace" ? null : "workspace",
                  );
                  if (activeThreadContextMenu !== "workspace") {
                    onComposerAction?.("select-branch");
                  }
                }}
                type="button"
                title={`${workspaceName(workspacePath)} / ${branchLabel} / ${modeLabel}`}
              >
                <GitBranch aria-hidden="true" size={13} />
                <em className="gyro-thread-context-branch">{branchLabel}</em>
                <ChevronDown aria-hidden="true" size={12} />
              </button>
              {activeThreadContextMenu === "workspace" ? (
                <ComposerPopover
                  align="end"
                  className="gyro-thread-workspace-menu"
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
            modelFocus={visibleModelFocus}
            onCloseChat={onCloseChat}
            onToggleToolPanel={onToggleToolPanel}
            onToggleEnvironmentRail={onToggleEnvironmentRail}
            onTogglePlanPanel={onTogglePlanPanel}
            onToggleBrowserPanel={onToggleBrowserPanel}
            planItemCount={sessionPlan?.items.length ?? 0}
          />
        </div>
      </div>

      <section className="gyro-chat-thread-canvas" aria-label="Chat">
        <div
          aria-busy={isComposerSending || isLoadingEarlier}
          aria-live="polite"
          aria-relevant="additions text"
          className="gyro-thread-body gyro-chat-transcript"
          onScroll={updateTranscriptScrollPosition}
          ref={transcriptRef}
          role="log"
        >
          {hasMoreBefore && onLoadEarlier ? (
            <div className="gyro-chat-load-earlier">
              <button
                disabled={isLoadingEarlier}
                onClick={onLoadEarlier}
                type="button"
              >
                {isLoadingEarlier ? "Loading earlier…" : "Load earlier messages"}
              </button>
            </div>
          ) : null}
          {isMission ? (
            <MissionWorkersBoard
              defaultProfileLabel={missionDefaultProfileLabel}
              goalActive
              onAddWorker={onAddMissionWorker}
              onSelectWorker={onSelectMissionWorker}
              workers={missionWorkers}
            />
          ) : null}
          {transcriptContent}
        </div>

        <div className="gyro-chat-composer-dock">
          {activePeek ? (
            <ModelFocusPeek
              content={activePeek.content}
              error={activePeek.error}
              focus={activePeek.focus}
              isLoading={activePeek.isLoading}
              onClose={() => setActivePeek(undefined)}
              onOpen={() => {
                const focus = activePeek.focus;
                setActivePeek(undefined);
                onOpenModelFocus?.(focus);
              }}
            />
          ) : null}
          {visibleModelFocus ? (
            <ModelFocusStrip
              focus={visibleModelFocus}
              isBusy={isModelFocusBusy}
              onOpen={() => onOpenModelFocus?.(visibleModelFocus)}
              onPeek={() => openModelFocusPeek(visibleModelFocus)}
            />
          ) : null}
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
              onOpenPlan={onTogglePlanPanel}
              plan={sessionPlan}
            />
          ) : null}
          <Composer
            attachments={attachments}
            chatMode={chatMode}
            config={config}
            constrainToParent={Boolean(activeRailPanel)}
            draft={isGoalComposerActive ? goalDraft : localDraft}
            branchName={branchName}
            onDraftChange={handleComposerDraftChange}
            onRemoveAttachment={onRemoveAttachment}
            onAttachMediaFiles={onAttachMediaFiles}
            onSend={handleSend}
            onStop={onStopChat}
            isSending={isComposerSending}
            maxDraftLength={maxDraftLength}
            providerReadiness={providerReadiness}
            providerStatuses={providerStatuses}
            providerUsage={composerProviderUsage}
            limitWindows={composerLimits}
            savedProjects={savedProjects}
            shellReady={shellReady}
            workspaceMode={workspaceMode}
            workspacePath={workspacePath}
            worktreeName={worktreeName}
            onComposerAction={onComposerAction}
            sessionModel={sessionModel}
            sessionGoal={sessionGoal}
            isGoalComposerActive={isGoalComposerActive}
            onCancelGoalComposer={cancelGoalComposer}
            promptHistory={turns.flatMap((turn) =>
              turn.user ? [turn.user.message] : [],
            )}
            contextUsage={contextUsage}
            sessionUsage={sessionUsage}
            usageSafety={usageSafety}
            onResumeUsage={onResumeUsage}
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

/** Steps shown before the card defers to the plan document. */
const PLAN_DECISION_VISIBLE_STEPS = 5;

function PlanDecisionCard({
  isPending,
  onDecision,
  onOpenPlan,
  plan,
}: {
  isPending: boolean;
  onDecision: (decision: "approve" | "reject") => void;
  onOpenPlan?: () => void;
  plan: SessionPlan;
}) {
  const visibleItems = plan.items.slice(0, PLAN_DECISION_VISIBLE_STEPS);
  const hiddenCount = plan.items.length - visibleItems.length;
  const stepLabel =
    plan.items.length > 0
      ? `${plan.items.length} ${plan.items.length === 1 ? "step" : "steps"}`
      : "Plan document";
  return (
    <section
      aria-label="Plan ready for approval"
      className={`gyro-plan-decision-card${isPending ? " is-pending" : ""}`}
    >
      <header>
        <div>
          <strong>{plan.title || "Implementation plan"}</strong>
          <small>{stepLabel} · read-only until you approve</small>
        </div>
      </header>
      {visibleItems.length > 0 ? (
        <ol>
          {visibleItems.map((item, index) => (
            <li key={item.id}>
              {/* Every step reads `todo` at this moment, so identical status
                  glyphs carry nothing; the ordinal carries the sequence. */}
              <span aria-hidden="true">
                {item.status === "complete" ? (
                  <Check size={12} />
                ) : item.status === "blocked" ? (
                  <X size={12} />
                ) : (
                  index + 1
                )}
              </span>
              <div>
                <strong>{item.title}</strong>
                {item.detail ? <small>{item.detail}</small> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="gyro-plan-decision-summary">
          The full plan is written up in the Plan document.
        </p>
      )}
      {hiddenCount > 0 || visibleItems.length === 0 ? (
        <button
          className="gyro-plan-decision-more"
          onClick={onOpenPlan}
          type="button"
        >
          <ListChecks size={12} />
          {hiddenCount > 0 ? `+${hiddenCount} more · open plan` : "Open plan"}
        </button>
      ) : null}
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
      {isPending ? (
        <span aria-hidden="true" className="gyro-plan-decision-progress" />
      ) : null}
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
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useOutsidePointerDismiss<HTMLDivElement>(
    menuMessageId !== undefined,
    () => setMenuState(undefined),
    menuTriggerRef,
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
                ref={menuMessageId === message.id ? menuTriggerRef : undefined}
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
                ref={menuRef}
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

/**
 * A slice of whatever the model is looking at, rendered over the thread so the
 * user can check on it without the app navigating away.
 */
export type ModelFocusPeekContent = {
  title: string;
  subtitle?: string;
  lines: string[];
  /** 1-based number of the first entry in `lines`, for the gutter. */
  startLine?: number;
  highlightLine?: number;
};

function ModelFocusIcon({ kind }: { kind: ModelFocus["kind"] }) {
  if (kind === "terminal") return <Terminal size={14} />;
  if (kind === "browser") return <Globe2 size={14} />;
  if (kind === "output") return <ScrollText size={14} />;
  if (kind === "proposal") return <GitPullRequest size={14} />;
  return <FileCode2 size={14} />;
}

function modelFocusVerb(focus: ModelFocus) {
  switch (focus.kind) {
    case "terminal":
      return "Running";
    case "browser":
      return "Browsing";
    case "output":
      return focus.detail === "Tests" ? "Testing" : "Output";
    case "proposal":
      return "Proposing";
    default:
      return focus.path ? "Reading" : "Opened";
  }
}

function modelFocusHeadline(focus: ModelFocus) {
  if (focus.kind === "ide" && focus.path && focus.line) {
    return `${focus.label}:${focus.line}`;
  }
  if (focus.kind === "browser" || focus.kind === "terminal") {
    return focus.detail ?? focus.label;
  }
  return focus.label;
}

/**
 * The ambient "the model is working here" line above the composer. It reports
 * position only; navigating is always the user's own click.
 */
function ModelFocusStrip({
  focus,
  isBusy,
  onOpen,
  onPeek,
}: {
  focus: ModelFocus;
  isBusy: boolean;
  onOpen: () => void;
  onPeek: () => void;
}) {
  return (
    <div
      aria-live="polite"
      className={[
        "gyro-model-focus-strip",
        `is-${focus.kind}`,
        isBusy ? "is-busy" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span aria-hidden="true" className="gyro-model-focus-icon">
        <ModelFocusIcon kind={focus.kind} />
      </span>
      <button
        aria-label={`Peek at ${modelFocusHeadline(focus)} without leaving the thread`}
        className="gyro-model-focus-label"
        onClick={onPeek}
        title="Peek without leaving the thread"
        type="button"
      >
        <strong>{modelFocusVerb(focus)}</strong>
        <span>{modelFocusHeadline(focus)}</span>
      </button>
      <button className="gyro-model-focus-open" onClick={onOpen} type="button">
        Open in workspace
      </button>
    </div>
  );
}

function ModelFocusPeek({
  content,
  error,
  focus,
  isLoading,
  onClose,
  onOpen,
}: {
  content?: ModelFocusPeekContent;
  error?: string;
  focus: ModelFocus;
  isLoading: boolean;
  onClose: () => void;
  onOpen: () => void;
}) {
  const scopeRef = useOutsidePointerDismiss<HTMLDivElement>(true, onClose);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
  const startLine = content?.startLine ?? 1;
  return (
    <div
      aria-label="Model activity peek"
      className="gyro-model-focus-peek"
      ref={scopeRef}
      role="dialog"
    >
      <header>
        <span aria-hidden="true">
          <ModelFocusIcon kind={focus.kind} />
        </span>
        <div>
          <strong>{content?.title ?? modelFocusHeadline(focus)}</strong>
          {(content?.subtitle ?? focus.detail) ? (
            <small>{content?.subtitle ?? focus.detail}</small>
          ) : null}
        </div>
        <button
          aria-label="Close peek"
          className="gyro-chat-tool-close"
          onClick={onClose}
          type="button"
        >
          <X size={14} />
        </button>
      </header>
      <div className="gyro-model-focus-peek-body">
        {isLoading ? (
          <p className="is-pending">Loading…</p>
        ) : error ? (
          <p className="is-pending">{error}</p>
        ) : content && content.lines.length > 0 ? (
          <pre>
            {content.lines.map((line, index) => {
              const lineNumber = startLine + index;
              return (
                <code
                  className={
                    lineNumber === content.highlightLine
                      ? "is-highlighted"
                      : undefined
                  }
                  key={lineNumber}
                >
                  <small>{lineNumber}</small>
                  <span>{line || " "}</span>
                </code>
              );
            })}
          </pre>
        ) : (
          <p className="is-pending">Nothing to preview yet.</p>
        )}
      </div>
      <footer>
        <button onClick={onOpen} type="button">
          Open in workspace
        </button>
      </footer>
    </div>
  );
}

function ChatSurfaceControls({
  activePanel,
  isToolPanelOpen,
  modelFocus,
  onCloseChat,
  onToggleToolPanel,
  onToggleEnvironmentRail,
  onTogglePlanPanel,
  onToggleBrowserPanel,
  planItemCount,
}: {
  activePanel?: ChatSidePanelId;
  isToolPanelOpen: boolean;
  modelFocus?: ModelFocus;
  onCloseChat?: () => void;
  onToggleToolPanel?: () => void;
  onToggleEnvironmentRail?: () => void;
  onTogglePlanPanel?: () => void;
  onToggleBrowserPanel?: () => void;
  planItemCount: number;
}) {
  // Peripheral awareness: the surface holding the model's latest work gets a
  // dot, so it can be found without anything moving on its own.
  const drawerHasModelActivity = Boolean(
    modelFocus?.paneTab && !isToolPanelOpen,
  );
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
          drawerHasModelActivity ? "has-model-activity" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={onToggleToolPanel}
        title={
          drawerHasModelActivity
            ? `Bottom drawer · model activity in ${modelFocus?.paneTab}`
            : "Bottom drawer"
        }
        type="button"
      >
        <PanelBottom size={15} />
        {drawerHasModelActivity ? (
          <span aria-hidden="true" className="gyro-model-activity-dot" />
        ) : null}
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
          activePanel === "browser" ? "Close browser rail" : "Open browser rail"
        }
        aria-pressed={activePanel === "browser"}
        className={[
          "gyro-chat-surface-button",
          activePanel === "browser" ? "is-active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={onToggleBrowserPanel}
        title="Browser"
        type="button"
      >
        <Globe2 size={15} />
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
          // The grid slot focuses its pane on pointerdown, which for this button
          // means focusing the pane on the way to closing it — making the chat
          // being closed the active session, and costing the previously focused
          // pane its focus once the close goes through.
          onPointerDown={(event) => event.stopPropagation()}
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
  browserNativeHost = false,
  browserOverlayOccluded = false,
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
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  onBrowserUrlChange,
  onBrowserNavigate,
  onBrowserDeviceChange,
  onBrowserScreenshot,
  onBrowserOpenExternal,
  onBrowserHostBoundsChange,
  sessionPlan,
  sessionGoal,
  terminalPanes = [],
  workspacePath,
}: {
  activePanel: ChatSidePanelId;
  branchName?: string;
  browserPreview?: BrowserPreview;
  browserNativeHost?: boolean;
  browserOverlayOccluded?: boolean;
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
  ) => boolean | void | Promise<boolean | void>;
  editorRequest?: {
    kind: "goal" | "item";
    token: number;
  };
  onEditorRequestHandled?: () => void;
  onClose?: () => void;
  onComposerAction?: (action: string) => void;
  onOpenToolPanel?: (tab: WorkbenchPaneTab) => void;
  onTogglePlanPanel?: () => void;
  onBrowserBack?: () => void;
  onBrowserForward?: () => void;
  onBrowserReload?: () => void;
  onBrowserUrlChange?: (url: string) => void;
  onBrowserNavigate?: (url: string) => void;
  onBrowserDeviceChange?: (device: BrowserPreviewDevice) => void;
  onBrowserScreenshot?: (action?: BrowserScreenshotAction) => void;
  onBrowserOpenExternal?: () => void;
  onBrowserHostBoundsChange?: (
    bounds: { x: number; y: number; width: number; height: number } | null,
  ) => void;
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
  const submitGoalEditor = async () => {
    const text = goalEditor?.trim();
    if (goalEditor === undefined || !text) return;
    const result = await onGoalAction?.(
      sessionGoal?.text ? "edit" : "set",
      text,
    );
    if (result === false) return;
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

  if (activePanel === "browser") {
    return (
      <ResizableBrowserRail
        browserNativeHost={browserNativeHost}
        browserOverlayOccluded={browserOverlayOccluded}
        browserPreview={browserPreview}
        onBrowserBack={onBrowserBack}
        onBrowserDeviceChange={onBrowserDeviceChange}
        onBrowserForward={onBrowserForward}
        onBrowserHostBoundsChange={onBrowserHostBoundsChange}
        onBrowserNavigate={onBrowserNavigate}
        onBrowserOpenExternal={onBrowserOpenExternal}
        onBrowserReload={onBrowserReload}
        onBrowserScreenshot={onBrowserScreenshot}
        onBrowserUrlChange={onBrowserUrlChange}
        onClose={onClose}
      />
    );
  }

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
        <details
          className="gyro-capability-policy-summary"
          aria-label="Model permissions"
        >
          <summary>
            <ShieldCheck size={15} />
            <strong>Permissions</strong>
            <small>
              {capabilityActivities.filter((item) =>
                ["requested", "waiting", "running"].includes(item.status),
              ).length
                ? `${capabilityActivities.filter((item) => ["requested", "waiting", "running"].includes(item.status)).length} active`
                : capabilityPolicySummary(capabilityPolicy)}
            </small>
            <ChevronDown aria-hidden="true" size={13} />
          </summary>
          <div className="gyro-capability-policy-details">
            <div>
              <span>Workspace</span>
              <strong>{capabilityPolicy.classes["workspace-inspect"]}</strong>
            </div>
            <div>
              <span>Terminal</span>
              <strong>{capabilityPolicy.classes["terminal-execute"]}</strong>
            </div>
            <div>
              <span>Browser</span>
              <strong>{capabilityPolicy.classes["browser-navigate"]}</strong>
            </div>
          </div>
        </details>
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
        {changesLabel === "No changes" ? null : <small>{changesLabel}</small>}
      </button>
      <button
        aria-label={`Open Terminal, ${terminalLabel}`}
        onClick={() => onOpenTool("terminal")}
        className={runningPanes > 0 ? "has-activity" : undefined}
        type="button"
      >
        <Terminal size={15} />
        <span>Terminal</span>
        {terminalLabel === "Ready" ? null : <small>{terminalLabel}</small>}
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
        {browserLabel === "Ready" ? null : <small>{browserLabel}</small>}
      </button>
      <button
        aria-label={`Open files in Workspace, ${workspaceName(workspacePath)}`}
        onClick={onOpenFiles}
        type="button"
      >
        <Folder size={15} />
        <span>Files</span>
        <small>Open</small>
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
        {planItemCount > 0 ? <small>{planLabel}</small> : null}
      </button>
    </nav>
  );
}

function capabilityPolicySummary(policy: ProjectCapabilityPolicy) {
  const access = [
    policy.classes["workspace-inspect"],
    policy.classes["terminal-execute"],
    policy.classes["browser-navigate"],
  ];
  const labels = (["allow", "ask", "deny"] as const)
    .map((level) => ({
      count: access.filter((value) => value === level).length,
      level,
    }))
    .filter(({ count }) => count > 0)
    .map(({ count, level }) => `${count} ${level}`);
  return labels.join(" · ");
}

function chatToolBrowserStatusLabel(browserPreview?: BrowserPreview) {
  if (browserPreview?.captureStatus === "capturing") {
    return "Capturing";
  }
  switch (browserPreview?.status) {
    case "loading":
      return "Loading";
    case "verification-passed":
    case "ready":
      return "Live";
    case "console-error": {
      const count = browserPreview.consoleErrors;
      return count > 0
        ? `${count} issue${count === 1 ? "" : "s"}`
        : "Issues";
    }
    case "verification-failed":
      return "Unreachable";
    case "idle":
    default:
      return "Idle";
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
  const focusedPane =
    panes.find((pane) => pane.id === selectedTerminalPaneId) ?? panes[0];
  const focusedProfile = focusedPane
    ? terminalProfiles.find((profile) => profile.id === focusedPane.profileId)
    : undefined;
  // Only the backend can confirm a pane launched under Gyro's approval policy.
  // Without that confirmation the rail says so plainly rather than showing a
  // reassuring badge the pane does not earn.
  const governedPanes = panes.filter((pane) => pane.governedSessionId);
  const focusedGoverned = Boolean(focusedPane?.governedSessionId);

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
            <ContextMetric
              label="Agent"
              value={
                focusedProfile?.displayName ??
                focusedPane?.profileId ??
                "no pane"
              }
              tone="slate"
            />
            <ContextMetric
              label="Branch"
              value={
                focusedPane?.worktreeName ?? focusedPane?.branch ?? "no pane"
              }
            />
            <ContextMetric
              label="Panes"
              value={
                governedPanes.length > 0
                  ? `${panes.length}/16 · ${governedPanes.length} governed`
                  : `${panes.length}/16`
              }
            />
            <ContextMetric
              label="Approval"
              value={
                !focusedPane
                  ? "no pane"
                  : focusedGoverned
                    ? "via Gyro"
                    : "terminal only"
              }
              tone={focusedGoverned ? "slate" : "amber"}
            />
          </div>
          {focusedPane ? (
            <div className="gyro-muted-note">
              {focusedGoverned
                ? "This pane's file edits arrive as Gyro proposals you review in Diff review."
                : "This pane runs like any terminal. Gyro cannot review its file edits."}
            </div>
          ) : null}
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
                    <span>
                      {session.governedSessionId
                        ? `${session.profileId} · governed`
                        : session.profileId}
                    </span>
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

function workspaceSettingsList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function WorkspaceSettingsEditor({
  activeWorkspaceRoot,
  folderSettings = {},
  languageServers = [],
  onChange,
  userSettings = {},
  workspacePath,
  workspaceRoots,
  workspaceSettings = {},
  keybindings = {},
  onKeybindingChange,
  contributions = [],
  onRegisterContribution,
  onToggleContribution,
  onRemoveContribution,
  view,
}: {
  activeWorkspaceRoot?: string;
  folderSettings?: Record<string, WorkspaceScopedSettings>;
  languageServers?: LanguageServerState[];
  onChange?: (
    scope: WorkspaceSettingScope,
    path: string | undefined,
    settings: WorkspaceScopedSettings,
  ) => void;
  userSettings?: WorkspaceScopedSettings;
  workspacePath?: string;
  workspaceRoots: string[];
  workspaceSettings?: Record<string, WorkspaceScopedSettings>;
  keybindings?: Record<string, WorkspaceKeybinding | null>;
  onKeybindingChange?: (
    commandId: string,
    keybinding?: WorkspaceKeybinding | null,
  ) => void;
  contributions?: IdeContribution[];
  onRegisterContribution?: (contribution: IdeContribution) => void;
  onToggleContribution?: (id: string, enabled: boolean) => void;
  onRemoveContribution?: (id: string) => void;
  view: "editor" | "tools";
}) {
  const [scope, setScope] = useState<WorkspaceSettingScope>(
    workspacePath ? "workspace" : "user",
  );
  const [folderPath, setFolderPath] = useState(
    activeWorkspaceRoot ?? workspaceRoots[0] ?? "",
  );
  const contributionInputRef = useRef<HTMLInputElement>(null);
  const [contributionError, setContributionError] = useState("");
  useEffect(() => {
    if (activeWorkspaceRoot && workspaceRoots.includes(activeWorkspaceRoot)) {
      setFolderPath(activeWorkspaceRoot);
    }
  }, [activeWorkspaceRoot, workspaceRoots]);
  useEffect(() => {
    if (!workspacePath && scope !== "user") {
      setScope("user");
    }
  }, [scope, workspacePath]);
  const path =
    scope === "workspace"
      ? workspacePath
      : scope === "folder"
        ? folderPath
        : undefined;
  const settings =
    scope === "user"
      ? userSettings
      : scope === "workspace"
        ? (workspaceSettings[workspacePath ?? ""] ?? {})
        : (folderSettings[folderPath] ?? {});
  const update = (next: WorkspaceScopedSettings) =>
    onChange?.(scope, path, next);
  const inheritedLabel = scope === "user" ? "Use default" : "Inherit";

  return (
    <section
      aria-labelledby="gyro-workspace-settings-title"
      className="gyro-workspace-settings-editor"
    >
      <header>
        <span className="gyro-workspace-settings-eyebrow">
          <Settings size={13} /> Workspace configuration
        </span>
        <h1 id="gyro-workspace-settings-title">
          {view === "editor" ? "Editor & Search" : "Tools & Contributions"}
        </h1>
        <p>
          {view === "editor"
            ? "Tune editor and search behavior at user, workspace, or folder scope. Narrower scopes override broader ones."
            : "Manage workspace commands, language services, and trusted local contributions."}
        </p>
      </header>
      {view === "editor" ? (
        <>
          <div
            aria-label="Settings scope"
            className="gyro-workspace-settings-scopes"
          >
            {(["user", "workspace", "folder"] as WorkspaceSettingScope[]).map(
              (item) => (
                <button
                  aria-pressed={scope === item}
                  className={scope === item ? "is-active" : undefined}
                  disabled={item !== "user" && !workspacePath}
                  key={item}
                  onClick={() => setScope(item)}
                  title={
                    item !== "user" && !workspacePath
                      ? "Open a project to configure this scope"
                      : undefined
                  }
                  type="button"
                >
                  {item[0]?.toUpperCase()}
                  {item.slice(1)}
                </button>
              ),
            )}
          </div>
          {!workspacePath ? (
            <p className="gyro-workspace-settings-empty">
              Open a project to configure workspace and folder overrides.
            </p>
          ) : null}
          {scope === "folder" && workspaceRoots.length > 0 ? (
            <label className="gyro-workspace-settings-folder">
              <span>Folder</span>
              <select
                onChange={(event) => setFolderPath(event.target.value)}
                value={folderPath}
              >
                {workspaceRoots.map((root) => (
                  <option key={root} value={root}>
                    {root.split("/").filter(Boolean).at(-1) ?? root}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="gyro-workspace-settings-list">
            <label>
              <span>
                <strong>Files: Exclude</strong>
                <small>Comma-separated globs hidden from Explorer.</small>
              </span>
              <input
                onChange={(event) =>
                  update({
                    ...settings,
                    filesExclude: workspaceSettingsList(event.target.value),
                  })
                }
                placeholder={`${inheritedLabel}: .git/**, node_modules/**`}
                value={(settings.filesExclude ?? []).join(", ")}
              />
            </label>
            <label>
              <span>
                <strong>Search: Exclude</strong>
                <small>
                  Comma-separated globs skipped by workspace search.
                </small>
              </span>
              <input
                onChange={(event) =>
                  update({
                    ...settings,
                    searchExclude: workspaceSettingsList(event.target.value),
                  })
                }
                placeholder={`${inheritedLabel}: .git/**, dist/**`}
                value={(settings.searchExclude ?? []).join(", ")}
              />
            </label>
            <label>
              <span>
                <strong>Search: Maximum Results</strong>
                <small>Caps results between 10 and 1,000.</small>
              </span>
              <input
                max={1000}
                min={10}
                onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  update({
                    ...settings,
                    searchMaxResults: Number.isFinite(value)
                      ? value
                      : undefined,
                  });
                }}
                placeholder={inheritedLabel}
                type="number"
                value={settings.searchMaxResults ?? ""}
              />
            </label>
            <label>
              <span>
                <strong>Editor: Minimap</strong>
                <small>
                  Shows a compact document overview beside the editor.
                </small>
              </span>
              <select
                onChange={(event) =>
                  update({
                    ...settings,
                    editorMinimapEnabled:
                      event.target.value === "inherit"
                        ? undefined
                        : event.target.value === "on",
                  })
                }
                value={
                  settings.editorMinimapEnabled === undefined
                    ? "inherit"
                    : settings.editorMinimapEnabled
                      ? "on"
                      : "off"
                }
              >
                <option value="inherit">{inheritedLabel}</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
          </div>
          {scope !== "user" ? (
            <button
              className="gyro-workspace-settings-reset"
              disabled={Object.keys(settings).length === 0}
              onClick={() => update({})}
              type="button"
            >
              Reset {scope} overrides
            </button>
          ) : null}
        </>
      ) : (
        <>
          <section className="gyro-workspace-services">
            <header>
              <h2>Language services</h2>
              <p>
                Detected locally for the active project. Gyro does not
                auto-install external tools.
              </p>
            </header>
            <div>
              {languageServers.length > 0 ? (
                languageServers.map((server) => (
                  <article key={server.id}>
                    <span>
                      <strong>{server.languageId}</strong>
                      <small>{server.message ?? server.command}</small>
                    </span>
                    <em data-status={server.status}>{server.status}</em>
                  </article>
                ))
              ) : (
                <p>No language services detected for the current project.</p>
              )}
            </div>
          </section>
          <section className="gyro-workspace-keybindings">
            <header>
              <div>
                <h2>Keyboard shortcuts</h2>
                <p>
                  Focus a shortcut and press the key combination to reassign it.
                </p>
              </div>
              <kbd>{isMacPlatform() ? "⌘" : "Ctrl"}</kbd>
            </header>
            <div>
              {workspaceCommandRegistry.map((command) => {
                const hasOverride = command.id in keybindings;
                const binding = hasOverride
                  ? keybindings[command.id]
                  : command.keybinding;
                const collision = binding
                  ? workspaceCommandRegistry.find((candidate) => {
                      if (candidate.id === command.id) return false;
                      const candidateBinding =
                        candidate.id in keybindings
                          ? keybindings[candidate.id]
                          : candidate.keybinding;
                      return (
                        candidateBinding &&
                        workspaceKeybindingSignature(candidateBinding) ===
                          workspaceKeybindingSignature(binding)
                      );
                    })
                  : undefined;
                return (
                  <label key={command.id}>
                    <span>
                      <strong>{command.label}</strong>
                      <small>
                        {collision
                          ? `Conflicts with ${collision.label}`
                          : command.description}
                      </small>
                    </span>
                    <input
                      aria-label={`Keybinding for ${command.label}`}
                      className={collision ? "is-conflict" : undefined}
                      onKeyDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.key === "Escape") {
                          event.currentTarget.blur();
                          return;
                        }
                        if (
                          (event.key === "Backspace" ||
                            event.key === "Delete") &&
                          !event.metaKey &&
                          !event.ctrlKey &&
                          !event.altKey
                        ) {
                          onKeybindingChange?.(command.id, undefined);
                          return;
                        }
                        if (
                          ["Meta", "Control", "Alt", "Shift"].includes(
                            event.key,
                          )
                        ) {
                          return;
                        }
                        const mac = isMacPlatform();
                        onKeybindingChange?.(command.id, {
                          key: event.key.toLowerCase(),
                          primary: mac ? event.metaKey : event.ctrlKey,
                          control: mac ? event.ctrlKey : false,
                          shift: event.shiftKey,
                          alt: event.altKey,
                        });
                      }}
                      placeholder="Unassigned"
                      readOnly
                      value={binding ? workspaceKeybindingLabel(binding) : ""}
                    />
                    {hasOverride ? (
                      <button
                        aria-label={`Reset keybinding for ${command.label}`}
                        onClick={() =>
                          onKeybindingChange?.(command.id, undefined)
                        }
                        title="Reset to default"
                        type="button"
                      >
                        <RefreshCw size={12} />
                      </button>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </section>
          <section className="gyro-workspace-contributions">
            <header>
              <div>
                <h2>Local contributions</h2>
                <p>
                  Declarative commands and views loaded from a local manifest.
                  Contributions stay disabled until you enable them.
                </p>
              </div>
              <button
                onClick={() => contributionInputRef.current?.click()}
                type="button"
              >
                <Plus size={13} /> Install from manifest
              </button>
              <input
                accept=".json,.gyro-extension"
                aria-label="Install local contribution manifest"
                hidden
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  try {
                    const contribution = parsedLocalIdeContribution(
                      JSON.parse(await file.text()),
                      file.name,
                    );
                    onRegisterContribution?.(contribution);
                    setContributionError("");
                  } catch (error) {
                    setContributionError(String(error));
                  }
                }}
                ref={contributionInputRef}
                type="file"
              />
            </header>
            {contributionError ? (
              <p className="gyro-workspace-contribution-error" role="alert">
                {contributionError}
              </p>
            ) : null}
            <div className="gyro-workspace-contribution-list">
              {contributions.map((contribution) => (
                <article key={contribution.id}>
                  <div className="gyro-workspace-contribution-title">
                    <Settings size={14} />
                    <span>
                      <strong>{contribution.label}</strong>
                      <small>
                        {contribution.publisher} · v{contribution.version} ·{" "}
                        {contribution.source === "core"
                          ? "bundled with Gyro"
                          : (contribution.manifestName ?? "local manifest")}
                      </small>
                    </span>
                    <em className={`is-${contribution.source}`}>
                      {contribution.source}
                    </em>
                  </div>
                  <div className="gyro-workspace-contribution-permissions">
                    {contribution.permissions.map((permission) => (
                      <span key={permission}>
                        <ShieldCheck size={10} /> {permission}
                      </span>
                    ))}
                  </div>
                  <div className="gyro-workspace-contribution-actions">
                    <button
                      disabled={contribution.source === "core"}
                      onClick={() =>
                        onToggleContribution?.(
                          contribution.id,
                          !contribution.enabled,
                        )
                      }
                      type="button"
                    >
                      {contribution.enabled ? "Disable" : "Enable"}
                    </button>
                    {contribution.source === "local" ? (
                      <button
                        className="is-danger"
                        onClick={() => onRemoveContribution?.(contribution.id)}
                        type="button"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </section>
  );
}

function parsedLocalIdeContribution(
  value: unknown,
  manifestName: string,
): IdeContribution {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Contribution manifest must contain a JSON object");
  }
  const manifest = value as Record<string, unknown>;
  const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
  const label = typeof manifest.label === "string" ? manifest.label.trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]{1,99}$/i.test(id) || !label) {
    throw new Error("Contribution manifest needs a valid id and label");
  }
  const viewIds: IdeViewId[] = [
    "explorer",
    "search",
    "source-control",
    "run-test",
    "ai",
    "settings",
  ];
  const views = Array.isArray(manifest.views)
    ? manifest.views.filter(
        (view): view is IdeViewId =>
          typeof view === "string" && viewIds.includes(view as IdeViewId),
      )
    : [];
  const categories = [
    "file",
    "edit",
    "view",
    "source-control",
    "run",
    "ai",
  ] as const;
  const commands = Array.isArray(manifest.commands)
    ? manifest.commands.slice(0, 100).flatMap((candidate) => {
        if (
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        )
          return [];
        const command = candidate as Record<string, unknown>;
        if (typeof command.id !== "string" || typeof command.label !== "string")
          return [];
        const category = categories.includes(
          command.category as (typeof categories)[number],
        )
          ? (command.category as (typeof categories)[number])
          : "view";
        const viewId = viewIds.includes(command.viewId as IdeViewId)
          ? (command.viewId as IdeViewId)
          : undefined;
        return [
          {
            id: command.id.slice(0, 200),
            label: command.label.slice(0, 200),
            category,
            viewId,
          },
        ];
      })
    : [];
  const allowedPermissions: IdeContribution["permissions"] = [
    "commands",
    "views",
    "tasks",
    "debug",
    "languages",
  ];
  const permissions = Array.isArray(manifest.permissions)
    ? manifest.permissions.filter(
        (permission): permission is IdeContribution["permissions"][number] =>
          typeof permission === "string" &&
          allowedPermissions.includes(
            permission as IdeContribution["permissions"][number],
          ),
      )
    : [];
  return {
    id,
    label: label.slice(0, 200),
    version:
      typeof manifest.version === "string"
        ? manifest.version.slice(0, 50)
        : "0.0.0",
    publisher:
      typeof manifest.publisher === "string"
        ? manifest.publisher.slice(0, 100)
        : "Local",
    source: "local",
    enabled: false,
    permissions,
    manifestName,
    views,
    commands,
  };
}

function workspaceKeybindingSignature(binding: WorkspaceKeybinding) {
  return [
    binding.primary ? "primary" : "",
    binding.control ? "control" : "",
    binding.shift ? "shift" : "",
    binding.alt ? "alt" : "",
    binding.key.toLowerCase(),
  ].join("+");
}

function workspaceKeybindingLabel(binding: WorkspaceKeybinding) {
  const mac = isMacPlatform();
  return [
    binding.primary ? (mac ? "⌘" : "Ctrl") : "",
    binding.control ? "Ctrl" : "",
    binding.alt ? (mac ? "⌥" : "Alt") : "",
    binding.shift ? (mac ? "⇧" : "Shift") : "",
    binding.key.length === 1 ? binding.key.toUpperCase() : binding.key,
  ]
    .filter(Boolean)
    .join(mac ? "" : "+");
}

type IdeSurfaceProps = {
  files: WorkspaceFile[];
  ide?: IdeState;
  workspacePath?: string;
  workspaceTrusted?: boolean;
  effectiveMinimapEnabled?: boolean;
  selectedPath?: string;
  fileContent?: WorkspaceFileContent;
  fileError?: string;
  fileLoadState?: "idle" | "loading" | "ready" | "error";
  editorTabs?: EditorTab[];
  activeBuffer?: EditorBuffer;
  editorSelection?: EditorSelection;
  editorRevealTarget?: EditorRevealTarget;
  onOpenWorkspace?: () => void;
  onTrustWorkspace?: () => void;
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
  isToolPanelOpen?: boolean;
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
  workspaceTrusted = true,
  effectiveMinimapEnabled,
  selectedPath,
  fileContent,
  fileError = "",
  fileLoadState = "idle",
  editorTabs,
  activeBuffer,
  editorSelection,
  editorRevealTarget,
  onOpenWorkspace,
  onTrustWorkspace,
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
  isToolPanelOpen = false,
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
        {!workspaceTrusted ? (
          <aside className="gyro-workspace-trust-banner" role="status">
            <LockKeyhole size={14} />
            <span>
              <strong>Restricted Mode</strong>
              Tasks, terminals, language servers, and debug adapters are paused
              for this folder.
            </span>
            <button onClick={onTrustWorkspace} type="button">
              Trust workspace
            </button>
          </aside>
        ) : null}
        {ide?.activeView !== "settings" ? (
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
                  breadcrumbPath={
                    files.find((file) => file.path === groupPath)
                      ?.relativePath ?? groupPath
                  }
                  browserFocusEmpty={
                    activePaneTab === "browser" &&
                    isToolPanelOpen &&
                    !selectedPath
                  }
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
                  minimapEnabled={
                    effectiveMinimapEnabled ??
                    ide?.layout.minimapEnabled !== false
                  }
                  assistantOpen={ide?.activeView === "ai"}
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
  branchCatalog,
  isBranchLoading = false,
  onSelectBranch,
  onCreateBranch,
}: {
  ide?: IdeState;
  activeBuffer?: EditorBuffer;
  editorSelection?: EditorSelection;
  fileContent?: WorkspaceFileContent;
  fileLoadState?: "idle" | "loading" | "ready" | "error";
  groupCount?: number;
  selectedPath?: string;
  branchCatalog?: GitBranchCatalog;
  isBranchLoading?: boolean;
  onSelectBranch?: (branch: string) => void;
  onCreateBranch?: () => void;
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
  const branchLabel =
    ide?.sourceControl.branch ??
    branchCatalog?.current ??
    (branchCatalog?.available === false ? "No repository" : "Select branch");

  return (
    <footer className="gyro-editor-statusbar" aria-label="Workspace status">
      <div className="gyro-editor-statusbar-group is-primary">
        <div className="gyro-editor-statusbar-branch">
          <ScmBranchPicker
            branchCatalog={branchCatalog}
            currentBranch={ide?.sourceControl.branch ?? branchCatalog?.current}
            disabled={isBranchLoading}
            error={ide?.sourceControl.error ?? branchCatalog?.error}
            isLoading={isBranchLoading}
            onCreateBranch={onCreateBranch}
            onSelectBranch={onSelectBranch}
          />
        </div>
        <span className="gyro-editor-statusbar-branch-fallback" hidden>
          <GitBranch size={12} />
          {branchLabel}
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
  breadcrumbPath?: string;
  activeBuffer?: EditorBuffer;
  selection?: EditorSelection;
  revealTarget?: EditorRevealTarget;
  fileContent?: WorkspaceFileContent;
  fileError: string;
  fileLoadState: "idle" | "loading" | "ready" | "error";
  filesAvailable: boolean;
  minimapEnabled: boolean;
  assistantOpen?: boolean;
  /** When Browser is focused and no file is open, de-emphasize editor chrome. */
  browserFocusEmpty?: boolean;
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
  breadcrumbPath,
  activeBuffer,
  selection,
  revealTarget,
  fileContent,
  fileError,
  fileLoadState,
  filesAvailable,
  minimapEnabled,
  assistantOpen,
  browserFocusEmpty = false,
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
            aria-label="Toggle chat"
            className={assistantOpen ? "is-active" : undefined}
            onClick={onToggleAssistant}
            title="Toggle chat"
            type="button"
          >
            <MessageSquare size={14} />
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
              {parentSegments(breadcrumbPath ?? activePath).map((segment) => (
                <span key={segment}>{segment}</span>
              ))}
              {parentSegments(breadcrumbPath ?? activePath).length > 0 ? (
                <ChevronRight size={13} />
              ) : null}
              <strong>{workspaceName(activePath)}</strong>
            </>
          ) : (
            <strong className="gyro-editor-empty-hint">
              {browserFocusEmpty
                ? "Previewing — open a file to edit alongside"
                : "No workspace file loaded"}
            </strong>
          )}
        </div>
        <div
          className={["gyro-editor-ai-bar", !activePath ? "is-file-empty" : ""]
            .filter(Boolean)
            .join(" ")}
          aria-label="Editor AI actions"
          hidden={browserFocusEmpty}
        >
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
            <Sparkles size={13} />
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
  onBrowserHostBoundsChange,
  browserNativeHost = false,
  browserOverlayOccluded = false,
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
  browserNativeHost?: boolean;
  browserOverlayOccluded?: boolean;
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
  onBrowserHostBoundsChange?: (
    bounds: { x: number; y: number; width: number; height: number } | null,
  ) => void;
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
        nativeHost={browserNativeHost}
        overlayOccluded={browserOverlayOccluded}
        onBack={onBrowserBack}
        onDeviceChange={onBrowserDeviceChange}
        onForward={onBrowserForward}
        onHostBoundsChange={onBrowserHostBoundsChange}
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

  if (activePaneTab === "test-results") {
    const tests = (ide?.testTree ?? []).flatMap((item) =>
      item.children?.length ? item.children : [item],
    );
    return (
      <section className="gyro-test-results-pane" aria-label="Test Results">
        <header>
          <ListChecks size={15} />
          <span>{tests.length} tests</span>
          <small>
            {tests.filter((test) => test.status === "passed").length} passed ·{" "}
            {tests.filter((test) => test.status === "failed").length} failed
          </small>
        </header>
        <div className="gyro-test-results-list">
          {tests.length > 0 ? (
            tests.map((test) => (
              <button
                className={`gyro-test-result is-${test.status}`}
                disabled={!test.path}
                key={test.id}
                onClick={() =>
                  test.path && onOpenDiffInEditor?.(test.path, 1, 1)
                }
                type="button"
              >
                {test.status === "passed" ? (
                  <Check size={13} />
                ) : test.status === "failed" ? (
                  <X size={13} />
                ) : test.status === "running" ? (
                  <Activity size={13} />
                ) : (
                  <CircleDashed size={13} />
                )}
                <strong>{test.label}</strong>
                <span>{test.status}</span>
              </button>
            ))
          ) : (
            <div className="gyro-panel-empty">
              Run a discovered test task to populate structured results.
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
  onBrowserHostBoundsChange?: (
    bounds: { x: number; y: number; width: number; height: number } | null,
  ) => void;
  browserNativeHost?: boolean;
  browserOverlayOccluded?: boolean;
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
  browserNativeHost = false,
  browserOverlayOccluded = false,
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
  onBrowserHostBoundsChange,
}: WorkspaceToolPanelProps) {
  const [isResizing, setIsResizing] = useState(false);
  const dragMovedRef = useRef(false);
  const canResize = isResizable && !isPrimary;
  const effectivePaneTab = terminalOnly ? "terminal" : activePaneTab;
  const activeTerminalPane =
    terminalPanes?.find((pane) => pane.id === selectedTerminalPaneId) ??
    terminalPanes?.[0];
  const maxHeight = maxToolPanelHeight();
  const currentHeight = height ?? TOOL_PANEL_DEFAULT_HEIGHT;
  const isNearFull = canResize && currentHeight >= maxHeight - 24;

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!canResize || !onHeightChange) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const panel = event.currentTarget.closest(
      ".gyro-workspace-tool-panel",
    ) as HTMLElement | null;
    const startHeight =
      height ??
      panel?.getBoundingClientRect().height ??
      TOOL_PANEL_DEFAULT_HEIGHT;
    const startY = event.clientY;
    const ceiling = maxToolPanelHeight();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    dragMovedRef.current = false;
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
      moveEvent.preventDefault();
      if (Math.abs(moveEvent.clientY - startY) > 2) {
        dragMovedRef.current = true;
      }
      const nextHeight = nextHeightForY(moveEvent.clientY);
      onHeightChange(
        clampToolPanelHeight(nextHeight, TOOL_PANEL_COLLAPSE_HEIGHT, ceiling),
      );
    };

    const handleUp = (upEvent: PointerEvent) => {
      const nextHeight = nextHeightForY(upEvent.clientY);
      cleanup();
      if (nextHeight <= TOOL_PANEL_COLLAPSE_HEIGHT) {
        onCollapse?.();
        return;
      }
      onHeightChange(
        clampToolPanelHeight(nextHeight, TOOL_PANEL_MIN_HEIGHT, ceiling),
      );
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
    const baseHeight = height ?? TOOL_PANEL_DEFAULT_HEIGHT;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onHeightChange(clampToolPanelHeight(baseHeight + 32));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onHeightChange(clampToolPanelHeight(baseHeight - 32));
    } else if (event.key === "Home") {
      event.preventDefault();
      onHeightChange(maxToolPanelHeight());
    } else if (event.key === "End") {
      event.preventDefault();
      onCollapse?.();
    }
  };

  const togglePanelMaximize = () => {
    if (!canResize || !onHeightChange) {
      return;
    }
    if (isNearFull) {
      onHeightChange(
        effectivePaneTab === "browser"
          ? TOOL_PANEL_BROWSER_HEIGHT
          : TOOL_PANEL_DEFAULT_HEIGHT,
      );
      return;
    }
    onHeightChange(maxToolPanelHeight());
  };

  const panelClassName = [
    "gyro-workspace-tool-panel",
    isPrimary ? "is-primary" : "",
    canResize ? "is-resizable" : "",
    isResizing ? "is-resizing" : "",
    isNearFull ? "is-maximized" : "",
    effectivePaneTab === "browser" ? "is-browser" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section
      className={panelClassName}
      style={
        canResize
          ? {
              height: currentHeight,
              maxHeight: maxHeight,
            }
          : undefined
      }
      aria-label="Workspace tools"
      data-active-tab={effectivePaneTab}
    >
      {canResize ? (
        <button
          aria-label="Resize tool panel. Drag up to enlarge, double-click to maximize."
          className="gyro-tool-panel-resize-handle"
          onClick={(event) => {
            // Click after a drag must not snap height back to the default.
            if (dragMovedRef.current) {
              dragMovedRef.current = false;
              return;
            }
            // Single click is a no-op; double-click maximizes (or restores).
            if (event.detail >= 2) {
              togglePanelMaximize();
            }
          }}
          onKeyDown={handleResizeKeyDown}
          onPointerDown={beginResize}
          title="Drag to resize · Double-click to maximize"
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
          {canResize ? (
            <button
              aria-label={
                isNearFull ? "Restore tool panel height" : "Maximize tool panel"
              }
              className="gyro-icon-button is-subtle"
              onClick={togglePanelMaximize}
              title={isNearFull ? "Restore height" : "Maximize panel"}
              type="button"
            >
              {isNearFull ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          ) : null}
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
        onBrowserHostBoundsChange={onBrowserHostBoundsChange}
        onBrowserNavigate={onBrowserNavigate}
        onBrowserOpenExternal={onBrowserOpenExternal}
        onBrowserReload={onBrowserReload}
        onBrowserScreenshot={onBrowserScreenshot}
        onBrowserUrlChange={onBrowserUrlChange}
        browserNativeHost={browserNativeHost}
        browserOverlayOccluded={browserOverlayOccluded}
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
  // Prefer nearly full workspace height so Browser/Terminal can dominate.
  return Math.max(
    TOOL_PANEL_MIN_HEIGHT,
    Math.round(window.innerHeight * TOOL_PANEL_MAX_VIEWPORT_RATIO),
  );
}

export {
  TOOL_PANEL_BROWSER_HEIGHT,
  TOOL_PANEL_DEFAULT_HEIGHT,
  TOOL_PANEL_MIN_HEIGHT,
  maxToolPanelHeight,
};

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
                        {providerConnectionLabel(provider, status)} ·{" "}
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
              // Only committing depends on the reviewed files; pushing and
              // opening a PR act on commits that already exist, so they stay
              // available even when nothing is pending review.
              const gitActionStatus =
                hasFiles || action.id !== "commit" ? action.status : "blocked";
              return (
                <button
                  className={`is-${gitActionStatus}`}
                  disabled={
                    gitActionStatus === "blocked" ||
                    gitActionStatus === "running"
                  }
                  key={action.id}
                  onClick={() => onRunGitAction?.(action.id)}
                  title={action.error ?? action.detail}
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

/** Icon for a normalized GitHub run state. */
function githubRunStateIcon(state: GithubRunState): IconComponent {
  if (state === "success") {
    return Check;
  }
  if (state === "queued" || state === "in-progress") {
    return CircleDashed;
  }
  if (
    state === "failure" ||
    state === "timed-out" ||
    state === "action-required" ||
    state === "stale"
  ) {
    return XCircle;
  }
  return Minus;
}

/**
 * GitHub pull requests and Actions runs for the current workspace.
 *
 * Renders nothing but a short hint when `gh` is missing, logged out, or the
 * repository is not on GitHub — the states where showing controls would only
 * promise something Gyro cannot deliver.
 */
function ScmBranchPicker({
  branchCatalog,
  currentBranch,
  disabled = false,
  error,
  isLoading = false,
  onCreateBranch,
  onSelectBranch,
}: {
  branchCatalog?: GitBranchCatalog;
  currentBranch?: string;
  disabled?: boolean;
  error?: string;
  isLoading?: boolean;
  onCreateBranch?: () => void;
  onSelectBranch?: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useOutsidePointerDismiss<HTMLDivElement>(open, () =>
    setOpen(false),
  );
  const branches = branchCatalog?.branches ?? [];
  const label =
    currentBranch && currentBranch !== "(detached)"
      ? currentBranch
      : currentBranch === "(detached)"
        ? "Detached HEAD"
        : branchCatalog?.available === false
          ? "No repository"
          : "Select branch";

  return (
    <div className="gyro-scm-branch-picker" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="gyro-scm-branch-trigger"
        disabled={disabled || isLoading}
        onClick={() => setOpen((value) => !value)}
        title={error ?? label}
        type="button"
      >
        <GitBranch size={12} aria-hidden="true" />
        <span>{isLoading ? "Loading…" : label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div className="gyro-scm-branch-menu" role="listbox">
          <button
            className="gyro-scm-branch-item is-action"
            onClick={() => {
              setOpen(false);
              onCreateBranch?.();
            }}
            type="button"
          >
            <GitBranchPlus size={12} aria-hidden="true" />
            Create new branch…
          </button>
          {branches.length === 0 ? (
            <div className="gyro-scm-branch-empty">
              {branchCatalog?.error ?? error ?? "No local branches found."}
            </div>
          ) : (
            branches.map((branch) => {
              const isCurrent = branch === currentBranch;
              return (
                <button
                  aria-selected={isCurrent}
                  className={[
                    "gyro-scm-branch-item",
                    isCurrent ? "is-current" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={branch}
                  onClick={() => {
                    setOpen(false);
                    if (!isCurrent) {
                      onSelectBranch?.(branch);
                    }
                  }}
                  role="option"
                  type="button"
                >
                  <GitBranch size={12} aria-hidden="true" />
                  <span>{branch}</span>
                  {isCurrent ? <Check size={12} aria-hidden="true" /> : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function GithubSidebarPanel({
  github,
  branch,
  onOpenUrl,
  onRefresh,
  onRerunRun,
  onSelectRun,
  onViewLogs,
}: {
  github?: GithubState;
  branch?: string;
  onOpenUrl?: (url: string) => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  onRerunRun?: (runId: number, failedOnly: boolean) => void | Promise<void>;
  onSelectRun?: (runId: number) => void | Promise<void>;
  onViewLogs?: (runId: number) => void | Promise<void>;
}) {
  const availability = github?.availability;
  const header = (
    <div className="gyro-sidebar-scm-group-label is-github">
      <span className="gyro-scm-label-text">GitHub</span>
      {github?.loading ? <small>…</small> : null}
      <button
        aria-label="Refresh GitHub"
        onClick={() => void onRefresh?.()}
        title="Refresh"
        type="button"
      >
        <RefreshCw size={12} />
      </button>
    </div>
  );

  if (!github || !availability?.available) {
    return (
      <>
        {header}
        <div className="gyro-sidebar-mini-copy">
          {availability?.hint ??
            availability?.error ??
            "Checking GitHub availability…"}
        </div>
      </>
    );
  }

  // Runs for the checked-out branch first: that is what the user just pushed.
  const runs = [...github.runs].sort((first, second) => {
    const firstMatches = branch && first.branch === branch ? 0 : 1;
    const secondMatches = branch && second.branch === branch ? 0 : 1;
    return firstMatches - secondMatches;
  });
  const selectedRun = github.runs.find(
    (run) => run.id === github.selectedRunId,
  );
  const detail =
    github.runDetail?.run.id === github.selectedRunId
      ? github.runDetail
      : undefined;

  return (
    <>
      {header}
      {github.error ? (
        <div className="gyro-sidebar-mini-copy">{github.error}</div>
      ) : null}
      {github.pullRequests.length > 0 ? (
        <>
          <div className="gyro-sidebar-scm-group-label">
            <span className="gyro-scm-label-text">Pull requests</span>
            <small>{github.pullRequests.length}</small>
          </div>
          {github.pullRequests.slice(0, 8).map((pullRequest) => {
            const ChecksIcon = pullRequest.checks
              ? githubRunStateIcon(pullRequest.checks)
              : undefined;
            return (
              <button
                className="gyro-sidebar-github-row"
                key={pullRequest.number}
                onClick={() => void onOpenUrl?.(pullRequest.url)}
                title={`#${pullRequest.number} ${pullRequest.title}`}
                type="button"
              >
                <GitPullRequest size={12} aria-hidden="true" />
                <span className="gyro-sidebar-github-title">
                  {pullRequest.title}
                </span>
                <small>#{pullRequest.number}</small>
                {ChecksIcon ? (
                  <ChecksIcon
                    className={`gyro-github-state is-${pullRequest.checks}`}
                    size={11}
                  />
                ) : null}
              </button>
            );
          })}
        </>
      ) : null}
      <div className="gyro-sidebar-scm-group-label">
        <span className="gyro-scm-label-text">Actions</span>
        <small>{runs.length}</small>
      </div>
      {runs.length === 0 ? (
        <div className="gyro-sidebar-mini-copy">No workflow runs</div>
      ) : (
        runs.slice(0, 10).map((run) => {
          const StateIcon = githubRunStateIcon(run.state);
          const isSelected = run.id === github.selectedRunId;
          return (
            <div className="gyro-sidebar-github-run" key={run.id}>
              <button
                className={`gyro-sidebar-github-row${isSelected ? " is-active" : ""}`}
                onClick={() => void onSelectRun?.(run.id)}
                title={`${run.workflowName} · ${run.title} · ${run.branch}`}
                type="button"
              >
                <StateIcon
                  className={`gyro-github-state is-${run.state}`}
                  size={12}
                />
                <span className="gyro-sidebar-github-title">
                  {run.workflowName}
                </span>
                <small>{run.branch}</small>
              </button>
              {isSelected ? (
                <div className="gyro-sidebar-github-detail">
                  {detail ? (
                    detail.jobs.map((job) => {
                      const JobIcon = githubRunStateIcon(job.state);
                      return (
                        <div
                          className="gyro-sidebar-github-job"
                          key={job.id}
                          title={`${job.name} — ${job.state}`}
                        >
                          <JobIcon
                            className={`gyro-github-state is-${job.state}`}
                            size={12}
                          />
                          <span>{job.name}</span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="gyro-sidebar-mini-copy">Loading jobs…</div>
                  )}
                  <div className="gyro-sidebar-github-actions">
                    <button
                      onClick={() => void onViewLogs?.(run.id)}
                      title="Show failed-step logs in the Output panel"
                      type="button"
                    >
                      <ScrollText size={12} />
                      Logs
                    </button>
                    <button
                      // Re-running only the failed jobs is the common repair;
                      // it is also far cheaper than a full re-run.
                      disabled={!selectedRun?.state}
                      onClick={() => void onRerunRun?.(run.id, true)}
                      title="Re-run the failed jobs in this run"
                      type="button"
                    >
                      <RotateCcw size={12} />
                      Re-run failed
                    </button>
                    <button
                      onClick={() => void onOpenUrl?.(run.url)}
                      title="Open this run on GitHub"
                      type="button"
                    >
                      <Globe2 size={12} />
                      Open
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </>
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

const BROWSER_RAIL_DEFAULT_WIDTH = 380;
const BROWSER_RAIL_MIN_WIDTH = 280;
const BROWSER_RAIL_MAX_WIDTH = 900;
const BROWSER_RAIL_WIDTH_KEY = "gyro.chat.browserRailWidth";

function readBrowserRailWidth(): number {
  if (typeof window === "undefined") {
    return BROWSER_RAIL_DEFAULT_WIDTH;
  }
  const raw = window.localStorage.getItem(BROWSER_RAIL_WIDTH_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return BROWSER_RAIL_DEFAULT_WIDTH;
  }
  return Math.min(
    BROWSER_RAIL_MAX_WIDTH,
    Math.max(BROWSER_RAIL_MIN_WIDTH, parsed),
  );
}

/**
 * Chat-side browser card, docked on the right. Drag the left edge to widen
 * or narrow it (into the transcript), not to free-float the panel.
 */
function ResizableBrowserRail({
  browserPreview,
  browserNativeHost,
  browserOverlayOccluded,
  onClose,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  onBrowserUrlChange,
  onBrowserNavigate,
  onBrowserDeviceChange,
  onBrowserScreenshot,
  onBrowserOpenExternal,
  onBrowserHostBoundsChange,
}: {
  browserPreview?: BrowserPreview;
  browserNativeHost?: boolean;
  browserOverlayOccluded?: boolean;
  onClose?: () => void;
  onBrowserBack?: () => void;
  onBrowserForward?: () => void;
  onBrowserReload?: () => void;
  onBrowserUrlChange?: (url: string) => void;
  onBrowserNavigate?: (url: string) => void;
  onBrowserDeviceChange?: (device: BrowserPreviewDevice) => void;
  onBrowserScreenshot?: (action?: BrowserScreenshotAction) => void;
  onBrowserOpenExternal?: () => void;
  onBrowserHostBoundsChange?: (
    bounds: { x: number; y: number; width: number; height: number } | null,
  ) => void;
}) {
  const railRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(readBrowserRailWidth);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  const clampWidth = useCallback((value: number, parentWidth?: number) => {
    // Leave the transcript at least ~280px; cap by viewport and hard max.
    const parentCap =
      parentWidth !== undefined
        ? Math.max(BROWSER_RAIL_MIN_WIDTH, parentWidth - 280)
        : BROWSER_RAIL_MAX_WIDTH;
    const max = Math.min(BROWSER_RAIL_MAX_WIDTH, parentCap);
    return Math.min(max, Math.max(BROWSER_RAIL_MIN_WIDTH, Math.round(value)));
  }, []);

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }
    const rail = railRef.current;
    if (!rail) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: rail.getBoundingClientRect().width,
    };
    setIsResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    // Handle is on the left edge: drag left → wider, drag right → narrower.
    const parent = railRef.current?.parentElement;
    const parentWidth = parent?.getBoundingClientRect().width;
    const delta = drag.startX - event.clientX;
    setWidth(clampWidth(drag.startWidth + delta, parentWidth));
  };

  const endResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    resizeRef.current = null;
    setIsResizing(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already be released.
    }
    const next = clampWidth(
      railRef.current?.getBoundingClientRect().width ?? width,
      railRef.current?.parentElement?.getBoundingClientRect().width,
    );
    setWidth(next);
    try {
      window.localStorage.setItem(BROWSER_RAIL_WIDTH_KEY, String(next));
    } catch {
      // Private mode / blocked storage — width still works for the session.
    }
    // Native webview host bounds track layout width.
    window.dispatchEvent(new Event("resize"));
  };

  return (
    <aside
      aria-label="Browser"
      className={["gyro-browser-rail", isResizing ? "is-resizing" : ""]
        .filter(Boolean)
        .join(" ")}
      ref={railRef}
      style={{ width }}
    >
      <button
        aria-label="Resize browser panel. Drag left to enlarge, right to shrink."
        aria-orientation="vertical"
        aria-valuemax={BROWSER_RAIL_MAX_WIDTH}
        aria-valuemin={BROWSER_RAIL_MIN_WIDTH}
        aria-valuenow={width}
        className="gyro-browser-rail-resize-handle"
        onKeyDown={(event) => {
          const parentWidth =
            railRef.current?.parentElement?.getBoundingClientRect().width;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            setWidth((current) => {
              const next = clampWidth(current + 24, parentWidth);
              try {
                window.localStorage.setItem(
                  BROWSER_RAIL_WIDTH_KEY,
                  String(next),
                );
              } catch {
                // ignore
              }
              return next;
            });
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            setWidth((current) => {
              const next = clampWidth(current - 24, parentWidth);
              try {
                window.localStorage.setItem(
                  BROWSER_RAIL_WIDTH_KEY,
                  String(next),
                );
              } catch {
                // ignore
              }
              return next;
            });
          }
        }}
        onPointerCancel={endResize}
        onPointerDown={beginResize}
        onPointerMove={onResizeMove}
        onPointerUp={endResize}
        title="Drag to resize"
        type="button"
      >
        <span />
      </button>
      <header>
        <div className="gyro-chat-tool-title">
          <Globe2 aria-hidden="true" size={15} />
          <div>
            <strong>Browser</strong>
            <span>
              {browserPreview?.title?.trim() ||
                browserPreviewHostLabel(browserPreview?.url) ||
                "Session preview"}
            </span>
          </div>
        </div>
        <button
          aria-label="Close browser"
          className="gyro-chat-tool-close"
          onClick={onClose}
          type="button"
        >
          <X size={14} />
        </button>
      </header>
      <BrowserPreviewSurface
        browserPreview={browserPreview}
        nativeHost={browserNativeHost}
        overlayOccluded={browserOverlayOccluded}
        variant="chat"
        onBack={onBrowserBack}
        onDeviceChange={onBrowserDeviceChange}
        onForward={onBrowserForward}
        onHostBoundsChange={onBrowserHostBoundsChange}
        onNavigate={onBrowserNavigate}
        onOpenExternal={onBrowserOpenExternal}
        onReload={onBrowserReload}
        onScreenshot={onBrowserScreenshot}
        onUrlChange={onBrowserUrlChange}
      />
    </aside>
  );
}

export function BrowserPreviewSurface({
  compact = false,
  variant,
  browserPreview,
  nativeHost = false,
  overlayOccluded = false,
  onBack,
  onForward,
  onReload,
  onUrlChange,
  onNavigate,
  onDeviceChange,
  onScreenshot,
  onOpenExternal,
  onHostBoundsChange,
}: {
  compact?: boolean;
  /** Chat rail uses a lighter chrome; workbench keeps full diagnostics chrome. */
  variant?: "workbench" | "chat";
  browserPreview?: BrowserPreview;
  /** When true, render a spacer host for a native child webview instead of an iframe. */
  nativeHost?: boolean;
  /** True when any app overlay is open — native webview should hide. */
  overlayOccluded?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onReload?: () => void;
  onUrlChange?: (url: string) => void;
  onNavigate?: (url: string) => void;
  onDeviceChange?: (device: BrowserPreviewDevice) => void;
  onScreenshot?: (action?: BrowserScreenshotAction) => void;
  onOpenExternal?: () => void;
  onHostBoundsChange?: (
    bounds: { x: number; y: number; width: number; height: number } | null,
  ) => void;
}) {
  const preview =
    browserPreview ??
    ({
      url: "http://localhost:3000",
      history: ["http://localhost:3000"],
      historyIndex: 0,
      device: "desktop",
      consoleErrors: 0,
      diagnostics: [],
      diagnosticsSupported: false,
      diagnosticsCaptured: false,
      captureStatus: "idle",
      status: "idle",
      verificationMessage: "Idle",
    } satisfies BrowserPreview);
  const resolvedVariant = variant ?? (compact ? "workbench" : "workbench");
  const isChat = resolvedVariant === "chat";
  const canGoBack = preview.historyIndex > 0;
  const canGoForward = preview.historyIndex < preview.history.length - 1;
  const [frameRevision, setFrameRevision] = useState(0);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [frameMode, setFrameMode] = useState<"live" | "capture">("live");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const lastCaptureKeyRef = useRef<string | undefined>(undefined);
  const frameUrl = normalizedBrowserPreviewUrl(preview.url);
  const hasDiagnostics = preview.consoleErrors !== 0;
  const useNativeHost = nativeHost || preview.nativeHost === true;
  const canCapturePreview =
    useNativeHost || isLoopbackBrowserPreviewUrl(frameUrl);
  const isLocalPreview = isLoopbackBrowserPreviewUrl(frameUrl);
  const hostLabel = browserPreviewHostLabel(preview.url);
  const isLoading = preview.status === "loading";
  const isCapturing = preview.captureStatus === "capturing";
  const isLive =
    preview.status === "ready" || preview.status === "verification-passed";
  const isFailed =
    preview.status === "verification-failed" ||
    preview.status === "console-error";
  const captureSrc = preview.latestCapture?.src;
  const hasCapture =
    preview.captureStatus === "captured" && Boolean(captureSrc);
  // Auto-open Capture view when a new screenshot lands.
  useEffect(() => {
    const key = preview.latestCapture
      ? `${preview.latestCapture.path}:${preview.latestCapture.createdAt}`
      : undefined;
    if (
      preview.captureStatus === "captured" &&
      key &&
      key !== lastCaptureKeyRef.current &&
      captureSrc
    ) {
      lastCaptureKeyRef.current = key;
      setFrameMode("capture");
    }
  }, [captureSrc, preview.captureStatus, preview.latestCapture]);
  // Fall back to Live if the capture disappears.
  useEffect(() => {
    if (frameMode === "capture" && !hasCapture) {
      setFrameMode("live");
    }
  }, [frameMode, hasCapture]);
  const showingCapture = frameMode === "capture" && hasCapture;
  // Placeholder fills the frame when there is no live paint yet (or host is occluded).
  const showPlaceholder =
    !showingCapture &&
    (overlayOccluded ||
      preview.status === "idle" ||
      isLoading ||
      preview.status === "verification-failed" ||
      (!useNativeHost && !isLive && preview.status !== "console-error"));
  const showCaptureBackdrop =
    Boolean(captureSrc) &&
    !showingCapture &&
    (preview.status === "idle" ||
      preview.status === "verification-failed" ||
      overlayOccluded);
  // Hide the native webview while inspecting a freeze-frame capture.
  const hostShouldHide = overlayOccluded || showingCapture;

  useEffect(() => {
    if (!useNativeHost || !onHostBoundsChange) {
      return;
    }
    const element = hostRef.current;
    if (!element) {
      return;
    }
    const report = () => {
      if (hostShouldHide) {
        onHostBoundsChange(null);
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        onHostBoundsChange(null);
        return;
      }
      onHostBoundsChange({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };
    report();
    const observer = new ResizeObserver(() => report());
    observer.observe(element);
    window.addEventListener("resize", report);
    // Capture scroll on ancestors so rail scrolling repositions the webview.
    window.addEventListener("scroll", report, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      window.removeEventListener("scroll", report, true);
      onHostBoundsChange(null);
    };
  }, [
    useNativeHost,
    onHostBoundsChange,
    hostShouldHide,
    compact,
    isChat,
    preview.device,
  ]);

  const reloadFrame = () => {
    setFrameRevision((revision) => revision + 1);
    onReload?.();
  };

  const statusRingClass =
    isFailed
      ? "gyro-ring is-failed"
      : isLoading || isCapturing
        ? "gyro-ring is-running"
        : isLive
          ? "gyro-ring is-done"
          : "gyro-ring is-idle";

  return (
    <div
      className={[
        "gyro-browser-preview",
        compact ? "is-compact" : "",
        isChat ? "is-chat" : "is-workbench",
        useNativeHost ? "is-native-host" : "",
        overlayOccluded ? "is-occluded" : "",
        isLoading ? "is-loading" : "",
        isCapturing ? "is-capturing-frame" : "",
        isLive ? "is-live" : "",
        showingCapture ? "is-capture-view" : "",
        `is-device-${preview.device}`,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="gyro-browser-preview-toolbar">
        <div
          className="gyro-browser-nav-group"
          role="group"
          aria-label="Navigation"
        >
          <button
            aria-label="Back"
            disabled={!canGoBack || showingCapture}
            onClick={onBack}
            type="button"
          >
            <ChevronRight className="is-back" size={15} />
          </button>
          <button
            aria-label="Forward"
            disabled={!canGoForward || showingCapture}
            onClick={onForward}
            type="button"
          >
            <ChevronRight size={15} />
          </button>
          <button
            aria-label="Reload"
            disabled={showingCapture}
            onClick={reloadFrame}
            type="button"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <form
          className="gyro-url-bar"
          onSubmit={(event) => {
            event.preventDefault();
            if (showingCapture) {
              setFrameMode("live");
            }
            onNavigate?.(frameUrl);
          }}
        >
          <Globe2 size={14} />
          <input
            aria-label="Browser URL"
            onChange={(event) => onUrlChange?.(event.target.value)}
            placeholder="https://example.com"
            value={preview.url}
          />
          <small className={isLocalPreview ? "is-local" : "is-web"}>
            {showingCapture
              ? "capture"
              : useNativeHost
                ? "native"
                : isLocalPreview
                  ? "local"
                  : "web"}
          </small>
        </form>
        <div
          className="gyro-browser-actions"
          role="group"
          aria-label="Browser actions"
        >
          {hasCapture ? (
            <div
              className="gyro-browser-view-group"
              role="group"
              aria-label="Preview mode"
            >
              <button
                aria-pressed={frameMode === "live"}
                className={frameMode === "live" ? "is-active" : undefined}
                onClick={() => setFrameMode("live")}
                title="Live preview"
                type="button"
              >
                Live
              </button>
              <button
                aria-pressed={frameMode === "capture"}
                className={frameMode === "capture" ? "is-active" : undefined}
                onClick={() => setFrameMode("capture")}
                title="Last capture"
                type="button"
              >
                Capture
              </button>
            </div>
          ) : null}
          <div
            className="gyro-browser-device-group"
            role="group"
            aria-label="Device size"
          >
            {(
              [
                { id: "desktop", label: "Desktop", icon: Monitor },
                { id: "tablet", label: "Tablet", icon: Tablet },
                { id: "mobile", label: "Mobile", icon: Smartphone },
              ] as const
            ).map((device) => {
              const Icon = device.icon;
              return (
                <button
                  aria-label={device.label}
                  aria-pressed={preview.device === device.id}
                  className={
                    preview.device === device.id ? "is-active" : undefined
                  }
                  key={device.id}
                  onClick={() => onDeviceChange?.(device.id)}
                  title={device.label}
                  type="button"
                >
                  <Icon size={14} />
                </button>
              );
            })}
          </div>
          <button
            aria-label="Capture browser screenshot"
            className={`gyro-browser-capture-button${
              isCapturing ? " is-capturing" : ""
            }`}
            disabled={isCapturing || !canCapturePreview}
            onClick={() => {
              setFrameMode("live");
              onScreenshot?.("capture");
            }}
            title={
              isCapturing
                ? "Capturing preview"
                : canCapturePreview
                  ? "Capture screenshot"
                  : "Screenshots require the native browser host"
            }
            type="button"
          >
            <Camera size={14} />
          </button>
          <button
            aria-label="Open in system browser"
            className="gyro-browser-external-button"
            onClick={onOpenExternal}
            title="Open in system browser"
            type="button"
          >
            <Globe2 size={14} />
          </button>
        </div>
      </div>
      <div className="gyro-browser-frame">
        <div
          className={`gyro-browser-page is-${preview.device}`}
          data-device-label={deviceLabel(preview.device)}
        >
          {useNativeHost ? (
            <div
              ref={hostRef}
              aria-hidden={showingCapture || undefined}
              aria-label="Native browser surface"
              className={[
                "gyro-browser-native-host",
                showingCapture ? "is-capture-hidden" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-browser-host="true"
            >
              {showPlaceholder ? (
                <BrowserFramePlaceholder
                  captureSrc={showCaptureBackdrop ? captureSrc : undefined}
                  hostLabel={hostLabel}
                  isLoading={isLoading}
                  isOccluded={overlayOccluded}
                  isUnreachable={preview.status === "verification-failed"}
                  onNavigate={onNavigate}
                  onOpenExternal={onOpenExternal}
                  onReload={reloadFrame}
                  suggestedUrl={frameUrl}
                />
              ) : null}
            </div>
          ) : null}
          {showingCapture && captureSrc ? (
            <div className="gyro-browser-capture-view">
              <img
                alt={`Browser capture of ${hostLabel || preview.url}`}
                className="gyro-browser-capture-image"
                draggable={false}
                src={captureSrc}
              />
              <div className="gyro-browser-capture-meta">
                <span>
                  {preview.latestCapture?.width ?? 0} ×{" "}
                  {preview.latestCapture?.height ?? 0}
                  {hostLabel ? ` · ${hostLabel}` : ""}
                  {preview.latestCapture?.createdAt
                    ? ` · ${formatBrowserCaptureTime(preview.latestCapture.createdAt)}`
                    : ""}
                </span>
                <div className="gyro-browser-capture-actions">
                  <button
                    onClick={() => setFrameMode("live")}
                    type="button"
                  >
                    Back to live
                  </button>
                  <button
                    onClick={() => onScreenshot?.("reveal")}
                    type="button"
                  >
                    Reveal file
                  </button>
                </div>
              </div>
            </div>
          ) : !useNativeHost ? (
            showPlaceholder ? (
              <BrowserFramePlaceholder
                captureSrc={showCaptureBackdrop ? captureSrc : undefined}
                hostLabel={hostLabel}
                isLoading={isLoading}
                isOccluded={overlayOccluded}
                isUnreachable={preview.status === "verification-failed"}
                onNavigate={onNavigate}
                onOpenExternal={onOpenExternal}
                onReload={reloadFrame}
                suggestedUrl={frameUrl}
              />
            ) : (
              <iframe
                key={`${frameUrl}:${frameRevision}`}
                referrerPolicy="no-referrer"
                src={frameUrl}
                title="Browser preview"
              />
            )
          ) : null}
          {isLoading || isCapturing ? (
            <div
              aria-live="polite"
              className="gyro-browser-activity-strip"
            >
              <span className="gyro-ring is-running" />
              <span>
                {isCapturing
                  ? "Capturing screenshot…"
                  : hostLabel
                    ? `Loading ${hostLabel}…`
                    : "Loading preview…"}
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="gyro-browser-statusbar">
        <div>
          <span className={statusRingClass} />
          <span>
            {showingCapture
              ? `Capture · ${hostLabel || "preview"} · ${deviceLabel(preview.device)}`
              : browserStatusLabel(preview)}
          </span>
        </div>
        {preview.captureStatus !== "idle" ? (
          <button
            className={
              preview.captureStatus === "failed" ? "has-errors" : undefined
            }
            disabled={preview.captureStatus !== "captured"}
            onClick={() => {
              if (preview.captureStatus === "captured" && hasCapture) {
                setFrameMode((mode) =>
                  mode === "capture" ? "live" : "capture",
                );
                return;
              }
              onScreenshot?.("reveal");
            }}
            title={
              preview.captureStatus === "failed"
                ? preview.captureError
                : hasCapture
                  ? showingCapture
                    ? "Show live preview"
                    : "Show last capture"
                  : preview.latestCapture?.path
            }
            type="button"
          >
            <Camera size={13} />
            {preview.captureStatus === "capturing"
              ? "Capturing..."
              : preview.captureStatus === "failed"
                ? "Capture failed"
                : showingCapture
                  ? "Viewing capture"
                  : `${preview.latestCapture?.width ?? 0} × ${preview.latestCapture?.height ?? 0}`}
          </button>
        ) : null}
        {!isChat ? (
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
        ) : hasDiagnostics ? (
          <button
            aria-expanded={isDiagnosticsOpen}
            className="has-errors"
            onClick={() => setIsDiagnosticsOpen((open) => !open)}
            type="button"
          >
            <TriangleAlert size={13} />
            {`${preview.consoleErrors} issue${preview.consoleErrors === 1 ? "" : "s"}`}
          </button>
        ) : null}
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

function BrowserFramePlaceholder({
  captureSrc,
  hostLabel,
  isLoading,
  isOccluded,
  isUnreachable,
  onNavigate,
  onOpenExternal,
  onReload,
  suggestedUrl,
}: {
  captureSrc?: string;
  hostLabel?: string;
  isLoading: boolean;
  isOccluded: boolean;
  isUnreachable: boolean;
  onNavigate?: (url: string) => void;
  onOpenExternal?: () => void;
  onReload?: () => void;
  suggestedUrl: string;
}) {
  const title = isOccluded
    ? "Preview hidden"
    : isLoading
      ? "Loading preview"
      : isUnreachable
        ? "Can't reach this URL"
        : "No live preview yet";
  const detail = isOccluded
    ? "Close the overlay to show the native browser surface again."
    : isLoading
      ? hostLabel
        ? `Connecting to ${hostLabel}…`
        : "Connecting…"
      : isUnreachable
        ? "Start the app, or try another local URL."
        : "Point the browser at a running app, or open this URL externally.";

  return (
    <div
      className={[
        "gyro-browser-placeholder",
        isLoading ? "is-loading" : "",
        captureSrc ? "has-capture" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {captureSrc ? (
        <img
          alt=""
          className="gyro-browser-placeholder-capture"
          draggable={false}
          src={captureSrc}
        />
      ) : null}
      <div className="gyro-browser-placeholder-body">
        {isLoading ? (
          <div className="gyro-browser-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : (
          <div className="gyro-browser-placeholder-icon" aria-hidden="true">
            <Globe2 size={22} />
          </div>
        )}
        <strong>{title}</strong>
        <p>{detail}</p>
        {!isOccluded ? (
          <div className="gyro-browser-placeholder-actions">
            {suggestedUrl && suggestedUrl !== "about:blank" ? (
              <button
                onClick={() => onNavigate?.(suggestedUrl)}
                type="button"
              >
                {hostLabel || "localhost:3000"}
              </button>
            ) : null}
            {isUnreachable || isLoading ? (
              <button onClick={onReload} type="button">
                Retry
              </button>
            ) : null}
            <button onClick={onOpenExternal} type="button">
              Open external
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function browserPreviewHostLabel(url?: string) {
  const trimmed = url?.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `http://${trimmed}`,
    );
    return parsed.host || parsed.hostname || "";
  } catch {
    return "";
  }
}

function formatBrowserCaptureTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
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
  requiresWorkspace?: boolean;
  requiresTrust?: boolean;
};

type GlobalSearchEntry = {
  id: string;
  label: string;
  detail: string;
  icon: IconComponent;
  selection: GlobalSearchSelection;
  shortcut?: string;
  target: GlobalSearchTarget;
  priority: number;
  action?: GlobalSearchAction;
  disabledReason?: string;
};

type GlobalSearchHit = {
  entry: GlobalSearchEntry;
  match: GlobalSearchMatch;
};

type GlobalSearchGroup = {
  id: string;
  label: string;
  hits: GlobalSearchHit[];
};

const legacyGlobalSearchActions: GlobalSearchAction[] = [
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
    label: "Search in files",
    meta: "Find text across the workspace",
    destination: "workspace",
    layout: "code",
    icon: Search,
    keywords: "code find text grep contents",
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
    icon: Sparkles,
  },
  {
    id: "run-claude",
    label: "Start Claude Code",
    meta: "Open Claude in a terminal pane",
    destination: "workspace",
    layout: "terminal-grid",
    toolTab: "terminal",
    icon: Sparkles,
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

const workspaceCommandIds = new Set<string>(
  workspaceCommandRegistry.map((command) => command.id),
);
const globalSearchActions: GlobalSearchAction[] = [
  ...legacyGlobalSearchActions.filter(
    (action) => !workspaceCommandIds.has(action.id),
  ),
  ...workspaceCommandRegistry.map((command) => ({
    id: command.id,
    label: command.label,
    meta: command.description,
    destination: command.destination,
    layout: command.layout,
    toolTab: command.panel,
    icon: workspaceShellIcons[command.icon],
    keywords: command.keywords,
    shortcut: command.shortcut,
    requiresWorkspace: command.requiresWorkspace,
    requiresTrust: command.requiresTrust,
  })),
];

function isMacPlatform() {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  );
}

type GlobalSearchMode = "commands" | "files" | "global";

function primaryGlobalSearchShortcut(mode: GlobalSearchMode) {
  if (mode === "commands") {
    return isMacPlatform() ? "⇧⌘P" : "Ctrl Shift P";
  }
  if (mode === "files") {
    return isMacPlatform() ? "⌘P" : "Ctrl P";
  }
  return isMacPlatform() ? "⌘K" : "Ctrl K";
}

/** Holds one ranker per collection so keystrokes narrow the previous survivors. */
function useGlobalSearchRanker(entries: GlobalSearchEntry[]) {
  const rankerRef = useRef<GlobalSearchRanker<GlobalSearchEntry> | null>(null);
  if (!rankerRef.current) {
    rankerRef.current = new GlobalSearchRanker<GlobalSearchEntry>();
  }
  rankerRef.current.setCandidates(entries);
  return rankerRef.current;
}

function GlobalSearchHighlight({
  ranges,
  text,
}: {
  ranges: GlobalSearchRange[];
  text: string;
}) {
  if (ranges.length === 0) return <>{text}</>;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
    nodes.push(
      <mark className="gyro-global-search-hit" key={range.start}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

export function CommandPaletteOverlay({
  onClose,
  onSelectDestination,
  onSelectWorkspaceLayout,
  onOpenToolPanel,
  recents = [],
  sessions = [],
  projects = [],
  files = [],
  recentFilePaths = [],
  pinnedSessionIds = [],
  hasWorkspace = false,
  workspaceTrusted = true,
  mode = "global",
  query = "",
  onQueryChange,
  onCommand,
  onSelectSession,
  onSelectProject,
  onSelectFile,
}: {
  onClose: () => void;
  onSelectDestination: (destination: AppDestination) => void;
  onSelectWorkspaceLayout: (layout: WorkspaceLayoutId) => void;
  onOpenToolPanel: (tab: WorkbenchPaneTab) => void;
  recents?: string[];
  sessions?: Session[];
  projects?: GlobalSearchProject[];
  files?: WorkspaceFile[];
  recentFilePaths?: string[];
  pinnedSessionIds?: string[];
  hasWorkspace?: boolean;
  workspaceTrusted?: boolean;
  mode?: GlobalSearchMode;
  query?: string;
  onQueryChange?: (query: string) => void;
  onCommand?: (commandId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onSelectProject?: (path: string) => void;
  onSelectFile?: (path: string) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
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
        target: createGlobalSearchTarget(
          action.label,
          action.meta,
          action.keywords ?? "",
        ),
        priority:
          recents.indexOf(action.id) >= 0
            ? recents.indexOf(action.id)
            : 100 + index,
        action,
        disabledReason:
          action.requiresWorkspace && !hasWorkspace
            ? "Open a project to use this command"
            : action.requiresTrust && !workspaceTrusted
              ? "Trust this workspace to run commands"
              : undefined,
      })),
    [hasWorkspace, recents, workspaceTrusted],
  );
  const sessionEntries = useMemo<GlobalSearchEntry[]>(() => {
    const pinned = new Set(pinnedSessionIds);
    return [...sessions]
      .sort(
        (first, second) =>
          Number(pinned.has(second.id)) - Number(pinned.has(first.id)) ||
          new Date(second.updatedAt).getTime() -
            new Date(first.updatedAt).getTime(),
      )
      .map<GlobalSearchEntry>((session, index) => {
        const detail =
          session.summary ||
          `${workspaceName(session.workspacePath)}${session.providerLabel ? ` · ${session.providerLabel}` : ""}`;
        return {
          id: `session:${session.id}`,
          label: session.title || "Untitled session",
          detail,
          icon: pinned.has(session.id) ? Pin : MessageSquare,
          selection: { kind: "session", sessionId: session.id },
          target: createGlobalSearchTarget(
            session.title || "Untitled session",
            detail,
            `${session.workspacePath} ${session.providerLabel ?? ""}`,
          ),
          priority: (pinned.has(session.id) ? 0 : 100) + index,
        };
      });
  }, [pinnedSessionIds, sessions]);
  const projectEntries = useMemo<GlobalSearchEntry[]>(
    () =>
      projects.map<GlobalSearchEntry>((project, index) => {
        const detail = project.current
          ? "Current project"
          : project.detail || project.path;
        return {
          id: `project:${project.path}`,
          label: project.label,
          detail,
          icon: project.current ? Folder : HardDrive,
          selection: { kind: "project", path: project.path },
          target: createGlobalSearchTarget(project.label, detail, project.path),
          priority: (project.current ? 0 : 100) + index,
        };
      }),
    [projects],
  );
  const fileEntries = useMemo<GlobalSearchEntry[]>(() => {
    const recentOrder = new Map(
      recentFilePaths.map((path, index) => [path, index]),
    );
    return files
      .filter((file) => file.kind === "file")
      .slice(0, 10_000)
      .map<GlobalSearchEntry>((file, index) => {
        const segments = file.path.split("/").filter(Boolean);
        const label = segments.at(-1) ?? file.path;
        const parent = segments.slice(0, -1).join("/") || "Workspace root";
        const recentIndex = recentOrder.get(file.path);
        return {
          id: `file:${file.path}`,
          label,
          detail: parent,
          icon: FileCode2,
          selection: { kind: "file", path: file.path },
          target: createGlobalSearchTarget(label, parent, file.path),
          priority: recentIndex ?? 1_000 + index,
        };
      })
      .sort(
        (first, second) =>
          first.priority - second.priority ||
          first.label.localeCompare(second.label),
      );
  }, [files, recentFilePaths]);
  const actionRanker = useGlobalSearchRanker(actionEntries);
  const fileRanker = useGlobalSearchRanker(fileEntries);
  const projectRanker = useGlobalSearchRanker(projectEntries);
  const sessionRanker = useGlobalSearchRanker(sessionEntries);
  // Ranking runs off the deferred query so long file lists never block a
  // keystroke from painting.
  const deferredQuery = useDeferredValue(query);
  const groups = useMemo<GlobalSearchGroup[]>(() => {
    const searching = Boolean(normalizedGlobalSearchText(deferredQuery));
    const rank = (
      ranker: GlobalSearchRanker<GlobalSearchEntry>,
      limit: number,
    ) =>
      ranker
        .rank(deferredQuery, limit)
        .map(({ item, match }) => ({ entry: item, match }));
    if (mode === "commands") {
      return [
        { id: "commands", label: "Commands", hits: rank(actionRanker, 12) },
      ].filter((group) => group.hits.length > 0);
    }
    if (mode === "files") {
      return [
        {
          id: "files",
          label: "Files",
          hits: rank(fileRanker, searching ? 16 : 12),
        },
      ].filter((group) => group.hits.length > 0);
    }
    if (!searching) {
      return [
        { id: "suggested", label: "Suggested", hits: rank(actionRanker, 6) },
        { id: "open-files", label: "Open files", hits: rank(fileRanker, 6) },
        {
          id: "recent-sessions",
          label: "Recent sessions",
          hits: rank(sessionRanker, 5),
        },
        { id: "projects", label: "Projects", hits: rank(projectRanker, 4) },
      ].filter((group) => group.hits.length > 0);
    }
    return [
      { id: "files", label: "Files", hits: rank(fileRanker, 8) },
      { id: "projects", label: "Projects", hits: rank(projectRanker, 8) },
      { id: "sessions", label: "Sessions", hits: rank(sessionRanker, 8) },
      { id: "actions", label: "Actions", hits: rank(actionRanker, 8) },
    ].filter((group) => group.hits.length > 0);
  }, [
    actionRanker,
    deferredQuery,
    fileRanker,
    mode,
    projectRanker,
    sessionRanker,
  ]);
  const visibleHits = groups.flatMap((group) => group.hits);
  const visibleEntries = visibleHits.map((hit) => hit.entry);
  const activeEntry = visibleEntries[selectedIndex];
  const isStale = query !== deferredQuery;

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
  useEffect(() => {
    if (!activeEntry) return;
    optionRefs.current
      .get(activeEntry.id)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeEntry]);

  const activateEntry = (entry?: GlobalSearchEntry) => {
    if (!entry || entry.disabledReason) return;
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
    if (entry.selection.kind === "file") {
      onSelectWorkspaceLayout("code");
      onSelectFile?.(entry.selection.path);
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
        aria-label={
          mode === "commands"
            ? "Command Palette"
            : mode === "files"
              ? "Quick Open"
              : "Search Gyro"
        }
        className={[
          "gyro-command-palette is-global-search",
          isStale ? "is-ranking" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <header>
          <span className="gyro-global-search-glyph">
            <Search size={16} />
          </span>
          <input
            aria-activedescendant={activeEntry?.id}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-label={
              mode === "commands"
                ? "Search commands"
                : mode === "files"
                  ? "Search files by name"
                  : "Search files, projects, sessions, and actions"
            }
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
            placeholder={
              mode === "commands"
                ? "Type a command"
                : mode === "files"
                  ? "Search files by name"
                  : "Search files, projects, sessions, and actions"
            }
            ref={inputRef}
            role="combobox"
            value={query}
          />
          <kbd>{primaryGlobalSearchShortcut(mode)}</kbd>
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
              <span>Try a file, project, session title, or Gyro action.</span>
            </div>
          ) : null}
          {groups.map((group) => (
            <section className="gyro-global-search-group" key={group.id}>
              <div className="gyro-global-search-heading">
                <span>{group.label}</span>
                <span className="gyro-global-search-count">
                  {group.hits.length}
                </span>
              </div>
              {group.hits.map(({ entry, match }, groupIndex) => {
                const Icon = entry.icon;
                const index = visibleHits.indexOf(group.hits[groupIndex]!);
                const active = index === selectedIndex;
                return (
                  <button
                    aria-disabled={Boolean(entry.disabledReason)}
                    aria-selected={active}
                    className={[
                      active ? "is-active" : "",
                      entry.disabledReason ? "is-disabled" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    id={entry.id}
                    key={entry.id}
                    onClick={() => activateEntry(entry)}
                    onPointerDown={(event) => event.preventDefault()}
                    onPointerMove={() => setSelectedIndex(index)}
                    ref={(node) => {
                      if (node) optionRefs.current.set(entry.id, node);
                      else optionRefs.current.delete(entry.id);
                    }}
                    role="option"
                    type="button"
                  >
                    <span className="gyro-global-search-icon">
                      <Icon size={15} />
                    </span>
                    <span className="gyro-global-search-copy">
                      <strong>
                        <GlobalSearchHighlight
                          ranges={match.labelRanges}
                          text={entry.label}
                        />
                      </strong>
                      <small>
                        {entry.disabledReason ? (
                          entry.disabledReason
                        ) : (
                          <GlobalSearchHighlight
                            ranges={match.detailRanges}
                            text={entry.detail}
                          />
                        )}
                      </small>
                    </span>
                    {entry.shortcut ? (
                      <kbd>{entry.shortcut}</kbd>
                    ) : active && !entry.disabledReason ? (
                      <kbd className="gyro-global-search-enter">↵</kbd>
                    ) : null}
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
          <span>
            {query.trim()
              ? `${visibleEntries.length} result${visibleEntries.length === 1 ? "" : "s"} · local only`
              : "Search stays local to this Mac."}
          </span>
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

type ChatCloseConfirmOverlayProps = {
  chatLabel: string;
  hasModelTerminal?: boolean;
  onCancel: () => void;
  /** Close the pane and leave the provider turn running in the background. */
  onKeepRunning: () => void;
  /** Stop the provider turn (and model terminal if any), then close the pane. */
  onStopAndClose: () => void;
};

/**
 * Closing a chat pane does not always mean the user wants the backend CLI
 * to keep burning power. Ask when a turn (or model-owned terminal) is live.
 */
export function ChatCloseConfirmOverlay({
  chatLabel,
  hasModelTerminal = false,
  onCancel,
  onKeepRunning,
  onStopAndClose,
}: ChatCloseConfirmOverlayProps) {
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
        aria-label={`Close ${chatLabel}`}
        className="gyro-terminal-terminate-card gyro-chat-close-card"
      >
        <div className="gyro-terminal-terminate-heading">
          <MessageSquare size={16} />
          <h2>Stop this chat?</h2>
        </div>
        <p>
          <strong>{chatLabel}</strong> still has work running
          {hasModelTerminal ? " and a model-owned terminal" : ""}. Closing the
          pane without stopping leaves it using power in the background.
        </p>
        <div className="gyro-terminal-terminate-actions gyro-chat-close-actions">
          <button onClick={onCancel} type="button">
            Cancel
          </button>
          <button onClick={onKeepRunning} type="button">
            Keep running
          </button>
          <button
            autoFocus
            className="is-danger"
            onClick={onStopAndClose}
            type="button"
          >
            Stop and close
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
  modelFollow?: ModelFollowMode;
  defaultWorkspaceMode?: WorkbenchMode;
  onModelFollowChange?: (mode: ModelFollowMode) => void;
  onDefaultWorkspaceModeChange?: (mode: WorkbenchMode) => void;
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
  /** Repairs a connected provider whose credential the provider itself rejected. */
  onSignInProvider?: (providerId: string) => void;
  providerStatuses?: ProviderStatus[];
  onSelectProviderDefaultModel?: (
    providerId: ProviderId,
    modelId: string,
  ) => void;
  selectedUsageProviderId?: ProviderId;
  usageVisualization?: "bars" | "wheels";
  providerUsage?: ProviderUsageState;
  /** Local ledger summary used for spend-limit controls. */
  providerLedger?: ProviderLedgerSummary;
  usageSafety?: UsageSafetySnapshot;
  onProviderBudgetChange?: (providerId: ProviderId, maxTokens: number) => void;
  onUsagePauseChange?: (paused: boolean) => void;
  onUsageProviderChange?: (providerId: ProviderId) => void;
  onUsageVisualizationChange?: (visualization: "bars" | "wheels") => void;
  onRefreshProviderUsage?: (providerId: ProviderId) => void;
  updateState?: UpdateState;
  activeWorkspaceRoot?: string;
  workspacePath?: string;
  workspaceRoots?: string[];
  workspaceUserSettings?: WorkspaceScopedSettings;
  workspaceSettingsByWorkspace?: Record<string, WorkspaceScopedSettings>;
  workspaceSettingsByFolder?: Record<string, WorkspaceScopedSettings>;
  workspaceKeybindings?: Record<string, WorkspaceKeybinding | null>;
  workspaceLanguageServers?: LanguageServerState[];
  workspaceContributions?: IdeContribution[];
  onWorkspaceSettingsChange?: (
    scope: WorkspaceSettingScope,
    path: string | undefined,
    settings: WorkspaceScopedSettings,
  ) => void;
  onWorkspaceKeybindingChange?: (
    commandId: string,
    keybinding?: WorkspaceKeybinding | null,
  ) => void;
  onRegisterWorkspaceContribution?: (contribution: IdeContribution) => void;
  onToggleWorkspaceContribution?: (id: string, enabled: boolean) => void;
  onRemoveWorkspaceContribution?: (id: string) => void;
};

/**
 * A native `<details>` stays open until its own summary is pressed again, so
 * the disclosure is controlled here to dismiss it like every other dropdown.
 */
function ProviderDetailsMenu({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const detailsRef = useOutsidePointerDismiss<HTMLDetailsElement>(isOpen, () =>
    setIsOpen(false),
  );

  return (
    <details
      className="gyro-provider-details"
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      open={isOpen}
      ref={detailsRef}
    >
      <summary aria-label={label}>
        <MoreHorizontal size={16} />
      </summary>
      {children}
    </details>
  );
}

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
  modelFollow = "peek",
  defaultWorkspaceMode = "local",
  onModelFollowChange,
  onDefaultWorkspaceModeChange,
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
  onSignInProvider,
  providerStatuses,
  onSelectProviderDefaultModel,
  selectedUsageProviderId,
  usageVisualization = "bars",
  providerUsage,
  providerLedger,
  usageSafety,
  onProviderBudgetChange,
  onUsagePauseChange,
  onUsageProviderChange,
  onUsageVisualizationChange,
  onRefreshProviderUsage,
  updateState,
  activeWorkspaceRoot,
  workspacePath,
  workspaceRoots = workspacePath ? [workspacePath] : [],
  workspaceUserSettings,
  workspaceSettingsByWorkspace,
  workspaceSettingsByFolder,
  workspaceKeybindings,
  workspaceLanguageServers,
  workspaceContributions,
  onWorkspaceSettingsChange,
  onWorkspaceKeybindingChange,
  onRegisterWorkspaceContribution,
  onToggleWorkspaceContribution,
  onRemoveWorkspaceContribution,
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
            <SettingsGroup label="Model activity">
              <SettingsRow
                label="When the model opens a workspace surface"
                detail="Peek keeps you in the thread and shows a strip above the composer. Follow lets the model switch the app to what it opened."
              >
                <SettingsSegmented
                  label="Model activity behavior"
                  value={modelFollow}
                  options={[
                    { label: "Off", value: "off" },
                    { label: "Peek", value: "peek" },
                    { label: "Follow", value: "follow" },
                  ]}
                  onChange={(value) => onModelFollowChange?.(value)}
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

        {activeSection === "editor-workspace" ? (
          <WorkspaceSettingsEditor
            activeWorkspaceRoot={activeWorkspaceRoot}
            folderSettings={workspaceSettingsByFolder}
            keybindings={workspaceKeybindings}
            onChange={onWorkspaceSettingsChange}
            userSettings={workspaceUserSettings}
            view="editor"
            workspacePath={workspacePath}
            workspaceRoots={workspaceRoots}
            workspaceSettings={workspaceSettingsByWorkspace}
          />
        ) : null}

        {activeSection === "tools-contributions" ? (
          <WorkspaceSettingsEditor
            activeWorkspaceRoot={activeWorkspaceRoot}
            contributions={workspaceContributions}
            folderSettings={workspaceSettingsByFolder}
            keybindings={workspaceKeybindings}
            languageServers={workspaceLanguageServers}
            onKeybindingChange={onWorkspaceKeybindingChange}
            onRegisterContribution={onRegisterWorkspaceContribution}
            onRemoveContribution={onRemoveWorkspaceContribution}
            onToggleContribution={onToggleWorkspaceContribution}
            userSettings={workspaceUserSettings}
            view="tools"
            workspacePath={workspacePath}
            workspaceRoots={workspaceRoots}
            workspaceSettings={workspaceSettingsByWorkspace}
          />
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
                        {providerConnectionLabel(
                          provider,
                          providerStatuses?.find(
                            (status) => status.id === provider.id,
                          ),
                        )}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="gyro-usage-toolbar">
                  <div>
                    <strong>
                      {usageProvider.id === "openai" ||
                      usageProvider.id === "anthropic" ||
                      usageProvider.id === "xai"
                        ? `${usageProvider.displayName} plan windows`
                        : `${usageProvider.displayName} spend`}
                    </strong>
                    <span>
                      {providerUsage?.status === "available" &&
                      providerUsage.windows.length > 0
                        ? providerUsage.fetchedAt
                          ? `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(providerUsage.fetchedAt))}${providerUsage.stale ? " · stale" : ""} · % of window spent`
                          : "Percent of each plan window spent"
                        : providerUsage?.status === "loading"
                          ? "Checking with the provider…"
                          : usageProvider.id === "openai" ||
                              usageProvider.id === "anthropic" ||
                              usageProvider.id === "xai"
                            ? usageProvider.id === "xai"
                              ? "Refresh to load Grok Build weekly credit usage"
                              : "Plan windows appear after the first chat or refresh"
                            : "No plan window API on this provider — local spend is below"}
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
                {providerUsage?.status === "available" &&
                providerUsage.windows.length > 0 ? (
                  <div className="gyro-usage-cards">
                    {/* Show every window the provider (or ledger) reported —
                        five-hour, weekly, weekly-opus, etc. — not only two slots. */}
                    {[...providerUsage.windows]
                      .sort((left, right) => {
                        const order = ["five-hour", "weekly"];
                        const leftRank = order.indexOf(left.id);
                        const rightRank = order.indexOf(right.id);
                        return (
                          (leftRank === -1 ? order.length : leftRank) -
                          (rightRank === -1 ? order.length : rightRank)
                        );
                      })
                      .map((window) => (
                        <UsageCard
                          key={window.id}
                          visualization={usageVisualization}
                          window={window}
                        />
                      ))}
                  </div>
                ) : providerUsage?.status === "loading" ||
                  providerUsage?.status === "error" ? (
                  <div className="gyro-usage-empty" role="status">
                    <Gauge size={22} />
                    <div>
                      <strong>
                        {providerUsage.status === "loading"
                          ? "Loading provider allowance…"
                          : "Provider allowance could not be loaded"}
                      </strong>
                      <span>
                        {providerUsage.error ??
                          "Connect or refresh this provider to load plan usage."}
                      </span>
                    </div>
                    <button
                      className="gyro-secondary-button"
                      disabled={providerUsage.status === "loading"}
                      onClick={() => onRefreshProviderUsage?.(usageProvider.id)}
                      type="button"
                    >
                      <RefreshCw size={14} />
                      Refresh
                    </button>
                  </div>
                ) : null}
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
            <SettingsGroup label="Spend limits">
              <SettingsRow
                label={
                  usageProvider
                    ? `${usageProvider.displayName} daily budget`
                    : "Daily budget"
                }
                detail={
                  providerLedger?.budget
                    ? "Holds council runs and automations at 90%, and stops this provider at 100%."
                    : "Set a cap and Gyro measures against it instead of the default reference."
                }
              >
                <select
                  aria-label="Daily token budget"
                  className="gyro-settings-select"
                  disabled={!usageProvider}
                  onChange={(event) =>
                    usageProvider &&
                    onProviderBudgetChange?.(
                      usageProvider.id,
                      Number(event.target.value),
                    )
                  }
                  value={String(providerLedger?.budget?.maxTokens ?? 0)}
                >
                  {budgetOptions(providerLedger?.budget?.maxTokens).map(
                    (option) => (
                      <option key={option.value} value={String(option.value)}>
                        {option.label}
                      </option>
                    ),
                  )}
                </select>
              </SettingsRow>
              <SettingsRow
                label="Pause provider runs"
                detail={
                  usageSafety?.pause.active
                    ? usagePauseDetail(usageSafety)
                    : "Hold every provider run until you resume. Automations included."
                }
              >
                <SettingsSwitch
                  checked={Boolean(usageSafety?.pause.active)}
                  label="Pause provider runs"
                  onChange={(checked) => onUsagePauseChange?.(checked)}
                />
              </SettingsRow>
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
            description="Connect a provider and choose the model it starts new chats with."
          >
            <div className="gyro-provider-table is-native-list">
              <div className="gyro-provider-table-head">
                <span>Provider</span>
                <span>Default model</span>
                <span>Connection</span>
                <span>Actions</span>
              </div>
              {[...enabledProviders, ...disabledProviders].map((provider) => {
                const capabilities = providerCapabilities(provider.id);
                const defaultModelId = providerDefaultModelId(provider);
                const hasModelChoice = provider.models.length > 1;
                const health = providerStatuses?.find(
                  (status) => status.id === provider.id,
                );
                const needsSignInRepair = providerNeedsSignInRepair(
                  provider,
                  health,
                );
                return (
                  <div
                    className={`gyro-provider-row${capabilities?.executable ? "" : " is-readiness-only"}`}
                    key={provider.id}
                  >
                    <div className="gyro-provider-identity">
                      <ProviderLogo providerId={provider.id} />
                      <strong>{provider.displayName}</strong>
                    </div>
                    <div className="gyro-provider-default-model">
                      {hasModelChoice ? (
                        <select
                          aria-label={`${provider.displayName} default model`}
                          onChange={(event) =>
                            onSelectProviderDefaultModel?.(
                              provider.id,
                              event.target.value,
                            )
                          }
                          value={defaultModelId ?? ""}
                        >
                          {provider.models.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.displayName}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <strong>{defaultModelLabel(provider)}</strong>
                      )}
                    </div>
                    <SettingsStatus
                      status={
                        needsSignInRepair ||
                        provider.authStatus === "connecting"
                          ? "warning"
                          : provider.authStatus === "connected"
                            ? "good"
                            : "neutral"
                      }
                    >
                      {providerConnectionLabel(provider, health)}
                    </SettingsStatus>
                    <div className="gyro-settings-provider-actions">
                      <button
                        className="gyro-primary-button"
                        disabled={
                          provider.authStatus === "connecting" ||
                          (provider.authStatus === "connected" &&
                            !needsSignInRepair)
                        }
                        onClick={() =>
                          needsSignInRepair
                            ? onSignInProvider?.(provider.id)
                            : onToggleProvider?.(provider.id)
                        }
                        type="button"
                      >
                        {needsSignInRepair
                          ? "Sign in again"
                          : provider.authStatus === "connected"
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
                      <ProviderDetailsMenu
                        label={`${provider.displayName} details`}
                      >
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
                      </ProviderDetailsMenu>
                    </div>
                  </div>
                );
              })}
            </div>
            <SettingsGroup
              badge={
                COUNCIL_COMING_SOON ? COUNCIL_COMING_SOON_LABEL : undefined
              }
              label="Model Council"
            >
              <SettingsRow
                label="Enable Council mode"
                detail={
                  COUNCIL_COMING_SOON
                    ? "Parallel multi-provider answers with synthesis. Still in development and not yet available to run."
                    : "Parallel multi-provider answers with synthesis for high-stakes coding decisions."
                }
              >
                <SettingsSwitch
                  label="Enable Council mode"
                  checked={normalizedCouncilConfig(config.council).enabled}
                  disabled={COUNCIL_COMING_SOON}
                  onChange={(checked) =>
                    onConfigChange?.({
                      ...config,
                      council: {
                        ...normalizedCouncilConfig(config.council),
                        enabled: checked,
                      },
                    })
                  }
                />
              </SettingsRow>
              <SettingsRow
                label="Default preset"
                detail="Which council membership to use when you enable Council mode."
              >
                <select
                  aria-label="Default Council preset"
                  disabled={COUNCIL_COMING_SOON}
                  onChange={(event) =>
                    onConfigChange?.({
                      ...config,
                      council: {
                        ...normalizedCouncilConfig(config.council),
                        defaultPresetId: event.target.value,
                      },
                    })
                  }
                  value={
                    normalizedCouncilConfig(config.council).defaultPresetId
                  }
                >
                  {normalizedCouncilConfig(config.council).presets.map(
                    (preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ),
                  )}
                </select>
              </SettingsRow>
              <SettingsRow
                label="Synthesize on partial"
                detail="When one seat fails, still synthesize from the seats that finished."
              >
                <SettingsSwitch
                  label="Synthesize on partial"
                  checked={
                    normalizedCouncilConfig(config.council).synthesizeOnPartial
                  }
                  disabled={COUNCIL_COMING_SOON}
                  onChange={(checked) =>
                    onConfigChange?.({
                      ...config,
                      council: {
                        ...normalizedCouncilConfig(config.council),
                        synthesizeOnPartial: checked,
                      },
                    })
                  }
                />
              </SettingsRow>
            </SettingsGroup>
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
                label="New chats start in"
                detail="Project folder edits the project you opened. Agent workspace gives the agent a private branch under Gyro so main stays untouched."
              >
                <select
                  aria-label="Default workspace mode for new chats"
                  onChange={(event) => {
                    const mode =
                      event.target.value === "worktree" ? "worktree" : "local";
                    onDefaultWorkspaceModeChange?.(mode);
                  }}
                  value={defaultWorkspaceMode}
                >
                  <option value="local">Project folder</option>
                  <option value="worktree">Agent workspace</option>
                </select>
              </SettingsRow>
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
  badge,
  children,
}: {
  label: string;
  /** Marks a group whose controls are visible but not yet usable. */
  badge?: string;
  children: ReactNode;
}) {
  return (
    <section className={`gyro-settings-group${badge ? " is-unavailable" : ""}`}>
      {badge ? (
        <h2>
          {label}
          <span className="gyro-settings-group-badge">{badge}</span>
        </h2>
      ) : (
        <h2>{label}</h2>
      )}
      <div className="gyro-settings-group-rows">{children}</div>
    </section>
  );
}

function SettingsSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={`gyro-settings-switch${checked ? " is-on" : ""}`}
      disabled={disabled}
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

/**
 * What Gyro measured for a provider, as opposed to what the provider reported.
 *
 * This is the part that works everywhere: Codex is the only CLI with a quota
 * endpoint, so without the ledger four of five providers had nothing to show.
 */
/** Budget choices, in the units people actually think in. */
function budgetOptions(current?: number) {
  const presets = [
    { label: "No limit", value: 0 },
    { label: "500K tokens / day", value: 500_000 },
    { label: "1M tokens / day", value: 1_000_000 },
    { label: "2M tokens / day", value: 2_000_000 },
    { label: "5M tokens / day", value: 5_000_000 },
    { label: "10M tokens / day", value: 10_000_000 },
  ];
  // A budget set by hand in config may not match a preset, and picking it must
  // not silently round the user's number to the nearest option.
  if (current && !presets.some((preset) => preset.value === current)) {
    presets.push({
      label: `${formatTokenCount(current)} tokens / day`,
      value: current,
    });
    presets.sort((left, right) => left.value - right.value);
  }
  return presets;
}

/** Why runs are held, for the Settings row rather than the composer banner. */
function usagePauseDetail(snapshot: UsageSafetySnapshot) {
  const notice = summarizeUsageSafety(snapshot);
  return notice ? [notice.title, notice.detail].filter(Boolean).join(" ") : "";
}

function UsageCard({
  window,
  visualization,
}: {
  window?: ProviderUsageState["windows"][number];
  visualization: "bars" | "wheels";
}) {
  if (!window) return null;
  // Plan windows report how much of the allowance is *spent* this period.
  // The bar fills as spend builds up.
  const measured =
    typeof window.usedPercent === "number" &&
    Number.isFinite(window.usedPercent);
  const used = measured
    ? Math.max(0, Math.min(100, Math.round(window.usedPercent!)))
    : window.status === "exhausted"
      ? 100
      : undefined;
  const severity =
    window.status === "exhausted" || (used !== undefined && used >= 95)
      ? "critical"
      : window.status === "warning" || (used !== undefined && used >= 80)
        ? "warning"
        : "normal";
  const usedLabel =
    used === undefined
      ? "—"
      : used === 0 && measured && (window.usedPercent ?? 0) > 0
        ? "<1"
        : String(used);
  return (
    <article className={`gyro-usage-card is-${severity}`}>
      <header>
        <strong>{window.label}</strong>
        <span>
          {severity === "critical"
            ? "Limit reached"
            : severity === "warning"
              ? "High usage"
              : used === undefined
                ? "Unmeasured"
                : "Within limit"}
        </span>
      </header>
      {visualization === "wheels" ? (
        <div
          className="gyro-usage-wheel"
          style={
            {
              "--usage": `${(used ?? 0) * 3.6}deg`,
            } as CSSProperties
          }
        >
          <span>
            <strong>{used === undefined ? "—" : `${usedLabel}%`}</strong>
            <small>used</small>
          </span>
        </div>
      ) : (
        <div
          className={`gyro-usage-bar${used === undefined ? " is-unmeasured" : ""}`}
          aria-label={
            used === undefined
              ? `${window.label}: level not reported`
              : `${usedLabel}% used`
          }
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(used !== undefined ? { "aria-valuenow": used } : {})}
        >
          {used !== undefined ? (
            <span
              style={{
                width: `${Math.max(used, used > 0 ? 2 : 0)}%`,
              }}
            />
          ) : null}
        </div>
      )}
      <div className="gyro-usage-card-meta">
        <strong>
          {used === undefined ? "Level not reported" : `${usedLabel}% used`}
        </strong>
        <span>
          {window.resetsAt
            ? formatUsageReset(window.resetsAt)
            : "Resets with plan window"}
        </span>
      </div>
    </article>
  );
}

/**
 * One plan limit under the composer's context bar.
 *
 * A window whose level the provider never measures renders an unfilled track
 * rather than a guess, so the bar reads as "Gyro was not told" instead of
 * "you have used none of it" — the two look identical once a bar is filled.
 */
function ComposerLimitRow({ window }: { window: ComposerLimitWindow }) {
  const measured = window.percent !== undefined;
  return (
    <div className={`gyro-composer-limit-row is-${window.severity}`}>
      <div className="gyro-composer-limit-heading">
        <strong>{window.label}</strong>
        <span>
          {window.resetsLabel ? <em>{window.resetsLabel}</em> : null}
          <b>{window.percentLabel}</b>
        </span>
      </div>
      <div
        aria-label={`${window.label}: ${
          measured ? `${window.percentLabel} used` : "level not reported"
        }`}
        aria-valuemax={100}
        aria-valuemin={0}
        {...(measured ? { "aria-valuenow": window.percent } : {})}
        className={`gyro-composer-limit-bar${measured ? "" : " is-unmeasured"}`}
        role="progressbar"
      >
        {measured ? <span style={{ width: `${window.percent}%` }} /> : null}
      </div>
    </div>
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
    | "warning"
    | "workspace-mode";
  sectionLabel?: string;
  providerId?: ProviderId;
  active?: boolean;
  disabled?: boolean;
  showChevron?: boolean;
  trailingLabel?: string;
  /** Accent chip next to the title (e.g. Recommended) — not the trailing slot. */
  badge?: string;
  /** Soften connected/disconnected contrast without washing brand color out. */
  disconnected?: boolean;
  hideIcon?: boolean;
};

type ComposerSlashCommand = {
  command: string;
  label: string;
  icon: IconComponent;
  action?: string;
  popover?: Extract<ComposerPopoverId, "approval" | "provider">;
  /** Plain-language explainer shown when hovering the row's "?" marker. */
  hint?: string;
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
        detail: "Agent workspace keeps this private branch for the chat",
        icon: GitBranch,
        label: branchName,
      },
    ];
  }
  const createBranchItem: ComposerPopoverItem = {
    action: `create-branch-from:${encodeURIComponent(branchCatalog.current ?? "")}`,
    disabled: isDisabled,
    detail: isDisabled
      ? "Wait for the active turn to finish"
      : branchCatalog.current
        ? `Branch from ${branchCatalog.current}`
        : "Branch from the current commit",
    icon: GitBranchPlus,
    label: "New branch…",
  };
  const branchItems = branchCatalog.branches.map((branch) => ({
    action: `select-branch:${encodeURIComponent(branch)}`,
    active: branch === branchCatalog.current,
    disabled: isDisabled,
    removeAction:
      branch !== branchCatalog.current &&
      branchCatalog.worktrees?.some((worktree) => worktree.branch === branch)
        ? `remove-worktree:${encodeURIComponent(branch)}`
        : undefined,
    detail: isDisabled
      ? "Wait for the active turn to finish"
      : branch === branchCatalog.current
        ? "Current workspace branch"
        : branchCatalog.worktrees?.some(
              (worktree) => worktree.branch === branch,
            )
          ? "Checked out in a linked worktree"
          : "Switch this clean workspace",
    icon: GitBranch,
    label: branch,
  }));
  return [createBranchItem, ...branchItems];
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
          item.disconnected ? "is-disconnected" : "",
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
              <span className="gyro-composer-menu-item-title">
                <strong>{item.label}</strong>
                {item.badge ? (
                  <em className="gyro-composer-menu-badge">{item.badge}</em>
                ) : null}
              </span>
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
    return "Uses Grok Build's local login or XAI_API_KEY through ACP; credentials and billing stay with xAI.";
  }
  if (providerId === "gemini") {
    return "Uses Gemini CLI's local Google login or environment credentials through ACP; plan access stays with Google.";
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
    return "Grok Build sign-in";
  }
  if (providerId === "gemini") {
    return "Gemini CLI sign-in";
  }
  return "Provider-owned";
}

function providerCredentialSummary(secretStorage?: string) {
  if (secretStorage?.trim()) {
    return secretStorage.replace(/;.*$/, ".");
  }
  return "Gyro stores readiness only.";
}

/**
 * What the connection column may claim.
 *
 * "verified" is a claim about the credential working, and only live health can
 * support it. Reading `authStatus` alone is what let Settings report a verified
 * Claude Code sign-in while every send in chat came back rejected.
 */
function providerConnectionLabel(
  provider: Pick<ModelProviderConfig, "authStatus" | "enabled"> & {
    id: ProviderId;
  },
  health?: Pick<
    ProviderStatus,
    "connectionStatus" | "runtimeStatus" | "signInRejectedAt"
  >,
) {
  if (providerNeedsSignInRepair(provider, health)) {
    return health?.signInRejectedAt ? "sign-in expired" : "needs attention";
  }
  if (provider.authStatus === "connected" && provider.id === "openai") {
    return "verified via Codex";
  }
  if (provider.authStatus === "connected" && provider.id === "anthropic") {
    return "verified via Claude Code";
  }
  if (provider.authStatus === "connected" && provider.id === "kimi") {
    return "verified via Kimi Code";
  }
  if (provider.authStatus === "connected" && provider.id === "xai") {
    return "verified via Grok Build";
  }
  if (provider.authStatus === "connected" && provider.id === "gemini") {
    return "verified via Gemini CLI";
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
  if (provider.id === "xai") {
    return "xAI is available through the local Grok Build sign-in on this Mac.";
  }
  if (provider.id === "gemini") {
    return "Gemini is available through the local Gemini CLI sign-in on this Mac.";
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
        title="Claude"
      >
        <svg viewBox="0 0 24 24">
          <path
            d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
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
        <svg viewBox="0 0 24 25">
          <path
            className="gyro-kimi-logo-dot"
            d="M21.7202 0.939941C22.9502 0.939941 23.9502 1.93994 23.9502 3.16994C23.9502 4.39994 22.9502 5.39994 21.7202 5.39994H19.7502C19.6002 5.39994 19.4902 5.27994 19.4902 5.13994V3.16994C19.4902 1.93994 20.4902 0.939941 21.7202 0.939941Z"
          />
          <path
            className="gyro-kimi-logo-symbol"
            d="M9.39 13.9501L17.82 5.59012C17.98 5.43012 17.89 5.12012 17.68 5.12012H13.14C13.14 5.12012 13.04 5.14012 13 5.18012L3.92 14.1901C3.78 14.3301 3.57 14.2101 3.57 13.9801V5.39012C3.57 5.24012 3.47 5.12012 3.35 5.12012H0.219999C0.0999993 5.12012 0 5.24012 0 5.39012V23.9201C0 24.0701 0.0999993 24.1901 0.219999 24.1901H3.35C3.47 24.1901 3.57 24.0701 3.57 23.9201V20.1401C3.57 20.0601 3.6 19.9801 3.65 19.9301L6.47 17.1401C6.54 17.0701 6.63 17.0601 6.71 17.1101L14.24 22.6501C15.47 23.4801 16.85 23.9901 18.25 24.1401C18.37 24.1501 18.48 24.0301 18.48 23.8701V20.3101C18.48 20.1701 18.4 20.0601 18.29 20.0501C17.47 19.9201 16.66 19.6001 15.94 19.1101L9.42 14.3901C9.28 14.3001 9.27 14.0701 9.39 13.9501Z"
          />
        </svg>
      </span>
    );
  }

  if (providerId === "xai") {
    // Grok monochrome mark (not the X/Twitter glyph and not the geometric xAI
    // lockup, which reads as a broken X at 15–19px). currentColor follows theme.
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-xai"
        title="Grok"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
          <path d="M9.27 15.29 17.248 9.393c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 0 0-1.829-1A8.975 8.975 0 0 0 5.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
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

  // Cursor and OpenCode marks from Simple Icons 16.27.1 (CC0-1.0), the same
  // source the download site inlines. Both are monochrome, so currentColor
  // carries them across themes.
  if (providerId === "cursor") {
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-cursor"
        title="Cursor"
      >
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
        </svg>
      </span>
    );
  }

  if (providerId === "opencode") {
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-opencode"
        title="OpenCode"
      >
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
        </svg>
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`gyro-provider-logo is-${providerId}`}
      title={providerId}
    >
      <span>{String(providerId).slice(0, 2)}</span>
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
        gatedLabel: "Ask first",
        gatedDetail: "Claude asks before tools and edits",
        autoLabel: "Allow in project",
        autoDetail: "Claude can work without prompts inside its boundary",
        directLabel: "Full access",
        directDetail: "Claude can use Git, network, and user tools directly",
        commandValue: config.requireCommandApproval ? "Ask first" : "Allow",
        commandDetail: "Claude tool calls use the backend command policy.",
        editValue: config.requireFileEditApproval ? "Review" : "Auto-accept",
        editDetail: "Claude edits follow the backend diff policy.",
      }
    : {
        title: providerTitle,
        gatedLabel: "Ask first",
        gatedDetail: `${agentName} asks before commands and file edits`,
        autoLabel: "Allow in project",
        autoDetail: `${agentName} works without prompts inside its provider boundary`,
        directLabel: "Full access",
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
  providerStatuses,
  providerUsage,
  limitWindows = [],
  onComposerAction,
  onCancelGoalComposer,
  sessionModel,
  sessionGoal,
  promptHistory = [],
  contextUsage,
  sessionUsage,
  usageSafety,
  onResumeUsage,
  isGoalComposerActive = false,
  savedProjects = [],
  surfaceControls,
  isSending = false,
  isBranchLoading,
  maxDraftLength,
  popoverPlacement,
  showContextRow,
  /** False while the desktop shell is still warming the backend. */
  shellReady = true,
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
  providerStatuses?: ProviderStatus[];
  providerUsage?: ProviderUsageState;
  limitWindows?: ComposerLimitWindow[];
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
  /** Ledger totals for this chat, shown as the running cost line. */
  sessionUsage?: SessionUsageTotals;
  usageSafety?: UsageSafetySnapshot;
  onResumeUsage?: () => void;
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
  shellReady?: boolean;
  variant?: "thread" | "hero";
}) {
  const [activePopover, setActivePopover] = useState<ComposerPopoverId | null>(
    null,
  );
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [modelPickerProviderId, setModelPickerProviderId] = useState<
    ProviderId | undefined
  >(undefined);
  const [modelFlyoutVertical, setModelFlyoutVertical] = useState<"down" | "up">(
    "down",
  );
  // Pixels to shift the whole picker left so models stay on-screen (right of
  // providers) without clipping the viewport edge.
  const [modelFlyoutShiftX, setModelFlyoutShiftX] = useState(0);
  // Where the models open relative to the provider list. The Workspace AI
  // sidebar is narrower than the two lists side by side, so the flyout flips
  // to the left, and stacks above the list when neither side fits.
  const [modelFlyoutSide, setModelFlyoutSide] = useState<
    "right" | "left" | "stacked"
  >("right");
  const [historyIndex, setHistoryIndex] = useState<number>();
  const [activeSlashCommandIndex, setActiveSlashCommandIndex] = useState(0);
  const [isSlashMenuDismissed, setIsSlashMenuDismissed] = useState(false);
  // Hover explainer for a slash command. Positioned fixed against the "?"
  // marker so it can escape the menu's own scroll clipping.
  const [slashHint, setSlashHint] = useState<{
    text: string;
    top: number;
    left: number;
  }>();
  const slashCommandRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const providerPickerRef = useRef<HTMLDivElement | null>(null);
  // Sticky model-flyout hover: brief crossings of other rows must not yank the
  // models panel closed before the pointer reaches it.
  const modelPickerProviderIdRef = useRef<ProviderId | undefined>(undefined);
  const modelFlyoutPreviewTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const clearModelFlyoutPreviewTimer = useCallback(() => {
    if (modelFlyoutPreviewTimerRef.current != null) {
      clearTimeout(modelFlyoutPreviewTimerRef.current);
      modelFlyoutPreviewTimerRef.current = null;
    }
  }, []);
  const setModelPickerProviderIdSticky = useCallback(
    (providerId: ProviderId | undefined) => {
      clearModelFlyoutPreviewTimer();
      modelPickerProviderIdRef.current = providerId;
      setModelPickerProviderId(providerId);
    },
    [clearModelFlyoutPreviewTimer],
  );
  const previewConnectedProviderModels = useCallback(
    (providerId: ProviderId) => {
      if (modelPickerProviderIdRef.current === providerId) {
        clearModelFlyoutPreviewTimer();
        return;
      }
      // First open is immediate; switches wait so a diagonal path to the
      // models list is not hijacked by a 1ms graze of a neighbour row.
      const delayMs = modelPickerProviderIdRef.current ? 160 : 0;
      clearModelFlyoutPreviewTimer();
      if (delayMs === 0) {
        modelPickerProviderIdRef.current = providerId;
        setModelPickerProviderId(providerId);
        return;
      }
      modelFlyoutPreviewTimerRef.current = setTimeout(() => {
        modelPickerProviderIdRef.current = providerId;
        setModelPickerProviderId(providerId);
        modelFlyoutPreviewTimerRef.current = null;
      }, delayMs);
    },
    [clearModelFlyoutPreviewTimer],
  );
  useEffect(
    () => () => {
      clearModelFlyoutPreviewTimer();
    },
    [clearModelFlyoutPreviewTimer],
  );
  // Scoped to the open control (its trigger plus panel) rather than the whole
  // composer, so pressing the textarea or any other chip closes the dropdown.
  const popoverScopeRef = useOutsidePointerDismiss<HTMLDivElement>(
    Boolean(activePopover),
    () => {
      setActivePopover(null);
      setModelPickerProviderIdSticky(undefined);
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
  // Each chat pane may bind its own provider/model. Prefer that over the
  // workbench-wide selection so split-screen composers can diverge.
  const boundToSession = Boolean(
    sessionModel?.providerId &&
      (sessionModel.modelId || sessionModel.modelLabel),
  );
  const effectiveProviderId = boundToSession
    ? sessionModel?.providerId
    : config.selectedProviderId;
  const selectedProvider = providerConfigs.find(
    (provider) => provider.id === effectiveProviderId,
  );
  const sessionProvider =
    sessionModel?.providerId &&
    (sessionModel.modelLabel || sessionModel.modelId)
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
    selectedProvider ?? sessionModel?.modelLabel ?? sessionModel?.modelId,
  );
  const hasReadyProvider = Boolean(
    selectedProvider?.authStatus === "connected" ||
    sessionProvider?.authStatus === "connected",
  );
  const effectiveModelId = boundToSession
    ? sessionModel?.modelId
    : selectedProvider?.selectedModelId;
  const resolvedBoundModel =
    selectedProvider && effectiveModelId
      ? getProviderModel(selectedProvider, effectiveModelId)
      : undefined;
  const providerModelLabel = boundToSession
    ? (sessionModel?.modelLabel ??
      resolvedBoundModel?.displayName ??
      sessionModel?.modelId ??
      "Select provider")
    : selectedProvider
      ? selectedModelLabel(selectedProvider)
      : (sessionModel?.modelLabel ?? "Select provider");
  const modelChipLabel = hasSelectedProvider
    ? providerModelLabel
    : "Choose model";
  const providerReasoningEffort = boundToSession
    ? (sessionModel?.reasoningEffort ??
      (selectedProvider
        ? selectedReasoningEffort(selectedProvider)
        : undefined))
    : selectedProvider
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
  const modeChipLabel = workspaceModeLabel(workspaceMode);
  const hasUserWorkspace = Boolean(isUserSelectedWorkspacePath(workspacePath));
  const councilResolution = useMemo(() => {
    if (chatMode !== "council") {
      return undefined;
    }
    return resolveCouncilSeatRequests(
      config,
      readyCouncilProviders(config, providerStatuses),
    );
  }, [chatMode, config, providerStatuses]);
  const councilEnabled = config.council?.enabled !== false;
  const providerErrorMessage =
    providerReadiness?.status === "blocked"
      ? providerReadiness.message
      : undefined;
  const canSubmitChat =
    shellReady &&
    (chatMode === "council"
      ? councilEnabled &&
        !councilResolution?.error &&
        (councilResolution?.seats.length ?? 0) >= 2 &&
        hasUserWorkspace
      : canSendChat(hasReadyProvider, workspacePath));
  const canSubmitComposer = isGoalComposerActive || canSubmitChat;
  const preferredConnect = preferredCleanMachineConnectProvider(
    providerConfigs
      .filter((provider) => isProviderExecutable(provider.id))
      .map((provider) => ({
        executable: true,
        id: provider.id,
        label: provider.displayName,
      })),
  );
  const cleanMachinePath = resolveCleanMachinePath({
    hasReadyProvider,
    preferredProviderId: preferredConnect.id,
    preferredProviderLabel: preferredConnect.label,
    providerBlockMessage: providerErrorMessage,
    workspacePath,
  });
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
      // Connected first (A–Z), then not-yet-connected (A–Z).
      .slice()
      .sort((left, right) => {
        const leftConnected = left.authStatus === "connected" ? 0 : 1;
        const rightConnected = right.authStatus === "connected" ? 0 : 1;
        if (leftConnected !== rightConnected) {
          return leftConnected - rightConnected;
        }
        return left.displayName.localeCompare(right.displayName, undefined, {
          sensitivity: "base",
        });
      })
      .map((provider) => {
        const isConnected = provider.authStatus === "connected";
        // Clean-machine path: disconnected providers start their own login
        // instead of appearing as dead "Unavailable" rows. Always pass
        // providerId so each row shows that provider's brand mark, not a
        // generic key/bot icon (connected or Connect alike).
        return {
          action: isConnected
            ? `select-provider:${provider.id}`
            : `connect-provider:${provider.id}`,
          active: isConnected && provider.id === effectiveProviderId,
          disabled: false,
          disconnected: !isConnected,
          icon: Sparkles,
          kind: "provider" as const,
          label: provider.displayName,
          providerId: provider.id,
          showChevron: isConnected,
          trailingLabel: isConnected ? undefined : "Connect",
        };
      }),
  ];
  const activeModelIdForPicker =
    modelPickerProvider && modelPickerProvider.id === effectiveProviderId
      ? (effectiveModelId ?? modelPickerProvider.selectedModelId)
      : modelPickerProvider?.selectedModelId;
  const providerModelItems: ComposerPopoverItem[] = [
    ...(modelPickerProvider
      ? [
          ...modelPickerProvider.models.map((model) => ({
            action: `select-provider-model:${modelPickerProvider.id}:${model.id}`,
            active:
              modelPickerProvider.id === effectiveProviderId &&
              model.id === activeModelIdForPicker,
            icon: Sparkles,
            hideIcon: true,
            kind: "model" as const,
            label: model.displayName,
          })),
        ]
      : []),
  ];
  const effortSourceModel = selectedProvider
    ? getProviderModel(selectedProvider, effectiveModelId)
    : undefined;
  const effortItems: ComposerPopoverItem[] = selectedProvider
    ? (effortSourceModel?.supportedReasoningEfforts ?? []).map((effort) => ({
        action: `select-provider-effort:${selectedProvider.id}:${effort}`,
        active: effort === providerReasoningEffort,
        hideIcon: true,
        icon: Gauge,
        kind: "effort" as const,
        label: reasoningEffortLabel(effort),
      }))
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
      // Kept visible while frozen so the capability is discoverable, but
      // disabled rather than clickable — it cannot run yet.
      action: COUNCIL_COMING_SOON ? undefined : "set-chat-mode-council",
      detail: COUNCIL_COMING_SOON ? COUNCIL_COMING_SOON_LABEL : undefined,
      disabled: COUNCIL_COMING_SOON,
      icon: Users,
      label: "Council",
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
      hint: "Say what a good result looks like, and Gyro keeps it in mind for the whole chat.",
      icon: Goal,
      label: sessionGoal?.text ? "Edit goal" : "Set goal",
    },
    chatMode === "plan" || chatMode === "council"
      ? {
          action: "set-chat-mode-normal",
          command: "/normal",
          hint: "Go back to the usual way of working, where Gyro just does what you ask.",
          icon: Play,
          label: "Normal mode",
        }
      : {
          action: "set-chat-mode-plan",
          command: "/plan",
          hint: "Gyro works out the steps and shows them to you first. Nothing on your computer changes until you agree.",
          icon: LockKeyhole,
          label: "Plan mode",
        },
    // No `/council` while frozen: a slash command has no disabled state, so
    // listing one that cannot start a run would just be a dead end.
    ...(COUNCIL_COMING_SOON || chatMode === "council"
      ? []
      : [
          {
            action: "set-chat-mode-council" as const,
            command: "/council",
            hint: "Asks several AI models the same question at the same time, then hands you one combined answer.",
            icon: Users,
            label: "Council mode",
          },
        ]),
    {
      action: "attach-editor-snapshot",
      command: "/editor",
      hint: "Sends a copy of the file you have open, exactly as it looks right now.",
      icon: FileCode2,
      label: "Attach editor snapshot",
    },
    {
      action: "select-image",
      command: "/image",
      icon: ImagePlus,
      label: "Attach image",
    },
    {
      action: "select-video",
      command: "/video",
      icon: Video,
      label: "Attach video",
    },
    {
      action: "select-file",
      command: "/file",
      icon: Paperclip,
      label: "Attach file",
    },
    {
      action: "select-folder",
      command: "/folder",
      hint: "Pick the project folder this chat is allowed to work in.",
      icon: Folder,
      label: "Choose folder",
    },
    {
      action: "search-workspace",
      command: "/search",
      icon: Search,
      label: "Search workspace",
    },
    {
      command: "/model",
      icon: Sparkles,
      label: "Choose model",
      popover: "provider",
    },
    {
      command: "/permissions",
      hint: "Choose how often Gyro checks with you before it does something.",
      icon: ShieldCheck,
      label: "Change permissions",
      popover: "approval",
    },
    {
      action: "new-chat",
      command: "/new",
      icon: Edit3,
      label: "New chat",
    },
  ];
  // What this chat has spent so far, from Gyro's ledger rather than from a
  // provider's own reporting — so it is present even for the CLIs that report
  // no counts at all.
  const sessionCost = useMemo(
    () => summarizeSessionCost(sessionUsage),
    [sessionUsage],
  );
  // What the next send is about to buy. A Council send is its seats plus a
  // synthesis, so the multiplier is disclosed before Enter commits it.
  const councilSeatCount = councilResolution?.seats.length;
  const turnCost = useMemo(
    () =>
      estimateTurnCost({
        chatMode: chatMode ?? "normal",
        contextTokens: contextUsage?.usedTokens ?? 0,
        reasoningEffort: providerReasoningEffort,
        seatCount: councilSeatCount,
        sessionTotals: sessionUsage,
      }),
    [
      chatMode,
      contextUsage?.usedTokens,
      councilSeatCount,
      providerReasoningEffort,
      sessionUsage,
    ],
  );
  // An expensive send is armed once and sent on the second press, so quota is
  // never committed by a single keystroke.
  const [isCostConfirmPending, setIsCostConfirmPending] = useState(false);
  const needsCostConfirm = !isGoalComposerActive && turnCost.needsConfirm;
  useEffect(() => {
    setIsCostConfirmPending(false);
  }, [chatMode, councilSeatCount, providerReasoningEffort]);
  const requestSend = () => {
    if (needsCostConfirm && !isCostConfirmPending) {
      setIsCostConfirmPending(true);
      return;
    }
    setIsCostConfirmPending(false);
    onSend();
  };
  const costPreviewTitle = `Each seat carries this chat's context, and the synthesizer then reads their answers. Estimated total for one send: ${turnCost.label}.`;
  // Why runs are stopped, or which budget is about to stop them. A pause
  // outranks a budget warning: the banner explains the block, not every number.
  const safetyNotice = useMemo(
    () => summarizeUsageSafety(usageSafety),
    [usageSafety],
  );
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
  // The slash menu is driven by the draft, so it stays open while the textarea
  // is in use and closes on a press anywhere outside the composer.
  const slashMenuScopeRef = useOutsidePointerDismiss<HTMLDivElement>(
    isSlashMenuOpen,
    () => setIsSlashMenuDismissed(true),
  );
  const selectedSlashCommandIndex = Math.min(
    activeSlashCommandIndex,
    Math.max(0, filteredSlashCommands.length - 1),
  );

  const togglePopover = (popover: ComposerPopoverId) => {
    setActivePopover((current) => (current === popover ? null : popover));
  };
  const toggleProviderPopover = () => {
    setModelPickerProviderIdSticky(undefined);
    togglePopover("provider");
  };
  const runPopoverAction = (action?: string, item?: ComposerPopoverItem) => {
    if (item?.providerId) {
      // Clicks pin the flyout immediately (no hover grace). Only connected
      // providers have a model list; Connect rows keep the menu open but do
      // not clear an already-open neighbour flyout.
      const provider = providerConfigs.find(
        (entry) => entry.id === item.providerId,
      );
      if (provider?.authStatus === "connected") {
        setModelPickerProviderIdSticky(item.providerId);
      }
      setActivePopover("provider");
      if (action) {
        onComposerAction?.(action);
      }
      return;
    }

    setActivePopover(null);
    setModelPickerProviderIdSticky(undefined);
    if (action) {
      onComposerAction?.(action);
    }
  };
  const showSlashHint = (text: string, marker: HTMLElement) => {
    const rect = marker.getBoundingClientRect();
    const width = 216;
    const gap = 8;
    const fitsRight = rect.right + gap + width <= window.innerWidth - 8;
    setSlashHint({
      left: fitsRight ? rect.right + gap : Math.max(8, rect.left - gap - width),
      text,
      // Centred on the marker, but kept clear of the viewport edges.
      top: Math.min(
        Math.max(rect.top + rect.height / 2, 44),
        window.innerHeight - 44,
      ),
    });
  };
  const runSlashCommand = (command: ComposerSlashCommand) => {
    setSlashHint(undefined);
    setIsSlashMenuDismissed(true);
    setHistoryIndex(undefined);
    onDraftChange("");
    if (command.popover) {
      setModelPickerProviderIdSticky(undefined);
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

  // Models open to the right of the provider list. If that would clip, nudge
  // the whole picker left just enough to fit, and flip the flyout to the left
  // of the list when even that is not enough. Flip up only when the panel
  // would run off the bottom.
  useEffect(() => {
    if (!modelPickerProvider || !providerPickerRef.current) {
      setModelFlyoutVertical("down");
      setModelFlyoutShiftX(0);
      setModelFlyoutSide("right");
      return;
    }
    const picker = providerPickerRef.current;
    const control =
      picker.offsetParent instanceof HTMLElement
        ? picker.offsetParent
        : picker.parentElement;
    const flyout = picker.querySelector<HTMLElement>(
      ".gyro-provider-model-flyout",
    );
    const modelFlyoutWidth =
      flyout?.offsetWidth ?? Math.min(176, window.innerWidth * 0.42);
    const modelFlyoutHeight = flyout?.scrollHeight ?? 420;
    const edgePad = 8;
    const gap = 2;
    // The composer is not always the window's full width. In the Workspace AI
    // sidebar it sits inside a panel that clips its overflow, so the viewport
    // is the wrong bound — measuring against it let the flyout render past the
    // sidebar and get cut in half by the editor next to it.
    const bounds = clippingBounds(picker);
    let side: "right" | "left" | "stacked" = "right";

    if (control) {
      // data-align="end" with right:0 pins the picker to the control's right.
      // Measure from that natural position so shift is stable across renders.
      const controlRect = control.getBoundingClientRect();
      const unshiftedRight = controlRect.right;
      const unshiftedFlyoutRight = unshiftedRight + gap + modelFlyoutWidth;
      const overflowRight = unshiftedFlyoutRight - (bounds.right - edgePad);
      const unshiftedLeft = unshiftedRight - picker.offsetWidth;
      const maxShift = Math.max(0, unshiftedLeft - (bounds.left + edgePad));
      const shift =
        overflowRight > 0 ? Math.min(Math.ceil(overflowRight), maxShift) : 0;
      setModelFlyoutShiftX(shift);
      // Shifting only helps while the picker still has room to travel. Once it
      // is against the left edge and models would still overhang, open them on
      // the other side of the list instead of letting them clip.
      const fitsRight = overflowRight - shift <= 0;
      const fitsLeft =
        unshiftedLeft - shift - gap - modelFlyoutWidth >= bounds.left + edgePad;
      // The Workspace AI sidebar is narrower than list plus flyout together,
      // so neither side can hold them. Stack the models over the list there
      // rather than docking a panel that has nowhere to go.
      side = fitsRight ? "right" : fitsLeft ? "left" : "stacked";
      setModelFlyoutSide(side);
    }

    const rect = picker.getBoundingClientRect();
    // Docked beside the list the flyout shares its top edge, so it runs out of
    // room below that. Stacked it starts past the list instead, and only the
    // room left over decides which way it goes.
    const flyoutTop = side === "stacked" ? rect.bottom + gap : rect.top;
    const fitsBelow = flyoutTop + modelFlyoutHeight <= bounds.bottom - 16;
    const fitsAbove =
      (side === "stacked" ? rect.top - gap : rect.bottom) - modelFlyoutHeight >=
      bounds.top + 16;
    setModelFlyoutVertical(!fitsBelow && fitsAbove ? "up" : "down");
  }, [modelPickerProvider]);

  useEffect(() => {
    setActiveSlashCommandIndex(0);
    setSlashHint(undefined);
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
        isHero && constrainToParent ? "is-constrained" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        isHero
          ? { justifySelf: constrainToParent ? "stretch" : "center" }
          : undefined
      }
      ref={slashMenuScopeRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && activePopover) {
          event.stopPropagation();
          setActivePopover(null);
          setModelPickerProviderIdSticky(undefined);
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
      {chatMode === "council" && councilResolution ? (
        <div
          className={[
            "gyro-council-preflight",
            councilResolution.error || !councilEnabled ? "is-blocked" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="status"
        >
          <Users size={13} />
          <span>
            {!councilEnabled
              ? "Model Council is disabled in Settings → Providers."
              : councilPreflightLabel(councilResolution)}
          </span>
          {councilResolution.seats.length > 0 ? (
            <span className="gyro-council-preflight-seats">
              {councilResolution.seats.map((seat) => (
                <span
                  className="gyro-council-preflight-chip"
                  key={seat.providerId}
                >
                  {seat.providerLabel ?? seat.providerId}
                </span>
              ))}
            </span>
          ) : null}
          {councilResolution.seats.length > 0 && !councilResolution.error ? (
            <span
              className="gyro-council-preflight-cost"
              title={costPreviewTitle}
            >
              {turnCost.label}
            </span>
          ) : null}
        </div>
      ) : null}
      {safetyNotice ? (
        <div
          className={`gyro-composer-safety-notice is-${safetyNotice.tone}`}
          role="status"
        >
          {safetyNotice.tone === "paused" ? (
            <PauseIcon aria-hidden="true" size={14} />
          ) : (
            <Gauge aria-hidden="true" size={14} />
          )}
          <span>
            <strong>{safetyNotice.title}</strong>
            {safetyNotice.detail ? <small>{safetyNotice.detail}</small> : null}
          </span>
          {safetyNotice.canResume && onResumeUsage ? (
            <button onClick={onResumeUsage} type="button">
              Resume
            </button>
          ) : null}
        </div>
      ) : null}
      {isCostConfirmPending ? (
        <div className="gyro-composer-cost-confirm" role="alertdialog">
          <Gauge aria-hidden="true" size={14} />
          <span>
            <strong>{turnCost.label}</strong>
            <small>{turnCost.confirmReason}</small>
          </span>
          <button
            className="gyro-composer-cost-confirm-cancel"
            onClick={() => setIsCostConfirmPending(false)}
            type="button"
          >
            Cancel
          </button>
          <button
            className="gyro-composer-cost-confirm-send"
            onClick={requestSend}
            type="button"
          >
            Send anyway
          </button>
        </div>
      ) : null}
      {isSlashMenuOpen ? (
        <div
          aria-label="Chat commands"
          className="gyro-composer-slash-menu"
          id={`${popoverBaseId}-slash-menu`}
          onScroll={() => setSlashHint(undefined)}
          role="menu"
        >
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
                <Icon size={14} />
                <code>{command.command}</code>
                <span>{command.label}</span>
                {command.hint ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="gyro-composer-slash-hint-mark"
                      onPointerEnter={(event) =>
                        showSlashHint(command.hint ?? "", event.currentTarget)
                      }
                      onPointerLeave={() => setSlashHint(undefined)}
                    >
                      ?
                    </span>
                    <span className="gyro-sr-only">{command.hint}</span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {/* Portalled to the body: the hero composer carries a drop-shadow
          filter, which would otherwise become the containing block for this
          fixed bubble and offset it by the composer's own position. */}
      {isSlashMenuOpen && slashHint
        ? createPortal(
            <div
              className="gyro-composer-slash-hint-bubble"
              role="tooltip"
              style={{ left: slashHint.left, top: slashHint.top }}
            >
              {slashHint.text}
            </div>,
            document.body,
          )
        : null}
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
              requestSend();
            }
          }
        }}
        placeholder={
          !shellReady
            ? "Draft freely — send unlocks when Gyro finishes optimizing"
            : isGoalComposerActive
              ? "Define the outcome for this chat"
              : chatMode === "council"
                ? "Ask for architecture, review, or alternatives — models answer in parallel"
                : !canSubmitChat
                  ? cleanMachinePath.placeholder
                  : variant === "hero"
                    ? "Describe a task or attach images"
                    : "Ask for follow-up changes or attach images"
        }
        value={draft}
      />
      <div className="gyro-composer-bar">
        {hasSelectedProvider || isHero ? (
          <>
            <div
              className="gyro-composer-control gyro-composer-reveal"
              ref={activePopover === "context" ? popoverScopeRef : undefined}
            >
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
            <div
              className="gyro-composer-control gyro-composer-control-approval gyro-composer-reveal"
              ref={activePopover === "approval" ? popoverScopeRef : undefined}
            >
              <button
                aria-label={`Approval mode: ${approvalCopy.chipLabel}`}
                className={approvalChipClassName}
                onClick={() => togglePopover("approval")}
                title={`Approval mode: ${approvalCopy.chipLabel}`}
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
        {/* Mode and goal are independent, so both chips can sit here at once. */}
        {chatMode === "plan" ? (
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
        ) : chatMode === "council" ? (
          <button
            aria-label="Remove Council mode"
            aria-pressed="true"
            className="gyro-composer-chip is-council"
            onClick={() => onComposerAction?.("set-chat-mode-normal")}
            title="Remove Council mode — multi-model parallel answers with synthesis"
            type="button"
          >
            <Users size={13} />
            <span className="gyro-composer-label">Council</span>
            <X
              aria-hidden="true"
              className="gyro-composer-chip-remove"
              size={12}
            />
          </button>
        ) : null}
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
              {limitWindows.length > 0 || providerUsage ? (
                <div
                  aria-label="Plan usage limits"
                  className="gyro-composer-limit-summary"
                >
                  <span className="gyro-composer-limit-title">
                    Plan usage limits
                  </span>
                  {limitWindows.length > 0 ? (
                    limitWindows.map((window) => (
                      <ComposerLimitRow key={window.id} window={window} />
                    ))
                  ) : (
                    <small>
                      {providerUsage?.status === "loading"
                        ? "Updating…"
                        : "Unavailable"}
                    </small>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        <div
          className="gyro-composer-control gyro-composer-control-model"
          ref={activePopover === "provider" ? popoverScopeRef : undefined}
        >
          <button
            /* Narrow panes hide .gyro-composer-label, so the visible text
               cannot be the only name this control has. */
            aria-label={`Model: ${modelChipLabel}`}
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
              onPointerEnter={clearModelFlyoutPreviewTimer}
              ref={providerPickerRef}
              style={
                modelFlyoutShiftX > 0 ? { right: modelFlyoutShiftX } : undefined
              }
            >
              <ComposerPopover
                className="gyro-provider-picker-menu"
                id={`${popoverBaseId}-provider-menu`}
                items={providerItems}
                onAction={runPopoverAction}
                onItemPreview={(item) => {
                  // Disconnected rows still carry providerId (brand logos) but
                  // must not collapse the models panel while the pointer
                  // crosses them on the way to a model.
                  if (!item.providerId || item.disabled) {
                    return;
                  }
                  const provider = providerConfigs.find(
                    (entry) => entry.id === item.providerId,
                  );
                  if (provider?.authStatus === "connected") {
                    previewConnectedProviderModels(item.providerId);
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
                  onItemPreview={() => {
                    // Pointer is over models — cancel any pending provider switch.
                    clearModelFlyoutPreviewTimer();
                  }}
                  placement={providerPopoverPlacement}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {providerReasoningEffort && effortItems.length > 0 ? (
          <div
            className="gyro-composer-control gyro-composer-control-effort"
            ref={activePopover === "effort" ? popoverScopeRef : undefined}
          >
            <button
              aria-label={`Reasoning effort: ${reasoningEffortLabel(providerReasoningEffort)}`}
              className="gyro-composer-chip gyro-effort-chip"
              onClick={() => togglePopover("effort")}
              title={`Reasoning effort: ${reasoningEffortLabel(providerReasoningEffort)}`}
              type="button"
              {...menuProps("effort")}
            >
              <Gauge className="gyro-effort-chip-icon" size={14} />
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
            requestSend();
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
          <div
            className="gyro-composer-control"
            ref={activePopover === "project" ? popoverScopeRef : undefined}
          >
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
          <div
            className="gyro-composer-control"
            ref={
              activePopover === "workspace-mode" ? popoverScopeRef : undefined
            }
          >
            <button
              className={[
                "gyro-composer-chip",
                workspaceMode === "worktree" ? "is-agent-workspace" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => togglePopover("workspace-mode")}
              title={workspaceModeTechnicalHint(workspaceMode)}
              type="button"
              {...menuProps("workspace-mode")}
            >
              {workspaceMode === "worktree" ? (
                <GitBranch size={14} />
              ) : (
                <Laptop size={14} />
              )}
              {modeChipLabel}
              <ChevronDown size={13} />
            </button>
            {activePopover === "workspace-mode" ? (
              <ComposerPopover
                className="gyro-workspace-mode-picker"
                id={`${popoverBaseId}-workspace-mode`}
                items={[
                  {
                    action: "set-workspace-mode:local",
                    active: workspaceMode === "local",
                    icon: Laptop,
                    kind: "workspace-mode",
                    label: workspaceModePopoverLabel("local"),
                    // Full explanation lives on the chip tooltip — labels are enough here.
                    tooltip: workspaceModeTechnicalHint("local"),
                  },
                  {
                    action: "set-workspace-mode:worktree",
                    active: workspaceMode === "worktree",
                    badge:
                      hasUserWorkspace && workspaceMode !== "worktree"
                        ? "Recommended"
                        : undefined,
                    // Only surface a detail when isolation can't run yet.
                    detail: hasUserWorkspace
                      ? undefined
                      : workspaceModeDetail("worktree", {
                          hasWorkspace: false,
                        }),
                    icon: GitBranch,
                    kind: "workspace-mode",
                    label: workspaceModePopoverLabel("worktree"),
                    tooltip: workspaceModeTechnicalHint("worktree"),
                  },
                ]}
                onAction={runPopoverAction}
                placement="down"
              />
            ) : null}
          </div>
          <div
            className="gyro-composer-control"
            ref={activePopover === "branch" ? popoverScopeRef : undefined}
          >
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
          {sessionCost && !sessionCost.isEmpty ? (
            <span
              className="gyro-composer-session-cost"
              role="status"
              title={sessionCost.title}
            >
              <Gauge aria-hidden="true" size={12} />
              <span>{sessionCost.label}</span>
              {sessionCost.estimateNote ? (
                <em>{sessionCost.estimateNote}</em>
              ) : null}
            </span>
          ) : null}
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
  onCouncilAction,
  onMutationApprovalAction,
  onProviderApprovalAction,
  onProviderStatusAction,
  onReusePrompt,
}: {
  event: SessionEvent;
  onCouncilAction?: (
    action: CouncilActionRequest,
  ) => void | Promise<string | void>;
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
              providerNeedsSignIn(providerStatus.recoveryKind) ? (
                <button
                  onClick={() =>
                    onProviderStatusAction?.("reconnect-provider", event)
                  }
                  type="button"
                >
                  {providerSignInLabel(providerStatus.recoveryKind)}
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
        {isUser ? <UserCircle size={17} /> : <Sparkles size={17} />}
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
          <AssistantResponse event={event} onCouncilAction={onCouncilAction} />
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
        <small>
          {isBusy ? "Working" : capabilityStatusLabel(activity.status)}
        </small>
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

/** Sentence case, so a finished call does not read "completed" next to "Working". */
function capabilityStatusLabel(status: CapabilityCallEvent["status"]) {
  switch (status) {
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "denied":
      return "Denied";
    case "cancelled":
      return "Cancelled";
    case "inactive":
      return "Inactive";
    default:
      return "Working";
  }
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
  /*
   * A capability call reports itself several times as it runs — requested,
   * running, then completed — and each report is its own event. Approvals
   * already fold their updates back onto the event that opened them; capability
   * calls did not, so one workspace read stacked three near-identical cards.
   * Keep the first event as the card's place in the turn and let the newest
   * payload supply what it says.
   */
  const capabilityCallUpdates = new Map<string, Record<string, unknown>>();
  const capabilityCallAnchors = new Map<string, string>();
  for (const event of events) {
    const payload = eventPayloadRecord(event);
    const capabilityCall = capabilityCallFromEvent(event);
    if (capabilityCall) {
      capabilityCallUpdates.set(capabilityCall.callId, payload ?? {});
      if (!capabilityCallAnchors.has(capabilityCall.callId)) {
        capabilityCallAnchors.set(capabilityCall.callId, event.id);
      }
    }
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
    const originalCapabilityCall = capabilityCallFromEvent(originalEvent);
    if (
      originalCapabilityCall &&
      capabilityCallAnchors.get(originalCapabilityCall.callId) !==
        originalEvent.id
    ) {
      continue;
    }
    const capabilityUpdate = originalCapabilityCall
      ? capabilityCallUpdates.get(originalCapabilityCall.callId)
      : undefined;
    const originalApproval = mutationApprovalFromEvent(originalEvent);
    const originalProviderApproval = providerApprovalFromEvent(originalEvent);
    const decision = originalApproval
      ? mutationDecisions.get(originalApproval.proposalId)
      : originalProviderApproval
        ? providerApprovalDecisions.get(originalProviderApproval.approvalId)
        : undefined;
    const event = capabilityUpdate
      ? { ...originalEvent, payload: capabilityUpdate }
      : decision
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
    } else if (capabilityCallFromEvent(event)) {
      /*
       * Capability calls used to fall through to `looseEvents`, which render
       * ahead of every turn — so the workspace reads a turn made showed up at
       * the top of the transcript, above the message that asked for them. They
       * are work the turn did; they belong in its timeline, in order.
       */
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
  onCouncilAction,
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
  previewCapture,
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
  onCouncilAction?: (
    action: CouncilActionRequest,
  ) => void | Promise<string | void>;
  onReusePrompt?: (message: string) => void;
  onContinueChat?: () => void;
  onOpenPlan?: () => void;
  onPlanDecision?: (decision: "approve" | "reject") => void;
  plan?: SessionPlan;
  isPlanDecisionPending: boolean;
  isPlanPanelOpen?: boolean;
  isPlanReadyForDecision: boolean;
  previewCapture?: { src?: string; path?: string };
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
  const isRunning = isActive;
  const startedAt = turn.runStartedAt ?? turn.startedAt;
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
  const runModel = buildRunModel(turn.timelineEvents, {
    isRunning,
    startedAt,
    durationMs: turn.durationMs ?? elapsedMsBetween(startedAt, completedAt),
    fileStats: (path) => {
      const file = sourceControlFileForActivityPath(path, sourceControl);
      return file
        ? sourceControlFileDelta(
            file,
            sourceControlStatsForActivityPath(path, sourceControlBaseline),
          )
        : undefined;
    },
    status: providerStatus
      ? {
          status: providerStatus.status,
          message: turn.statusEvent?.message,
          error: providerStatus.error,
          recoveryKind: providerStatus.recoveryKind,
          recoveryMessage: providerStatus.recoveryMessage,
        }
      : undefined,
  });
  const responseEvent = runModel.response;
  // Offer Continue when the turn produced anything the user might resume from —
  // a text answer, or work that stopped before an answer (empty void + tools).
  const canContinue =
    !isRunning &&
    Boolean(onContinueChat) &&
    (hasResponse || runModel.steps.length > 0) &&
    runModel.phase.name === "done";
  // A turn the provider never closed out can be resent; a cancelled one cannot
  // be reconnected. Both decisions stay here because they need the status event
  // the run model deliberately does not carry.
  const canRetry =
    runModel.phase.name === "interrupted" ||
    providerStatus?.status === "failed" ||
    providerStatus?.status === "cancelled";
  const canReconnect = Boolean(
    providerStatus &&
    providerStatus.status !== "cancelled" &&
    (providerStatus.status === "blocked" ||
      providerNeedsSignIn(providerStatus.recoveryKind)),
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
        <ChatRun
          headerActions={
            canContinue ? (
              <button onClick={onContinueChat} type="button">
                Continue
              </button>
            ) : null
          }
          model={runModel}
          onOpenChanges={onOpenChanges}
          onReconnect={
            canReconnect && turn.statusEvent
              ? () =>
                  onProviderStatusAction?.(
                    "reconnect-provider",
                    turn.statusEvent as SessionEvent,
                  )
              : undefined
          }
          onRetry={
            canRetry && turn.statusEvent
              ? () =>
                  onProviderStatusAction?.(
                    "retry-send",
                    turn.statusEvent as SessionEvent,
                  )
              : undefined
          }
          reconnectLabel={
            providerStatus?.status === "blocked"
              ? "Reconnect"
              : providerSignInLabel(providerStatus?.recoveryKind)
          }
          renderAsk={(event) => (
            <ChatEvent
              event={event}
              onMutationApprovalAction={onMutationApprovalAction}
              onProviderApprovalAction={onProviderApprovalAction}
            />
          )}
          renderSay={(text) => renderAssistantInlineContent(text)}
        />
        {responseEvent ? (
          <div
            className="gyro-chat-run-sequence is-response"
            aria-label="Final response"
          >
            <div
              aria-label={isRunning ? "Assistant update" : "Final response"}
              className="gyro-chat-run-timeline is-final-response"
              key={responseEvent.id}
            >
              <article className="gyro-message is-assistant">
                <div>
                  {isPlanResponseTurn ? (
                    <PlanArtifactCard
                      content={plan?.content ?? responseEvent.message}
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
                      event={responseEvent}
                      onCouncilAction={onCouncilAction}
                      previewCapture={previewCapture}
                    />
                  )}
                </div>
              </article>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
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

function sourceControlFileForActivityPath(
  activityPath: string,
  sourceControl?: SourceControlState,
) {
  return sourceControl?.files.find((file) =>
    providerActivityPathsMatch(activityPath, file.path),
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

function AssistantResponse({
  actions,
  event,
  onCouncilAction,
  previewCapture,
}: {
  actions?: ChatArtifactActions;
  event: SessionEvent;
  onCouncilAction?: (
    action: CouncilActionRequest,
  ) => void | Promise<string | void>;
  previewCapture?: { src?: string; path?: string };
}) {
  const council = useMemo(() => councilResponseFromEvent(event), [event]);
  // Repair glued stream blocks (`repo.Gyro is…`) so the final answer reads as
  // separate paragraphs rather than one thick run-on line.
  const visibleMessage = structuredCommentaryBlocks(
    stripHiddenSessionTitleMarker(event.message),
  ).join("\n\n");
  const artifacts = useMemo(
    () =>
      chatArtifactsFromEvent(event).filter(
        (artifact) => artifact.kind !== "completion",
      ),
    [event],
  );
  const isStreaming = isStreamingAssistantEvent(event);
  const shouldUsePlainText =
    isStreaming ||
    visibleMessage.length > ASSISTANT_RESPONSE_RICH_PARSE_MAX_CHARS;
  const blocks = useMemo(
    () => (shouldUsePlainText ? [] : assistantResponseBlocks(visibleMessage)),
    [shouldUsePlainText, visibleMessage],
  );
  if (council) {
    return (
      <CouncilResponseCard
        event={event}
        onCouncilAction={onCouncilAction}
        payload={council}
      />
    );
  }
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
      <ChatArtifacts
        actions={actions}
        artifacts={artifacts}
        previewCapture={previewCapture}
      />
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

function councilResponseFromEvent(
  event: SessionEvent,
): CouncilResponsePayload | undefined {
  const payload = recordFromUnknown(event.payload);
  if (!payload || stringFromRecord(payload, "kind") !== "council-response") {
    return undefined;
  }
  const councilRunId = stringFromRecord(payload, "councilRunId");
  if (!councilRunId) {
    return undefined;
  }
  const seatsRaw = Array.isArray(payload.seats) ? payload.seats : [];
  const seats: CouncilSeatSummary[] = [];
  for (const item of seatsRaw) {
    const record = recordFromUnknown(item);
    if (!record) continue;
    const id = stringFromRecord(record, "id");
    const providerId = stringFromRecord(record, "providerId");
    const providerLabel =
      stringFromRecord(record, "providerLabel") ?? providerId;
    if (!id || !providerId || !providerLabel) {
      continue;
    }
    seats.push({
      id,
      providerId,
      providerLabel,
      modelId: stringFromRecord(record, "modelId") ?? null,
      status: stringFromRecord(record, "status") ?? "done",
      durationMs:
        typeof record.durationMs === "number" ? record.durationMs : undefined,
      error: stringFromRecord(record, "error") ?? null,
      artifactPath: stringFromRecord(record, "artifactPath") ?? null,
      outputPreview: stringFromRecord(record, "outputPreview") ?? null,
    });
  }

  return {
    kind: "council-response",
    councilRunId,
    status: stringFromRecord(payload, "status") ?? "done",
    presetId: stringFromRecord(payload, "presetId") ?? null,
    seats,
    synthesis:
      (payload.synthesis as CouncilSynthesis | null | undefined) ?? null,
    totals: (payload.totals as CouncilResponsePayload["totals"]) ?? null,
    manifestPath: stringFromRecord(payload, "manifestPath") ?? null,
    retry: payload.retry === true,
  };
}

function CouncilResponseCard({
  event,
  payload,
  onCouncilAction,
}: {
  event: SessionEvent;
  payload: CouncilResponsePayload;
  onCouncilAction?: (
    action: CouncilActionRequest,
  ) => void | Promise<string | void>;
}) {
  const [expandedSeatId, setExpandedSeatId] = useState<string | null>(null);
  const [seatBodies, setSeatBodies] = useState<Record<string, string>>({});
  const [loadingSeatId, setLoadingSeatId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const markdown =
    payload.synthesis?.userEditedMarkdown ??
    payload.synthesis?.unifiedMarkdown ??
    event.message;
  const blocks = useMemo(
    () =>
      markdown.length > ASSISTANT_RESPONSE_RICH_PARSE_MAX_CHARS
        ? []
        : assistantResponseBlocks(markdown),
    [markdown],
  );
  const succeeded = payload.seats.filter(
    (seat) => seat.status === "done",
  ).length;
  const failed = payload.seats.length - succeeded;
  const wallMs = payload.totals?.wallDurationMs;

  const loadSeat = async (seat: CouncilSeatSummary) => {
    if (seatBodies[seat.id] || !onCouncilAction) {
      setExpandedSeatId((current) => (current === seat.id ? null : seat.id));
      return;
    }
    if (seat.outputPreview && !seat.artifactPath) {
      setSeatBodies((current) => ({
        ...current,
        [seat.id]: seat.outputPreview ?? "",
      }));
      setExpandedSeatId(seat.id);
      return;
    }
    setLoadingSeatId(seat.id);
    try {
      const full = await onCouncilAction({
        type: "load-seat",
        councilRunId: payload.councilRunId,
        sessionId: event.sessionId,
        seatId: seat.id,
      });
      const text =
        typeof full === "string" && full.trim().length > 0
          ? full
          : (seat.outputPreview ?? seat.error ?? "No seat output available.");
      setSeatBodies((current) => ({ ...current, [seat.id]: text }));
      setExpandedSeatId(seat.id);
    } finally {
      setLoadingSeatId(null);
    }
  };

  const runAction = async (key: string, action: CouncilActionRequest) => {
    if (!onCouncilAction) return;
    setBusyAction(key);
    try {
      await onCouncilAction(action);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="gyro-response gyro-council-response">
      <header className="gyro-council-header">
        <div className="gyro-council-title-row">
          <Users size={15} />
          <strong>Model Council</strong>
          <span className={`gyro-council-status is-${payload.status}`}>
            {payload.status}
          </span>
          {payload.retry ? (
            <span className="gyro-council-badge">re-synth</span>
          ) : null}
        </div>
        <p className="gyro-council-meta">
          {succeeded} of {payload.seats.length} seats succeeded
          {failed > 0 ? ` · ${failed} failed` : ""}
          {typeof wallMs === "number"
            ? ` · ${(wallMs / 1000).toFixed(1)}s wall`
            : ""}
          {payload.presetId ? ` · ${payload.presetId}` : ""}
        </p>
        {payload.status === "partial" ? (
          <p className="gyro-council-banner" role="status">
            Partial council — synthesis used available seats. Expand seats below
            for full answers.
          </p>
        ) : null}
        {!payload.synthesis ? (
          <p className="gyro-council-banner is-warn" role="status">
            Synthesis unavailable. Individual seat answers are shown below.
          </p>
        ) : null}
      </header>

      <div className="gyro-council-seats" aria-label="Council seats">
        {payload.seats.map((seat) => {
          const expanded = expandedSeatId === seat.id;
          const body =
            seatBodies[seat.id] ?? seat.outputPreview ?? seat.error ?? "";
          return (
            <div
              className={[
                "gyro-council-seat",
                `is-${seat.status}`,
                expanded ? "is-expanded" : "",
              ].join(" ")}
              key={seat.id}
            >
              <button
                className="gyro-council-seat-header"
                onClick={() => void loadSeat(seat)}
                type="button"
              >
                <span className="gyro-council-seat-label">
                  {seat.providerLabel}
                  {seat.modelId ? ` · ${seat.modelId}` : ""}
                </span>
                <span className="gyro-council-seat-status">{seat.status}</span>
                {typeof seat.durationMs === "number" ? (
                  <span className="gyro-council-seat-latency">
                    {(seat.durationMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
                <ChevronDown className={expanded ? "is-open" : ""} size={14} />
              </button>
              {expanded ? (
                <div className="gyro-council-seat-body">
                  {loadingSeatId === seat.id ? (
                    <p className="gyro-muted">Loading seat output…</p>
                  ) : (
                    <pre className="gyro-council-seat-output">{body}</pre>
                  )}
                  <div className="gyro-council-seat-actions">
                    <button
                      disabled={busyAction !== null}
                      onClick={() =>
                        void runAction(`promote-${seat.id}`, {
                          type: "promote-seat",
                          councilRunId: payload.councilRunId,
                          seat,
                          fullText: body,
                        })
                      }
                      type="button"
                    >
                      Promote as baseline
                    </button>
                    <button
                      onClick={() => copyAssistantResponse(body)}
                      type="button"
                    >
                      Copy seat
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="gyro-response-body">
        {blocks.length === 0 ? (
          <p className="gyro-response-streaming-text">{markdown}</p>
        ) : (
          blocks.map((block, index) => (
            <AssistantResponseBlockView
              block={block}
              key={`${block.kind}-${index}`}
            />
          ))
        )}
      </div>

      {payload.synthesis?.parseWarnings?.length ? (
        <p className="gyro-council-banner is-warn">
          {payload.synthesis.parseWarnings.join(" ")}
        </p>
      ) : null}

      <footer className="gyro-response-actions gyro-council-actions">
        <button
          aria-label="Copy synthesis"
          onClick={() => copyAssistantResponse(markdown)}
          title="Copy synthesis"
          type="button"
        >
          <Copy size={15} />
        </button>
        <button
          disabled={busyAction !== null}
          onClick={() =>
            void runAction("continue", {
              type: "continue-as-run",
              markdown,
              councilRunId: payload.councilRunId,
            })
          }
          type="button"
        >
          Continue as run
        </button>
        <button
          disabled={busyAction !== null || succeeded === 0}
          onClick={() =>
            void runAction("resynth", {
              type: "resynthesize",
              councilRunId: payload.councilRunId,
              sessionId: event.sessionId,
            })
          }
          type="button"
        >
          {busyAction === "resynth" ? "Re-synthesizing…" : "Re-synthesize"}
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

// A sign-in that expired and one that was never established need the same
// button but not the same word: the first is a repair, the second is setup.
export function providerNeedsSignIn(recoveryKind: string | undefined) {
  return recoveryKind === "login-expired" || recoveryKind === "authentication";
}

function providerSignInLabel(recoveryKind: string | undefined) {
  return recoveryKind === "login-expired" ? "Sign in" : "Reconnect";
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
  if (event.kind === "system-event" && payloadKind === "workspace-context") {
    return true;
  }
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
    { id: "agent", label: "Agent", icon: Sparkles },
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

/**
 * Legacy first-run step chrome for an empty Chat.
 * The activation checklist is gone: the composer placeholder and provider
 * picker carry the project/provider gates now.
 */
function CleanMachineActivation({
  onboarding,
  onCompleteStep,
  onSelectStep,
  showLegacySteps = false,
}: {
  onboarding?: OnboardingState;
  onCompleteStep?: (step: OnboardingState["activeStep"]) => void;
  onSelectStep?: (step: OnboardingState["activeStep"]) => void;
  showLegacySteps?: boolean;
}) {
  if (!showLegacySteps) {
    return null;
  }

  const legacySteps: Array<{
    id: OnboardingState["activeStep"];
    label: string;
  }> = [
    { id: "welcome", label: "Welcome" },
    { id: "workspace", label: "Project" },
    { id: "provider", label: "Provider" },
    { id: "approval", label: "Approvals" },
    { id: "first-session", label: "First chat" },
  ];

  return (
    <div className="gyro-clean-machine-path" aria-label="Get ready to chat">
      <div className="gyro-onboarding-steps" aria-label="First run flow">
        {legacySteps.map((step, index) => (
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

/// The rectangle a popover actually has to stay inside.
///
/// An overflow-clipped ancestor, not the viewport, is what cuts a flyout off:
/// the Workspace AI sidebar panel is `overflow: hidden`, so anything the
/// composer opens past its right edge is simply not drawn. Walk up to the
/// nearest such ancestor and use it; fall back to the viewport when the
/// composer really does own the full width.
function clippingBounds(element: HTMLElement) {
  const viewport = {
    left: 0,
    right: window.innerWidth,
    top: 0,
    bottom: window.innerHeight,
  };
  for (
    let node = element.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    const style = window.getComputedStyle(node);
    const clips = [style.overflowX, style.overflowY].some(
      (value) => value !== "visible",
    );
    if (!clips) {
      continue;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      continue;
    }
    return {
      left: Math.max(viewport.left, rect.left),
      right: Math.min(viewport.right, rect.right),
      top: Math.max(viewport.top, rect.top),
      bottom: Math.min(viewport.bottom, rect.bottom),
    };
  }
  return viewport;
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

function workspaceAncestorPaths(path: string, workspacePath?: string) {
  if (workspacePath) {
    const root = workspacePath.replaceAll("\\", "/").replace(/\/+$/, "");
    const normalizedPath = path.replaceAll("\\", "/");
    if (normalizedPath === root) return [];
    if (normalizedPath.startsWith(`${root}/`)) {
      const parts = normalizedPath
        .slice(root.length + 1)
        .split("/")
        .filter(Boolean);
      return [
        root,
        ...parts
          .slice(0, -1)
          .map((_, index) => `${root}/${parts.slice(0, index + 1).join("/")}`),
      ];
    }
  }
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts
    .slice(0, -1)
    .map((_, index) => parts.slice(0, index + 1).join("/"));
}

function deviceLabel(device: BrowserPreviewDevice) {
  switch (device) {
    case "desktop":
      return "Desktop";
    case "tablet":
      return "Tablet";
    case "mobile":
      return "Mobile";
  }
}

function browserStatusLabel(preview: BrowserPreview) {
  const device = deviceLabel(preview.device);
  const host = browserPreviewHostLabel(preview.url);
  const legacyNoPreview = /no preview loaded/i.test(
    preview.verificationMessage ?? "",
  );

  if (preview.captureStatus === "capturing") {
    return `Capturing · ${device}`;
  }

  switch (preview.status) {
    case "loading":
      return host ? `Loading · ${host} · ${device}` : `Loading · ${device}`;
    case "console-error": {
      const count = preview.consoleErrors || 1;
      return `${count} issue${count === 1 ? "" : "s"} · ${device}`;
    }
    case "verification-failed": {
      if (legacyNoPreview) {
        return host ? `Idle · ${host} · ${device}` : `Idle · ${device}`;
      }
      const detail = (preview.verificationMessage ?? "")
        .replace(/^unreachable\s*·?\s*/i, "")
        .replace(/^preview unavailable:\s*/i, "")
        .trim();
      if (detail && !legacyNoPreview) {
        return detail.toLowerCase().includes(device.toLowerCase())
          ? detail
          : `Unreachable · ${detail}`;
      }
      return host ? `Unreachable · ${host} · ${device}` : `Unreachable · ${device}`;
    }
    case "verification-passed":
    case "ready":
      return host ? `Live · ${host} · ${device}` : `Live · ${device}`;
    case "idle":
    default: {
      if (legacyNoPreview) {
        return host ? `Idle · ${host} · ${device}` : `Idle · ${device}`;
      }
      const message = preview.verificationMessage?.trim() ?? "";
      if (
        message &&
        !/^ready(\s*·|$)/i.test(message) &&
        !/^idle(\s*·|$)/i.test(message)
      ) {
        return message.includes(device) ? message : `${message} · ${device}`;
      }
      return host ? `Idle · ${host} · ${device}` : `Idle · ${device}`;
    }
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

function sidebarRecencyLabel(updatedAt: number, now: number): string {
  if (Number.isNaN(updatedAt) || updatedAt <= 0) {
    return "Older";
  }
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 6);
  const startOfMonth = new Date(startOfToday);
  startOfMonth.setDate(startOfMonth.getDate() - 29);
  if (updatedAt >= startOfToday.getTime()) {
    return "Today";
  }
  if (updatedAt >= startOfWeek.getTime()) {
    return "This week";
  }
  if (updatedAt >= startOfMonth.getTime()) {
    return "Earlier this month";
  }
  return "Older";
}

/**
 * Group expanded project chats by recency so a month-old thread is not lost
 * in a flat list sorted only by updated_at.
 */
function groupSidebarItemsByRecency(items: SidebarSessionItem[]) {
  const now = Date.now();
  const order = ["Today", "This week", "Earlier this month", "Older"] as const;
  const buckets = new Map<string, SidebarSessionItem[]>();
  for (const label of order) {
    buckets.set(label, []);
  }
  for (const item of items) {
    const label = sidebarRecencyLabel(sidebarSessionTimestamp(item), now);
    buckets.get(label)?.push(item);
  }
  return order
    .map((label) => ({ label, items: buckets.get(label) ?? [] }))
    .filter((group) => group.items.length > 0);
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
