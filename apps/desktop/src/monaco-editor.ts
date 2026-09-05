import { createMonacoTheme } from "./editor/monaco-theme";
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

for (const mode of ["dark", "light"] as const)
  monaco.editor.defineTheme(`gyro-${mode}`, createMonacoTheme(mode));

export default Editor;

export { DiffEditor } from "@monaco-editor/react";

export { loadSyntax } from "./editor/monaco-syntax";
