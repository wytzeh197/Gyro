import {
  measuredFileCounts,
  type FileChangeCounts,
} from "./file-change-counts.ts";

export function FileChangeCountBadges({
  counts,
  showUnknown = true,
}: {
  counts?: FileChangeCounts;
  showUnknown?: boolean;
}) {
  const measured = counts && measuredFileCounts(counts);
  return measured ? (
    <>
      <em className="is-added">+{measured.additions}</em>
      {" "}
      <em className="is-removed">−{measured.deletions}</em>
    </>
  ) : showUnknown ? (
    <span>Line counts unavailable</span>
  ) : null;
}
