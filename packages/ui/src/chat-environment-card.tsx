import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Monitor,
  RefreshCw,
  Terminal,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChatCompanionTabId } from "./chat-companion";
import {
  buildRunModel,
  formatRunDuration,
  runRowText,
  type RunStep,
} from "./chat-run";
import {
  environmentActions,
  environmentFocus,
  type EnvironmentFocus,
} from "./environment-actions";
import { reviewScopeFromSourceControl, type ReviewScope } from "./review-scope";
import { sourceControlTotals } from "./source-control-stats";
import { subagentsForStatus, type SubagentSurfaceState } from "./subagents";
import type {
  GitReviewActionId,
  SessionEvent,
  SessionPlan,
  SessionPlanItem,
  SourceControlState,
  TerminalPane,
} from "./types";
import { terminalPaneHasActiveWork } from "./workspace-sidebar";
import "./chat-environment-card.css";

/**
 * The environment card: the session plan as a step rail, with the branch,
 * processes and subagents along its foot. In the chat's right-hand Environment
 * panel it is always open and closes with the panel; in a stream it folds
 * into a two-line bar until opened.
 */
/**
 * A chat that runs on another machine. Its connection, who controls it and
 * the remote tools live in the card, so the chat itself looks like any other.
 */
export type ChatEnvironmentRemote = {
  host: string;
  status: "connecting" | "online" | "offline";
  /** Read from the connection, e.g. "Connected · Experimental". */
  statusLabel: string;
  /** The project the chat runs in on the host. */
  location?: string;
  notices?: { id: string; text: string; icon?: ReactNode; tone?: "warning" }[];
  /** Remote tools; `pressed` marks the one open beside the chat. */
  rows?: {
    id: string;
    icon: ReactNode;
    label: string;
    pressed?: boolean;
    onClick: () => void;
  }[];
  /** At most one is primary; it outranks the card's own git action. */
  actions?: {
    id: string;
    label: string;
    primary?: boolean;
    disabled?: boolean;
    onClick: () => void;
  }[];
  onRefresh?: () => void;
  isRefreshing?: boolean;
};

export type ChatEnvironmentCardProps = {
  /** "panel" is the right-hand Environment panel; "stream" folds into a bar. */
  placement?: "panel" | "stream";
  /** A chat without a plan still shows its branch, processes and subagents. */
  plan?: SessionPlan;
  /** The chat is mid-turn. A step left "in progress" by a stopped turn is not. */
  isRunning: boolean;
  /** The latest turn: its timeline feeds the active step's beats. */
  turn?: {
    id: string;
    timelineEvents: SessionEvent[];
    startedAt: string;
    runStartedAt?: string;
    completedAt?: string;
    durationMs?: number;
  };
  modelLabel?: string;
  sourceControl?: SourceControlState;
  terminalPanes?: TerminalPane[];
  subagents?: SubagentSurfaceState;
  onOpenReview?: (scope: ReviewScope) => void;
  onOpenTab?: (tab: ChatCompanionTabId) => void;
  onRunGitAction?: (actionId: GitReviewActionId) => void;
  /** Closes the Environment panel. */
  onClose?: () => void;
  /** Set for a chat that runs on another machine; panel placement only. */
  remote?: ChatEnvironmentRemote;
};

type CardMode = "running" | "waiting" | "done" | "paused" | "idle";

/** The live beats under the active step: the last few things the run did. */
const ACTIVE_BEATS = 3;

function useTickingNow(isLive: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isLive]);
  return now;
}

function turnElapsedSeconds(
  turn: ChatEnvironmentCardProps["turn"],
  isRunning: boolean,
  now: number,
) {
  if (!turn) return undefined;
  const start = Date.parse(turn.runStartedAt ?? turn.startedAt);
  if (!Number.isFinite(start)) return undefined;
  if (isRunning) return Math.max(0, Math.floor((now - start) / 1_000));
  if (typeof turn.durationMs === "number") {
    return Math.floor(turn.durationMs / 1_000);
  }
  const end = turn.completedAt ? Date.parse(turn.completedAt) : NaN;
  return Number.isFinite(end)
    ? Math.max(0, Math.floor((end - start) / 1_000))
    : undefined;
}

type Beat = {
  id: string;
  label: string;
  ref?: string;
  additions?: number;
  deletions?: number;
  isLive: boolean;
};

