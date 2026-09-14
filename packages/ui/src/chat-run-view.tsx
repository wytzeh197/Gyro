import { type ReactNode, useEffect, useState } from "react";
import {
  Book,
  ChevronDown,
  ChevronRight,
  Eye,
  FileCode2,
  Globe2,
  Image as ImageIcon,
  ListChecks,
  type LucideIcon,
  Lightbulb,
  Minimize2,
  Pencil,
  RotateCw,
  Search,
  ShieldQuestion,
  SquareTerminal,
  Wrench,
} from "lucide-react";

import {
  formatRunDuration,
  groupRunSteps,
  isCancelledRunPhase,
  isRunPhaseLive,
  liveWindow,
  runCallText,
  runHeaderLabel,
  runRetryText,
  runRowText,
  runWorkGroupText,
  segmentRunSteps,
  segmentWorkSteps,
  summarizeSegment,
} from "./chat-run";
import type {
  RunModel,
  RunPhase,
  RunStep,
  WorkGroup,
  WorkItem,
} from "./chat-run";
import type { SessionEvent } from "./types";

/**
 * The run rail: a timestamp-free working summary.
 *
 * Every parser and grouping rule lives in `chat-run.ts`, so nothing here reads
 * an event payload. The compact group tells the story; its detail preserves the
 * exact steps for someone who needs to inspect them.
 */

/**
 * One icon per kind, with no fallback. `satisfies` makes a new `WorkItem` kind a
 * compile error here rather than something that silently picks up whichever
 * default the nearest branch happened to use.
 */
const WORK_ICON = {
  command: SquareTerminal,
  file: Pencil,
  memory: Book,
  read: Eye,
  search: Search,
  context: Minimize2,
  browser: Globe2,
  tool: Wrench,
} as const satisfies Record<WorkItem["kind"], LucideIcon>;

const WORK_GROUP_ICON = {
  review: Search,
  change: Pencil,
  verify: ListChecks,
  command: SquareTerminal,
  browser: Globe2,
} as const satisfies Record<WorkGroup["groupKind"], LucideIcon>;

/** A read of an image is still a read, but the eye undersells what happened. */
function workIcon(item: WorkItem): LucideIcon {
  if (item.kind === "read" && item.media === "image") {
    return ImageIcon;
  }
  return WORK_ICON[item.kind];
}

export type ChatRunProps = {
  model: RunModel;
  /** Optional host state when work is preparing or waiting for a person. */
  statusLabel?: string;
  suppressThinkingIndicator?: boolean;
  /** Turn-wide line delta for a provider's generic “files” activity. */
  aggregateFileStats?: { additions: number; deletions: number };
  onOpenChanges?: () => void;
  onRetry?: () => void;
  onReconnect?: () => void;
  reconnectLabel?: string;
  /** Trailing header content, such as a Continue button on a settled turn. */
  headerActions?: ReactNode;
  /**
   * How to draw an approval beat. An approval needs its own decision buttons and
   * the handlers that back them, which belong to the chat surface rather than
   * here; without this the row degrades to the request text alone.
   */
  renderAsk?: (event: SessionEvent) => ReactNode;
  /** How to draw narration, so inline code and links survive the rail. */
  renderSay?: (text: string) => ReactNode;
  /**
   * `segments` (default) reads as narration with each stretch of work under it,
   * folded to a one-line summary once the agent moves on. `groups` is the older
   * phase view ("Reviewed workspace") for surfaces that want the coarser story.
   */
  layout?: "segments" | "groups";
};

type WorkStep = Extract<RunStep, { kind: "work" }>;
type FileStats = { additions: number; deletions: number };

/** Newest calls kept on screen while a stretch of work is still running. */
const LIVE_CALL_WINDOW = 4;

