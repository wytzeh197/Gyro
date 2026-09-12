import type { SourceControlState } from "./types.ts";

/**
 * The one +/− pair a surface prints for a repository.
 *
 * Two different quantities can fill that slot and they are rarely equal: the
 * branch measured against main, which counts committed work, and the
 * uncommitted working tree, which does not. Reading whichever one a surface
 * happened to have on hand is what let the Workspace sidebar show +487 −390
 * while the chat Environment showed +335 −338 for the same repository at the
 * same moment. Every surface resolves the pair here instead, so they cannot
 * drift, and each pair carries what it measured so a fallback is never passed
 * off as the headline figure.
 */
export type SourceControlTotals =
  | { kind: "branch"; additions: number; deletions: number }
  | { kind: "working-tree"; additions: number; deletions: number }
  | { kind: "clean" }
  | { kind: "unavailable" };

/**
 * Prefer the branch against main — the number that answers "how much has this
 * piece of work changed", and the only one that stays right when the work is
 * committed. The working tree stands in when that comparison could not be
 * made, and says so rather than borrowing the branch's meaning.
 */
export function sourceControlTotals(
  sourceControl?: SourceControlState,
): SourceControlTotals {
  if (!sourceControl?.available) return { kind: "unavailable" };
  const branch = sourceControl.comparedToMain;
  if (branch && !branch.partial) {
    return branch.additions === 0 && branch.deletions === 0
      ? { kind: "clean" }
      : {
          kind: "branch",
          additions: branch.additions,
          deletions: branch.deletions,
        };
  }
  if (sourceControl.statsPartial) return { kind: "unavailable" };
  return sourceControl.additions === 0 && sourceControl.deletions === 0
    ? { kind: "clean" }
    : {
        kind: "working-tree",
        additions: sourceControl.additions,
        deletions: sourceControl.deletions,
      };
}

/** What the pair measured, for a row's tooltip and screen-reader label. */
export function sourceControlTotalsScope(totals: SourceControlTotals) {
  switch (totals.kind) {
    case "branch":
      return "Compared to main";
    case "working-tree":
      return "Uncommitted changes; comparison with main is unavailable";
    case "clean":
      return "No changes compared to main";
    case "unavailable":
      return "Could not finish counting changes. Refresh to retry.";
  }
}

/** The row's own text when there is no pair of numbers to draw. */
export function sourceControlTotalsLabel(totals: SourceControlTotals) {
  return totals.kind === "clean" ? "Clean" : "Count unavailable";
}