function beatFromStep(
  step: RunStep,
  isLast: boolean,
  isRunning: boolean,
): Beat {
  const text = runRowText(step);
  const item = step.kind === "work" ? step.item : undefined;
  const ref =
    item?.kind === "file" || item?.kind === "read"
      ? item.path?.split("/").pop()
      : text.description;
  return {
    id: step.id,
    label: text.label,
    ref: ref && ref !== text.label ? ref : undefined,
    additions: item?.kind === "file" ? item.additions : undefined,
    deletions: item?.kind === "file" ? item.deletions : undefined,
    isLive:
      isRunning &&
      isLast &&
      (step.kind === "status" || item?.status === "running"),
  };
}

function Diff({
  additions,
  deletions,
}: {
  additions?: number;
  deletions?: number;
}) {
  if (additions === undefined && deletions === undefined) return null;
  return (
    <span className="gyro-env-card-diff">
      <span className="is-added">+{additions ?? 0}</span>{" "}
      <span className="is-removed">−{deletions ?? 0}</span>
    </span>
  );
}

function StepNode({
  status,
  isActive,
}: {
  status: SessionPlanItem["status"];
  isActive: boolean;
}) {
  if (status === "complete") {
    return (
      <span className="gyro-env-card-node is-complete">
        <Check aria-hidden="true" size={11} strokeWidth={3} />
      </span>
    );
  }
  if (status === "blocked")
    return <span className="gyro-env-card-node is-blocked" />;
  if (isActive) return <span className="gyro-env-card-node is-active" />;
  return <span className="gyro-env-card-node is-todo" />;
}

function SegmentBar({
  items,
  isRunning,
}: {
  items: SessionPlanItem[];
  isRunning: boolean;
}) {
  const done = items.filter((item) => item.status === "complete").length;
  return (
    <span
      aria-label={`${done} of ${items.length} steps done`}
      className="gyro-env-card-segments"
      role="img"
    >
      {items.map((item) => (
        <span
          className={`gyro-env-card-segment is-${
            item.status === "in-progress" && !isRunning ? "todo" : item.status
          }`}
          key={item.id}
        />
      ))}
    </span>
  );
}

