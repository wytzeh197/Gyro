import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Book,
  ChevronDown,
  ChevronRight,
  Eye,
  Image as ImageIcon,
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
  isRunPhaseLive,
  runHeaderLabel,
  runRetryText,
  runRowText,
} from "./chat-run";
import type { RunModel, RunPhase, RunStep, WorkItem } from "./chat-run";
import type { SessionEvent } from "./types";

/**
 * The run rail: a flat, timestamp-free list of beats.
 *
 * Every parser lives in `chat-run.ts`, so nothing here reads an event payload.
 * A row is an icon, a label, and an optional muted description — the wording
 * arrives already decided by `runRowText`.
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
  tool: Wrench,
} as const satisfies Record<WorkItem["kind"], LucideIcon>;

/** A read of an image is still a read, but the eye undersells what happened. */
function workIcon(item: WorkItem): LucideIcon {
  if (item.kind === "read" && item.media === "image") {
    return ImageIcon;
  }
  return WORK_ICON[item.kind];
}

export type ChatRunProps = {
  model: RunModel;
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
};

export function ChatRun({
  model,
  onOpenChanges,
  onRetry,
  onReconnect,
  reconnectLabel,
  headerActions,
  renderAsk,
  renderSay,
}: ChatRunProps) {
  const isLive = isRunPhaseLive(model.phase);
  // A fully answered turn — work on the rail plus a final answer — is history:
  // it starts collapsed, and folds itself away the moment it settles, so the
  // answer is what stays on screen. Incomplete settles (a mid-task stop, a
  // failure) stay open, because collapsing those leaves an empty "Worked for …"
  // void with no answer under it.
  const isAnswered =
    model.phase.name === "done" &&
    Boolean(model.response) &&
    model.steps.length > 0;
  const [isCollapsed, setIsCollapsed] = useState(() => !isLive && isAnswered);
  // One automatic fold per run: after that the user's own toggle wins, so
  // expanding a just-finished trail does not snap shut under them.
  const hasAutoCollapsed = useRef(!isLive && isAnswered);
  useEffect(() => {
    // Re-open when a turn goes live again (retry / reconnect), and arm the next
    // fold.
    if (isLive) {
      hasAutoCollapsed.current = false;
      setIsCollapsed(false);
      return;
    }
    if (isAnswered && !hasAutoCollapsed.current) {
      hasAutoCollapsed.current = true;
      setIsCollapsed(true);
    }
  }, [isAnswered, isLive]);
  const canCollapse = !isLive && model.steps.length > 0;
  const showSteps = isLive || !isCollapsed;
  // Keep a thinking beat while the model is quiet between tools, not only at
  // the empty start of a run — otherwise the rail freezes on the last Done row.
  const hasRunningWork = model.steps.some(
    (step) => step.kind === "work" && step.item.status === "running",
  );
  const showThinkingPulse =
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

  return (
    <div className="gyro-run">
      <RunHeader
        canCollapse={canCollapse}
        headerActions={headerActions}
        isCollapsed={isCollapsed}
        model={model}
        onToggle={() => setIsCollapsed((current) => !current)}
      />
      {showRail ? (
        <ol aria-label="Work timeline" className="gyro-run-rail">
          {showSteps
            ? model.steps.map((step) => (
                <li className="gyro-run-row-item" key={step.id}>
                  {step.kind === "ask" && renderAsk ? (
                    renderAsk(step.event)
                  ) : (
                    <RunRow
                      onOpenChanges={onOpenChanges}
                      renderSay={renderSay}
                      step={step}
                    />
                  )}
                </li>
              ))
            : null}
          {showFinalizingPulse ? (
            <li className="gyro-run-row-item">
              <RunPulse label="Finalizing" />
            </li>
          ) : null}
          {showThinkingPulse ? (
            <li className="gyro-run-row-item">
              <RunPulse label="Thinking" />
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

function RunHeader({
  canCollapse,
  headerActions,
  isCollapsed,
  model,
  onToggle,
}: {
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
  return (
    <div className="gyro-run-header">
      {canCollapse ? (
        <button
          aria-expanded={!isCollapsed}
          className="gyro-run-header-toggle"
          onClick={onToggle}
          type="button"
        >
          <span>{label}</span>
          {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : (
        <span>{label}</span>
      )}
      {headerActions ? (
        <span className="gyro-run-header-actions">{headerActions}</span>
      ) : null}
    </div>
  );
}

function RunRow({
  onOpenChanges,
  renderSay,
  step,
}: {
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
        {file && ((file.additions ?? 0) > 0 || (file.deletions ?? 0) > 0) ? (
          <span className="gyro-run-row-stat">
            {(file.additions ?? 0) > 0 ? (
              <em className="is-added">+{file.additions}</em>
            ) : null}
            {(file.deletions ?? 0) > 0 ? (
              <em className="is-removed">-{file.deletions}</em>
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
  const detail = isInterrupted
    ? "Gyro restarted or lost the provider before this turn finished. Retry continues the same message."
    : (phase.recoveryMessage ?? undefined);
  return (
    <div className="gyro-run-problem" role="alert">
      <span className="gyro-run-problem-text">
        <strong>
          {isInterrupted ? "Previous send was interrupted" : phase.message}
        </strong>
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
