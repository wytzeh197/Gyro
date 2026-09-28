import type { editor } from "monaco-editor";

/** Shared presentation inputs update the existing editor without recreating its model. */
export function workspaceEditorOptions({
  scale,
  reduceMotion,
  minimapEnabled,
  limited,
  readOnly,
}: {
  scale: number;
  reduceMotion: boolean;
  minimapEnabled: boolean;
  limited: boolean;
  readOnly: boolean;
}): editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    bracketPairColorization: { enabled: !limited },
    readOnly,
    "semanticHighlighting.enabled": !limited,
    maxTokenizationLineLength: 20000,
    fontFamily:
      "SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace",
    fontLigatures: false,
    fontSize: 13.5 * scale,
    guides: {
      bracketPairs: !limited,
      indentation: !limited,
    },
    lineHeight: Math.round(21 * scale),
    minimap: {
      enabled: minimapEnabled && !limited,
      scale: 0.75,
    },
    overviewRulerBorder: false,
    padding: { top: 8, bottom: 12 },
    renderWhitespace: "selection" as const,
    scrollbar: {
      horizontalScrollbarSize: 10,
      verticalScrollbarSize: 10,
    },
    scrollBeyondLastLine: false,
    smoothScrolling: !reduceMotion,
    cursorBlinking: reduceMotion ? ("solid" as const) : ("blink" as const),
    stickyScroll: { enabled: !limited, maxLineCount: 3 },
    tabSize: 2,
    wordWrap: "off" as const,
  };
}
