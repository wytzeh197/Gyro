export const statusLabels: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  pending: "Pending",
  active: "Active",
  paused: "Paused",
  passed: "Passed",
  stopped: "Stopped",
  starting: "Starting",
};
function statusTone(status: string, requirementsMet?: boolean | null) {
  if (requirementsMet === false) return "warning";
  if (status === "completed" || status === "passed") return "success";
  if (status === "starting" || status === "running") return "running";
  if (status === "waiting" || status === "interrupted") return "warning";
  if (status === "failed") return "danger";
  return "neutral";
}
export function StatusPill({
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

type RunStatus = {
  status: string;
  requirementsMet?: boolean;
  steps: {
    status: string;
    verificationPassed?: boolean;
    reviewCompleted?: boolean;
    openFindings: number;
  }[];
};

export function attentionStep(run: RunStatus) {
  const verification = run.steps.findIndex(
    (step) => step.verificationPassed === false,
  );
  if (verification !== -1) return verification;
  const review = run.steps.findIndex(
    (step) => step.reviewCompleted === false || step.openFindings > 0,
  );
  if (review !== -1) return review;
  return run.steps.findIndex((step) =>
    ["failed", "waiting", "interrupted"].includes(step.status),
  );
}

export function runAttentionReason(run: RunStatus) {
  if (
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "cancelled"
  )
    return;
  const findings = run.steps.reduce(
    (total, step) => total + step.openFindings,
    0,
  );
  if (run.steps.some((step) => step.verificationPassed === false))
    return "Verification failed";
  if (run.steps.some((step) => step.reviewCompleted === false))
    return findings
      ? `Review incomplete · ${findings} open ${findings === 1 ? "finding" : "findings"}`
      : "Review incomplete";
  if (findings)
    return `${findings} open review ${findings === 1 ? "finding" : "findings"}`;
  if (run.status === "failed") return "Run failed";
  if (run.status === "waiting") return "Run is waiting";
  if (run.status === "interrupted") return "Run was interrupted";
  if (run.requirementsMet === false)
    return "Completion requirements weren’t met";
  return undefined;
}
