import { FileDiff, Files, GitPullRequest, ShieldCheck } from "lucide-react";
import "./review-design.css";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  initialFilePath,
  sourceControl,
  turnFiles,
  workspacePath,
  onCheckWork,
  onLoadDiff,
  onOpenFile,
}: {
  scope: ReviewScope;
  initialFilePath?: string;
  sourceControl?: SourceControlState;
  turnFiles?: Array<{
    path: string;
    additions?: number;
    deletions?: number;
    patches?: string[];
  }>;
  workspacePath?: string;
  onCheckWork?: () => void;
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
  const [selectedPath, setSelectedPath] = useState(initialFilePath);
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(true);
  const [filesChoice, setFilesChoice] = useState<boolean | undefined>(() => {
    try {
      const saved = localStorage.getItem("gyro.review.show-files");
      return saved === "true" ? true : saved === "false" ? false : undefined;
    } catch {
      return undefined;
    }
  });
  const showFiles = filesChoice ?? !compact;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const width = root.getBoundingClientRect().width;
      if (width > 0) setCompact(width < 560);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
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
      ref={rootRef}
      className={[
        "gyro-comparison-review",
        "gyro-git-comparison-review",
        hasFiles ? "" : "is-empty",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header
        className={`gyro-review-scope${onCheckWork ? " has-check-action" : ""}`}
        aria-label="Comparison scope"
      >
        <div className="gyro-review-identity">
          <strong title={selected?.path}>
            {selected
              ? workspaceRelativeFilePath(selected.path, workspacePath)
              : reviewScopeTitle(scope)}
          </strong>
          {hasFiles ? (
            <span className="gyro-review-scope-meta">
              <span>{reviewScopeTitle(scope)}</span>
              <span>
                · {listing.files.length}{" "}
                {listing.files.length === 1 ? "file" : "files"}
              </span>
              <FileChangeCountBadges counts={totals} showUnknown={false} />
            </span>
          ) : null}
        </div>
        {hasFiles ? (
          <span className="gyro-review-scope-actions">
            {onCheckWork ? (
              <button
                className="gyro-review-scope-button"
                type="button"
                onClick={onCheckWork}
              >
                <ShieldCheck size={14} aria-hidden="true" />
                Check this work
              </button>
            ) : null}
            <button
              className="gyro-review-scope-button gyro-review-files-toggle"
              type="button"
              aria-controls={fileListId}
              aria-expanded={showFiles}
              onClick={() => {
                const next = !showFiles;
                setFilesChoice(next);
                try {
                  localStorage.setItem("gyro.review.show-files", String(next));
                } catch {
                  // Keep the in-memory choice when storage is unavailable.
                }
              }}
              title={showFiles ? "Hide changed files" : "Show changed files"}
            >
              <Files size={14} aria-hidden="true" />
              Files
            </button>
          </span>
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
  const editPicker =
    patches.length > 1 ? (
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
    ) : null;
  const compareButton = props.onLoadDiff ? (
    <button
      type="button"
      onClick={() => setShowCurrent((current) => !current)}
    >
      {showCurrent ? "Back to recorded turn" : "Compare working tree"}
    </button>
  ) : null;
  const controls = (editPicker || compareButton) && (
    <span className="gyro-recorded-diff-controls">
      {editPicker}
      {compareButton}
    </span>
  );
  if (showCurrent) {
    return (
      <ComparisonDiffPane
        {...props}
        toolbarAction={
          <span className="gyro-recorded-diff-controls">{compareButton}</span>
        }
      />
    );
  }
  return (
    <div className="gyro-comparison-diff-pane">
      {patches.length ? (
        <PlainDiffView
          key={selectedEdit}
          actions={controls}
          diff={patches[selectedEdit]!}
          lead="Recorded turn"
        />
      ) : (
        <div className="gyro-diff-empty-state" role="status">
          <FileDiff size={18} aria-hidden="true" />
          <strong>No patch was saved for this turn</strong>
          <span>
            The current working tree may have changed since then.
          </span>
          <div className="gyro-plain-diff-actions gyro-review-recovery-actions">
            {props.onOpenFile ? (
              <button
                className="gyro-secondary-button"
                type="button"
                onClick={() => props.onOpenFile?.(props.file.path)}
              >
                Open current file
              </button>
            ) : null}
            {compareButton}
          </div>
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
  toolbarAction,
  workspacePath,
}: {
  comparison: "working-tree" | "index" | "branch";
  file: ReviewFile;
  onLoadDiff?: (
    file: ReviewFile,
    comparison: "working-tree" | "index" | "branch",
  ) => Promise<ComparisonDiffResult>;
  onOpenFile?: (path: string) => void;
  toolbarAction?: ReactNode;
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
  const previewUnavailable =
    state.kind === "ready" && state.result.notice && !state.result.unified;

  return (
    <div className="gyro-comparison-diff-pane">
      {state.kind !== "ready" || previewUnavailable ? (
        <div className="gyro-diff-review-toolbar">
          <strong>{scopeLabel}</strong>
          {toolbarAction}
        </div>
      ) : null}
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
      ) : previewUnavailable ? (
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
          actions={toolbarAction}
          lead={scopeLabel}
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
