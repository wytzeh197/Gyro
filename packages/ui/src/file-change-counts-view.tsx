import {
  measuredFileCounts,
  type FileChangeCounts,
} from "./file-change-counts.ts";

export function FileChangeCountBadges({
  counts,
}: {
  counts?: FileChangeCounts;
}) {
  const measured = counts && measuredFileCounts(counts);
  return measured ? (
    <>
      <em className="is-added">+{measured.additions}</em>
      {" "}
      <em className="is-removed">−{measured.deletions}</em>
    </>
  ) : (
    <span>Line counts unavailable</span>
  );
}
