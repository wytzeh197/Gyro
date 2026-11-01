import { FileDiff, Files, GitPullRequest } from "lucide-react";
import "./review-design.css";
import { useEffect, useId, useMemo, useState } from "react";
import { ReviewFileNavigator } from "./review-file-navigator";
import { PlainDiffView } from "./plain-diff-view.tsx";
import { totalFileChangeCounts } from "./file-change-counts.ts";
import { FileChangeCountBadges } from "./file-change-counts-view.tsx";
import {
  filesForReviewScope,
  reviewComparisonForScope,
  reviewScopeEmptyCopy,
  reviewScopeTitle,
  type ReviewFile,
  type ReviewScope,
} from "./review-scope.ts";
import type { SourceControlState } from "./types.ts";
import { workspaceRelativeFilePath } from "./workspace-project.ts";

export type ComparisonDiffResult = {
  original: string;
  modified: string;
  unified?: string;
  notice?: string;
};

export function GitComparisonReview({
  scope,
  sourceControl,
  turnFiles,
  workspacePath,
  onLoadDiff,
  onOpenFile,
}: {
  scope: ReviewScope;
  sourceControl?: SourceControlState;
  turnFiles?: Array<{
    path: string;
    additions?: number;
    deletions?: number;
    patches?: string[];
  }>;
  workspacePath?: string;
  onLoadDiff?: (
    file: ReviewFile,
    comparison: "working-tree" | "index" | "branch",
  ) => Promise<ComparisonDiffResult>;
  onOpenFile?: (path: string) => void;
}) {
  const listing = useMemo(
    () => filesForReviewScope(scope, { sourceControl, turnFiles }),
    [scope, sourceControl, turnFiles],
  );
  const [selectedPath, setSelectedPath] = useState<string>();
  const [showFiles, setShowFiles] = useState(true);
  const fileListId = useId();
  const selected =
    listing.files.find((file) => file.path === selectedPath) ??
    listing.files[0];
  useEffect(() => {
    if (
      selectedPath &&
      listing.files.some((file) => file.path === selectedPath)
    ) {
      return;
    }
    setSelectedPath(listing.files[0]?.path);
  }, [listing.files, selectedPath]);
  const totals = totalFileChangeCounts(listing.files);
  const empty = reviewScopeEmptyCopy(scope);
  const hasFiles = listing.files.length > 0;

  return (
    <div
      className={[
        "gyro-comparison-review",
        "gyro-git-comparison-review",
        hasFiles ? "" : "is-empty",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header className="gyro-review-scope" aria-label="Comparison scope">
        <strong>{reviewScopeTitle(scope)}</strong>
        {hasFiles ? (
          <span>
            <FileChangeCountBadges counts={totals} />
            {" · "}
            {listing.files.length}{" "}
            {listing.files.length === 1 ? "file" : "files"}
          </span>
        ) : null}
        {hasFiles ? (
          <button
            className="gyro-review-files-toggle"
            type="button"
            aria-controls={fileListId}
            aria-expanded={showFiles}
            onClick={() => setShowFiles((current) => !current)}
            title={showFiles ? "Hide changed files" : "Show changed files"}
          >
            <Files size={14} aria-hidden="true" />
            Files
          </button>
        ) : null}
      </header>
      <div className="gyro-review-workspace">
        {hasFiles ? (
          <div
            id={fileListId}
            hidden={!showFiles}
            className={
              showFiles
                ? "gyro-review-files-slot"
                : "gyro-review-files-slot is-hidden"
            }
          >
            <ReviewFileNavigator
              files={listing.files}
              selectedPath={selected?.path}
              workspacePath={workspacePath}
              onSelect={setSelectedPath}
            />
          </div>
        ) : null}
        <section className="gyro-comparison-main" aria-label="Diff review">
          {selected ? (
            <ScopedDiffPane
              key={`${scope.kind}:${scope.kind === "turn" ? scope.turnId : ""}:${selected.path}`}
              historical={scope.kind === "turn"}
              comparison={reviewComparisonForScope(scope, selected)}
              file={selected}
              onLoadDiff={onLoadDiff}
              onOpenFile={onOpenFile}
              workspacePath={workspacePath}
            />
          ) : (
            <div className="gyro-diff-empty-state">
              <GitPullRequest size={18} />
              <strong>{empty.title}</strong>
              <span>{listing.limitation ?? empty.detail}</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ScopedDiffPane({
  historical,
  ...props
}: Parameters<typeof ComparisonDiffPane>[0] & { historical: boolean }) {
  const [showCurrent, setShowCurrent] = useState(false);
  const patches = props.file.patches ?? [];
  const [recordedEdit, setRecordedEdit] = useState<number>();
  const selectedEdit = Math.max(
    0,
    Math.min(recordedEdit ?? patches.length - 1, patches.length - 1),
  );
  if (!historical) return <ComparisonDiffPane {...props} />;
  return (
    <div className="gyro-comparison-diff-pane gyro-recorded-diff-pane">
      <div className="gyro-diff-review-toolbar">
        <strong>
          {showCurrent
            ? "Current working tree comparison"
            : "Recorded changes from this turn"}
        </strong>
        <div className="gyro-recorded-diff-controls">
          {!showCurrent && patches.length > 1 ? (
            <select
              aria-label="Recorded edit"
              value={selectedEdit}
              onChange={(event) => {
                const edit = Number(event.target.value);
                setRecordedEdit(edit === patches.length - 1 ? undefined : edit);
              }}
            >
              {patches.map((_, index) => (
                <option key={index} value={index}>
                  Edit {index + 1} of {patches.length}
                  {index === patches.length - 1 ? " · Latest" : ""}
                </option>
              ))}
            </select>
          ) : null}
          <button type="button" onClick={() => setShowCurrent(!showCurrent)}>
            {showCurrent ? "Back to recorded turn" : "Compare current file"}
          </button>
        </div>
      </div>
      {showCurrent ? (
        <ComparisonDiffPane {...props} />
      ) : patches.length ? (
        <PlainDiffView
          key={selectedEdit}
          diff={patches[selectedEdit]!}
          notice={`Recorded edit ${selectedEdit + 1} of ${patches.length}`}
        />
      ) : (
        <div className="gyro-diff-empty-state">
          <strong>Historical diff unavailable</strong>
          <span>
            This turn recorded the file and its counts, but no patch was saved.
            The current working tree may have changed since then.
          </span>
          {props.onOpenFile ? (
            <button
              className="gyro-secondary-button"
              type="button"
              onClick={() => props.onOpenFile?.(props.file.path)}
            >
              Open current file
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ComparisonDiffPane({
  comparison,
  file,
  onLoadDiff,
  onOpenFile,
  workspacePath,
}: {
  comparison: "working-tree" | "index" | "branch";
  file: ReviewFile;
  onLoadDiff?: (
    file: ReviewFile,
    comparison: "working-tree" | "index" | "branch",
  ) => Promise<ComparisonDiffResult>;
  onOpenFile?: (path: string) => void;
  workspacePath?: string;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; result: ComparisonDiffResult }
    | { kind: "failed"; message: string }
  >({ kind: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!onLoadDiff) {
      setState({
        kind: "failed",
        message: "This comparison cannot be loaded in the current session.",
      });
      return;
    }
    setState({ kind: "loading" });
    void onLoadDiff(file, comparison)
      .then((result) => {
        if (!cancelled) setState({ kind: "ready", result });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: "failed",
            message: String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    comparison,
    file.path,
    file.originalPath,
    file.staged,
    onLoadDiff,
    reload,
  ]);

  const relative = workspaceRelativeFilePath(file.path, workspacePath);
  const scopeLabel =
    comparison === "branch"
      ? "main ↔ Working Tree"
      : comparison === "index"
        ? "HEAD ↔ Index"
        : "Index ↔ Working Tree";

  return (
    <div className="gyro-comparison-diff-pane">
      <div className="gyro-diff-review-toolbar">
        <div>
          <strong title={file.path}>{relative.split("/").at(-1)}</strong>
          <span title={file.path}>{relative}</span>
        </div>
        <div className="gyro-review-file-meta">
          <FileChangeCountBadges counts={file} />
          <span>{scopeLabel}</span>
        </div>
      </div>
      {state.kind === "loading" ? (
        <div className="gyro-diff-empty-state" role="status">
          <FileDiff size={18} />
          <strong>Loading changes…</strong>
          <span>
            Reading {relative} for {scopeLabel}.
          </span>
        </div>
      ) : state.kind === "failed" ? (
        <div className="gyro-diff-empty-state" role="alert">
          <FileDiff size={18} />
          <strong>Could not load this diff</strong>
          <span>{state.message}</span>
          <div className="gyro-plain-diff-actions">
            <button
              className="gyro-secondary-button"
              onClick={() => setReload((value) => value + 1)}
              type="button"
            >
              Try again
            </button>
            {onOpenFile ? (
              <button
                className="gyro-secondary-button"
                onClick={() => onOpenFile(file.path)}
                type="button"
              >
                Open file
              </button>
            ) : null}
          </div>
        </div>
      ) : state.result.notice && !state.result.unified ? (
        <div className="gyro-diff-empty-state" role="status">
          <FileDiff size={18} />
          <strong>Preview unavailable</strong>
          <span>{state.result.notice}</span>
          <div className="gyro-plain-diff-actions">
            <button
              className="gyro-secondary-button"
              onClick={() => setReload((value) => value + 1)}
              type="button"
            >
              Try again
            </button>
            {onOpenFile ? (
              <button
                className="gyro-secondary-button"
                onClick={() => onOpenFile(file.path)}
                type="button"
              >
                Open file
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <PlainDiffView
          diff={
            state.result.unified?.trim() ||
            syntheticUnified(
              file.path,
              state.result.original,
              state.result.modified,
            )
          }
          notice={
            state.result.notice ||
            (state.result.unified
              ? undefined
              : "Showing a text comparison of this file.")
          }
          onOpenFile={onOpenFile ? () => onOpenFile(file.path) : undefined}
          onRetry={() => setReload((value) => value + 1)}
        />
      )}
    </div>
  );
}

export function syntheticUnified(
  path: string,
  original: string,
  modified: string,
) {
  if (original === modified) return "";
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${Math.max(originalLines.length, 1)} +1,${Math.max(modifiedLines.length, 1)} @@`,
    ...originalLines.map((line) => `-${line}`),
    ...modifiedLines.map((line) => `+${line}`),
  ];
  return lines.join("\n");
}
