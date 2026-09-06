import { useSyntax } from "./editor/use-syntax";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ScmReviewToolbar } from "@gyro-dev/ui";
import type { DiffOnMount } from "@monaco-editor/react";
import type { EditorTab } from "@gyro-dev/ui";
import { DiffEditor, remeasureMonacoFonts } from "./monaco-editor";

type Review = NonNullable<EditorTab["sourceControlDiff"]>;
type Content = { original: string; modified: string; notice?: string };

export default function SourceControlDiffEditor({
  review,
  refreshKey,
  languageOverride,
  onDetectedLanguage,
  theme,
  onOpenFile,
}: {
  review: Review;
  refreshKey?: string;
  languageOverride?: string;
  onDetectedLanguage?: (id: string) => void;
  theme: "light" | "dark";
  onOpenFile: () => void;
}) {
  const [content, setContent] = useState<Content>();
  const syntax = useSyntax(
    review.path,
    content?.modified || content?.original || "",
    languageOverride,
    Math.max(content?.original.length ?? 0, content?.modified.length ?? 0),
  );
  useEffect(() => {
    onDetectedLanguage?.(syntax.definition.id);
  }, [syntax.definition.id, onDetectedLanguage]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [changeCount, setChangeCount] = useState(0);
  const editorRef = useRef<Parameters<DiffOnMount>[0]>();
  const subscriptionRef = useRef<{ dispose(): void }>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void invoke<Content>("git_review_content", { request: review })
      .then((result) => {
        if (!cancelled) setContent(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
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
  }, [
    review.workspacePath,
    review.path,
    review.originalPath,
    review.staged,
    refreshKey,
    reload,
  ]);

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

  const notice = error || content?.notice;
  return (
    <div
      className="gyro-source-control-review"
      aria-label={`Review ${review.path}`}
    >
      <ScmReviewToolbar
        staged={review.staged}
        summary={
          loading
            ? "Loading changes…"
            : notice
              ? "Preview unavailable"
              : `${changeCount} change${changeCount === 1 ? "" : "s"}`
        }
        canNavigate={!!changeCount && !loading && !notice}
        onPrevious={() => move(false)}
        onNext={() => move(true)}
        onRefresh={() => setReload((value) => value + 1)}
        onOpenFile={onOpenFile}
      />
      {syntax.notice && (
        <div className="gyro-syntax-notice" role="status">
          {syntax.notice}
        </div>
      )}
      {notice ? (
        <div className="gyro-code-empty" role="status">
          {notice}
        </div>
      ) : !content ? (
        <div className="gyro-code-empty">Loading changes...</div>
      ) : (
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
            subscriptionRef.current = editor.onDidUpdateDiff(() => {
              const changes = editor.getLineChanges() ?? [];
              setChangeCount(changes.length);
              if (firstDiff && changes.length) {
                firstDiff = false;
                const line = Math.max(1, changes[0]!.modifiedStartLineNumber);
                editor
                  .getModifiedEditor()
                  .setPosition({ lineNumber: line, column: 1 });
                editor.getModifiedEditor().revealLineInCenter(line);
              }
            });
            requestAnimationFrame(remeasureMonacoFonts);
          }}
          options={{
            automaticLayout: true,
            bracketPairColorization: { enabled: !syntax.policy.limited },
            guides: {
              bracketPairs: !syntax.policy.limited,
              indentation: !syntax.policy.limited,
            },
            maxComputationTime: 3000,
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
            useInlineViewWhenSpaceIsLimited: true,
            renderSideBySideInlineBreakpoint: 560,
            ignoreTrimWhitespace: false,
            fontFamily:
              "SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace",
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            padding: { top: 8, bottom: 12 },
            renderOverviewRuler: true,
            diffWordWrap: "off",
          }}
        />
      )}
    </div>
  );
}
