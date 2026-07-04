import {
  Activity,
  Archive,
  ArrowUp,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Edit3,
  FileCode2,
  FileText,
  Folder,
  Gauge,
  GitBranch,
  GitPullRequest,
  Globe2,
  HardDrive,
  HelpCircle,
  KeyRound,
  Laptop,
  LayoutPanelLeft,
  LockKeyhole,
  MessageSquare,
  Mic,
  Moon,
  MoreHorizontal,
  Palette,
  PanelRight,
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
  Sun,
  Terminal,
  UserCircle,
  X,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type {
  AppDestination,
  Automation,
  BrowserPreview,
  BrowserPreviewDevice,
  CommandProfile,
  DiffFile,
  DiffReview,
  GitReviewActionId,
  GyroConfig,
  Notification,
  OnboardingState,
  ProviderReadiness,
  ProviderHandoff,
  ProviderSession,
  ProviderStatus,
  SettingsSectionId,
  Session,
  SessionEvent,
  SurfaceId,
  Task,
  TaskStatus,
  TerminalPane,
  TerminalTemplate,
  ThemeMode,
  WorkbenchDensity,
  WorkbenchMode,
  WorkbenchPaneTab,
  WorkbenchTurn,
  WorkspaceFile,
  WorkspaceFileContent,
} from "./types";
import {
  defaultCommandProfiles,
  defaultProviderStatuses,
} from "./workbench-state";

type IconComponent = typeof MessageSquare;
const CommandIcon = Search;

type AppChromeProps = {
  sessions: Session[];
  activeSessionId?: string;
  activeDestination: AppDestination;
  workspacePath?: string;
  notifications?: Notification[];
  pinnedSessionIds?: string[];
  isChatsCollapsed?: boolean;
  onSelectSession: (sessionId: string) => void;
  onSelectSurface: (surface: SurfaceId) => void;
  onSelectDestination: (destination: AppDestination) => void;
  onDeleteSession?: (sessionId: string) => void;
  onDismissNotification?: (id: string) => void;
  onOpenSettings: () => void;
  onOpenSettingsSection?: (section: SettingsSectionId) => void;
  onOpenCommandPalette: () => void;
  onCreateSession: () => void;
  onOpenWorkspace: () => void;
  onPinSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string) => void;
  onToggleChatsCollapsed?: () => void;
  children: ReactNode;
};

const surfaces: Array<{
  id: SurfaceId;
  label: string;
  icon: IconComponent;
}> = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "cli", label: "CLI", icon: Terminal },
  { id: "ide", label: "IDE", icon: LayoutPanelLeft },
];

const paneTabs: Array<{
  id: WorkbenchPaneTab;
  label: string;
  icon: IconComponent;
}> = [
  { id: "diff", label: "Diff", icon: GitPullRequest },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "browser", label: "Browser", icon: Globe2 },
];

