import type { SessionEvent } from "./types.ts";

/** Applied receipts carry measurements even when their approval UI is hidden. */
export function isAppliedFileMutationEvent(event: SessionEvent): boolean {
  const payload = event.payload as Record<string, unknown> | undefined;
  return (
    event.kind === "system-event" &&
    payload?.status === "applied" &&
    ["gyro.mutation.v1", "gyro.provider-approval.v1"].includes(
      String(payload.schema),
    )
  );
}

/** Exact counts recorded by successful, guarded mutations in this turn. */
export function appliedFileChangeCounts(events: readonly SessionEvent[]) {
  const totals = new Map<string, { additions: number; deletions: number }>();
  const seen = new Set<string>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (
      !isAppliedFileMutationEvent(event) ||
      !payload ||
      !Array.isArray(payload.fileChanges)
    )
      continue;
    const mutationId = payload.proposalId ?? payload.approvalId ?? event.id;
    for (const entry of payload.fileChanges) {
      if (!entry || typeof entry !== "object" || typeof entry.path !== "string")
        continue;
      const counts = measuredFileCounts(entry);
      if (!counts) continue;
      const key = JSON.stringify([
        event.sessionId,
        event.turnId,
        mutationId,
        entry.path,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      const previous = totals.get(entry.path);
      totals.set(entry.path, {
        additions: (previous?.additions ?? 0) + counts.additions,
        deletions: (previous?.deletions ?? 0) + counts.deletions,
      });
    }
  }
  return totals;
}

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
