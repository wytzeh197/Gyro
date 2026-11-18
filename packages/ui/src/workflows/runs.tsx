import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  History,
  Play,
  RefreshCw,
} from "lucide-react";
import { FeatureUsageLine } from "../feature-usage";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkflowJob,
  WorkflowRun,
  WorkflowRunSummary,
  WorkflowRuntime,
} from "./types";
import { attentionStep, runAttentionReason, StatusPill } from "./status";
export function WorkflowRuns({
  runtime,
  runs,
  jobs,
  loading,
  loadError,
  onOpenSession,
  onRefresh,
  onBrowseWorkflows,
}: {
  runtime: WorkflowRuntime;
  runs: WorkflowRunSummary[];
  jobs: WorkflowJob[];
  loading: boolean;
  loadError: boolean;
  onOpenSession?: (id: string) => void;
  onRefresh: () => void;
  onBrowseWorkflows: () => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<WorkflowRun>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const selectedStep = useRef<HTMLLIElement>(null);
  const runHeading = useRef<HTMLHeadingElement>(null);
  const runList = useRef<HTMLElement>(null);
  const returnFocus = useRef<string>();
  useEffect(() => {
    if (!detail) return;
    (selectedStep.current ?? runHeading.current)?.focus();
  }, [detail?.id]);
  useEffect(() => {
    if (selected || !returnFocus.current) return;
    const row = Array.from(
      runList.current?.querySelectorAll<HTMLButtonElement>("[data-run-id]") ??
        [],
    ).find((button) => button.dataset.runId === returnFocus.current);
    (row ?? runHeading.current)?.focus();
    returnFocus.current = undefined;
  }, [selected]);
  const generation = useRef(0);
  const selection = useRef(selected);
  selection.current = selected;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [retry, setRetry] = useState<{
    revision: number;
    workspaceFingerprint: string;
    stepId: string;
    completedSteps: number;
    message: string;
  }>();
  const [reviewed, setReviewed] = useState(false);
  const retryOperation = useRef(crypto.randomUUID());
  const load = useCallback(async () => {
    if (!selected) return;
    const sequence = ++generation.current;
    try {
      const next = await runtime.run<WorkflowRun>("get", { runId: selected });
      if (sequence === generation.current) setDetail(next);
    } catch (error) {
      if (sequence === generation.current) setError(String(error));
    }
  }, [runtime, selected]);
  useEffect(() => {
    setDeleteConfirmed(false);
    setBusy(false);
    setDetail(undefined);
    setRetry(undefined);
    setReviewed(false);
    setError("");
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => runtime.subscribe(() => void load()), [runtime, load]);
  useEffect(() => {
    if (!detail || !["queued", "running"].includes(detail.status)) return;
    const timer = window.setInterval(() => {
      void load();
      onRefresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [detail?.id, detail?.status, load, onRefresh]);
  async function stop() {
    if (!detail) return;
    const identity = detail.id;
    setBusy(true);
    try {
      const next = await runtime.run<WorkflowRun>("stop", {
        runId: detail.id,
        revision: detail.revision,
      });
      if (alive.current && selection.current === identity) {
        setDetail(next);
        onRefresh();
      }
    } catch (error) {
      if (alive.current && selection.current === identity)
        setError(String(error));
    } finally {
      if (alive.current && selection.current === identity) setBusy(false);
    }
  }
  async function deleteRun() {
    if (!detail) return;
    setBusy(true);
    setError("");
    const identity = detail.id;
    try {
      await runtime.run("delete", {
        runId: detail.id,
        revision: detail.revision,
      });
      if (alive.current && selection.current === identity) {
        setSelected(undefined);
        onRefresh();
      }
    } catch (error) {
      if (alive.current && selection.current === identity)
        setError(String(error));
    } finally {
      if (alive.current && selection.current === identity) setBusy(false);
    }
  }
  async function retryRun(confirm: boolean) {
    if (!detail) return;
    setBusy(true);
    setError("");
    const identity = detail.id;
    try {
      if (!confirm) {
        const preview = await runtime.run<NonNullable<typeof retry>>(
          "retry-preview",
          { runId: detail.id },
        );
        if (alive.current && selection.current === identity) {
          setRetry(preview);
          setReviewed(false);
          retryOperation.current = crypto.randomUUID();
        }
      } else {
        await runtime.run("retry", {
          runId: detail.id,
          ...retry,
          reviewedActions: reviewed,
          operationId: retryOperation.current,
        });
        if (alive.current && selection.current === identity) {
          setRetry(undefined);
          setSelected(undefined);
          onRefresh();
        }
      }
    } catch (error) {
      if (alive.current && selection.current === identity)
        setError(String(error));
    } finally {
      if (alive.current && selection.current === identity) setBusy(false);
    }
  }
  const pending = jobs.filter(
    (job) =>
      job.schedule === "manual" &&
      job.status !== "completed" &&
      !runs.some((run) => run.automationId === job.id),
  );
  type RunGroup = {
    label: string;
    runs: WorkflowRunSummary[];
    jobs: WorkflowJob[];
  };
  const attention: RunGroup = { label: "Needs attention", runs: [], jobs: [] };
  const progress: RunGroup = { label: "In progress", runs: [], jobs: [] };
  const history: RunGroup = { label: "History", runs: [], jobs: [] };
  for (const job of pending) {
    const group =
      job.status === "paused" && !job.leaseOwner ? attention : progress;
    group.jobs.push(job);
  }
  for (const run of [...runs].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )) {
    const group = runAttentionReason(run)
      ? attention
      : ["queued", "running"].includes(run.status)
        ? progress
        : history;
    group.runs.push(run);
  }
  const runGroups = [attention, progress, history];
  const relevantStep = detail ? attentionStep(detail) : -1;
  if (selected)
    return (
      <section
        className="gyro-workflow-run-detail"
        aria-label="Workflow run detail"
      >
        <button
          className="gyro-workflow-back"
          onClick={() => setSelected(undefined)}
        >
          <ChevronLeft size={14} aria-hidden="true" />
          Back to runs
        </button>
        {!detail ? (
          error ? (
            <button
              onClick={() => {
                setError("");
                void load();
              }}
            >
              Retry loading run
            </button>
          ) : (
            <p className="gyro-workflow-muted" role="status">
              Loading run…
            </p>
          )
        ) : (
          <>
            <header className="gyro-workflow-run-header">
              <div>
                <h2 ref={runHeading} tabIndex={-1}>
                  {detail.definition.name}
                </h2>
                <p>
                  {detail.origin === "automation" ? "Scheduled" : "Manual"} ·{" "}
                  {new Date(detail.createdAt).toLocaleString()} ·{" "}
                  <code>{detail.rootKey}</code>
                </p>
              </div>
              <div className="gyro-workflow-header-actions">
                {["queued", "running", "waiting"].includes(detail.status) ? (
                  <button disabled={busy} onClick={() => void stop()}>
                    Stop run
                  </button>
                ) : null}
                {["waiting", "interrupted", "cancelled", "failed"].includes(
                  detail.status,
                ) &&
                detail.steps.some((step) => step.status !== "completed") ? (
                  <button disabled={busy} onClick={() => void retryRun(false)}>
                    Inspect retry
                  </button>
                ) : null}
              </div>
            </header>
            <div className="gyro-workflow-run-summary" role="status">
              <StatusPill
                status={detail.status}
                label={
                  detail.status === "completed"
                    ? "Execution completed"
                    : undefined
                }
              />
              <StatusPill
                status={
                  detail.requirementsMet === true
                    ? "completed"
                    : detail.requirementsMet === false
                      ? "waiting"
                      : "cancelled"
                }
                label={
                  detail.requirementsMet === true
                    ? "Recorded requirements met"
                    : detail.requirementsMet === false
                      ? "Needs attention"
                      : "Requirements not yet assessed"
                }
              />
            </div>
            {runAttentionReason(detail) ? (
              <p className="gyro-workflow-attention-reason">
                {runAttentionReason(detail)}
              </p>
            ) : null}
            <FeatureUsageLine
              usage={detail.usage}
              createdAt={detail.createdAt}
              finishedAt={detail.finishedAt}
            />
            {detail.error ? (
              <p className="gyro-workflow-alert" role="alert">
                {detail.error}
              </p>
            ) : null}
            {detail.previousRunId ? (
              <p className="gyro-workflow-muted">
                Continues run {detail.previousRunId}. Completed step receipts
                were retained.
              </p>
            ) : null}
            {retry ? (
              <section
                className="gyro-workflow-callout"
                aria-label="Retry unfinished steps"
              >
                <h3>Retry from {retry.stepId}</h3>
                <p>{retry.message}</p>
                <p className="gyro-workflow-muted">
                  {retry.completedSteps} completed steps will be retained.
                  Inputs, role bindings and recipe version remain pinned.
                </p>
                <label className="gyro-workflow-check">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(event) => setReviewed(event.target.checked)}
                  />
                  I inspected the recorded actions and accept a fresh attempt of
                  the unfinished step.
                </label>
                <div className="gyro-workflow-actions">
                  <button
                    className="gyro-primary-button"
                    disabled={busy || !reviewed}
                    onClick={() => void retryRun(true)}
                  >
                    Queue explicit continuation
                  </button>
                  <button disabled={busy} onClick={() => setRetry(undefined)}>
                    Cancel retry
                  </button>
                </div>
              </section>
            ) : null}
            <h3 className="gyro-workflow-subheading">Steps</h3>
            <ol className="gyro-workflow-steps gyro-workflow-run-steps">
              {detail.steps.map((step, index) => {
                const kind = detail.definition.steps.find(
                  (item) => item.id === step.stepId,
                )?.kind;
                const reviewNeedsAttention =
                  step.status === "completed" &&
                  (step.reviewCompleted === false || step.openFindings > 0);
                return (
                  <li
                    key={step.stepId}
                    ref={index === relevantStep ? selectedStep : undefined}
                    tabIndex={index === relevantStep ? -1 : undefined}
                    className={
                      index === relevantStep ? "is-attention-step" : undefined
                    }
                  >
                    <div className="gyro-workflow-step-head">
                      <span className="gyro-workflow-step-index">
                        {index + 1}
                      </span>
                      <strong>
                        {kind === "verification"
                          ? "Verify"
                          : kind === "review"
                            ? "Review"
                            : step.stepId}
                      </strong>
                      <StatusPill
                        status={
                          step.verificationPassed === false
                            ? "failed"
                            : step.status
                        }
                        requirementsMet={
                          reviewNeedsAttention ? false : undefined
                        }
                        label={
                          reviewNeedsAttention ? "Needs attention" : undefined
                        }
                      />
                    </div>
                    {step.verificationPassed !== undefined &&
                    step.verificationPassed !== null ? (
                      <p>
                        Verification{" "}
                        {step.verificationPassed
                          ? "recorded exit code 0"
                          : "did not pass"}
                      </p>
                    ) : null}
                    {step.reviewCompleted !== undefined &&
                    step.reviewCompleted !== null ? (
                      <p>
                        Review{" "}
                        {step.reviewCompleted ? "complete" : "incomplete"} ·{" "}
                        {step.openFindings} open findings
                      </p>
                    ) : null}
                    {step.error ? (
                      <p className="gyro-workflow-alert" role="alert">
                        {step.error}
                      </p>
                    ) : null}
                    {step.sessionId && onOpenSession ? (
                      <button onClick={() => onOpenSession(step.sessionId!)}>
                        Open step and approvals
                      </button>
                    ) : null}
                    {step.output ? (
                      <details>
                        <summary>Recorded output</summary>
                        <pre>{step.output}</pre>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            <details className="gyro-workflow-disclosure">
              <summary>Original inputs and recipe</summary>
              <p className="gyro-workflow-muted">
                Recipe {detail.binding.definitionHash.slice(0, 12)}. Execution
                status, review findings and verification are separate evidence.
                Each attempt has a 30 minute deadline.
              </p>
              <pre>
                {JSON.stringify(
                  {
                    inputs: detail.binding.inputs,
                    definition: detail.definition,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            {["completed", "failed", "cancelled", "interrupted"].includes(
              detail.status,
            ) ? (
              <div className="gyro-workflow-danger-zone">
                {deleteConfirmed ? (
                  <>
                    <p>
                      Delete this private run record, including its saved inputs
                      and outputs? Linked chats can be removed separately.
                    </p>
                    <div className="gyro-workflow-actions">
                      <button
                        className="gyro-workflow-danger-button"
                        disabled={busy}
                        onClick={() => void deleteRun()}
                      >
                        Delete run record
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => setDeleteConfirmed(false)}
                      >
                        Keep run record
                      </button>
                    </div>
                  </>
                ) : (
                  <button onClick={() => setDeleteConfirmed(true)}>
                    Delete run record…
                  </button>
                )}
              </div>
            ) : null}
          </>
        )}
        {error ? (
          <p className="gyro-workflow-alert" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    );
  return (
    <section aria-label="Workflow runs" ref={runList}>
      <header className="gyro-workflow-page-heading gyro-workflow-heading-actions">
        <div>
          <h1 ref={runHeading} tabIndex={-1}>
            Runs
          </h1>
        </div>
        <button
          className="gyro-workflow-icon-button"
          onClick={onRefresh}
          aria-label="Refresh runs"
          title="Refresh runs"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </header>
      {loading ? (
        <p className="gyro-workflow-muted" role="status">
          Loading runs…
        </p>
      ) : null}
      {loadError ? (
        <p className="gyro-workflow-muted" role="status">
          Runs couldn’t be refreshed. Use Refresh runs to try again.
        </p>
      ) : null}
      {!loading && !loadError && !runs.length && !pending.length ? (
        <div className="gyro-workflow-empty">
          <span className="gyro-workflow-icon-tile is-large">
            <History size={20} aria-hidden="true" />
          </span>
          <h2>No workflow runs yet</h2>
          <p>Run a saved workflow to see its progress and results here.</p>
          <button className="gyro-primary-button" onClick={onBrowseWorkflows}>
            Browse workflows
          </button>
        </div>
      ) : null}
      {runGroups.map((group) =>
        !group.jobs.length && !group.runs.length ? null : (
          <section
            className="gyro-workflow-section"
            key={group.label}
            aria-label={group.label}
          >
            <div className="gyro-workflow-section-head">
              <h2>{group.label}</h2>
            </div>
            <ul className="gyro-workflow-rows">
              {group.jobs.map((job) => (
                <li key={job.id}>
                  <span className="gyro-workflow-icon-tile">
                    <Play size={16} aria-hidden="true" />
                  </span>
                  <div className="gyro-workflow-row-body">
                    <strong>{job.title}</strong>
                    <small>
                      Manual
                      {job.execution.workspacePath
                        ? ` · ${job.execution.workspacePath.split(/[\\/]/).filter(Boolean).pop()}`
                        : ""}
                    </small>
                    {job.lastResult ? <p>{job.lastResult}</p> : null}
                  </div>
                  <StatusPill
                    status={
                      job.leaseOwner
                        ? "starting"
                        : job.status === "paused"
                          ? "waiting"
                          : "queued"
                    }
                    label={
                      job.status === "paused" && !job.leaseOwner
                        ? "Needs attention"
                        : undefined
                    }
                  />
                  {job.status === "current" ? (
                    <div className="gyro-workflow-row-actions">
                      <button
                        onClick={() =>
                          void runtime
                            .run("toggle-job", { jobId: job.id, paused: true })
                            .then(onRefresh)
                            .catch((error) => setError(String(error)))
                        }
                      >
                        Cancel launch
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
              {group.runs.map((run) => {
                const reason = runAttentionReason(run);
                const date = new Date(run.createdAt);
                return (
                  <li key={run.id} className="is-link">
                    <button
                      className="gyro-workflow-row"
                      data-run-id={run.id}
                      onClick={() => {
                        returnFocus.current = run.id;
                        setSelected(run.id);
                      }}
                    >
                      <span className="gyro-workflow-icon-tile">
                        {run.origin === "automation" ? (
                          <CalendarClock size={16} aria-hidden="true" />
                        ) : (
                          <Play size={16} aria-hidden="true" />
                        )}
                      </span>
                      <span className="gyro-workflow-row-body">
                        <strong>{run.definition.name}</strong>
                        {reason ? (
                          <small className="gyro-workflow-attention-reason">
                            {reason}
                          </small>
                        ) : null}
                        <small>
                          {run.origin === "automation" ? "Scheduled" : "Manual"}{" "}
                          ·{" "}
                          {run.rootKey.split(/[\\/]/).filter(Boolean).pop() ??
                            run.rootKey}
                        </small>
                      </span>
                      <span className="gyro-workflow-row-end">
                        <StatusPill
                          status={run.status}
                          requirementsMet={
                            run.status === "completed"
                              ? run.requirementsMet
                              : undefined
                          }
                          label={
                            run.status === "completed" && reason
                              ? "Needs attention"
                              : undefined
                          }
                        />
                        <time
                          className="gyro-workflow-row-meta"
                          dateTime={run.createdAt}
                          title={date.toLocaleString()}
                        >
                          {date.toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}{" "}
                          ·{" "}
                          {date.toLocaleTimeString(undefined, {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </time>
                      </span>
                      <ChevronRight
                        className="gyro-workflow-row-chevron"
                        size={16}
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ),
      )}
      {error ? (
        <p className="gyro-workflow-alert" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
