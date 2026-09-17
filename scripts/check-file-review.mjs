import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { totalFileChangeCounts } from "../packages/ui/src/file-change-counts.ts";
import { filesForReviewScope } from "../packages/ui/src/review-scope.ts";

import {
  askAboutFilePrompt,
  changeSummaryLine,
  diffPreviewLines,
  fileReviewDecisions,
  isKeptCurrent,
  latestFileReviewTurn,
} from "../packages/ui/src/file-review.ts";
import { FILE_REVIEW_SCHEMA } from "../packages/ui/src/types.ts";

let sequence = 0;
const at = (minutes) =>
  new Date(
    Date.parse("2026-08-02T09:00:00.000Z") + minutes * 60_000,
  ).toISOString();

const event = (kind, message, payload = {}, turnId = "turn_1", minutes = 0) => {
  sequence += 1;
  return {
    id: `evt_${sequence}`,
    sessionId: "ses_1",
    turnId,
    createdAt: at(minutes),
    kind,
    message,
    payload,
  };
};

const fileEdit = (path, extra = {}, turnId = "turn_1") =>
  event(
    "system-event",
    `Updated ${path}`,
    {
      kind: "provider-activity",
      activityKind: "file",
      status: "done",
      path,
      additions: 4,
      deletions: 1,
      ...extra,
    },
    turnId,
  );

const kept = (path, contentHash, turnId = "turn_1", minutes = 0) =>
  event(
    "system-event",
    `Kept ${path}`,
    {
      schema: FILE_REVIEW_SCHEMA,
      kind: "file-review",
      path,
      contentHash,
      decision: "kept",
    },
    turnId,
    minutes,
  );

// --- The one line under a file name ------------------------------------------
// Nothing here may be invented: the card shows a sentence bought for this diff,
// the agent's own note, or the measured counts — in that order, and nothing at
// all when it has none of them.

assert.equal(
  changeSummaryLine({}, undefined),
  undefined,
  "a file with no summary and no note gets no line rather than filler",
);

assert.deepEqual(
  changeSummaryLine(
    { intent: "tidying imports" },
    {
      path: "a.ts",
      contentHash: "h",
      summary: "Adds a retry.",
      source: "provider",
    },
  ),
  { text: "Adds a retry.", source: "provider" },
  "a sentence written about this diff outranks the agent's own note",
);

assert.deepEqual(
  changeSummaryLine(
    { intent: "tidying   imports" },
    {
      path: "a.ts",
      contentHash: "h",
      summary: "4 lines added, 1 removed.",
      source: "fallback",
    },
  ),
  { text: "Tidying imports.", source: "intent" },
  "the agent's note outranks a count, and is written as a sentence",
);

assert.deepEqual(
  changeSummaryLine(
    {},
    {
      path: "a.ts",
      contentHash: "h",
      summary: "4 lines added, 1 removed.",
      source: "fallback",
    },
  ),
  { text: "4 lines added, 1 removed.", source: "fallback" },
  "a count is a last resort, and says so through its source",
);

assert.deepEqual(
  changeSummaryLine(
    {},
    { path: "a.ts", contentHash: "h", summary: "   ", source: "provider" },
  ),
  undefined,
  "an empty provider sentence is not a line",
);

// --- Keep is a reading record ------------------------------------------------

const decisions = fileReviewDecisions([
  fileEdit("src/a.ts"),
  kept("src/a.ts", "hash-1"),
  kept("src/b.ts", "hash-2", "turn_1", 1),
]);
assert.deepEqual(
  [...decisions.keys()].sort(),
  ["src/a.ts", "src/b.ts"],
  "every kept file is replayed out of the session log",
);
assert.equal(decisions.get("src/a.ts").decision, "kept");

const relit = fileReviewDecisions([
  kept("src/a.ts", "hash-1"),
  kept("src/a.ts", "hash-2", "turn_1", 1),
]);
assert.equal(
  relit.get("src/a.ts").contentHash,
  "hash-2",
  "the newest Keep for a path wins",
);

assert.equal(
  fileReviewDecisions([
    event("system-event", "Updated src/a.ts", {
      kind: "provider-activity",
      activityKind: "file",
      path: "src/a.ts",
    }),
  ]).size,
  0,
  "only file-review events count as decisions",
);

// A Keep is about content, so an edit after it retires the badge rather than
// telling the user they have read something they have not.
assert.equal(isKeptCurrent(undefined, "hash-1"), false);
assert.equal(
  isKeptCurrent(
    { decision: "kept", contentHash: "hash-1", at: at(0) },
    "hash-1",
  ),
  true,
);
assert.equal(
  isKeptCurrent(
    { decision: "kept", contentHash: "hash-1", at: at(0) },
    "hash-2",
  ),
  false,
  "a file edited again since the Keep is unread again",
);
assert.equal(
  isKeptCurrent(
    { decision: "kept", contentHash: "hash-1", at: at(0) },
    undefined,
  ),
  true,
  "an unknown current hash leaves the last known answer standing",
);

// --- The turn a summary call is spent on -------------------------------------

assert.equal(
  latestFileReviewTurn([event("user-message", "hello")]),
  undefined,
  "a turn that edited nothing is not worth a summary call",
);

