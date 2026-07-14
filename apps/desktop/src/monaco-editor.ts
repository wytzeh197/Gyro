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

export function disposeMonacoModel(path: string) {
  monaco.editor.getModel(monaco.Uri.parse(path))?.dispose();
}

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
    "editor.background": "#1E1F22",
    "editor.foreground": "#D7D9DE",
    "editorGutter.background": "#1E1F22",
    "editor.lineHighlightBackground": "#25262A",
    "editorLineNumber.foreground": "#626872",
    "editorLineNumber.activeForeground": "#C2C5CB",
    "editorCursor.foreground": "#E9EDF2",
    "editor.selectionBackground": "#294A73",
    "editor.inactiveSelectionBackground": "#26394F",
    "editorIndentGuide.background1": "#2C2E33",
    "editorIndentGuide.activeBackground1": "#4A4E57",
    "editorWidget.background": "#25272B",
    "editorWidget.border": "#3A3D43",
    "editorSuggestWidget.background": "#25272B",
    "editorSuggestWidget.border": "#3A3D43",
    "editorSuggestWidget.selectedBackground": "#343941",
    "editorHoverWidget.background": "#25272B",
    "editorHoverWidget.border": "#3A3D43",
    "minimap.background": "#1E1F22",
    "scrollbarSlider.background": "#5A5F694D",
    "scrollbarSlider.hoverBackground": "#70768066",
    "scrollbarSlider.activeBackground": "#878D9980",
  },
});

export default Editor;
