import { gitSetupMessage } from "./workspace-preparation";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Box,
  Workflow,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDashed,
  Cloud,
  CodeXml,
  Columns2,
  CornerDownRight,
  Edit3,
  FileCode2,
  FileText,
  GitBranch,
  GitBranchPlus,
  GitPullRequest,
  Globe2,
  HardDrive,
  ListChecks,
  MessageSquare,
  Minus,
  MoreHorizontal,
  PanelLeft,
  PauseCircle,
  Pin,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  Tag,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { AntigravityMark } from "./antigravity-mark";
import { branchCommitDetail, recentBranches } from "./branch-recency";
import { formatRunDuration } from "./chat-run";
import "./automation-detail.css";
import { startChatPointerDrag } from "./chat-pointer-drag";
import {
  beginChatSessionDrag,
  chatDragSource,
  currentChatDrag,
  endChatDrag,
  endChatDragForTransfer,
  subscribeChatDrag,
} from "./chat-session-drag";
import { CheckWorkMenuItem } from "./check-work-context";
import { CliSessionList } from "./cli-session-list";
import { confirmAction } from "./confirm-action";
import { resolveLanguage } from "./editor/languages/registry";
import { useOutsidePointerDismiss } from "./menu-dismiss";
import "./provider-allowance.css";
import {
  CUSTOM_PROVIDER_PREFIX,
  isCustomProviderId,
  isProviderId,
} from "./provider-catalog";
import "./scheduled-work.css";
import { ScmCommitHover } from "./scm-commit-hover";
import { ScmFileActions } from "./scm-file-actions";
import { SelectionTrack } from "./selection-track";
import {
  SidebarProjectCard,
  type SidebarProjectSettings,
} from "./sidebar-project-card";
import {
  sourceControlHistoryMessage,
  sourceControlTotals,
  sourceControlTotalsBadge,
  sourceControlTotalsLabel,
  sourceControlTotalsScope,
} from "./source-control-stats";
import { runSurfaceSwitch } from "./surface-switch-transition";
import { askTextValue } from "./text-prompt";
import type {
  AppDestination,
  CommandProfile,
  CustomTaskDraft,
  DebugSessionState,
  EditorBuffer,
  EditorTab,
  GitBranchCatalog,
  GithubRunState,
  GithubState,
  IdeState,
  IdeViewId,
  ProviderId,
  Session,
  SourceControlFile,
  SourceControlState,
  TaskDefinition,
  TerminalPane,
  WorkbenchPaneTab,
  WorkspaceFile,
  WorkspaceLayoutId,
  WorkspaceSearchQuery,
} from "./types";
import { useDialogDismiss } from "./use-dialog-dismiss";
import {
  isTransientWorkspacePath,
  isUserSelectedWorkspacePath,
} from "./workbench-state";
import { workspaceFileBadge } from "./workspace-file-icons";
import { Folder, FolderOpen } from "./workspace-folder-icons";
import "./workspace-folder-icons.css";
import { validateWorkspaceEntryName } from "./workspace-names";
import {
  normalizedWorkspaceFolderPath,
  planWorkspaceMove,
  workspaceCopyAbsolutePath,
  workspaceCopyRelativePath,
  workspaceExplorerRootEntryGroup,
  workspaceRelativeFilePath,
} from "./workspace-project";
import {
  WorkspaceRootIssues,
  type WorkspaceRootIssuesModel,
} from "./workspace-root-issues";
import {
  workspaceSearchGlobText,
  workspaceSearchGlobs,
} from "./workspace-search";
import { WorkspaceSearchResults } from "./workspace-search-results";

export type IconComponent = typeof MessageSquare;

/** Sessions / Workspace switch. The hidden-sidebar restore cluster renders it
    too, so Workspace keeps the switch on the same pixel with its panel hidden. */
export function PrimarySurfaceSwitch({
  isIdeSidebar,
  onSelectSessions,
  onSelectWorkspace,
}: {
  isIdeSidebar: boolean;
  onSelectSessions: () => void;
  onSelectWorkspace: () => void;
}) {
  return (
    <SelectionTrack
      label="Primary surfaces"
      className="gyro-titlebar-switch"
      value={isIdeSidebar ? "workspace" : "sessions"}
    >
      <SidebarModeRow
        icon={<MessageSquare size={15} strokeWidth={1.5} />}
        label="Sessions"
        isActive={!isIdeSidebar}
        onClick={onSelectSessions}
      />
      <SidebarModeRow
        icon={<CodeXml size={15} strokeWidth={1.5} />}
        label="Workspace"
        isActive={isIdeSidebar}
        onClick={onSelectWorkspace}
      />
    </SelectionTrack>
  );
}

export function scmFileBadge(path: string) {
  return workspaceFileBadge(path);
}

/**
 * Letter and colour tone per resource state, mirroring VS Code's git
 * decorations: M amber, A/U/R mint, D and conflicts red.
 */
export const SCM_STATE_DECORATIONS: Record<
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

export function scmStateDecoration(state: SourceControlFile["state"]) {
  return SCM_STATE_DECORATIONS[state] ?? SCM_STATE_DECORATIONS.modified;
}

/**
 * One hue per graph lane, reused as lanes are recycled. The colours are the
 * only thing that says two commits sit on different branches, so they are
 * spaced around the wheel rather than shaded from one accent.
 */
export const SCM_GRAPH_LANE_COLORS = [
  "#4d9ee0",
  "#e0a03c",
  "#c76bd4",
  "#4bbf9c",
  "#e0715e",
  "#948af0",
];

/** Lanes past this fold back onto the last one; the rail has to stay narrow. */
export const SCM_GRAPH_LANE_LIMIT = 5;

export type ScmGraphRow = {
  /** Lane the commit's dot sits in. */
  lane: number;
  /** Paths from the upper row boundary through the dot to the lower boundary. */
  edges: Array<{
    from: number;
    to: number;
    half: "top" | "bottom";
    color: number;
  }>;
  /** No child in the loaded window, so the lane's line starts at the dot. */
  startsHere: boolean;
  /** No parent in the loaded window, so the lane's line stops at the dot. */
  endsHere: boolean;
  isMerge: boolean;
};

/**
 * Lay the loaded commits out as `git log --graph` does: walk newest to oldest
 * carrying, per lane, the hash that lane is still waiting for. A commit claims
 * the lane that was waiting on it — that is what keeps a branch on one colour
 * down the rail — and hands the lane to its first parent, while a merge's
 * extra parents open lanes of their own.
 *
 * History arrives as a 30-commit window, so a lane can begin or end mid-view
 * simply because the other end is out of frame; those rows draw a half line
 * instead of pretending the branch stops there.
 */
export function scmGraphRows(
  history: NonNullable<SourceControlState["history"]>,
): ScmGraphRow[] {
  const expected: Array<string | undefined> = [];
  const claim = (hash: string | undefined) => {
    const free = expected.indexOf(undefined);
    const lane = free === -1 ? expected.length : free;
    expected[lane] = hash;
    return lane;
  };
  return history.map((commit) => {
    const parents = commit.parents ?? [];
    const waiting = expected.indexOf(commit.hash);
    const startsHere = waiting === -1;
    const lane = startsHere ? claim(commit.hash) : waiting;
    const edges: ScmGraphRow["edges"] = [];
    for (let index = 0; index < expected.length; index += 1) {
      if (expected[index] === undefined) continue;
      const arrives = expected[index] === commit.hash;
      if (!(startsHere && index === lane)) {
        edges.push({
          from: index,
          to: arrives ? lane : index,
          half: "top",
          color: index,
        });
      }
      if (arrives) expected[index] = undefined;
    }
    parents.forEach((parent, index) => {
      let target = expected.indexOf(parent);
      if (target === -1) {
        if (index === 0) {
          expected[lane] = parent;
          target = lane;
        } else {
          target = claim(parent);
        }
      }
      edges.push({ from: lane, to: target, half: "bottom", color: target });
    });
    for (let index = 0; index < expected.length; index += 1) {
      if (
        expected[index] !== undefined &&
        !edges.some((edge) => edge.half === "bottom" && edge.to === index)
      ) {
        edges.push({ from: index, to: index, half: "bottom", color: index });
      } else if (
        expected[index] !== undefined &&
        edges.some(
          (edge) => edge.half === "top" && edge.to === index && index !== lane,
        )
      ) {
        edges.push({ from: index, to: index, half: "bottom", color: index });
      }
    }
    while (expected.length > 0 && expected[expected.length - 1] === undefined) {
      expected.pop();
    }
    return {
      lane,
      edges,
      startsHere,
      endsHere: parents.length === 0,
      isMerge: parents.length > 1,
    };
  });
}

/** Lane pitch in the rail, and the padding that keeps lane 0 off the edge. */
export const SCM_GRAPH_LANE_PITCH = 14;

export const SCM_GRAPH_LANE_INSET = 8;

export const scmGraphLaneOffset = (lane: number) =>
  SCM_GRAPH_LANE_INSET +
  Math.min(lane, SCM_GRAPH_LANE_LIMIT - 1) * SCM_GRAPH_LANE_PITCH;

export const scmGraphLaneColor = (lane: number) =>
  SCM_GRAPH_LANE_COLORS[
    Math.min(lane, SCM_GRAPH_LANE_LIMIT - 1) % SCM_GRAPH_LANE_COLORS.length
  ] ?? "#4d9ee0";

/**
 * The refs git prints for a commit, as the chips the graph shows: the checked
 * out branch first, then tags, then everything else. `HEAD -> main` is one
 * ref in git's output and two facts here — where HEAD is, and which branch.
 */
export function scmCommitRefs(refs: string) {
  return refs
    .split(",")
    .map((ref) => ref.trim())
    .filter(Boolean)
    .map((ref) => {
      if (ref.startsWith("HEAD -> ")) {
        return { label: ref.slice("HEAD -> ".length), kind: "head" as const };
      }
      if (ref === "HEAD") {
        return { label: "HEAD", kind: "head" as const };
      }
      if (ref.startsWith("tag: ")) {
        return { label: ref.slice("tag: ".length), kind: "tag" as const };
      }
      return { label: ref, kind: "branch" as const };
    })
    .sort((first, second) => {
      const rank = { head: 0, tag: 1, branch: 2 };
      return rank[first.kind] - rank[second.kind];
    });
}

/**
 * VS Code's sync badge: how far the branch has drifted from its remote, as
 * "1↓ 2↑". Behind comes first because a pull has to land before a push can,
 * and a direction that is level is left out rather than shown as a zero.
 */
export function scmSyncCountLabel(ahead: number, behind: number) {
  const counts: string[] = [];
  if (behind > 0) {
    counts.push(`${behind}↓`);
  }
  if (ahead > 0) {
    counts.push(`${ahead}↑`);
  }
  return counts.join(" ");
}

/**
 * The row that gets a commit off this machine.
 *
 * Committing writes history locally; nothing reaches GitHub until it is
 * pushed, so the panel says where the branch stands against its remote and
 * offers the one press that closes the gap. A branch that has never been
 * published says so plainly — "Publish branch" is a different act from a
 * push, and the count that would normally sit beside it does not exist yet.
 *
 * The row only earns its space while there is still something to commit: with
 * a clean tree the commit button itself becomes the push or pull, so repeating
 * it here would be a second copy of the same press. A branch level with its
 * remote has nothing to report either, so it says nothing rather than
 * announcing that it is up to date.
 */
