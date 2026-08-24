import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TypeScriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import {
  conf as rustConfiguration,
  language as rustLanguage,
} from "monaco-editor/esm/vs/basic-languages/rust/rust.js";

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

// TSX files are opened under the `typescript` language id. Without JSX in the
// compiler options the tokenizer treats tags as comparisons and the file loses
// most of its colouring.
const typescriptDefaults = monaco.languages.typescript.typescriptDefaults;
typescriptDefaults.setCompilerOptions({
  ...typescriptDefaults.getCompilerOptions(),
  allowJs: true,
  allowNonTsExtensions: true,
  jsx: monaco.languages.typescript.JsxEmit.React,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  target: monaco.languages.typescript.ScriptTarget.ESNext,
});
// Completion, hover, definition, references, and rename all come from the real
// LSP. The bundled TypeScript worker only has the single open file, so its
// semantic pass is both wrong and the dominant cost on large buffers.
typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
  noSuggestionDiagnostics: true,
});
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
  noSuggestionDiagnostics: true,
});

const GYRO_RUST_LANGUAGE_ID = "gyro-rust";

monaco.languages.register({
  id: GYRO_RUST_LANGUAGE_ID,
  aliases: ["Rust", "rust"],
  extensions: [".rs"],
});
monaco.languages.setLanguageConfiguration(
  GYRO_RUST_LANGUAGE_ID,
  rustConfiguration,
);

const rustTokenizer = rustLanguage.tokenizer as Record<string, unknown>;
const rustRoot = Array.isArray(rustTokenizer.root) ? rustTokenizer.root : [];

monaco.languages.setMonarchTokensProvider(GYRO_RUST_LANGUAGE_ID, {
  ...rustLanguage,
  tokenizer: {
    ...rustTokenizer,
    root: [
      [/\b[A-Z][A-Z0-9_]{2,}\b/, "constant"],
      [/\b[A-Z][a-zA-Z0-9_]*\b/, "type.identifier"],
      [/\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*!)/, "function.macro"],
      [/\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/, "function"],
      [/\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*::)/, "namespace"],
      [/'[a-zA-Z_][a-zA-Z0-9_]*/, "type.lifetime"],
      ...rustRoot,
    ],
  },
});

export function disposeMonacoModel(path: string) {
  monaco.editor.getModel(monaco.Uri.parse(path))?.dispose();
}

// @monaco-editor/react creates the editor inside a `display: none` container
// and only unhides it once mount finishes, so the first font measurement reads
// back zero. Every view line then lands at the same offset. Re-measure once the
// container is visible and once more when font loading settles.
export function remeasureMonacoFonts() {
  monaco.editor.remeasureFonts();
  void document.fonts?.ready.then(() => monaco.editor.remeasureFonts());
}

monaco.editor.defineTheme("gyro-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6A737D", fontStyle: "italic" },
    { token: "string", foreground: "A5D6FF" },
    { token: "string.escape", foreground: "79C0FF" },
    { token: "number", foreground: "9ECE6A" },
    { token: "keyword", foreground: "FF7B72" },
    { token: "keyword.type", foreground: "2DD4BF" },
    { token: "type.identifier", foreground: "2DD4BF" },
    { token: "type.lifetime", foreground: "FF9E64" },
    { token: "namespace", foreground: "2DD4BF" },
    { token: "function", foreground: "C7A0FF" },
    { token: "function.macro", foreground: "C7A0FF" },
    { token: "constant", foreground: "79C0FF" },
    { token: "operator", foreground: "E6EDF3" },
  ],
  colors: {
    "editor.background": "#0C0C0C",
    "editor.foreground": "#D7D9DE",
    "editorGutter.background": "#0C0C0C",
    "editor.lineHighlightBackground": "#161616",
    "editorLineNumber.foreground": "#626872",
    "editorLineNumber.activeForeground": "#C2C5CB",
    "editorCursor.foreground": "#E9EDF2",
    "editor.selectionBackground": "#294A73",
    "editor.inactiveSelectionBackground": "#26394F",
    "editorIndentGuide.background1": "#262626",
    "editorIndentGuide.activeBackground1": "#444444",
    "editorWidget.background": "#1B1B1B",
    "editorWidget.border": "#303030",
    "editorSuggestWidget.background": "#1B1B1B",
    "editorSuggestWidget.border": "#303030",
    "editorSuggestWidget.selectedBackground": "#2A2A2A",
    "editorHoverWidget.background": "#1B1B1B",
    "editorHoverWidget.border": "#303030",
    "minimap.background": "#0C0C0C",
    "scrollbarSlider.background": "#5A5F694D",
    "scrollbarSlider.hoverBackground": "#70768066",
    "scrollbarSlider.activeBackground": "#878D9980",
  },
});

monaco.editor.defineTheme("gyro-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6B7380", fontStyle: "italic" },
    { token: "string", foreground: "0B6E99" },
    { token: "string.escape", foreground: "1F66D1" },
    { token: "number", foreground: "2B7A4B" },
    { token: "keyword", foreground: "B42318" },
    { token: "keyword.type", foreground: "0F766E" },
    { token: "type.identifier", foreground: "0F766E" },
    { token: "type.lifetime", foreground: "C2410C" },
    { token: "namespace", foreground: "0F766E" },
    { token: "function", foreground: "6D28D9" },
    { token: "function.macro", foreground: "6D28D9" },
    { token: "constant", foreground: "1F66D1" },
    { token: "operator", foreground: "24272D" },
  ],
  colors: {
    "editor.background": "#F6F8FA",
    "editor.foreground": "#24272D",
    "editorGutter.background": "#F6F8FA",
    "editor.lineHighlightBackground": "#EEF1F5",
    "editorLineNumber.foreground": "#7A8490",
    "editorLineNumber.activeForeground": "#3F4650",
    "editorCursor.foreground": "#161B23",
    "editor.selectionBackground": "#C9DBF7",
    "editor.inactiveSelectionBackground": "#DCE6F2",
    "editorIndentGuide.background1": "#DBE1E8",
    "editorIndentGuide.activeBackground1": "#9EABB9",
    "editorWidget.background": "#FFFFFF",
    "editorWidget.border": "#C7D0DA",
    "editorSuggestWidget.background": "#FFFFFF",
    "editorSuggestWidget.border": "#C7D0DA",
    "editorSuggestWidget.selectedBackground": "#E8EDF3",
    "editorHoverWidget.background": "#FFFFFF",
    "editorHoverWidget.border": "#C7D0DA",
    "minimap.background": "#F6F8FA",
    "scrollbarSlider.background": "#9EABB94D",
    "scrollbarSlider.hoverBackground": "#7A849066",
    "scrollbarSlider.activeBackground": "#4E5A6880",
  },
});

export default Editor;
