import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleDashed,
  Clock,
  Edit3,
  FileCode2,
  FileText,
  Gauge,
  GitBranch,
  GitPullRequest,
  Goal,
  Hand,
  HardDrive,
  HelpCircle,
  ImagePlus,
  Laptop,
  ListChecks,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pause,
  Pause as PauseIcon,
  Play,
  PlugZap,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Users,
  Video,
  X,
  createLucideIcon,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AntigravityMark } from "./antigravity-mark";
import "./automation-detail.css";
import "./chat-canvas.css";
import { chatMediaFiles } from "./chat-media-transfer";
import { formatRunDuration } from "./chat-run";
import { CheckWorkStatus } from "./check-work-context";
import { resolveCleanMachinePath } from "./clean-machine-path";
import "./companion-motion.css";
import { ComposerCompletionMenu } from "./composer-completion-menu";
import {
  ComposerContextCandidates,
  contextMentionCandidates,
} from "./composer-context.ts";
import { ComposerEffortSelector } from "./composer-effort-selector";
import { ComposerModelRail } from "./composer-model-rail";
import { clippingBounds } from "./composer-popover-bounds";
import {
  type ComposerContextUsage,
  type ComposerLimitWindow,
} from "./context-usage";
import {
  COUNCIL_COMING_SOON,
  councilPreflightLabel,
  readyCouncilProviders,
  resolveCouncilSeatRequests,
} from "./council";
import {
  browserDictation,
  dictationDraft,
  type DictationController,
} from "./dictation";
import { useOutsidePointerDismiss } from "./menu-dismiss";
import "./provider-allowance.css";
import {
  CUSTOM_PROVIDER_PREFIX,
  getProviderModel,
  isCustomProviderId,
  isProviderExecutable,
  isProviderRuntimeUsable,
  providerSupportsUsage,
  providersForConfig,
  reasoningEffortLabel,
  selectedModelLabel,
  selectedReasoningEffort,
} from "./provider-catalog";
import {
  composerFastMode,
  pickerModelId,
  pickerModelLabel,
} from "./provider-fast-mode";
import "./scheduled-work.css";
import type {
  ChatAttachment,
  ChatMode,
  GitBranchCatalog,
  GyroConfig,
  ModelProviderConfig,
  ProviderId,
  ProviderLedgerSummary,
  ProviderReadiness,
  ProviderStatus,
  ProviderUsageState,
  ReasoningEffort,
  SessionGoal,
  SessionUsageTotals,
  UsageSafetySnapshot,
  WorkbenchMode,
} from "./types";
import {
  DAILY_PACE_NOTICE_PERCENT,
  dailyPaceNotice,
  estimateTurnCost,
  planUsageNotices,
  summarizeUsageSafety,
  type PlanUsageNotice,
} from "./usage-ledger";
import { remainingUsage } from "./usage-remaining";
import { canSendChat, isUserSelectedWorkspacePath } from "./workbench-state";
import { Folder } from "./workspace-folder-icons";
import "./workspace-folder-icons.css";
import {
  workspaceModeDetail,
  workspaceModeLabel,
  workspaceModePopoverLabel,
  workspaceModeTechnicalHint,
} from "./workspace-mode";

export type IconComponent = typeof MessageSquare;

export const AutoApproveIcon = createLucideIcon("AutoApprove", [
  [
    "path",
    {
      d: "M10.8 2.8Q12 2.3 13.2 2.8L19.2 5.1Q21 5.8 21 7.8V12.5C21 18.2 17.3 21.5 12 21.5S3 18.2 3 12.5V7.8Q3 5.8 4.8 5.1Z",
      key: "outline",
    },
  ],
  ["path", { d: "m8 9 2 3-2 3M13 15h3", key: "terminal" }],
]);

export let explorerAskSendHeld = false;

export const explorerAskSendListeners = new Set<() => void>();

export function subscribeExplorerAskSend(listener: () => void) {
  explorerAskSendListeners.add(listener);
  return () => {
    explorerAskSendListeners.delete(listener);
  };
}

/** Draft key shared by a chat that has no session yet; the host uses the same. */
export const NEW_CHAT_DRAFT_KEY = "new";

/**
 * The composer a drop belongs to, keyed by the draft it edits.
 *
 * Registered rather than passed because a drop can land on the app chrome
 * around a chat — the drop is delivered to the window, and only the composer
 * knows which chat its rectangle covers.
 */
export type MediaDropTarget = {
  attach: (files: File[]) => void;
  attachPaths?: (paths: string[]) => void;
  reportError: (message: string) => void;
  paneKey: string;
  rect: () => DOMRect;
};

export const mediaDropTargets = new Map<string, MediaDropTarget[]>();

/** Nothing is armed yet on the very first drag-over, so fall back to the host. */
export let localMediaDrop: MediaDropTarget | undefined;

export function registerMediaDropTarget(target: MediaDropTarget) {
  const targets = mediaDropTargets.get(target.paneKey) ?? [];
  const next = [...targets.filter((item) => item !== target), target];
  mediaDropTargets.set(target.paneKey, next);
  return () => {
    const current = mediaDropTargets.get(target.paneKey) ?? [];
    const remaining = current.filter((item) => item !== target);
    if (remaining.length) mediaDropTargets.set(target.paneKey, remaining);
    else mediaDropTargets.delete(target.paneKey);
    // The armed key is left alone on purpose: a surface that unmounts between
    // the drag-over and the drop must not retarget a drop already in flight.
  };
}

/**
 * Project, isolation, branch, and spend — the chat's standing context.
 *
 * They live in the strip under the composer, on the hero and in an active
 * thread alike — the same place the send controls are, so switching project,
 * isolation, or branch never costs a trip to the rail.
 *
 * Its popover state is its own: the composer's `activePopover` drives the
 * attach, model, and effort menus in the row above, and one shared cursor
 * across both rows would let a context menu close a composer one.
 */
export function ChatContextSection({
  branchCatalog,
  branchName,
  isBranchLoading,
  isSending = false,
  onAction,
  savedProjects = [],
  workspaceMode = "local",
  workspacePath,
}: {
  branchCatalog?: GitBranchCatalog;
  branchName?: string;
  isBranchLoading?: boolean;
  isSending?: boolean;
  onAction?: (action: string) => void;
  savedProjects?: Array<{ path: string; label: string; detail?: string }>;
  workspaceMode?: WorkbenchMode;
  workspacePath?: string;
}) {
  const [activePopover, setActivePopover] = useState<
    "project" | "workspace-mode" | "branch" | null
  >(null);
  const popoverScopeRef = useOutsidePointerDismiss<HTMLDivElement>(
    Boolean(activePopover),
    () => setActivePopover(null),
  );
  const popoverBaseId = useId();
  const hasUserWorkspace = Boolean(isUserSelectedWorkspacePath(workspacePath));
  const projectLabel = composerProjectLabel(workspacePath);
  const modeChipLabel = workspaceModeLabel(workspaceMode);
  const branchLabel =
    branchName ??
    (workspaceMode === "worktree" ? "New worktree branch" : "main");
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
  const runAction = (action?: string) => {
    setActivePopover(null);
    if (action) {
      onAction?.(action);
    }
  };
  const items: ComposerPopoverItem[] =
    activePopover === "project"
      ? [
          ...(hasUserWorkspace && workspacePath
            ? [
                {
                  action: `select-saved-project:${encodeURIComponent(workspacePath)}`,
                  active: true,
                  detail: workspacePath,
                  icon: Folder,
                  label: projectLabel,
                  removeAction: `remove-saved-project:${encodeURIComponent(workspacePath)}`,
                },
              ]
            : []),
          {
            action: "select-no-folder",
            active: !hasUserWorkspace,
            detail: "Chat without a project folder",
            icon: HardDrive,
            label: "No folder",
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
            sectionLabel: "Actions",
          },
          {
            action: "search-workspace",
            disabled: !hasUserWorkspace,
            icon: Search,
            label: "Search workspace",
          },
        ]
      : activePopover === "workspace-mode"
        ? [
            {
              action: "set-workspace-mode:local",
              active: workspaceMode === "local",
              icon: Laptop,
              kind: "workspace-mode",
              label: workspaceModePopoverLabel("local"),
              tooltip: workspaceModeTechnicalHint("local"),
            },
            {
              action: "set-workspace-mode:worktree",
              active: workspaceMode === "worktree",
              badge:
                hasUserWorkspace && workspaceMode !== "worktree"
                  ? "Recommended"
                  : undefined,
              detail: hasUserWorkspace
                ? undefined
                : workspaceModeDetail("worktree", { hasWorkspace: false }),
              icon: GitBranch,
              kind: "workspace-mode",
              label: workspaceModePopoverLabel("worktree"),
              tooltip: workspaceModeTechnicalHint("worktree"),
            },
          ]
        : branchPopoverItems({
            branchCatalog,
            branchName: branchLabel,
            isDisabled: isSending,
            isLoading: isBranchLoading,
            workspaceMode,
            workspacePath,
          });
  return (
    <section className="gyro-composer-context-row gyro-composer-reveal">
      <div className="gyro-composer-control" ref={popoverScopeRef}>
        {(
          [
            [
              "project",
              Folder,
              projectLabel,
              "Project",
              workspacePath ?? projectLabel,
            ],
            [
              "workspace-mode",
              Laptop,
              modeChipLabel,
              "Workspace mode",
              modeChipLabel,
            ],
            ["branch", GitBranch, branchLabel, "Branch", branchLabel],
          ] as const
        ).map(([popover, Icon, label, name, title]) => (
          <button
            aria-controls={
              activePopover === popover ? `${popoverBaseId}-context` : undefined
            }
            aria-expanded={activePopover === popover}
            aria-haspopup="menu"
            aria-label={`${name}: ${label}`}
            className={`gyro-composer-chip gyro-context-summary-item is-${popover}`}
            data-tour={popover === "project" ? "composer.project" : undefined}
            key={popover}
            onClick={() => {
              setActivePopover((current) =>
                current === popover ? null : popover,
              );
              if (popover === "branch" && activePopover !== "branch") {
                onAction?.("select-branch");
              }
            }}
            title={title}
            type="button"
          >
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
            {popover === "branch" ? (
              <ChevronDown size={13} aria-hidden="true" />
            ) : null}
          </button>
        ))}
        {activePopover ? (
          <ComposerPopover
            className={
              activePopover === "project"
                ? "gyro-project-picker"
                : activePopover === "branch"
                  ? "gyro-chat-context-branch-picker"
                  : undefined
            }
            id={`${popoverBaseId}-context`}
            keepInBounds
            items={items}
            onAction={runAction}
            placement="up"
            title={
              activePopover === "workspace-mode"
                ? "Workspace mode"
                : activePopover === "project"
                  ? "Project"
                  : "Branch"
            }
          />
        ) : null}
      </div>
    </section>
  );
}

export function formatAttachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A reading younger than this already answers a hover on the context meter. */
export const CONTEXT_METER_USAGE_REFRESH_MIN_AGE_MS = 15_000;

/** Plan limits turn at 80% and 95%. Context uses the same bands. */
export function contextMeterSeverity(
  usage: { contextWindowTokens: number; percent: number } | undefined,
  source: "reported" | "estimated" | "empty",
) {
  if (!usage || source === "empty" || usage.contextWindowTokens <= 0) {
    return "normal" as const;
  }
  if (usage.percent >= 95) return "critical" as const;
  if (usage.percent >= 80) return "warning" as const;
  return "normal" as const;
}

export function ComposerLimitRow({ window }: { window: ComposerLimitWindow }) {
  const measured = window.remainingPercent !== undefined;
  return (
    <div className={`gyro-composer-limit-row is-${window.severity}`}>
      <div className="gyro-composer-limit-heading">
        <strong>{window.label}</strong>
        <b className={measured ? undefined : "is-unmeasured"}>
          {measured
            ? `${window.remainingPercentLabel} left`
            : window.status === "exhausted"
              ? window.percentLabel
              : "Not reported"}
        </b>
      </div>
      <div
        aria-label={`${window.label}: ${
          measured
            ? `${window.remainingPercentLabel} left`
            : "level not reported"
        }`}
        aria-valuemax={100}
        aria-valuemin={0}
        {...(measured ? { "aria-valuenow": window.remainingPercent } : {})}
        className={`gyro-composer-limit-bar${measured ? "" : " is-unmeasured"}`}
        role="progressbar"
      >
        {measured ? (
          <span style={{ width: `${window.remainingPercent}%` }} />
        ) : null}
      </div>
      {window.resetsLabel ? (
        <em className="gyro-composer-limit-reset">{window.resetsLabel}</em>
      ) : null}
    </div>
  );
}

export const PLAN_USAGE_NOTICE_STORAGE_KEY = "gyro.plan-usage-notices.v1";

