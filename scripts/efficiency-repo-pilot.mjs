// Build only from the frozen corpus, never from mutable application sources.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const fixtureRoot = fileURLToPath(
  new URL("./fixtures/efficiency-repo/", import.meta.url),
);
export const manifestPath = fileURLToPath(
  new URL("../docs/performance/efficiency-repo-pilot.json", import.meta.url),
);
export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
export const snapshot = (files) =>
  `sha256:${sha256(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))))}`;
const read = (path) => readFileSync(resolve(fixtureRoot, path), "utf8");
export const provenance = JSON.parse(read("provenance.json"));
const sources = Object.fromEntries(
  provenance.files.map(({ path, sha256: expected }) => {
    const source = read(`sources/${path}`);
    assert.equal(sha256(source), expected, `Frozen source changed: ${path}`);
    return [path, source];
  }),
);
export function replaceOnce(source, before, after) {
  assert.equal(
    source.split(before).length,
    2,
    `Expected one occurrence of ${JSON.stringify(before)}`,
  );
  return source.replace(before, after);
}
const retryPath = "apps/desktop/src/chat-auto-retry.ts";
const turnPath = "packages/ui/src/turn-tokens.ts";
const ledgerPath = "packages/ui/src/usage-ledger.ts";
const searchPath = "apps/desktop/src/workspace-search-run.ts";
const retry = sources[retryPath],
  turn = sources[turnPath],
  ledger = sources[ledgerPath],
  search = sources[searchPath];
let brokenRetry = retry;
for (const kind of ["no-progress", "tool-budget", "partial-answer"])
  brokenRetry = replaceOnce(brokenRetry, `  "${kind}",\n`, "");
const brokenTurn = replaceOnce(
  turn,
  '  if (unavailable(tokens)) return "Usage unavailable";\n',
  "",
);
const brokenLedger = replaceOnce(
  ledger,
  "  const useReportedSubtotal =\n    reportedSubtotal !== undefined &&\n    (!knownCoverage || totals.estimatedCalls > 0 || partial + unavailable > 0);",
  "  const useReportedSubtotal = false;",
);
const unorderedSearch = replaceOnce(
  search,
  "roots.flatMap((path) => completed.get(path) ?? []).slice(0, maxResults)",
  "[...completed.values()].flat().slice(0, maxResults)",
);
const staleSearch = replaceOnce(
  replaceOnce(
    search,
    "      const results = await search(root);\n      if (!isCurrent()) return;",
    "      const results = await search(root);",
  ),
  "  if (!isCurrent()) return;\n  const failures",
  "  const failures",
);
const brokenSearch = replaceOnce(
  replaceOnce(
    unorderedSearch,
    "      const results = await search(root);\n      if (!isCurrent()) return;",
    "      const results = await search(root);",
  ),
  "  if (!isCurrent()) return;\n  const failures",
  "  const failures",
);
const packageFile =
  JSON.stringify(
    {
      private: true,
      type: "module",
      engines: { node: ">=24" },
      scripts: { test: "node --test tests/smoke.mjs" },
    },
    null,
    2,
  ) + "\n";
const smokeHeader =
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\n';
const common = (description, smoke) => ({
  "package.json": packageFile,
  "README.md": `${description}\n\nThis is an extracted, frozen Gyro module fixture with deliberately seeded regressions. Node 24+ runs the TypeScript directly; there are no install dependencies. Run node --test tests/smoke.mjs. Public smoke tests are intentionally incomplete. Preserve exported APIs and the contracts in the task. Do not modify the tests or evidence.\n`,
  "tests/smoke.mjs": smokeHeader + smoke,
});
const task = (value) => ({
  ...value,
  repositorySnapshot: snapshot(value.files),
});

