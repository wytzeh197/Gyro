import type { ProblemDiagnostic } from "./types";

export const PROBLEM_DRAG_MIME = "application/x-gyro-problem";
export type ProblemDragPayload = {
  workspacePath?: string;
} & (
  | { diagnostic: ProblemDiagnostic }
  | { planStep: { id: string; title: string; detail?: string }; planTitle: string }
);

export function beginPlanProblemDrag(
  transfer: DataTransfer,
  planStep: { id: string; title: string; detail?: string },
  planTitle: string,
  workspacePath?: string,
) {
  transfer.effectAllowed = "copy";
  transfer.setData(PROBLEM_DRAG_MIME, JSON.stringify({ planStep, planTitle, workspacePath }));
  transfer.setData("text/plain", `${planStep.title}: ${planStep.detail?.trim() || "No blocking reason was recorded for this step."}`);
}

export function isProblemDrag(transfer: Pick<DataTransfer, "types"> | null) {
  return Boolean(transfer && Array.from(transfer.types).includes(PROBLEM_DRAG_MIME));
}

export function beginProblemDrag(
  transfer: DataTransfer,
  diagnostic: ProblemDiagnostic,
  workspacePath?: string,
) {
  transfer.effectAllowed = "copy";
  transfer.setData(PROBLEM_DRAG_MIME, JSON.stringify({ diagnostic, workspacePath }));
  transfer.setData("text/plain", `${diagnostic.path}:${diagnostic.startLineNumber}:${diagnostic.startColumn}: ${diagnostic.message}`);
}

/** Validate the drop before it can become a stored attachment. */
export function readProblemDrag(transfer: Pick<DataTransfer, "getData">): ProblemDragPayload | undefined {
  try {
    const raw = transfer.getData(PROBLEM_DRAG_MIME);
    if (!raw || raw.length > 64 * 1024) return;
    const value = JSON.parse(raw);
    const d = value?.diagnostic;
    const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max && !v.includes("\0");
    const position = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
    if (value?.workspacePath !== undefined && !text(value.workspacePath, 4096)) return;
    if (value?.planStep !== undefined) {
      const step = value.planStep;
      if (d !== undefined || !step || !text(step.id, 4096) ||
          !text(step.title, 4096) || !step.title.trim() ||
          (step.detail !== undefined && !text(step.detail, 32768)) ||
          !text(value.planTitle, 4096)) return;
      return {
        planStep: { id: step.id, title: step.title, detail: step.detail },
        planTitle: value.planTitle,
        workspacePath: value.workspacePath,
      };
    }
    if (!d || !text(d.id, 4096) || !text(d.path, 4096) || !d.path.trim() ||
        !text(d.message, 32768) || !d.message.trim() ||
        !["error", "warning", "info", "hint"].includes(d.severity) ||
        !position(d.startLineNumber) || !position(d.startColumn) ||
        (d.source !== undefined && !text(d.source, 1024)) ||
        (d.endLineNumber !== undefined && !position(d.endLineNumber)) ||
        (d.endColumn !== undefined && !position(d.endColumn)) ||
        (value.workspacePath !== undefined && !text(value.workspacePath, 4096))) return;
    return {
      diagnostic: {
        id: d.id, path: d.path, message: d.message, severity: d.severity,
        source: d.source, startLineNumber: d.startLineNumber, startColumn: d.startColumn,
        endLineNumber: d.endLineNumber, endColumn: d.endColumn,
      },
      workspacePath: value.workspacePath,
    };
  } catch {
    return;
  }
}

export function problemAttachmentText(problem: ProblemDragPayload) {
  const { workspacePath } = problem;
  if ("planStep" in problem) {
    return [
      "Blocked plan step captured from Gyro",
      workspacePath ? `Workspace: ${workspacePath}` : undefined,
      `Plan: ${problem.planTitle}`,
      `Step: ${problem.planStep.title}`,
      "Status: blocked",
      "",
      problem.planStep.detail?.trim() || "No blocking reason was recorded for this step.",
      "",
    ].filter((line) => line !== undefined).join("\n");
  }
  const d = problem.diagnostic;
  return [
    "Problem captured from Gyro's Problems panel",
    workspacePath ? `Workspace: ${workspacePath}` : undefined,
    `File: ${d.path}`,
    `Location: ${d.startLineNumber}:${d.startColumn}${d.endLineNumber ? `–${d.endLineNumber}:${d.endColumn ?? d.startColumn}` : ""}`,
    `Severity: ${d.severity}`,
    d.source ? `Source: ${d.source}` : undefined,
    "",
    d.message,
    "",
  ].filter((line) => line !== undefined).join("\n");
}

export function problemAttachmentName(problem: ProblemDragPayload) {
  if ("planStep" in problem) {
    const title = problem.planStep.title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    return `${title || "blocked-step"}.problem.txt`;
  }
  const d = problem.diagnostic;
  const basename = d.path.split(/[\\/]/).pop() || "file";
  return `${basename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100)}-L${d.startLineNumber}.problem.txt`;
}
