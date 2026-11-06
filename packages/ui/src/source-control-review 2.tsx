import { ArrowDown, ArrowUp, FileCode2, RefreshCw } from "lucide-react";

export function comparisonScopeLabel(
  comparison?: "working-tree" | "index" | "branch",
  staged = false,
) {
  if (comparison === "branch") return "main ↔ Working Tree";
  if (comparison === "index" || staged) return "HEAD ↔ Index";
  return "Index ↔ Working Tree";
}

export function ScmReviewToolbar({
  staged,
  comparison,
  summary,
  canNavigate,
  onPrevious,
  onNext,
  onRefresh,
  onOpenFile,
}: {
  staged: boolean;
  comparison?: "working-tree" | "index" | "branch";
  summary: string;
  canNavigate: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onRefresh: () => void;
  onOpenFile: () => void;
}) {
  return (
    <div className="gyro-review-toolbar">
      <span>{comparisonScopeLabel(comparison, staged)}</span>
      <span className="gyro-review-summary" role="status">
        {summary}
      </span>
      <button
        aria-label="Previous change"
        title="Previous change"
        disabled={!canNavigate}
        onClick={onPrevious}
      >
        <ArrowUp size={14} />
      </button>
      <button
        aria-label="Next change"
        title="Next change"
        disabled={!canNavigate}
        onClick={onNext}
      >
        <ArrowDown size={14} />
      </button>
      <button
        aria-label="Refresh diff"
        title="Refresh diff"
        onClick={onRefresh}
      >
        <RefreshCw size={14} />
      </button>
      <button
        aria-label="Open working file"
        title="Open working file"
        onClick={onOpenFile}
      >
        <FileCode2 size={14} />
        <span>Open file</span>
      </button>
    </div>
  );
}