// Generated diagnostic rows are clearly synthetic. They exercise bulky tool output
// and recovery of earlier evidence without including solutions in the workspace.
const capture = (name) => {
  const header = {
    fixture: true,
    captureId: `gyro-search-recovery-20261031-${name}`,
    workspaceOrder: ["alpha", "beta", "gamma"],
    completionOrder: ["gamma", "beta", "alpha"],
    globalCap: 4,
  };
  const rows = Array.from({ length: 96 }, (_, index) => {
    const number = String(index).padStart(3, "0");
    return {
      eventId: `capture-${name}-${number}`,
      path: `${["alpha", "beta", "gamma"][index % 3]}/src/search-result-${number}.ts`,
      line: 101 + index,
      symbol: `retainedNeedle${index}`,
      diagnostic: Array.from({ length: 7 }, (_, chunk) =>
        sha256(`gyro-fixture-${name}-${index}-${chunk}`),
      ).join(" "),
    };
  });
  // This anchor is intentionally in the middle of the first large result.
  rows[47].path = "beta/src/search-result-047.ts";
  return [header, ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n";
};
const expectedSummary =
  JSON.stringify(
    {
      captureId: "gyro-search-recovery-20261031-a",
      workspaceOrder: ["alpha", "beta", "gamma"],
      completionOrder: ["gamma", "beta", "alpha"],
      globalCap: 4,
      anchor: {
        eventId: "capture-a-047",
        path: "beta/src/search-result-047.ts",
        line: 148,
        symbol: "retainedNeedle47",
      },
      recordCount: 96,
    },
    null,
    2,
  ) + "\n";

export const tasks = [
  task({
    id: "gyro-retry-terminal-guards",
    category: "bug-fixes",
    files: {
      ...common(
        "Repair retry eligibility while preserving useful transient recovery.",
        `import { eligibleChatAutoRetryFailure } from "../${retryPath}";\ntest("empty transcript does not retry", () => assert.equal(eligibleChatAutoRetryFailure([]), undefined));\n`,
      ),
      [retryPath]: brokenRetry,
    },
    turns: [
      "Fix automatic retry safety in apps/desktop/src/chat-auto-retry.ts. Explicit no-progress, tool-budget, and partial-answer stops must never retry, even when their error text includes connection reset or HTTP 503. Preserve a single 30-second delayed retry for transient failures before work starts. Historical failures must not trigger it; completed work, answers, busy sessions, and duplicate status frames must remain safe. Inspect the implementation, make the smallest correct fix, and run checks. Edit only apps/desktop/src/chat-auto-retry.ts.",
    ],
    allowedChanges: [retryPath],
    verifier: read("verifiers/retry.mjs"),
    referenceSolution: { [retryPath]: retry },
  }),
  task({
    id: "gyro-usage-confidence",
    category: "multi-file-features",
    files: {
      ...common(
        "Restore truthful turn and session usage display across two modules.",
        `import { turnTokensFromValue, turnTokensLabel } from "../${turnPath}";\nimport { summarizeSessionCost } from "../${ledgerPath}";\ntest("invalid input and an empty session stay empty", () => { assert.equal(turnTokensFromValue(null), undefined); assert.equal(summarizeSessionCost(undefined).isEmpty, true); });\n`,
      ),
      [turnPath]: brokenTurn,
      [ledgerPath]: brokenLedger,
      "packages/ui/src/token-count.ts":
        sources["packages/ui/src/token-count.ts"],
      "packages/ui/src/usage-remaining.ts":
        sources["packages/ui/src/usage-remaining.ts"],
    },
    turns: [
      "Repair usage reporting in packages/ui/src/turn-tokens.ts and usage-ledger.ts. Turn labels must say Usage unavailable for estimated, inconsistent, non-provider, or context/session-scope readings; complete measured turn totals remain exact and partial/request readings use ≥. For mixed or incomplete sessions, display only a valid reportedTotalTokens subtotal with ≥, excluding estimated counts and suppressing the cache note. Without an isolatable reported subtotal, mixed/unverified usage stays unavailable. Preserve measured zero, complete counts, and inclusive cache/reasoning accounting. Inspect both modules, implement and verify the behavior. Edit only those two files.",
    ],
    allowedChanges: [turnPath, ledgerPath],
    verifier: read("verifiers/usage.mjs"),
    referenceSolution: { [turnPath]: turn, [ledgerPath]: ledger },
  }),
  task({
    id: "gyro-search-session-recovery",
    category: "long-session-recovery",
    files: {
      ...common(
        "Repair asynchronous multi-root search through a six-turn evidence-recovery exercise. Evidence captures are generated fixture data, not real user searches.",
        `import { runWorkspaceSearchRoots } from "../${searchPath}";\ntest("empty root list performs no search", async () => { let calls = 0; await runWorkspaceSearchRoots([], async () => { calls++; return []; }, () => {}, () => true, 10); assert.equal(calls, 0); });\n`,
      ),
      [searchPath]: brokenSearch,
      "evidence/capture-a.ndjson": capture("a"),
      "evidence/capture-b.ndjson": capture("b"),
      "scripts/replay-capture.mjs":
        'import { readFileSync } from "node:fs";\nconst name = process.argv[2];\nif (!["a", "b"].includes(name)) throw new Error("Use a or b");\nprocess.stdout.write(readFileSync(new URL(`../evidence/capture-${name}.ndjson`, import.meta.url)));\n',
    },
    turns: [
      "Investigate apps/desktop/src/workspace-search-run.ts. Read README.md and run node scripts/replay-capture.mjs a to inspect the first diagnostic capture. It is generated fixture data. Identify the ordering and stale-query risks; do not edit yet. The final checkpoint will need the first capture's metadata and exact capture-a-047 row, so keep the evidence recoverable. Only the search module and evidence-summary.json may be changed during this task.",
      "Work through a case where gamma finishes before beta and alpha. Explain what currently publishes and what should publish under one global result cap. Preserve early publication from fast roots; do not serialize the searches. Inspect the module and public smoke test before making changes.",
      "Implement stable workspace-order publication in the search module while retaining concurrent root searches, incremental results, a global cap, and unchanged input arrays. Run the smoke test and a targeted out-of-order check. Keep the original task constraints in force.",
      "Run node scripts/replay-capture.mjs b to add the second diagnostic capture to the investigation. Examine how an in-flight request can become stale before either success or failure. Successful roots must remain visible when another root fails, and current-query errors must identify every failed root after all settle. Explain the remaining gaps before editing.",
      "Finish the stale-query and failure handling. An already obsolete query must launch no work; a query superseded while awaiting must neither publish nor throw its obsolete failure. Current queries must await all roots, retain successful results, and throw an AggregateError naming every failed path. Verify these behaviors and preserve the earlier ordering repair.",
      "Complete the recovery checkpoint: recover the first capture's metadata and capture-a-047 row from retained evidence, a spill reference, or the original capture file. Write evidence-summary.json with exactly captureId, workspaceOrder, completionOrder, globalCap, anchor {eventId,path,line,symbol}, and recordCount (data rows excluding the header). Use capture A, not B. Run final checks and report the change. Edit only apps/desktop/src/workspace-search-run.ts and evidence-summary.json. Do not claim a spill or compaction occurred unless you observed one.",
    ],
    allowedChanges: [searchPath, "evidence-summary.json"],
    verifier: read("verifiers/search.mjs"),
    referenceSolution: {
      [searchPath]: search,
      "evidence-summary.json": expectedSummary,
    },
  }),
];

// Each control is a plausible incomplete or over-broad repair, tested behaviorally.
export const controls = [
  [
    {
      name: "disable-all-retries",
      patch: {
        [retryPath]: replaceOnce(
          retry,
          "  return status;",
          "  return undefined;",
        ),
      },
      failure: "transient pre-work failures remain eligible",
    },
    {
      name: "restore-only-one-terminal-kind",
      patch: {
        [retryPath]: replaceOnce(
          replaceOnce(retry, '  "tool-budget",\n', ""),
          '  "partial-answer",\n',
          "",
        ),
      },
      failure: "terminal tool-budget overrides transient-looking error text",
    },
  ],
  [
    {
      name: "repair-only-turn-display",
      patch: { [ledgerPath]: brokenLedger },
      failure: "mixed session uses only the reported subtotal as a lower bound",
    },
    {
      name: "repair-only-session-display",
      patch: { [turnPath]: brokenTurn },
      failure: "estimated turn counts are never presented as provider usage",
    },
    {
      name: "hide-all-turn-counts",
      patch: {
        [turnPath]: replaceOnce(
          turn,
          '  if (unavailable(tokens)) return "Usage unavailable";',
          '  return "Usage unavailable";',
        ),
      },
      failure:
        "complete turns stay exact and request or partial readings are lower bounds",
    },
  ],
  [
    {
      name: "completion-order-results",
      patch: { [searchPath]: unorderedSearch },
      failure:
        "fast roots publish early but final results use workspace order and one global cap",
    },
    {
      name: "stale-query-results",
      patch: { [searchPath]: staleSearch },
      failure: "superseded successful queries cannot publish stale results",
    },
    {
      name: "swallow-current-query-errors",
      patch: {
        [searchPath]: replaceOnce(
          search,
          "  if (failures.length)",
          "  if (false)",
        ),
      },
      failure:
        "a root failure waits for successful roots and identifies every failing path",
    },
    {
      name: "wrong-capture-recovery",
      patch: {
        "evidence-summary.json": expectedSummary.replace(
          "20261031-a",
          "20261031-b",
        ),
      },
      failure: "early evidence is recovered accurately at the final checkpoint",
    },
  ],
];
export const baselineFailures = [
  "terminal no-progress overrides transient-looking error text",
  "estimated turn counts are never presented as provider usage",
  "fast roots publish early but final results use workspace order and one global cap",
];
export const spec = {
  schema: "gyro.efficiency-benchmark.v2",
  providers: [],
  trials: 3,
  timeoutSeconds: 180,
  variants: ["baseline", "recoverable-evidence", "cache-assembly"],
  cacheConditions: ["fresh-session", "resumed-session"],
  executionBudget: {
    maxObservedTokens: 0,
    maxCalls: 0,
    maxCostMicros: null,
    currency: "USD",
    maxTokensPerTurn: 20_000,
  },
  prices: [],
  tasks,
};
export const serializedSpec = JSON.stringify(spec, null, 2) + "\n";
