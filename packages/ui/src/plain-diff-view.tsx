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
  const [wrapLines, setWrapLines] = useState(true);
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
    <div className={`gyro-plain-diff${wrapLines ? " is-wrapped" : ""}`}>
      {notice ? (
        <div className="gyro-plain-diff-notice" role="status">
          {notice}
        </div>
      ) : null}
      <div className="gyro-plain-diff-toolbar">
        <span>
          {hunks.length} changed section{hunks.length === 1 ? "" : "s"}
          {pageCount > 1 ? ` · ${safePage + 1} of ${pageCount}` : ""}
        </span>
        <button
          className="gyro-review-wrap-toggle"
          aria-pressed={wrapLines}
          onClick={() => setWrapLines((value) => !value)}
          type="button"
        >
          Wrap lines
        </button>
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
  const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header);
  let oldLine = range ? Number(range[1]) : undefined;
  let newLine = range ? Number(range[2]) : undefined;
  return (
    <section className="gyro-plain-diff-hunk">
      <header>{hunk.header}</header>
      {hunk.lines.map((line, index) => {
        const marker = line.text.startsWith("\\");
        const before = !marker && line.kind !== "added" ? oldLine : undefined;
        const after = !marker && line.kind !== "removed" ? newLine : undefined;
        if (before !== undefined) oldLine = before + 1;
        if (after !== undefined) newLine = after + 1;
        return (
          <div className={`gyro-diff-line is-${line.kind}`} key={index}>
            <span
              className="gyro-review-line-number"
              aria-label={
                before === undefined ? undefined : `Old line ${before}`
              }
            >
              {before}
            </span>
            <span
              className="gyro-review-line-number"
              aria-label={after === undefined ? undefined : `New line ${after}`}
            >
              {after}
            </span>
            <span className="gyro-diff-line-marker" aria-label={line.kind}>
              {line.kind === "added"
                ? "+"
                : line.kind === "removed"
                  ? "−"
                  : " "}
            </span>
            <code>{(marker ? line.text : line.text.slice(1)) || " "}</code>
          </div>
        );
      })}
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
          Refresh diff
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
