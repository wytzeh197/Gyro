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
    "editor.background": "#101010",
    "editor.foreground": "#D7D9DE",
    "editorGutter.background": "#101010",
    "editor.lineHighlightBackground": "#181818",
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
    "minimap.background": "#101010",
    "scrollbarSlider.background": "#5A5F694D",
    "scrollbarSlider.hoverBackground": "#70768066",
    "scrollbarSlider.activeBackground": "#878D9980",
  },
});

export default Editor;
