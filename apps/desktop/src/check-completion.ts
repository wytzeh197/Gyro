import type { CheckReport } from "./local-check-types";

export const MAX_CHECK_REQUIREMENTS = 8;
export type RequirementStatus = "passed" | "failed" | "not-checked" | "stale";

/** Derive display state from the reviewed requirements, never from model prose.
 * Missing/duplicate results and unspecified scopes cannot establish completion.
 * Old observations remain inspectable even when their verdict is stale.
 */
export function completionRequirements(report: CheckReport) {
  const duplicateCriteria = new Set(
    report.plan.draft.criteria
      .filter((c, i, all) => all.findIndex((a) => a.id === c.id) !== i)
      .map((c) => c.id),
  );
  return report.plan.draft.criteria.map((criterion) => {
    const matches = report.results.filter(
      (r) => r.criterionId === criterion.id,
    );
    const result = matches.length === 1 ? matches[0] : undefined;
    let status: RequirementStatus = "not-checked";
    if (
      !duplicateCriteria.has(criterion.id) &&
      criterion.scope !== "unspecified" &&
      result?.observedScope === criterion.scope &&
      result.evidence?.trim() &&
      (result.status === "passed" || result.status === "failed")
    )
      status = report.stale ? "stale" : result.status;
    return { criterion, result, status };
  });
}

export function completionSummary(report?: CheckReport) {
  const requirements = report ? completionRequirements(report) : [];
  const count = (status: RequirementStatus) =>
    requirements.filter((r) => r.status === status).length;
  const verified =
    requirements.length > 0 && count("passed") === requirements.length;
  const label = report?.stale
    ? "Stale"
    : verified
      ? "Requirements verified"
      : count("failed")
        ? "Needs attention"
        : "Not fully checked";
  const detail = requirements.length
    ? (["passed", "failed", "not-checked", "stale"] as const)
        .flatMap((status) =>
          count(status) ? [`${count(status)} ${status.replace("-", " ")}`] : [],
        )
        .join(" · ")
    : "No requirements checked";
  return { verified, label, detail, requirements };
}