export function ChatRun({
  model,
  statusLabel,
  suppressThinkingIndicator = false,
  aggregateFileStats,
  onOpenChanges,
  onRetry,
  onReconnect,
  reconnectLabel,
  headerActions,
  renderAsk,
  renderSay,
  layout = "segments",
}: ChatRunProps) {
  const isLive = isRunPhaseLive(model.phase);
  // A finished turn leads with its final response. Work remains available
  // behind the header; live work and failures stay open for visibility.
  const isDone = model.phase.name === "done";
  const [isCollapsed, setIsCollapsed] = useState(isDone);
  useEffect(() => {
    setIsCollapsed(isDone);
  }, [isLive, isDone]);
  const canCollapse = !isLive && model.steps.length > 0;
  const showSteps = isLive || !isCollapsed;
  const isSegments = layout === "segments";
  // Reasoning headlines only ever speak at the live tail, so the phase view
  // never sees them.
  const displaySteps = groupRunSteps(
    model.steps.filter((step) => step.kind !== "status"),
  );
  const segments = segmentRunSteps(model.steps);
  const tailSegment = segments.at(-1);
  const lastStep = model.steps.at(-1);
  const tailStatus = lastStep?.kind === "status" ? lastStep.text : undefined;
  // The phase view names the currently live phase in the header. The segment
  // view does not need to: the live call is already on screen under it, and
  // the header stays the steady "Working for 21s".
  const activeGroup = displaySteps.findLast(
    (step): step is WorkGroup =>
      step.kind === "work-group" && step.status === "running",
  );
  const activeContextStep = displaySteps.findLast(
    (step): step is Extract<RunStep, { kind: "work" }> =>
      step.kind === "work" &&
      step.item.kind === "context" &&
      step.item.status === "running",
  );
  const activeLabel = isSegments
    ? undefined
    : activeContextStep
      ? runRowText(activeContextStep).label
      : activeGroup
        ? runWorkGroupText(activeGroup).label
        : undefined;
  // Keep a thinking beat while the model is quiet between tools, not only at
  // the empty start of a run — otherwise the rail freezes on the last Done row.
  const hasRunningWork = model.steps.some(
    (step) => step.kind === "work" && step.item.status === "running",
  );
  const showThinkingPulse =
    !suppressThinkingIndicator &&
    isLive &&
    (model.phase.name === "thinking" ||
      (model.phase.name === "working" && !hasRunningWork));
  const showFinalizingPulse = model.phase.name === "finalizing";
  // The retry beat replaces the other live beats rather than joining them: two
  // things breathing at the tail of the rail reads as two runs.
  const retryPhase = model.phase.name === "retrying" ? model.phase : undefined;
  const showRail =
    showSteps &&
    (model.steps.length > 0 ||
      showThinkingPulse ||
      showFinalizingPulse ||
      retryPhase !== undefined);

  const shellClass = [
    "gyro-run",
    isSegments ? "is-segments" : "is-groups",
    isLive
      ? model.phase.name === "retrying"
        ? "is-retrying"
        : "is-live"
      : (model.phase.name === "failed" || model.phase.name === "interrupted") &&
          !isCancelledRunPhase(model.phase)
        ? "is-problem"
        : "is-settled",
    isCancelledRunPhase(model.phase) ? "is-cancelled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClass}>
      <RunHeader
        statusLabel={statusLabel}
        canCollapse={canCollapse}
        headerActions={headerActions}
        isCollapsed={isCollapsed}
        model={model}
        activeLabel={activeLabel}
        onToggle={() => setIsCollapsed((current) => !current)}
      />
      {showRail ? (
        <ol aria-label="Work timeline" className="gyro-run-rail">
          {showSteps && isSegments
            ? segments.map((segment) => {
                if (segment.kind === "say") {
                  return (
                    <li
                      className="gyro-run-row-item gyro-run-say-item"
                      key={segment.id}
                    >
                      <RunRow renderSay={renderSay} step={segment.step} />
                    </li>
                  );
                }
                if (segment.kind === "ask") {
                  return (
                    <li
                      className={
                        renderAsk
                          ? "gyro-run-row-item gyro-run-approval-item"
                          : "gyro-run-row-item"
                      }
                      key={segment.id}
                    >
                      {renderAsk ? (
                        renderAsk(segment.step.event)
                      ) : (
                        <RunRow step={segment.step} />
                      )}
                    </li>
                  );
                }
                const calls = segmentWorkSteps(segment.steps);
                if (calls.length === 0) {
                  return null;
                }
                const isTail = isLive && segment === tailSegment;
                return (
                  <li
                    className="gyro-run-row-item gyro-run-segment-item"
                    key={segment.id}
                  >
                    {isTail || calls.length === 1 ? (
                      <RunCalls
                        aggregateFileStats={aggregateFileStats}
                        calls={calls}
                        onOpenChanges={onOpenChanges}
                        windowed={isTail}
                      />
                    ) : (
                      <RunSegmentSummary
                        aggregateFileStats={aggregateFileStats}
                        calls={calls}
                        onOpenChanges={onOpenChanges}
                      />
                    )}
                  </li>
                );
              })
            : null}
          {showSteps && !isSegments
            ? displaySteps.map((step) => {
                if (step.kind === "work-group") {
                  return (
                    <li
                      className="gyro-run-row-item gyro-run-group-item"
                      key={step.id}
                    >
                      <RunWorkGroup
                        aggregateFileStats={aggregateFileStats}
                        group={step}
                        onOpenChanges={onOpenChanges}
                      />
                    </li>
                  );
                }
                return (
                  <li
                    className={
                      step.kind === "ask" && renderAsk
                        ? "gyro-run-row-item gyro-run-approval-item"
                        : "gyro-run-row-item"
                    }
                    key={step.id}
                  >
                    {step.kind === "ask" && renderAsk ? (
                      renderAsk(step.event)
                    ) : (
                      <RunRow
                        aggregateFileStats={aggregateFileStats}
                        onOpenChanges={onOpenChanges}
                        renderSay={renderSay}
                        step={step}
                      />
                    )}
                  </li>
                );
              })
            : null}
          {showFinalizingPulse ? (
            <li className="gyro-run-row-item">
              <RunPulse label="Finalizing" />
            </li>
          ) : null}
          {showThinkingPulse ? (
            <li className="gyro-run-row-item">
              {/* A reasoning headline, when the provider sent one, is the more
                  honest version of "Thinking": it says what about. */}
              {isSegments && tailStatus ? (
                <RunPulse label={tailStatus} />
              ) : (
                <RunPulse label="Thinking" />
              )}
            </li>
          ) : null}
          {retryPhase ? (
            <li className="gyro-run-row-item">
              <RunRetry phase={retryPhase} />
            </li>
          ) : null}
        </ol>
      ) : null}
      {model.phase.name === "failed" || model.phase.name === "interrupted" ? (
        <RunProblem
          onReconnect={onReconnect}
          onRetry={onRetry}
          phase={model.phase}
          reconnectLabel={reconnectLabel}
        />
      ) : null}
    </div>
  );
}

