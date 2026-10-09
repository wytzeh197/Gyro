import assert from "node:assert/strict";
import { buildDiffFileTree } from "../packages/ui/src/diff-file-tree.ts";

import {
  defaultChatReview,
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

{
  const events = [
    {
      id: "old",
      turnId: "old-turn",
      kind: "system-event",
      payload: {
        kind: "provider-activity",
        activityKind: "file",
        status: "done",
        path: "old.ts",
        additions: 1,
        deletions: 0,
      },
    },
    {
      id: "new",
      turnId: "new-turn",
      kind: "system-event",
      payload: {
        kind: "provider-activity",
        activityKind: "file",
        status: "done",
        path: "new.ts",
        additions: 2,
        deletions: 1,
      },
    },
  ];
  events.splice(1, 0, {
    id: "old-patch",
    turnId: "old-turn",
    kind: "system-event",
    payload: {
      schema: "gyro.mutation.v1",
      status: "applied",
      fileChanges: [{ path: "new.ts", patch: "old turn patch" }],
    },
  });
  events.push({
    id: "new-patch",
    turnId: "new-turn",
    kind: "system-event",
    payload: {
      schema: "gyro.mutation.v1",
      status: "applied",
      fileChanges: [{ path: "new.ts", patch: "new turn patch" }],
    },
  });
  const review = defaultChatReview(events, false);
  assert.deepEqual(review.scope, { kind: "turn", turnId: "new-turn" });
  assert.deepEqual(
    review.turnFiles.map((file) => file.path),
    ["new.ts"],
  );
  assert.deepEqual(
    review.turnFiles[0].patches,
    ["new turn patch"],
    "reopening Review must not mix another turn's patches into the selected turn",
  );
  assert.deepEqual(
    defaultChatReview(events, true),
    { scope: { kind: "proposed" } },
    "an explicit proposed review must retain its approval controls",
  );
  assert.deepEqual(
    defaultChatReview([], false),
    { scope: { kind: "proposed" } },
    "an empty chat must not borrow changes from another chat or the repository",
  );
}
assert.equal(
  shouldUsePlainDiff("x".repeat(513 * 1024), "y"),
  true,
  "a half-megabyte file uses the text fallback",
);

console.log("Review scope and plain-diff checks passed.");

// Shared path navigation must retain same-named file/directory replacements and
// unknown counts; compacting folders must not lose their full identity.
{
  const files = [
    { path: "/repo/src/a.ts", additions: 2, deletions: 1, state: "pending" },
    { path: "/repo/src/nested/b.ts" },
    { path: "/repo/src/nested/deep/c.ts", additions: 1, deletions: 0 },
    { path: "/repo/foo" },
    { path: "/repo/foo/child.ts" },
  ];
  const tree = buildDiffFileTree(files, "/repo");
  assert.equal(tree.filter((node) => node.name === "foo").length, 2);
  const src = tree.find((node) => node.kind === "directory" && node.name === "src");
  assert.equal(src.changedFiles, 3);
  assert.equal(src.pendingFiles, 1);
  assert.equal(src.additions, 3);
  const gather = (nodes) => nodes.flatMap((node) => node.kind === "file" ? [node.file] : gather(node.children));
  assert.deepEqual(new Set(gather(tree)), new Set(files));
  assert.equal(gather(tree).find((file) => file.path.endsWith("b.ts")).additions, undefined);
  const compact = buildDiffFileTree([{ path: "packages/ui/src/one.ts" }]);
  assert.equal(compact[0].name, "packages/ui/src");
  assert.equal(compact[0].path, "packages/ui/src");
}
