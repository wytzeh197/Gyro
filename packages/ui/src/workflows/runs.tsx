import { FeatureUsageLine } from "../feature-usage";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkflowJob,
  WorkflowRun,
  WorkflowRunSummary,
  WorkflowRuntime,
} from "./types";
export function WorkflowRuns({
  runtime,
  runs,
  jobs,
  onOpenSession,
  onRefresh,
}: {
  runtime: WorkflowRuntime;
  runs: WorkflowRunSummary[];
  jobs: WorkflowJob[];
  onOpenSession?: (id: string) => void;
  onRefresh: () => void;
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
      <section aria-label="Workflow run detail">
        <button onClick={() => setSelected(undefined)}>Back to runs</button>
        {!detail ? (
          <p role="status">Loading run…</p>
        ) : (
          <>
            <h2>{detail.definition.name}</h2>
            <p role="status">
              {detail.status === "completed"
                ? "Execution completed"
                : detail.status}{" "}
              ·{" "}
              {detail.requirementsMet === true
                ? "Recorded requirements met"
                : detail.requirementsMet === false
                  ? "Needs attention"
                  : "Requirements not yet assessed"}
            </p>
            <p>
              {detail.rootKey} ·{" "}
              {detail.origin === "automation" ? "Scheduled" : "Manual"} ·{" "}
              {new Date(detail.createdAt).toLocaleString()}
            </p>
            <p>
              Recipe {detail.binding.definitionHash.slice(0, 12)}. Execution
              status, review findings and verification are separate evidence.
              Each attempt has a 30 minute deadline.
            </p>
            <FeatureUsageLine
              usage={detail.usage}
              createdAt={detail.createdAt}
              finishedAt={detail.finishedAt}
            />
            {detail.error ? <p role="alert">{detail.error}</p> : null}
            {["queued", "running", "waiting"].includes(detail.status) ? (
              <button disabled={busy} onClick={() => void stop()}>
                Stop run
              </button>
            ) : null}
            {detail.previousRunId ? (
              <p>
                Continues run {detail.previousRunId}. Completed step receipts
                were retained.
              </p>
            ) : null}
            {["waiting", "interrupted", "cancelled", "failed"].includes(
              detail.status,
            ) && detail.steps.some((step) => step.status !== "completed") ? (
              <button disabled={busy} onClick={() => void retryRun(false)}>
                Inspect retry
              </button>
            ) : null}
            {retry ? (
              <section aria-label="Retry unfinished steps">
                <h3>Retry from {retry.stepId}</h3>
                <p>{retry.message}</p>
                <p>
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
                <button
                  disabled={busy || !reviewed}
                  onClick={() => void retryRun(true)}
                >
                  Queue explicit continuation
                </button>
                <button disabled={busy} onClick={() => setRetry(undefined)}>
                  Cancel retry
                </button>
              </section>
            ) : null}
            <ol className="gyro-workflow-steps">
              {detail.steps.map((step) => (
                <li key={step.stepId}>
                  <strong>
                    {step.stepId} · {step.status}
                  </strong>
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
                  {step.error ? <p role="alert">{step.error}</p> : null}
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
            {["completed", "failed", "cancelled", "interrupted"].includes(
              detail.status,
            ) ? (
              <div className="gyro-workflow-actions">
                {deleteConfirmed ? (
                  <>
                    <p>
                      Delete this private run record, including its saved inputs
                      and outputs? Linked chats can be removed separately.
                    </p>
                    <button disabled={busy} onClick={() => void deleteRun()}>
                      Delete run record
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => setDeleteConfirmed(false)}
                    >
                      Keep run record
                    </button>
                  </>
                ) : (
                  <button onClick={() => setDeleteConfirmed(true)}>
                    Delete run record…
                  </button>
                )}
              </div>
            ) : null}
            <details>
              <summary>Original inputs and recipe</summary>
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
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </section>
    );
  return (
    <section aria-label="Workflow runs">
      <h2>Workflow runs</h2>
      <button onClick={onRefresh}>Refresh runs</button>
      {!runs.length && !pending.length ? (
        <p>
          No workflow runs yet. Save a recipe, review its setup, then launch it
          explicitly.
        </p>
      ) : null}
      <ul className="gyro-workflow-list">
        {pending.map((job) => (
          <li key={job.id}>
            <strong>{job.title}</strong>
            <p>
              {job.leaseOwner
                ? "Starting"
                : job.status === "paused"
                  ? "Needs attention"
                  : "Queued"}{" "}
              · {job.execution.workspacePath}
            </p>
            <p>{job.lastResult}</p>
            {job.status === "current" ? (
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
            ) : null}
          </li>
        ))}
        {runs.map((run) => (
          <li key={run.id}>
            <button
              className="gyro-workflow-row"
              onClick={() => setSelected(run.id)}
            >
              <strong>{run.definition.name}</strong>
              <span>
                {run.status === "completed"
                  ? "Execution completed"
                  : run.status}
                {run.requirementsMet === false ? " · needs attention" : ""} ·{" "}
                {new Date(run.createdAt).toLocaleString()}
              </span>
              <span>{run.rootKey}</span>
            </button>
          </li>
        ))}
      </ul>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