export function ChatEnvironmentCard({
  isRunning,
  modelLabel,
  onClose,
  onOpenReview,
  onOpenTab,
  onRunGitAction,
  placement = "stream",
  plan,
  remote,
  sourceControl,
  subagents,
  terminalPanes,
  turn,
}: ChatEnvironmentCardProps) {
  const isPanel = placement === "panel";
  const [isFolded, setIsFolded] = useState(true);
  const [remoteDetailsOpen, setRemoteDetailsOpen] = useState(false);
  const remoteTrigger = useRef<HTMLButtonElement>(null);
  const remoteDetailsId = useId();
  const isOpen = isPanel || !isFolded;
  const bodyId = useId();
  const now = useTickingNow(isRunning);
  const items = plan?.items ?? [];
  const total = items.length;
  const done = items.filter((item) => item.status === "complete").length;
  const activeIndex = isRunning
    ? items.findIndex((item) => item.status === "in-progress")
    : -1;
  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;
  const blockedItem = items.find((item) => item.status === "blocked");
  const elapsed = turnElapsedSeconds(turn, isRunning, now);
  const progress = [
    total ? `${done}/${total}` : undefined,
    elapsed !== undefined ? formatRunDuration(elapsed) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  const workingAgents = subagents
    ? subagentsForStatus(subagents.agents, "working")
    : [];
  const runningPanes = (terminalPanes ?? []).filter(terminalPaneHasActiveWork);
  const focus = environmentFocus({
    canRunGitActions: Boolean(onRunGitAction),
    isRunning,
    planCurrent: activeIndex >= 0 ? activeIndex + 1 : undefined,
    planDone: done,
    planSteps: total,
    sourceControl,
    workingSubagents: workingAgents.length,
  });
  const mode: CardMode = isRunning
    ? "running"
    : blockedItem || focus.primaryAction
      ? "waiting"
      : total === 0
        ? "idle"
        : done === total
          ? "done"
          : "paused";

  const totals = sourceControlTotals(sourceControl);
  const hasTotals = totals.kind === "branch" || totals.kind === "working-tree";
  const changedFiles =
    totals.kind === "branch"
      ? (sourceControl?.comparedToMain?.files?.length ??
        sourceControl?.files.length ??
        0)
      : (sourceControl?.files.length ?? 0);
  const branch = sourceControl?.branch;

  // The live beats only exist for the turn that is running now.
  const beats = useMemo(() => {
    if (!isRunning || !turn) return [];
    const steps = buildRunModel(turn.timelineEvents, {
      isRunning,
      startedAt: turn.runStartedAt ?? turn.startedAt,
    }).steps.filter((step) => step.kind === "work" || step.kind === "status");
    const tail = steps.slice(-ACTIVE_BEATS);
    return tail.map((step, index) =>
      beatFromStep(step, index === tail.length - 1, isRunning),
    );
  }, [isRunning, turn]);
  const liveBeat = beats.at(-1);

  const openReview = () => {
    const scope = reviewScopeFromSourceControl(sourceControl);
    if (onOpenReview) onOpenReview(scope);
    else onOpenTab?.("review");
  };
  const primaryAction = focus.primaryAction
    ? environmentActions(sourceControl).find(
        (action) => action.id === focus.primaryAction,
      )
    : undefined;
  const primaryLabel =
    focus.focus === "commit"
      ? "Commit"
      : focus.focus === "push"
        ? sourceControl?.upstream
          ? "Push"
          : "Publish branch"
        : focus.focus === "pull-request"
          ? "Create pull request"
          : undefined;
  const runPrimary = () => {
    const intent = primaryAction?.intent;
    if (!intent || intent.kind === "review") {
      openReview();
      return;
    }
    onRunGitAction?.(intent.actionId);
  };

  const waitingTitle = blockedItem
    ? blockedItem.title
    : waitingTitleFor(focus.focus);
  const barTitle =
    mode === "running"
      ? (activeItem?.title ?? plan?.title ?? "Working")
      : mode === "waiting"
        ? waitingTitle
        : plan?.title || activeItem?.title || items.at(-1)?.title || "Plan";

  const diffMeta = hasTotals ? (
    <span className="gyro-env-card-mono">
      <Diff additions={totals.additions} deletions={totals.deletions} />
      {changedFiles > 0
        ? ` · ${changedFiles} ${changedFiles === 1 ? "file" : "files"}`
        : null}
    </span>
  ) : null;
  const processMeta = runningPanes.length ? (
    <span className="gyro-env-card-dotted">
      <span aria-hidden="true" className="gyro-env-card-dot is-success" />
      {runningPanes.length === 1
        ? runningPanes[0]?.title
        : `${runningPanes.length} running`}
    </span>
  ) : null;
  const agentMeta = workingAgents.length ? (
    <span>
      {workingAgents.length} {workingAgents.length === 1 ? "agent" : "agents"}
    </span>
  ) : null;

  const barLead =
    mode === "running" ? (
      <span className="gyro-env-card-node is-active is-lead" />
    ) : mode === "waiting" ? (
      <span className="gyro-env-card-node is-blocked is-lead" />
    ) : mode === "done" ? (
      <span className="gyro-env-card-node is-done is-lead">
        <Check aria-hidden="true" size={11} strokeWidth={3} />
      </span>
    ) : (
      <span className="gyro-env-card-node is-todo is-lead" />
    );

  const barSecondLine =
    mode === "running" ? (
      <>
        <span className="gyro-env-card-grow">
          {liveBeat ? (
            <>
              <span className="is-accent">{liveBeat.label}</span>
              {liveBeat.ref ? (
                <>
                  {" "}
                  <span className="gyro-env-card-mono">{liveBeat.ref}</span>
                </>
              ) : null}
            </>
          ) : (
            <span className="is-accent">{focus.status ?? "Working"}</span>
          )}
        </span>
        {diffMeta}
        {processMeta}
        {agentMeta}
      </>
    ) : mode === "waiting" ? (
      <>
        {blockedItem ? <span className="is-attention">Needs you</span> : null}
        {diffMeta}
        {branch ? (
          <span className="gyro-env-card-mono">{branch} → main</span>
        ) : null}
      </>
    ) : (
      <>
        <span className="gyro-env-card-grow">
          {mode === "done" ? (
            <span className="is-accent">All {total} steps done</span>
          ) : (
            <span>
              Stopped at step {Math.min(done + 1, total)} · {total - done} left
            </span>
          )}
        </span>
        {diffMeta}
        {processMeta}
      </>
    );

  const toggle = () => setIsFolded((value) => !value);

  const railSteps = items.map((item, index) => {
    const isActive = index === activeIndex;
    const isLast = index === items.length - 1;
    return (
      <li
        className={`gyro-env-card-step is-${item.status}${isActive ? " is-active" : ""}`}
        key={item.id}
      >
        <div className="gyro-env-card-track">
          <StepNode isActive={isActive} status={item.status} />
          {isLast ? null : (
            <span
              className={`gyro-env-card-stem${item.status === "complete" ? " is-complete" : ""}`}
            />
          )}
        </div>
        {isActive ? (
          <div className="gyro-env-card-step-body is-highlight">
            <div className="gyro-env-card-step-row is-strong">
              <span className="gyro-env-card-grow">{item.title}</span>
              {liveBeat?.isLive ? (
                <span className="is-accent">Working</span>
              ) : null}
            </div>
            {item.detail ? (
              <p className="gyro-env-card-step-detail">{item.detail}</p>
            ) : null}
            {beats.length ? (
              <ul className="gyro-env-card-beats">
                {beats.map((beat, beatIndex) => (
                  <li
                    className={`gyro-env-card-beat${beat.isLive ? " is-live" : ""}`}
                    key={beat.id}
                  >
                    <div className="gyro-env-card-beat-track">
                      <span className="gyro-env-card-beat-dot" />
                      {beatIndex < beats.length - 1 ? (
                        <span className="gyro-env-card-beat-stem" />
                      ) : null}
                    </div>
                    <span className="gyro-env-card-grow">{beat.label}</span>
                    {beat.additions !== undefined ||
                    beat.deletions !== undefined ? (
                      <span className="gyro-env-card-mono">
                        <Diff
                          additions={beat.additions}
                          deletions={beat.deletions}
                        />
                      </span>
                    ) : beat.ref ? (
                      <span className="gyro-env-card-mono is-dim gyro-env-card-ref">
                        {beat.ref}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="gyro-env-card-step-body">
            <div className="gyro-env-card-step-row">
              <span className="gyro-env-card-grow">{item.title}</span>
              {item.status === "blocked" ? (
                <span className="gyro-env-card-badge">Needs you</span>
              ) : null}
            </div>
          </div>
        )}
      </li>
    );
  });

  if (isPanel) {
    // One primary per screen: a remote action (Take control) outranks git.
    const remotePrimary = Boolean(
      remote?.actions?.some((action) => action.primary),
    );
    // While the host is unreachable or still connecting, the chat's state is
    // the connection, so the header says that instead of "Ready".
    const remoteDot =
      remote?.status === "online"
        ? "is-success"
        : remote?.status === "connecting"
          ? "is-accent"
          : "is-attention";
    const remoteDown = remote !== undefined && remote.status !== "online";
    const remoteActions = remote?.actions?.filter(
      (action) => action.id !== "local",
    );
    const showBranchRow = !remote;
    const hasRows = Boolean(
      showBranchRow || runningPanes.length || workingAgents.length,
    );
    // The panel says one thing at a time: what state the work is in, the plan
    // when there is one, the branch, and anything running. Empty rows stay out.
    const panelProgress = [
      total ? `${done}/${total}` : undefined,
      isRunning && elapsed !== undefined
        ? formatRunDuration(elapsed)
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <section
        className={`gyro-env-card is-panel is-${mode}`}
        onKeyDown={(event) => {
          if (event.key === "Escape" && remoteDetailsOpen) {
            event.stopPropagation();
            setRemoteDetailsOpen(false);
            remoteTrigger.current?.focus();
          }
        }}
      >
        <header className="gyro-env-panel-head">
          <span
            aria-hidden="true"
            className={`gyro-env-card-dot ${remoteDown ? remoteDot : `is-${mode}`}`}
          />
          <span className="gyro-env-panel-status">
            {remoteDown
              ? remote.statusLabel
              : panelStatus(mode, focus.status, blockedItem, focus.focus)}
          </span>
          {panelProgress ? (
            <span className="gyro-env-card-mono is-dim">{panelProgress}</span>
          ) : null}
          {onClose ? (
            <button
              aria-label="Close environment"
              className="gyro-env-card-close"
              onClick={onClose}
              title="Close"
              type="button"
            >
              <X aria-hidden="true" size={14} />
            </button>
          ) : null}
        </header>
        {items.length ? (
          <div className="gyro-env-panel-plan">
            {plan?.title ? (
              <h3 className="gyro-env-panel-title">{plan.title}</h3>
            ) : null}
            <ol className="gyro-env-card-rail" id={bodyId}>
              {railSteps}
            </ol>
          </div>
        ) : null}
        {remote ? (
          <>
            <div className="gyro-env-panel-context">
              <button
                className="gyro-env-panel-branch"
                type="button"
                disabled={remote.status !== "online" || !sourceControl}
                onClick={() =>
                  remote.rows?.find((row) => row.id === "git")?.onClick()
                }
                title={sourceControl?.error ?? "Review changes on host"}
              >
                <GitBranch aria-hidden="true" />
                <span className="gyro-env-card-ellipsis">
                  {branch ??
                    (sourceControl || remoteDown
                      ? "Changes"
                      : "Loading changes…")}
                </span>
              </button>
              <button
                className="gyro-env-panel-location"
                type="button"
                ref={remoteTrigger}
                aria-label={`Remote on ${remote.host}`}
                aria-expanded={remoteDetailsOpen}
                aria-controls={remoteDetailsId}
                title={`Remote on ${remote.host} · ${remote.statusLabel}`}
                onClick={() => setRemoteDetailsOpen((open) => !open)}
              >
                <Monitor aria-hidden="true" />
                <span className="gyro-env-card-ellipsis">
                  Remote · {remote.host}
                </span>
              </button>
              {hasTotals ? (
                <span className="gyro-env-card-mono">
                  <Diff
                    additions={totals.additions}
                    deletions={totals.deletions}
                  />
                </span>
              ) : null}
            </div>
            <div
              className="gyro-env-panel-remote"
              id={remoteDetailsId}
              hidden={!remoteDetailsOpen}
              aria-label={`Remote: ${remote.host}`}
              role="group"
            >
              <div className="gyro-env-panel-remote-head">
                <span
                  aria-hidden="true"
                  className={`gyro-env-card-dot ${remoteDot}`}
                />
                <span
                  className="gyro-env-card-grow gyro-env-card-ellipsis"
                  role="status"
                >
                  {remote.statusLabel}
                </span>
                {remote.onRefresh ? (
                  <button
                    aria-label={`Refresh ${remote.host}`}
                    className="gyro-env-card-close"
                    disabled={remote.isRefreshing}
                    onClick={remote.onRefresh}
                    title="Refresh"
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              {remote.rows?.length ? (
                <div className="gyro-env-panel-rows">
                  {remote.rows.map((row) => (
                    <button
                      aria-pressed={row.pressed}
                      className={`gyro-env-panel-row${row.pressed ? " is-pressed" : ""}`}
                      key={row.id}
                      onClick={row.onClick}
                      type="button"
                    >
                      {row.icon}
                      <span className="gyro-env-card-grow gyro-env-card-ellipsis">
                        {row.label}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              {remote.actions
                ?.filter((action) => action.id === "local")
                .map((action) => (
                  <div
                    className="gyro-env-panel-actions is-remote"
                    key={action.id}
                  >
                    <button
                      className="gyro-env-card-button"
                      onClick={action.onClick}
                      disabled={action.disabled}
                      type="button"
                    >
                      {action.label}
                    </button>
                  </div>
                ))}
            </div>
            {remote.notices?.map((notice) => (
              <p
                className={`gyro-env-panel-note${notice.tone === "warning" ? " is-warning" : ""}`}
                key={notice.id}
              >
                {notice.icon ??
                  (notice.tone === "warning" ? (
                    <span
                      aria-hidden="true"
                      className="gyro-env-card-dot is-attention"
                    />
                  ) : null)}
                <span>{notice.text}</span>
              </p>
            ))}
            {remoteActions?.length ? (
              <div className="gyro-env-panel-actions is-remote">
                {remoteActions.map((action) => (
                  <button
                    className={`gyro-env-card-button${action.primary ? " is-primary" : ""}`}
                    disabled={action.disabled}
                    key={action.id}
                    onClick={action.onClick}
                    type="button"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        {hasRows ? (
          <div className="gyro-env-panel-rows">
            {!showBranchRow ? null : (
              <button
                className="gyro-env-panel-row"
                onClick={openReview}
                title={
                  changedFiles > 0
                    ? `Review ${changedFiles} changed ${changedFiles === 1 ? "file" : "files"}`
                    : "Review changes"
                }
                type="button"
              >
                <GitBranch aria-hidden="true" size={13} />
                <span className="gyro-env-card-grow gyro-env-card-mono">
                  {branch ?? "Changes"}
                </span>
                {hasTotals ? (
                  <span className="gyro-env-card-mono">
                    <Diff
                      additions={totals.additions}
                      deletions={totals.deletions}
                    />
                  </span>
                ) : (
                  <span className="is-dim">
                    {totals.kind === "clean" ? "Clean" : null}
                  </span>
                )}
              </button>
            )}
            {runningPanes.length ? (
              <button
                className="gyro-env-panel-row"
                onClick={() => onOpenTab?.("terminal")}
                title="Open terminal"
                type="button"
              >
                <Terminal aria-hidden="true" size={13} />
                <span className="gyro-env-card-grow gyro-env-card-ellipsis">
                  {runningPanes.length === 1
                    ? runningPanes[0]?.title
                    : `${runningPanes.length} processes`}
                </span>
                <span
                  aria-hidden="true"
                  className="gyro-env-card-dot is-success"
                />
              </button>
            ) : null}
            {workingAgents.length ? (
              <button
                className="gyro-env-panel-row"
                onClick={() => onOpenTab?.("agents")}
                title="Show subagents"
                type="button"
              >
                <Bot aria-hidden="true" size={13} />
                <span className="gyro-env-card-grow gyro-env-card-ellipsis">
                  {workingAgents.length === 1
                    ? workingAgents[0]?.name
                    : `${workingAgents.length} subagents`}
                </span>
                <span
                  aria-hidden="true"
                  className="gyro-env-card-dot is-accent"
                />
              </button>
            ) : null}
          </div>
        ) : null}
        {primaryLabel && !isRunning && !remote ? (
          <div className="gyro-env-panel-actions">
            <button
              className="gyro-env-card-button"
              onClick={openReview}
              type="button"
            >
              Review
            </button>
            <button
              className={`gyro-env-card-button${remotePrimary ? "" : " is-primary"}`}
              onClick={runPrimary}
              type="button"
            >
              {primaryLabel}
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  if (!isOpen) {
    const bar = (
      <>
        {barLead}
        <span className="gyro-env-card-lines">
          <span className="gyro-env-card-line">
            <span className="gyro-env-card-title">{barTitle}</span>
            {mode === "running" ? (
              <SegmentBar isRunning={isRunning} items={items} />
            ) : null}
            <span className="gyro-env-card-mono is-dim">
              {mode === "waiting" ? `${done}/${total}` : progress}
            </span>
          </span>
          <span className="gyro-env-card-line is-meta">{barSecondLine}</span>
        </span>
      </>
    );
    if (mode === "waiting") {
      return (
        <section
          aria-label="Environment"
          className="gyro-env-card is-bar is-waiting"
        >
          <button
            aria-controls={bodyId}
            aria-expanded={false}
            className="gyro-env-card-bar-toggle"
            onClick={toggle}
            type="button"
          >
            {bar}
          </button>
          <button
            className="gyro-env-card-button"
            onClick={openReview}
            type="button"
          >
            Review
          </button>
          {primaryLabel && !blockedItem ? (
            <button
              className="gyro-env-card-button is-primary"
              onClick={runPrimary}
              type="button"
            >
              {primaryLabel}
            </button>
          ) : null}
        </section>
      );
    }
    return (
      <section
        aria-label="Environment"
        className={`gyro-env-card is-bar is-${mode}`}
      >
        <button
          aria-controls={bodyId}
          aria-expanded={false}
          className="gyro-env-card-bar-toggle"
          onClick={toggle}
          type="button"
        >
          {bar}
          <ChevronDown
            aria-hidden="true"
            className="gyro-env-card-chevron"
            size={14}
          />
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label="Environment"
      className={`gyro-env-card is-open is-${mode}`}
    >
      <button
        aria-controls={bodyId}
        aria-expanded
        className="gyro-env-card-header"
        onClick={toggle}
        type="button"
      >
        <h3 className="gyro-env-card-heading">{plan?.title || "Plan"}</h3>
        {modelLabel ? (
          <span className="gyro-env-card-chip">
            <span
              aria-hidden="true"
              className="gyro-env-card-dot is-attention"
            />
            {modelLabel}
          </span>
        ) : null}
        <span className="gyro-env-card-mono is-dim">{progress}</span>
        <ChevronUp
          aria-hidden="true"
          className="gyro-env-card-chevron"
          size={13}
        />
      </button>
      <ol className="gyro-env-card-rail" id={bodyId}>
        {railSteps}
      </ol>
      <div className="gyro-env-card-foot">
        <button
          className="gyro-env-card-cell"
          onClick={openReview}
          title="Review changes"
          type="button"
        >
          <span className="gyro-env-card-cell-label">
            <GitBranch aria-hidden="true" size={12} />
            <span className="gyro-env-card-grow gyro-env-card-mono">
              {branch ?? "Changes"}
            </span>
            <span className="is-accent">Review</span>
          </span>
          <span className="gyro-env-card-cell-value gyro-env-card-mono">
            {hasTotals ? (
              <>
                <Diff
                  additions={totals.additions}
                  deletions={totals.deletions}
                />
                {changedFiles > 0 ? (
                  <span className="is-dim">
                    {" "}
                    · {changedFiles} {changedFiles === 1 ? "file" : "files"}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="is-dim">
                {totals.kind === "clean" ? "Clean" : "—"}
              </span>
            )}
          </span>
        </button>
        <button
          className="gyro-env-card-cell"
          onClick={() => onOpenTab?.("terminal")}
          title="Open terminal"
          type="button"
        >
          <span className="gyro-env-card-cell-label">
            <Terminal aria-hidden="true" size={12} />
            <span className="gyro-env-card-grow">Processes</span>
          </span>
          <span className="gyro-env-card-cell-value gyro-env-card-dotted">
            {runningPanes.length ? (
              <>
                <span
                  aria-hidden="true"
                  className="gyro-env-card-dot is-success"
                />
                <span className="gyro-env-card-ellipsis">
                  {runningPanes.length === 1
                    ? runningPanes[0]?.title
                    : `${runningPanes.length} running`}
                </span>
              </>
            ) : (
              <span className="is-dim">None running</span>
            )}
          </span>
        </button>
        <button
          className="gyro-env-card-cell"
          onClick={() => onOpenTab?.("agents")}
          title="Show subagents"
          type="button"
        >
          <span className="gyro-env-card-cell-label">
            <Bot aria-hidden="true" size={12} />
            <span className="gyro-env-card-grow">Subagents</span>
          </span>
          <span className="gyro-env-card-cell-value gyro-env-card-dotted">
            {workingAgents.length ? (
              <>
                <span
                  aria-hidden="true"
                  className="gyro-env-card-dot is-accent"
                />
                <span className="gyro-env-card-ellipsis">
                  {workingAgents.length === 1
                    ? workingAgents[0]?.name
                    : `${workingAgents.length} working`}
                </span>
              </>
            ) : (
              <span className="is-dim">None working</span>
            )}
          </span>
        </button>
      </div>
      {mode === "waiting" && primaryLabel && !blockedItem ? (
        <div className="gyro-env-card-next">
          <span className="gyro-env-card-grow">{waitingTitle}</span>
          <button
            className="gyro-env-card-button"
            onClick={openReview}
            type="button"
          >
            Review
          </button>
          <button
            className="gyro-env-card-button is-primary"
            onClick={runPrimary}
            type="button"
          >
            {primaryLabel}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function panelStatus(
  mode: CardMode,
  status: string | undefined,
  blockedItem: SessionPlanItem | undefined,
  focus: EnvironmentFocus,
) {
  switch (mode) {
    case "running":
      return status ?? "Working";
    case "waiting":
      return blockedItem ? "Needs you" : (status ?? waitingTitleFor(focus));
    case "done":
      return "Done";
    case "paused":
      return "Stopped";
    default:
      return status ?? "Ready";
  }
}

function waitingTitleFor(focus: EnvironmentFocus) {
  switch (focus) {
    case "commit":
      return "Ready to commit";
    case "push":
      return "Ready to push";
    case "pull-request":
      return "Ready to open a pull request";
    default:
      return "Waiting on you";
  }
}