function RunWorkGroup({
  aggregateFileStats,
  group,
  onOpenChanges,
}: {
  aggregateFileStats?: { additions: number; deletions: number };
  group: WorkGroup;
  onOpenChanges?: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const text = runWorkGroupText(group);
  const reads = group.steps.flatMap((step) =>
    step.item.kind === "read" && step.item.path ? [step.item] : [],
  );
  const activeRead =
    reads.find((item) => item.status === "running") ?? reads.at(-1);
  const readPaths = [...new Set(reads.map((item) => item.path))];
  const Icon = WORK_GROUP_ICON[group.groupKind];
  const className = [
    "gyro-run-group",
    `is-${group.groupKind}`,
    group.status === "running" ? "is-running" : "",
    group.status === "failed" ? "is-failed" : "",
    isExpanded ? "is-expanded" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const detailLabel = isExpanded ? "Hide details" : "Show details";

  return (
    <div className={className}>
      <button
        aria-expanded={isExpanded}
        aria-label={`${text.label}, ${text.description}. ${detailLabel}`}
        className="gyro-run-group-toggle"
        onClick={() => setIsExpanded((current) => !current)}
        title={detailLabel}
        type="button"
      >
        <span aria-hidden="true" className="gyro-run-row-icon">
          <Icon size={15} />
        </span>
        <span className="gyro-run-group-text">
          <span className="gyro-run-row-label">{text.label}</span>
          <span className="gyro-run-row-detail">{text.description}</span>
          {activeRead ? (
            <span
              className="gyro-run-read-context"
              title={readPaths.join("\n")}
            >
              <FileCode2 aria-hidden="true" size={13} />
              <span>{activeRead.path}</span>
              {readPaths.length > 1 ? (
                <small>+{readPaths.length - 1} more</small>
              ) : null}
            </span>
          ) : null}
        </span>
        <span aria-hidden="true" className="gyro-run-group-disclosure">
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {isExpanded ? (
        <ol aria-label="Technical details" className="gyro-run-group-details">
          {group.steps.map((step) => (
            <li key={step.id}>
              <RunRow
                aggregateFileStats={aggregateFileStats}
                onOpenChanges={onOpenChanges}
                step={step}
              />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * A finished stretch of work as one line — "Ran 3 commands, Read 1 file ›" —
 * that opens onto the exact calls behind it.
 */
function RunSegmentSummary({
  aggregateFileStats,
  calls,
  onOpenChanges,
}: {
  aggregateFileStats?: FileStats;
  calls: WorkStep[];
  onOpenChanges?: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const failed = calls.some((step) => step.item.status === "failed");
  const className = [
    "gyro-run-segment",
    isExpanded ? "is-expanded" : "",
    failed ? "is-failed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={className}>
      <button
        aria-expanded={isExpanded}
        className="gyro-run-segment-toggle"
        onClick={() => setIsExpanded((current) => !current)}
        type="button"
      >
        <span className="gyro-run-segment-label">
          {summarizeSegment(calls)}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="gyro-run-segment-chevron"
          size={12}
        />
      </button>
      {isExpanded ? (
        <RunCalls
          aggregateFileStats={aggregateFileStats}
          calls={calls}
          onOpenChanges={onOpenChanges}
          windowed={false}
        />
      ) : null}
    </div>
  );
}

/**
 * The exact calls of a stretch. While the stretch is live only the newest few
 * stay on screen, so a long run of reads scrolls under a "+N more" line rather
 * than pushing the narration out of view.
 */
function RunCalls({
  aggregateFileStats,
  calls,
  onOpenChanges,
  windowed,
}: {
  aggregateFileStats?: FileStats;
  calls: WorkStep[];
  onOpenChanges?: () => void;
  windowed: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const now = useNow(calls.some((step) => step.item.status === "running"));
  const { visible, hiddenCount } =
    windowed && !showAll
      ? liveWindow(calls, LIVE_CALL_WINDOW)
      : { visible: calls, hiddenCount: 0 };
  return (
    <ol aria-label="Tool calls" className="gyro-run-calls">
      {hiddenCount > 0 ? (
        <li>
          <button
            className="gyro-run-calls-more"
            onClick={() => setShowAll(true)}
            type="button"
          >
            +{hiddenCount} more tool {hiddenCount === 1 ? "call" : "calls"}
          </button>
        </li>
      ) : null}
      {visible.map((step) => (
        <li key={step.id}>
          <RunCallRow
            aggregateFileStats={aggregateFileStats}
            now={now}
            onOpenChanges={onOpenChanges}
            step={step}
          />
        </li>
      ))}
    </ol>
  );
}

/** One call, as one muted line: icon, "Ran git status", then its state. */
function RunCallRow({
  aggregateFileStats,
  now,
  onOpenChanges,
  step,
}: {
  aggregateFileStats?: FileStats;
  now: number;
  onOpenChanges?: () => void;
  step: WorkStep;
}) {
  const item = step.item;
  const text = runCallText(step);
  const Icon = workIcon(item);
  const repeat = step.repeat ?? 1;
  const file = item.kind === "file" ? item : undefined;
  const lineStats = fileLineStats(file, aggregateFileStats);
  const startedAt = Date.parse(step.at);
  const elapsed =
    item.status === "running" && Number.isFinite(startedAt)
      ? formatRunDuration(Math.max(0, Math.round((now - startedAt) / 1_000)))
      : undefined;
  const className = [
    "gyro-run-call",
    `is-${item.kind}`,
    item.status === "running" ? "is-running" : "",
    item.status === "failed" ? "is-failed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <span aria-hidden="true" className="gyro-run-row-icon">
        <Icon size={14} />
      </span>
      <span className="gyro-run-call-text">
        <span className="gyro-run-call-verb">{text.label}</span>
        {text.description ? (
          <span className="gyro-run-call-target">{text.description}</span>
        ) : null}
      </span>
      {repeat > 1 ? (
        <span className="gyro-run-row-repeat">×{repeat}</span>
      ) : null}
      {lineStats ? (
        <span className="gyro-run-row-stat">
          {lineStats.additions > 0 ? (
            <em className="is-added">+{lineStats.additions}</em>
          ) : null}
          {lineStats.deletions > 0 ? (
            <em className="is-removed">-{lineStats.deletions}</em>
          ) : null}
        </span>
      ) : null}
      {elapsed ? (
        <span className="gyro-run-call-meta">
          · Active now · {elapsed} elapsed
        </span>
      ) : null}
      {item.status === "failed" ? (
        <span className="gyro-run-call-meta is-failed">· Failed</span>
      ) : null}
    </>
  );

  if (file && onOpenChanges) {
    return (
      <button
        className={`${className} is-actionable`}
        onClick={onOpenChanges}
        title={file.path}
        type="button"
      >
        {body}
        <ChevronRight
          aria-hidden="true"
          className="gyro-run-call-chevron"
          size={12}
        />
      </button>
    );
  }
  return (
    <div className={className} title={text.description}>
      {body}
    </div>
  );
}

/** A clock for "Ns elapsed", ticking only while something is running. */
function useNow(isTicking: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isTicking) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isTicking]);
  return now;
}

function RunHeader({
  activeLabel,
  statusLabel,
  canCollapse,
  headerActions,
  isCollapsed,
  model,
  onToggle,
}: {
  activeLabel?: string;
  statusLabel?: string;
  canCollapse: boolean;
  headerActions?: ReactNode;
  isCollapsed: boolean;
  model: RunModel;
  onToggle: () => void;
}) {
  const elapsed = useElapsedSeconds(model);
  const label = runHeaderLabel(
    model.phase,
    elapsed === undefined ? undefined : formatRunDuration(elapsed),
  );
  const headerLabel =
    statusLabel ??
    (activeLabel && elapsed !== undefined
      ? `${activeLabel} · ${formatRunDuration(elapsed)}`
      : (activeLabel ?? label));
  return (
    <div className="gyro-run-header">
      {canCollapse ? (
        <button
          aria-expanded={!isCollapsed}
          className="gyro-run-header-toggle"
          onClick={onToggle}
          type="button"
        >
          <span>{headerLabel}</span>
          {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : (
        <span>{headerLabel}</span>
      )}
      {headerActions ? (
        <span className="gyro-run-header-actions">{headerActions}</span>
      ) : null}
    </div>
  );
}

function RunRow({
  aggregateFileStats,
  onOpenChanges,
  renderSay,
  step,
}: {
  aggregateFileStats?: FileStats;
  onOpenChanges?: () => void;
  renderSay?: (text: string) => ReactNode;
  step: RunStep;
}) {
  const text = runRowText(step);
  const item = step.kind === "work" ? step.item : undefined;
  const Icon = item
    ? workIcon(item)
    : step.kind === "ask"
      ? ShieldQuestion
      : Lightbulb;
  const status = item?.status ?? "done";
  const file = item?.kind === "file" ? item : undefined;
  const repeat = step.kind === "work" ? (step.repeat ?? 1) : 1;
  const lineStats = fileLineStats(file, aggregateFileStats);
  const className = [
    "gyro-run-row",
    `is-${step.kind}`,
    item ? `is-${item.kind}` : "",
    status === "running" ? "is-running" : "",
    status === "failed" ? "is-failed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <span aria-hidden="true" className="gyro-run-row-icon">
        <Icon size={15} />
      </span>
      <span className="gyro-run-row-text">
        <span className="gyro-run-row-label">
          {step.kind === "say" && renderSay ? renderSay(step.text) : text.label}
        </span>
        {text.description ? (
          <span className="gyro-run-row-detail">{text.description}</span>
        ) : null}
        {/* How many times the same beat folded in. Only ever drawn above one,
            so a row that happened once stays exactly as it was. */}
        {repeat > 1 ? (
          <span className="gyro-run-row-repeat">×{repeat}</span>
        ) : null}
        {/* A side with no lines is left off entirely: the reference shows a bare
            `+73`, and a trailing `-0` is noise on every new file. */}
        {lineStats ? (
          <span className="gyro-run-row-stat">
            {lineStats.additions > 0 ? (
              <em className="is-added">+{lineStats.additions}</em>
            ) : null}
            {lineStats.deletions > 0 ? (
              <em className="is-removed">-{lineStats.deletions}</em>
            ) : null}
          </span>
        ) : null}
      </span>
    </>
  );

  // A file row is the way into Source Control. Keeping the affordance on the row
  // is what lets the rail stay card-free.
  if (file && onOpenChanges) {
    return (
      <button
        className={`${className} is-actionable`}
        onClick={onOpenChanges}
        title={file.path}
        type="button"
      >
        {body}
      </button>
    );
  }
  // Only attach a native tooltip when it adds detail the row does not already
  // show (truncated path, full command). Duplicating the label on hover is noise.
  const title =
    text.description && text.description !== text.label
      ? text.description
      : undefined;
  return (
    <div className={className} title={title}>
      {body}
    </div>
  );
}

function fileLineStats(
  file: Extract<WorkItem, { kind: "file" }> | undefined,
  aggregate: { additions: number; deletions: number } | undefined,
) {
  if (!file) return undefined;
  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;
  if (additions > 0 || deletions > 0) {
    return { additions, deletions };
  }
  // Some provider streams report a batch as “Edited files” instead of naming
  // each path. The source-control delta still gives that row a useful result.
  if (file.path.trim().toLowerCase() !== "files") return undefined;
  if (!aggregate || (aggregate.additions === 0 && aggregate.deletions === 0)) {
    return undefined;
  }
  return aggregate;
}

/**
 * The "reaching for the provider again" beat.
 *
 * Built from the same two spans and the same grid as a work row, so it lands at
 * exactly the size of a "Ran command" line and the spine runs through it
 * unbroken. Only the motion tells it apart: the icon sweeps once per cycle and
 * then holds, which reads as an attempt followed by a wait rather than the
 * even breathing of work that is going fine. It stays in the muted palette on
 * purpose — the danger colour belongs to the failure block, for when retrying
 * has stopped being the answer.
 */
function RunRetry({
  phase,
}: {
  phase: Extract<RunPhase, { name: "retrying" }>;
}) {
  const text = runRetryText(phase);
  return (
    <div className="gyro-run-row gyro-run-retry" role="status">
      <span aria-hidden="true" className="gyro-run-row-icon">
        <RotateCw size={15} />
      </span>
      <span className="gyro-run-row-text">
        <span className="gyro-run-row-label">{text.label}</span>
        {text.description ? (
          <span className="gyro-run-row-detail">{text.description}</span>
        ) : null}
      </span>
    </div>
  );
}

/** The "still going" beat: sits on the rail spine so an empty run still has shape. */
function RunPulse({ label }: { label: string }) {
  return (
    <div className="gyro-run-pulse" role="status">
      <span aria-hidden="true" className="gyro-run-row-icon">
        <Lightbulb size={15} />
      </span>
      <span className="gyro-run-pulse-label">{label}</span>
    </div>
  );
}

function RunProblem({
  onReconnect,
  onRetry,
  phase,
  reconnectLabel,
}: {
  onReconnect?: () => void;
  onRetry?: () => void;
  phase: Extract<RunPhase, { name: "failed" | "interrupted" }>;
  reconnectLabel?: string;
}) {
  const isInterrupted = phase.name === "interrupted";
  const isCancelled =
    phase.name === "failed" && phase.recoveryKind === "cancelled";
  if (isCancelled) return null; // The neutral Stopped header is sufficient.
  const detail = isInterrupted
    ? "Gyro restarted or lost the provider before this turn finished. Retry continues the same message."
    : phase.recoveryMessage;
  const title = isInterrupted ? "Previous send was interrupted" : phase.message;
  return (
    <div
      className={["gyro-run-problem", isInterrupted ? "is-interrupted" : ""]
        .filter(Boolean)
        .join(" ")}
      role="alert"
    >
      <span className="gyro-run-problem-text">
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </span>
      <span className="gyro-run-problem-actions">
        {onRetry ? (
          <button onClick={onRetry} type="button">
            Retry
          </button>
        ) : null}
        {onReconnect ? (
          <button onClick={onReconnect} type="button">
            {reconnectLabel ?? "Reconnect"}
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Seconds to show in the header, or undefined when no honest number exists.
 *
 * The interval only runs while the phase is live, so a settled transcript full
 * of finished runs schedules no timers at all.
 */
function useElapsedSeconds(model: RunModel) {
  const isLive = isRunPhaseLive(model.phase);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isLive]);

  if (model.phase.name === "done") {
    return model.phase.durationMs === undefined
      ? undefined
      : Math.max(0, Math.round(model.phase.durationMs / 1_000));
  }
  if (!isLive) {
    return undefined;
  }
  const start = Date.parse(model.startedAt);
  return Number.isFinite(start)
    ? Math.max(0, Math.round((now - start) / 1_000))
    : 0;
}
