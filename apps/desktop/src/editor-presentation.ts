import type { editor } from "monaco-editor";
// Type-only: this module also loads in Node checks and the launch film.
import type { WorkspaceEditorSettings } from "@gyro-dev/ui";

/** Shared presentation inputs update the existing editor without recreating its model. */
export function workspaceEditorOptions({
  scale,
  reduceMotion,
  minimapEnabled,
  limited,
  readOnly,
  settings,
}: {
  scale: number;
  reduceMotion: boolean;
  minimapEnabled: boolean;
  limited: boolean;
  readOnly: boolean;
  settings?: WorkspaceEditorSettings;
}): editor.IStandaloneEditorConstructionOptions {
  // Defaults mirror defaultWorkspaceEditorSettings.
  // Line height tracks the font so larger sizes do not clip descenders.
  const fontSize = (settings?.editorFontSize ?? 13.5) * scale;
  return {
    automaticLayout: true,
    bracketPairColorization: { enabled: !limited },
    readOnly,
    "semanticHighlighting.enabled": !limited,
    maxTokenizationLineLength: 20000,
    fontFamily:
      "SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace",
    fontLigatures: false,
    fontSize,
    guides: {
      bracketPairs: !limited,
      indentation: !limited,
    },
    lineHeight: Math.round(fontSize * (21 / 13.5)),
    minimap: {
      enabled: minimapEnabled && !limited,
      scale: 0.75,
    },
    overviewRulerBorder: false,
    padding: { top: 8, bottom: 12 },
    renderWhitespace: settings?.editorRenderWhitespace ?? "selection",
    rulers: settings?.editorRulers ?? [],
    scrollbar: {
      horizontalScrollbarSize: 10,
      verticalScrollbarSize: 10,
    },
    scrollBeyondLastLine: false,
    // Smooth scrolling animates every wheel tick, which lags behind the
    // trackpad in WKWebView.
    smoothScrolling: false,
    cursorBlinking: reduceMotion ? ("solid" as const) : ("blink" as const),
    stickyScroll: { enabled: !limited, maxLineCount: 3 },
    tabSize: settings?.editorTabSize ?? 2,
    insertSpaces: settings?.editorInsertSpaces ?? true,
    wordWrap: settings?.editorWordWrap ?? "off",
  };
}