const target = latestFileReviewTurn([
  fileEdit("src/old.ts", {}, "turn_1"),
  event("assistant-message", "done", {}, "turn_1"),
  fileEdit("src/a.ts", { intent: "add a retry" }, "turn_2"),
  fileEdit("src/a.ts", { additions: 9, deletions: 2 }, "turn_2"),
  fileEdit("Files", {}, "turn_2"),
]);
assert.equal(target.turnId, "turn_2", "only the newest turn is described");
assert.deepEqual(
  target.files,
  [{ path: "src/a.ts", additions: 9, deletions: 2, intent: "add a retry" }],
  "a path edited twice is one file, keeping the note the agent left with it",
);

// --- Unknown counts and rendered badges --------------------------------------

const unknownTurn = latestFileReviewTurn([
  fileEdit("unknown.ts", { additions: undefined, deletions: undefined }),
]);
assert.equal(unknownTurn.files[0].additions, undefined);
assert.equal(unknownTurn.files[0].deletions, undefined);
const unknownListing = filesForReviewScope(
  { kind: "turn", turnId: unknownTurn.turnId },
  { turnFiles: unknownTurn.files },
);
assert.deepEqual(unknownListing.files, [
  { path: "unknown.ts", additions: undefined, deletions: undefined },
]);
const measured = [
  { additions: 9, deletions: 2 },
  { additions: 3, deletions: 0 },
];
assert.deepEqual(totalFileChangeCounts(measured), {
  additions: 12,
  deletions: 2,
});
assert.equal(
  totalFileChangeCounts([...measured, ...unknownTurn.files]),
  undefined,
);
assert.equal(totalFileChangeCounts([{ additions: 3 }]), undefined);
assert.equal(
  totalFileChangeCounts([{ additions: -1, deletions: 0 }]),
  undefined,
);
assert.equal(
  totalFileChangeCounts([{ additions: NaN, deletions: 0 }]),
  undefined,
);
assert.equal(totalFileChangeCounts([]), undefined);
assert.deepEqual(totalFileChangeCounts([{ additions: 0, deletions: 0 }]), {
  additions: 0,
  deletions: 0,
});

// Render the actual shared badges used by live, completed, and Review surfaces.
const badgeUrl = new URL(
  "../packages/ui/src/file-change-counts-view.tsx",
  import.meta.url,
);
const requireUi = createRequire(badgeUrl);
const { createElement } = requireUi("react");
const { renderToStaticMarkup } = requireUi("react-dom/server");
const compiled = ts.transpileModule(readFileSync(badgeUrl, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const badgeModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  requireUi,
  badgeModule,
  badgeModule.exports,
);
const renderCounts = (counts) =>
  renderToStaticMarkup(
    createElement(badgeModule.exports.FileChangeCountBadges, { counts }),
  );
assert.equal(renderCounts(undefined), "<span>Line counts unavailable</span>");
assert.equal(
  renderCounts({ additions: 3 }),
  "<span>Line counts unavailable</span>",
);
assert.match(renderCounts({ additions: 9, deletions: 2 }), />\+9<.*>−2</);
assert.match(renderCounts({ additions: 0, deletions: 0 }), />\+0<.*>−0</);
assert.equal(
  renderCounts(totalFileChangeCounts([...measured, {}])),
  "<span>Line counts unavailable</span>",
);

// --- The inline diff ---------------------------------------------------------

const preview = diffPreviewLines(
  [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "",
  ].join("\n"),
);
assert.equal(preview.truncated, false);
assert.deepEqual(
  preview.lines.map((line) => line.kind),
  ["meta", "meta", "meta", "meta", "hunk", "context", "removed", "added"],
  "file headers are metadata, not added and removed content",
);

const long = diffPreviewLines(
  Array.from({ length: 40 }, (_, index) => `+line ${index}`).join("\n"),
  10,
);
assert.equal(long.lines.length, 10, "the inline preview is capped");
assert.equal(long.truncated, true, "and says so, rather than silently ending");

// --- Ask AI ------------------------------------------------------------------
// Prefill only: the prompt is a question opener the user finishes and sends.

assert.equal(askAboutFilePrompt("src/a.ts"), "About src/a.ts: ");

// --- The card cannot claim work it did not do --------------------------------

const surfaces = readFileSync(
  new URL("../packages/ui/src/surfaces.tsx", import.meta.url),
  "utf8",
);
const cardStart = surfaces.indexOf("function ChatRunChangeSummary(");
assert.doesNotMatch(surfaces, /additions: file\.additions \?\? 0/);
const turnSource = surfaces.slice(
  surfaces.indexOf("function ChatTurn("),
  cardStart,
);
assert.doesNotMatch(
  turnSource,
  /fileStats:/,
  "turn totals must not borrow shared Git counts",
);
assert.match(surfaces, /FileChangeCountBadges counts=\{totals\}/);
assert.ok(cardStart > 0, "the review card should be findable in surfaces.tsx");
const card = surfaces.slice(
  cardStart,
  surfaces.indexOf("function ChangeSummaryDiff(", cardStart),
);
for (const claim of ["Applied", "Reverted", "Pending", "Discard"]) {
  assert.equal(
    card.includes(`>${claim}`),
    false,
    `Keep records a reading, so the card must not offer "${claim}"`,
  );
}
assert.ok(
  card.includes("isSummarizing"),
  "the waiting line is shown only while a summary call is actually in flight",
);

console.log("file review checks passed");
