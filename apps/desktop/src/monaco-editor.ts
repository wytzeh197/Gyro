import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TypeScriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

type MonacoWorkerEnvironment = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_moduleId: string, label: string) => Worker;
  };
};

(globalThis as MonacoWorkerEnvironment).MonacoEnvironment = {
  getWorker: (_moduleId, label) => {
    if (label === "json") {
      return new JsonWorker();
    }
    if (label === "css" || label === "scss" || label === "less") {
      return new CssWorker();
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new HtmlWorker();
    }
    if (label === "typescript" || label === "javascript") {
      return new TypeScriptWorker();
    }
    return new EditorWorker();
  },
};

loader.config({ monaco });

monaco.editor.defineTheme("gyro-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "667180" },
    { token: "string", foreground: "A8D1A0" },
    { token: "number", foreground: "C9A6E8" },
    { token: "keyword", foreground: "86AEF7" },
  ],
  colors: {
    "editor.background": "#030405",
    "editor.foreground": "#D7DEE8",
    "editorGutter.background": "#030405",
    "editor.lineHighlightBackground": "#080B0F",
    "editorLineNumber.foreground": "#4F5966",
    "editorLineNumber.activeForeground": "#AAB4C0",
    "editorCursor.foreground": "#E9EDF2",
    "editor.selectionBackground": "#1D3048",
    "editor.inactiveSelectionBackground": "#152235",
    "editorWidget.background": "#101318",
    "editorWidget.border": "#222831",
    "editorSuggestWidget.background": "#101318",
    "editorSuggestWidget.border": "#222831",
    "editorSuggestWidget.selectedBackground": "#1B2735",
    "editorHoverWidget.background": "#101318",
    "editorHoverWidget.border": "#222831",
    "minimap.background": "#030405",
    "scrollbarSlider.background": "#30384466",
    "scrollbarSlider.hoverBackground": "#3D475580",
    "scrollbarSlider.activeBackground": "#4B576699",
  },
});

export default Editor;