export function ScmSyncRow({
  ahead,
  behind,
  hasPendingChanges,
  hasRemote,
  onPull,
  onPush,
  syncing,
  upstream,
}: {
  ahead: number;
  behind: number;
  hasPendingChanges: boolean;
  hasRemote: boolean;
  onPull?: () => void;
  onPush?: () => void;
  syncing: boolean;
  upstream?: string;
}) {
  const published = Boolean(upstream);
  if (!hasRemote || !hasPendingChanges) {
    return null;
  }
  if (published && ahead === 0 && behind === 0) {
    return null;
  }
  const pushLabel = published ? "Push" : "Publish branch";
  const summary = !published
    ? "This branch is not on the remote yet"
    : behind > 0 && ahead > 0
      ? `${ahead} to push, ${behind} to pull`
      : ahead > 0
        ? `${ahead} commit${ahead === 1 ? "" : "s"} to push`
        : `${behind} commit${behind === 1 ? "" : "s"} to pull`;
  return (
    <div className="gyro-sidebar-scm-sync">
      <span className="gyro-scm-sync-summary" title={upstream ?? undefined}>
        {summary}
      </span>
      <div className="gyro-scm-sync-actions">
        {behind > 0 ? (
          <button
            className="is-secondary"
            disabled={syncing}
            onClick={onPull}
            title={`Pull ${behind} from ${upstream}`}
            type="button"
          >
            <ArrowDown size={12} />
            Pull
            <span className="gyro-scm-sync-count">{`${behind}↓`}</span>
          </button>
        ) : null}
        <button
          disabled={syncing || (published && ahead === 0 && behind === 0)}
          onClick={onPush}
          title={
            published
              ? `Push to ${upstream}`
              : "Push this branch to the remote and track it"
          }
          type="button"
        >
          <ArrowUp size={12} />
          {syncing ? "Working…" : pushLabel}
          {!syncing && published && ahead > 0 ? (
            <span className="gyro-scm-sync-count">{`${ahead}↑`}</span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

export const SCM_HISTORY_OPEN_STORAGE_KEY = "gyro.scm-history-open-v1";

/** Cap per group so a huge working tree cannot stall the sidebar. */
export const SCM_GROUP_LIMIT = 60;

/**
 * One VS Code-style change group — "Staged Changes" or "Changes" — with a
 * collapsible header, a count, group actions, and colour-coded rows.
 */
export function ScmSectionDivider({
  label,
  target,
  onResize,
}: {
  label: string;
  target: "previous" | "next";
  onResize: (height: number) => void;
}) {
  const drag = useRef<{
    y: number;
    height: number;
    min: number;
    max: number;
  }>();
  const measure = (divider: HTMLDivElement) => {
    const section =
      target === "previous"
        ? divider.previousElementSibling
        : divider.nextElementSibling;
    const min = Math.max(
      52,
      section ? parseFloat(getComputedStyle(section).minHeight) || 0 : 0,
    );
    return {
      height: section?.getBoundingClientRect().height ?? 100,
      min,
      max: Math.max(
        min,
        (divider.parentElement?.getBoundingClientRect().height ?? 400) * 0.6,
      ),
    };
  };
  return (
    <div
      className="gyro-scm-history-resizer gyro-scm-section-resizer"
      role="separator"
      aria-label={label}
      aria-orientation="horizontal"
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { y: event.clientY, ...measure(event.currentTarget) };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const delta =
          (event.clientY - start.y) * (target === "previous" ? 1 : -1);
        onResize(
          Math.max(start.min, Math.min(start.max, start.height + delta)),
        );
      }}
      onPointerUp={(event) => {
        drag.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = undefined;
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const current = measure(event.currentTarget);
        const delta =
          (event.key === "ArrowDown" ? 12 : -12) *
          (target === "previous" ? 1 : -1);
        onResize(
          Math.max(current.min, Math.min(current.max, current.height + delta)),
        );
      }}
    />
  );
}

export function ScmChangeGroup({
  actions,
  activeDiff,
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
  activeDiff?: EditorTab["sourceControlDiff"];
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
                className={`gyro-sidebar-scm-row${activeDiff?.path === file.path && activeDiff.staged === file.staged ? " is-active" : ""}${selectedPaths.size > 0 ? " is-selecting" : ""}`}
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
                    size={14}
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
                <ScmFileActions path={file.path} onDiscard={onDiscardFile} />
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

/** Explorer-only drag. Media drops ignore every `application/x-gyro-*` type. */
export const EXPLORER_PATH_DRAG_MIME = "application/x-gyro-explorer-path";

/** Blocks composer Return while Ask Gyro is still attaching a file or folder. */
export let explorerAskSendHolds = 0;

export let explorerAskSendHeld = false;

export const explorerAskSendListeners = new Set<() => void>();

export function setExplorerAskSendHeld(held: boolean) {
  explorerAskSendHolds = Math.max(0, explorerAskSendHolds + (held ? 1 : -1));
  const next = explorerAskSendHolds > 0;
  if (explorerAskSendHeld === next) return;
  explorerAskSendHeld = next;
  for (const listener of explorerAskSendListeners) listener();
}

export function WorkspaceSidebarContent({
  sessions,
  commandProfiles,
  savedProjects,
  activeSessionId,
  sendingSessionIds,
  completedSessionIds = [],
  approvalCountsBySessionId = {},
  questionCountsBySessionId = {},
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
  draftChats = [],
  activeDraftId,
  onSelectDraftChat,
  onSelectSession,
  onAddSessionToGrid,
  onSelectDestination,
  onSelectWorkspaceLayout,
  onOpenToolPanel,
  onCreateSession,
  onCreateCliSession,
  onSelectSessions,
  onOpenWorkspace,
  onAddWorkspaceFolder,
  onRemoveWorkspaceFolder,
  workspaceRootIssues,
  onSelectWorkspaceFolder,
  onOpenWorkspaceFile,
  onPinEditorTab,
  onExpandedWorkspaceDirectoriesChange,
  onRefreshWorkspace,
  onCreateWorkspacePath,
  onRenameWorkspacePath,
  onDeleteWorkspacePath,
  onMoveWorkspacePath,
  onDuplicateWorkspacePath,
  onRevealWorkspacePath,
  onAskWorkspacePath,
  onOpenCommandPalette,
  onSelectIdeView,
  onRunWorkspaceSearch,
  onApplyWorkspaceReplace,
  onRefreshSourceControl,
  onToggleSourceControlFile,
  onStageAllSourceControl,
  onDiscardSourceControlFile,
  onOpenSourceControlDiff,
  onReviewWithAgent,
  onCommitSourceControl,
  onPushSourceControl,
  onPullSourceControl,
  onCheckRemote,
  isRemoteChecking = false,
  remoteCheckMessage,
  remoteCheckFailed = false,
  isSourceControlSyncing = false,
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
  onFixIdeTaskWithAi,
  onStopIdeTask,
  onRefreshIdeTasks,
  onCreateCustomTask,
  onDeleteCustomTask,
  onStartDebugSession,
  onSendDebugCommand,
  onStopDebugSession,
  onAddTerminalPane,
  onCloseTerminalPane,
  onSelectTerminalPane,
  onDeleteSession,
  onPinSession,
  onRenameSession,
  onUploadCloudChat,
  onRemoveProject,
  projectSettings,
  onToggleChatsCollapsed,
  onToggleSidebar,
  renderAiChat,
}: {
  renderAiChat?: () => ReactNode;
  sessions: Session[];
  commandProfiles: CommandProfile[];
  savedProjects: Array<{ path: string; label: string }>;
  activeSessionId?: string;
  sendingSessionIds: string[];
  completedSessionIds?: string[];
  approvalCountsBySessionId?: Record<string, number>;
  questionCountsBySessionId?: Record<string, number>;
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
  draftChats?: SidebarDraftChat[];
  activeDraftId?: string;
  onSelectDraftChat?: (draftId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onAddSessionToGrid?: (sessionId: string) => void;
  onSelectDestination: (destination: AppDestination) => void;
  onSelectWorkspaceLayout: (layout: WorkspaceLayoutId) => void;
  onOpenToolPanel: (tab: WorkbenchPaneTab) => void;
  onCreateSession: () => void;
  onCreateCliSession: (profileId: string, workspacePath: string) => void;
  onSelectSessions: () => void;
  onOpenWorkspace: () => void;
  onAddWorkspaceFolder?: () => void;
  onRemoveWorkspaceFolder?: (path: string) => void;
  workspaceRootIssues?: WorkspaceRootIssuesModel;
  onSelectWorkspaceFolder?: (path: string) => void;
  onOpenWorkspaceFile?: (
    path: string,
    lineNumber?: number,
    column?: number,
  ) => void;
  onPinEditorTab?: (path: string) => void;
  onExpandedWorkspaceDirectoriesChange?: (paths: string[]) => void;
  onRefreshWorkspace?: () => void;
  onCreateWorkspacePath?: (
    kind: "file" | "directory",
    parentPath?: string,
    path?: string,
  ) => void;
  onRenameWorkspacePath?: (path: string, nextName: string) => void;
  onDeleteWorkspacePath?: (path: string) => void;
  onMoveWorkspacePath?: (
    fromPath: string,
    destinationDirectory: string,
  ) => void;
  onDuplicateWorkspacePath?: (path: string) => void;
  onRevealWorkspacePath?: (path: string) => void;
  onAskWorkspacePath?: (
    path: string,
  ) => void | boolean | Promise<void | boolean>;
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
  onReviewWithAgent?: () => void;
  onCommitSourceControl?: (message: string) => void;
  onPushSourceControl?: () => void;
  onPullSourceControl?: () => void;
  onCheckRemote?: () => void;
  isRemoteChecking?: boolean;
  remoteCheckMessage?: string;
  remoteCheckFailed?: boolean;
  isSourceControlSyncing?: boolean;
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
  /** Attach a failed command's output to the chat so a model can fix it. */
  onFixIdeTaskWithAi?: (task: TaskDefinition) => void;
  onStopIdeTask?: (task: TaskDefinition) => void | Promise<void>;
  onRefreshIdeTasks?: () => void;
  onCreateCustomTask?: (draft: CustomTaskDraft) => void | Promise<void>;
  onDeleteCustomTask?: (task: TaskDefinition) => void | Promise<void>;
  onStartDebugSession?: (command: string) => void;
  onSendDebugCommand?: (session: DebugSessionState, command: string) => void;
  onStopDebugSession?: (session: DebugSessionState) => void;
  onAddTerminalPane?: (options?: TerminalLaunchOptions) => void;
  onCloseTerminalPane?: (paneId: string) => void;
  onSelectTerminalPane?: (paneId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onPinSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string) => void;
  onUploadCloudChat?: (sessionId: string) => void;
  onRemoveProject?: (project: { path: string; label: string }) => void;
  projectSettings?: SidebarProjectSettings;
  onToggleChatsCollapsed?: () => void;
  onToggleSidebar: () => void;
}) {
  // CLI sessions belong to the terminal surface. Explicitly imported projects
  // remain navigable even when their original folder is temporary.
  const sidebarSessions = sessions.filter(
    (session) =>
      session.origin !== "cli" &&
      (session.importSource ||
        !isTransientWorkspacePath(session.workspacePath)),
  );
  const pinnedSessions = sidebarSessions.filter((session) =>
    pinnedSessionIds.includes(session.id),
  );
  // Placeholder shells stay hidden until activity, including open chats.
  const recentSessions = sidebarSessions.filter((session) => {
    if (pinnedSessionIds.includes(session.id)) {
      return false;
    }
    return sessionHasStartedForSidebar(session);
  });
  const projectSessions = recentSessions.filter((session) =>
    isUserSelectedWorkspacePath(session.workspacePath),
  );
  const unprojectedRecentSessions = recentSessions
    .filter((session) => !isUserSelectedWorkspacePath(session.workspacePath))
    .sort(
      (first, second) =>
        new Date(second.updatedAt).getTime() -
        new Date(first.updatedAt).getTime(),
    );
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string>();
  // Deleting a chat is two steps on the sidebar: a row menu's Delete opens
  // this candidate, and the confirm overlay performs the removal.
  const [sessionDeleteCandidate, setSessionDeleteCandidate] = useState<{
    id: string;
    label: string;
  }>();
  const [draggedSessionId, setDraggedSessionId] = useState<string>();
  const sidebarDragId = useRef<number>();
  useEffect(() => {
    const unsubscribe = subscribeChatDrag((drag) => {
      if (drag?.kind === "session") {
        setDraggedSessionId(drag.sessionId);
        if (drag.inputMode === "pointer") sidebarDragId.current = drag.dragId;
      } else {
        setDraggedSessionId(undefined);
      }
    });
    return () => {
      unsubscribe();
      if (sidebarDragId.current !== undefined)
        endChatDrag(sidebarDragId.current);
    };
  }, []);
  useEffect(() => {
    const drag = currentChatDrag();
    if (
      drag?.kind === "session" &&
      drag.dragId === sidebarDragId.current &&
      !sessions.some((session) => session.id === drag.sessionId)
    ) {
      endChatDrag(drag.dragId);
    }
  }, [sessions]);
  const [newSessionMenuView, setNewSessionMenuView] = useState<
    "closed" | "root" | "more"
  >("closed");
  const readyCommandProfiles = commandProfiles.filter(
    (profile) => profile.readiness !== "blocked",
  );
  const blockedCommandProfiles = commandProfiles.filter(
    (profile) => profile.readiness === "blocked",
  );
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
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>(
    loadCollapsedSidebarProjectIds,
  );
  const [projectVisibleCounts, setProjectVisibleCounts] = useState<
    Record<string, number>
  >({});
  const discoveredSessionNavigation = useMemo(
    () =>
      sidebarProjectGroups(
        projectSessions,
        savedProjects,
        workspacePath,
        draftChats,
      ),
    [draftChats, projectSessions, savedProjects, workspacePath],
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
  )
    .map((project) => ({
      ...project,
      label: projectSettings?.details[project.key]?.name || project.label,
    }))
    .sort(
      (a, b) =>
        Number(projectSettings?.details[b.key]?.pinned ?? false) -
        Number(projectSettings?.details[a.key]?.pinned ?? false),
    );
  const draftsByProjectKey = new Map<string, SidebarDraftChat[]>();
  const unprojectedDraftChats: SidebarDraftChat[] = [];
  for (const draft of draftChats) {
    // Empty draft panes remain available in the grid, but are not chats yet.
    if (!draftHasStartedForSidebar(draft)) continue;
    if (!isUserSelectedWorkspacePath(draft.workspacePath)) {
      unprojectedDraftChats.push(draft);
      continue;
    }
    const key = sidebarDraftGroupKey(
      draft.workspacePath,
      workspacePath,
      savedProjects,
    );
    const list = draftsByProjectKey.get(key) ?? [];
    list.push(draft);
    draftsByProjectKey.set(key, list);
  }
  const renderDraftRow = (draft: SidebarDraftChat, isNested = false) => (
    <DraftSidebarRow
      isActive={draft.id === activeDraftId}
      isNested={isNested}
      key={draft.id}
      onSelect={() => onSelectDraftChat?.(draft.id)}
      title={draft.title.trim() || "New chat"}
    />
  );
  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_PROJECT_COLLAPSE_STORAGE_KEY,
        JSON.stringify(collapsedProjectIds),
      );
    } catch {
      // The current sidebar state still works if local storage is unavailable.
    }
  }, [collapsedProjectIds]);
  const [expandedWorkspaceDirectories, setExpandedWorkspaceDirectories] =
    useState<Set<string>>(() => new Set());
  useEffect(() => {
    onExpandedWorkspaceDirectoriesChange?.([...expandedWorkspaceDirectories]);
  }, [expandedWorkspaceDirectories, onExpandedWorkspaceDirectoriesChange]);
  const [selectedExplorerPath, setSelectedExplorerPath] = useState<string>();
  const [selectedExplorerPaths, setSelectedExplorerPaths] = useState<
    Set<string>
  >(() => new Set());
  const [explorerContextMenu, setExplorerContextMenu] = useState<{
    path: string;
    x: number;
    y: number;
  }>();
  const explorerDragPath = useRef<string | undefined>(undefined);
  const [explorerDropPath, setExplorerDropPath] = useState<string>();
  const explorerMoveRoots = useMemo(() => {
    const roots = new Set<string>();
    for (const file of files) {
      if (file.isWorkspaceRoot) roots.add(file.workspacePath ?? file.path);
      else if (file.workspacePath) roots.add(file.workspacePath);
    }
    if (roots.size === 0 && workspacePath) roots.add(workspacePath);
    return [...roots];
  }, [files, workspacePath]);
  const explorerContextMenuRef = useOutsidePointerDismiss<HTMLDivElement>(
    Boolean(explorerContextMenu),
    () => setExplorerContextMenu(undefined),
  );
  /* VS Code-style creation: the toolbar and the context menu open one row in
     the tree, and whatever is typed there names the new entry. The extension is
     part of the name, so "notes.txt" becomes a text file. */
  const [explorerDraft, setExplorerDraft] = useState<{
    kind: "file" | "directory";
    parentPath?: string;
    value: string;
    renamePath?: string;
  }>();
  const startExplorerDraft = (
    kind: "file" | "directory",
    parentPath?: string,
  ) => {
    setExplorerContextMenu(undefined);
    // No selection means the workspace root. The field is drawn under that
    // folder, so the parent has to be a real row rather than "somewhere".
    const rawParent = parentPath || workspacePath;
    const parent = rawParent
      ? normalizedWorkspaceFolderPath(rawParent)
      : undefined;
    if (parent) {
      setExpandedWorkspaceDirectories((current) =>
        current.has(parent) ? current : new Set(current).add(parent),
      );
    }
    setExplorerDraft({ kind, parentPath: parent, value: "" });
  };
  /* Rename seeds the same inline row with the current basename, the way the
     Explorer's create row already works. That keeps rename off window.prompt,
     which WKWebView answers with null, and off the absolute path: only the
     basename is editable and the entry keeps its folder. */
  const startExplorerRename = (path: string) => {
    setExplorerContextMenu(undefined);
    if (!path) return;
    // The root is the folder Gyro has open. Renaming it is refused later, so
    // the field would appear and then fail. Don't open it.
    if (files.some((file) => file.path === path && file.isWorkspaceRoot)) {
      return;
    }
    const separator = path.lastIndexOf("/");
    const parentPath = separator > 0 ? path.slice(0, separator) : undefined;
    if (parentPath) {
      setExpandedWorkspaceDirectories((current) =>
        current.has(parentPath) ? current : new Set(current).add(parentPath),
      );
    }
    setExplorerDraft({
      kind: "file",
      parentPath,
      value: path.slice(separator + 1),
      renamePath: path,
    });
  };
  const commitExplorerDraft = () => {
    const draft = explorerDraft;
    const name = draft?.value.trim().replace(/^\/+/, "");
    if (!draft || !name) {
      setExplorerDraft(undefined);
      return;
    }
    // A name that cannot be a single path segment is refused here rather than
    // sent to Rust; the inline row stays open so it can be corrected.
    if (validateWorkspaceEntryName(name)) return;
    setExplorerDraft(undefined);
    if (draft.renamePath) {
      const currentName = draft.renamePath.slice(
        draft.renamePath.lastIndexOf("/") + 1,
      );
      if (name === currentName) return;
      onRenameWorkspacePath?.(draft.renamePath, name);
      return;
    }
    const parentPath = draft.parentPath?.replace(/\/+$/, "");
    onCreateWorkspacePath?.(
      draft.kind,
      parentPath || undefined,
      parentPath ? `${parentPath}/${name}` : name,
    );
  };
  const selectedExplorerFile = files.find(
    (file) => file.path === selectedExplorerPath,
  );
  const [sourceControlMessage, setSourceControlMessage] = useState("");
  const scmTotals = sourceControlTotals(ide?.sourceControl);
  const scmHistoryMessage = sourceControlHistoryMessage(ide?.sourceControl);
  const [scmRepositoryHeight, setScmRepositoryHeight] = useState<number>();
  const [scmRepositoryMinHeight, setScmRepositoryMinHeight] = useState(180);
  const scmRepositoryContentRef = useRef<HTMLDivElement>(null);
  const scmRepositoryMeasuredHeight = useRef(180);
  useEffect(() => {
    const content = scmRepositoryContentRef.current;
    if (!content) return;
    const update = () => {
      const height = Math.ceil(content.getBoundingClientRect().height);
      const delta = height - scmRepositoryMeasuredHeight.current;
      scmRepositoryMeasuredHeight.current = height;
      setScmRepositoryMinHeight(height);
      // Keep the divider close when a conditional row (such as sync) vanishes.
      // Preserve only the additional space the user deliberately dragged open.
      if (delta !== 0)
        setScmRepositoryHeight((previous) =>
          previous === undefined
            ? previous
            : Math.max(height, previous + delta),
        );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(content);
    return () => observer.disconnect();
  });
  const [scmGithubHeight, setScmGithubHeight] = useState<number>();
  const [scmStagedHeight, setScmStagedHeight] = useState<number>();
  const [scmHistoryShare, setScmHistoryShare] = useState<number>();
  const [scmHistoryOpen, setScmHistoryOpen] = useState(() => {
    try {
      return (
        window.localStorage.getItem(SCM_HISTORY_OPEN_STORAGE_KEY) !== "false"
      );
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        SCM_HISTORY_OPEN_STORAGE_KEY,
        String(scmHistoryOpen),
      );
    } catch {
      // History still remembers its state during navigation without storage.
    }
  }, [scmHistoryOpen]);
  const scmHistoryDrag = useRef<{ y: number; share: number; height: number }>();
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
  // VS Code's source control panel keeps one primary button: it commits while
  // there is something to commit, and once the tree is clean it turns into the
  // press that moves that history — pull first when the branch is behind,
  // otherwise push, or publish a branch the remote has never seen.
  const hasSourceControlChanges =
    stagedSourceControlFiles.length > 0 ||
    unstagedSourceControlFiles.length > 0;
  const sourceControlAhead = ide?.sourceControl.ahead ?? 0;
  const sourceControlBehind = ide?.sourceControl.behind ?? 0;
  const sourceControlPublished = Boolean(ide?.sourceControl.upstream);
  const sourceControlSyncAction: "pull" | "push" | "publish" | undefined =
    ide?.sourceControl.available !== true
      ? undefined
      : !sourceControlPublished
        ? "publish"
        : sourceControlBehind > 0
          ? "pull"
          : sourceControlAhead > 0
            ? "push"
            : undefined;
  const showSourceControlSyncButton =
    !hasSourceControlChanges && Boolean(sourceControlSyncAction);
  // The button carries both counts, so a branch that is behind still says how
  // much is waiting to go out once the pull lands.
  const sourceControlSyncCounts = sourceControlPublished
    ? scmSyncCountLabel(sourceControlAhead, sourceControlBehind)
    : "";

  const sourceControlHistory = ide?.sourceControl.history;
  const scmHistoryGraph = useMemo(
    () => scmGraphRows(sourceControlHistory ?? []),
    [sourceControlHistory],
  );
  // The rail is only as wide as the branches actually in view, so a plain
  // linear history does not pay for lanes it never uses.
  const scmHistoryRailWidth = useMemo(
    () =>
      scmGraphLaneOffset(
        scmHistoryGraph.reduce(
          (widest, row) =>
            Math.max(
              widest,
              row.lane,
              ...row.edges.flatMap((edge) => [edge.from, edge.to]),
            ),
          0,
        ),
      ) + SCM_GRAPH_LANE_INSET,
    [scmHistoryGraph],
  );

  const [debugAdapterCommand, setDebugAdapterCommand] = useState("lldb-dap");
  const [isAddingRunCommand, setIsAddingRunCommand] = useState(false);
  const [runCommandDraft, setRunCommandDraft] = useState("");
  const [runCommandLabelDraft, setRunCommandLabelDraft] = useState("");
  const [runCommandGroupDraft, setRunCommandGroupDraft] =
    useState<TaskDefinition["group"]>("custom");
  const [runCommandFilter, setRunCommandFilter] = useState("");
  const matchedRunPackage = useMemo(
    () =>
      matchingRunPackage(
        ide?.taskDefinitions ?? [],
        ide?.activePath,
        workspacePath,
      ),
    [ide?.activePath, ide?.taskDefinitions, workspacePath],
  );
  const [runScopeOverride, setRunScopeOverride] = useState<{
    packagePath: string;
    mode: "package" | "repo";
  } | null>(null);
  const runScopeMode =
    matchedRunPackage && runScopeOverride?.packagePath === matchedRunPackage
      ? runScopeOverride.mode
      : "package";
  const runScopePackage =
    matchedRunPackage && runScopeMode === "package"
      ? matchedRunPackage
      : undefined;
  const runTaskGroups = useMemo(
    () =>
      groupedRunTasks(
        ide?.taskDefinitions ?? [],
        runCommandFilter,
        runScopePackage,
      ),
    [ide?.taskDefinitions, runCommandFilter, runScopePackage],
  );
  const runToolchain = useMemo(
    () => runToolchainSummary(ide?.taskDefinitions ?? []),
    [ide?.taskDefinitions],
  );
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
  const workspaceSearchCallbackRef = useRef(onRunWorkspaceSearch);
  workspaceSearchCallbackRef.current = onRunWorkspaceSearch;
  const sidebarSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(() => {
    if (activeIdeView !== "search" || !sidebarSearchDraft.trim()) return;
    sidebarSearchTimerRef.current = setTimeout(() => {
      sidebarSearchTimerRef.current = null;
      const globs = workspaceSearchGlobs(
        sidebarSearchIncludeDraft,
        sidebarSearchExcludeDraft,
      );
      workspaceSearchCallbackRef.current?.({
        query: sidebarSearchDraft,
        globs: globs.length > 0 ? globs : undefined,
      });
    }, 250);
    return () => {
      if (sidebarSearchTimerRef.current !== null) {
        clearTimeout(sidebarSearchTimerRef.current);
        sidebarSearchTimerRef.current = null;
      }
    };
  }, [
    activeIdeView,
    sidebarSearchDraft,
    sidebarSearchIncludeDraft,
    sidebarSearchExcludeDraft,
    workspaceFileRootKey,
  ]);
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
  const isCliSidebar =
    activeDestination === "workspace" &&
    activeWorkspaceLayout === "terminal-grid";
  const isIdeSidebar =
    activeDestination === "workspace" && activeWorkspaceLayout === "code";
  // Secondary pages retain chat navigation, even when opened from the IDE.
  const isSessionsSidebar = !isIdeSidebar;
  const toggleProject = (projectKey: string) => {
    setCollapsedProjectIds((current) =>
      current.includes(projectKey)
        ? current.filter((id) => id !== projectKey)
        : [...current, projectKey],
    );
  };
  const showMoreProjectSessions = (projectKey: string, totalCount: number) => {
    setProjectVisibleCounts((current) => {
      const visibleCount =
        current[projectKey] ?? SIDEBAR_INITIAL_PROJECT_SESSION_COUNT;
      return {
        ...current,
        [projectKey]: Math.min(
          totalCount,
          visibleCount + SIDEBAR_PROJECT_SESSION_BATCH_SIZE,
        ),
      };
    });
  };
  const [recentsVisibleCount, setRecentsVisibleCount] = useState(
    SIDEBAR_INITIAL_RECENT_SESSION_COUNT,
  );
  const recentsHaveRevealedMore =
    recentsVisibleCount > SIDEBAR_INITIAL_RECENT_SESSION_COUNT;
  const firstRecentSessions = unprojectedRecentSessions.slice(
    0,
    recentsVisibleCount,
  );
  const activeRecentSession = unprojectedRecentSessions.find(
    (session) => session.id === activeSessionId,
  );
  // The open chat stays listed even when it falls past the visible count.
  const visibleRecentSessions =
    activeRecentSession && !firstRecentSessions.includes(activeRecentSession)
      ? [
          ...firstRecentSessions.slice(0, Math.max(0, recentsVisibleCount - 1)),
          activeRecentSession,
        ]
      : firstRecentSessions;
  const hiddenRecentCount =
    unprojectedRecentSessions.length - visibleRecentSessions.length;
  const showLessProjectSessions = (projectKey: string) => {
    setProjectVisibleCounts((current) => {
      const next = { ...current };
      delete next[projectKey];
      return next;
    });
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
    } else if (event.key === "F2") {
      event.preventDefault();
      startExplorerRename(file.path);
    } else if (
      (event.key === "Delete" || event.key === "Backspace") &&
      !event.metaKey &&
      !event.altKey &&
      !event.ctrlKey
    ) {
      event.preventDefault();
      if (file.isWorkspaceRoot) {
        onRemoveWorkspaceFolder?.(file.workspacePath ?? file.path);
      } else {
        onDeleteWorkspacePath?.(file.path);
      }
    }
  };
  const explorerCreateParent = () => {
    const selected = files.find((file) => file.path === selectedExplorerPath);
    if (!selected) return undefined;
    if (selected.kind === "directory") return selected.path;
    const separator = selected.path.lastIndexOf("/");
    return separator > 0 ? selected.path.slice(0, separator) : undefined;
  };
  const renderSessionRow = (session: Session, isNested = false) => (
    <SessionSidebarRow
      isActive={session.id === activeSessionId}
      isSending={sendingSessionIds.includes(session.id)}
      isUnreadComplete={completedSessionIds.includes(session.id)}
      approvalCount={approvalCountsBySessionId[session.id] ?? 0}
      questionCount={questionCountsBySessionId[session.id] ?? 0}
      isNested={isNested}
      isMenuOpen={openSessionMenuId === session.id}
      isPinned={pinnedSessionIds.includes(session.id)}
      isOpen={openChatSessionIds.includes(session.id)}
      isDragging={draggedSessionId === session.id}
      key={session.id}
      onDelete={() => {
        setSessionDeleteCandidate({
          id: session.id,
          label: session.title?.trim() || "This chat",
        });
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
      onUploadCloudChat={
        onUploadCloudChat
          ? () => {
              onUploadCloudChat(session.id);
              setOpenSessionMenuId(undefined);
            }
          : undefined
      }
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
        const payload = {
          sessionId: session.id,
          projectKey: normalizeSidebarPath(session.workspacePath),
        };
        sidebarDragId.current = beginChatSessionDrag(
          payload,
          event.dataTransfer,
        )?.dragId;
        // Chat IDs are internal data, never text to insert into a composer.
        guardChatDragsOutsideGrid();
        setDraggedSessionId(session.id);
      }}
      onPointerDown={(event) => {
        if (
          !(event.target instanceof Element) ||
          !event.target.closest(".gyro-sidebar-thread-main")
        )
          return;
        startChatPointerDrag(event.nativeEvent, event.currentTarget, {
          kind: "session",
          sessionId: session.id,
          projectKey: normalizeSidebarPath(session.workspacePath),
        });
      }}
      onDragEnd={() => {
        // The lifecycle checks the native event token before clearing state.
        // A late dragend from an older source must leave the new drag alone.
        if (!currentChatDrag()) setDraggedSessionId(undefined);
      }}
      session={session}
    />
  );

  return (
    <>
      {sessionDeleteCandidate
        ? createPortal(
            <SessionDeleteConfirmOverlay
              chatLabel={sessionDeleteCandidate.label}
              isWorking={sendingSessionIds.includes(sessionDeleteCandidate.id)}
              onCancel={() => setSessionDeleteCandidate(undefined)}
              onDelete={() => {
                const candidate = sessionDeleteCandidate;
                setSessionDeleteCandidate(undefined);
                onDeleteSession?.(candidate.id);
              }}
            />,
            document.body,
          )
        : null}
      <div className="gyro-sidebar-persistent-header">
        <div className="gyro-sidebar-windowbar" aria-label="Window navigation">
          {/* Both surfaces carry the toggle in the same slot, so the surface
              switch never moves out from under the pointer that clicked it. */}
          <div className="gyro-sidebar-window-actions">
            <button
              aria-label="Hide sidebar"
              title="Hide sidebar"
              className="gyro-sidebar-toggle-button"
              onClick={onToggleSidebar}
              type="button"
            >
              <PanelLeft size={16} strokeWidth={1.5} />
            </button>
          </div>
          <PrimarySurfaceSwitch
            isIdeSidebar={isIdeSidebar}
            onSelectSessions={onSelectSessions}
            onSelectWorkspace={() => onSelectWorkspaceLayout("code")}
          />
          <div
            aria-hidden="true"
            className="gyro-sidebar-titlebar-drag-region"
            data-tauri-drag-region
          />
        </div>
      </div>

      {isIdeSidebar ? (
        <>
          {!workspacePath ? (
            <SidebarSection grow title="Workspace">
              <div className="gyro-sidebar-mini-copy">
                Open a project to see its files, search, and changes here.
              </div>
            </SidebarSection>
          ) : null}

          {workspacePath && activeIdeView === "explorer" ? (
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
                      onClick={() =>
                        startExplorerDraft("file", explorerCreateParent())
                      }
                      title="New file"
                      type="button"
                    >
                      <FileText size={13} />
                      <Plus size={9} />
                    </button>
                    <button
                      aria-label="New folder"
                      onClick={() =>
                        startExplorerDraft("directory", explorerCreateParent())
                      }
                      title="New folder"
                      type="button"
                    >
                      <Folder size={13} />
                      <Plus size={9} />
                    </button>
                    <button
                      aria-label="Rename selected path"
                      disabled={
                        (!selectedExplorerPath && !ide?.activePath) ||
                        Boolean(selectedExplorerFile?.isWorkspaceRoot)
                      }
                      onClick={() =>
                        startExplorerRename(
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
                  <WorkspaceRootIssues model={workspaceRootIssues} />
                  {files.some((file) => file.isWorkspaceRoot) ? null : (
                    <SidebarProjectRow
                      icon={Folder}
                      label={workspaceName(workspacePath)}
                      meta="workspace"
                      onClick={onOpenWorkspace}
                    />
                  )}
                  {visibleFiles.length > 0 || explorerDraft ? (
                    <div
                      aria-label="Workspace files"
                      className="gyro-sidebar-explorer-tree"
                      onKeyDown={handleExplorerKeyDown}
                      ref={explorerTreeRef}
                      role="tree"
                    >
                      {visibleFiles.flatMap((file, index) => {
                        const decoration = ide?.fileDecorations.find(
                          (item) => item.path === file.path,
                        );
                        const rootGroup = explorerRootGroupForFile(file);
                        let previousRootGroup: typeof rootGroup;
                        if (rootGroup) {
                          for (let prior = index - 1; prior >= 0; prior -= 1) {
                            const candidate = visibleFiles[prior];
                            if (candidate?.workspacePath !== file.workspacePath)
                              break;
                            previousRootGroup =
                              explorerRootGroupForFile(candidate);
                            if (previousRootGroup) break;
                          }
                        }
                        if (explorerDraft?.renamePath === file.path) {
                          return (
                            <ExplorerDraftRow
                              depth={file.depth}
                              draft={{
                                ...explorerDraft,
                                kind:
                                  file.kind === "directory"
                                    ? "directory"
                                    : "file",
                              }}
                              key={`rename:${file.path}`}
                              onCancel={() => setExplorerDraft(undefined)}
                              onChange={(value) =>
                                setExplorerDraft((current) =>
                                  current ? { ...current, value } : current,
                                )
                              }
                              onCommit={commitExplorerDraft}
                            />
                          );
                        }
                        const row = (
                          <WorkspaceExplorerRow
                            collapsed={
                              !expandedWorkspaceDirectories.has(file.path)
                            }
                            decoration={decoration}
                            depth={
                              file.depth ?? file.path.split(/[\\/]/).length
                            }
                            bufferStatus={ide?.buffers[file.path]?.status}
                            draggable={!file.isWorkspaceRoot}
                            isDropTarget={explorerDropPath === file.path}
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
                            rootGroup={rootGroup}
                            startsRootGroup={
                              rootGroup !== undefined &&
                              rootGroup !== "project" &&
                              rootGroup !== previousRootGroup
                            }
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
                            onDragStart={(event) => {
                              if (file.isWorkspaceRoot) {
                                event.preventDefault();
                                return;
                              }
                              explorerDragPath.current = file.path;
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData(
                                EXPLORER_PATH_DRAG_MIME,
                                file.path,
                              );
                              event.dataTransfer.setData(
                                "text/plain",
                                file.path,
                              );
                            }}
                            onDragEnd={() => {
                              explorerDragPath.current = undefined;
                              setExplorerDropPath(undefined);
                            }}
                            onDragOver={(event) => {
                              if (file.kind !== "directory") return;
                              const from = explorerDragPath.current;
                              const types = Array.from(
                                event.dataTransfer.types,
                              );
                              if (
                                !from &&
                                !types.includes(EXPLORER_PATH_DRAG_MIME)
                              ) {
                                return;
                              }
                              // Highlight only a destination planWorkspaceMove
                              // will accept. Another workspace root must not
                              // look like a valid target.
                              if (
                                from &&
                                planWorkspaceMove(
                                  explorerMoveRoots,
                                  from,
                                  file.path,
                                ).kind !== "move"
                              ) {
                                return;
                              }
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              setExplorerDropPath((current) =>
                                current === file.path ? current : file.path,
                              );
                            }}
                            onDragLeave={(event) => {
                              const next = event.relatedTarget;
                              if (
                                next instanceof Node &&
                                event.currentTarget.contains(next)
                              ) {
                                return;
                              }
                              setExplorerDropPath((current) =>
                                current === file.path ? undefined : current,
                              );
                            }}
                            onDrop={(event) => {
                              if (file.kind !== "directory") return;
                              const from =
                                event.dataTransfer.getData(
                                  EXPLORER_PATH_DRAG_MIME,
                                ) ||
                                explorerDragPath.current ||
                                "";
                              explorerDragPath.current = undefined;
                              setExplorerDropPath(undefined);
                              if (!from) return;
                              event.preventDefault();
                              event.stopPropagation();
                              if (
                                planWorkspaceMove(
                                  explorerMoveRoots,
                                  from,
                                  file.path,
                                ).kind !== "move"
                              ) {
                                return;
                              }
                              onMoveWorkspacePath?.(from, file.path);
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
                        // The new name sits under the folder it will belong to.
                        // A field at the bottom of the tree looks like a no-op
                        // in a long project.
                        if (
                          explorerDraft &&
                          !explorerDraft.renamePath &&
                          explorerDraft.parentPath === file.path
                        ) {
                          return [
                            row,
                            <ExplorerDraftRow
                              depth={(file.depth ?? 0) + 1}
                              draft={explorerDraft}
                              key="create-explorer-entry"
                              onCancel={() => setExplorerDraft(undefined)}
                              onChange={(value) =>
                                setExplorerDraft((current) =>
                                  current ? { ...current, value } : current,
                                )
                              }
                              onCommit={commitExplorerDraft}
                            />,
                          ];
                        }
                        return row;
                      })}
                      {/* Rename replaces its own row above. A second field here
                          autofocuses, blurs that row, and the unchanged name
                          commits the rename shut before it can be typed. */}
                      {explorerDraft &&
                      !(explorerDraft.renamePath
                        ? visibleFiles.some(
                            (file) => file.path === explorerDraft.renamePath,
                          )
                        : visibleFiles.some(
                            (file) => file.path === explorerDraft.parentPath,
                          )) ? (
                        <ExplorerDraftRow
                          draft={explorerDraft}
                          key="create-explorer-entry"
                          onCancel={() => setExplorerDraft(undefined)}
                          onChange={(value) =>
                            setExplorerDraft((current) =>
                              current ? { ...current, value } : current,
                            )
                          }
                          onCommit={commitExplorerDraft}
                        />
                      ) : null}
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
                        startExplorerDraft("file", file?.path);
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
                  {files.find((item) => item.path === explorerContextMenu.path)
                    ?.kind === "directory" ? (
                    <button
                      onClick={() =>
                        startExplorerDraft(
                          "directory",
                          explorerContextMenu.path,
                        )
                      }
                      role="menuitem"
                      type="button"
                    >
                      New Folder
                    </button>
                  ) : null}
                  <button
                    onClick={() =>
                      startExplorerRename(explorerContextMenu.path)
                    }
                    role="menuitem"
                    type="button"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => {
                      const target = explorerContextMenu.path;
                      setExplorerContextMenu(undefined);
                      onDuplicateWorkspacePath?.(target);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Duplicate
                  </button>
                  {files.find((item) => item.path === explorerContextMenu.path)
                    ?.isWorkspaceRoot ? null : (
                    <button
                      onClick={() => {
                        const target = explorerContextMenu.path;
                        const separator = target.lastIndexOf("/");
                        const parent =
                          separator > 0 ? target.slice(0, separator) : target;
                        setExplorerContextMenu(undefined);
                        void askTextValue({
                          title: "Move",
                          label: "Destination folder",
                          message:
                            "The file keeps its name. Leave the destination inside this workspace folder.",
                          initialValue: parent,
                          confirmLabel: "Move",
                        }).then((destination) => {
                          if (!destination) return;
                          onMoveWorkspacePath?.(target, destination);
                        });
                      }}
                      role="menuitem"
                      type="button"
                    >
                      Move…
                    </button>
                  )}
                  <button
                    onClick={() => {
                      const target = explorerContextMenu.path;
                      setExplorerContextMenu(undefined);
                      // Return must not send the current draft while the
                      // folder listing is still being attached. Focus only
                      // after that attachment is in the composer.
                      setExplorerAskSendHeld(true);
                      void Promise.resolve(onAskWorkspacePath?.(target))
                        .then((attached) => {
                          if (attached === false) return;
                          window.dispatchEvent(
                            new Event("gyro-focus-composer"),
                          );
                        })
                        .finally(() => {
                          setExplorerAskSendHeld(false);
                        });
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Ask Gyro
                  </button>
                  <button
                    onClick={() => {
                      const target = explorerContextMenu.path;
                      const entry = files.find((file) => file.path === target);
                      setExplorerContextMenu(undefined);
                      writeClipboardText(
                        entry ? workspaceCopyAbsolutePath(entry) : target,
                      );
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Copy Path
                  </button>
                  <button
                    onClick={() => {
                      const target = explorerContextMenu.path;
                      const entry = files.find((file) => file.path === target);
                      setExplorerContextMenu(undefined);
                      writeClipboardText(
                        entry ? workspaceCopyRelativePath(entry) : target,
                      );
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Copy Relative Path
                  </button>
                  <button
                    onClick={() => {
                      const target = explorerContextMenu.path;
                      setExplorerContextMenu(undefined);
                      onRevealWorkspacePath?.(target);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Reveal in Finder
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

          {workspacePath && activeIdeView === "search" ? (
            <SidebarSection
              grow
              meta={String(ide?.searchResults.length ?? 0)}
              title="Search"
            >
              <form
                className="gyro-sidebar-search-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (sidebarSearchTimerRef.current !== null) {
                    clearTimeout(sidebarSearchTimerRef.current);
                    sidebarSearchTimerRef.current = null;
                  }
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
                <WorkspaceSearchResults
                  results={ide?.searchResults ?? []}
                  query={ide?.searchQuery.query ?? ""}
                  activePath={ide?.activePath}
                  replaceOpen={sidebarReplaceOpen}
                  selectedPaths={selectedReplacePaths}
                  onToggleReplacePath={(path) =>
                    setSelectedReplacePaths((current) => {
                      const next = new Set(current);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return next;
                    })
                  }
                  onOpenFile={onOpenWorkspaceFile}
                />
              ) : (
                <div className="gyro-sidebar-mini-copy">
                  {sidebarSearchDraft.trim()
                    ? "No matches found."
                    : "Type to search file contents in this workspace."}
                </div>
              )}
            </SidebarSection>
          ) : null}

          {workspacePath && activeIdeView === "source-control" ? (
            <SidebarSection
              grow
              title="Source control"
              headerActions={
                ide?.sourceControl.available ? (
                  scmTotals.kind === "branch" ||
                  scmTotals.kind === "working-tree" ? (
                    <span
                      className="gyro-scm-heading-totals"
                      title={sourceControlTotalsScope(scmTotals)}
                      aria-label={`${sourceControlTotalsScope(scmTotals)}: ${scmTotals.additions.toLocaleString()} additions, ${scmTotals.deletions.toLocaleString()} deletions`}
                    >
                      <span className="is-added">
                        +{scmTotals.additions.toLocaleString()}
                      </span>
                      <span className="is-removed">
                        −{scmTotals.deletions.toLocaleString()}
                      </span>
                      {scmTotals.kind === "working-tree" ? (
                        <small>{sourceControlTotalsBadge(scmTotals)}</small>
                      ) : null}
                    </span>
                  ) : (
                    <span
                      className="gyro-scm-heading-unavailable"
                      title={sourceControlTotalsScope(scmTotals)}
                    >
                      {sourceControlTotalsLabel(scmTotals)}
                    </span>
                  )
                ) : undefined
              }
            >
              <div className="gyro-scm-panel">
                {onReviewWithAgent ? (
                  <button
                    className="gyro-sidebar-action"
                    type="button"
                    aria-label="Get a second opinion on uncommitted changes"
                    title="Get a second opinion on changes in this project"
                    onClick={onReviewWithAgent}
                  >
                    <GitPullRequest size={14} />
                    <span>Get a second opinion</span>
                  </button>
                ) : null}
                <div
                  className="gyro-scm-repository-section"
                  style={{
                    height: scmRepositoryHeight,
                    minHeight: scmRepositoryMinHeight,
                  }}
                >
                  <div
                    ref={scmRepositoryContentRef}
                    style={{ display: "flow-root" }}
                  >
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
                          aria-label="Refresh source control and check GitHub"
                          disabled={isRemoteChecking}
                          onClick={() => {
                            onRefreshSourceControl?.();
                            onCheckRemote?.();
                          }}
                          title="Refresh and check GitHub"
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
                        {showSourceControlSyncButton ? (
                          <button
                            disabled={
                              isSourceControlSyncing || isRemoteChecking
                            }
                            onClick={
                              sourceControlSyncAction === "pull"
                                ? onPullSourceControl
                                : onPushSourceControl
                            }
                            type="button"
                            title={
                              sourceControlSyncAction === "pull"
                                ? `Pull ${sourceControlBehind} from ${ide?.sourceControl.upstream}`
                                : sourceControlSyncAction === "push"
                                  ? `Push to ${ide?.sourceControl.upstream}`
                                  : "Push this branch to the remote and track it"
                            }
                          >
                            {sourceControlSyncAction === "pull" ? (
                              <ArrowDown size={13} />
                            ) : (
                              <ArrowUp size={13} />
                            )}
                            {isSourceControlSyncing
                              ? "Working…"
                              : sourceControlSyncAction === "pull"
                                ? "Pull"
                                : sourceControlSyncAction === "push"
                                  ? "Push"
                                  : "Publish branch"}
                            {!isSourceControlSyncing &&
                            sourceControlSyncCounts ? (
                              <span className="gyro-scm-sync-count">
                                {sourceControlSyncCounts}
                              </span>
                            ) : null}
                          </button>
                        ) : !hasSourceControlChanges &&
                          sourceControlPublished &&
                          ide?.sourceControl.available === true ? (
                          <button
                            disabled={
                              isRemoteChecking || isSourceControlSyncing
                            }
                            onClick={onCheckRemote}
                            title="Check the tracked GitHub branch for new commits"
                            type="button"
                          >
                            <RefreshCw size={13} />
                            {isRemoteChecking ? "Checking…" : "Check GitHub"}
                          </button>
                        ) : (
                          <button
                            disabled={
                              !sourceControlMessage.trim() ||
                              !hasSourceControlChanges
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
                        )}
                      </div>
                    </form>
                    <ScmSyncRow
                      ahead={sourceControlAhead}
                      behind={sourceControlBehind}
                      hasRemote={ide?.sourceControl.available === true}
                      hasPendingChanges={hasSourceControlChanges}
                      onPull={onPullSourceControl}
                      onPush={onPushSourceControl}
                      syncing={isSourceControlSyncing || isRemoteChecking}
                      upstream={ide?.sourceControl.upstream}
                    />
                    {remoteCheckMessage && ide?.sourceControl.available ? (
                      <div
                        className={`gyro-sidebar-mini-copy${remoteCheckFailed ? " is-error" : ""}`}
                        role={remoteCheckFailed ? "alert" : "status"}
                      >
                        {remoteCheckMessage}
                      </div>
                    ) : null}
                    {gitSetupMessage(ide?.sourceControl.readState) ? (
                      <div className="gyro-sidebar-mini-copy" role="status">
                        {gitSetupMessage(ide?.sourceControl.readState)}
                      </div>
                    ) : ide?.sourceControl.error ? (
                      <div className="gyro-sidebar-mini-copy is-error" role="status">
                        Couldn’t refresh Git status.
                        {ide.sourceControl.stale ? " Showing last-known changes." : ""}
                        <details>
                          <summary>Details</summary>
                          {ide.sourceControl.error}
                        </details>
                      </div>
                    ) : ide?.sourceControl.available === false ? (
                      <div className="gyro-sidebar-mini-copy" role="status">
                        Git status is unavailable. Refresh to try again.
                      </div>
                    ) : null}
                  </div>
                </div>
                <ScmSectionDivider
                  label="Resize repository section"
                  target="previous"
                  onResize={setScmRepositoryHeight}
                />
                <div
                  className="gyro-scm-change-list"
                  style={
                    scmHistoryShare === undefined
                      ? { flex: "0 1 auto" }
                      : { flex: `${100 - scmHistoryShare} 1 0px` }
                  }
                >
                  {stagedSourceControlFiles.length > 0 ? (
                    <div
                      className="gyro-scm-staged-section"
                      style={{
                        height: collapsedScmGroups.has("staged")
                          ? undefined
                          : scmStagedHeight,
                      }}
                    >
                      <ScmChangeGroup
                        activeDiff={
                          ide?.tabs.find((tab) => tab.path === ide.activePath)
                            ?.sourceControlDiff
                        }
                        actions={
                          <button
                            aria-label="Unstage all staged changes"
                            onClick={async () => {
                              for (const file of stagedSourceControlFiles) {
                                await onToggleSourceControlFile?.(
                                  file.path,
                                  true,
                                );
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
                    </div>
                  ) : null}
                  {stagedSourceControlFiles.length > 0 &&
                  !collapsedScmGroups.has("staged") ? (
                    <ScmSectionDivider
                      label="Resize staged changes"
                      target="previous"
                      onResize={setScmStagedHeight}
                    />
                  ) : null}
                  <ScmChangeGroup
                    activeDiff={
                      ide?.tabs.find((tab) => tab.path === ide.activePath)
                        ?.sourceControlDiff
                    }
                    actions={
                      <>
                        <button
                          aria-label="Stage all changes"
                          title="Stage all changes"
                          disabled={!unstagedSourceControlFiles.length}
                          onClick={() => void onStageAllSourceControl?.()}
                          type="button"
                        >
                          <Plus size={13} />
                        </button>
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
                        {selectedSourceControlPaths.size > 0 ? (
                          <>
                            <button
                              aria-label="Stage selected source control changes"
                              onClick={async () => {
                                const selected =
                                  unstagedSourceControlFiles.filter((file) =>
                                    selectedSourceControlPaths.has(file.path),
                                  );
                                for (const file of selected) {
                                  await onToggleSourceControlFile?.(
                                    file.path,
                                    false,
                                  );
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
                              onClick={async () => {
                                if (
                                  !(await confirmAction(
                                    `Discard changes in ${selectedSourceControlPaths.size} selected files? This cannot be undone.`,
                                  ))
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
                        ) : null}
                      </>
                    }
                    className="is-changes"
                    collapsed={collapsedScmGroups.has("changes")}
                    emptyCopy={
                      ide?.sourceControl.available !== true || ide.sourceControl.stale || ide.sourceControl.error
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
                    title="Uncommitted changes"
                  />
                </div>
                <div
                  className="gyro-scm-history-resizer"
                  role="separator"
                  aria-label="Resize changes and history"
                  aria-orientation="horizontal"
                  aria-valuemin={15}
                  aria-valuemax={85}
                  aria-valuenow={Math.round(scmHistoryShare ?? 40)}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (
                      !["ArrowUp", "ArrowDown", "Home", "End"].includes(
                        event.key,
                      )
                    )
                      return;
                    event.preventDefault();
                    setScmHistoryShare((share) => {
                      const current = share ?? 40;
                      return event.key === "Home"
                        ? 15
                        : event.key === "End"
                          ? 85
                          : Math.max(
                              15,
                              Math.min(
                                85,
                                current + (event.key === "ArrowUp" ? 5 : -5),
                              ),
                            );
                    });
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    const divider = event.currentTarget;
                    const changes = divider.previousElementSibling;
                    const history = divider.nextElementSibling;
                    if (!changes || !history) return;
                    event.preventDefault();
                    const height =
                      changes.getBoundingClientRect().height +
                      history.getBoundingClientRect().height;
                    if (height <= 0) return;
                    scmHistoryDrag.current = {
                      y: event.clientY,
                      share:
                        (history.getBoundingClientRect().height / height) * 100,
                      height,
                    };
                    divider.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    const drag = scmHistoryDrag.current;
                    if (!drag) return;
                    setScmHistoryShare(
                      Math.max(
                        15,
                        Math.min(
                          85,
                          drag.share -
                            ((event.clientY - drag.y) / drag.height) * 100,
                        ),
                      ),
                    );
                  }}
                  onPointerUp={(event) => {
                    scmHistoryDrag.current = undefined;
                    if (
                      event.currentTarget.hasPointerCapture(event.pointerId)
                    ) {
                      event.currentTarget.releasePointerCapture(
                        event.pointerId,
                      );
                    }
                  }}
                  onPointerCancel={() => {
                    scmHistoryDrag.current = undefined;
                  }}
                  onLostPointerCapture={() => {
                    scmHistoryDrag.current = undefined;
                  }}
                />
                <details
                  className="gyro-scm-history"
                  style={
                    scmHistoryShare === undefined
                      ? { flex: "1 1 auto", minHeight: 0 }
                      : { flexGrow: scmHistoryShare, flexBasis: 0 }
                  }
                  open={scmHistoryOpen}
                  onToggle={(event) =>
                    setScmHistoryOpen(event.currentTarget.open)
                  }
                >
                  <summary>
                    <ChevronRight size={12} aria-hidden="true" />
                    <span>History</span>
                    {ide?.sourceControl.history?.length ? (
                      <small>{ide.sourceControl.history.length}</small>
                    ) : null}
                  </summary>
                  <div className="gyro-scm-history-list">
                    {scmHistoryMessage ? (
                      <p className="gyro-sidebar-mini-copy">
                        {scmHistoryMessage}
                      </p>
                    ) : (
                      ide?.sourceControl.history?.map((commit, index) => {
                        const row = scmHistoryGraph[index];
                        const refs = commit.refs
                          ? scmCommitRefs(commit.refs)
                          : [];
                        const isHead = refs.some((ref) => ref.kind === "head");
                        return (
                          <ScmCommitHover
                            commit={commit}
                            color={scmGraphLaneColor(row?.lane ?? 0)}
                            className={[
                              "gyro-scm-history-entry",
                              isHead ? "is-head" : "",
                              row?.isMerge ? "is-merge" : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            key={commit.hash}
                            style={
                              {
                                "--gyro-scm-graph-width": `${scmHistoryRailWidth}px`,
                              } as CSSProperties
                            }
                          >
                            <span
                              aria-hidden="true"
                              className="gyro-scm-graph-rail"
                            >
                              <svg
                                className="gyro-scm-graph-lines"
                                viewBox={`0 0 ${scmHistoryRailWidth} 24`}
                                preserveAspectRatio="none"
                              >
                                {(row?.edges ?? []).map((edge, edgeIndex) => {
                                  const from = scmGraphLaneOffset(edge.from);
                                  const to = scmGraphLaneOffset(edge.to);
                                  const top = edge.half === "top" ? 0 : 12;
                                  return (
                                    <path
                                      key={edgeIndex}
                                      d={`M ${from} ${top} C ${from} ${top + 6}, ${to} ${top + 6}, ${to} ${top + 12}`}
                                      stroke={scmGraphLaneColor(edge.color)}
                                      vectorEffect="non-scaling-stroke"
                                    />
                                  );
                                })}
                              </svg>
                              <span
                                className="gyro-scm-graph-dot"
                                style={{
                                  color: scmGraphLaneColor(row?.lane ?? 0),
                                  left: `${scmGraphLaneOffset(row?.lane ?? 0)}px`,
                                }}
                              />
                            </span>
                            <span className="gyro-scm-history-subject">
                              {commit.subject}
                            </span>
                            {refs.length ? (
                              <span className="gyro-scm-history-refs">
                                {/* The sidebar is too narrow for two refs to
                                    stay legible, and scmCommitRefs already
                                    sorts head before tag before branch, so the
                                    row shows the most meaningful one. The rest
                                    stay in the commit hover card. */}
                                {refs.slice(0, 1).map((ref) => (
                                  <span
                                    className={`gyro-scm-history-ref is-${ref.kind}`}
                                    key={`${ref.kind}:${ref.label}`}
                                  >
                                    {ref.kind === "tag" ? (
                                      <Tag size={9} aria-hidden="true" />
                                    ) : (
                                      <GitBranch size={9} aria-hidden="true" />
                                    )}
                                    {ref.label}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                            <small className="gyro-scm-history-author">
                              {commit.author}
                            </small>
                          </ScmCommitHover>
                        );
                      })
                    )}
                  </div>
                </details>
                <ScmSectionDivider
                  label="Resize GitHub section"
                  target="next"
                  onResize={setScmGithubHeight}
                />
                <div
                  className="gyro-scm-github-section"
                  style={
                    scmGithubHeight === undefined
                      ? undefined
                      : { height: scmGithubHeight, maxHeight: "none" }
                  }
                >
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
              </div>
            </SidebarSection>
          ) : null}

          {workspacePath && activeIdeView === "run-test" ? (
            <SidebarSection
              grow
              headerActions={
                <div className="gyro-sidebar-section-actions">
                  <button
                    aria-label="Add a command"
                    onClick={() => setIsAddingRunCommand((open) => !open)}
                    title="Add a command"
                    type="button"
                  >
                    <Plus size={12} />
                  </button>
                  <button
                    aria-label="Rescan workspace commands"
                    onClick={() => onRefreshIdeTasks?.()}
                    title="Rescan commands"
                    type="button"
                  >
                    <RefreshCw size={12} />
                  </button>
                </div>
              }
              title="Run and Test"
            >
              {isAddingRunCommand ? (
                <form
                  className="gyro-run-command-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const commandLine = runCommandDraft.trim();
                    if (!commandLine) {
                      return;
                    }
                    void onCreateCustomTask?.({
                      commandLine,
                      label: runCommandLabelDraft.trim() || undefined,
                      group: runCommandGroupDraft,
                    });
                    setRunCommandDraft("");
                    setRunCommandLabelDraft("");
                    setIsAddingRunCommand(false);
                  }}
                >
                  <input
                    aria-label="Command to run"
                    autoFocus
                    onChange={(event) => setRunCommandDraft(event.target.value)}
                    placeholder="pnpm test --filter ui"
                    value={runCommandDraft}
                  />
                  <input
                    aria-label="Command name"
                    onChange={(event) =>
                      setRunCommandLabelDraft(event.target.value)
                    }
                    placeholder="Name (optional)"
                    value={runCommandLabelDraft}
                  />
                  <div className="gyro-run-command-form-row">
                    <select
                      aria-label="Command group"
                      onChange={(event) =>
                        setRunCommandGroupDraft(
                          event.target.value as TaskDefinition["group"],
                        )
                      }
                      value={runCommandGroupDraft}
                    >
                      <option value="custom">Command</option>
                      <option value="test">Test</option>
                      <option value="check">Check</option>
                      <option value="build">Build</option>
                      <option value="dev">Dev</option>
                    </select>
                    <button
                      onClick={() => {
                        setIsAddingRunCommand(false);
                        setRunCommandDraft("");
                        setRunCommandLabelDraft("");
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button disabled={!runCommandDraft.trim()} type="submit">
                      Save
                    </button>
                  </div>
                  <p>
                    Saved commands run from the workspace root and are kept in
                    .gyro/tasks.json.
                  </p>
                </form>
              ) : null}
              {runToolchain ? (
                <p className="gyro-run-toolchain">{runToolchain}</p>
              ) : null}
              {matchedRunPackage ? (
                <div
                  aria-label="Command scope"
                  className="gyro-run-scope"
                  role="group"
                >
                  <button
                    aria-pressed={runScopeMode === "package"}
                    onClick={() =>
                      setRunScopeOverride({
                        packagePath: matchedRunPackage,
                        mode: "package",
                      })
                    }
                    title={matchedRunPackage}
                    type="button"
                  >
                    This package
                  </button>
                  <button
                    aria-pressed={runScopeMode === "repo"}
                    onClick={() =>
                      setRunScopeOverride({
                        packagePath: matchedRunPackage,
                        mode: "repo",
                      })
                    }
                    type="button"
                  >
                    Whole repo
                  </button>
                </div>
              ) : null}
              {(ide?.taskDefinitions.length ?? 0) > 0 ? (
                <input
                  aria-label="Filter commands"
                  className="gyro-run-command-filter"
                  onChange={(event) => setRunCommandFilter(event.target.value)}
                  placeholder="Filter commands"
                  value={runCommandFilter}
                />
              ) : null}
              {runTaskGroups.length > 0 ? (
                runTaskGroups.map((group) => {
                  const rows = group.tasks.map((entry) => (
                    <div className="gyro-run-task-entry" key={entry.task.id}>
                      <RunTaskRow
                        onRemove={
                          entry.task.source === "custom" && onDeleteCustomTask
                            ? () => void onDeleteCustomTask(entry.task)
                            : undefined
                        }
                        onFixWithAi={
                          entry.task.status === "failed" && onFixIdeTaskWithAi
                            ? () => onFixIdeTaskWithAi(entry.task)
                            : undefined
                        }
                        onRun={() => onRunIdeTask?.(entry.task)}
                        onStop={() => void onStopIdeTask?.(entry.task)}
                        task={entry.task}
                      />
                      {entry.variants.length > 0 ? (
                        <details className="gyro-run-task-variants">
                          <summary>{entry.variants.length} more</summary>
                          {entry.variants.map((variant) => (
                            <RunTaskRow
                              key={variant.id}
                              onFixWithAi={
                                variant.status === "failed" &&
                                onFixIdeTaskWithAi
                                  ? () => onFixIdeTaskWithAi(variant)
                                  : undefined
                              }
                              onRun={() => onRunIdeTask?.(variant)}
                              onStop={() => void onStopIdeTask?.(variant)}
                              task={variant}
                            />
                          ))}
                        </details>
                      ) : null}
                    </div>
                  ));
                  if (group.collapsed) {
                    return (
                      <details className="gyro-run-task-group" key={group.id}>
                        <summary className="gyro-run-task-group-label">
                          {group.label}
                          <small>{group.tasks.length}</small>
                        </summary>
                        {rows}
                      </details>
                    );
                  }
                  return (
                    <div className="gyro-run-task-group" key={group.id}>
                      <div className="gyro-run-task-group-label">
                        {group.label}
                        <small>{group.tasks.length}</small>
                      </div>
                      {rows}
                    </div>
                  );
                })
              ) : (
                <div className="gyro-sidebar-mini-copy">
                  {runCommandFilter.trim()
                    ? "No command matches this filter."
                    : "No commands found. Add a command or scan the project again."}
                  {!runCommandFilter.trim() ? (
                    <div className="gyro-empty-actions">
                      <button
                        type="button"
                        onClick={() => setIsAddingRunCommand(true)}
                      >
                        Add command
                      </button>
                      <button
                        type="button"
                        onClick={() => onRefreshIdeTasks?.()}
                      >
                        Rescan
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
              <details
                className="gyro-run-task-group gyro-settings-disclosure"
                open={
                  (ide?.debugSessions ?? []).some(
                    (session) =>
                      session.status !== "stopped" &&
                      session.status !== "failed",
                  ) || undefined
                }
              >
                <summary>Debug adapter</summary>
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
                        onClick={() =>
                          onSendDebugCommand?.(session, "continue")
                        }
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
              </details>
            </SidebarSection>
          ) : null}

          {workspacePath && activeIdeView === "ai" ? (
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
        </>
      ) : null}

      {isSessionsSidebar ? (
        <>
          <div className="gyro-sidebar-actions gyro-sidebar-quick-actions">
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
                New session
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
                  </div>
                  <div
                    aria-label="Open CLI sessions"
                    className="gyro-sidebar-session-group is-cli"
                    role="group"
                  >
                    <span className="gyro-sidebar-session-group-label">
                      CLI sessions
                    </span>
                    {terminalPanes.length > 0 ? (
                      <button
                        className="is-terminal-navigation"
                        onClick={() => {
                          setNewSessionMenuView("closed");
                          onSelectWorkspaceLayout("terminal-grid");
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <Columns2 size={15} />
                        <strong>View open terminals</strong>
                      </button>
                    ) : null}
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
                      {readyCommandProfiles.map((profile) => (
                        <button
                          aria-label={profile.displayName}
                          disabled={!newCliWorkspacePath}
                          key={profile.id}
                          title={
                            newCliWorkspacePath
                              ? profile.displayName
                              : "Open a project to start a CLI session"
                          }
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
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {blockedCommandProfiles.length > 0 ? (
                    <div className="gyro-sidebar-session-group is-more">
                      <button
                        aria-expanded={newSessionMenuView === "more"}
                        aria-label={`More tools, ${blockedCommandProfiles.length} ${blockedCommandProfiles.length === 1 ? "needs" : "need"} setup`}
                        onClick={() =>
                          setNewSessionMenuView((current) =>
                            current === "more" ? "root" : "more",
                          )
                        }
                        role="menuitem"
                        type="button"
                      >
                        <Box size={16} />
                        <strong>More tools</strong>
                        <small
                          aria-hidden="true"
                          title={`${blockedCommandProfiles.length} tools need setup`}
                        >
                          {blockedCommandProfiles.length}
                        </small>
                        {newSessionMenuView === "more" ? (
                          <ChevronDown size={15} />
                        ) : (
                          <ChevronRight size={15} />
                        )}
                      </button>
                      {newSessionMenuView === "more" ? (
                        <div
                          aria-label="Tools requiring setup"
                          className="gyro-sidebar-cli-profiles"
                          role="group"
                        >
                          {blockedCommandProfiles.map((profile) => (
                            <button
                              disabled
                              key={profile.id}
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
                              <strong>{profile.displayName}</strong>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <button
              aria-label="Search"
              title={`Search (${primaryGlobalSearchShortcut("global")})`}
              className="gyro-sidebar-action gyro-sidebar-icon-action"
              onClick={() => {
                setNewSessionMenuView("closed");
                onOpenCommandPalette();
              }}
              type="button"
            >
              <Search size={15} />
            </button>
            <button
              aria-current={
                activeDestination === "automations" ? "page" : undefined
              }
              aria-label="Workflows"
              title="Workflows"
              className={`gyro-sidebar-action gyro-sidebar-icon-action${activeDestination === "automations" ? " is-active" : ""}`}
              onClick={() => {
                setNewSessionMenuView("closed");
                onSelectDestination("automations");
              }}
              type="button"
            >
              <Workflow size={15} />
            </button>
          </div>

          {isCliSidebar ? (
            <CliSessionList
              selectedId={selectedTerminalPaneId}
              onBack={() => onSelectWorkspaceLayout("thread")}
              onSelect={onSelectTerminalPane}
              onClose={onCloseTerminalPane}
              items={terminalPanes.map((pane) => {
                const providerId = commandProfiles.find(
                  (profile) => profile.id === pane.profileId,
                )?.providerId;
                return {
                  pane,
                  status:
                    pane.attention ??
                    (pane.status === "running" &&
                    !terminalPaneHasActiveWork(pane)
                      ? "idle"
                      : pane.status),
                  icon: providerId ? (
                    <ProviderLogo providerId={providerId as ProviderId} />
                  ) : (
                    <Terminal size={16} />
                  ),
                };
              })}
            />
          ) : (
            <div className="gyro-sidebar-project-chat-list">
              {pinnedSessions.length > 0 ? (
                <>
                  <div className="gyro-sidebar-small-title">Pinned</div>
                  {pinnedSessions.map((session) => renderSessionRow(session))}
                </>
              ) : null}
              <div className="gyro-sidebar-small-title gyro-sidebar-projects-heading">
                <span>Projects</span>
                <button
                  type="button"
                  aria-label="Open project"
                  title="Open project"
                  onClick={onOpenWorkspace}
                >
                  <Plus size={15} />
                </button>
              </div>
              {projectGroups.map((project, projectIndex) => {
                const isCollapsed = collapsedProjectIds.includes(project.key);
                const projectDrafts = draftsByProjectKey.get(project.key) ?? [];
                const projectVisibleCount =
                  projectVisibleCounts[project.key] ??
                  SIDEBAR_INITIAL_PROJECT_SESSION_COUNT;
                const collapsedProjectSessions = project.items.slice(
                  0,
                  projectVisibleCount,
                );
                const activeProjectSession = project.items.find(
                  (session) => session.id === activeSessionId,
                );
                const visibleProjectSessions =
                  activeProjectSession &&
                  !collapsedProjectSessions.includes(activeProjectSession)
                    ? [
                        ...collapsedProjectSessions.slice(
                          0,
                          Math.max(0, projectVisibleCount - 1),
                        ),
                        activeProjectSession,
                      ]
                    : collapsedProjectSessions;
                const hiddenCount = Math.max(
                  0,
                  project.items.length - visibleProjectSessions.length,
                );
                const hasRevealedMore =
                  projectVisibleCount > SIDEBAR_INITIAL_PROJECT_SESSION_COUNT;
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
                          .querySelector<HTMLElement>(
                            ".gyro-sidebar-project-row",
                          )
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
                    <SidebarProjectCard
                      expandedContent={
                        !isCollapsed ? (
                          <>
                            {projectDrafts.map((draft) =>
                              renderDraftRow(draft, true),
                            )}
                            {visibleProjectSessions.length > 0 ? (
                              visibleProjectSessions.map((session) =>
                                renderSessionRow(session, true),
                              )
                            ) : projectDrafts.length > 0 ? null : (
                              <button
                                className="gyro-sidebar-thread is-empty"
                                onClick={onCreateSession}
                                type="button"
                              >
                                <span>No recent sessions</span>
                              </button>
                            )}
                            {hiddenCount > 0 || hasRevealedMore ? (
                              <div className="gyro-sidebar-more-actions">
                                {hiddenCount > 0 ? (
                                  <button
                                    aria-expanded={hasRevealedMore}
                                    aria-label={`Show more chats in ${project.label}`}
                                    className="gyro-sidebar-more-button"
                                    onClick={() =>
                                      showMoreProjectSessions(
                                        project.key,
                                        project.items.length,
                                      )
                                    }
                                    type="button"
                                  >
                                    <ChevronDown aria-hidden="true" size={12} />
                                    <span>more</span>
                                  </button>
                                ) : null}
                                {hasRevealedMore ? (
                                  <button
                                    aria-label={`Show fewer chats in ${project.label}`}
                                    className="gyro-sidebar-more-button"
                                    onClick={() =>
                                      showLessProjectSessions(project.key)
                                    }
                                    type="button"
                                  >
                                    <ChevronUp aria-hidden="true" size={12} />
                                    <span>less</span>
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </>
                        ) : null
                      }
                      path={project.key}
                      name={project.label}
                      taskCount={project.items.length}
                      activeCount={
                        project.items.filter((session) =>
                          sendingSessionIds.includes(session.id),
                        ).length
                      }
                      settings={
                        project.hasWorkspace ? projectSettings : undefined
                      }
                      memorySessionId={
                        (
                          project.items.find(
                            (item) => item.id === activeSessionId,
                          ) ?? project.items[0]
                        )?.id
                      }
                      onRemove={
                        project.hasWorkspace
                          ? () =>
                              onRemoveProject?.({
                                path: project.key,
                                label: project.label,
                              })
                          : undefined
                      }
                    >
                      <SidebarProjectRow
                        draggable
                        isPinned={
                          projectSettings?.details[project.key]?.pinned ?? false
                        }
                        onPin={
                          project.hasWorkspace && projectSettings
                            ? () => {
                                const details =
                                  projectSettings.details[project.key];
                                projectSettings.save(
                                  project.key,
                                  project.label,
                                  !details?.pinned,
                                  projectSettings.folders[project.key] ?? [],
                                  details?.primaryFolder,
                                  details?.allowNestedFolders,
                                );
                              }
                            : undefined
                        }
                        icon={
                          project.hasWorkspace
                            ? isCollapsed
                              ? Folder
                              : FolderOpen
                            : HardDrive
                        }
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
                      />
                    </SidebarProjectCard>
                  </div>
                );
              })}
              <section
                aria-label="Recent chats"
                className="gyro-sidebar-recents"
              >
                <div className="gyro-sidebar-small-title">Recents</div>
                {unprojectedDraftChats.map((draft) => renderDraftRow(draft))}
                {unprojectedRecentSessions.length > 0 ? (
                  visibleRecentSessions.map((session) =>
                    renderSessionRow(session),
                  )
                ) : unprojectedDraftChats.length > 0 ? null : (
                  <div className="gyro-sidebar-recents-empty">
                    No standalone chats yet
                  </div>
                )}
                {hiddenRecentCount > 0 || recentsHaveRevealedMore ? (
                  <div className="gyro-sidebar-more-actions">
                    {hiddenRecentCount > 0 ? (
                      <button
                        aria-expanded={recentsHaveRevealedMore}
                        className="gyro-sidebar-more-button"
                        onClick={() =>
                          setRecentsVisibleCount((count) =>
                            Math.min(
                              unprojectedRecentSessions.length,
                              count + SIDEBAR_PROJECT_SESSION_BATCH_SIZE,
                            ),
                          )
                        }
                        type="button"
                      >
                        <ChevronDown aria-hidden="true" size={12} />
                        <span>more</span>
                      </button>
                    ) : null}
                    {recentsHaveRevealedMore ? (
                      <button
                        className="gyro-sidebar-more-button"
                        onClick={() =>
                          setRecentsVisibleCount(
                            SIDEBAR_INITIAL_RECENT_SESSION_COUNT,
                          )
                        }
                        type="button"
                      >
                        <ChevronUp aria-hidden="true" size={12} />
                        <span>less</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </div>
          )}
        </>
      ) : null}
    </>
  );
}

export function SidebarSection({
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

export function SidebarProjectRow({
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
  isPinned,
  onPin,
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
  isPinned?: boolean;
  onPin?: () => void;
}) {
  return (
    <div
      aria-grabbed={draggable ? Boolean(isDragging) : undefined}
      className={[
        "gyro-sidebar-project-row",
        draggable ? "is-draggable" : "",
        isDragging ? "is-dragging" : "",
        onRemove ? "has-remove" : "",
        onPin ? "has-pin" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={draggable}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
      onKeyDown={onKeyDown}
    >
      <button
        aria-expanded={isCollapsed === undefined ? undefined : !isCollapsed}
        aria-label={
          isCollapsed === undefined
            ? undefined
            : `${isCollapsed ? "Expand" : "Collapse"} ${label}`
        }
        className="gyro-sidebar-project-toggle"
        onClick={onClick}
        type="button"
      >
        {isCollapsed !== undefined ? (
          isCollapsed ? (
            <ChevronRight className="gyro-project-chevron" size={13} />
          ) : (
            <ChevronDown className="gyro-project-chevron" size={13} />
          )
        ) : null}
        <Icon size={15} />
        <span>{label}</span>
        {isCollapsed === undefined ? meta ? <small>{meta}</small> : null : null}
      </button>
      {onPin ? (
        <button
          type="button"
          className="gyro-sidebar-project-pin"
          aria-label={`${isPinned ? "Unpin" : "Pin"} ${label}`}
          title={`${isPinned ? "Unpin" : "Pin"} ${label}`}
          aria-pressed={Boolean(isPinned)}
          onClick={onPin}
        >
          <Pin size={14} fill={isPinned ? "currentColor" : "none"} />
        </button>
      ) : null}
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

export function DraftSidebarRow({
  title,
  isActive,
  isNested,
  onSelect,
}: {
  title: string;
  isActive: boolean;
  isNested?: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={[
        "gyro-session-row",
        "is-draft",
        isActive ? "is-active" : "",
        isNested ? "is-nested" : "",
      ].join(" ")}
    >
      {isNested ? <span aria-hidden="true" className="gyro-sidebar-tree-branch" /> : null}
      <button
        aria-current={isActive ? "page" : undefined}
        aria-label={title}
        className="gyro-sidebar-thread-main"
        onClick={onSelect}
        title={title}
        type="button"
      >
        <span className="gyro-sidebar-thread-title">
          <span>{title}</span>
        </span>
      </button>
    </div>
  );
}

export function SessionSidebarRow({
  session,
  isActive,
  isSending,
  isUnreadComplete = false,
  approvalCount = 0,
  questionCount = 0,
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
  onUploadCloudChat,
  onDelete,
  onDragStart,
  onDragEnd,
  onPointerDown,
}: {
  session: Session;
  isActive: boolean;
  isSending: boolean;
  isUnreadComplete?: boolean;
  approvalCount?: number;
  questionCount?: number;
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
  onUploadCloudChat?: () => void;
  onDelete: () => void;
  onDragStart?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
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
  const isAwaitingQuestion = !approvalCount && questionCount > 0;
  const isAwaitingInput = approvalCount > 0 || isAwaitingQuestion;
  const badgeLabels = [
    approvalCount > 0
      ? `${approvalCount} ${approvalCount === 1 ? "approval" : "approvals"} required`
      : undefined,
    isAwaitingQuestion
      ? `${questionCount} ${questionCount === 1 ? "question" : "questions"} awaiting an answer`
      : undefined,
    isUnreadComplete ? "Completed, unread" : undefined,
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
        !isAwaitingInput && !isSending && !isUnreadComplete
          ? "has-idle-time"
          : "",
        approvalCount > 0 ? "is-awaiting-approval" : "",
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
      onPointerDown={onPointerDown}
    >
      {isNested ? <span aria-hidden="true" className="gyro-sidebar-tree-branch" /> : null}
      <button
        aria-current={isActive ? "page" : undefined}
        aria-label={ariaTitle}
        title={[session.title, ...badgeLabels].join(" · ")}
        className={
          sessionProviderId
            ? "gyro-sidebar-thread-main has-model-logo"
            : "gyro-sidebar-thread-main"
        }
        onClick={onSelect}
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
            approvalCount > 0
              ? "Chat needs approval"
              : isAwaitingQuestion
                ? "Chat needs input"
                : isSending
                  ? "Chat working"
                  : isUnreadComplete
                    ? "Chat completed, unread"
                    : undefined
          }
          className={[
            "gyro-session-time",
            approvalCount > 0 ? "is-approval" : "",
            !isAwaitingInput && isSending ? "is-working" : "",
            isAwaitingQuestion ? "is-needs-input" : "",
            !isAwaitingInput && !isSending && isUnreadComplete
              ? "is-complete"
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
          title={
            approvalCount > 0
              ? `${approvalCount} ${approvalCount === 1 ? "approval" : "approvals"} required — open this chat to review`
              : isAwaitingQuestion
                ? `${questionCount} ${questionCount === 1 ? "question" : "questions"} — open this chat to answer`
                : isSending
                  ? "Chat working in the background"
                  : isUnreadComplete
                    ? "Chat completed — open to view"
                    : undefined
          }
        >
          {approvalCount > 0 ? (
            <>
              <PauseCircle aria-hidden="true" size={14} />
              <span className="gyro-sr-only">Awaiting approval</span>
            </>
          ) : isAwaitingQuestion ? (
            "Needs Input"
          ) : isSending ? (
            <CircleDashed aria-hidden="true" size={13} />
          ) : isUnreadComplete ? (
            <span aria-hidden="true" className="gyro-session-complete-dot" />
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
          <CheckWorkMenuItem
            sessionId={session.id}
            disabled={isSending}
            onClose={onMenuClose}
          />
          {onOpenInGrid ? (
            <button onClick={onOpenInGrid} role="menuitem" type="button">
              <Columns2 aria-hidden="true" size={14} />
              Open in chat grid
            </button>
          ) : null}
          {onUploadCloudChat ? (
            <button onClick={onUploadCloudChat} role="menuitem" type="button">
              Back up to Cloud
            </button>
          ) : null}
          <button onClick={onRename} role="menuitem" type="button">
            <Edit3 aria-hidden="true" size={14} />
            Rename
          </button>
          <button
            className="is-danger"
            onClick={onDelete}
            role="menuitem"
            type="button"
          >
            <Trash2 aria-hidden="true" size={14} />
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The provider whose mark a sidebar row carries.
 *
 * This listed four ids by hand, so every provider added since — Kimi, Ollama,
 * Cursor, OpenCode, the API-key presets, and every endpoint a user defines —
 * rendered no mark, and the row lost the one thing that said which model wrote
 * the chat. The catalog already knows every id, and `ProviderLogo` falls back
 * to a monogram for a provider that publishes no mark of its own, so a
 * hand-kept list has nothing left to protect against.
 *
 * The guard stays for the case it actually answers: a chat saved against a
 * provider that has since left the catalog has an id nothing can draw.
 */
export function providerIdForSession(session: Session): ProviderId | undefined {
  return isProviderId(session.providerId) ? session.providerId : undefined;
}

export type SidebarDraftChat = {
  id: string;
  title: string;
  workspacePath: string;
};

export type SidebarProjectGroupData = {
  hasWorkspace: boolean;
  key: string;
  label: string;
  items: Session[];
};

export const SIDEBAR_PROJECT_ORDER_STORAGE_KEY =
  "gyro.sidebar-project-order-v1";

export const SIDEBAR_PROJECT_COLLAPSE_STORAGE_KEY =
  "gyro.sidebar-project-collapse-v1";

export const SIDEBAR_INITIAL_PROJECT_SESSION_COUNT = 5;

export const SIDEBAR_INITIAL_RECENT_SESSION_COUNT = 7;

export const SIDEBAR_PROJECT_SESSION_BATCH_SIZE = 15;

export function sidebarProjectGroups(
  sessions: Session[],
  _savedProjects: Array<{ path: string; label: string }>,
  workspacePath?: string,
  drafts: SidebarDraftChat[] = [],
): SidebarProjectGroupData[] {
  const groups = new Map<string, SidebarProjectGroupData>();
  const groupKeyForPath = projectGroupKey;
  const currentProjectKey = groupKeyForPath(workspacePath);
  for (const session of sessions) {
    const key = groupKeyForPath(session.workspacePath);
    // Generated scratch folders are not projects. The open workspace is added
    // below, so the folder the user is in stays reachable.
    if (
      key !== currentProjectKey &&
      !isUserSelectedWorkspacePath(session.workspacePath)
    ) {
      continue;
    }
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(session);
    } else {
      groups.set(key, {
        hasWorkspace:
          key === currentProjectKey ||
          (key !== "gyro" && isUserSelectedWorkspacePath(key)),
        key,
        label: projectSidebarName(session.workspacePath),
        items: [session],
      });
    }
  }

  for (const draft of drafts) {
    // Restored layouts retain empty drafts for other projects. A hidden row
    // must not create a project by itself; the active workspace is added below.
    if (!draftHasStartedForSidebar(draft)) continue;
    if (!isUserSelectedWorkspacePath(draft.workspacePath)) continue;
    const key = groupKeyForPath(draft.workspacePath);
    if (groups.has(key)) continue;
    groups.set(key, {
      hasWorkspace: key !== "gyro" && isUserSelectedWorkspacePath(key),
      key,
      label: projectSidebarName(draft.workspacePath),
      items: [],
    });
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
        (new Date(second.updatedAt).getTime() || 0) -
        (new Date(first.updatedAt).getTime() || 0),
    );
  }
  return [...groups.values()];
}

/** Placeholder titles used before the first real turn or auto-title. */
export function isSidebarPlaceholderSessionTitle(title: string) {
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

/** Use the same visibility rule for a draft row and its project group. */
function draftHasStartedForSidebar(draft: SidebarDraftChat) {
  return Boolean(draft.title.trim()) && !isSidebarPlaceholderSessionTitle(draft.title);
}

/**
 * Whether a chat should list in the Projects sidebar.
 * Unstarted shells (empty New chat / New mission) stay out until activity.
 */
export function sessionHasStartedForSidebar(session: Session) {
  if (!isSidebarPlaceholderSessionTitle(session.title)) {
    return true;
  }
  if (session.summary?.trim()) {
    return true;
  }
  // Settings and other metadata also advance updatedAt. A timestamp alone
  // must not make an empty placeholder appear as a started session.
  return false;
}

export function normalizeSidebarPath(path?: string) {
  return path?.trim().replaceAll("\\", "/").replace(/\/+$/, "") ?? "";
}

export function stableSidebarProjectGroups(
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

export function loadSidebarProjectOrder() {
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

export function loadCollapsedSidebarProjectIds() {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const value = window.localStorage.getItem(
      SIDEBAR_PROJECT_COLLAPSE_STORAGE_KEY,
    );
    const parsed: unknown = value ? JSON.parse(value) : [];
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

export function mergeSidebarProjectOrder(
  current: string[],
  discovered: string[],
) {
  const discoveredSet = new Set(discovered);
  return [
    ...current.filter((key) => discoveredSet.has(key)),
    ...discovered.filter((key) => !current.includes(key)),
  ];
}

export function sidebarDraftGroupKey(
  draftPath: string | undefined,
  _workspacePath: string | undefined,
  _savedProjects: Array<{ path: string }>,
) {
  return projectGroupKey(draftPath);
}

export function projectGroupKey(
  path?: string,
  _primaryGyroProjectPath?: string,
) {
  return normalizeSidebarPath(path) || "gyro";
}

export function isInteractiveShellPane(pane: TerminalPane) {
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

export function terminalPaneHasActiveWork(pane: TerminalPane) {
  if (pane.status === "waiting") {
    return true;
  }
  if (pane.status !== "running") {
    return false;
  }
  return !isInteractiveShellPane(pane) || pane.hasForegroundJob !== false;
}

export const RUN_TASK_GROUP_LABELS: Array<{
  id: TaskDefinition["group"];
  label: string;
}> = [
  { id: "test", label: "Tests" },
  { id: "build", label: "Build" },
  { id: "check", label: "Checks" },
  { id: "dev", label: "Dev servers" },
  { id: "custom", label: "Other commands" },
];

export type RunTaskEntry = {
  task: TaskDefinition;
  variants: TaskDefinition[];
};

export type RunTaskGroup = {
  id: string;
  label: string;
  tasks: RunTaskEntry[];
  /** Other commands start closed once the list is long. */
  collapsed?: boolean;
};

export function taskCommandLine(task: TaskDefinition): string {
  return [task.command, ...task.args].join(" ");
}

/** The script or cargo subcommand a row should be named, when it has one. */
export function taskScriptName(task: TaskDefinition): string {
  const { args, command } = task;
  if (
    (command === "pnpm" && args[0] === "--filter" && args.length >= 3) ||
    (command === "yarn" && args[0] === "workspace" && args.length >= 3) ||
    (command === "bun" && args[0] === "run" && args[1] === "--filter")
  ) {
    return args.at(-1) ?? task.label;
  }
  if (
    command === "npm" &&
    args[0] === "run" &&
    args.some((arg) => arg.startsWith("--workspace="))
  ) {
    return args[1] ?? task.label;
  }
  if (args[0] === "run" && args[1] && !args[1].startsWith("-")) {
    return args[1];
  }
  if (task.toolchain === "deno" && args[0] === "task" && args[1]) {
    return args[1];
  }
  const cargoCommand = task.toolchain === "cargo" ? args[0] : undefined;
  if (cargoCommand) {
    return cargoCommand;
  }
  if ((command === "make" || command === "just") && args.length === 1) {
    return args[0] ?? task.label;
  }
  return task.label;
}

/** A root package script whose command is exactly `<runner> run <name>`. */
export function isObviousPackageScript(task: TaskDefinition): boolean {
  return (
    task.source !== "custom" &&
    !task.packagePath &&
    task.args[0] === "run" &&
    task.args.length === 2 &&
    (task.toolchain === undefined || task.toolchain === "node")
  );
}

export function taskRowTitle(task: TaskDefinition): string {
  if (
    isObviousPackageScript(task) ||
    (task.packagePath && task.toolchain === "node") ||
    (task.toolchain === "deno" && task.args[0] === "task") ||
    ((task.command === "make" || task.command === "just") &&
      task.args.length === 1)
  ) {
    return taskScriptName(task);
  }
  return task.label;
}

export function taskShowsCommandLine(task: TaskDefinition): boolean {
  return !isObviousPackageScript(task);
}

const NODE_RUNNERS = new Set(["pnpm", "npm", "yarn", "bun"]);

/** One line naming the toolchains discovery actually found. */
export function runToolchainSummary(tasks: TaskDefinition[]): string {
  const parts: string[] = [];
  const nodeTasks = tasks.filter(
    (task) => task.toolchain === "node" || NODE_RUNNERS.has(task.command),
  );
  if (nodeTasks.length > 0) {
    const runner =
      nodeTasks.find((task) => NODE_RUNNERS.has(task.command))?.command ??
      "node";
    parts.push(
      nodeTasks.some((task) => task.packagePath)
        ? `${runner} workspace`
        : runner,
    );
  }
  const cargoTasks = tasks.filter(
    (task) => task.toolchain === "cargo" || task.command === "cargo",
  );
  if (cargoTasks.length > 0) {
    parts.push(
      cargoTasks.some(
        (task) => task.packagePath || task.args.includes("--workspace"),
      )
        ? "Cargo workspace"
        : "Cargo",
    );
  }
  if (tasks.some((task) => task.toolchain === "python")) parts.push("Python");
  if (tasks.some((task) => task.toolchain === "go")) parts.push("Go");
  if (tasks.some((task) => task.toolchain === "deno")) parts.push("Deno");
  if (tasks.some((task) => task.toolchain === "make" || task.command === "make")) {
    parts.push("Make");
  }
  if (tasks.some((task) => task.toolchain === "just" || task.command === "just")) {
    parts.push("just");
  }
  return parts.join(" · ");
}

/**
 * The workspace member that owns the open file, when the catalog has one.
 * The longest matching directory wins.
 */
export function matchingRunPackage(
  tasks: TaskDefinition[],
  activePath: string | undefined,
  workspacePath: string | undefined,
): string | undefined {
  if (!activePath || !workspacePath) return undefined;
  const relative = workspaceRelativeFilePath(activePath, workspacePath);
  if (!relative || relative.startsWith("/")) return undefined;
  const packages = [
    ...new Set(
      tasks
        .map((task) => task.packagePath)
        .filter((path): path is string => Boolean(path)),
    ),
  ];
  return packages
    .filter(
      (packagePath) =>
        relative === packagePath || relative.startsWith(`${packagePath}/`),
    )
    .sort((first, second) => second.length - first.length)[0];
}

function variantFoldsUnder(variant: TaskDefinition, primary: TaskDefinition) {
  if (variant.role === "primary" || primary.role === "variant") return false;
  if (variant.group !== primary.group) return false;
  if ((variant.toolchain ?? "") !== (primary.toolchain ?? "")) return false;
  if ((variant.packagePath ?? "") !== (primary.packagePath ?? "")) return false;
  return taskScriptName(variant).startsWith(`${taskScriptName(primary)}:`);
}

function taskInRunScope(task: TaskDefinition, packagePath: string | undefined) {
  if (task.source === "custom") return true;
  if (!packagePath) return !task.packagePath;
  if (task.packagePath === packagePath) return task.role !== "variant";
  if (task.packagePath) return false;
  if (task.role === "variant") return false;
  const name = taskScriptName(task);
  return name === "test" || name === "check";
}

function foldRunEntries(tasks: TaskDefinition[]): RunTaskEntry[] {
  const primaries = tasks.filter((task) => task.role !== "variant");
  const variants = tasks.filter((task) => task.role === "variant");
  const folded = new Set<string>();
  const entries = primaries.map((task) => {
    const children = variants.filter((variant) =>
      variantFoldsUnder(variant, task),
    );
    for (const child of children) folded.add(child.id);
    return { task, variants: children };
  });
  for (const variant of variants) {
    if (!folded.has(variant.id)) {
      entries.push({ task: variant, variants: [] });
    }
  }
  return entries;
}

function runTaskGroupsFromEntries(
  entries: RunTaskEntry[],
  recent: RunTaskEntry[],
): RunTaskGroup[] {
  const hidden = new Set(
    recent.flatMap((entry) => [
      entry.task.id,
      ...entry.variants.map((variant) => variant.id),
    ]),
  );
  const rest = entries
    .filter((entry) => !hidden.has(entry.task.id))
    .map((entry) => ({
      ...entry,
      variants: entry.variants.filter((variant) => !hidden.has(variant.id)),
    }))
    .filter((entry) => entry.task);
  const groups: RunTaskGroup[] = [];
  if (recent.length > 0) {
    groups.push({ id: "recent", label: "Recent", tasks: recent });
  }
  const saved = rest.filter((entry) => entry.task.source === "custom");
  const suggested = rest.filter((entry) => entry.task.source !== "custom");
  if (saved.length > 0) {
    groups.push({ id: "saved", label: "Saved commands", tasks: saved });
  }
  for (const group of RUN_TASK_GROUP_LABELS) {
    const grouped = suggested.filter((entry) => entry.task.group === group.id);
    if (grouped.length === 0) continue;
    groups.push({
      id: group.id,
      label: group.label,
      tasks: grouped,
      collapsed: group.id === "custom" && grouped.length > 4,
    });
  }
  return groups;
}

/**
 * Buckets the catalog. An empty filter shows the scoped front door, with
 * `test:*` folded under `test`. A filter searches the whole catalog.
 */
export function groupedRunTasks(
  tasks: TaskDefinition[],
  filter: string,
  packagePath?: string,
): RunTaskGroup[] {
  const needle = filter.trim().toLowerCase();
  if (needle) {
    const matching = tasks.filter((task) => {
      const haystack = [
        task.label,
        taskCommandLine(task),
        taskScriptName(task),
        task.packagePath ?? "",
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(needle);
    });
    return runTaskGroupsFromEntries(
      matching.map((task) => ({ task, variants: [] })),
      [],
    );
  }
  const scoped = tasks.filter((task) => taskInRunScope(task, packagePath));
  const recentTasks = scoped
    .filter((task) => task.lastRunAt)
    .sort((first, second) =>
      (second.lastRunAt ?? "").localeCompare(first.lastRunAt ?? ""),
    )
    .slice(0, 5);
  const recentIds = new Set(recentTasks.map((task) => task.id));
  const recent = recentTasks.map((task) => ({
    task,
    variants:
      task.role === "variant"
        ? []
        : scoped.filter(
            (variant) =>
              !recentIds.has(variant.id) && variantFoldsUnder(variant, task),
          ),
  }));
  const hidden = new Set(
    recent.flatMap((entry) => [
      entry.task.id,
      ...entry.variants.map((variant) => variant.id),
    ]),
  );
  return runTaskGroupsFromEntries(
    foldRunEntries(scoped.filter((task) => !hidden.has(task.id))),
    recent,
  );
}

export function runTaskStatusCopy(task: TaskDefinition): string | undefined {
  switch (task.status) {
    case "running":
      return task.group === "dev" ? "live" : "running";
    case "done":
      return task.group === "test" ? "passed" : "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return undefined;
  }
}

export function RunTaskRow({
  task,
  onFixWithAi,
  onRun,
  onStop,
  onRemove,
}: {
  task: TaskDefinition;
  onFixWithAi?: () => void;
  onRun: () => void;
  onStop: () => void;
  onRemove?: () => void;
}) {
  const commandLine = taskCommandLine(task);
  const isRunning = task.status === "running";
  const status = runTaskStatusCopy(task);
  const duration =
    task.durationMs !== undefined &&
    task.status !== "running" &&
    task.status !== "cancelled"
      ? formatRunDuration(Math.max(0, Math.round(task.durationMs / 1000)))
      : undefined;
  const statusLabel = status
    ? duration
      ? `${status} · ${duration}`
      : status
    : undefined;
  const title = taskRowTitle(task);
  const LaunchIcon = task.group === "test" ? ListChecks : Play;

  return (
    <div className="gyro-run-task-row" data-status={task.status}>
      <button
        aria-label={isRunning ? `Stop ${title}` : `Run ${title}: ${commandLine}`}
        className="gyro-run-task-main"
        onClick={isRunning ? onStop : onRun}
        title={isRunning ? `Stop ${commandLine}` : commandLine}
        type="button"
      >
        {isRunning ? <Square size={11} /> : <LaunchIcon size={13} />}
        <span>
          <strong>{title}</strong>
          {taskShowsCommandLine(task) && commandLine !== title ? (
            <small>{commandLine}</small>
          ) : null}
        </span>
      </button>
      {statusLabel ? (
        <em className="gyro-run-task-status">{statusLabel}</em>
      ) : null}
      {onFixWithAi ? (
        <button
          aria-label={`Fix ${task.label} with AI`}
          className="gyro-run-task-fix"
          onClick={onFixWithAi}
          title="Attach this failure to the chat so a model can fix it"
          type="button"
        >
          <Sparkles size={11} />
          <span>Fix with AI</span>
        </button>
      ) : null}
      {onRemove ? (
        <button
          aria-label={`Remove ${task.label}`}
          className="gyro-run-task-remove"
          onClick={onRemove}
          title="Remove saved command"
          type="button"
        >
          <Trash2 size={11} />
        </button>
      ) : null}
    </div>
  );
}

export function SidebarDestinationRow({
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

/** Copy during the click. The async clipboard API drops the user gesture in
 *  the macOS webview and then fails with nothing on the clipboard. */
export function writeClipboardText(value: string) {
  // Start the async write while this click is still the user gesture, then
  // also copy synchronously. Either path is enough; one of them fails in the
  // macOS webview depending on the page.
  const pending = navigator.clipboard?.writeText(value);
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  try {
    document.execCommand("copy");
  } catch {
    // The async write above is the other attempt.
  }
  area.remove();
  void pending?.catch(() => undefined);
}

export function explorerRootGroupForFile(file: WorkspaceFile | undefined) {
  if (!file || file.isWorkspaceRoot) return undefined;
  const relativePath =
    file.relativePath ??
    workspaceRelativeFilePath(file.path, file.workspacePath);
  if (!relativePath || relativePath.includes("/")) return undefined;
  return workspaceExplorerRootEntryGroup(workspaceName(file.path));
}

export function WorkspaceExplorerRow({
  label,
  decoration,
  bufferStatus,
  kind,
  rootGroup,
  startsRootGroup,
  depth,
  collapsed,
  isActive,
  isOpen,
  isDropTarget,
  path,
  rowRef,
  tabIndex,
  draggable,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  label: string;
  decoration?: IdeState["fileDecorations"][number];
  bufferStatus?: EditorBuffer["status"];
  kind: WorkspaceFile["kind"];
  rootGroup?: ReturnType<typeof workspaceExplorerRootEntryGroup>;
  startsRootGroup?: boolean;
  depth: number;
  collapsed: boolean;
  isActive: boolean;
  isOpen: boolean;
  isDropTarget?: boolean;
  path: string;
  rowRef: (element: HTMLButtonElement | null) => void;
  tabIndex: number;
  draggable?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onDragStart?: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onDragEnd?: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onDragOver?: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onDragLeave?: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onDrop?: (event: ReactDragEvent<HTMLButtonElement>) => void;
}) {
  const badge = kind === "file" ? scmFileBadge(path) : undefined;
  const FileIcon = badge?.icon ?? FileCode2;
  const FolderIcon = collapsed ? Folder : FolderOpen;

  return (
    <button
      aria-expanded={kind === "directory" ? !collapsed : undefined}
      aria-label={`${kind === "directory" ? "Folder" : "File"} ${path}${decoration?.tooltip ? `, ${decoration.tooltip}` : ""}${bufferStatus === "dirty" ? ", unsaved changes" : ""}`}
      aria-level={Math.max(1, depth)}
      aria-selected={isActive}
      className={[
        "gyro-sidebar-row gyro-sidebar-explorer-row",
        isActive ? "is-active" : "",
        isDropTarget ? "is-drop-target" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-buffer-state={bufferStatus}
      data-explorer-path={path}
      data-file-state={decoration?.color}
      data-file-tone={badge?.tone}
      data-root-group={rootGroup}
      data-root-group-start={startsRootGroup || undefined}
      data-open={isOpen || undefined}
      draggable={draggable || undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onDragEnd={onDragEnd}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDragStart={onDragStart}
      onDrop={onDrop}
      ref={rowRef}
      role="treeitem"
      style={{ paddingLeft: `${Math.max(8, Math.min(depth, 8) * 11)}px` }}
      tabIndex={tabIndex}
      title={`${path}${decoration?.tooltip ? ` · ${decoration.tooltip}` : ""}`}
      type="button"
    >
      {kind === "directory" ? (
        <>
          <ChevronRight
            aria-hidden="true"
            className="gyro-explorer-chevron"
            size={12}
          />
          <FolderIcon
            aria-hidden="true"
            className="gyro-explorer-folder-icon"
            size={14}
          />
        </>
      ) : (
        <FileIcon
          aria-hidden="true"
          className="gyro-explorer-file-icon"
          size={14}
        />
      )}
      <span>{label}</span>
      {decoration?.badge ? (
        <small className="gyro-explorer-decoration">{decoration.badge}</small>
      ) : null}
    </button>
  );
}

/* Inline naming row for Explorer creation. The typed extension is what decides
   the file type, so the row previews the detected language and icon live. */
export function ExplorerDraftRow({
  draft,
  depth,
  onChange,
  onCommit,
  onCancel,
}: {
  draft: {
    kind: "file" | "directory";
    parentPath?: string;
    value: string;
    renamePath?: string;
  };
  depth?: number;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const selectedRenameText = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, []);
  /* The click that opens this row unmounts the menu that held focus. That
     focus move can blur the new field in the same turn and commit it shut.
     Blur only counts once the field has actually been shown. */
  const acceptBlur = useRef(false);
  useEffect(() => {
    acceptBlur.current = true;
    return () => {
      acceptBlur.current = false;
    };
  }, []);
  const isRename = Boolean(draft.renamePath);
  const indent =
    depth ??
    (draft.parentPath
      ? draft.parentPath.split("/").filter(Boolean).length + 2
      : 2);
  const name = draft.value.trim();
  const typeLabel =
    draft.kind === "directory"
      ? "Folder"
      : name.includes(".")
        ? resolveLanguage({ path: name }).name
        : "Plain Text";
  const DraftFileIcon = workspaceFileBadge(name || "untitled").icon;
  return (
    <div
      className="gyro-explorer-draft"
      ref={rowRef}
      style={{ paddingLeft: `${Math.max(8, Math.min(indent, 8) * 11)}px` }}
    >
      {draft.kind === "directory" ? (
        <Folder
          aria-hidden="true"
          className="gyro-explorer-folder-icon"
          size={14}
        />
      ) : (
        <DraftFileIcon
          aria-hidden="true"
          className="gyro-explorer-file-icon"
          size={14}
        />
      )}
      <input
        aria-label={
          isRename
            ? "New name"
            : draft.kind === "directory"
              ? "New folder name"
              : "New file name"
        }
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        onFocus={(event) => {
          /* VS Code selects the basename so typing replaces it and keeps the
             extension; only do that once, on entry, so editing is untouched. */
          if (!isRename || selectedRenameText.current) return;
          selectedRenameText.current = true;
          const input = event.currentTarget;
          const extension = draft.value.lastIndexOf(".");
          if (extension > 0) {
            input.setSelectionRange(0, extension);
          } else {
            input.select();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            onCommit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            // Unmount blurs the field before this guard resets, and blur
            // commits. Ignore that blur or Escape keeps the typed name.
            acceptBlur.current = false;
            onCancel();
          }
        }}
        onBlur={(event) => {
          if (!acceptBlur.current) {
            const input = event.currentTarget;
            requestAnimationFrame(() => {
              if (input.isConnected && document.activeElement !== input) {
                input.focus();
              }
            });
            return;
          }
          onCommit();
        }}
        placeholder={
          isRename
            ? "name"
            : draft.kind === "directory"
              ? "folder name"
              : "name.ext"
        }
        spellCheck={false}
        value={draft.value}
      />
      <small>{typeLabel}</small>
    </div>
  );
}

/* Icon-only in the title bar: the label is the accessible name and the tooltip,
   so the switch stays narrow enough to share the row with window navigation. */
export function SidebarModeRow({
  icon,
  label,
  isActive,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  isActive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={isActive === true}
      className={
        isActive
          ? "gyro-titlebar-switch-option is-active"
          : "gyro-titlebar-switch-option"
      }
      data-sidebar-mode={label.toLowerCase()}
      data-tour={label === "Workspace" ? "sidebar.ide" : undefined}
      onClick={() => (isActive ? onClick() : runSurfaceSwitch(onClick))}
      title={label}
      type="button"
    >
      {icon}
    </button>
  );
}

/**
 * Only the chat grid takes a chat drag. Released anywhere else — a composer
 * outside the grid, a search field — the webview's default drop inserted the
 * drag's text (the chat's id). Installed once, on the first chat drag.
 */
export let chatDragGuardInstalled = false;

export function guardChatDragsOutsideGrid() {
  if (chatDragGuardInstalled || typeof window === "undefined") return;
  chatDragGuardInstalled = true;
  const block = (event: DragEvent) => {
    if (!event.dataTransfer || !chatDragSource(event.dataTransfer)) return;
    if (
      event.target instanceof Element &&
      event.target.closest(".gyro-chat-grid")
    ) {
      return;
    }
    event.preventDefault();
    if (event.type === "dragover") event.dataTransfer.dropEffect = "none";
    else {
      event.stopPropagation();
      endChatDragForTransfer(event.dataTransfer);
    }
  };
  window.addEventListener("dragover", block, true);
  window.addEventListener("drop", block, true);
}

export type TerminalLaunchOptions = {
  reveal?: boolean;
  directory?: "home" | "choose";
  folderPath?: string;
};

/** Icon for a normalized GitHub run state. */
export function githubRunStateIcon(state: GithubRunState): IconComponent {
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
export function scmBranchMenuStyle(trigger: HTMLElement): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const padding = 8;
  const minWidth = Math.max(rect.width, 260);
  const width = Math.min(
    minWidth,
    Math.max(160, window.innerWidth - padding * 2),
  );
  const spaceBelow = window.innerHeight - rect.bottom - padding;
  const spaceAbove = rect.top - padding;
  const openUp = spaceBelow < 148 && spaceAbove > spaceBelow;
  const left = Math.min(
    Math.max(padding, rect.right - width),
    Math.max(padding, window.innerWidth - width - padding),
  );
  const maxHeight = Math.min(
    280,
    Math.max(96, (openUp ? spaceAbove : spaceBelow) - 4),
  );
  return openUp
    ? {
        left,
        width,
        maxHeight,
        top: "auto",
        bottom: window.innerHeight - rect.top + 4,
      }
    : {
        left,
        width,
        maxHeight,
        top: rect.bottom + 4,
        bottom: "auto",
      };
}

export function ScmBranchPicker({
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
  const [query, setQuery] = useState("");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useOutsidePointerDismiss<HTMLDivElement>(
    open,
    () => setOpen(false),
    triggerRef,
  );
  const branches = recentBranches(branchCatalog, currentBranch);
  const needle = query.trim().toLowerCase();
  const visibleBranches = branches.filter((branch) =>
    branch.name.toLowerCase().includes(needle),
  );
  const label =
    currentBranch && currentBranch !== "(detached)"
      ? currentBranch
      : currentBranch === "(detached)"
        ? "Detached HEAD"
        : branchCatalog?.available === false
          ? "No repository"
          : "Select branch";

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      setMenuStyle(scmBranchMenuStyle(trigger));
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [open]);

  return (
    <div className="gyro-scm-branch-picker">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="gyro-scm-branch-trigger"
        disabled={disabled || isLoading}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          if (triggerRef.current) {
            setMenuStyle(scmBranchMenuStyle(triggerRef.current));
          }
          setQuery("");
          setOpen(true);
        }}
        ref={triggerRef}
        title={error ?? label}
        type="button"
      >
        <GitBranch size={12} aria-hidden="true" />
        <span>{isLoading ? "Loading…" : label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            // The repository section clips overflow, so this menu has to live
            // on document.body or the current branch is cut off over the form.
            <div
              className="gyro-scm-branch-menu"
              ref={menuRef}
              role="menu"
              aria-label="Local branches"
              style={menuStyle}
            >
              {branches.length >= 6 ? (
                <label className="gyro-composer-menu-search">
                  <Search size={12} aria-hidden="true" />
                  <input
                    aria-label="Find branch"
                    autoFocus
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                        return;
                      const rows =
                        menuRef.current?.querySelectorAll<HTMLButtonElement>(
                          '[role="menuitem"]:not(.is-action):not(:disabled)',
                        );
                      const row =
                        event.key === "ArrowDown"
                          ? rows?.[0]
                          : rows?.[rows.length - 1];
                      if (row) {
                        event.preventDefault();
                        row.focus();
                      }
                    }}
                    placeholder="Find branch…"
                    spellCheck={false}
                    type="search"
                    value={query}
                  />
                </label>
              ) : null}
              <button
                className="gyro-scm-branch-item is-action"
                disabled={disabled || isLoading}
                onClick={() => {
                  setOpen(false);
                  onCreateBranch?.();
                }}
                role="menuitem"
                type="button"
              >
                <GitBranchPlus size={12} aria-hidden="true" />
                Create new branch…
              </button>
              {branches.length === 0 ? (
                <div className="gyro-scm-branch-empty">
                  {branchCatalog?.error ?? error ?? "No local branches found."}
                </div>
              ) : visibleBranches.length === 0 ? (
                <div className="gyro-scm-branch-empty" role="status">
                  No matching branches
                </div>
              ) : (
                visibleBranches.map(
                  ({
                    name: branch,
                    current: isCurrent,
                    latest,
                    committedAt,
                  }) => {
                    const detail = branchCommitDetail(committedAt);
                    return (
                      <button
                        aria-current={isCurrent ? "true" : undefined}
                        disabled={disabled || isLoading}
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
                        role="menuitem"
                        title={[
                          branch,
                          detail,
                          latest ? "Latest local commit" : undefined,
                        ]
                          .filter(Boolean)
                          .join(" — ")}
                        type="button"
                      >
                        <GitBranch size={12} aria-hidden="true" />
                        <span className="gyro-scm-branch-copy">
                          <span className="gyro-scm-branch-name">{branch}</span>
                          {latest ? (
                            <em className="gyro-scm-branch-badge">
                              Latest commit
                            </em>
                          ) : null}
                          {detail ? <small>{detail}</small> : null}
                        </span>
                        {isCurrent ? (
                          <Check size={12} aria-hidden="true" />
                        ) : null}
                      </button>
                    );
                  },
                )
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function GithubSidebarPanel({
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
  const [expanded, setExpanded] = useState(false);
  const availability = github?.availability;
  const header = (
    <div className="gyro-sidebar-scm-group-label is-github">
      <button
        aria-expanded={expanded}
        aria-label={
          expanded ? "Collapse GitHub details" : "Expand GitHub details"
        }
        className="gyro-sidebar-scm-group-toggle"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      <span className="gyro-scm-label-text">GitHub</span>
      {github?.loading ? <small>…</small> : null}
      <button
        aria-label="Refresh GitHub"
        disabled={github?.loading}
        onClick={() => void onRefresh?.()}
        title="Refresh"
        type="button"
      >
        <RefreshCw size={12} />
      </button>
    </div>
  );

  if (!expanded) {
    return header;
  }

  if (!github || !availability?.available) {
    return (
      <>
        {header}
        <div className="gyro-sidebar-mini-copy">
          {github?.error ??
            availability?.error ??
            availability?.hint ??
            (github?.loading
              ? "Checking GitHub availability…"
              : "Refresh to check GitHub availability.")}
          {availability?.hint &&
          (github?.error || availability.error) &&
          availability.hint !== (github?.error ?? availability.error)
            ? ` ${availability.hint}`
            : null}
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
      <div className="gyro-sidebar-mini-copy">
        {github.error
          ? "PR refresh failed. Previously loaded results may be stale."
          : github.loading
            ? "Refreshing pull requests…"
            : github.lastCheckedAt &&
                !github.pullRequests.some((pr) => pr.headRef === branch)
              ? `No open pull request for ${branch ?? "this branch"}`
              : null}
      </div>
      {github.pullRequests.length > 0 ? (
        <>
          <div className="gyro-sidebar-scm-group-label">
            <span className="gyro-scm-label-text">Pull requests</span>
            <small>{github.pullRequests.length}</small>
          </div>
          {[...github.pullRequests]
            .sort(
              (a, b) =>
                Number(b.headRef === branch) - Number(a.headRef === branch),
            )
            .slice(0, 8)
            .map((pullRequest) => {
              const ChecksIcon = pullRequest.checks
                ? githubRunStateIcon(pullRequest.checks)
                : undefined;
              return (
                <button
                  className="gyro-sidebar-github-row"
                  key={pullRequest.number}
                  onClick={() => void onOpenUrl?.(pullRequest.url)}
                  title={`Open GitHub for comments, review, and merge · #${pullRequest.number} ${pullRequest.title} · Checks: ${pullRequest.checks ?? "not reported"}`}
                  type="button"
                >
                  <GitPullRequest size={12} aria-hidden="true" />
                  <span className="gyro-sidebar-github-title">
                    {pullRequest.headRef === branch ? "Current branch · " : ""}
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

export function isMacPlatform() {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  );
}

export type GlobalSearchMode = "commands" | "files" | "global";

export function primaryGlobalSearchShortcut(mode: GlobalSearchMode) {
  if (mode === "commands") {
    return isMacPlatform() ? "⇧⌘P" : "Ctrl Shift P";
  }
  if (mode === "files") {
    return isMacPlatform() ? "⌘P" : "Ctrl P";
  }
  return isMacPlatform() ? "⌘K" : "Ctrl K";
}

export type SessionDeleteConfirmOverlayProps = {
  chatLabel: string;
  /**
   * A live provider turn blocks deletion in the backend, so a working chat
   * explains that here rather than failing after the user commits.
   */
  isWorking?: boolean;
  onCancel: () => void;
  onDelete: () => void;
};

/**
 * Deleting a sidebar chat is the one sidebar action that cannot be undone —
 * it removes the transcript, saved attachments, panes, and terminals bound to
 * the session — so the row menu's Delete asks here first.
 */
export function SessionDeleteConfirmOverlay({
  chatLabel,
  isWorking = false,
  onCancel,
  onDelete,
}: SessionDeleteConfirmOverlayProps) {
  const { ref: dialogRef, dismiss } = useDialogDismiss(onCancel);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dismiss]);

  return (
    <div
      ref={dialogRef}
      aria-modal="true"
      className="gyro-terminal-terminate-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          dismiss();
        }
      }}
      role="alertdialog"
    >
      <section
        aria-label={`Delete ${chatLabel}`}
        className="gyro-terminal-terminate-card gyro-chat-delete-card"
      >
        <div className="gyro-terminal-terminate-heading">
          <Trash2 size={16} />
          <h2>Delete this chat?</h2>
        </div>
        <p>
          Deleting <strong>{chatLabel}</strong> removes its messages and saved
          attachments from Gyro, and this can't be undone. Files in the project
          are not touched.
        </p>
        {isWorking ? (
          <p className="gyro-chat-delete-note">
            This chat is still working. Stop its turn before deleting it.
          </p>
        ) : null}
        <div className="gyro-terminal-terminate-actions">
          <button autoFocus onClick={dismiss} type="button">
            Cancel
          </button>
          <button
            className="is-danger"
            disabled={isWorking}
            onClick={onDelete}
            type="button"
          >
            Delete chat
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * Initials for a provider that publishes no mark of its own.
 *
 * Custom endpoints all carry a `custom:<slug>` id, so slicing the id stamped
 * every one of them with the same "cu". Read the name the user typed instead,
 * and take one letter per word so "My gateway" reads as MG rather than MY.
 */
export function providerMonogram(providerId: string, label?: string) {
  const source = (
    label ?? providerId.replace(CUSTOM_PROVIDER_PREFIX, "")
  ).trim();
  const [first, second] = source.split(/[\s._/-]+/).filter(Boolean);
  if (first && second) {
    return `${first[0]}${second[0]}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function ProviderLogo({
  providerId,
  label,
}: {
  providerId: ProviderId;
  /** Display name, used when the provider has no mark to draw. */
  label?: string;
}) {
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

  if (providerId === "ollama") {
    // Official Ollama mark, sourced from the Ollama repository. It stays
    // monochrome so it remains crisp in both composer themes.
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-ollama"
        title="Ollama"
      >
        <svg viewBox="0 0 17 25">
          <path
            d="M4.40517 0.102088C4.62117 0.198678 4.81617 0.357766 4.99317 0.56799C5.28817 0.915712 5.53718 1.41342 5.72718 2.00318C5.91818 2.59635 6.04218 3.25316 6.08918 3.91224C6.71878 3.5075 7.41754 3.26103 8.13818 3.18953L8.18918 3.18498C9.05919 3.10544 9.91919 3.28384 10.6692 3.72361C10.7702 3.78384 10.8692 3.84861 10.9662 3.91679C11.0162 3.27021 11.1382 2.62817 11.3262 2.04863C11.5162 1.45773 11.7652 0.961166 12.0592 0.612308C12.2235 0.410338 12.4245 0.251368 12.6482 0.146406C12.9052 0.032771 13.1782 0.0123167 13.4442 0.098679C13.8452 0.228223 14.1892 0.516855 14.4602 0.936167C14.7082 1.3191 14.8942 1.81 15.0212 2.39863C15.2512 3.45998 15.2912 4.85655 15.1362 6.54061L15.1892 6.58607L15.2152 6.60766C15.9722 7.26219 16.4992 8.19513 16.7782 9.27807C17.2133 10.9678 16.9943 12.8632 16.2442 13.9235L16.2262 13.9473L16.2282 13.9507C16.6453 14.8166 16.8983 15.7314 16.9523 16.678L16.9543 16.7121C17.0183 17.9223 16.7542 19.1404 16.1402 20.337L16.1332 20.3484L16.1432 20.3756C16.6152 21.6904 16.7632 23.0142 16.5812 24.3369L16.5752 24.3813C16.547 24.5744 16.4525 24.7472 16.3125 24.8612C16.1725 24.9753 15.9983 25.0219 15.8282 24.9903C15.744 24.9753 15.6632 24.9417 15.5904 24.8912C15.5177 24.8408 15.4544 24.7744 15.4042 24.696C15.3541 24.6178 15.318 24.529 15.2981 24.4347C15.2782 24.3406 15.2748 24.2428 15.2882 24.1472C15.4552 22.9733 15.2982 21.7961 14.8082 20.5984C14.7625 20.4871 14.7422 20.3645 14.7492 20.242C14.7562 20.1194 14.7902 20.0009 14.8482 19.8972L14.8522 19.8904C15.4562 18.8404 15.7062 17.8109 15.6522 16.7996C15.6062 15.9143 15.3272 15.045 14.8522 14.2166C14.7598 14.0556 14.7269 13.8597 14.7606 13.6713C14.7943 13.4829 14.8918 13.3171 15.0322 13.2098L15.0412 13.203C15.2842 13.0223 15.5082 12.561 15.6212 11.9303C15.7459 11.1846 15.7133 10.4159 15.5262 9.68716C15.3212 8.89171 14.9462 8.22809 14.4212 7.77468C13.8262 7.25878 13.0382 7.00992 12.0412 7.08151C11.9108 7.09115 11.7809 7.05613 11.6682 6.98097C11.5556 6.90581 11.4653 6.79399 11.4092 6.65993C11.0952 5.90426 10.6372 5.36336 10.0662 5.02814C9.51799 4.71723 8.90425 4.58657 8.29418 4.65087C7.04918 4.76337 5.95118 5.56108 5.62418 6.56675C5.57792 6.70829 5.4947 6.8304 5.38568 6.91672C5.27666 7.00301 5.14703 7.04942 5.01417 7.0497C3.94717 7.05197 3.12117 7.33606 2.51717 7.84855C1.99517 8.29172 1.63916 8.91103 1.45116 9.65307C1.28104 10.3515 1.25774 11.0857 1.38316 11.7962C1.49516 12.4303 1.71416 12.9553 1.96517 13.2382L1.97317 13.2462C2.18517 13.4814 2.23017 13.8485 2.08217 14.1382C1.72216 14.845 1.45316 15.8984 1.40916 16.9109C1.35916 18.0677 1.59516 19.0722 2.12817 19.7927L2.14417 19.8143C2.22461 19.9208 2.27633 20.0514 2.29319 20.1905C2.31003 20.3295 2.29127 20.4711 2.23917 20.5984C1.66316 22.0029 1.48616 23.1574 1.67716 24.0665C1.71148 24.2556 1.67954 24.4524 1.58812 24.6149C1.4967 24.7776 1.35302 24.8933 1.18766 24.9374C1.0223 24.9817 0.848322 24.9506 0.702741 24.8512C0.557141 24.7517 0.451463 24.5917 0.408163 24.4051C0.165162 23.2483 0.330162 21.9233 0.881162 20.4302L0.895162 20.3904L0.887162 20.3768C0.616341 19.9222 0.414243 19.4195 0.289162 18.8893L0.284162 18.8677C0.132362 18.2062 0.0726416 17.5218 0.107162 16.8393C0.151162 15.8052 0.385163 14.7462 0.729162 13.8962L0.741162 13.8666L0.739162 13.8644C0.446163 13.3894 0.229162 12.7814 0.109162 12.1087L0.104162 12.0814C-0.0611788 11.1431 -0.0293187 10.1737 0.197162 9.25194C0.459163 8.21218 0.974162 7.31901 1.73316 6.67356C1.79316 6.62243 1.85616 6.57129 1.91916 6.52357C1.76016 4.827 1.80016 3.42134 2.03117 2.35317C2.15817 1.76455 2.34517 1.27365 2.59317 0.890713C2.86317 0.472537 3.20717 0.183905 3.60817 0.0532252C3.87417 -0.0331371 4.14817 -0.0126829 4.40517 0.102088ZM8.52118 10.4315C9.45719 10.4315 10.3212 10.7871 10.9672 11.403C11.5972 12.0019 11.9722 12.8064 11.9722 13.6076C11.9722 14.6166 11.5662 15.403 10.8392 15.9052C10.2192 16.3314 9.38819 16.5382 8.43618 16.5382C7.42718 16.5382 6.56518 16.2439 5.94318 15.7041C5.32618 15.17 4.98017 14.42 4.98017 13.6076C4.98017 12.8042 5.37818 11.9973 6.03618 11.3962C6.70418 10.786 7.58618 10.4315 8.52118 10.4315ZM8.52118 11.4496C7.82742 11.4428 7.15204 11.7031 6.60518 12.1883C6.14418 12.6087 5.88318 13.1371 5.88318 13.6087C5.88318 14.095 6.09318 14.5507 6.49318 14.8973C6.94818 15.2916 7.61718 15.52 8.43618 15.52C9.23519 15.52 9.90919 15.353 10.3682 15.0359C10.8312 14.7178 11.0682 14.2564 11.0682 13.6076C11.0682 13.1269 10.8222 12.5962 10.3852 12.1803C9.90119 11.7201 9.24519 11.4496 8.52118 11.4496ZM9.18319 12.8246L9.18719 12.8292C9.30719 13.0007 9.28219 13.2496 9.13119 13.386L8.83919 13.6473V14.1541C8.83865 14.267 8.79877 14.375 8.72829 14.4544C8.6578 14.5339 8.56246 14.5783 8.46318 14.578C8.3639 14.5783 8.26856 14.5339 8.19808 14.4544C8.12758 14.375 8.0877 14.267 8.08718 14.1541V13.6314L7.81618 13.3837C7.78042 13.3511 7.7507 13.3109 7.72872 13.2652C7.70674 13.2195 7.69294 13.1694 7.6881 13.1176C7.68326 13.0658 7.6875 13.0135 7.70056 12.9636C7.71362 12.9137 7.73524 12.8672 7.76418 12.8269C7.8232 12.7452 7.9082 12.6934 8.0007 12.6825C8.09318 12.6717 8.18572 12.7027 8.25818 12.7689L8.47318 12.9644L8.69318 12.7667C8.76538 12.7018 8.85702 12.6716 8.94854 12.6825C9.04009 12.6933 9.12427 12.7443 9.18319 12.8246ZM4.14317 10.644C4.62117 10.644 5.01017 11.0871 5.01017 11.6337C5.01043 11.8957 4.91917 12.1471 4.75641 12.3327C4.59365 12.5183 4.37273 12.6229 4.14217 12.6235C3.91195 12.6226 3.69143 12.518 3.52893 12.3327C3.36641 12.1474 3.27517 11.8965 3.27517 11.6349C3.27463 11.3729 3.36565 11.1213 3.52821 10.9355C3.69079 10.7497 3.91261 10.6449 4.14317 10.644ZM12.8492 10.644C13.3292 10.644 13.7172 11.0871 13.7172 11.6337C13.7175 11.8957 13.6262 12.1471 13.4634 12.3327C13.3007 12.5183 13.0798 12.6229 12.8492 12.6235C12.619 12.6226 12.3985 12.518 12.236 12.3327C12.0734 12.1474 11.9822 11.8965 11.9822 11.6349C11.9817 11.3729 12.0727 11.1213 12.2352 10.9355C12.3978 10.7497 12.6186 10.6449 12.8492 10.644ZM3.94017 1.47705L3.93717 1.47932C3.82131 1.53657 3.72239 1.63046 3.65217 1.74977L3.64717 1.75659C3.50917 1.97136 3.38917 2.28727 3.29917 2.70203C3.12917 3.48839 3.08317 4.55541 3.17517 5.86335C3.60517 5.7179 4.07417 5.62699 4.57917 5.59404L4.58917 5.5929L4.60817 5.55426C4.65417 5.46108 4.70317 5.37131 4.75617 5.28268C4.87917 4.40655 4.77817 3.35998 4.50317 2.50545C4.36917 2.09182 4.20617 1.76682 4.05017 1.5816C4.01797 1.5431 3.98207 1.5088 3.94317 1.47932L3.94017 1.47705ZM13.1142 1.52251L13.1122 1.52364C13.0733 1.55312 13.0374 1.58741 13.0052 1.62591C12.8492 1.81114 12.6852 2.13727 12.5522 2.5509C12.2622 3.45316 12.1652 4.56905 12.3222 5.47358L12.3802 5.58381L12.3882 5.59972H12.4182C12.9145 5.59988 13.4082 5.68101 13.8842 5.84062C13.9702 4.56337 13.9222 3.51907 13.7562 2.74749C13.6662 2.33272 13.5462 2.01682 13.4072 1.80205L13.4032 1.79523C13.3331 1.67548 13.2342 1.58121 13.1182 1.52364L13.1142 1.52251Z"
            fill="currentColor"
            fillRule="evenodd"
          />
        </svg>
      </span>
    );
  }

  if (providerId === "antigravity") {
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-antigravity"
        title="Google Antigravity"
      >
        <AntigravityMark />
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

  // Cursor's cube is the monochrome mark from Simple Icons 16.27.1 (CC0-1.0),
  // the same source the download site inlines. currentColor carries it
  // across themes.
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

  // OpenCode's square mark. The frame follows the theme ink and the block is
  // the published weak tone. The top third of the window stays open.
  if (providerId === "opencode") {
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-opencode"
        title="OpenCode"
      >
        <svg viewBox="0 0 240 300">
          <path
            className="gyro-opencode-logo-block"
            d="M180 240H60V120H180V240Z"
          />
          <path
            fill="currentColor"
            d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z"
          />
        </svg>
      </span>
    );
  }

  // DeepSeek and Mistral marks from Simple Icons 16.27.1 (CC0-1.0), the same
  // source as Cursor above. Each is a single monochrome path, so
  // currentColor carries the brand ink set in the stylesheet.
  if (providerId === "deepseek") {
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-deepseek"
        title="DeepSeek"
      >
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" />
        </svg>
      </span>
    );
  }

  if (providerId === "mistral") {
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-mistral"
        title="Mistral"
      >
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z" />
        </svg>
      </span>
    );
  }

  // OpenRouter's glyph comes from its own brand assets (openrouter.ai/brand,
  // v2) — Simple Icons still carries the retired route mark. The glyph is
  // wider than it is tall, so the viewBox is its own bounds plus a hair of
  // padding; the default `meet` fit centres it in the square logo well.
  if (providerId === "openrouter") {
    return (
      <span
        aria-hidden="true"
        className="gyro-provider-logo is-openrouter"
        title="OpenRouter"
      >
        <svg viewBox="17.8 15.2 369.6 262.3" fill="currentColor">
          <path d="M303.9475,17.19926c42.79734,0,77.48933,34.69327,77.48933,77.48933s-34.69199,77.48933-77.48933,77.48933l76.86166,76.86244c9.76367,9.76313,2.84903,26.45667-10.95697,26.45667h-220.88335c-71.32686,0-129.14889-57.82202-129.14889-129.14889S77.64197,17.19926,148.96884,17.19926h154.97866ZM148.96884,68.85881c-42.79607,0-77.48933,34.69327-77.48933,77.48933s34.69327,77.48933,77.48933,77.48933,77.48933-34.69327,77.48933-77.48933-34.69327-77.48933-77.48933-77.48933Z" />
        </svg>
      </span>
    );
  }

  // A user-defined endpoint has no published mark, so it gets a monogram well.
  // The class drops the `custom:<slug>` suffix: the slug is user text, and a
  // colon is not addressable from a stylesheet anyway.
  return (
    <span
      aria-hidden="true"
      className={`gyro-provider-logo is-monogram is-${isCustomProviderId(providerId) ? "custom" : providerId}`}
      title={label ?? providerId}
    >
      <span>{providerMonogram(providerId, label)}</span>
    </span>
  );
}

export function workspaceName(path?: string) {
  if (!path) {
    return "No workspace";
  }
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function workspaceParentFolder(path?: string) {
  if (!path) return "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

export function projectSidebarName(path?: string) {
  const name = workspaceName(path);
  if (name === "No workspace") {
    return "Gyro";
  }
  return name;
}

export function workspaceAncestorPaths(path: string, workspacePath?: string) {
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

export function relativeSessionTime(value: string) {
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