export function usageNoticeKey(notice: PlanUsageNotice) {
  return [
    notice.providerId,
    notice.windowId,
    notice.cycleId,
    notice.threshold,
  ].join(":");
}

export function loadShownPlanUsageNotices() {
  if (typeof window === "undefined") return {} as Record<string, true>;
  try {
    const value = window.localStorage.getItem(PLAN_USAGE_NOTICE_STORAGE_KEY);
    const parsed = value ? JSON.parse(value) : undefined;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, true>)
      : {};
  } catch {
    return {} as Record<string, true>;
  }
}

/** A progressive, once-per-window notice for provider-reported plan usage. */
export function PlanUsageNotification({
  dailyPaceWarning = true,
  onHandoff,
  paused = false,
  providerId,
  providerLedger,
  providers,
  windows,
}: {
  dailyPaceWarning?: boolean;
  onHandoff: (providerId: ProviderId) => void;
  paused?: boolean;
  providerId: ProviderId;
  providerLedger?: ProviderLedgerSummary;
  providers: Array<{ id: ProviderId; label: string }>;
  windows: ProviderUsageState["windows"];
}) {
  const [shown, setShown] = useState(loadShownPlanUsageNotices);
  const [notice, setNotice] = useState<PlanUsageNotice>();
  const candidates = useMemo(() => {
    const plan = planUsageNotices(providerId, windows);
    const daily = dailyPaceNotice(providerId, {
      enabled: dailyPaceWarning,
      ledger: providerLedger,
      paused,
      windows,
    });
    return daily
      ? [...plan, daily].sort((left, right) => right.threshold - left.threshold)
      : plan;
  }, [dailyPaceWarning, paused, providerId, providerLedger, windows]);

  useEffect(() => {
    const next = candidates.find(
      (candidate) => !shown[usageNoticeKey(candidate)],
    );
    if (!next) return;
    const key = usageNoticeKey(next);
    setShown((current) => {
      const updated: Record<string, true> = { ...current, [key]: true };
      try {
        window.localStorage.setItem(
          PLAN_USAGE_NOTICE_STORAGE_KEY,
          JSON.stringify(updated),
        );
      } catch {
        // Notifications remain correct for this open chat even when storage is unavailable.
      }
      return updated;
    });
    setNotice(next);
  }, [candidates, shown]);

  if (!notice) return null;
  const isDailyPace = notice.threshold === DAILY_PACE_NOTICE_PERCENT;
  const handoffTarget =
    !isDailyPace && notice.threshold >= 95 ? providers[0] : undefined;
  const tone =
    notice.threshold >= 95
      ? "critical"
      : notice.threshold >= 80
        ? "warning"
        : "info";
  const title = isDailyPace
    ? "Daily pace warning"
    : notice.threshold >= 95
      ? "Plan limit nearly reached"
      : notice.threshold >= 90
        ? "Plan limit is close"
        : notice.threshold >= 80
          ? "Plan allowance is running low"
          : "Half of this plan window is left";
  const detail = isDailyPace
    ? notice.windowId === "day"
      ? `Today’s activity is above an even weekly pace (~${DAILY_PACE_NOTICE_PERCENT}% per day).`
      : `${notice.windowLabel} has ${remainingUsage(notice.percent).percentLabel} left and is more than a day ahead of an even weekly pace (~${DAILY_PACE_NOTICE_PERCENT}% per day).`
    : `${notice.windowLabel} has ${remainingUsage(notice.percent).percentLabel} left.${
        notice.threshold >= 90 ? " Consider wrapping up this window." : ""
      }`;

  return (
    <section
      aria-live="polite"
      className={`gyro-plan-usage-notice is-${tone}`}
      role="status"
    >
      <TriangleAlert aria-hidden="true" size={17} />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <div className="gyro-plan-usage-notice-actions">
        {handoffTarget ? (
          <button
            className="gyro-secondary-button"
            onClick={() => {
              onHandoff(handoffTarget.id);
              setNotice(undefined);
            }}
            type="button"
          >
            Continue with {handoffTarget.label}
            <ChevronRight aria-hidden="true" size={15} />
          </button>
        ) : null}
        <button
          aria-label="Dismiss usage notice"
          className="gyro-plan-usage-notice-dismiss"
          onClick={() => setNotice(undefined)}
          type="button"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>
    </section>
  );
}

export type ComposerPopoverId =
  "approval" | "branch" | "context" | "project" | "provider" | "workspace-mode";

export type ComposerPopoverItem = {
  label: string;
  detail?: string;
  tooltip?: string;
  action?: string;
  removeAction?: string;
  icon: IconComponent;
  kind?:
    | "back"
    | "branch"
    | "branch-action"
    | "disclosure"
    | "effort"
    | "model"
    | "permission-direct"
    | "project"
    | "provider"
    | "setting"
    | "warning"
    | "workspace-mode";
  /** Disclosure rows draw a caret instead of a value; which way it points. */
  caret?: "up" | "down";
  /**
   * Navigation inside a drill-down menu. These rows move between panels
   * rather than doing anything, so they carry a destination instead of an
   * action string the composer would have to pretend to handle.
   */
  menuPane?:
    "root" | "model" | "effort" | "provider" | "provider-model" | "settings";
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
  /** Catalog window for a model row, used to preview remaining context live. */
  contextWindowTokens?: number;
};

export type ComposerSlashCommand = {
  command: string;
  label: string;
  /** Concise copy shown in the full `/help` catalog. */
  description: string;
  icon: IconComponent;
  /** Commands whose provider or workspace cannot support them stay out of the menu. */
  available?: boolean;
  action?: string;
  popover?: Extract<ComposerPopoverId, "approval" | "branch" | "provider">;
  /** Plain-language explainer shown when hovering the row's "?" marker. */
  hint?: string;
};

export function branchPopoverItems({
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
  const busy = isDisabled ? "Wait for the active turn to finish" : undefined;
  const createBranchItem: ComposerPopoverItem = {
    action: `create-branch-from:${encodeURIComponent(branchCatalog.current ?? "")}`,
    disabled: isDisabled,
    icon: Plus,
    kind: "branch-action",
    label: "New branch",
    tooltip:
      busy ??
      (branchCatalog.current
        ? `Branch from ${branchCatalog.current}`
        : "Branch from the current commit"),
  };
  // One line per branch: what each row does lives in its tooltip, and the
  // current branch leads the list so it never scrolls out of view.
  const branchItems = [...branchCatalog.branches]
    .sort(
      (a, b) =>
        Number(b === branchCatalog.current) -
        Number(a === branchCatalog.current),
    )
    .map((branch): ComposerPopoverItem => {
      const inWorktree =
        branch !== branchCatalog.current &&
        Boolean(
          branchCatalog.worktrees?.some(
            (worktree) => worktree.branch === branch,
          ),
        );
      return {
        action: `select-branch:${encodeURIComponent(branch)}`,
        active: branch === branchCatalog.current,
        badge: inWorktree ? "worktree" : undefined,
        disabled: isDisabled,
        icon: GitBranch,
        kind: "branch",
        label: branch,
        removeAction: inWorktree
          ? `remove-worktree:${encodeURIComponent(branch)}`
          : undefined,
        tooltip:
          busy ??
          (branch === branchCatalog.current
            ? "Current workspace branch"
            : inWorktree
              ? "Checked out in a linked worktree"
              : "Switch branch; keep compatible local changes"),
      };
    });
  return [
    ...branchItems,
    createBranchItem,
    ...(branchCatalog.current
      ? [
          {
            action: `rename-current-branch:${encodeURIComponent(branchCatalog.current)}`,
            disabled: isDisabled,
            icon: Edit3,
            kind: "branch-action" as const,
            label: "Rename",
            tooltip:
              busy ?? `Rename current branch… (${branchCatalog.current})`,
          },
        ]
      : []),
  ];
}

/**
 * Dim the folder part of `release/v0.1.0` and let it give way first when the
 * row is narrow, so the part that tells branches apart stays readable.
 */
export function BranchLabel({ name }: { name: string }) {
  const slash = name.lastIndexOf("/");
  if (slash < 0) return <>{name}</>;
  return (
    <>
      <span className="gyro-branch-label-prefix">
        {name.slice(0, slash + 1)}
      </span>
      <span className="gyro-branch-label-leaf">{name.slice(slash + 1)}</span>
    </>
  );
}

export function ComposerPopover({
  align = "start",
  className,
  keepInBounds = false,
  id,
  items,
  onAction,
  placement = "up",
  title,
}: {
  align?: "start" | "end";
  className?: string;
  keepInBounds?: boolean;
  id: string;
  items: ComposerPopoverItem[];
  onAction: (action?: string, item?: ComposerPopoverItem) => void;
  placement?: "up" | "down";
  title?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  // Long branch lists get a filter; short ones stay a plain menu.
  const searchable = items.filter((item) => item.kind === "branch").length >= 6;
  const needle = query.trim().toLowerCase();
  const visibleItems = needle
    ? items.filter(
        (item) =>
          item.kind !== "branch" || item.label.toLowerCase().includes(needle),
      )
    : items;
  const listItems = visibleItems.filter(
    (item) => item.kind !== "branch-action",
  );
  const footerItems = visibleItems.filter(
    (item) => item.kind === "branch-action",
  );
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!keepInBounds || !panel) return;
    const position = (event?: Event) => {
      if (
        event?.type === "scroll" &&
        event.target instanceof Node &&
        panel.contains(event.target)
      )
        return;
      const scrollTop = panel.scrollTop;
      // Start from the CSS anchor each time so resizing never accumulates drift.
      panel.style.top = "";
      panel.style.bottom = "";
      panel.style.maxHeight = "";
      panel.style.translate = "";
      const bounds = clippingBounds(panel);
      const anchorElement =
        panel.offsetParent instanceof HTMLElement
          ? panel.offsetParent
          : panel.parentElement!;
      const anchor = anchorElement.getBoundingClientRect();
      const anchorStyle = window.getComputedStyle(anchorElement);
      const scaleX = anchor.width / parseFloat(anchorStyle.width) || 1;
      const scaleY = anchor.height / parseFloat(anchorStyle.height) || 1;
      const pad = 8;
      const gap = 8 * scaleY;
      if (panel.closest(".gyro-chat-surface.is-tiled")) {
        panel.style.minWidth = "0";
        panel.style.maxWidth = `${Math.max(0, bounds.right - bounds.left - pad * 2) / scaleX}px`;
      }
      const anchorTop = anchor.top;
      const anchorBottom = anchor.bottom;
      const above = Math.max(0, anchorTop - bounds.top - pad - gap);
      const below = Math.max(0, bounds.bottom - anchorBottom - pad - gap);
      const preferred = placement === "up" ? above : below;
      const opposite = placement === "up" ? below : above;
      const flip =
        panel.offsetHeight * scaleY > preferred && opposite > preferred;
      const direction = flip ? (placement === "up" ? "down" : "up") : placement;
      panel.style.top = direction === "down" ? "calc(100% + 8px)" : "auto";
      panel.style.bottom = direction === "up" ? "calc(100% + 8px)" : "auto";
      panel.style.maxHeight = `${Math.min(420, (direction === "up" ? above : below) / scaleY)}px`;
      const positioned = panel.getBoundingClientRect();
      const shift = Math.max(
        bounds.left + pad - positioned.left,
        Math.min(0, bounds.right - pad - positioned.right),
      );
      panel.style.translate = `${shift / scaleX}px 0`;
      panel.scrollTop = scrollTop;
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    const observer = new ResizeObserver(() => position());
    for (
      let ancestor = panel.parentElement;
      ancestor && ancestor !== document.body;
      ancestor = ancestor.parentElement
    ) {
      observer.observe(ancestor);
    }
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      observer.disconnect();
    };
  }, [keepInBounds, placement, items]);
  return (
    <div
      ref={panelRef}
      style={
        keepInBounds
          ? {
              gridAutoRows: "max-content",
              alignContent: "start",
              overflowY: "auto",
            }
          : undefined
      }
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
      {searchable ? (
        <label className="gyro-composer-menu-search">
          <Search aria-hidden="true" size={13} />
          <input
            aria-label="Find branch"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find branch…"
            spellCheck={false}
            type="search"
            value={query}
          />
        </label>
      ) : null}
      {searchable &&
      needle &&
      !listItems.some((item) => item.kind === "branch") ? (
        <div className="gyro-composer-menu-empty">No matching branches</div>
      ) : null}
      {listItems.map(renderItem)}
      {footerItems.length ? (
        <div className="gyro-composer-menu-footer" role="group">
          {footerItems.map(renderItem)}
        </div>
      ) : null}
    </div>
  );

  function renderItem(item: ComposerPopoverItem, index: number) {
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
          <ProviderLogo label={item.label} providerId={item.providerId} />
        ) : (
          <Icon size={14} />
        )}
        <span>
          <span className="gyro-composer-menu-item-title">
            <strong>
              {item.kind === "branch" ? (
                <BranchLabel name={item.label} />
              ) : (
                item.label
              )}
            </strong>
            {item.badge ? (
              <em className="gyro-composer-menu-badge">{item.badge}</em>
            ) : null}
          </span>
          {item.detail ? <small>{item.detail}</small> : null}
        </span>
        {item.kind === "setting" || item.kind === "disclosure" ? (
          <>
            {item.trailingLabel ? (
              <em className="gyro-composer-menu-trailing">
                {item.trailingLabel}
              </em>
            ) : null}
            {/* Settings rows drill into their own list; disclosure rows
                    fold a section open in place, so they point differently.
                    Both are navigation, so they carry the caret class that
                    keeps them quiet — the accent belongs to the checkmark. */}
            {item.kind === "disclosure" ? (
              item.caret === "up" ? (
                <ChevronUp className="gyro-composer-menu-caret" size={13} />
              ) : (
                <ChevronDown className="gyro-composer-menu-caret" size={13} />
              )
            ) : (
              <ChevronRight className="gyro-composer-menu-caret" size={13} />
            )}
          </>
        ) : item.trailingLabel ? (
          <em className="gyro-composer-menu-trailing">{item.trailingLabel}</em>
        ) : item.active ? (
          <Check size={13} />
        ) : item.providerId && item.showChevron !== false ? (
          <ChevronRight className="gyro-composer-menu-caret" size={13} />
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
          role="menuitem"
          title={item.tooltip}
          type="button"
        >
          {itemContent}
        </button>
      </Fragment>
    );
  }
}