export function AppChrome({
  sessions,
  activeSessionId,
  activeDestination,
  workspacePath,
  notifications = [],
  pinnedSessionIds = [],
  isChatsCollapsed = false,
  onSelectSession,
  onSelectSurface,
  onSelectDestination,
  onDeleteSession,
  onDismissNotification,
  onOpenSettings,
  onOpenSettingsSection,
  onOpenCommandPalette,
  onCreateSession,
  onOpenWorkspace,
  onPinSession,
  onRenameSession,
  onToggleChatsCollapsed,
  children,
}: AppChromeProps) {
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const activeSidebarSurface = sidebarSurfaceForDestination(activeDestination);
  const activeSession = sessions.find(
    (session) => session.id === activeSessionId,
  );

  return (
    <div
      className={
        activeSidebarSurface === "chat"
          ? "gyro-app-shell is-chat-shell"
          : "gyro-app-shell"
      }
    >
      <aside className="gyro-sidebar">
        <div className="gyro-sidebar-head">
          <div className="gyro-surface-switch" aria-label="Workspace surface">
            {surfaces.map((surface) => {
              const Icon = surface.icon;
              const isActive = surface.id === activeSidebarSurface;
              return (
                <button
                  aria-pressed={isActive}
                  className={
                    isActive ? "gyro-surface-row is-active" : "gyro-surface-row"
                  }
                  key={surface.id}
                  onClick={() => onSelectSurface(surface.id)}
                  type="button"
                >
                  <Icon size={15} />
                  <span>{surface.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {activeSidebarSurface === "chat" ? (
          <ChatSidebarContent
            activeDestination={activeDestination}
            activeSessionId={activeSessionId}
            onCreateSession={onCreateSession}
            onOpenCommandPalette={onOpenCommandPalette}
            onOpenWorkspace={onOpenWorkspace}
            onDeleteSession={onDeleteSession}
            onPinSession={onPinSession}
            onRenameSession={onRenameSession}
            onSelectDestination={onSelectDestination}
            onSelectSession={onSelectSession}
            activeSession={activeSession}
            isChatsCollapsed={isChatsCollapsed}
            onToggleChatsCollapsed={onToggleChatsCollapsed}
            pinnedSessionIds={pinnedSessionIds}
            sessions={sessions}
            workspacePath={workspacePath}
          />
        ) : null}

        {activeSidebarSurface === "cli" ? (
          <CliSidebarContent
            activeDestination={activeDestination}
            onOpenCommandPalette={onOpenCommandPalette}
            onSelectDestination={onSelectDestination}
          />
        ) : null}

        {activeSidebarSurface === "ide" ? (
          <IdeSidebarContent
            activeDestination={activeDestination}
            onOpenCommandPalette={onOpenCommandPalette}
            onOpenWorkspace={onOpenWorkspace}
            onSelectDestination={onSelectDestination}
            workspacePath={workspacePath}
          />
        ) : null}

        <div className="gyro-sidebar-footer">
          {isAccountMenuOpen ? (
            <div className="gyro-account-menu" role="menu">
              <button
                className="gyro-account-menu-row"
                onClick={() => {
                  onOpenSettings();
                  setIsAccountMenuOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                <Settings size={16} />
                <span>All Settings</span>
              </button>
              <button
                className="gyro-account-menu-row"
                onClick={() => {
                  onOpenSettingsSection?.("general");
                  setIsAccountMenuOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                <SlidersHorizontal size={16} />
                <span>General</span>
              </button>
              <button
                className="gyro-account-menu-row"
                onClick={() => {
                  onOpenSettingsSection?.("appearance");
                  setIsAccountMenuOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                <Palette size={16} />
                <span>Appearance</span>
              </button>
              <button
                className="gyro-account-menu-row"
                onClick={() => {
                  onOpenSettingsSection?.("usage-limits");
                  setIsAccountMenuOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                <Gauge size={16} />
                <span>Usage Limits</span>
              </button>
              <button
                className="gyro-account-menu-row"
                onClick={() => {
                  onOpenSettingsSection?.("providers");
                  setIsAccountMenuOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                <KeyRound size={16} />
                <span>Providers</span>
              </button>
              <button
                className="gyro-account-menu-row"
                onClick={() => {
                  onOpenSettingsSection?.("about");
                  setIsAccountMenuOpen(false);
                }}
                role="menuitem"
                type="button"
              >
                <HelpCircle size={16} />
                <span>Help</span>
              </button>
            </div>
          ) : null}
          <button
            aria-expanded={isAccountMenuOpen}
            className="gyro-account-button"
            onClick={() => setIsAccountMenuOpen((current) => !current)}
            type="button"
          >
            <Settings size={16} />
            <span className="gyro-account-name">
              <strong>Settings</strong>
            </span>
          </button>
        </div>
      </aside>
      <main className="gyro-main">{children}</main>
    </div>
  );
}

function ChatSidebarContent({
  sessions,
  activeSessionId,
  activeSession,
  activeDestination,
  isChatsCollapsed,
  workspacePath,
  pinnedSessionIds,
  onSelectSession,
  onSelectDestination,
  onCreateSession,
  onOpenWorkspace,
  onOpenCommandPalette,
  onDeleteSession,
  onPinSession,
  onRenameSession,
  onToggleChatsCollapsed,
}: {
  sessions: Session[];
  activeSessionId?: string;
  activeSession?: Session;
  activeDestination: AppDestination;
  isChatsCollapsed: boolean;
  workspacePath?: string;
  pinnedSessionIds: string[];
  onSelectSession: (sessionId: string) => void;
  onSelectDestination: (destination: AppDestination) => void;
  onCreateSession: () => void;
  onOpenWorkspace: () => void;
  onOpenCommandPalette: () => void;
  onDeleteSession?: (sessionId: string) => void;
  onPinSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string) => void;
  onToggleChatsCollapsed?: () => void;
}) {
  const hasWorkspace = Boolean(workspacePath);
  const hasSessions = sessions.length > 0;
  const showContextSections = hasWorkspace || hasSessions;
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string>();

  return (
    <>
      <div className="gyro-sidebar-actions">
        <button
          className="gyro-sidebar-action"
          onClick={onCreateSession}
          type="button"
        >
          <Edit3 size={15} />
          New chat
        </button>
        <button
          className="gyro-sidebar-action"
          onClick={onOpenCommandPalette}
          type="button"
        >
          <Search size={15} />
          Search
        </button>
        <button
          className={
            activeDestination === "automations"
              ? "gyro-sidebar-action is-active"
              : "gyro-sidebar-action"
          }
          onClick={() => onSelectDestination("automations")}
          type="button"
        >
          <CalendarClock size={15} />
          Scheduled
        </button>
        <button
          className={
            activeDestination === "providers"
              ? "gyro-sidebar-action is-active"
              : "gyro-sidebar-action"
          }
          onClick={() => onSelectDestination("providers")}
          type="button"
        >
          <KeyRound size={15} />
          Plugins
        </button>
      </div>

      {showContextSections ? (
        <SidebarSection title="Projects">
          <SidebarProjectRow
            icon={Folder}
            label={workspaceName(workspacePath)}
            meta={workspacePath ? "local" : "open"}
            onClick={onOpenWorkspace}
          />
          {activeSession ? (
            <SidebarThreadRow
              indent
              label={
                activeSession.worktreeName ?? activeSession.branch ?? "main"
              }
              meta={
                activeSession.workspaceMode === "worktree"
                  ? "worktree"
                  : "branch"
              }
              onClick={() => onSelectDestination("diff")}
            />
          ) : null}
        </SidebarSection>
      ) : (
        <SidebarSection title="Projects">
          <SidebarProjectRow
            icon={HardDrive}
            label="Gyro"
            meta="local"
            onClick={onOpenWorkspace}
          />
        </SidebarSection>
      )}

      <SidebarSection
        collapsible
        grow
        isCollapsed={isChatsCollapsed}
        meta={sessions.length > 0 ? String(sessions.length) : undefined}
        onToggle={onToggleChatsCollapsed}
        title="Chats"
      >
        {!isChatsCollapsed ? (
          sessions.length === 0 ? (
            <button
              className="gyro-sidebar-thread is-empty"
              onClick={onCreateSession}
              type="button"
            >
              <span>No sessions yet</span>
              <small>Start one</small>
            </button>
          ) : (
            sessions.map((session) => (
              <SessionSidebarRow
                isActive={session.id === activeSessionId}
                isMenuOpen={openSessionMenuId === session.id}
                isPinned={pinnedSessionIds.includes(session.id)}
                key={session.id}
                onDelete={() => {
                  onDeleteSession?.(session.id);
                  setOpenSessionMenuId(undefined);
                }}
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
                onSelect={() => {
                  onSelectSession(session.id);
                  setOpenSessionMenuId(undefined);
                }}
                session={session}
              />
            ))
          )
        ) : null}
      </SidebarSection>
    </>
  );
}

function CliSidebarContent({
  activeDestination,
  onSelectDestination,
  onOpenCommandPalette,
}: {
  activeDestination: AppDestination;
  onSelectDestination: (destination: AppDestination) => void;
  onOpenCommandPalette: () => void;
}) {
  return (
    <>
      <div className="gyro-sidebar-actions">
        <button
          className="gyro-sidebar-action"
          onClick={() => onSelectDestination("cli")}
          type="button"
        >
          <Terminal size={15} />
          Terminal grid
        </button>
        <button
          className="gyro-sidebar-action"
          onClick={onOpenCommandPalette}
          type="button"
        >
          <Play size={15} />
          Run command
        </button>
        <button
          className="gyro-sidebar-action"
          onClick={() => onSelectDestination("diff")}
          type="button"
        >
          <GitPullRequest size={15} />
          Review diffs
        </button>
      </div>

      <SidebarSection title="Workbench">
        <SidebarDestinationRow
          icon={Activity}
          label="Task board"
          meta="queue"
          isActive={activeDestination === "tasks"}
          onClick={() => onSelectDestination("tasks")}
        />
        <SidebarDestinationRow
          icon={CalendarClock}
          label="Automations"
          meta="scheduled"
          isActive={activeDestination === "automations"}
          onClick={() => onSelectDestination("automations")}
        />
        <SidebarDestinationRow
          icon={GitPullRequest}
          label="Diff review"
          meta="approval"
          isActive={activeDestination === "diff"}
          onClick={() => onSelectDestination("diff")}
        />
        <SidebarDestinationRow
          icon={Globe2}
          label="Browser preview"
          meta="local"
          isActive={activeDestination === "browser"}
          onClick={() => onSelectDestination("browser")}
        />
      </SidebarSection>

      <SidebarSection title="Profiles">
        <SidebarStaticRow icon={Terminal} label="Shell" meta="running" />
        <SidebarStaticRow icon={Bot} label="Codex" meta="waiting" />
        <SidebarStaticRow icon={Bot} label="Claude Code" meta="restored" />
      </SidebarSection>

      <SidebarSection grow title="Status">
        <SidebarStaticRow icon={Check} label="Approvals" meta="gated" />
        <SidebarStaticRow icon={CircleDashed} label="Restore" meta="local" />
        <SidebarStaticRow icon={HardDrive} label="Output" meta="bounded" />
      </SidebarSection>
    </>
  );
}

function IdeSidebarContent({
  activeDestination,
  workspacePath,
  onSelectDestination,
  onOpenWorkspace,
  onOpenCommandPalette,
}: {
  activeDestination: AppDestination;
  workspacePath?: string;
  onSelectDestination: (destination: AppDestination) => void;
  onOpenWorkspace: () => void;
  onOpenCommandPalette: () => void;
}) {
  return (
    <>
      <div className="gyro-sidebar-actions">
        <button
          className="gyro-sidebar-action"
          onClick={onOpenWorkspace}
          type="button"
        >
          <Folder size={15} />
          Open folder
        </button>
        <button
          className="gyro-sidebar-action"
          onClick={onOpenCommandPalette}
          type="button"
        >
          <Search size={15} />
          Search files
        </button>
        <button
          className="gyro-sidebar-action"
          onClick={() => onSelectDestination("diff")}
          type="button"
        >
          <GitPullRequest size={15} />
          Review changes
        </button>
      </div>

      <SidebarSection title="Explorer">
        <button
          className="gyro-sidebar-row gyro-workspace-card"
          onClick={onOpenWorkspace}
          type="button"
        >
          <Laptop size={15} />
          <span>{workspaceName(workspacePath)}</span>
          <small>
            {workspacePath ? "Local workspace" : "No workspace selected"}
          </small>
        </button>
        <SidebarStaticRow icon={Folder} label="packages/ui/src" meta="open" />
        <SidebarStaticRow icon={Folder} label="apps/desktop/src" meta="open" />
        <SidebarStaticRow icon={Folder} label="docs" meta="local" />
      </SidebarSection>

      <SidebarSection title="Tools">
        <SidebarDestinationRow
          icon={FileCode2}
          label="Editor preview"
          meta="active"
          isActive={activeDestination === "ide"}
          onClick={() => onSelectDestination("ide")}
        />
        <SidebarDestinationRow
          icon={GitPullRequest}
          label="Diff review"
          meta="changes"
          isActive={activeDestination === "diff"}
          onClick={() => onSelectDestination("diff")}
        />
        <SidebarDestinationRow
          icon={Globe2}
          label="Browser preview"
          meta="visual"
          isActive={activeDestination === "browser"}
          onClick={() => onSelectDestination("browser")}
        />
      </SidebarSection>

      <SidebarSection grow title="Open files">
        <SidebarDestinationRow
          icon={FileText}
          label="surfaces.tsx"
          meta="tsx"
          isActive={activeDestination === "ide"}
          onClick={() => onSelectDestination("ide")}
        />
        <SidebarDestinationRow
          icon={FileText}
          label="styles.css"
          meta="css"
          onClick={() => onSelectDestination("ide")}
        />
        <SidebarDestinationRow
          icon={FileText}
          label="App.tsx"
          meta="tsx"
          onClick={() => onSelectDestination("ide")}
        />
      </SidebarSection>
    </>
  );
}

function sidebarSurfaceForDestination(destination: AppDestination): SurfaceId {
  if (
    destination === "cli" ||
    destination === "tasks" ||
    destination === "diff" ||
    destination === "browser"
  ) {
    return "cli";
  }

  if (destination === "ide") {
    return "ide";
  }

  return "chat";
}

function SidebarSection({
  title,
  grow,
  collapsible,
  isCollapsed,
  meta,
  onToggle,
  children,
}: {
  title: string;
  grow?: boolean;
  collapsible?: boolean;
  isCollapsed?: boolean;
  meta?: string;
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
  meta: string;
}) {
  return (
    <div className="gyro-sidebar-row">
      <Icon size={15} />
      <span>{label}</span>
      <small>{meta}</small>
    </div>
  );
}

function SidebarProjectRow({
  icon: Icon,
  label,
  meta,
  onClick,
}: {
  icon: IconComponent;
  label: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      className="gyro-sidebar-project-row"
      onClick={onClick}
      type="button"
    >
      <Icon size={15} />
      <span>{label}</span>
      <small>{meta}</small>
    </button>
  );
}

function SessionSidebarRow({
  session,
  isActive,
  isPinned,
  isMenuOpen,
  onSelect,
  onPin,
  onMenuToggle,
  onRename,
  onDelete,
}: {
  session: Session;
  isActive: boolean;
  isPinned: boolean;
  isMenuOpen: boolean;
  onSelect: () => void;
  onPin: () => void;
  onMenuToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={[
        "gyro-session-row",
        isActive ? "is-active" : "",
        isPinned ? "is-pinned" : "",
        isMenuOpen ? "is-menu-open" : "",
      ].join(" ")}
    >
      <button
        className="gyro-sidebar-thread-main"
        onClick={onSelect}
        type="button"
      >
        <span>{session.title}</span>
        <small className="gyro-session-time">
          {relativeSessionTime(session.updatedAt)}
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

function SidebarThreadRow({
  label,
  meta,
  indent,
  isActive,
  onClick,
}: {
  label: string;
  meta: string;
  indent?: boolean;
  isActive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={[
        "gyro-sidebar-thread",
        indent ? "is-indent" : "",
        isActive ? "is-active" : "",
      ].join(" ")}
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      <small>{meta}</small>
    </button>
  );
}

function SidebarDestinationRow({
  icon: Icon,
  label,
  meta,
  isActive,
  onClick,
}: {
  icon: IconComponent;
  label: string;
  meta: string;
  isActive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={isActive ? "gyro-sidebar-row is-active" : "gyro-sidebar-row"}
      onClick={onClick}
      type="button"
    >
      <Icon size={15} />
      <span>{label}</span>
      <small>{meta}</small>
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
    <header className="gyro-topbar">
      <div className="gyro-title-stack">
        <div className="gyro-surface-title">
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
        <div className="gyro-workspace-path">{workspacePath ?? subtitle}</div>
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
            New session
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
  onOpenDestination?: (destination: AppDestination) => void;
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
  onOpenDestination,
  onOpenWorkspace,
}: ChatUtilityBarProps) {
  const waitingPanes = terminalPanes.filter(
    (pane) => pane.status === "waiting",
  ).length;
  const runningPanes = terminalPanes.filter(
    (pane) => pane.status === "running",
  ).length;
  const pendingDiffs =
    diffReview?.files.filter((file) => file.state === "pending").length ?? 0;
  const previewState = browserPreview?.status ?? "idle";
  const hasTerminalActivity = waitingPanes > 0 || runningPanes > 0;
  const hasDiffActivity = pendingDiffs > 0;
  const hasPreviewActivity = previewState !== "idle";
  const hasTurnActivity = activeTurn && activeTurn.sessionTitle;

  return (
    <header className="gyro-chat-utility-bar">
      <div className="gyro-chat-context">
        <strong>{sessionTitle ?? "Chat"}</strong>
        <span>
          {workspaceName(workspacePath)} · {workspaceMode}
        </span>
      </div>
      <div className="gyro-chat-tools" aria-label="Chat tools">
        {hasTerminalActivity ? (
          <button
            className="gyro-chat-tool"
            onClick={() => onOpenDestination?.("cli")}
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
            onClick={() => onOpenDestination?.("diff")}
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
            onClick={() => onOpenDestination?.("diff")}
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
            onClick={() => onOpenDestination?.("browser")}
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
          aria-label="New chat"
          className="gyro-chat-icon-tool"
          onClick={() => onCreateSession?.()}
          title="New chat"
          type="button"
        >
          <Edit3 size={16} />
        </button>
      </div>
    </header>
  );
}

type ChatSurfaceProps = {
  events: SessionEvent[];
  draft: string;
  sessionTitle?: string;
  workspacePath?: string;
  config: GyroConfig;
  providerReadiness?: ProviderReadiness;
  terminalPanes?: TerminalPane[];
  diffReview?: DiffReview;
  browserPreview?: BrowserPreview;
  onboarding?: OnboardingState;
  showOnboardingSteps?: boolean;
  isEnvironmentRailOpen?: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onComposerAction?: (action: string) => void;
  onToggleEnvironmentRail?: () => void;
  onSetOnboardingStep?: (step: OnboardingState["activeStep"]) => void;
  onCompleteOnboardingStep?: (step: OnboardingState["activeStep"]) => void;
  onAgentAction?: (action: string) => void;
  onOpenDestination?: (destination: AppDestination) => void;
};

export function ChatSurface({
  events,
  draft,
  sessionTitle,
  workspacePath,
  config,
  providerReadiness,
  terminalPanes,
  diffReview,
  browserPreview,
  onboarding,
  showOnboardingSteps = false,
  isEnvironmentRailOpen = false,
  onDraftChange,
  onSend,
  onComposerAction,
  onToggleEnvironmentRail,
  onSetOnboardingStep,
  onCompleteOnboardingStep,
  onAgentAction,
  onOpenDestination,
}: ChatSurfaceProps) {
  if (events.length === 0 && !sessionTitle) {
    return (
      <div className="gyro-chat-surface is-empty">
        <section className="gyro-chat-start" aria-label="New chat">
          <h1>What should we build in Gyro?</h1>
          <Composer
            config={config}
            draft={draft}
            onDraftChange={onDraftChange}
            onSend={onSend}
            providerReadiness={providerReadiness}
            variant="hero"
            workspacePath={workspacePath}
            onComposerAction={onComposerAction}
          />
          {showOnboardingSteps ? (
            <OnboardingSteps
              onboarding={onboarding}
              onCompleteStep={onCompleteOnboardingStep}
              onSelectStep={onSetOnboardingStep}
            />
          ) : null}
        </section>
      </div>
    );
  }

  const pendingDiffs =
    diffReview?.files.filter((file) => file.state === "pending").length ?? 0;
  const hasWorkbenchActivity =
    (terminalPanes?.length ?? 0) > 0 ||
    pendingDiffs > 0 ||
    (browserPreview?.status ?? "idle") !== "idle";

  return (
    <div
      className={
        hasWorkbenchActivity && isEnvironmentRailOpen
          ? "gyro-chat-surface has-environment"
          : "gyro-chat-surface"
      }
    >
      <section className="gyro-chat-thread-canvas" aria-label="Chat">
        <div className="gyro-chat-thread-topbar">
          <div>
            <strong>{sessionTitle ?? "Gyro session"}</strong>
            <span>{workspaceName(workspacePath)}</span>
          </div>
          <div className="gyro-thread-pills">
            {hasWorkbenchActivity ? (
              <>
                <span>BYOK</span>
                <span>Local</span>
                <button
                  aria-expanded={isEnvironmentRailOpen}
                  className="gyro-thread-pill-button"
                  onClick={onToggleEnvironmentRail}
                  type="button"
                >
                  <PanelRight size={13} />
                  Context
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="gyro-thread-body gyro-chat-transcript">
          {events.map((event) => (
            <ChatEvent event={event} key={event.id} />
          ))}
          {events.length === 0 ? (
            <div className="gyro-thread-empty">Start with a request.</div>
          ) : null}
          {hasWorkbenchActivity ? (
            <AgentRunPreview
              diffCount={pendingDiffs}
              onAction={onAgentAction}
              onOpenDestination={onOpenDestination}
              terminalCount={terminalPanes?.length ?? 0}
            />
          ) : null}
        </div>

        <div className="gyro-chat-composer-dock">
          <Composer
            config={config}
            draft={draft}
            onDraftChange={onDraftChange}
            onSend={onSend}
            providerReadiness={providerReadiness}
            workspacePath={workspacePath}
            onComposerAction={onComposerAction}
          />
        </div>
      </section>
      {hasWorkbenchActivity && isEnvironmentRailOpen ? (
        <EnvironmentRail
          browserPreview={browserPreview}
          config={config}
          diffReview={diffReview}
          onAction={onComposerAction}
          onOpenDestination={onOpenDestination}
          terminalPanes={terminalPanes}
          workspacePath={workspacePath}
        />
      ) : null}
    </div>
  );
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
  onOpenDiffInEditor?: (path: string) => void;
  onBrowserBack?: () => void;
  onBrowserForward?: () => void;
  onBrowserReload?: () => void;
  onBrowserUrlChange?: (url: string) => void;
  onBrowserNavigate?: (url: string) => void;
  onBrowserDeviceChange?: (device: BrowserPreviewDevice) => void;
  onBrowserScreenshot?: () => void;
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
  const activePanes = panes.filter((pane) =>
    ["running", "waiting"].includes(pane.status),
  );

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
            <ContextMetric label="Branch" value="main" />
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
  selectedPath?: string;
  fileContent?: WorkspaceFileContent;
  fileError?: string;
  fileLoadState?: "idle" | "loading" | "ready" | "error";
  onSelectFile: (path: string) => void;
  terminalOutput: string;
  activePaneTab: WorkbenchPaneTab;
  terminalPanes?: TerminalPane[];
  selectedTerminalPaneId?: string;
  terminalTemplate?: TerminalTemplate;
  diffReview?: DiffReview;
  browserPreview?: BrowserPreview;
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
  onOpenDiffInEditor?: (path: string) => void;
  onBrowserBack?: () => void;
  onBrowserForward?: () => void;
  onBrowserReload?: () => void;
  onBrowserUrlChange?: (url: string) => void;
  onBrowserNavigate?: (url: string) => void;
  onBrowserDeviceChange?: (device: BrowserPreviewDevice) => void;
  onBrowserScreenshot?: () => void;
  onBrowserOpenExternal?: () => void;
};

export function IdeSurface({
  files,
  selectedPath,
  fileContent,
  fileError = "",
  fileLoadState = "idle",
  onSelectFile,
  terminalOutput,
  activePaneTab,
  terminalPanes,
  selectedTerminalPaneId,
  terminalTemplate,
  diffReview,
  browserPreview,
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
  const editorTabs = files
    .filter((file) => file.kind === "file")
    .slice(0, 3)
    .map((file) => ({ label: workspaceName(file.path), path: file.path }));
  const activeEditorPath = selectedPath;

  return (
    <div className="gyro-ide-surface">
      <nav className="gyro-ide-activitybar" aria-label="IDE views">
        <button
          className="is-active"
          onClick={() => undefined}
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
      <FileTree
        files={files}
        onSelectFile={onSelectFile}
        selectedPath={selectedPath}
      />
      <div className="gyro-ide-editor-stack">
        <section className="gyro-editor-pane" aria-label="Editor preview">
          <div className="gyro-editor-tabs">
            {editorTabs.length > 0 ? (
              editorTabs.map((tab) => (
                <button
                  className={activeEditorPath === tab.path ? "is-active" : ""}
                  key={tab.path}
                  onClick={() => onSelectFile(tab.path)}
                  type="button"
                >
                  <FileCode2 size={14} />
                  <span>{tab.label}</span>
                </button>
              ))
            ) : (
              <button className="is-active" disabled type="button">
                <FileCode2 size={14} />
                <span>No file selected</span>
              </button>
            )}
            <span className="gyro-preview-tag">Editor</span>
          </div>
          <div className="gyro-breadcrumb-row">
            {activeEditorPath ? (
              <>
                {parentSegments(activeEditorPath).map((segment) => (
                  <span key={segment}>{segment}</span>
                ))}
                {parentSegments(activeEditorPath).length > 0 ? (
                  <ChevronRight size={13} />
                ) : null}
                <strong>{workspaceName(activeEditorPath)}</strong>
              </>
            ) : (
              <strong>No workspace file loaded</strong>
            )}
          </div>
          <div
            className="gyro-code-surface"
            role="img"
            aria-label="Code editor"
          >
            {fileLoadState === "loading" ? (
              <div className="gyro-code-empty">Loading file preview...</div>
            ) : fileLoadState === "error" ? (
              <div className="gyro-code-empty">
                {fileError || "File preview failed."}
              </div>
            ) : activeEditorPath && fileContent?.path === activeEditorPath ? (
              <pre>
                <code>{fileContent.content}</code>
              </pre>
            ) : (
              <div className="gyro-code-empty">
                {files.length > 0
                  ? "Select a workspace file to preview it here."
                  : "Open a workspace file to preview it here."}
              </div>
            )}
          </div>
        </section>
        <section
          className="gyro-workbench-pane is-compact"
          aria-label="IDE panel"
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
            onToggleDiffDirectory={onToggleDiffDirectory}
            onRunGitReviewAction={onRunGitReviewAction}
            onSelectTerminalPane={onSelectTerminalPane}
            onSplitTerminalPane={onSplitTerminalPane}
            onTerminalUtilityAction={onTerminalUtilityAction}
            onWriteTerminalInput={onWriteTerminalInput}
            onUndoDiff={onUndoDiff}
            profiles={[]}
            terminalOutput={terminalOutput}
          />
        </section>
        <div className="gyro-editor-statusbar">
          <span>main</span>
          <span>{fileLoadState}</span>
          <span>
            {fileContent
              ? `${formatBytes(fileContent.sizeBytes)}${
                  fileContent.truncated ? " preview" : ""
                }`
              : activeEditorPath
                ? "No preview"
                : "No file"}
          </span>
          <span>UTF-8</span>
        </div>
      </div>
    </div>
  );
}

type FileTreeProps = {
  files: WorkspaceFile[];
  selectedPath?: string;
  onSelectFile: (path: string) => void;
};

export function FileTree({ files, selectedPath, onSelectFile }: FileTreeProps) {
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
          files.map((file) => (
            <button
              className={
                file.path === selectedPath
                  ? "gyro-file-row is-active"
                  : "gyro-file-row"
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
        updateChannel: "stable",
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
  terminalPanes?: TerminalPane[];
  selectedTerminalPaneId?: string;
  terminalTemplate?: TerminalTemplate;
  output: string;
  onProfileChange: (profileId: string) => void;
  onRunProfile: () => void;
  onAddTerminalPane?: () => void;
  onSplitTerminalPane?: (template: TerminalTemplate) => void;
  onSelectTerminalPane?: (paneId: string) => void;
  onRenameTerminalPane?: (paneId: string) => void;
  onRestartTerminalPane?: (paneId: string) => void;
  onKillTerminalPane?: (paneId: string) => void;
  onTerminalUtilityAction?: (action: string) => void;
  onWriteTerminalInput?: (input: string) => void;
};

export function TerminalPanel({
  profiles,
  activeProfileId,
  terminalPanes,
  selectedTerminalPaneId,
  terminalTemplate = 4,
  onProfileChange,
  onRunProfile,
  onAddTerminalPane,
  onSplitTerminalPane,
  onSelectTerminalPane,
  onRenameTerminalPane,
  onRestartTerminalPane,
  onKillTerminalPane,
  onTerminalUtilityAction,
  onWriteTerminalInput,
}: TerminalPanelProps) {
  const panes = terminalPanes ?? [];
  const activePaneId = selectedTerminalPaneId ?? panes[0]?.id;
  const [terminalInput, setTerminalInput] = useState("");
  const submitTerminalInput = () => {
    const input = terminalInput;
    if (!input.trim() && input !== "") {
      return;
    }
    onWriteTerminalInput?.(`${input}\n`);
    setTerminalInput("");
  };
  return (
    <div className="gyro-terminal-workspace">
      <div className="gyro-terminal-tabbar">
        {panes.map((pane) => (
          <button
            className={
              pane.id === activePaneId
                ? "gyro-terminal-tab is-active"
                : "gyro-terminal-tab"
            }
            key={pane.id}
            onClick={() => onSelectTerminalPane?.(pane.id)}
            type="button"
          >
            <Bot size={14} />
            <span>{pane.title}</span>
            <span className={`gyro-ring is-${pane.status}`} />
          </button>
        ))}
        <button
          className="gyro-terminal-add"
          onClick={onAddTerminalPane}
          type="button"
        >
          <Plus size={15} />
        </button>
        <div className="gyro-terminal-tools">
          <button
            aria-label="Split vertical"
            onClick={() => onSplitTerminalPane?.(2)}
            title="Split vertical"
            type="button"
          >
            <PanelRight size={15} />
          </button>
          <button
            aria-label="Split horizontal"
            onClick={() =>
              onSplitTerminalPane?.(
                terminalTemplate === 1 ? 2 : terminalTemplate,
              )
            }
            title="Split horizontal"
            type="button"
          >
            <LayoutPanelLeft size={15} />
          </button>
          <button
            aria-label="Rename"
            disabled={!activePaneId}
            onClick={() => activePaneId && onRenameTerminalPane?.(activePaneId)}
            title="Rename"
            type="button"
          >
            <FileText size={15} />
          </button>
          <button
            aria-label="Restart"
            disabled={!activePaneId}
            onClick={() =>
              activePaneId && onRestartTerminalPane?.(activePaneId)
            }
            title="Restart"
            type="button"
          >
            <RefreshCw size={15} />
          </button>
          <button
            aria-label="Kill"
            disabled={!activePaneId}
            onClick={() => activePaneId && onKillTerminalPane?.(activePaneId)}
            title="Kill"
            type="button"
          >
            <X size={15} />
          </button>
          <button
            aria-label="More terminal actions"
            onClick={() => onTerminalUtilityAction?.("more-actions")}
            type="button"
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
      </div>
      <div className="gyro-terminal-controlbar">
        <select
          aria-label="Command profile"
          onChange={(event) => onProfileChange(event.target.value)}
          value={activeProfileId}
        >
          {profiles.length === 0 ? (
            <option value="shell">Shell</option>
          ) : (
            profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.displayName}
              </option>
            ))
          )}
        </select>
        <button
          aria-label="Run selected command profile"
          className="gyro-icon-button"
          disabled={!activePaneId}
          onClick={onRunProfile}
          title="Run profile"
          type="button"
        >
          <Play size={15} />
        </button>
        <div className="gyro-terminal-action-set">
          <button
            disabled={!activePaneId}
            onClick={() => onTerminalUtilityAction?.("read-screen")}
            type="button"
          >
            Read screen
          </button>
          <button
            disabled={!activePaneId}
            onClick={submitTerminalInput}
            type="button"
          >
            Send input
          </button>
          <button
            disabled={!activePaneId}
            onClick={() => onTerminalUtilityAction?.("open-in-app")}
            type="button"
          >
            Open in app
          </button>
        </div>
        <input
          aria-label="Terminal input"
          disabled={!activePaneId}
          onChange={(event) => setTerminalInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submitTerminalInput();
            }
          }}
          placeholder="stdin"
          value={terminalInput}
        />
      </div>
      <div className="gyro-terminal-grid" aria-label="Terminal grid">
        {panes.length > 0 ? (
          panes.map((pane) => (
            <TerminalPaneView
              command={pane.command}
              isActive={pane.id === activePaneId}
              key={pane.id}
              onSelect={() => onSelectTerminalPane?.(pane.id)}
              output={pane.output}
              branch={pane.branch}
              status={pane.status}
              title={pane.title}
              workspaceMode={pane.workspaceMode}
              worktreeName={pane.worktreeName}
            />
          ))
        ) : (
          <div className="gyro-terminal-empty">
            <Terminal size={18} />
            <strong>No terminal panes yet</strong>
            <span>Create a pane before running a command profile.</span>
            <button
              className="gyro-secondary-button"
              onClick={onAddTerminalPane}
              type="button"
            >
              <Plus size={15} />
              Create terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function WorkbenchPaneTabs({
  activeTab,
  onTabChange,
  onAddPane,
}: {
  activeTab: WorkbenchPaneTab;
  onTabChange: (tab: WorkbenchPaneTab) => void;
  onAddPane?: () => void;
}) {
  return (
    <div className="gyro-pane-tabs" role="tablist" aria-label="Workbench panes">
      {paneTabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = tab.id === activeTab;
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
            {tab.label}
          </button>
        );
      })}
      <button className="gyro-pane-add" onClick={onAddPane} type="button">
        <Plus size={16} />
      </button>
    </div>
  );
}

function WorkbenchPaneContent({
  activePaneTab,
  profiles,
  activeProfileId,
  selectedTerminalPaneId,
  terminalPanes,
  terminalTemplate,
  diffReview,
  browserPreview,
  terminalOutput,
  onProfileChange,
  onRunProfile,
  onAddTerminalPane,
  onSplitTerminalPane,
  onSelectTerminalPane,
  onRenameTerminalPane,
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
}: {
  activePaneTab: WorkbenchPaneTab;
  profiles: CommandProfile[];
  activeProfileId: string;
  selectedTerminalPaneId?: string;
  terminalPanes?: TerminalPane[];
  terminalTemplate?: TerminalTemplate;
  diffReview?: DiffReview;
  browserPreview?: BrowserPreview;
  terminalOutput: string;
  onProfileChange: (profileId: string) => void;
  onRunProfile: () => void;
  onAddTerminalPane?: () => void;
  onSplitTerminalPane?: (template: TerminalTemplate) => void;
  onSelectTerminalPane?: (paneId: string) => void;
  onRenameTerminalPane?: (paneId: string) => void;
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
  onOpenDiffInEditor?: (path: string) => void;
  onBrowserBack?: () => void;
  onBrowserForward?: () => void;
  onBrowserReload?: () => void;
  onBrowserUrlChange?: (url: string) => void;
  onBrowserNavigate?: (url: string) => void;
  onBrowserDeviceChange?: (device: BrowserPreviewDevice) => void;
  onBrowserScreenshot?: () => void;
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

  return (
    <TerminalPanel
      activeProfileId={activeProfileId}
      selectedTerminalPaneId={selectedTerminalPaneId}
      terminalPanes={terminalPanes}
      terminalTemplate={terminalTemplate}
      onAddTerminalPane={onAddTerminalPane}
      onKillTerminalPane={onKillTerminalPane}
      onProfileChange={onProfileChange}
      onRunProfile={onRunProfile}
      onRestartTerminalPane={onRestartTerminalPane}
      onRenameTerminalPane={onRenameTerminalPane}
      onSelectTerminalPane={onSelectTerminalPane}
      onSplitTerminalPane={onSplitTerminalPane}
      onTerminalUtilityAction={onTerminalUtilityAction}
      onWriteTerminalInput={onWriteTerminalInput}
      output={terminalOutput}
      profiles={profiles}
    />
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

  return (
    <div className="gyro-board-surface">
      <div className="gyro-board-toolbar">
        <div>
          <strong>Plan</strong>
          <span>Dispatch tasks into app-hosted CLI panes</span>
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
      </div>
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
                      Open pane
                    </button>
                  </div>
                  <div className="gyro-task-transition-row">
                    {(
                      [
                        "todo",
                        "in-progress",
                        "in-review",
                        "complete",
                      ] as TaskStatus[]
                    ).map((status) => (
                      <button
                        className={status === task.status ? "is-active" : ""}
                        key={status}
                        onClick={(event) => {
                          event.stopPropagation();
                          onMoveTask?.(task.id, status);
                        }}
                        type="button"
                      >
                        {status}
                      </button>
                    ))}
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

  return (
    <div className="gyro-automations-surface">
      <header className="gyro-automation-toolbar">
        <div>
          <strong>Automations</strong>
          <span>
            Scheduled agent runs with local triage and stop conditions
          </span>
        </div>
        <div className="gyro-board-actions">
          <button
            className="gyro-secondary-button"
            disabled={!selectedAutomation}
            onClick={() =>
              selectedAutomation && onRunAutomation?.(selectedAutomation.id)
            }
            type="button"
          >
            <Play size={15} />
            Run now
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
            {automation.status === "paused" ? (
              <Play size={15} />
            ) : (
              <PauseCircle size={15} />
            )}
            {automation.status === "paused" ? "Resume" : "Pause"}
          </button>
          <button className="gyro-primary-button" onClick={onRun} type="button">
            <Play size={15} />
            Run
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
          value={automation.worktreeName ?? automation.workspaceMode}
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
            <small>{relativeSessionTime(run.startedAt)}</small>
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
  onProviderModelChange,
  onQueueProviderHandoff,
  onAddCustomProfile,
}: {
  config: GyroConfig;
  providerStatuses?: ProviderStatus[];
  providerSessions?: ProviderSession[];
  providerHandoffs?: ProviderHandoff[];
  onToggleProvider?: (providerId: string) => void;
  onTestProvider?: (providerId: string) => void;
  onProviderModelChange?: (providerId: string, model: string) => void;
  onQueueProviderHandoff?: (request: {
    fromProviderId: string;
    toProviderId: string;
    contextSummary: string;
  }) => void;
  onAddCustomProfile?: () => void;
}) {
  const providerConfigs = providerConfigsWithDefaults(config.modelProviders);
  const commandProfiles = commandProfilesWithDefaults(config.commandProfiles);
  const statuses =
    providerStatuses && providerStatuses.length > 0
      ? providerStatuses
      : defaultProviderStatuses();
  const [fromProviderId, setFromProviderId] = useState(
    providerConfigs[0]?.id ?? "openai",
  );
  const [toProviderId, setToProviderId] = useState(
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
    (provider) => provider.enabled,
  ).length;

  return (
    <div className="gyro-providers-surface">
      <section className="gyro-provider-hero">
        <div>
          <strong>Agents & Providers</strong>
          <span>Local subscriptions, BYOK credentials, and CLI commands.</span>
        </div>
        <span className="gyro-live-pill">{enabledProviderCount} enabled</span>
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
                      <KeyRound size={17} />
                    </div>
                    <div>
                      <strong>{provider.displayName}</strong>
                      <span>
                        {provider.enabled ? "Authenticated" : "Not connected"} ·{" "}
                        {status?.connectionStatus ?? "not-configured"}
                      </span>
                    </div>
                    <span
                      className={
                        provider.enabled
                          ? "gyro-provider-state is-enabled"
                          : "gyro-provider-state"
                      }
                    >
                      {provider.enabled ? "on" : "off"}
                    </span>
                  </div>
                  <div className="gyro-provider-card-body">
                    <SettingsRow
                      detail="Stored in macOS Keychain when configured."
                      label="API key"
                      value={provider.apiKeyRef}
                    />
                    <SettingsRow
                      detail="Uses subscriptions or bring-your-own-key credentials."
                      label="Account mode"
                      value={provider.enabled ? "BYOK" : "Setup"}
                    />
                    <SettingsRow
                      detail="Reasoning and effort defaults can vary per profile."
                      label="Default model"
                      value={status?.defaultModel ?? "Choose"}
                    />
                    <div className="gyro-provider-health">
                      <span
                        className={`is-${status?.connectionStatus ?? "not-configured"}`}
                      />
                      <div>
                        <strong>Health</strong>
                        <small>
                          {status?.healthSummary ??
                            (provider.enabled
                              ? "Ready to check local credentials."
                              : "Enable before checking.")}
                        </small>
                      </div>
                      <em>
                        {status?.healthCheckedAt
                          ? relativeSessionTime(status.healthCheckedAt)
                          : (status?.connectionStatus ?? "not-configured")}
                      </em>
                    </div>
                    <div className="gyro-provider-actions">
                      <button
                        className="gyro-secondary-button"
                        onClick={() => onToggleProvider?.(provider.id)}
                        type="button"
                      >
                        {provider.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        className="gyro-secondary-button"
                        onClick={() => onTestProvider?.(provider.id)}
                        type="button"
                      >
                        Test
                      </button>
                      <button
                        className="gyro-secondary-button"
                        onClick={() =>
                          onProviderModelChange?.(
                            provider.id,
                            provider.enabled ? "Fast local" : "5.5 Extra High",
                          )
                        }
                        type="button"
                      >
                        Model
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
  onScreenshot?: () => void;
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
      screenshotCount: 0,
      status: "verification-passed",
      verificationMessage: "Agent verification passed",
    } satisfies BrowserPreview);
  const canGoBack = preview.historyIndex > 0;
  const canGoForward = preview.historyIndex < preview.history.length - 1;

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
        <button aria-label="Reload" onClick={onReload} type="button">
          <RefreshCw size={15} />
        </button>
        <form
          className="gyro-url-bar"
          onSubmit={(event) => {
            event.preventDefault();
            onNavigate?.(preview.url);
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
        <span className="gyro-browser-console-pill">
          Console {preview.consoleErrors}
        </span>
        <button onClick={onScreenshot} type="button">
          Screenshot {preview.screenshotCount}
        </button>
        <button onClick={onOpenExternal} type="button">
          Open external
        </button>
      </div>
      <div className="gyro-browser-frame">
        <div className={`gyro-browser-page is-${preview.device}`}>
          <header>
            <strong>Gyro preview</strong>
            <span>{preview.verificationMessage}</span>
          </header>
          <div className="gyro-browser-content-grid">
            <div>
              <span>Viewport</span>
              <strong>{deviceLabel(preview.device)}</strong>
            </div>
            <div>
              <span>Console</span>
              <strong>{preview.consoleErrors} errors</strong>
            </div>
            <div>
              <span>Checks</span>
              <strong>{preview.status}</strong>
            </div>
          </div>
          <div className="gyro-browser-skeleton">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
      <div className="gyro-browser-statusbar">
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
        <span>Agent verification status: {preview.status}</span>
      </div>
    </div>
  );
}

export function CommandPaletteOverlay({
  onClose,
  onSelectDestination,
  recents = [],
  query = "",
  onQueryChange,
  onCommand,
}: {
  onClose: () => void;
  onSelectDestination: (destination: AppDestination) => void;
  recents?: string[];
  query?: string;
  onQueryChange?: (query: string) => void;
  onCommand?: (commandId: string) => void;
}) {
  const commands: Array<{
    id: string;
    label: string;
    meta: string;
    destination?: AppDestination;
    icon: IconComponent;
  }> = [
    {
      id: "new-chat",
      label: "New chat",
      meta: "Start a desktop session",
      destination: "chat",
      icon: MessageSquare,
    },
    {
      id: "open-workspace",
      label: "Open workspace",
      meta: "Choose a local folder",
      destination: "chat",
      icon: Folder,
    },
    {
      id: "new-terminal",
      label: "New terminal",
      meta: "Create a shell pane",
      destination: "cli",
      icon: Terminal,
    },
    {
      id: "run-codex",
      label: "Run Codex",
      meta: "Dispatch Codex CLI",
      destination: "cli",
      icon: Bot,
    },
    {
      id: "run-claude",
      label: "Run Claude Code",
      meta: "Dispatch Claude profile",
      destination: "cli",
      icon: Bot,
    },
    {
      id: "split-terminal",
      label: "Split terminal",
      meta: "Choose a pane template",
      destination: "cli",
      icon: PanelRight,
    },
    {
      id: "open-settings",
      label: "Open settings",
      meta: "Preferences",
      destination: "settings",
      icon: Settings,
    },
    {
      id: "search-files",
      label: "Search files",
      meta: "Workspace search",
      destination: "ide",
      icon: Search,
    },
    {
      id: "toggle-theme",
      label: "Toggle theme",
      meta: "Dark or light",
      icon: Palette,
    },
    {
      id: "open-browser-preview",
      label: "Open browser preview",
      meta: "Localhost pane",
      destination: "browser",
      icon: Globe2,
    },
    {
      id: "show-diffs",
      label: "Show diffs",
      meta: "Review changes",
      destination: "diff",
      icon: GitPullRequest,
    },
    {
      id: "run-tests",
      label: "Run tests",
      meta: "Send command to terminal",
      destination: "cli",
      icon: Play,
    },
    {
      id: "create-task",
      label: "Create task",
      meta: "Add to plan board",
      destination: "tasks",
      icon: Activity,
    },
    {
      id: "open-automations",
      label: "Open automations",
      meta: "Scheduled local runs",
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
      meta: "Queue selected automation",
      destination: "automations",
      icon: Play,
    },
    {
      id: "dispatch-agent",
      label: "Dispatch agent",
      meta: "Run a profile in a pane",
      destination: "providers",
      icon: Sparkles,
    },
  ];
  const normalizedQuery = query.trim().toLowerCase();
  const filteredCommands = commands
    .filter((command) =>
      normalizedQuery === ""
        ? true
        : `${command.label} ${command.meta}`
            .toLowerCase()
            .includes(normalizedQuery),
    )
    .sort((a, b) => {
      const aRecent = recents.indexOf(a.id);
      const bRecent = recents.indexOf(b.id);
      if (aRecent === -1 && bRecent === -1) {
        return 0;
      }
      if (aRecent === -1) {
        return 1;
      }
      if (bRecent === -1) {
        return -1;
      }
      return aRecent - bRecent;
    });

  return (
    <div className="gyro-command-overlay" role="dialog" aria-modal="true">
      <div className="gyro-command-palette">
        <header>
          <Search size={17} />
          <input
            autoFocus
            onChange={(event) => onQueryChange?.(event.target.value)}
            placeholder="Search commands"
            value={query}
          />
          <button
            aria-label="Close command palette"
            onClick={onClose}
            type="button"
          >
            <X size={16} />
          </button>
        </header>
        <div className="gyro-command-list">
          {filteredCommands.length === 0 ? (
            <div className="gyro-empty-row">No matching commands</div>
          ) : null}
          {filteredCommands.map((command, index) => {
            const Icon = command.icon;
            return (
              <button
                className={index === 0 ? "is-active" : ""}
                key={command.label}
                onClick={() => {
                  onCommand?.(command.id);
                  if (command.destination) {
                    onSelectDestination(command.destination);
                  }
                  onClose();
                }}
                type="button"
              >
                <Icon size={16} />
                <span>{command.label}</span>
                <small>{command.meta}</small>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type SettingsPanelProps = {
  config: GyroConfig;
};

type SettingsSurfaceProps = {
  config: GyroConfig;
  themeMode: ThemeMode;
  density?: WorkbenchDensity;
  activeSection?: SettingsSectionId;
  onThemeChange: (mode: ThemeMode) => void;
  onDensityChange?: (density: WorkbenchDensity) => void;
  onSectionChange?: (section: SettingsSectionId) => void;
  onConfigChange?: (config: GyroConfig) => void;
  onResetUiState?: () => void;
  onExportDiagnostics?: () => void;
};

export function SettingsSurface({
  config,
  themeMode,
  density = "compact",
  activeSection = "general",
  onThemeChange,
  onDensityChange,
  onSectionChange,
  onConfigChange,
  onResetUiState,
  onExportDiagnostics,
}: SettingsSurfaceProps) {
  const providerConfigs = providerConfigsWithDefaults(config.modelProviders);
  const enabledProviders = providerConfigs.filter(
    (provider) => provider.enabled,
  );
  const disabledProviders = providerConfigs.filter(
    (provider) => !provider.enabled,
  );
  const commandProfiles = commandProfilesWithDefaults(config.commandProfiles);

  return (
    <div className="gyro-settings-surface">
      <aside className="gyro-settings-nav" aria-label="Settings sections">
        {(
          [
            ["general", "General", SlidersHorizontal],
            ["appearance", "Appearance", Palette],
            ["usage-limits", "Usage Limits", Gauge],
            ["providers", "Providers", KeyRound],
            ["cli-profiles", "CLI Profiles", Terminal],
            ["permissions", "Permissions", LockKeyhole],
            ["updates", "Updates", RefreshCw],
            ["keyboard", "Keyboard", CommandIcon],
            ["advanced", "Advanced", Settings],
            ["about", "Help", HelpCircle],
          ] as Array<[SettingsSectionId, string, IconComponent]>
        ).map(([section, label, Icon]) => {
          const SectionIcon = Icon as IconComponent;
          return (
            <button
              className={activeSection === section ? "is-active" : ""}
              key={section}
              onClick={() => onSectionChange?.(section)}
              type="button"
            >
              <SectionIcon size={16} />
              {label}
            </button>
          );
        })}
      </aside>

      <section className="gyro-settings-content" aria-label="Settings">
        <SettingsSection
          icon={SlidersHorizontal}
          title="General"
          description="Workspace startup, local sessions, and default surfaces."
        >
          <SettingsRow
            label="Startup"
            value="Open last workspace"
            detail="Gyro keeps local sessions available across app and CLI."
            onClick={() =>
              onConfigChange?.({
                ...config,
                telemetryEnabled: config.telemetryEnabled,
              })
            }
          />
          <SettingsRow
            label="Default workspace"
            value="Ask on launch"
            detail="Choose a folder only when the session needs filesystem access."
          />
          <SettingsRow
            label="Default surface"
            value="Chats"
            detail="CLI and IDE remain one click away in the sidebar."
          />
          <SettingsRow
            label="Session restore"
            value="On"
            detail="Terminal layouts and app sessions come back after restart."
          />
          <SettingsRow
            label="Continue sessions from CLI"
            value="Enabled"
            detail="CLI-origin sessions can attach back into the desktop app."
          />
        </SettingsSection>

        <SettingsSection
          icon={KeyRound}
          title="Providers"
          description="Bring your own model keys and keep them in macOS Keychain."
        >
          <div className="gyro-provider-list">
            {[...enabledProviders, ...disabledProviders].map((provider) => (
              <button
                className="gyro-provider-row"
                key={provider.id}
                onClick={() =>
                  onConfigChange?.({
                    ...config,
                    modelProviders: providerConfigs.map((item) =>
                      item.id === provider.id
                        ? { ...item, enabled: !item.enabled }
                        : item,
                    ),
                  })
                }
                type="button"
              >
                <div>
                  <strong>{provider.displayName}</strong>
                  <span>{provider.enabled ? "Enabled" : "Not configured"}</span>
                </div>
                <code>{provider.apiKeyRef}</code>
              </button>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Terminal}
          title="CLI Profiles"
          description="Built-in and custom commands that can run in workbench panes."
        >
          <div className="gyro-provider-list">
            {commandProfiles.slice(0, 7).map((profile) => (
              <div className="gyro-provider-row" key={profile.id}>
                <div>
                  <strong>{profile.displayName}</strong>
                  <span>{profile.workingDirectory ?? "Workspace root"}</span>
                </div>
                <code>
                  {profile.command} {profile.args.join(" ")}
                </code>
              </div>
            ))}
          </div>
          <SettingsRow
            label="Hook notifications"
            value="Subtle"
            detail="Done, waiting, failed, and approval states show in app chrome."
          />
        </SettingsSection>

        <SettingsSection
          icon={Palette}
          title="Appearance"
          description="Choose the interface mode used by every Gyro surface."
        >
          <div className="gyro-theme-picker" role="group" aria-label="Theme">
            <button
              className={themeMode === "dark" ? "is-active" : ""}
              onClick={() => onThemeChange("dark")}
              type="button"
            >
              <Moon size={17} />
              <span>Dark</span>
            </button>
            <button
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
            value={density}
            detail="Optimized for terminal grids and dense developer panes."
            onClick={() =>
              onDensityChange?.(
                density === "compact" ? "comfortable" : "compact",
              )
            }
          />
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
        </SettingsSection>

        <SettingsSection
          icon={Gauge}
          title="Usage Limits"
          description="Local guardrails for agent runs, command output, and provider spend."
        >
          <SettingsRow
            label="Command output"
            value="Bounded"
            detail="Large terminal output is summarized into readable command blocks."
          />
          <SettingsRow
            label="Provider spend"
            value="Manual"
            detail="BYOK providers use visible limits before background agent work starts."
          />
          <SettingsRow
            label="Parallel agents"
            value="Ask first"
            detail="Multiple CLI agents should stay explicit until provider health is stable."
          />
          <SettingsRow
            label="Approval budget"
            value="Strict"
            detail="File edits and command escalation remain gated by default."
          />
        </SettingsSection>

        <SettingsSection
          icon={LockKeyhole}
          title="Permissions"
          description="Local-first defaults for commands, edits, telemetry, and secrets."
        >
          <SettingsRow
            label="Command approval"
            value={config.requireCommandApproval ? "Required" : "Custom"}
            detail="Terminal actions stay gated by default."
            onClick={() =>
              onConfigChange?.({
                ...config,
                requireCommandApproval: !config.requireCommandApproval,
              })
            }
          />
          <SettingsRow
            label="File edit approval"
            value={config.requireFileEditApproval ? "Required" : "Custom"}
            detail="Diff review remains explicit."
            onClick={() =>
              onConfigChange?.({
                ...config,
                requireFileEditApproval: !config.requireFileEditApproval,
              })
            }
          />
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
        </SettingsSection>

        <SettingsSection
          icon={RefreshCw}
          title="Updates"
          description="Release channel and signed updater status."
        >
          <SettingsRow
            label="Channel"
            value={config.updateChannel}
            detail="Stable is the default for direct macOS installs."
            onClick={() =>
              onConfigChange?.({
                ...config,
                updateChannel:
                  config.updateChannel === "stable"
                    ? "beta"
                    : config.updateChannel === "beta"
                      ? "nightly"
                      : "stable",
              })
            }
          />
          <SettingsRow
            label="Install method"
            value="Direct or Homebrew"
            detail="Homebrew users update through brew; direct installs use signed artifacts."
          />
          <SettingsRow
            label="Signature verification"
            value="Valid"
            detail="Release artifacts are expected to be signed before install."
          />
          <SettingsRow
            label="Last checked"
            value="Today"
            detail="Stable, Beta, and Nightly channels share the same updater panel."
          />
        </SettingsSection>

        <SettingsSection
          icon={CommandIcon}
          title="Keyboard"
          description="Keyboard-first shortcuts for common workbench actions."
        >
          {(
            [
              ["Command palette", "Cmd+K"],
              ["New session", "Cmd+N"],
              ["New terminal", "Cmd+T"],
              ["Split terminal", "Cmd+\\"],
              ["Switch panes", "Cmd+1-9"],
              ["Open settings", "Cmd+,"],
              ["Search", "Cmd+F"],
            ] as Array<[string, string]>
          ).map(([label, value]) => (
            <SettingsRow
              detail="Editable shortcut"
              key={label}
              label={label}
              value={value}
            />
          ))}
        </SettingsSection>

        <SettingsSection
          icon={Settings}
          title="Advanced"
          description="Local sockets, files, diagnostics, and state reset."
        >
          <SettingsRow
            label="Local socket"
            value="ready"
            detail="CLI agents can attach to the desktop app through the local bridge."
          />
          <SettingsRow
            label="Session store"
            value="Application Support/Gyro"
            detail="All sessions and terminal layouts are stored on this Mac."
          />
          <SettingsRow
            label="Logs path"
            value="Logs/Gyro"
            detail="Diagnostics are local until explicitly exported."
          />
          <SettingsRow
            label="Reset UI state"
            value="Available"
            detail="Clears layout preferences without touching workspace files."
            onClick={onResetUiState}
          />
          <SettingsRow
            label="Export diagnostics"
            value="Manual"
            detail="Creates a redacted bundle for issue reports."
            onClick={onExportDiagnostics}
          />
        </SettingsSection>

        <SettingsSection
          icon={HelpCircle}
          title="Help"
          description="Version, license, release notes, and security policy."
        >
          <SettingsRow
            label="Version"
            value="0.1.0"
            detail="Open-source local-first coding agent workspace."
          />
          <SettingsRow
            label="License"
            value="Apache-2.0"
            detail="Project links, release notes, and governance live in the repo."
          />
          <SettingsRow
            label="Security policy"
            value="Published"
            detail="Responsible disclosure instructions are available locally."
          />
        </SettingsSection>
      </section>
    </div>
  );
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
          <strong>{config.updateChannel}</strong>
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
              config.modelProviders.filter((provider) => provider.enabled)
                .length
            }{" "}
            enabled
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
    <section className="gyro-settings-section">
      <header>
        <div className="gyro-settings-section-icon">
          <Icon size={17} />
        </div>
        <div>
          <strong>{title}</strong>
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
}: {
  label: string;
  value: string;
  detail: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <em>{value}</em>
    </>
  );

  if (onClick) {
    return (
      <button className="gyro-settings-row" onClick={onClick} type="button">
        {content}
      </button>
    );
  }

  return <div className="gyro-settings-row">{content}</div>;
}

function Composer({
  draft,
  onDraftChange,
  onSend,
  workspacePath,
  config,
  providerReadiness,
  onComposerAction,
  variant = "thread",
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  workspacePath?: string;
  config: GyroConfig;
  providerReadiness?: ProviderReadiness;
  onComposerAction?: (action: string) => void;
  variant?: "thread" | "hero";
}) {
  const providerLabel =
    config.modelProviders.find((provider) => provider.enabled)?.displayName ??
    "5.5 Extra High";
  const isHero = variant === "hero";
  return (
    <div
      className={isHero ? "gyro-composer-shell is-hero" : "gyro-composer-shell"}
    >
      <textarea
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            onSend();
          }
        }}
        placeholder={
          variant === "hero"
            ? "Do anything"
            : "Ask for follow-up changes or attach context"
        }
        value={draft}
      />
      {providerReadiness && providerReadiness.status !== "idle" ? (
        <div
          className={`gyro-composer-readiness is-${providerReadiness.status}`}
        >
          <CircleDashed size={13} />
          <span>{providerReadiness.message}</span>
        </div>
      ) : null}
      <div className="gyro-composer-bar">
        <button
          aria-label="Add context"
          className="gyro-composer-tool"
          onClick={() => onComposerAction?.("add-context")}
          title="Add context"
          type="button"
        >
          <Plus size={17} />
        </button>
        <button
          className="gyro-composer-chip is-warning"
          onClick={() => onComposerAction?.("toggle-access")}
          type="button"
        >
          <ShieldCheck size={14} />
          Full access
          <ChevronDown size={13} />
        </button>
        {!isHero ? (
          <>
            <button
              className="gyro-composer-chip"
              onClick={() => onComposerAction?.("select-workspace")}
              type="button"
            >
              <Laptop size={14} />
              {workspaceName(workspacePath)}
            </button>
            <button
              className="gyro-composer-chip"
              onClick={() => onComposerAction?.("select-branch")}
              type="button"
            >
              <GitBranch size={14} />
              main
              <ChevronDown size={13} />
            </button>
          </>
        ) : null}
        <div className="gyro-composer-spacer" />
        <button
          className="gyro-composer-chip"
          onClick={() => onComposerAction?.("select-model")}
          type="button"
        >
          {providerLabel}
          <ChevronDown size={13} />
        </button>
        <button
          aria-label="Dictate message"
          className="gyro-composer-tool"
          onClick={() => onComposerAction?.("dictate")}
          type="button"
        >
          <Mic size={16} />
        </button>
        <button
          aria-label="Send message"
          className="gyro-send-button"
          onClick={onSend}
          title="Send"
          type="button"
        >
          <ArrowUp size={17} />
        </button>
      </div>
      {isHero ? (
        <div className="gyro-composer-context-row">
          <button
            className="gyro-composer-chip"
            onClick={() => onComposerAction?.("select-project")}
            type="button"
          >
            <HardDrive size={14} />
            Gyro
          </button>
          <button
            className="gyro-composer-chip"
            onClick={() => onComposerAction?.("select-workspace-mode")}
            type="button"
          >
            <Laptop size={14} />
            Work locally
            <ChevronDown size={13} />
          </button>
          <button
            className="gyro-composer-chip"
            onClick={() => onComposerAction?.("select-branch")}
            type="button"
          >
            <GitBranch size={14} />
            main
            <ChevronDown size={13} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ChatEvent({ event }: { event: SessionEvent }) {
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const isUser = event.kind === "user-message";
  const isSystem =
    event.kind === "system-event" || event.kind === "approval-requested";
  const canInspect = isInspectableEvent(event);
  return (
    <article
      className={[
        "gyro-message",
        isUser ? "is-user" : "",
        isSystem ? "is-system" : "",
      ].join(" ")}
    >
      <div className="gyro-message-avatar">
        {isUser ? <UserCircle size={17} /> : <Bot size={17} />}
      </div>
      <div>
        <div className="gyro-message-meta">
          {event.kind.replaceAll("-", " ")}
        </div>
        <p>{event.message}</p>
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
}

function isInspectableEvent(event: SessionEvent) {
  return [
    "command-requested",
    "command-output",
    "file-edit-proposed",
    "approval-requested",
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

function EnvironmentRail({
  browserPreview,
  config,
  diffReview,
  terminalPanes = [],
  workspacePath,
  onAction,
  onOpenDestination,
}: {
  browserPreview?: BrowserPreview;
  config: GyroConfig;
  diffReview?: DiffReview;
  terminalPanes?: TerminalPane[];
  workspacePath?: string;
  onAction?: (action: string) => void;
  onOpenDestination?: (destination: AppDestination) => void;
}) {
  const enabledProviders = config.modelProviders.filter(
    (provider) => provider.enabled,
  ).length;
  const waitingPanes = terminalPanes.filter(
    (pane) => pane.status === "waiting",
  ).length;
  const runningPanes = terminalPanes.filter(
    (pane) => pane.status === "running",
  ).length;
  const pendingDiffs =
    diffReview?.files.filter((file) => file.state === "pending").length ?? 0;
  const previewState = browserPreview?.status ?? "idle";
  const terminalValue =
    waitingPanes > 0
      ? `${waitingPanes} waiting`
      : runningPanes > 0
        ? `${runningPanes} running`
        : `${terminalPanes.length} panes`;

  return (
    <aside className="gyro-environment-rail" aria-label="Workbench context">
      <header>
        <span>Workbench</span>
        <button
          aria-label="Add workbench item"
          className="gyro-icon-button is-subtle"
          onClick={() => onAction?.("add-workbench-item")}
          title="Add"
          type="button"
        >
          <Plus size={16} />
        </button>
      </header>
      <div className="gyro-rail-section">
        <RailRow
          icon={Terminal}
          label="Terminal"
          onClick={() => onOpenDestination?.("cli")}
          value={terminalValue}
        />
        {pendingDiffs > 0 ? (
          <RailRow
            icon={GitPullRequest}
            label="Diff review"
            onClick={() => onOpenDestination?.("diff")}
            value={`${pendingDiffs} pending`}
          />
        ) : null}
        {previewState !== "idle" ? (
          <RailRow
            icon={Globe2}
            label="Preview"
            onClick={() => onOpenDestination?.("browser")}
            value={previewState.replace("-", " ")}
          />
        ) : null}
        <RailRow
          icon={HardDrive}
          label="Local"
          value={workspaceName(workspacePath)}
        />
        <RailRow icon={GitBranch} label="main" value="branch" />
        {pendingDiffs > 0 ? (
          <RailRow icon={Check} label="Commit or push" value="needs review" />
        ) : null}
      </div>
      <div className="gyro-rail-section">
        <div className="gyro-rail-heading">Sources</div>
        <RailRow
          icon={Folder}
          label="Workspace"
          value={workspaceName(workspacePath)}
        />
        <RailRow
          icon={KeyRound}
          label="Providers"
          onClick={() => onOpenDestination?.("providers")}
          value={`${enabledProviders} enabled`}
        />
      </div>
    </aside>
  );
}

function RailRow({
  icon: Icon,
  label,
  value,
  disabled,
  onClick,
}: {
  icon: IconComponent;
  label: string;
  value: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const className = [
    "gyro-rail-row",
    disabled ? "is-disabled" : "",
    onClick ? "is-clickable" : "",
  ].join(" ");

  if (onClick && !disabled) {
    return (
      <button className={className} onClick={onClick} type="button">
        <Icon size={16} />
        <span>{label}</span>
        <small>{value}</small>
      </button>
    );
  }

  return (
    <div className={className}>
      <Icon size={16} />
      <span>{label}</span>
      <small>{value}</small>
    </div>
  );
}

type TerminalStatus = "restored" | "running" | "waiting" | "done" | "failed";

function TerminalPaneView({
  title,
  command,
  output,
  status,
  workspaceMode,
  branch,
  worktreeName,
  isActive,
  onSelect,
}: {
  title: string;
  command: string;
  output: string;
  status: TerminalStatus;
  workspaceMode: WorkbenchMode;
  branch: string;
  worktreeName?: string;
  isActive?: boolean;
  onSelect?: () => void;
}) {
  const contextLabel =
    workspaceMode === "worktree" && worktreeName
      ? `${worktreeName} · ${branch}`
      : branch;

  return (
    <section
      className={
        isActive ? "gyro-terminal-pane is-active" : "gyro-terminal-pane"
      }
      onClick={onSelect}
    >
      <header>
        <div>
          <span className={`gyro-ring is-${status}`} />
          <strong>{title}</strong>
        </div>
        <small>{workspaceMode}</small>
      </header>
      <div className="gyro-terminal-context">{contextLabel}</div>
      <div className="gyro-command-block">
        <span>$</span>
        <code>{command}</code>
      </div>
      <pre>{output}</pre>
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
    <div className="gyro-pane-tabs" role="tablist" aria-label="IDE rail">
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

function AgentRunPreview({
  diffCount,
  onAction,
  onOpenDestination,
  terminalCount,
}: {
  diffCount: number;
  onAction?: (action: string) => void;
  onOpenDestination?: (destination: AppDestination) => void;
  terminalCount: number;
}) {
  return (
    <section className="gyro-agent-run-card" aria-label="Agent activity">
      <header>
        <div>
          <strong>Workbench activity</strong>
          <span>
            {terminalCount} terminal{terminalCount === 1 ? "" : "s"}
            {diffCount > 0 ? ` · ${diffCount} pending diff` : ""}
          </span>
        </div>
        {diffCount > 0 ? (
          <span className="gyro-live-pill is-waiting">review</span>
        ) : null}
      </header>
      {diffCount > 0 ? (
        <div className="gyro-diff-summary-card">
          <div>
            <strong>Diff waiting</strong>
            <span>
              {diffCount} file{diffCount === 1 ? "" : "s"} need review.
            </span>
          </div>
          <div>
            <button
              className="gyro-secondary-button"
              onClick={() => onAction?.("reject-diff")}
              type="button"
            >
              Reject
            </button>
            <button
              className="gyro-primary-button"
              onClick={() => onOpenDestination?.("diff")}
              type="button"
            >
              <Check size={15} />
              Review
            </button>
          </div>
        </div>
      ) : (
        <div className="gyro-agent-run-actions">
          <button
            className="gyro-secondary-button"
            onClick={() => onOpenDestination?.("cli")}
            type="button"
          >
            Open terminal
          </button>
        </div>
      )}
    </section>
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
      args: ["-l"],
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

function providerConfigsWithDefaults(
  providers: GyroConfig["modelProviders"],
): GyroConfig["modelProviders"] {
  if (providers.length > 0) {
    return providers;
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

function defaultTerminalOutput(profileName?: string) {
  return `Gyro ${profileName ?? "Shell"}\n~/Documents/Gyro\n\n$ gyro doctor\n✓ workspace store ready\n✓ CLI attach socket ready\n✓ approvals required\n\n$ gyro run \"inspect this repo\"\nWorking locally. Command execution will require approval.`;
}

function workspaceName(path?: string) {
  if (!path) {
    return "No workspace";
  }
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function parentSegments(path: string) {
  return path.split(/[\\/]/).filter(Boolean).slice(0, -1);
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
