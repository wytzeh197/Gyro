import { useMemo, useState } from "react";
import { diffHunks, type DiffHunk } from "./file-review.ts";

const HUNKS_PER_PAGE = 8;

/**
 * A bounded unified-diff reader for files the rich editor cannot render.
 * Hunks stay paginated so a 30k-line file with a handful of edits remains
 * inspectable instead of painting a blank Monaco pane.
 */
export function PlainDiffView({
  diff,
  notice,
  onRetry,
  onOpenFile,
}: {
  diff: string;
  notice?: string;
  onRetry?: () => void;
  onOpenFile?: () => void;
}) {
  const hunks = useMemo(() => diffHunks(diff), [diff]);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(hunks.length / HUNKS_PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = hunks.slice(
    safePage * HUNKS_PER_PAGE,
    safePage * HUNKS_PER_PAGE + HUNKS_PER_PAGE,
  );

  if (!hunks.length) {
    return (
      <div className="gyro-plain-diff is-empty" role="status">
        <strong>No text changes in this comparison.</strong>
        <span>The file is present on both sides with identical contents.</span>
        <PlainDiffActions onOpenFile={onOpenFile} onRetry={onRetry} />
      </div>
    );
  }

  return (
    <div className="gyro-plain-diff">
      {notice ? (
        <div className="gyro-plain-diff-notice" role="status">
          {notice}
        </div>
      ) : null}
      <div className="gyro-plain-diff-toolbar">
        <span>
          {hunks.length} hunk{hunks.length === 1 ? "" : "s"}
          {pageCount > 1
            ? ` · ${safePage + 1} of ${pageCount}`
            : ""}
        </span>
        {pageCount > 1 ? (
          <span className="gyro-plain-diff-pager">
            <button
              disabled={safePage === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              type="button"
            >
              Previous hunks
            </button>
            <button
              disabled={safePage >= pageCount - 1}
              onClick={() =>
                setPage((current) => Math.min(pageCount - 1, current + 1))
              }
              type="button"
            >
              Next hunks
            </button>
          </span>
        ) : null}
      </div>
      <div className="gyro-plain-diff-hunks">
        {visible.map((hunk, index) => (
          <PlainDiffHunk hunk={hunk} key={`${hunk.header}:${index}`} />
        ))}
      </div>
      <PlainDiffActions onOpenFile={onOpenFile} onRetry={onRetry} />
    </div>
  );
}

function PlainDiffHunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <section className="gyro-plain-diff-hunk">
      <header>{hunk.header}</header>
      {hunk.lines.map((line, index) => (
        <div className={`gyro-diff-line is-${line.kind}`} key={index}>
          <span className="gyro-diff-line-marker" aria-label={line.kind}>
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
          </span>
          <code>{line.text.slice(1) || " "}</code>
        </div>
      ))}
    </section>
  );
}

function PlainDiffActions({
  onOpenFile,
  onRetry,
}: {
  onOpenFile?: () => void;
  onRetry?: () => void;
}) {
  if (!onOpenFile && !onRetry) return null;
  return (
    <div className="gyro-plain-diff-actions">
      {onRetry ? (
        <button onClick={onRetry} type="button">
          Try again
        </button>
      ) : null}
      {onOpenFile ? (
        <button onClick={onOpenFile} type="button">
          Open file
        </button>
      ) : null}
    </div>
  );
}
