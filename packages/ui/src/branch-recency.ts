import type { GitBranchCatalog } from "./types";

/** Keep the current branch visible, then show the newest local commits first. */
export function recentBranches(
  catalog?: GitBranchCatalog,
  current = catalog?.current,
) {
  const dates = catalog?.lastCommitAt ?? {};
  const timestamp = (branch: string) =>
    Number.isFinite(dates[branch]) ? dates[branch] : undefined;
  const knownDates = (catalog?.branches ?? [])
    .map(timestamp)
    .filter((date): date is number => date !== undefined);
  const latest = knownDates.reduce<number | undefined>(
    (newest, date) => (newest === undefined ? date : Math.max(newest, date)),
    undefined,
  );
  return [...(catalog?.branches ?? [])]
    .sort(
      (a, b) =>
        Number(b === current) - Number(a === current) ||
        (timestamp(b) ?? -Infinity) - (timestamp(a) ?? -Infinity) ||
        0,
    )
    .map((name) => ({
      name,
      current: name === current,
      latest: latest !== undefined && timestamp(name) === latest,
      committedAt: timestamp(name),
    }));
}

export function branchCommitAge(timestamp?: number, now = Date.now()) {
  if (timestamp === undefined) return undefined;
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return undefined;
  const minutes = Math.floor((now - date.getTime()) / 60_000);
  if (minutes < 0) return date.toLocaleDateString();
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 43200) return `${Math.floor(minutes / 1440)}d ago`;
  return date.toLocaleDateString();
}

export function branchCommitDetail(timestamp?: number) {
  const age = branchCommitAge(timestamp);
  return age ? `Last commit ${age}` : undefined;
}
