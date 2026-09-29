import { useAppearance } from "@gyro-dev/ui";
import { useSyntax } from "./editor/use-syntax";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  PlainDiffView,
  ScmReviewToolbar,
  shouldUsePlainDiff,
} from "@gyro-dev/ui";
import type { DiffOnMount } from "@monaco-editor/react";
import type { EditorTab } from "@gyro-dev/ui";
import { DiffEditor, remeasureMonacoFonts } from "./monaco-editor";

type Review = NonNullable<EditorTab["sourceControlDiff"]>;
type Content = {
  original: string;
  modified: string;
  notice?: string;
  unified?: string;
};

function SourceControlDiffEditor({
  review,
  refreshKey,
  languageOverride,
  onDetectedLanguage,
  theme,
  onOpenFile: onOpenFileProp,
}: {
  review: Review;
  refreshKey?: string;
  languageOverride?: string;
  onDetectedLanguage?: (id: string) => void;
  theme: "light" | "dark";
  onOpenFile: () => void;
}) {
  const { scale } = useAppearance();
  const [content, setContent] = useState<Content>();
  const [forcePlain, setForcePlain] = useState(false);
  const syntax = useSyntax(
    review.path,
    content?.modified || content?.original || "",
    languageOverride,
    Math.max(content?.original.length ?? 0, content?.modified.length ?? 0),
  );
  // Callbacks arrive as fresh closures on every App render; the component is
  // memoised on everything else, so read them through refs.
  const onDetectedLanguageRef = useRef(onDetectedLanguage);
  const onOpenFileRef = useRef(onOpenFileProp);
  onDetectedLanguageRef.current = onDetectedLanguage;
  onOpenFileRef.current = onOpenFileProp;
  const onOpenFile = useCallback(() => onOpenFileRef.current(), []);
  useEffect(() => {
    onDetectedLanguageRef.current?.(syntax.definition.id);
  }, [syntax.definition.id]);
  // DiffEditor calls updateOptions whenever this object changes identity, so
  // an inline literal re-configured both editors on every render.
  const limited = syntax.policy.limited;
  const diffOptions = useMemo(
    () => ({
      automaticLayout: true,
      bracketPairColorization: { enabled: !limited },
      guides: { bracketPairs: !limited, indentation: !limited },
      maxComputationTime: 3000,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 560,
      ignoreTrimWhitespace: false,
      fontFamily:
        "SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace",
      fontSize: 13 * scale,
      lineHeight: Math.round(20 * scale),
      // Smooth scrolling animates every wheel tick, which lags behind the
      // trackpad in WKWebView.
      smoothScrolling: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 8, bottom: 12 },
      renderOverviewRuler: true,
      diffWordWrap: "off" as const,
    }),
    [limited, scale],
  );
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [changeCount, setChangeCount] = useState(0);
  const editorRef = useRef<Parameters<DiffOnMount>[0]>();
  const subscriptionRef = useRef<{ dispose(): void }>();

  // Source control re-checks in the background and bumps `refreshKey` each
  // time. Tearing the editor down for every check blanked the diff, reset the
  // scroll, and remounted Monaco. Only a different comparison shows a loading
  // state; a refresh of the same one swaps content in place, and only when it
  // actually changed.
  const identity = [
    review.workspacePath,
    review.path,
    review.originalPath,
    review.staged,
    review.comparison,
  ].join("\u0000");
  const loadedIdentity = useRef<string>();
  useEffect(() => {
    let cancelled = false;
    const background = loadedIdentity.current === identity;
    if (!background) {
      setLoading(true);
      setError("");
      setForcePlain(false);
      setChangeCount(0);
    }
    void invoke<Content>("git_review_content", { request: review })
      .then((result) => {
        if (cancelled) return;
        loadedIdentity.current = identity;
        setError("");
        setContent((current) =>
          current &&
          current.original === result.original &&
          current.modified === result.modified &&
          current.unified === result.unified &&
          current.notice === result.notice
            ? current
            : result,
        );
      })
      .catch((error: unknown) => {
        if (!cancelled && !background) {
          setError(String(error));
          setContent(undefined);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [identity, refreshKey, reload]);

  useEffect(() => () => subscriptionRef.current?.dispose(), []);

  const move = (forward: boolean) => {
    const editor = editorRef.current;
    const changes = editor?.getLineChanges();
    if (!editor || !changes?.length) return;
    const pane = editor.getModifiedEditor();
    const current = pane.getPosition()?.lineNumber ?? 0;
    const lines = changes.map((change) =>
      Math.max(1, change.modifiedStartLineNumber),
    );
    const target = forward
      ? (lines.find((line) => line > current) ?? lines[0])
      : ([...lines].reverse().find((line) => line < current) ??
        lines[lines.length - 1]);
    if (target === undefined) return;
    pane.setPosition({ lineNumber: target, column: 1 });
    pane.revealLineInCenter(target);
    pane.focus();
  };

  const comparison = review.comparison;
  const unavailable = error || (content?.notice && !content.unified);
  const usePlain =
    !loading &&
    !unavailable &&
    !!content &&
    (forcePlain ||
      (!content.original && !content.modified && !!content.unified) ||
      shouldUsePlainDiff(content.original, content.modified) ||
      syntax.policy.limited);
  const empty =
    !loading &&
    !unavailable &&
    !!content &&
    !content.unified &&
    content.original === content.modified;
  const summary = loading
    ? "Loading changes…"
    : unavailable
      ? "Preview unavailable"
      : empty
        ? "No text changes"
        : usePlain
          ? "Text diff"
          : `${changeCount} change${changeCount === 1 ? "" : "s"}`;

  return (
    <div
      className="gyro-source-control-review"
      aria-label={`Review ${review.path}`}
    >
      <ScmReviewToolbar
        staged={review.staged}
        comparison={comparison}
        summary={summary}
        canNavigate={!!changeCount && !loading && !unavailable && !usePlain}
        onPrevious={() => move(false)}
        onNext={() => move(true)}
        onRefresh={() => setReload((value) => value + 1)}
        onOpenFile={onOpenFile}
      />
      {syntax.notice && !usePlain ? (
        <div className="gyro-syntax-notice" role="status">
          {syntax.notice}
        </div>
      ) : null}
      {loading ? (
        <div className="gyro-empty-state gyro-code-empty" role="status">
          Loading changes…
        </div>
      ) : unavailable ? (
        <div className="gyro-empty-state gyro-code-empty" role="alert">
          <strong>Could not display this diff</strong>
          <span>{error || content?.notice}</span>
          <div className="gyro-plain-diff-actions">
            <button
              onClick={() => setReload((value) => value + 1)}
              type="button"
            >
              Try again
            </button>
            <button onClick={onOpenFile} type="button">
              Open file
            </button>
          </div>
        </div>
      ) : empty ? (
        <div className="gyro-empty-state gyro-code-empty" role="status">
          <strong>No text changes in this comparison</strong>
          <span>
            The file is present on both sides with identical contents.
          </span>
        </div>
      ) : usePlain && content ? (
        <PlainDiffView
          diff={
            content.unified?.trim() ||
            [
              `--- a/${review.path}`,
              `+++ b/${review.path}`,
              `@@`,
              ...content.original.split("\n").map((line) => `-${line}`),
              ...content.modified.split("\n").map((line) => `+${line}`),
            ].join("\n")
          }
          notice={
            content.notice ||
            (syntax.notice
              ? `${syntax.notice} Showing a text diff instead.`
              : "Showing a text diff because the rich editor cannot render this file reliably.")
          }
          onOpenFile={onOpenFile}
          onRetry={() => {
            setForcePlain(false);
            setReload((value) => value + 1);
          }}
        />
      ) : content && syntax.ready ? (
        <div className="gyro-source-control-review-editor">
          <DiffEditor
            original={content.original}
            modified={content.modified}
            language={syntax.language}
            theme={theme === "light" ? "gyro-light" : "gyro-dark"}
            onMount={(editor) => {
              editorRef.current = editor;
              for (const pane of [
                editor.getOriginalEditor(),
                editor.getModifiedEditor(),
              ])
                pane.updateOptions({
                  "semanticHighlighting.enabled": false,
                  maxTokenizationLineLength: 20000,
                });
              subscriptionRef.current?.dispose();
              let firstDiff = true;
              let settled = false;
              subscriptionRef.current = editor.onDidUpdateDiff(() => {
                const changes = editor.getLineChanges() ?? [];
                setChangeCount(changes.length);
                settled = true;
                if (firstDiff && changes.length) {
                  firstDiff = false;
                  const line = Math.max(1, changes[0]!.modifiedStartLineNumber);
                  editor
                    .getModifiedEditor()
                    .setPosition({ lineNumber: line, column: 1 });
                  editor.getModifiedEditor().revealLineInCenter(line);
                }
              });
              window.setTimeout(() => {
                if (
                  !settled &&
                  (content.unified || content.original !== content.modified)
                ) {
                  setForcePlain(true);
                }
              }, 4000);
              requestAnimationFrame(remeasureMonacoFonts);
            }}
            options={diffOptions}
          />
        </div>
      ) : (
        <div className="gyro-empty-state gyro-code-empty" role="status">
          Loading changes…
        </div>
      )}
    </div>
  );
}

export default memo(
  SourceControlDiffEditor,
  (previous, next) =>
    previous.review === next.review &&
    previous.refreshKey === next.refreshKey &&
    previous.languageOverride === next.languageOverride &&
    previous.theme === next.theme,
);
