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
const statusLabels: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  pending: "Pending",
};
function statusTone(status: string, requirementsMet?: boolean | null) {
  if (requirementsMet === false) return "warning";
  if (status === "completed") return "success";
  if (status === "queued" || status === "running") return "running";
  if (status === "waiting" || status === "interrupted") return "warning";
  if (status === "failed") return "danger";
  return "neutral";
}
function StatusPill({
  status,
  requirementsMet,
  label,
}: {
  status: string;
  requirementsMet?: boolean | null;
  label?: string;
}) {
  return (
    <em
      className={`gyro-workflow-pill is-${statusTone(status, requirementsMet)}`}
    >
      {label ?? statusLabels[status] ?? status}
    </em>
  );
}
export function WorkflowRuns({
  runtime,
  runs,
  jobs,
  onOpenSession,
  onRefresh,
  onBrowseWorkflows,
}: {
  runtime: WorkflowRuntime;
  runs: WorkflowRunSummary[];
  jobs: WorkflowJob[];
  onOpenSession?: (id: string) => void;
  onRefresh: () => void;
  onBrowseWorkflows: () => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<WorkflowRun>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
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
          <p className="gyro-workflow-muted" role="status">
            Loading run…
          </p>
        ) : (
          <>
            <header className="gyro-workflow-run-header">
              <div>
                <h2>{detail.definition.name}</h2>
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
              {detail.steps.map((step, index) => (
                <li key={step.stepId}>
                  <div className="gyro-workflow-step-head">
                    <span className="gyro-workflow-step-index">
                      {index + 1}
                    </span>
                    <strong>{step.stepId}</strong>
                    <StatusPill status={step.status} />
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
                      Review {step.reviewCompleted ? "complete" : "incomplete"}{" "}
                      · {step.openFindings} open findings
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
              ))}
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
    <section aria-label="Workflow runs">
      <header className="gyro-workflow-page-heading gyro-workflow-heading-actions">
        <div>
          <h1>Runs</h1>
          <p>Follow progress and review the results of your workflows.</p>
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
      {!runs.length && !pending.length ? (
        <div className="gyro-workflow-empty">
          <span className="gyro-workflow-icon-tile is-large">
            <History size={20} aria-hidden="true" />
          </span>
          <h2>No workflow runs yet</h2>
          <p>
            Run a saved workflow to see its progress, results, and history here.
          </p>
          <button className="gyro-primary-button" onClick={onBrowseWorkflows}>
            Browse workflows
          </button>
        </div>
      ) : (
        <ul className="gyro-workflow-rows">
          {pending.map((job) => (
            <li key={job.id}>
              <span className="gyro-workflow-icon-tile">
                <Play size={16} aria-hidden="true" />
              </span>
              <div className="gyro-workflow-row-body">
                <strong>
                  {job.title}
                  <StatusPill
                    status={
                      job.leaseOwner
                        ? "running"
                        : job.status === "paused"
                          ? "waiting"
                          : "queued"
                    }
                    label={
                      job.leaseOwner
                        ? "Starting"
                        : job.status === "paused"
                          ? "Needs attention"
                          : "Queued"
                    }
                  />
                </strong>
                {job.execution.workspacePath ? (
                  <small>
                    <code>{job.execution.workspacePath}</code>
                  </small>
                ) : null}
                {job.lastResult ? <p>{job.lastResult}</p> : null}
              </div>
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
          {runs.map((run) => (
            <li key={run.id} className="is-link">
              <button
                className="gyro-workflow-row"
                onClick={() => setSelected(run.id)}
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
                  <small>
                    {run.origin === "automation" ? "Scheduled" : "Manual"} ·{" "}
                    {new Date(run.createdAt).toLocaleString()} · {run.rootKey}
                  </small>
                </span>
                <StatusPill
                  status={run.status}
                  requirementsMet={run.requirementsMet}
                  label={
                    run.requirementsMet === false
                      ? "Needs attention"
                      : undefined
                  }
                />
                <ChevronRight
                  className="gyro-workflow-row-chevron"
                  size={16}
                  aria-hidden="true"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p className="gyro-workflow-alert" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
