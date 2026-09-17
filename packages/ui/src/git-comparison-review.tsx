import { FileDiff, GitPullRequest } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  turnFiles?: Array<{ path: string; additions?: number; deletions?: number }>;
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
  const selected =
    listing.files.find((file) => file.path === selectedPath) ?? listing.files[0];
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
        "gyro-diff-review",
        "is-compact",
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
      </header>
      <aside className="gyro-diff-file-list" aria-label="Changed files">
        <header>
          <strong>Changed files</strong>
        </header>
        <div className="gyro-diff-tree" role="tree">
          {!hasFiles ? (
            <div className="gyro-diff-tree-empty">
              {listing.limitation ?? empty.detail}
            </div>
          ) : (
            listing.files.map((file) => {
              const relative = workspaceRelativeFilePath(
                file.path,
                workspacePath,
              );
              const isSelected = file.path === selected?.path;
              return (
                <button
                  aria-current={isSelected ? "true" : undefined}
                  className={
                    isSelected
                      ? "gyro-diff-tree-file is-active"
                      : "gyro-diff-tree-file"
                  }
                  key={`${file.path}:${file.staged ? "index" : "work"}`}
                  onClick={() => setSelectedPath(file.path)}
                  title={file.path}
                  type="button"
                >
                  <span>{relative}</span>
                  <small>
                    <FileChangeCountBadges counts={file} />
                  </small>
                </button>
              );
            })
          )}
        </div>
      </aside>
      <section className="gyro-diff-main" aria-label="Diff review">
        {selected ? (
          <ComparisonDiffPane
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
  }, [comparison, file.path, file.originalPath, file.staged, onLoadDiff, reload]);

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
          <strong title={file.path}>{relative}</strong>
          <span>{scopeLabel}</span>
        </div>
      </div>
      {state.kind === "loading" ? (
        <div className="gyro-diff-empty-state" role="status">
          <FileDiff size={18} />
          <strong>Loading changes…</strong>
          <span>Reading {relative} for {scopeLabel}.</span>
        </div>
      ) : state.kind === "failed" ? (
        <div className="gyro-diff-empty-state" role="alert">
          <FileDiff size={18} />
          <strong>Could not load this diff</strong>
          <span>{state.message}</span>
          <div className="gyro-plain-diff-actions">
            <button onClick={() => setReload((value) => value + 1)} type="button">
              Try again
            </button>
            {onOpenFile ? (
              <button onClick={() => onOpenFile(file.path)} type="button">
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
            <button onClick={() => setReload((value) => value + 1)} type="button">
              Try again
            </button>
            {onOpenFile ? (
              <button onClick={() => onOpenFile(file.path)} type="button">
                Open file
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <PlainDiffView
          diff={
            state.result.unified?.trim() ||
            syntheticUnified(file.path, state.result.original, state.result.modified)
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