/** CLI, API, and local runtimes are separate catalog connections. */
/** Same order as the provider list: connected A–Z, then the rest A–Z. */
export function modelRailProvidersFor(providerConfigs: ModelProviderConfig[]) {
  return providerConfigs
    .filter((provider) => isProviderExecutable(provider.id))
    .map((provider) => ({
      id: provider.id,
      label: provider.displayName,
      connection: providerConnectionKind(provider.capabilities?.executionKind),
      connected: provider.authStatus === "connected",
      models: provider.models,
    }))
    .sort(
      (left, right) =>
        Number(right.connected) - Number(left.connected) ||
        left.label.localeCompare(right.label, undefined, {
          sensitivity: "base",
        }),
    );
}

export function providerConnectionKind(
  executionKind: string | undefined,
): "CLI" | "API" | "Local" {
  if (executionKind === "openai-compatible-api") return "API";
  if (executionKind === "ollama-api") return "Local";
  return "CLI";
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

export type ApprovalCopy = {
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

export function approvalModeForConfig(config: GyroConfig) {
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

export function approvalBackendSummary(config: GyroConfig) {
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

export function providerApprovalCopy(
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
  const base = isAnthropic
    ? {
        title: providerTitle,
        gatedLabel: "Ask for approval",
        gatedDetail: "Always ask before commands and file edits",
        autoLabel: "Approve for me",
        autoDetail: "Allow work within provider and project limits",
        directLabel: "Full access",
        directDetail:
          "Unrestricted access to the internet and any file on your computer",
        commandValue: config.requireCommandApproval ? "Ask first" : "Allow",
        commandDetail: "Claude tool calls use the backend command policy.",
        editValue: config.requireFileEditApproval ? "Review" : "Auto-accept",
        editDetail: "Claude edits follow the backend diff policy.",
      }
    : {
        title: providerTitle,
        gatedLabel: "Ask for approval",
        gatedDetail: "Always ask before commands and file edits",
        autoLabel: "Approve for me",
        autoDetail: "Allow work within provider and project limits",
        directLabel: "Full access",
        directDetail:
          "Unrestricted access to the internet and any file on your computer",
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

export function composerModelPickerItem(
  providerId: ProviderId,
  model: { id: string; displayName: string; contextWindowTokens?: number },
  activeModelId: string | undefined,
): ComposerPopoverItem {
  return {
    action: `select-provider-model:${providerId}:${model.id}`,
    active: model.id === activeModelId,
    contextWindowTokens: model.contextWindowTokens,
    hideIcon: true,
    icon: Sparkles,
    kind: "model",
    label: model.displayName,
  };
}

/**
 * Every way the goal can be changed. The composer, the chat surface and the
 * plan rail all speak this one set, so a control added to any of them is a
 * control the others already handle.
 */
export type SessionGoalAction =
  "set" | "edit" | "complete" | "reopen" | "clear" | "pause" | "resume";

/**
 * The composer renders from three sibling branches (start screen, thread dock,
 * side-chat dock), so a branch flip unmounts the textarea and focus falls to
 * <body>: keystrokes then vanish with nothing on screen to explain it. A removed
 * element does not fire `blur`, so this module flag survives the swap and the
 * replacement composer reclaims the caret.
 */
export let composerWantsFocus = false;

export function Composer({
  attachments = [],
  chatMode = "normal",
  draftKey = NEW_CHAT_DRAFT_KEY,
  constrainToParent = false,
  draft,
  branchName,
  branchCatalog,
  onDraftChange,
  onRemoveAttachment,
  canAttachEditorSnapshot = false,
  onAttachMediaFiles,
  onAttachMediaPaths,
  onMediaDropError,
  onSend,
  onStop,
  worktreeName,
  workspacePath,
  workspaceMode = "local",
  config,
  providerReadiness,
  providerStatuses,
  providerUsage,
  providerUsageByProvider,
  providerLedger,
  dailyPaceWarning = true,
  limitWindows = [],
  canCompactContext = false,
  onComposerAction,
  onCancelGoalComposer,
  dictation = browserDictation(),
  overlay,
  onGoalAction,
  sessionModel,
  sessionGoal,
  promptHistory = [],
  contextUsage,
  sessionUsage,
  usageSafety,
  onResumeUsage,
  isGoalComposerActive = false,
  isGoalModeActive = false,
  startsGoalSession = false,
  savedProjects = [],
  surfaceControls,
  isSending = false,
  isBranchLoading,
  maxDraftLength,
  popoverPlacement,
  /** False while the desktop shell is still warming the backend. */
  shellReady = true,
  isCliUpdating = false,
  sendDisabledReason,
  showContextRow,
  variant = "thread",
}: {
  attachments?: ChatAttachment[];
  chatMode?: ChatMode;
  /**
   * Which draft this composer edits, so a drop routed from the window reaches
   * the chat it landed on rather than whichever one happens to be focused.
   */
  draftKey?: string;
  constrainToParent?: boolean;
  draft: string;
  branchName?: string;
  branchCatalog?: GitBranchCatalog;
  onDraftChange: (value: string) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  /** True when an open project file can be captured for the Editor action. */
  canAttachEditorSnapshot?: boolean;
  onAttachMediaFiles?: (files: File[]) => void;
  onAttachMediaPaths?: (paths: string[]) => void;
  onMediaDropError?: (message: string) => void;
  onSend: () => void;
  onStop?: () => void;
  worktreeName?: string;
  workspacePath?: string;
  workspaceMode?: WorkbenchMode;
  config: GyroConfig;
  providerReadiness?: ProviderReadiness;
  providerStatuses?: ProviderStatus[];
  providerUsage?: ProviderUsageState;
  providerUsageByProvider?: Partial<Record<ProviderId, ProviderUsageState>>;
  providerLedger?: ProviderLedgerSummary;
  dailyPaceWarning?: boolean;
  limitWindows?: ComposerLimitWindow[];
  /** This chat has a provider-backed context that can be compacted manually. */
  canCompactContext?: boolean;
  onComposerAction?: (action: string) => void;
  onCancelGoalComposer?: () => void;
  /** Local speech-to-text. Defaults to the browser microphone. */
  dictation?: DictationController;
  /** Covers the whole composer while it asks for a decision, e.g. plan approval. */
  overlay?: ReactNode;
  /**
   * Complete, reopen or clear the goal from the strip that rides on the
   * composer. Absent in read-only embeds, where the strip shows state only.
   */
  onGoalAction?: (
    action: SessionGoalAction,
    value?: string,
  ) => boolean | void | Promise<boolean | void>;
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
  /** Goal mode stays selected after the goal is saved, like Plan. */
  isGoalModeActive?: boolean;
  /** The Goal chip will create a new chat and send the same text. */
  startsGoalSession?: boolean;
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
  shellReady?: boolean;
  /** A provider executable is updating; wait before starting a run. */
  isCliUpdating?: boolean;
  sendDisabledReason?: string;
  /** Defaults to the hero layout: project, mode, and branch only at the start. */
  showContextRow?: boolean;
  variant?: "thread" | "hero";
}) {
  const [activePopover, setActivePopover] = useState<ComposerPopoverId | null>(
    null,
  );
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    // Reclaim the caret after a branch swap removed the focused textarea.
    const textarea = composerTextareaRef.current;
    if (!composerWantsFocus || !textarea) return;
    composerWantsFocus = false;
    const active = document.activeElement;
    if (active && active !== document.body && active !== textarea) return;
    textarea.focus({ preventScroll: true });
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }, []);
  const dictationAnchorRef = useRef<{ base: string; caret: number } | null>(
    null,
  );
  const dictationAppliedRef = useRef<string | null>(null);
  const dictationCaretRef = useRef<number | null>(null);
  /** Caret the user last placed. Unset means dictation appends. */
  const dictationCaretChoiceRef = useRef<number | null>(null);
  const dictationSessionRef = useRef<AbortController | null>(null);
  /** Pending settle timer: a stop shows the processing ring, then clears. */
  const dictationSettleRef = useRef<number | null>(null);
  const [dictationPhase, setDictationPhase] = useState<
    "idle" | "listening" | "processing"
  >("idle");
  const [dictationNotice, setDictationNotice] = useState("");
  const releaseDictation = useCallback(
    (restoreBase: boolean) => {
      const anchor = dictationAnchorRef.current;
      if (dictationSettleRef.current !== null) {
        window.clearTimeout(dictationSettleRef.current);
        dictationSettleRef.current = null;
      }
      dictationSessionRef.current?.abort();
      dictationSessionRef.current = null;
      dictationAnchorRef.current = null;
      if (restoreBase) dictationCaretRef.current = null;
      dictation?.stop();
      setDictationPhase("idle");
      if (
        restoreBase &&
        anchor &&
        anchor.base !== dictationAppliedRef.current
      ) {
        dictationAppliedRef.current = anchor.base;
        dictationCaretRef.current = anchor.caret;
        dictationCaretChoiceRef.current = anchor.caret;
        onDraftChange(anchor.base);
      }
    },
    [dictation, onDraftChange],
  );
  /**
   * Stop from the mic: keep the words already applied to the draft, show the
   * processing ring, and clear the badge once the session settles.
   */
  const settleDictation = useCallback(() => {
    const session = dictationSessionRef.current;
    setDictationPhase("processing");
    dictation?.stop();
    if (dictationSettleRef.current !== null) {
      window.clearTimeout(dictationSettleRef.current);
    }
    // A late final still lands in the draft, so hold the session open briefly.
    dictationSettleRef.current = window.setTimeout(() => {
      dictationSettleRef.current = null;
      session?.abort();
      dictationSessionRef.current = null;
      dictationAnchorRef.current = null;
      dictationCaretRef.current = null;
      setDictationPhase("idle");
    }, 900);
  }, [dictation]);
  const toggleDictation = useCallback(() => {
    if (!dictation) return;
    if (dictationPhase === "processing") return;
    if (dictationAnchorRef.current) {
      settleDictation();
      return;
    }
    const textarea = composerTextareaRef.current;
    const caret = dictationCaretChoiceRef.current ?? draft.length;
    const at = Math.min(Math.max(0, caret), draft.length);
    dictationAnchorRef.current = { base: draft, caret: at };
    dictationAppliedRef.current = draft;
    const session = new AbortController();
    dictationSessionRef.current = session;
    setDictationNotice("");
    setDictationPhase("listening");
    textarea?.focus({ preventScroll: true });
    const limit = isGoalComposerActive ? 1000 : maxDraftLength;
    const applyUtterance = (utterance: string) => {
      const anchor = dictationAnchorRef.current;
      if (!anchor || session.signal.aborted) return;
      const next = dictationDraft(anchor.base, anchor.caret, utterance, limit);
      dictationAppliedRef.current = next.draft;
      dictationCaretRef.current = next.caret;
      dictationCaretChoiceRef.current = next.caret;
      onDraftChange(next.draft);
    };
    dictation.start({
      signal: session.signal,
      onPartial: applyUtterance,
      onFinal: (utterance) => {
        if (session.signal.aborted) return;
        applyUtterance(utterance);
        if (dictationSettleRef.current !== null) {
          window.clearTimeout(dictationSettleRef.current);
          dictationSettleRef.current = null;
        }
        dictationAnchorRef.current = null;
        dictationSessionRef.current = null;
        setDictationPhase("idle");
        dictation.stop();
      },
      onError: (message) => {
        if (session.signal.aborted) return;
        session.abort();
        dictationSessionRef.current = null;
        const anchor = dictationAnchorRef.current;
        dictationAnchorRef.current = null;
        if (anchor && anchor.base !== dictationAppliedRef.current) {
          dictationAppliedRef.current = anchor.base;
          dictationCaretRef.current = anchor.caret;
          dictationCaretChoiceRef.current = anchor.caret;
          onDraftChange(anchor.base);
        }
        setDictationNotice(message);
        setDictationPhase("idle");
        dictation.stop();
      },
    });
  }, [
    dictation,
    draft,
    isGoalComposerActive,
    maxDraftLength,
    onDraftChange,
    settleDictation,
  ]);
  useEffect(() => {
    return () => {
      if (dictationSettleRef.current !== null) {
        window.clearTimeout(dictationSettleRef.current);
        dictationSettleRef.current = null;
      }
      dictationSessionRef.current?.abort();
      dictationSessionRef.current = null;
      dictationAnchorRef.current = null;
      dictation?.stop();
    };
  }, [dictation]);
  useLayoutEffect(() => {
    const caret = dictationCaretRef.current;
    const textarea = composerTextareaRef.current;
    if (caret == null || !textarea) return;
    textarea.setSelectionRange(caret, caret);
    if (dictationPhase !== "listening") dictationCaretRef.current = null;
  }, [dictationPhase, draft]);
  const hadComposerOverlayRef = useRef(Boolean(overlay));
  useEffect(() => {
    const wasCovered = hadComposerOverlayRef.current;
    hadComposerOverlayRef.current = Boolean(overlay);
    // Closing a decision card unmounts its focused control. Return to the
    // revealed composer, while preserving focus if the user moved elsewhere.
    if (wasCovered && !overlay && document.activeElement === document.body) {
      composerTextareaRef.current?.focus({ preventScroll: true });
    }
  }, [overlay]);
  /**
   * Stop only when the press started on the stop control itself.
   *
   * Grid slots focus the pane on pointerdown. That used to re-layout the
   * composer under the finger so a press that began on empty margin could
   * finish as a click on Stop — reading as "click empty margin → stop".
   * Arming on pointerdown and requiring it on click keeps stop intentional.
   */
  const stopArmedRef = useRef(false);
  const [modelPickerProviderId, setModelPickerProviderId] = useState<
    ProviderId | undefined
  >(undefined);
  // Model and effort open from independent composer controls.
  const modelMenuEntry = useRef<"root" | "model">("root");
  const modelMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [modelMenuPane, setModelMenuPane] = useState<
    "root" | "model" | "effort" | "provider" | "provider-model" | "settings"
  >("root");
  const [isModelMenuAdvancedOpen, setIsModelMenuAdvancedOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState<number>();
  const [activeSlashCommandIndex, setActiveSlashCommandIndex] = useState(0);
  const [isSlashMenuDismissed, setIsSlashMenuDismissed] = useState(false);
  /** `/help` keeps the catalog open after removing its inline trigger. */
  const [isSlashHelpOpen, setIsSlashHelpOpen] = useState(false);
  // Hover explainer for a slash command. Positioned fixed against the "?"
  // marker so it can escape the menu's own scroll clipping.
  const [slashHint, setSlashHint] = useState<{
    text: string;
    top: number;
    left: number;
  }>();
  const slashCommandRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dismissActiveComposerPopover = useCallback(() => {
    setActivePopover(null);
    setModelPickerProviderId(undefined);
  }, [setModelPickerProviderId]);
  // Scoped to the open control (its trigger plus panel) rather than the whole
  // composer, so pressing the textarea or any other chip closes the dropdown.
  const popoverScopeRef = useOutsidePointerDismiss<HTMLDivElement>(
    Boolean(activePopover),
    dismissActiveComposerPopover,
    activePopover === "provider" ? modelMenuTriggerRef : undefined,
    () => {
      if (
        activePopover !== "provider" ||
        modelMenuPane === "root" ||
        modelMenuEntry.current === "model"
      )
        return false;
      // The model rail is one level deep: Escape goes straight back to root.
      setModelMenuPane("root");
      requestAnimationFrame(() =>
        popoverScopeRef.current
          ?.querySelector<HTMLElement>('[role="menuitem"], input[type="range"]')
          ?.focus(),
      );
      return true;
    },
  );
  const popoverBaseId = useId();
  // Closing the control forgets its previous submenu.
  useEffect(() => {
    if (activePopover !== "provider") {
      setModelMenuPane("root");
      setIsModelMenuAdvancedOpen(false);
    }
  }, [activePopover]);
  useEffect(() => {
    if (isGoalComposerActive) {
      composerTextareaRef.current?.focus();
    }
  }, [isGoalComposerActive]);
  useEffect(() => {
    const focus = () => {
      const textarea = composerTextareaRef.current;
      if (!textarea || textarea.getClientRects().length === 0) return;
      textarea.focus();
    };
    window.addEventListener("gyro-focus-composer", focus);
    return () => window.removeEventListener("gyro-focus-composer", focus);
  }, []);
  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;

    const updateHeight = () => {
      // Collapse the previous height before measuring wrapped text. An empty
      // field uses the same height as one line, so the first character does
      // not shrink the composer.
      textarea.style.height = "0px";
      const contentHeight = textarea.scrollHeight;
      const lineHeight = 52;
      const nextHeight =
        draft.length === 0
          ? lineHeight
          : Math.min(Math.max(contentHeight, lineHeight), 148);
      textarea.style.height = `${nextHeight}px`;
      textarea.style.overflowY =
        draft.length > 0 && contentHeight > 148 ? "auto" : "hidden";
    };
    updateHeight();

    let frame = 0;
    let disposed = false;
    let width = textarea.clientWidth;
    const scheduleHeightUpdate = () => {
      if (disposed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateHeight);
    };
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.clientWidth;
      // Height changes from autosizing must not feed back into this observer.
      if (nextWidth > 0 && nextWidth !== width) {
        width = nextWidth;
        scheduleHeightUpdate();
      }
    });
    observer.observe(textarea);
    void document.fonts.ready.then(scheduleHeightUpdate);

    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [attachments.length, draft]);
  const providerConfigs = providersForConfig(config);
  // Each chat pane may bind its own provider/model. Prefer that over the
  // workbench-wide selection so split-screen composers can diverge.
  const boundToSession = Boolean(sessionModel?.providerId);
  const effectiveProviderId = boundToSession
    ? sessionModel?.providerId
    : config.selectedProviderId;
  const selectedProvider = providerConfigs.find(
    (provider) => provider.id === effectiveProviderId,
  );
  const sessionProvider = sessionModel?.providerId
    ? providerConfigs.find(
        (provider) => provider.id === sessionModel.providerId,
      )
    : undefined;
  const displayProvider = selectedProvider ?? sessionProvider;
  const [previewedAttachmentId, setPreviewedAttachmentId] = useState<string>();
  const previewedTerminalAttachment = attachments.find(
    (attachment) =>
      attachment.id === previewedAttachmentId &&
      attachment.kind === "terminal-output",
  );
  const usageProviderId = providerUsage?.providerId ?? effectiveProviderId;
  const usageFetchedAt = providerUsage?.fetchedAt;
  const usageLoading = providerUsage?.status === "loading";
  // An empty thread has nothing to measure yet. Printing "0 of 1M" there
  // claims a reading nobody took — the system prompt alone is not zero.
  const contextSource: "reported" | "estimated" | "empty" = !contextUsage
    ? "empty"
    : contextUsage.source === "reported"
      ? "reported"
      : contextUsage.usedTokens > 0
        ? "estimated"
        : "empty";
  // The meter shows a provider measurement or nothing. The tilde caption
  // stays only for a positive count that is still marked estimated.
  const providerMeasured = Boolean(
    contextUsage &&
    (contextUsage.detail.startsWith("Latest context usage") ||
      contextUsage.detail.startsWith("Provider-reported")),
  );
  const contextSeverity = contextMeterSeverity(contextUsage, contextSource);
  const refreshContextMeterUsage = useCallback(() => {
    if (!usageProviderId || !providerSupportsUsage(usageProviderId)) return;
    const fetchedMs = usageFetchedAt ? Date.parse(usageFetchedAt) : NaN;
    if (
      usageLoading ||
      Date.now() - fetchedMs < CONTEXT_METER_USAGE_REFRESH_MIN_AGE_MS
    ) {
      return;
    }
    onComposerAction?.(`refresh-provider-usage:${usageProviderId}`);
  }, [onComposerAction, usageFetchedAt, usageLoading, usageProviderId]);
  const hasSelectedProvider = Boolean(
    selectedProvider ?? sessionModel?.modelLabel ?? sessionModel?.modelId,
  );
  const selectedProviderHealth = providerStatuses?.find(
    (status) => status.id === selectedProvider?.id,
  );
  const sessionProviderHealth = providerStatuses?.find(
    (status) => status.id === sessionProvider?.id,
  );
  const hasReadyProvider = Boolean(
    (selectedProvider &&
      isProviderRuntimeUsable(selectedProvider, selectedProviderHealth)) ||
    (sessionProvider &&
      isProviderRuntimeUsable(sessionProvider, sessionProviderHealth)),
  );
  const rawModelId = boundToSession
    ? sessionModel?.modelId
    : selectedProvider?.selectedModelId;
  const modelProviderId = boundToSession
    ? (sessionProvider?.id ?? selectedProvider?.id)
    : selectedProvider?.id;
  // A stored fast-pool id is still Grok 4.7. Fast mode keeps the raw id so a
  // chat launched on that pool stays fast until the user turns it off.
  const effectiveModelId = pickerModelId(modelProviderId, rawModelId);
  const resolvedBoundModel =
    selectedProvider && effectiveModelId
      ? getProviderModel(selectedProvider, effectiveModelId)
      : undefined;
  const providerModelLabel = boundToSession
    ? (sessionModel?.modelLabel ??
      resolvedBoundModel?.displayName ??
      sessionModel?.modelId ??
      selectedProvider?.displayName ??
      "Select provider")
    : selectedProvider
      ? selectedModelLabel(selectedProvider)
      : (sessionModel?.modelLabel ?? "Select provider");
  const modelChipLabel = hasSelectedProvider
    ? (pickerModelLabel(modelProviderId, rawModelId, providerModelLabel) ??
      providerModelLabel)
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
      : approvalMode === "auto"
        ? "gyro-composer-chip is-auto-approve"
        : "gyro-composer-chip";
  const ApprovalChipIcon =
    approvalMode === "direct"
      ? ShieldAlert
      : approvalMode === "auto"
        ? AutoApproveIcon
        : Hand;
  const isStopAction = Boolean(
    !isGoalComposerActive && isSending && onStop && draft.trim().length === 0,
  );
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
  const providerRuntimeBlock =
    selectedProvider?.id === "ollama" &&
    selectedProviderHealth?.runtimeStatus === "no-models"
      ? {
          action: "open-settings:providers",
          actionLabel: "Open provider settings",
          message:
            "Ollama is running, but no models are installed. Run `ollama pull <model>`, then test Ollama in provider settings.",
          placeholder: "Run ollama pull <model>, then test Ollama…",
          stepLabel: "Ollama needs a model",
        }
      : undefined;
  const providerErrorMessage =
    providerRuntimeBlock?.message ??
    (providerReadiness?.status === "blocked" && !hasReadyProvider
      ? providerReadiness.message
      : undefined);
  const canSubmitChat =
    shellReady &&
    !sendDisabledReason &&
    !isCliUpdating &&
    !isBranchLoading &&
    (chatMode === "council"
      ? councilEnabled &&
        !councilResolution?.error &&
        (councilResolution?.seats.length ?? 0) >= 2 &&
        hasUserWorkspace
      : canSendChat(hasReadyProvider, workspacePath));
  // Starting a goal sends a message, so it needs everything a send needs.
  const askAttachmentPending = useSyncExternalStore(
    subscribeExplorerAskSend,
    () => explorerAskSendHeld,
    () => false,
  );
  const canSubmitComposer =
    !askAttachmentPending &&
    (isGoalComposerActive && !startsGoalSession ? true : canSubmitChat);
  const needsProviderSetup =
    !boundToSession &&
    !providerConfigs.some((provider) =>
      isProviderRuntimeUsable(
        provider,
        providerStatuses?.find((status) => status.id === provider.id),
      ),
    );
  const cleanMachinePath = resolveCleanMachinePath({
    hasReadyProvider,
    preferredProviderId:
      hasSelectedProvider && !needsProviderSetup
        ? selectedProvider?.id
        : undefined,
    preferredProviderLabel: selectedProvider?.displayName,
    providerBlockAction: providerRuntimeBlock?.action,
    providerBlockActionLabel: providerRuntimeBlock?.actionLabel,
    providerBlockMessage: providerErrorMessage,
    providerBlockPlaceholder: providerRuntimeBlock?.placeholder,
    providerBlockStepLabel: providerRuntimeBlock?.stepLabel,
    workspacePath,
  });
  const isHero = variant === "hero";
  const shouldShowContextRow = showContextRow ?? isHero;
  const modelRailProviders = modelRailProvidersFor(providerConfigs);
  const isModelRailPane =
    modelMenuPane === "model" ||
    modelMenuPane === "provider" ||
    modelMenuPane === "provider-model";
  const handoffProviders = providerConfigs
    .filter(
      (provider) =>
        provider.authStatus === "connected" &&
        provider.id !== effectiveProviderId,
    )
    .map((provider) => ({ id: provider.id, label: provider.displayName }));
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
  // Direct access to models for the provider already in use.
  const currentModelItems: ComposerPopoverItem[] = displayProvider
    ? displayProvider.models.map((model) =>
        composerModelPickerItem(displayProvider.id, model, effectiveModelId),
      )
    : [];
  const hasEffortChoice = Boolean(
    providerReasoningEffort && effortItems.length > 0,
  );
  const modelMenuItems: ComposerPopoverItem[] = [
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
    {
      hideIcon: true,
      icon: Sparkles,
      kind: "setting" as const,
      label: "Model",
      // With no provider chosen there is no model list to show, so the row
      // leads to the providers instead of dead-ending on an empty panel.
      menuPane:
        currentModelItems.length > 0
          ? ("model" as const)
          : ("provider" as const),
      trailingLabel: modelChipLabel,
    },
    ...(hasEffortChoice && providerReasoningEffort
      ? [
          {
            hideIcon: true,
            icon: Gauge,
            kind: "setting" as const,
            label: "Effort",
            menuPane: "effort" as const,
            trailingLabel: reasoningEffortLabel(providerReasoningEffort),
          },
        ]
      : []),
    {
      caret: isModelMenuAdvancedOpen ? ("up" as const) : ("down" as const),
      hideIcon: true,
      icon: Sparkles,
      kind: "disclosure" as const,
      label: "Advanced",
    },
    ...(isModelMenuAdvancedOpen
      ? [
          {
            hideIcon: true,
            icon: Sparkles,
            kind: "setting" as const,
            label: "Provider",
            menuPane: "provider" as const,
            trailingLabel: displayProvider?.displayName ?? "Choose",
          },
        ]
      : []),
  ];
  const modelMenuBackItem = (label: string): ComposerPopoverItem => ({
    icon: ChevronLeft,
    kind: "back" as const,
    label,
    menuPane: "root" as const,
  });
  // One compact menu: attach, capture the open editor, plan, goal. The folder
  // chip and ⌘K already cover folder and search, and Council stays out of the
  // menu until it can run. Slash commands keep every action reachable.
  const contextItems: ComposerPopoverItem[] = [
    {
      action: "attach-files",
      icon: Paperclip,
      label: "Attach files",
      detail: "Add context to your message",
      tooltip: "Images, videos, or project files",
    },
    ...(canAttachEditorSnapshot
      ? [
          {
            action: "attach-editor-snapshot",
            icon: FileCode2,
            label: "Editor",
            detail: "Capture saved or unsaved editor text",
            tooltip: "Capture saved or unsaved editor text",
          },
        ]
      : []),
    // A mode that is already on shows its check, and picking it again turns
    // it off, so the menu never offers to switch on what is already running.
    {
      action:
        chatMode === "plan" ? "set-chat-mode-normal" : "set-chat-mode-plan",
      active: chatMode === "plan",
      icon: ListChecks,
      label: "Plan",
      detail:
        chatMode === "plan"
          ? "Turn Plan mode off"
          : "Think through the approach",
      tooltip: chatMode === "plan" ? "Turn Plan mode off" : undefined,
    },
    {
      action: "add-goal",
      active: isGoalModeActive,
      icon: Goal,
      label: "Set goal",
      detail: "Define the outcome",
    },
  ];
  const slashCommands: ComposerSlashCommand[] = [
    {
      command: "/help",
      description: "Browse every chat command",
      icon: HelpCircle,
      label: "Show command help",
    },
    {
      action: "compact-context",
      command: "/compact",
      description: "Condense earlier conversation",
      hint: canCompactContext
        ? "Keep a short record of earlier messages and make room for the rest of the chat."
        : "Compact this chat after the first reply.",
      icon: Archive,
      label: "Compact context",
    },
    {
      action: "add-goal",
      command: "/goal",
      description: sessionGoal?.text
        ? "Edit this chat's goal"
        : "Set a goal for this chat",
      hint: "Say what a good result looks like, and Gyro keeps it in mind for the whole chat.",
      icon: Goal,
      label: sessionGoal?.text ? "Edit goal" : "Save goal",
    },
    chatMode === "plan" || chatMode === "council"
      ? {
          action: "set-chat-mode-normal",
          command: "/normal",
          description: "Return to normal chat mode",
          hint: "Go back to the usual way of working, where Gyro just does what you ask.",
          icon: Play,
          label: "Normal mode",
        }
      : {
          action: "set-chat-mode-plan",
          command: "/plan",
          description: "Plan before making changes",
          hint: "Gyro works out the steps and shows them to you first. Nothing on your computer changes until you agree.",
          icon: ListChecks,
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
            description: "Ask several models for one answer",
            hint: "Asks several AI models the same question at the same time, then hands you one combined answer.",
            icon: Users,
            label: "Council mode",
          },
        ]),
    {
      action: "attach-editor-snapshot",
      command: "/editor",
      description: "Attach the open editor file",
      hint: "Sends a copy of the file you have open, exactly as it looks right now.",
      icon: FileCode2,
      label: "Attach editor snapshot",
    },
    {
      action: "select-image",
      command: "/image",
      description: "Attach an image",
      icon: ImagePlus,
      label: "Attach image",
    },
    {
      action: "select-video",
      command: "/video",
      description: "Attach a video",
      icon: Video,
      label: "Attach video",
    },
    {
      action: "select-file",
      command: "/file",
      description: "Attach a workspace file",
      icon: Paperclip,
      label: "Attach file",
    },
    {
      action: "select-folder",
      command: "/folder",
      description: "Choose the workspace folder",
      hint: "Pick the project folder this chat is allowed to work in.",
      icon: Folder,
      label: "Choose folder",
    },
    {
      action: "search-workspace",
      command: "/search",
      description: "Search workspace files",
      icon: Search,
      label: "Search workspace",
    },
    {
      command: "/model",
      description: "Choose a provider and model",
      icon: Sparkles,
      label: "Choose model",
      popover: "provider",
    },
    {
      command: "/permissions",
      description: "Change approval settings",
      hint: "Choose how often Gyro checks with you before it does something.",
      icon: ShieldCheck,
      label: "Change permissions",
      popover: "approval",
    },
    {
      action: "new-chat",
      command: "/new",
      description: "Start a new chat",
      icon: Edit3,
      label: "New chat",
    },
    {
      available: hasUserWorkspace,
      command: "/branch",
      description: "Create or switch a Git branch",
      icon: GitBranch,
      label: "Choose branch",
      popover: "branch",
    },
    {
      action: "open-source-control",
      available: hasUserWorkspace,
      command: "/review",
      description: "Review current workspace changes",
      icon: GitPullRequest,
      label: "Review changes",
    },
    {
      action: "run-workspace-test",
      available: hasUserWorkspace,
      command: "/test",
      description: "Run the detected test task",
      icon: Play,
      label: "Run workspace tests",
    },
    {
      action: "open-diff",
      available: hasUserWorkspace,
      command: "/diff",
      description: "Open the current workspace diff",
      icon: ScrollText,
      label: "Show diff",
    },
  ];
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
  const requestSend = () => {
    if (explorerAskSendHeld) return;
    if (draft.trim().toLowerCase() === "/compact" && onComposerAction) {
      onDraftChange("");
      onComposerAction("compact-context");
      return;
    }
    onSend();
  };
  const costPreviewTitle = `Each seat carries this chat's context, and the synthesizer then reads their answers. Estimated total for one send: ${turnCost.label}.`;
  // Why runs are stopped, or which budget is about to stop them. A pause
  // outranks a budget warning: the banner explains the block, not every number.
  const safetyNotice = useMemo(
    () => summarizeUsageSafety(usageSafety),
    [usageSafety],
  );
  // Slash commands work at the start of a draft and after whitespace, so a
  // person can write naturally and then add `/plan`, `/image`, etc. Paths and
  // URLs stay quiet because a slash in the middle of a word is not a command.
  const contextCandidates = useContext(ComposerContextCandidates);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const mentionMatch = !isGoalComposerActive
    ? draft.match(/(?:^|\s)@([^\s]*)$/)
    : null;
  const mentions = mentionMatch
    ? contextMentionCandidates(
        contextCandidates,
        mentionMatch[1] ?? "",
        workspacePath,
      )
    : [];
  const mentionOpen = !mentionDismissed && mentions.length > 0;
  const selectedMention = Math.min(
    mentionIndex,
    Math.max(0, mentions.length - 1),
  );
  const attachMention = (index: number) => {
    const item = mentions[index];
    if (!item || !mentionMatch) return;
    onDraftChange(draft.slice(0, draft.lastIndexOf("@")));
    onComposerAction?.(
      `${item.kind === "open-tab" ? "attach-open-tab" : "attach-workspace-path"}:${encodeURIComponent(item.path)}`,
    );
    setMentionIndex(0);
  };
  const slashMatch = isGoalComposerActive
    ? null
    : draft.match(/(?:^|\s)\/([^\s/]*)$/);
  const slashQuery = slashMatch?.[1]?.toLocaleLowerCase();
  const availableSlashCommands = slashCommands.filter(
    (command) => command.available !== false,
  );
  const filteredSlashCommands =
    slashQuery === undefined
      ? []
      : availableSlashCommands.filter((command) => {
          const commandName = command.command.slice(1).toLocaleLowerCase();
          const labelWords = command.label.toLocaleLowerCase().split(/\s+/);
          return (
            commandName.startsWith(slashQuery) ||
            labelWords.some((word) => word.startsWith(slashQuery))
          );
        });
  const visibleSlashCommands = isSlashHelpOpen
    ? availableSlashCommands
    : filteredSlashCommands;
  const isSlashMenuOpen =
    !isSlashMenuDismissed && visibleSlashCommands.length > 0;
  // The slash menu is driven by the draft, so it stays open while the textarea
  // is in use and closes on a press anywhere outside the composer.
  const slashMenuScopeRef = useOutsidePointerDismiss<HTMLDivElement>(
    isSlashMenuOpen,
    () => {
      setIsSlashHelpOpen(false);
      setIsSlashMenuDismissed(true);
    },
  );
  const selectedSlashCommandIndex = Math.min(
    activeSlashCommandIndex,
    Math.max(0, visibleSlashCommands.length - 1),
  );

  const togglePopover = (popover: ComposerPopoverId) => {
    setActivePopover((current) => (current === popover ? null : popover));
  };
  const toggleProviderPopover = (
    entry: "root" | "model",
    trigger: HTMLButtonElement,
  ) => {
    const pane =
      entry === "root"
        ? "root"
        : currentModelItems.length
          ? "model"
          : "provider";
    modelMenuEntry.current = entry;
    modelMenuTriggerRef.current = trigger;
    setModelPickerProviderId(undefined);
    setModelMenuPane(pane);
    setIsModelMenuAdvancedOpen(false);
    setActivePopover(
      activePopover === "provider" && modelMenuPane === pane
        ? null
        : "provider",
    );
  };
  // Navigation inside the chip's menu must not reach the composer's action
  // handler — only leaf choices (a model, an effort, a provider) do.
  const runModelMenuAction = (action?: string, item?: ComposerPopoverItem) => {
    if (item?.kind === "disclosure") {
      setIsModelMenuAdvancedOpen((current) => !current);
      return;
    }
    if (item?.menuPane) {
      if (item.menuPane === "root") {
        setModelPickerProviderId(undefined);
      }
      setModelMenuPane(item.menuPane);
      return;
    }
    runPopoverAction(action, item);
  };
  const runPopoverAction = (action?: string, item?: ComposerPopoverItem) => {
    if (item?.providerId) {
      // Browse models in-place; commit the provider only with a model choice.
      const provider = providerConfigs.find(
        (entry) => entry.id === item.providerId,
      );
      if (provider?.authStatus === "connected") {
        setModelPickerProviderId(item.providerId);
        setModelMenuPane("provider-model");
        return;
      }
      setActivePopover("provider");
      if (action) {
        onComposerAction?.(action);
      }
      return;
    }

    setActivePopover(null);
    setModelPickerProviderId(undefined);
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
    // Remove just the active `/command`, keeping the thought the person was
    // already writing. The retained space makes the command feel like a small
    // inline action instead of a destructive mode switch.
    onDraftChange(draft.replace(/(^|\s)\/[^\s/]*$/, "$1"));
    if (command.command === "/help") {
      setIsSlashHelpOpen(true);
      setIsSlashMenuDismissed(false);
      composerTextareaRef.current?.focus();
      return;
    }
    setIsSlashHelpOpen(false);
    if (command.popover) {
      setModelPickerProviderId(undefined);
      if (command.popover === "provider") {
        modelMenuEntry.current = "model";
        modelMenuTriggerRef.current = null;
        setModelMenuPane(currentModelItems.length ? "model" : "provider");
      }
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
  const preferredProviderPlacement =
    popoverPlacement ?? (hasEffortChoice ? "up" : isHero ? "down" : "up");
  // Prefer the space above the effort chip. Measure the current panel so
  // taller model lists can flip to the side with room in a short window.
  const [providerPopoverPlacement, setProviderPopoverPlacement] = useState<
    "up" | "down"
  >(preferredProviderPlacement);
  useLayoutEffect(() => {
    if (activePopover !== "provider") {
      setProviderPopoverPlacement(preferredProviderPlacement);
      return;
    }
    const scope = popoverScopeRef.current;
    const panel = scope?.querySelector<HTMLElement>(
      ":scope > .gyro-composer-popover, :scope > .gyro-provider-picker",
    );
    // The model rail owns its pane-aware placement and resize observation.
    if (!scope || !panel || isModelRailPane) {
      return;
    }
    const anchor = scope.getBoundingClientRect();
    const bounds = clippingBounds(panel);
    const gap = 6;
    const edgePad = 12;
    panel.style.maxHeight = "";
    const height = panel.offsetHeight;
    const fitsBelow = anchor.bottom + gap + height <= bounds.bottom - edgePad;
    const fitsAbove = anchor.top - gap - height >= bounds.top + edgePad;
    setProviderPopoverPlacement(
      preferredProviderPlacement === "down"
        ? fitsBelow || !fitsAbove
          ? "down"
          : "up"
        : fitsAbove || !fitsBelow
          ? "up"
          : "down",
    );
  }, [
    activePopover,
    isModelMenuAdvancedOpen,
    isModelRailPane,
    modelMenuPane,
    preferredProviderPlacement,
    popoverScopeRef,
  ]);

  useEffect(() => {
    setActiveSlashCommandIndex(0);
    setSlashHint(undefined);
  }, [isSlashHelpOpen, slashQuery]);

  useEffect(() => {
    if (activeSlashCommandIndex >= visibleSlashCommands.length) {
      setActiveSlashCommandIndex(0);
    }
  }, [activeSlashCommandIndex, visibleSlashCommands.length]);

  useEffect(() => {
    if (isSlashMenuOpen) {
      slashCommandRefs.current[selectedSlashCommandIndex]?.scrollIntoView({
        block: "nearest",
      });
    }
  }, [isSlashMenuOpen, selectedSlashCommandIndex]);

  // Drops land on a chat, not on a textarea: the rectangle that claims one is
  // the whole chat surface this composer sits in, falling back to the composer
  // itself when the surface is not the shell's ancestor.
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const attach = (files: File[]) => onAttachMediaFiles?.(files);
    const reportError = (message: string) => onMediaDropError?.(message);
    const host: MediaDropTarget = {
      attach,
      attachPaths: onAttachMediaPaths,
      reportError,
      paneKey: draftKey,
      rect: () => new DOMRect(),
    };
    // Any mounted composer can take a drop that landed off every chat, so there
    // is always somewhere for it to go.
    localMediaDrop = host;
    const deregister = registerMediaDropTarget({
      attach,
      attachPaths: onAttachMediaPaths,
      reportError,
      paneKey: draftKey,
      rect: () => {
        const shell = composerShellRef.current;
        const surface = shell?.closest(".gyro-chat-surface");
        return (surface ?? shell)?.getBoundingClientRect() ?? new DOMRect();
      },
    });
    return () => {
      deregister();
      if (localMediaDrop === host) localMediaDrop = undefined;
    };
  }, [draftKey, onAttachMediaFiles, onAttachMediaPaths, onMediaDropError]);

  const hasGoalCaption = Boolean(
    sessionGoal?.status === "active" &&
    sessionGoal.text &&
    !isGoalComposerActive,
  );

  return (
    <div
      className={[
        "gyro-composer-shell",
        hasGoalCaption ? "has-goal-caption" : "",
        isHero ? "is-hero" : "",
        hasSelectedProvider || isHero
          ? "has-provider"
          : "is-provider-collapsed",
        isHero && constrainToParent ? "is-constrained" : "",
        isSending ? "is-sending" : "",
        overlay ? "has-overlay" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        isHero
          ? { justifySelf: constrainToParent ? "stretch" : "center" }
          : undefined
      }
      ref={(node) => {
        slashMenuScopeRef.current = node;
        composerShellRef.current = node;
      }}
    >
      {overlay}
      <CheckWorkStatus sessionId={draftKey} />
      {/* An open goal rides on the composer, above the message that pursues
          it, and steps aside for the goal editor. A goal the model marks done
          leaves this spot: the outcome stays in the chat, and the strip does
          not. */}
      {sessionGoal?.status === "active" &&
      sessionGoal.text &&
      !isGoalComposerActive ? (
        <SessionGoalStrip
          goal={sessionGoal}
          isRunning={isSending}
          onClear={onGoalAction ? () => void onGoalAction("clear") : undefined}
          onComplete={
            onGoalAction
              ? () =>
                  void onGoalAction(
                    sessionGoal.status === "complete" ? "reopen" : "complete",
                  )
              : undefined
          }
          onEdit={() => onComposerAction?.("add-goal")}
          onPause={onGoalAction ? () => void onGoalAction("pause") : undefined}
          onResume={
            onGoalAction ? () => void onGoalAction("resume") : undefined
          }
        />
      ) : null}
      {attachments.length > 0 ? (
        <>
          <div className="gyro-composer-attachments" aria-label="Attachments">
            {attachments.map((attachment) => (
              <div
                className={`gyro-composer-attachment is-${attachment.kind}${attachment.kind === "video" ? " is-image" : ""}${attachment.stale ? " is-stale" : ""}${attachment.pending ? " is-pending" : ""}`}
                aria-busy={attachment.pending || undefined}
                key={attachment.id}
                title={`${attachment.name} · ${formatAttachmentSize(attachment.size)}${attachment.stale ? " · the command ran again after this was captured" : ""}`}
              >
                {attachment.kind === "image" || attachment.kind === "video" ? (
                  <ComposerMediaPreview attachment={attachment} />
                ) : attachment.kind === "terminal-output" &&
                  attachment.previewText ? (
                  <button
                    aria-expanded={previewedAttachmentId === attachment.id}
                    aria-label={`Preview ${attachment.name}`}
                    className="gyro-composer-attachment-preview-toggle"
                    onClick={() =>
                      setPreviewedAttachmentId((current) =>
                        current === attachment.id ? undefined : attachment.id,
                      )
                    }
                    title="Preview exactly what the model will receive"
                    type="button"
                  >
                    <SquareTerminal size={15} />
                  </button>
                ) : (
                  <FileText size={15} />
                )}
                <span>
                  <strong>{attachment.name}</strong>
                  <small>
                    {attachment.stale
                      ? "Out of date"
                      : formatAttachmentSize(attachment.size)}
                  </small>
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
          {previewedTerminalAttachment?.previewText ? (
            <pre
              aria-label={`${previewedTerminalAttachment.name} preview`}
              className="gyro-composer-attachment-preview"
            >
              {previewedTerminalAttachment.previewText}
            </pre>
          ) : null}
        </>
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
      {mentionOpen ? (
        <ComposerCompletionMenu
          className="gyro-composer-slash-menu"
          role="listbox"
          id={`${popoverBaseId}-context-menu`}
          aria-label="Attach context"
        >
          <header>
            <strong>Context · @file or @open-tab</strong>
            <span>↑↓ navigate · Enter attach · Esc close</span>
          </header>
          {mentions.map((item, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === selectedMention}
              id={`${popoverBaseId}-context-${index}`}
              className={index === selectedMention ? "is-selected" : ""}
              key={`${item.kind}:${item.path}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => attachMention(index)}
            >
              <FileText size={14} />
              <code>@{item.kind}</code>
              <span>{item.label}</span>
            </button>
          ))}
        </ComposerCompletionMenu>
      ) : null}
      {isSlashMenuOpen ? (
        <ComposerCompletionMenu
          aria-label="Chat commands"
          className="gyro-composer-slash-menu is-commands"
          id={`${popoverBaseId}-slash-menu`}
          role="menu"
        >
          <header role="presentation">
            <strong>Chat commands</strong>
            <span>{visibleSlashCommands.length} available</span>
          </header>
          <div
            className="gyro-composer-slash-list"
            onScroll={() => setSlashHint(undefined)}
            role="presentation"
          >
            {visibleSlashCommands.map((command, index) => {
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
                  onPointerEnter={() => {
                    setActiveSlashCommandIndex(index);
                    setSlashHint(undefined);
                  }}
                  ref={(element) => {
                    slashCommandRefs.current[index] = element;
                  }}
                  role="menuitem"
                  type="button"
                >
                  <Icon aria-hidden="true" size={16} />
                  <code>{command.command}</code>
                  <span className="gyro-composer-slash-command-copy">
                    <strong>{command.label}</strong>
                    {isSlashHelpOpen ? (
                      <small>{command.description}</small>
                    ) : null}
                  </span>
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
          <footer className="gyro-composer-slash-footer" role="presentation">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> Navigate
            </span>
            <span>
              <kbd>↵</kbd> Select
            </span>
            <span>
              <kbd>esc</kbd> Close
            </span>
          </footer>
        </ComposerCompletionMenu>
      ) : null}
      {activePopover === "branch" ? (
        <div
          className="gyro-composer-command-popover"
          ref={activePopover === "branch" ? popoverScopeRef : undefined}
        >
          <ComposerPopover
            align="end"
            className="gyro-composer-branch-picker"
            keepInBounds
            id={`${popoverBaseId}-branch`}
            items={branchPopoverItems({
              branchCatalog,
              branchName:
                branchName ??
                (workspaceMode === "worktree" ? "New worktree branch" : "main"),
              isDisabled: isSending,
              isLoading: isBranchLoading,
              workspaceMode,
              workspacePath,
            })}
            onAction={runPopoverAction}
            placement="up"
            title="Branches"
          />
        </div>
      ) : null}
      {effectiveProviderId &&
      selectedProvider?.capabilities?.supportsUsage === true &&
      selectedProvider.capabilities.executionKind !== "openai-compatible-api" &&
      selectedProvider.authMode !== "env" ? (
        <PlanUsageNotification
          key={effectiveProviderId}
          dailyPaceWarning={dailyPaceWarning}
          onHandoff={(providerId) =>
            onComposerAction?.(`handoff-provider:${providerId}`)
          }
          paused={Boolean(usageSafety?.pause.active)}
          providerId={effectiveProviderId}
          providerLedger={providerLedger}
          providers={handoffProviders}
          windows={providerUsage?.windows ?? []}
        />
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
        data-tour="composer.input"
        ref={composerTextareaRef}
        aria-label={
          isGoalComposerActive
            ? startsGoalSession
              ? "Set goal and send"
              : "Set session goal"
            : "Message Gyro"
        }
        aria-controls={
          mentionOpen
            ? `${popoverBaseId}-context-menu`
            : isSlashMenuOpen
              ? `${popoverBaseId}-slash-menu`
              : undefined
        }
        aria-activedescendant={
          mentionOpen
            ? `${popoverBaseId}-context-${selectedMention}`
            : isSlashMenuOpen
              ? `${popoverBaseId}-slash-command-${selectedSlashCommandIndex}`
              : undefined
        }
        aria-expanded={mentionOpen || isSlashMenuOpen}
        aria-haspopup={mentionOpen ? "listbox" : "menu"}
        onPaste={(event) => {
          const files = chatMediaFiles(event.clipboardData);
          if (files.length) {
            event.preventDefault();
            onAttachMediaFiles?.(files);
          }
        }}
        onFocus={() => {
          composerWantsFocus = true;
          setActivePopover(null);
          setIsSlashMenuDismissed(false);
        }}
        onBlur={(event) => {
          // A detached node means a branch swap removed the textarea rather
          // than the user moving on: keep the flag so the composer replacing
          // this one reclaims the caret.
          if (!event.currentTarget.isConnected) return;
          composerWantsFocus = false;
        }}
        maxLength={isGoalComposerActive ? 1000 : maxDraftLength}
        onSelect={(event) => {
          if (dictationAnchorRef.current) return;
          dictationCaretChoiceRef.current = event.currentTarget.selectionStart;
        }}
        onChange={(event) => {
          const value = event.target.value;
          if (
            dictationAnchorRef.current &&
            value !== dictationAppliedRef.current
          ) {
            releaseDictation(false);
          }
          dictationCaretChoiceRef.current = event.target.selectionStart;
          setMentionDismissed(false);
          setMentionIndex(0);
          setIsSlashHelpOpen(false);
          setIsSlashMenuDismissed(false);
          onDraftChange(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && dictationAnchorRef.current) {
            event.preventDefault();
            releaseDictation(true);
            return;
          }
          if (mentionOpen && !event.nativeEvent.isComposing) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setMentionIndex(
                (current) =>
                  (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    mentions.length) %
                  mentions.length,
              );
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setMentionDismissed(true);
              return;
            }
            if (
              (event.key === "Enter" || event.key === "Tab") &&
              !event.shiftKey
            ) {
              event.preventDefault();
              attachMention(selectedMention);
              return;
            }
          }
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
                  (current + direction + visibleSlashCommands.length) %
                  visibleSlashCommands.length,
              );
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setIsSlashHelpOpen(false);
              setIsSlashMenuDismissed(true);
              return;
            }
            if (
              (event.key === "Enter" || event.key === "Tab") &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              const command =
                visibleSlashCommands[selectedSlashCommandIndex] ??
                visibleSlashCommands[0];
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
            if (dictationAnchorRef.current) releaseDictation(false);
            if (explorerAskSendHeld) return;
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
              ? startsGoalSession
                ? "What should this chat achieve? Send to set the goal and start"
                : "Edit the goal, then save it"
              : chatMode === "council"
                ? "Ask for architecture, review, or alternatives — models answer in parallel"
                : !canSubmitChat
                  ? isCliUpdating
                    ? "Updating a provider CLI — sending unlocks when it finishes…"
                    : cleanMachinePath.placeholder
                  : variant === "hero"
                    ? "Describe a task or attach images"
                    : "Ask for follow-up changes or attach images"
        }
        value={draft}
      />
      {!isGoalComposerActive &&
      shellReady &&
      !canSubmitChat &&
      chatMode !== "council" &&
      !isCliUpdating &&
      (!hasUserWorkspace || needsProviderSetup || !hasSelectedProvider) ? (
        <div className="gyro-composer-blocker" role="status">
          <span>
            <PlugZap
              className="gyro-composer-blocker-icon"
              size={15}
              aria-hidden="true"
            />
            {isCliUpdating
              ? "Updating a provider CLI. Sending will unlock when it finishes."
              : cleanMachinePath.readinessLabel}
          </span>
          {!isCliUpdating &&
          cleanMachinePath.nextAction &&
          cleanMachinePath.nextActionLabel ? (
            <button
              onClick={() => {
                const action = cleanMachinePath.nextAction;
                if (action) onComposerAction?.(action);
              }}
              type="button"
            >
              {cleanMachinePath.nextActionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        className="gyro-composer-bar"
        // The full-width Add menu must anchor to the shell, including in
        // hero/tiled layouts whose toolbar rules establish a positioning box.
        style={activePopover === "context" ? { position: "static" } : undefined}
      >
        {hasSelectedProvider || isHero ? (
          <>
            <div
              className="gyro-composer-control gyro-composer-control-context gyro-composer-reveal"
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
                  title="Add"
                  keepInBounds
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
                <ApprovalChipIcon size={14} />
                <span className="gyro-composer-label">
                  {approvalCopy.chipLabel}
                </span>
                <ChevronDown size={13} />
              </button>
              {activePopover === "approval" ? (
                <ComposerPopover
                  className="gyro-approval-picker"
                  keepInBounds
                  id={`${popoverBaseId}-approval`}
                  items={[
                    {
                      action: "set-approval-gated",
                      active: approvalMode === "gated",
                      detail: approvalCopy.gatedDetail,
                      icon: Hand,
                      label: approvalCopy.gatedLabel,
                    },
                    {
                      action: "set-approval-auto",
                      active: approvalMode === "auto",
                      detail: approvalCopy.autoDetail,
                      icon: Clock,
                      label: approvalCopy.autoLabel,
                    },
                    {
                      action: "set-approval-direct",
                      active: approvalMode === "direct",
                      detail: approvalCopy.directDetail,
                      icon: ShieldAlert,
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
            aria-label={
              isSending ? "Remove Plan from next message" : "Remove Plan mode"
            }
            aria-pressed="true"
            className="gyro-composer-chip is-plan"
            onClick={() => onComposerAction?.("set-chat-mode-normal")}
            title={
              isSending
                ? "Plan applies to the next message"
                : "Remove Plan mode"
            }
            type="button"
          >
            <ListChecks size={13} />
            <span className="gyro-composer-label">
              {isSending ? "Plan next" : "Plan"}
            </span>
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
        {!hasGoalCaption && (isGoalModeActive || isGoalComposerActive) ? (
          <button
            aria-label={
              sessionGoal?.text
                ? "Remove Goal mode — the goal stays on this chat"
                : "Close goal editor — draft is kept"
            }
            aria-pressed="true"
            className="gyro-composer-chip is-goal"
            onClick={onCancelGoalComposer}
            title={
              sessionGoal?.text
                ? "Remove Goal mode — the goal stays on this chat"
                : "Close goal editor — draft is kept"
            }
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
        ) : !hasGoalCaption && sessionGoal?.text ? (
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
          <div
            className="gyro-composer-context-meter"
            // Opening the meter asks for the plan's current level; the account
            // poll coalesces repeat hovers into one request.
            onFocus={refreshContextMeterUsage}
            onPointerEnter={refreshContextMeterUsage}
          >
            <div
              aria-describedby={`${popoverBaseId}-context-usage-tooltip`}
              aria-label={contextUsage.label}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={
                contextUsage.contextWindowTokens > 0
                  ? contextUsage.percent
                  : undefined
              }
              className={`gyro-composer-context-wheel is-${contextSeverity}`}
              role="progressbar"
              tabIndex={0}
            >
              <svg
                aria-hidden="true"
                height="18"
                viewBox="0 0 18 18"
                width="18"
              >
                <circle
                  className="gyro-composer-context-track"
                  cx="9"
                  cy="9"
                  r="6.5"
                />
                <circle
                  className="gyro-composer-context-progress"
                  cx="9"
                  cy="9"
                  pathLength="100"
                  r="6.5"
                  strokeDasharray={`${contextUsage.percent ?? 0} 100`}
                  strokeLinecap={contextUsage.percent > 0 ? "round" : "butt"}
                  transform="rotate(-90 9 9)"
                />
              </svg>
            </div>
            <div
              className="gyro-composer-context-tooltip"
              id={`${popoverBaseId}-context-usage-tooltip`}
              role="tooltip"
            >
              <section
                className={`gyro-composer-context-section is-${contextSeverity}`}
              >
                <header>
                  <div className="gyro-composer-context-heading">
                    <strong>Context</strong>
                    <span
                      className="gyro-composer-context-model"
                      title={contextUsage.modelLabel}
                    >
                      {contextUsage.modelLabel}
                    </span>
                  </div>
                </header>
                <div
                  className="gyro-composer-context-value"
                  title={
                    contextSource === "empty"
                      ? "Waiting for provider measurement"
                      : contextUsage.detail
                  }
                >
                  <strong>
                    {contextSource === "empty"
                      ? "—"
                      : `${contextSource === "estimated" && !providerMeasured ? "~" : ""}${contextUsage.usedLabel}`}
                  </strong>
                  {contextUsage.contextWindowTokens > 0 ? (
                    <span>of {contextUsage.windowLabel}</span>
                  ) : null}
                  {contextSource === "empty" ||
                  contextUsage.contextWindowTokens <= 0 ? null : (
                    <b>{contextUsage.percentLabel}</b>
                  )}
                </div>
                <p className="gyro-composer-context-caption">
                  {contextSource === "empty"
                    ? "Waiting for provider measurement"
                    : contextUsage.contextWindowTokens <= 0
                      ? "Window unknown"
                      : contextSource === "estimated" && !providerMeasured
                        ? "Estimated from this thread"
                        : "Reported by the provider"}
                </p>
                <div
                  aria-label="Context window used"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={
                    contextSource !== "empty" &&
                    contextUsage.contextWindowTokens > 0
                      ? contextUsage.percent
                      : undefined
                  }
                  aria-valuetext={
                    contextSource === "empty"
                      ? "Context usage not reported"
                      : contextUsage.contextWindowTokens > 0
                        ? undefined
                        : "Context window unknown"
                  }
                  className="gyro-composer-context-bar"
                  role="progressbar"
                >
                  <span style={{ width: `${contextUsage.percent ?? 0}%` }} />
                </div>
              </section>
              {usageProviderId ? (
                <section
                  aria-label="Plan usage limits"
                  className="gyro-composer-limit-summary"
                >
                  <header className="gyro-composer-limit-title">
                    <span>Plan usage</span>
                  </header>
                  {providerUsage?.stale ? (
                    <small>Last known usage · retrying</small>
                  ) : null}
                  {limitWindows.length > 0 ? (
                    limitWindows.map((window) => (
                      <ComposerLimitRow key={window.id} window={window} />
                    ))
                  ) : (
                    <small>
                      {providerUsage?.status === "loading"
                        ? "Reading your plan…"
                        : "Your provider has not reported plan limits."}
                    </small>
                  )}
                </section>
              ) : null}
            </div>
          </div>
        ) : null}
        <div
          className="gyro-composer-control gyro-composer-control-model"
          ref={
            activePopover === "provider" && modelMenuPane !== "root"
              ? popoverScopeRef
              : undefined
          }
        >
          <button
            /* Narrow panes hide .gyro-composer-label, so the visible text
               cannot be the only name this control has. */
            aria-label={`Model: ${modelChipLabel}`}
            className="gyro-composer-chip gyro-model-chip gyro-composer-model-trigger"
            onClick={(event) =>
              toggleProviderPopover("model", event.currentTarget)
            }
            type="button"
            {...menuProps("provider")}
            aria-haspopup="menu"
            aria-expanded={activePopover === "provider" && isModelRailPane}
            aria-controls={
              activePopover === "provider" && isModelRailPane
                ? `${popoverBaseId}-provider`
                : undefined
            }
          >
            {displayProvider ? (
              <ProviderLogo providerId={displayProvider.id} />
            ) : null}
            <span className="gyro-composer-label">{modelChipLabel}</span>
            <ChevronDown aria-hidden="true" size={13} />
          </button>
          {activePopover === "provider" && isModelRailPane ? (
            <ComposerModelRail
              activeModelId={
                effectiveModelId ?? displayProvider?.selectedModelId
              }
              activeProviderId={effectiveProviderId}
              id={`${popoverBaseId}-provider`}
              onConnect={(providerId) =>
                onComposerAction?.(`connect-provider:${providerId}`)
              }
              onManageProviders={() => {
                dismissActiveComposerPopover();
                onComposerAction?.("open-settings:providers");
              }}
              onSelectModel={(providerId, modelId) => {
                dismissActiveComposerPopover();
                onComposerAction?.(
                  `select-provider-model:${providerId}:${modelId}`,
                );
              }}
              placement={providerPopoverPlacement}
              providers={modelRailProviders}
              renderLogo={(provider) => (
                <ProviderLogo
                  label={provider.label}
                  providerId={provider.id as ProviderId}
                />
              )}
              warning={providerErrorMessage}
            />
          ) : activePopover === "provider" && modelMenuPane !== "root" ? (
            <ComposerPopover
              align="end"
              className={
                modelMenuPane === "effort"
                  ? "gyro-model-menu gyro-effort-picker"
                  : "gyro-model-menu"
              }
              id={`${popoverBaseId}-provider`}
              items={
                modelMenuPane === "effort"
                  ? [modelMenuBackItem("Effort"), ...effortItems]
                  : modelMenuPane === "settings"
                    ? [modelMenuBackItem("Model settings"), ...modelMenuItems]
                    : modelMenuItems
              }
              onAction={runModelMenuAction}
              placement={providerPopoverPlacement}
            />
          ) : null}
        </div>
        {hasEffortChoice && providerReasoningEffort ? (
          <div
            className="gyro-composer-control gyro-composer-control-effort"
            ref={
              activePopover === "provider" && modelMenuPane === "root"
                ? popoverScopeRef
                : undefined
            }
          >
            <button
              className="gyro-composer-chip gyro-effort-chip gyro-composer-effort-trigger"
              aria-label={`Reasoning effort: ${reasoningEffortLabel(providerReasoningEffort)}`}
              aria-haspopup="dialog"
              aria-expanded={
                activePopover === "provider" && modelMenuPane === "root"
              }
              aria-controls={
                activePopover === "provider" && modelMenuPane === "root"
                  ? `${popoverBaseId}-provider`
                  : undefined
              }
              onClick={(event) =>
                toggleProviderPopover("root", event.currentTarget)
              }
              type="button"
            >
              <span
                className="gyro-effort-chip-label"
                data-max-effort={
                  effortItems.length > 1 &&
                  effortItems[effortItems.length - 1]?.active
                }
              >
                {reasoningEffortLabel(providerReasoningEffort)}
              </span>
              <ChevronDown aria-hidden="true" size={13} />
              <Gauge
                className="gyro-composer-effort-compact"
                aria-hidden="true"
                size={14}
              />
            </button>
            {activePopover === "provider" && modelMenuPane === "root" ? (
              <ComposerEffortSelector
                key={`${effectiveProviderId}:${effectiveModelId}`}
                id={`${popoverBaseId}-provider`}
                fastMode={composerFastMode(
                  config,
                  effectiveProviderId,
                  rawModelId,
                  onComposerAction,
                )}
                labels={effortItems.map((item) => item.label)}
                selectedIndex={Math.max(
                  0,
                  effortItems.findIndex((item) => item.active),
                )}
                placement={providerPopoverPlacement}
                onSelect={(index) => {
                  const action = effortItems[index]?.action;
                  if (action) onComposerAction?.(action);
                }}
              />
            ) : null}
          </div>
        ) : null}
        {dictation ? (
          <button
            aria-label={
              dictationPhase === "listening"
                ? "Stop dictation"
                : dictationPhase === "processing"
                  ? "Transcribing your words"
                  : "Dictate"
            }
            aria-pressed={dictationPhase === "listening"}
            className={[
              "gyro-composer-tool",
              "gyro-dictation-button",
              dictationPhase === "listening" ? "is-listening" : "",
              dictationPhase === "processing" ? "is-processing" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-dictation-phase={dictationPhase}
            onClick={() => {
              setActivePopover(null);
              toggleDictation();
            }}
            title={
              dictationPhase === "listening"
                ? "Stop dictation"
                : dictationPhase === "processing"
                  ? "Transcribing your words"
                  : "Dictate"
            }
            type="button"
          >
            <Mic aria-hidden="true" size={17} />
            <span aria-hidden="true" className="gyro-dictation-badge">
              <span className="gyro-dictation-wave">
                <span />
                <span />
                <span />
              </span>
              <Square
                className="gyro-dictation-stop"
                fill="currentColor"
                size={7}
                strokeWidth={0}
              />
              <span className="gyro-dictation-spinner" />
            </span>
          </button>
        ) : null}
        <button
          aria-label={
            isStopAction
              ? "Stop response"
              : isGoalComposerActive
                ? startsGoalSession
                  ? "Set goal and send"
                  : "Save goal"
                : isSending
                  ? "Queue message"
                  : "Send message"
          }
          aria-busy={false}
          className={[
            "gyro-send-button",
            isStopAction ? "is-stop" : "",
            isSending && !isStopAction ? "is-queue" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          disabled={
            !isStopAction && (!canSubmitComposer || draft.trim().length === 0)
          }
          onClick={(event) => {
            setActivePopover(null);
            if (isStopAction) {
              // Only honor stop when the press began on this button. A click
              // that migrated here after a layout shift (empty margin focus)
              // must not cancel the run. Keyboard activation (Enter/Space)
              // synthesizes a click with detail 0 and no pointerdown arm.
              const armed = stopArmedRef.current || event.detail === 0;
              stopArmedRef.current = false;
              if (!armed) {
                return;
              }
              onStop?.();
              return;
            }
            stopArmedRef.current = false;
            requestSend();
          }}
          // Grid slots focus their pane on pointerdown. Stopping that here
          // keeps a stop click from also re-focusing / re-laying out the chat
          // under the finger — which was reading as "click empty margin → stop".
          onPointerDown={(event) => {
            event.stopPropagation();
            if (!isStopAction) {
              stopArmedRef.current = false;
              return;
            }
            stopArmedRef.current = true;
            const button = event.currentTarget;
            const disarmIfReleasedAway = (up: PointerEvent) => {
              document.removeEventListener(
                "pointerup",
                disarmIfReleasedAway,
                true,
              );
              document.removeEventListener(
                "pointercancel",
                disarmIfReleasedAway,
                true,
              );
              if (!up.composedPath().includes(button)) {
                stopArmedRef.current = false;
              }
            };
            document.addEventListener("pointerup", disarmIfReleasedAway, true);
            document.addEventListener(
              "pointercancel",
              disarmIfReleasedAway,
              true,
            );
          }}
          title={
            isStopAction
              ? "Stop response"
              : sendDisabledReason
                ? sendDisabledReason
                : isGoalComposerActive
                  ? startsGoalSession
                    ? "Set goal and send"
                    : "Save goal"
                  : isCliUpdating
                    ? "Wait for the CLI update to finish"
                    : !hasReadyProvider
                      ? "Connect a provider before sending"
                      : chatMode === "council" && !hasUserWorkspace
                        ? "Choose a folder for Council"
                        : isBranchLoading
                          ? "Wait for the branch switch to finish"
                          : isSending
                            ? "Queue message"
                            : "Send"
          }
          type="button"
        >
          {isStopAction ? (
            <Square fill="currentColor" size={10} strokeWidth={0} />
          ) : isGoalComposerActive && !startsGoalSession ? (
            <Check size={17} />
          ) : (
            <svg
              aria-hidden="true"
              className="gyro-send-arrow"
              fill="none"
              viewBox="0 0 30 30"
            >
              <path
                d="M15 21.4V8.6M9.6 14.5 15 8.6 20.4 14.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.15"
              />
            </svg>
          )}
        </button>
      </div>
      {dictation && dictationNotice ? (
        <p className="gyro-dictation-status" role="status">
          {dictationNotice}
        </p>
      ) : null}
      {shouldShowContextRow ? (
        <ChatContextSection
          branchCatalog={branchCatalog}
          branchName={branchName}
          isBranchLoading={isBranchLoading}
          isSending={isSending}
          onAction={onComposerAction}
          savedProjects={savedProjects}
          workspaceMode={workspaceMode}
          workspacePath={workspacePath}
        />
      ) : null}
    </div>
  );
}

export function ComposerMediaPreview({
  attachment,
}: {
  attachment: ChatAttachment;
}) {
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

/** A quiet outcome caption above the composer, with secondary actions in More. */
export function SessionGoalStrip({
  goal,
  isRunning = false,
  onClear,
  onComplete,
  onEdit,
  onPause,
  onResume,
}: {
  goal: SessionGoal;
  /** Only an executing turn earns the active status mark and ticking clock. */
  isRunning?: boolean;
  onClear?: () => void;
  onComplete?: () => void;
  onEdit?: () => void;
  onPause?: () => void;
  onResume?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useOutsidePointerDismiss<HTMLSpanElement>(
    isMenuOpen,
    () => setIsMenuOpen(false),
    triggerRef,
  );
  const isActive = goal.status === "active";
  const runStatus = goal.run?.status;
  const isWorking =
    isActive &&
    isRunning &&
    (!runStatus ||
      ["running", "queued", "waiting-approval"].includes(runStatus));
  useEffect(() => {
    if (!isWorking) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [isWorking]);

  const startedAt = Date.parse(
    goal.run?.startedAt ?? goal.createdAt ?? goal.updatedAt ?? "",
  );
  const finishedAt = Date.parse(goal.updatedAt ?? "");
  const durationEnd =
    isWorking || !Number.isFinite(finishedAt) ? now : finishedAt;
  const duration = Number.isFinite(startedAt)
    ? formatRunDuration(
        Math.max(0, Math.floor((durationEnd - startedAt) / 1_000)),
      )
    : undefined;
  const label = !isActive
    ? "Goal completed"
    : runStatus === "blocked"
      ? "Goal blocked"
      : runStatus === "paused"
        ? "Goal paused"
        : runStatus === "waiting-approval"
          ? "Waiting for approval"
          : runStatus === "queued"
            ? "Goal queued"
            : isRunning
              ? "Pursuing goal"
              : "Goal active";
  const statusText =
    runStatus === "paused"
      ? "Paused"
      : runStatus === "blocked"
        ? "Blocked"
        : runStatus === "waiting-approval"
          ? "Needs approval"
          : runStatus === "queued"
            ? "Queued"
            : undefined;
  const menuItems: ComposerPopoverItem[] = [
    ...(onEdit ? [{ action: "edit", icon: Edit3, label: "Edit goal" }] : []),
    ...(onComplete
      ? [
          {
            action: "complete",
            icon: isActive ? Check : RefreshCw,
            label: isActive ? "Complete goal" : "Reopen goal",
          },
        ]
      : []),
    ...(onClear
      ? [{ action: "clear", icon: Trash2, label: "Clear goal" }]
      : []),
  ];

  return (
    <section
      aria-label={`${label}: ${goal.text}${goal.run?.reason ? ` — ${goal.run.reason}` : ""}`}
      className="gyro-goal-strip"
      data-running={isWorking ? "true" : undefined}
      data-status={goal.status}
      data-run-status={runStatus}
    >
      <span aria-hidden="true" className="gyro-goal-strip-mark" title={label}>
        {isActive ? (
          <Circle size={8} fill={isWorking ? "currentColor" : "none"} />
        ) : (
          <Check size={12} />
        )}
      </span>
      <span
        className="gyro-goal-strip-text"
        title={`${goal.text}${goal.run?.reason ? ` — ${goal.run.reason}` : ""}`}
      >
        {goal.text}
      </span>
      {statusText ? (
        <span className="gyro-goal-strip-status" title={goal.run?.reason}>
          {statusText}
        </span>
      ) : null}
      {duration ? (
        <time className="gyro-goal-strip-time">{duration}</time>
      ) : null}
      <span className="gyro-goal-strip-actions" ref={menuRef}>
        {isActive && isRunning && onPause ? (
          <button
            aria-label="Pause goal"
            onClick={onPause}
            title="Pause goal"
            type="button"
          >
            <Pause aria-hidden="true" size={13} />
          </button>
        ) : null}
        {isActive && !isRunning && onResume ? (
          <button
            aria-label="Resume goal"
            onClick={onResume}
            title="Resume goal from its checkpoint"
            type="button"
          >
            <Play aria-hidden="true" size={13} />
          </button>
        ) : null}
        {menuItems.length > 0 ? (
          <button
            aria-label="Goal options"
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            aria-controls={isMenuOpen ? menuId : undefined}
            onClick={() => setIsMenuOpen((open) => !open)}
            ref={triggerRef}
            title="Goal options"
            type="button"
          >
            <MoreHorizontal aria-hidden="true" size={15} />
          </button>
        ) : null}
        {isMenuOpen ? (
          <ComposerPopover
            align="end"
            className="gyro-goal-options"
            id={menuId}
            items={menuItems}
            keepInBounds
            title="Goal"
            onAction={(action) => {
              setIsMenuOpen(false);
              triggerRef.current?.focus();
              if (action === "edit") onEdit?.();
              if (action === "complete") onComplete?.();
              if (action === "clear") onClear?.();
            }}
          />
        ) : null}
      </span>
    </section>
  );
}

export function workspaceName(path?: string) {
  if (!path) {
    return "No workspace";
  }
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function isGeneratedGyroWorkspace(path?: string) {
  return Boolean(path && !isUserSelectedWorkspacePath(path));
}

export function composerProjectLabel(path?: string) {
  if (!path || isGeneratedGyroWorkspace(path)) {
    return "No folder";
  }
  return workspaceName(path);
}

let explorerAskSendHolds = 0;

export function setExplorerAskSendHeld(held: boolean) {
  explorerAskSendHolds = Math.max(0, explorerAskSendHolds + (held ? 1 : -1));
  const next = explorerAskSendHolds > 0;
  if (explorerAskSendHeld === next) return;
  explorerAskSendHeld = next;
  for (const listener of explorerAskSendListeners) listener();
}
