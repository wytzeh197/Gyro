import assert from "node:assert/strict";

import {
  filesForReviewScope,
  reviewComparisonForScope,
  reviewScopeEmptyCopy,
  reviewScopeFromTotals,
  reviewScopeTitle,
} from "../packages/ui/src/review-scope.ts";
import { sourceControlTotals } from "../packages/ui/src/source-control-stats.ts";
import {
  diffHunks,
  shouldUsePlainDiff,
} from "../packages/ui/src/file-review.ts";

const repo = (overrides) => ({
  provider: "git",
  available: true,
  ahead: 0,
  behind: 0,
  additions: 12,
  deletions: 3,
  statsPartial: false,
  files: [
    {
      path: "lib.rs",
      state: "modified",
      staged: false,
      additions: 5,
      deletions: 1,
    },
  ],
  ...overrides,
});

{
  const totals = sourceControlTotals(
    repo({
      comparedToMain: {
        additions: 268,
        deletions: 46,
        partial: false,
        files: [
          {
            path: "apps/desktop/src-tauri/src/lib.rs",
            state: "modified",
            staged: false,
            additions: 200,
            deletions: 40,
          },
        ],
      },
    }),
  );
  assert.equal(reviewScopeFromTotals(totals, 1).kind, "branch");
  const listing = filesForReviewScope(reviewScopeFromTotals(totals, 1), {
    sourceControl: repo({
      comparedToMain: {
        additions: 268,
        deletions: 46,
        partial: false,
        files: [
          {
            path: "apps/desktop/src-tauri/src/lib.rs",
            state: "modified",
            staged: false,
            additions: 200,
            deletions: 40,
          },
        ],
      },
    }),
  });
  assert.equal(listing.files.length, 1);
  assert.equal(listing.files[0].path, "apps/desktop/src-tauri/src/lib.rs");
  assert.equal(reviewComparisonForScope({ kind: "branch" }), "branch");
}

{
  const totals = sourceControlTotals(repo({ comparedToMain: undefined }));
  assert.equal(reviewScopeFromTotals(totals, 1).kind, "working-tree");
  const listing = filesForReviewScope(
    { kind: "working-tree" },
    { sourceControl: repo({ comparedToMain: undefined }) },
  );
  assert.equal(listing.files[0].path, "lib.rs");
}

{
  const listing = filesForReviewScope(
    { kind: "turn", turnId: "turn_old" },
    {
      sourceControl: repo({
        comparedToMain: {
          additions: 268,
          deletions: 46,
          partial: false,
          files: [
            {
              path: "unrelated.rs",
              state: "modified",
              staged: false,
              additions: 1,
              deletions: 0,
            },
          ],
        },
      }),
      turnFiles: [],
    },
  );
  assert.equal(listing.files.length, 0);
  assert.match(
    listing.limitation ?? "",
    /not backfilled/i,
    "a historical turn must not be filled with the live working tree",
  );
}

{
  const listing = filesForReviewScope(
    { kind: "branch" },
    {
      sourceControl: repo({
        comparedToMain: { additions: 268, deletions: 46, partial: false },
      }),
    },
  );
  assert.equal(listing.files.length, 0);
  assert.match(listing.limitation ?? "", /list files compared to main/i);
}

assert.equal(reviewScopeTitle({ kind: "proposed" }), "Recorded file changes");
assert.equal(
  reviewScopeEmptyCopy({ kind: "proposed" }).title,
  "No changes to review",
);
assert.equal(
  reviewScopeEmptyCopy({ kind: "working-tree" }).title,
  "No uncommitted changes",
);

{
  const hunks = diffHunks(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 context
-removed
+added
@@ -10,1 +11,1 @@
+later
`);
  assert.equal(hunks.length, 2);
  assert.equal(
    hunks[0].lines.some((line) => line.kind === "added"),
    true,
  );
}

assert.equal(shouldUsePlainDiff("short\n", "also short\n"), false);
assert.equal(
  shouldUsePlainDiff("x".repeat(513 * 1024), "y"),
  true,
  "a half-megabyte file uses the text fallback",
);

console.log("Review scope and plain-diff checks passed.");
