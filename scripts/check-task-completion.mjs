import assert from "node:assert/strict";
import { completionSummary } from "../apps/desktop/src/check-completion.ts";

const report = {
  plan: {
    draft: {
      criteria: [
        {
          id: "submit",
          requirement: "Submit works",
          expected: true,
          scope: "browser",
        },
        {
          id: "blank",
          requirement: "Reject blanks",
          expected: true,
          scope: "api",
        },
      ],
    },
  },
  stale: false,
  results: [
    {
      criterionId: "submit",
      status: "passed",
      observedScope: "browser",
      evidence: "Clicked submit and observed a new row.",
    },
    {
      criterionId: "blank",
      status: "passed",
      observedScope: "api",
      evidence: "Empty POST returned 400.",
    },
  ],
};
assert.equal(completionSummary(report).verified, true);
assert.equal(completionSummary({ ...report, stale: true }).verified, false);
assert.equal(completionSummary({ ...report, stale: true }).detail, "2 stale");
assert.equal(
  completionSummary({ ...report, results: report.results.slice(0, 1) })
    .verified,
  false,
);
assert.equal(
  completionSummary({
    ...report,
    results: [...report.results, report.results[0]],
  }).verified,
  false,
);
assert.equal(
  completionSummary({
    ...report,
    results: report.results.map((r) => ({ ...r, observedScope: "api" })),
  }).verified,
  false,
);
assert.equal(
  completionSummary({
    ...report,
    results: report.results.map((r) => ({ ...r, evidence: "" })),
  }).verified,
  false,
);
assert.equal(
  completionSummary({
    ...report,
    results: report.results.map((r) => ({ ...r, status: "not-checked" })),
  }).verified,
  false,
);
assert.equal(
  completionSummary({ ...report, plan: { draft: { criteria: [] } } }).verified,
  false,
);
assert.equal(completionSummary().verified, false);
assert.equal(
  completionSummary({
    ...report,
    plan: {
      draft: {
        criteria: [
          report.plan.draft.criteria[0],
          report.plan.draft.criteria[0],
        ],
      },
    },
  }).verified,
  false,
);
console.log("Task completion: 11 evidence and freshness assertions passed.");
