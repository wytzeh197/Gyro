import type { SourceControlFile, SourceControlState } from "./types.ts";
import {
  sourceControlTotals,
  type SourceControlTotals,
} from "./source-control-stats.ts";

/**
 * What a Review entry point promised when it was opened.
 *
 * Environment's +/− pair, a turn's edited-file card, uncommitted source
 * control, and proposed-edit approval are four different lists. Routing them
 * all to the proposed-edit empty state is what made "Changes +268 −46" open
 * "No changes to review".
 */
export type ReviewScope =
  | { kind: "proposed" }
  | { kind: "working-tree" }
  | { kind: "branch" }
  | { kind: "turn"; turnId: string };

export type ReviewFile = {
  path: string;
  originalPath?: string;
  additions?: number;
  deletions?: number;
  staged?: boolean;
};

export type ReviewScopeListing = {
  files: ReviewFile[];
  limitation?: string;
};

export function reviewScopeFromTotals(
  totals: SourceControlTotals,
  uncommittedCount = 0,
): ReviewScope {
  if (totals.kind === "branch") return { kind: "branch" };
  if (totals.kind === "working-tree") return { kind: "working-tree" };
  if (uncommittedCount > 0) return { kind: "working-tree" };
  return { kind: "branch" };
}

export function reviewScopeFromSourceControl(
  sourceControl?: SourceControlState,
): ReviewScope {
  return reviewScopeFromTotals(
    sourceControlTotals(sourceControl),
    sourceControl?.files.length ?? 0,
  );
}

export function reviewScopeTitle(scope: ReviewScope) {
  switch (scope.kind) {
    case "proposed":
      return "Proposed edits";
    case "working-tree":
      return "Uncommitted changes";
    case "branch":
      return "Compared to main";
    case "turn":
      return "This turn";
  }
}

export function reviewScopeEmptyCopy(scope: ReviewScope): {
  title: string;
  detail: string;
} {
  switch (scope.kind) {
    case "proposed":
      return {
        title: "No changes to review",
        detail: "Proposed file edits will appear here before approval.",
      };
    case "working-tree":
      return {
        title: "No uncommitted changes",
        detail: "The working tree matches the index for this workspace.",
      };
    case "branch":
      return {
        title: "No changes compared to main",
        detail: "This branch matches main. Uncommitted files are listed under source control.",
      };
    case "turn":
      return {
        title: "This turn’s file list is not available",
        detail:
          "Older records were not backfilled. Current repository changes are not shown here.",
      };
  }
}

/**
 * The files this scope is allowed to show. A historical turn never borrows the
 * live working tree just to avoid an empty state.
 */
export function filesForReviewScope(
  scope: ReviewScope,
  options: {
    sourceControl?: SourceControlState;
    turnFiles?: Array<{
      path: string;
      additions?: number;
      deletions?: number;
    }>;
  } = {},
): ReviewScopeListing {
  if (scope.kind === "proposed") {
    return { files: [] };
  }
  if (scope.kind === "turn") {
    const files = (options.turnFiles ?? []).map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    }));
    if (files.length === 0) {
      return {
        files: [],
        limitation: reviewScopeEmptyCopy(scope).detail,
      };
    }
    return { files };
  }
  if (scope.kind === "working-tree") {
    const files = (options.sourceControl?.files ?? []).map(toReviewFile);
    return { files };
  }
  const comparison = options.sourceControl?.comparedToMain;
  if (!comparison) {
    return {
      files: [],
      limitation:
        "Could not compare this branch with main. Refresh source control to retry.",
    };
  }
  const files = (comparison.files ?? []).map(toReviewFile);
  if (
    files.length === 0 &&
    (comparison.additions > 0 || comparison.deletions > 0)
  ) {
    return {
      files: [],
      limitation:
        "Could not list files compared to main. Refresh source control to retry.",
    };
  }
  return { files };
}

export function reviewComparisonForScope(
  scope: ReviewScope,
  file?: Pick<ReviewFile, "staged">,
): "working-tree" | "index" | "branch" {
  if (scope.kind === "branch") return "branch";
  if (file?.staged) return "index";
  return "working-tree";
}

function toReviewFile(file: SourceControlFile): ReviewFile {
  return {
    path: file.path,
    originalPath: file.originalPath,
    additions: file.additions,
    deletions: file.deletions,
    staged: file.staged,
  };
}
