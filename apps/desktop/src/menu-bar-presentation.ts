import type { MenuBarJob, MenuBarSnapshot } from "@gyro-dev/ui";

export const MAX_VISIBLE_MENU_BAR_JOBS = 4;

/** Mirrored by menu_bar.rs so the native window and its content agree. */
export function menuBarPresentation(snapshot: MenuBarSnapshot) {
  const waiting = snapshot.jobs.filter((job) => job.status === "waiting");
  const candidates = waiting.length ? waiting : snapshot.jobs;
  const visibleJobs = candidates.slice(0, MAX_VISIBLE_MENU_BAR_JOBS);
  const overflow = candidates.length - visibleJobs.length;
  const background = waiting.length
    ? snapshot.jobs.filter(
        (job) => job.status === "running" || job.status === "queued",
      )
    : [];
  const running = background.filter((job) => job.status === "running").length;
  const queued = background.length - running;
  const summary = [
    overflow > 0 ? `+${overflow} more${waiting.length ? " waiting" : ""}` : "",
    running > 0
      ? `${running} other ${running === 1 ? "task" : "tasks"} running`
      : "",
    queued > 0 ? `${queued} queued` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { visibleJobs, summary };
}

export function menuBarStatus(snapshot: MenuBarSnapshot): {
  label: string;
  tone: "neutral" | "accent" | "warn" | "ok" | "danger";
} {
  const waiting = snapshot.jobs.filter((job) => job.status === "waiting");
  if (waiting.length) {
    const repliesOnly = waiting.every((job) => job.question);
    return {
      label: repliesOnly
        ? `${waiting.length} ${waiting.length === 1 ? "needs reply" : "need replies"}`
        : `${waiting.length} ${waiting.length === 1 ? "needs" : "need"} you`,
      tone: "warn",
    };
  }
  const running = snapshot.jobs.filter(
    (job) => job.status === "running",
  ).length;
  const queued = snapshot.jobs.filter((job) => job.status === "queued").length;
  if (running || queued)
    return {
      label: [
        running ? `${running} running` : "",
        queued ? `${queued} queued` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      tone: "accent",
    };
  if (snapshot.recentOutcome?.status === "failed")
    return { label: "Needs attention", tone: "danger" };
  if (
    snapshot.jobs.some((job) => job.status === "finished") ||
    snapshot.recentOutcome?.status === "succeeded"
  ) {
    return { label: "Finished", tone: "ok" };
  }
  return { label: "Ready", tone: "neutral" };
}

export function approvalCanBeAnsweredInline(job: MenuBarJob) {
  return Boolean(job.approval && job.approval.approvalType !== "file-change");
}
