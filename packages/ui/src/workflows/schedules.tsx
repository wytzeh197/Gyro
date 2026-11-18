import { useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Plus,
  Search,
  Workflow,
} from "lucide-react";
import {
  automationDateLabel,
  automationScheduleLabel,
  isRecordedAutomationRun,
  type RenderScheduleIndex,
} from "../scheduled-work";
import type { Automation } from "../types";
import { runAttentionReason, statusLabels, StatusPill } from "./status";
import type { WorkflowJob, WorkflowRunSummary } from "./types";

type ScheduleRow =
  { kind: "prompt"; job: Automation } | { kind: "workflow"; job: WorkflowJob };

export function WorkflowSchedules({
  jobs,
  runs,
  loading,
  loadError,
  onRefresh,
  onChooseWorkflow,
  onReviewSetup,
  onToggle,
  promptIndex,
}: {
  jobs: WorkflowJob[];
  runs: WorkflowRunSummary[];
  loading: boolean;
  loadError: boolean;
  onRefresh: () => void;
  onChooseWorkflow?: () => void;
  onReviewSetup: (job: WorkflowJob) => Promise<void>;
  onToggle: (job: WorkflowJob) => Promise<void>;
  promptIndex?: Parameters<RenderScheduleIndex>[0];
}) {
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const schedules: ScheduleRow[] = [
    ...jobs.map((job) => ({ kind: "workflow" as const, job })),
    ...(promptIndex?.automations ?? []).map((job) => ({
      kind: "prompt" as const,
      job,
    })),
  ];
  const visible = schedules
    .filter(
      ({ job }) =>
        (!filter || job.status === filter) &&
        `${job.title} ${job.execution?.workspacePath ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    )
    .sort(
      (a, b) =>
        (a.job.status === "current" ? 0 : 1) -
          (b.job.status === "current" ? 0 : 1) ||
        (a.job.nextRunAt ?? "\uffff").localeCompare(
          b.job.nextRunAt ?? "\uffff",
        ) ||
        a.job.title.localeCompare(b.job.title),
    );

  async function act(
    action: (job: WorkflowJob) => Promise<void>,
    job: WorkflowJob,
  ) {
    setBusy(job.id);
    try {
      await action(job);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="gyro-workflow-scheduled" aria-label="Schedules">
      <header className="gyro-workflow-page-heading gyro-workflow-heading-actions">
        <div>
          <h1>Schedules</h1>
          <p>Scheduled runs start on this Mac while Gyro is open.</p>
        </div>
        {onChooseWorkflow || promptIndex ? (
          <button
            className="gyro-primary-button"
            disabled={promptIndex?.busy}
            aria-expanded={creating}
            aria-controls="gyro-new-schedule"
            onClick={() => setCreating(!creating)}
          >
            <Plus size={14} aria-hidden="true" /> New schedule
          </button>
        ) : null}
      </header>
      <div id="gyro-new-schedule" hidden={!creating}>
        <ul className="gyro-workflow-rows">
          {onChooseWorkflow ? (
            <li className="is-link">
              <button className="gyro-workflow-row" onClick={onChooseWorkflow}>
                <span className="gyro-workflow-icon-tile">
                  <Workflow size={16} aria-hidden="true" />
                </span>
                <span className="gyro-workflow-row-body">
                  <strong>Schedule a workflow</strong>
                  <small>Pick a saved workflow and set when it runs.</small>
                </span>
                <ChevronRight
                  className="gyro-workflow-row-chevron"
                  size={16}
                  aria-hidden="true"
                />
              </button>
            </li>
          ) : null}
          {promptIndex ? (
            <li className="is-link">
              <button
                className="gyro-workflow-row"
                onClick={() => {
                  setCreating(false);
                  promptIndex.onCreatePrompt();
                }}
              >
                <span className="gyro-workflow-icon-tile">
                  <MessageSquare size={16} aria-hidden="true" />
                </span>
                <span className="gyro-workflow-row-body">
                  <strong>Schedule a prompt</strong>
                  <small>Give Gyro a task to run on a schedule.</small>
                </span>
                <ChevronRight
                  className="gyro-workflow-row-chevron"
                  size={16}
                  aria-hidden="true"
                />
              </button>
            </li>
          ) : null}
        </ul>
      </div>
      {loading ? (
        <p className="gyro-workflow-muted" role="status">
          Loading workflow schedules…
        </p>
      ) : null}
      {loadError ? (
        <div className="gyro-workflow-section-head is-row">
          <p role="status">Workflow schedules couldn’t be loaded.</p>
          <button onClick={onRefresh}>Retry</button>
        </div>
      ) : null}
      {schedules.length ? (
        <>
          <div className="gyro-workflow-section-head is-row gyro-workflow-list-tools">
            <label className="gyro-workflow-search">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label="Search schedules"
                type="search"
                placeholder="Search schedules…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <span className="gyro-workflow-select">
              <select
                aria-label="Schedule status"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="">All statuses</option>
                <option value="current">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
              </select>
              <ChevronDown size={13} aria-hidden="true" />
            </span>
          </div>
          {visible.length ? (
            <ul className="gyro-workflow-rows">
              {visible.map((row) => {
                const { job, kind } = row;
                const calendar = job.execution?.calendar;
                const next =
                  job.status === "current" && job.nextRunAt
                    ? automationDateLabel(job.nextRunAt, calendar?.timezone)
                    : undefined;
                const relatedRuns = runs.filter(
                  (run) => run.automationId === job.id,
                );
                const activeRun = relatedRuns.find((run) =>
                  ["queued", "running", "waiting"].includes(run.status),
                );
                const promptRun =
                  row.kind === "prompt" &&
                  row.job.runHistory[0]?.status === "running";
                const inFlight = Boolean(
                  job.leaseOwner || activeRun || promptRun,
                );
                const scheduleStatus =
                  job.status === "current" ? "active" : job.status;
                const displayStatus =
                  activeRun?.status ??
                  (promptRun
                    ? "running"
                    : job.leaseOwner
                      ? "starting"
                      : scheduleStatus);
                const lastWorkflowRun =
                  row.kind === "workflow"
                    ? relatedRuns
                        .filter((run) => run.finishedAt)
                        .sort((a, b) =>
                          b.finishedAt!.localeCompare(a.finishedAt!),
                        )[0]
                    : undefined;
                const lastRecord = job.runHistory.find(
                  (run) =>
                    !["queued", "running"].includes(run.status) &&
                    isRecordedAutomationRun(run),
                );
                const last = lastWorkflowRun
                  ? (runAttentionReason(lastWorkflowRun) ??
                    (lastWorkflowRun.requirementsMet === true
                      ? "Passed"
                      : statusLabels[lastWorkflowRun.status]))
                  : lastRecord
                    ? statusLabels[lastRecord.status]
                    : undefined;
                const cadence =
                  kind === "prompt"
                    ? automationScheduleLabel(row.job)
                    : row.job.schedule === "daily-at" && calendar
                      ? `Daily at ${calendar.time} · ${calendar.timezone}`
                      : row.job.schedule === "hourly"
                        ? "Every hour"
                        : row.job.schedule === "daily-at"
                          ? "Daily"
                          : row.job.schedule;
                const isExpanded = kind === "workflow" && expanded === job.id;
                return (
                  <li
                    key={`${kind}:${job.id}`}
                    className={`is-link${isExpanded ? " is-expanded" : ""}`}
                  >
                    <button
                      className="gyro-workflow-row"
                      aria-expanded={
                        kind === "workflow" ? isExpanded : undefined
                      }
                      disabled={promptIndex?.busy}
                      onClick={() =>
                        kind === "prompt"
                          ? promptIndex?.onOpenPrompt(job.id)
                          : setExpanded(isExpanded ? undefined : job.id)
                      }
                    >
                      <span className="gyro-workflow-icon-tile">
                        <CalendarClock size={16} aria-hidden="true" />
                      </span>
                      <span className="gyro-workflow-row-body">
                        <strong>{job.title}</strong>
                        <small>
                          {kind === "workflow" ? "Workflow" : "Prompt"} ·{" "}
                          {cadence}
                        </small>
                        {last ? <small>Last run · {last}</small> : null}
                      </span>
                      <span className="gyro-workflow-row-end">
                        <StatusPill status={displayStatus} />
                        {next ? (
                          <small className="gyro-workflow-row-meta">
                            Next {next}
                          </small>
                        ) : null}
                        {row.kind === "prompt" && row.job.unreadResults > 0 ? (
                          <small className="gyro-workflow-row-meta">
                            {row.job.unreadResults} unread
                          </small>
                        ) : null}
                      </span>
                      <ChevronRight
                        className="gyro-workflow-row-chevron"
                        size={16}
                        aria-hidden="true"
                      />
                    </button>
                    {row.kind === "workflow" && isExpanded ? (
                      <div className="gyro-workflow-schedule-details">
                        <div className="gyro-workflow-row-body">
                          <small>{row.job.execution.workspacePath}</small>
                          <small>
                            Pinned version{" "}
                            <code>
                              {row.job.execution.workflowBinding.binding.definitionHash.slice(
                                0,
                                12,
                              )}
                            </code>
                          </small>
                          {row.job.lastResult ? (
                            <p>{row.job.lastResult}</p>
                          ) : null}
                        </div>
                        <div className="gyro-workflow-row-actions">
                          <button
                            disabled={Boolean(busy)}
                            onClick={() => void act(onReviewSetup, row.job)}
                          >
                            Review setup
                          </button>
                          <button
                            disabled={Boolean(busy)}
                            onClick={() => void act(onToggle, row.job)}
                          >
                            {job.status !== "current"
                              ? "Resume schedule"
                              : inFlight
                                ? "Pause and stop run"
                                : "Pause schedule"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="gyro-workflow-inline-empty">
              No schedules match these filters.
            </p>
          )}
        </>
      ) : !loading && !loadError ? (
        <div className="gyro-workflow-empty">
          <span className="gyro-workflow-icon-tile is-large">
            <CalendarClock size={20} aria-hidden="true" />
          </span>
          <h2>No schedules yet</h2>
          <p>Set a time for a workflow or prompt to run.</p>
        </div>
      ) : null}
    </section>
  );
}
