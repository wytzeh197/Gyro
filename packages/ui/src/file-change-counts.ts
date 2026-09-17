/** Missing measurements are unknown, never zero or live working-tree totals. */
export type FileChangeCounts = { additions?: number; deletions?: number };

export function measuredFileCounts(
  counts: FileChangeCounts,
): { additions: number; deletions: number } | undefined {
  const { additions, deletions } = counts;
  return typeof additions === "number" &&
    Number.isSafeInteger(additions) &&
    additions >= 0 &&
    typeof deletions === "number" &&
    Number.isSafeInteger(deletions) &&
    deletions >= 0
    ? { additions, deletions }
    : undefined;
}

/** A partial sum must not be presented as the complete turn's total. */
export function totalFileChangeCounts(files: readonly FileChangeCounts[]) {
  if (!files.length) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    const counts = measuredFileCounts(file);
    if (!counts) return undefined;
    additions += counts.additions;
    deletions += counts.deletions;
  }
  return measuredFileCounts({ additions, deletions });
}
