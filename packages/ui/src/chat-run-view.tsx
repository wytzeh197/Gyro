import { type ReactNode, useEffect, useState } from "react";
import {
  Book,
  ChevronDown,
  ChevronRight,
  type LucideIcon,
  Lightbulb,
  Minimize2,
  Pencil,
  Search,
  ShieldQuestion,
  SquareTerminal,
  Wrench,
} from "lucide-react";

import {
  formatRunDuration,
  isRunPhaseLive,
  runHeaderLabel,
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
  search: Search,
  context: Minimize2,
  tool: Wrench,
} as const satisfies Record<WorkItem["kind"], LucideIcon>;

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
  const [isCollapsed, setIsCollapsed] = useState(!isLive);
  useEffect(() => {
    setIsCollapsed(!isLive);
  }, [isLive]);
  const canCollapse = !isLive && model.steps.length > 0;
  const showSteps = isLive || !isCollapsed;

  return (
    <div className="gyro-run">
      <RunHeader
        canCollapse={canCollapse}
        headerActions={headerActions}
        isCollapsed={isCollapsed}
        model={model}
        onToggle={() => setIsCollapsed((current) => !current)}
      />
      {showSteps && model.steps.length > 0 ? (
        <ol aria-label="Work timeline" className="gyro-run-rail">
          {model.steps.map((step) => (
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
          ))}
          {model.phase.name === "finalizing" ? (
            <li className="gyro-run-row-item">
              <RunPulse label="Finalizing" />
            </li>
          ) : null}
        </ol>
      ) : null}
      {model.phase.name === "thinking" ? <RunPulse label="Thinking" /> : null}
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
    ? WORK_ICON[item.kind]
    : step.kind === "ask"
      ? ShieldQuestion
      : Lightbulb;
  const status = item?.status ?? "done";
  const file = item?.kind === "file" ? item : undefined;
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

/** The "still going" beat: a label with no icon and no duration to report yet. */
function RunPulse({ label }: { label: string }) {
  return (
    <div className="gyro-run-pulse" role="status">
      {label}
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
