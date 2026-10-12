import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useAppearance,
  type EditorBuffer,
  type EditorRevealTarget,
  type EditorSelection,
  type ResolvedTheme,
  type WorkspaceFileContent,
} from "@gyro-dev/ui";
import type { OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { workspaceEditorOptions } from "../editor-presentation";
import { decodeSemanticTokens, semanticLegend } from "./semantic-tokens";
import { useSyntax } from "./use-syntax";
import { canonicalFileUri, filePathFromUri } from "./document-uri";

const MonacoEditor = lazy(() => import("../monaco-editor"));

type EditorPosition = { lineNumber: number; column: number };
export type WorkspaceNavigationSource = EditorPosition & { path: string };
export type MonacoEditorPaneProps = {
  languageOverride?: string;
  semanticReady?: string;
  fileError?: string;
  buffer?: EditorBuffer;
  fileContent?: WorkspaceFileContent;
  loadState: "idle" | "loading" | "ready" | "error";
  minimapEnabled: boolean;
  onChange: (value: string) => void;
  onLspRequest?: (
    path: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  onOpenLocation?: (
    path: string,
    lineNumber: number,
    column: number,
    source?: WorkspaceNavigationSource,
  ) => Promise<boolean> | boolean;
  onRenameSymbol?: (
    path: string,
    position: EditorPosition,
  ) => Promise<void> | void;
  onSelectionChange: (selection?: EditorSelection) => void;
  path?: string;
  revealTarget?: EditorRevealTarget;
  theme: ResolvedTheme;
};

type LspRoute = {
  current: {
    path: string;
    language: string;
    semanticReady?: string;
    onLspRequest: NonNullable<MonacoEditorPaneProps["onLspRequest"]>;
  };
  editor: () => Monaco.editor.IStandaloneCodeEditor | null;
};

// Providers belong to a language, not a pane. All splits share one provider and
// dispatch through the model URI, so a request cannot run once for each split.
const modelRoutes = new Map<string, Set<LspRoute>>();
const languageProviders = new Map<
  string,
  { references: number; dispose: () => void; semanticChanged: () => void }
>();

function routeForModel(model: Monaco.editor.ITextModel, language: string) {
  const routes = modelRoutes.get(model.uri.toString());
  if (!routes) return undefined;
  const candidates = [...routes].filter(
    (route) => route.current.language === language,
  );
  return (
    candidates.find((route) => route.editor()?.hasTextFocus()) ??
    candidates.at(-1)
  );
}

function registerLspRoute(monaco: Parameters<OnMount>[1], route: LspRoute) {
  const uri = canonicalFileUri(route.current.path);
  const language = route.current.language;
  const routes = modelRoutes.get(uri) ?? new Set<LspRoute>();
  routes.add(route);
  modelRoutes.set(uri, routes);
  let provider = languageProviders.get(language);
  if (!provider) {
    const semanticListeners = new Set<() => void>();
    const completionRegistration =
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: [".", '"', "'", "/", "<", ":"],
        provideCompletionItems: async (model, position, context, token) => {
          const route = routeForModel(model, language);
          if (!route) return { suggestions: [] };
          const { path, onLspRequest } = route.current;
          const version = model.getVersionId();
          try {
            const result = await onLspRequest(path, "textDocument/completion", {
              position: {
                line: position.lineNumber - 1,
                character: position.column - 1,
              },
              context: {
                triggerKind: context.triggerKind,
                triggerCharacter: context.triggerCharacter,
              },
            });
            if (!requestStillCurrent(model, version, token))
              return { suggestions: [] };
            const resultRecord = isRecord(result) ? result : undefined;
            const items = Array.isArray(result)
              ? result
              : Array.isArray(resultRecord?.items)
                ? resultRecord.items
                : [];
            const word = model.getWordUntilPosition(position);
            const fallbackRange = new monaco.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn,
            );
            return {
              suggestions: items.flatMap((value) => {
                if (!isRecord(value)) {
                  return [];
                }
                const label = completionLabel(value.label);
                if (!label) {
                  return [];
                }
                const textEdit = isRecord(value.textEdit)
                  ? value.textEdit
                  : undefined;
                const rangeValue = textEdit?.range ?? value.range;
                const range =
                  monacoRangeFromLsp(monaco, rangeValue) ?? fallbackRange;
                const insertText =
                  typeof textEdit?.newText === "string"
                    ? textEdit.newText
                    : typeof value.insertText === "string"
                      ? value.insertText
                      : label;
                return [
                  {
                    label,
                    detail:
                      typeof value.detail === "string"
                        ? value.detail
                        : undefined,
                    documentation: completionDocumentation(value.documentation),
                    insertText,
                    kind: monacoCompletionKind(monaco, value.kind),
                    range,
                  },
                ];
              }),
            };
          } catch {
            return { suggestions: [] };
          }
        },
      });
    const hoverRegistration = monaco.languages.registerHoverProvider(language, {
      provideHover: async (model, position, token) => {
        const route = routeForModel(model, language);
        if (!route) return null;
        const { path, onLspRequest } = route.current;
        const version = model.getVersionId();
        try {
          const result = await onLspRequest(path, "textDocument/hover", {
            position: {
              line: position.lineNumber - 1,
              character: position.column - 1,
            },
          });
          if (
            !requestStillCurrent(model, version, token) ||
            !isRecord(result)
          ) {
            return null;
          }
          const markdown = lspMarkdown(result.contents);
          if (!markdown) {
            return null;
          }
          return {
            contents: [{ value: markdown }],
            range: monacoRangeFromLsp(monaco, result.range),
          };
        } catch {
          return null;
        }
      },
    });
    const definitionRegistration = monaco.languages.registerDefinitionProvider(
      language,
      {
        provideDefinition: async (model, position, token) => {
          const route = routeForModel(model, language);
          if (!route) return null;
          const { path, onLspRequest } = route.current;
          const version = model.getVersionId();
          try {
            const result = await onLspRequest(path, "textDocument/definition", {
              position: {
                line: position.lineNumber - 1,
                character: position.column - 1,
              },
            });
            if (!requestStillCurrent(model, version, token)) return null;
            return monacoLocationsFromLsp(monaco, result);
          } catch {
            return [];
          }
        },
      },
    );
    const referencesRegistration = monaco.languages.registerReferenceProvider(
      language,
      {
        provideReferences: async (model, position, _context, token) => {
          const route = routeForModel(model, language);
          if (!route) return null;
          const { path, onLspRequest } = route.current;
          const version = model.getVersionId();
          try {
            const result = await onLspRequest(path, "textDocument/references", {
              position: {
                line: position.lineNumber - 1,
                character: position.column - 1,
              },
              context: { includeDeclaration: true },
            });
            if (!requestStillCurrent(model, version, token)) return null;
            return monacoLocationsFromLsp(monaco, result);
          } catch {
            return [];
          }
        },
      },
    );
    const semanticRegistration =
      monaco.languages.registerDocumentSemanticTokensProvider(language, {
        getLegend: () => semanticLegend,
        onDidChange: (listener) => {
          semanticListeners.add(listener);
          return { dispose: () => semanticListeners.delete(listener) };
        },
        provideDocumentSemanticTokens: async (model, _previous, token) => {
          const route = routeForModel(model, language);
          if (
            !route ||
            !route.current.semanticReady ||
            token.isCancellationRequested
          )
            return null;
          const { path, onLspRequest } = route.current;
          const version = model.getVersionId();
          try {
            const legend = await onLspRequest(
              path,
              "$/gyro/semanticTokensLegend",
              {},
            );
            if (
              !legend ||
              token.isCancellationRequested ||
              model.isDisposed() ||
              model.getVersionId() !== version
            )
              return null;
            const response = await onLspRequest(
              path,
              "textDocument/semanticTokens/full",
              {},
            );
            if (
              token.isCancellationRequested ||
              model.isDisposed() ||
              model.getVersionId() !== version
            )
              return null;
            const data = decodeSemanticTokens(
              response,
              legend,
              model.getLinesContent().map((line) => line.length),
            );
            return data ? { data } : null;
          } catch {
            return null;
          }
        },
        releaseDocumentSemanticTokens: () => {},
      });
    const registrations = [
      completionRegistration,
      hoverRegistration,
      definitionRegistration,
      referencesRegistration,
      semanticRegistration,
    ];
    provider = {
      references: 0,
      dispose: () => {
        registrations.forEach((registration) => registration.dispose());
        semanticListeners.clear();
      },
      semanticChanged: () =>
        semanticListeners.forEach((listener) => listener()),
    };
    languageProviders.set(language, provider);
  }
  provider.references++;
  return {
    semanticChanged: provider.semanticChanged,
    dispose: () => {
      routes.delete(route);
      if (!routes.size) modelRoutes.delete(uri);
      const currentProvider = languageProviders.get(language);
      if (currentProvider && --currentProvider.references === 0) {
        currentProvider.dispose();
        languageProviders.delete(language);
      }
    },
  };
}

function MonacoEditorPaneView(props: MonacoEditorPaneProps) {
  const {
    buffer,
    fileContent,
    loadState,
    minimapEnabled,
    path,
    revealTarget,
    theme,
    languageOverride,
    fileError,
    semanticReady,
  } = props;
  const syntax = useSyntax(
    path ?? "",
    buffer?.content ?? fileContent?.content ?? "",
    languageOverride,
    buffer?.sizeBytes ?? fileContent?.sizeBytes,
    buffer?.truncated ?? fileContent?.truncated,
  );
  const modelUri = useMemo(
    () => (path ? canonicalFileUri(path) : undefined),
    [path],
  );
  const syntaxModelRef = useRef({
    uri: modelUri,
    language: syntax.language,
    ready: syntax.ready,
  });
  syntaxModelRef.current = {
    uri: modelUri,
    language: syntax.language,
    ready: syntax.ready,
  };
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const routeRef = useRef<LspRoute>();
  if (path && props.onLspRequest) {
    const current = {
      path,
      language: syntax.language,
      semanticReady,
      onLspRequest: props.onLspRequest,
    };
    if (routeRef.current) routeRef.current.current = current;
    else routeRef.current = { current, editor: () => editorRef.current };
  }
  const handleChange = useCallback(
    (value?: string) => propsRef.current.onChange(value ?? ""),
    [],
  );
  const paneRegistrations = useRef<Monaco.IDisposable[]>([]);
  const providerRegistration = useRef<ReturnType<typeof registerLspRoute>>();
  const viewStates = useRef(
    new Map<string, Monaco.editor.ICodeEditorViewState>(),
  );
  const hasMountedRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const revealEditorTarget = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor) => {
      const { revealTarget, path } = propsRef.current;
      if (
        !path ||
        !revealTarget ||
        revealTarget.path !== path ||
        editor.getModel()?.uri.toString() !== canonicalFileUri(path)
      )
        return;
      const position = {
        lineNumber: revealTarget.lineNumber,
        column: revealTarget.column,
      };
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
      editor.focus();
    },
    [],
  );
  useEffect(() => {
    if (editorRef.current) revealEditorTarget(editorRef.current);
  }, [modelUri, revealEditorTarget, revealTarget?.nonce]);
  useEffect(
    () => () => {
      paneRegistrations.current.forEach((registration) =>
        registration.dispose(),
      );
      paneRegistrations.current = [];
      editorRef.current = null;
    },
    [],
  );
  const { scale, reduceMotion } = useAppearance();
  const editorOptions = useMemo(
    () =>
      workspaceEditorOptions({
        scale,
        reduceMotion,
        minimapEnabled,
        limited: syntax.policy.limited,
        readOnly: syntax.policy.readOnly,
      }),
    [
      minimapEnabled,
      syntax.policy.limited,
      syntax.policy.readOnly,
      scale,
      reduceMotion,
    ],
  );
  useEffect(() => {
    if (
      !mounted ||
      !path ||
      !props.onLspRequest ||
      syntax.policy.limited ||
      syntax.language === "plaintext"
    )
      return;
    let disposed = false;
    void import("monaco-editor").then((monaco) => {
      if (disposed || !routeRef.current) return;
      providerRegistration.current = registerLspRoute(monaco, routeRef.current);
    });
    return () => {
      disposed = true;
      providerRegistration.current?.dispose();
      providerRegistration.current = undefined;
    };
  }, [
    mounted,
    modelUri,
    syntax.language,
    syntax.policy.limited,
    Boolean(props.onLspRequest),
  ]);
  useEffect(() => {
    providerRegistration.current?.semanticChanged();
  }, [semanticReady]);

  const synchronizeModelLanguage = useCallback(
    (
      editor: Monaco.editor.IStandaloneCodeEditor,
      monaco: Parameters<OnMount>[1],
    ) => {
      const wanted = syntaxModelRef.current;
      const model = editor.getModel();
      // Retained models may still be plain text after a failed grammar load.
      // A cached grammar can resolve before the React adapter is ready, which
      // skips its initial language update. Apply the current completed result
      // to the attached model, preserving another split's highlighting while
      // a new pane is still loading its grammar.
      if (
        wanted.ready &&
        model &&
        model.uri.toString() === wanted.uri &&
        model.getLanguageId() !== wanted.language
      )
        monaco.editor.setModelLanguage(model, wanted.language);
    },
    [],
  );
  useEffect(() => {
    if (!mounted) return;
    let disposed = false;
    void import("monaco-editor").then((monaco) => {
      if (!disposed && editorRef.current)
        synchronizeModelLanguage(editorRef.current, monaco);
    });
    return () => {
      disposed = true;
    };
  }, [
    mounted,
    modelUri,
    syntax.language,
    syntax.ready,
    synchronizeModelLanguage,
  ]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    synchronizeModelLanguage(editor, monaco);
    hasMountedRef.current = true;
    setMounted(true);
    void import("../monaco-editor").then(({ remeasureMonacoFonts }) =>
      remeasureMonacoFonts(),
    );
    // React Monaco's default cache is shared across panes; each split should
    // retain its own cursor, selection and scroll position for each file.
    paneRegistrations.current.push(
      editor.onWillChangeModel(() => {
        const model = editor.getModel(),
          state = editor.saveViewState();
        if (model && state) viewStates.current.set(model.uri.toString(), state);
      }),
      editor.onDidChangeModel(() => {
        synchronizeModelLanguage(editor, monaco);
        const uri = editor.getModel()?.uri.toString();
        const state = uri ? viewStates.current.get(uri) : undefined;
        if (state) editor.restoreViewState(state);
        revealEditorTarget(editor);
      }),
      editor.onDidChangeCursorSelection((event) => {
        const model = editor.getModel();
        const path = model ? filePathFromUri(model.uri.toString()) : undefined;
        const text = model?.getValueInRange(event.selection);
        propsRef.current.onSelectionChange(
          path && text
            ? {
                path,
                startLineNumber: event.selection.startLineNumber,
                startColumn: event.selection.startColumn,
                endLineNumber: event.selection.endLineNumber,
                endColumn: event.selection.endColumn,
                text,
              }
            : undefined,
        );
      }),
      monaco.editor.registerEditorOpener({
        openCodeEditor: async (source, resource, selectionOrPosition) => {
          if (source !== editor || !propsRef.current.onOpenLocation)
            return false;
          const path = filePathFromUri(resource.toString());
          if (!path) return false;
          const position =
            selectionOrPosition && "startLineNumber" in selectionOrPosition
              ? {
                  lineNumber: selectionOrPosition.startLineNumber,
                  column: selectionOrPosition.startColumn,
                }
              : (selectionOrPosition ?? { lineNumber: 1, column: 1 });
          const sourcePath = editor.getModel()
            ? filePathFromUri(editor.getModel()!.uri.toString())
            : undefined;
          const sourcePosition = editor.getPosition();
          try {
            const opened = await propsRef.current.onOpenLocation(
              path,
              position.lineNumber,
              position.column,
              sourcePath && sourcePosition
                ? { path: sourcePath, ...sourcePosition }
                : undefined,
            );
            if (
              !opened ||
              !(await waitForModel(editor, canonicalFileUri(path)))
            )
              return false;
            editor.setPosition(position);
            editor.revealPositionInCenter(position);
            editor.focus();
            return true;
          } catch {
            return false;
          }
        },
      }),
      editor.addAction({
        id: "gyro.workspace.renameSymbol",
        label: "Rename symbol",
        keybindings: [monaco.KeyCode.F2],
        contextMenuGroupId: "1_modification",
        contextMenuOrder: 1.1,
        precondition: "editorTextFocus && !editorReadonly",
        run: async () => {
          const model = editor.getModel(),
            position = editor.getPosition();
          const path = model
            ? filePathFromUri(model.uri.toString())
            : undefined;
          if (path && position)
            await propsRef.current.onRenameSymbol?.(path, position);
        },
      }),
    );
    revealEditorTarget(editor);
  };

  if (!path)
    return <div className="gyro-code-empty">Select a workspace file.</div>;
  if (loadState === "loading" && !hasMountedRef.current)
    return <div className="gyro-code-empty">Loading file preview...</div>;
  if (syntax.policy.binary || loadState === "error")
    return (
      <div className="gyro-code-empty" role="status">
        {syntax.policy.reason ?? fileError ?? "This file cannot be displayed."}
      </div>
    );
  return (
    <div className="gyro-syntax-editor" style={{ minWidth: 0 }}>
      {syntax.notice && (
        <div className="gyro-syntax-notice" role="status">
          {syntax.notice}
        </div>
      )}
      <Suspense
        fallback={<div className="gyro-code-empty">Loading editor...</div>}
      >
        <MonacoEditor
          height="100%"
          keepCurrentModel
          saveViewState={false}
          language={syntax.language}
          onChange={handleChange}
          onMount={handleMount}
          options={editorOptions}
          path={modelUri}
          theme={theme === "light" ? "gyro-light" : "gyro-dark"}
          value={buffer?.content ?? fileContent?.content ?? ""}
        />
      </Suspense>
    </div>
  );
}

export const MonacoEditorPane = memo(MonacoEditorPaneView);

function waitForModel(
  editor: Monaco.editor.IStandaloneCodeEditor,
  uri: string,
): Promise<boolean> {
  if (editor.getModel()?.uri.toString() === uri) return Promise.resolve(true);
  // Host state commits asynchronously. Monaco must finish opening only after
  // React has attached the target, otherwise peek/highlight acts on the source.
  return new Promise((resolve) => {
    const finish = (opened: boolean) => {
      clearTimeout(timeout);
      changed.dispose();
      disposed.dispose();
      resolve(opened);
    };
    const changed = editor.onDidChangeModel(() => {
      if (editor.getModel()?.uri.toString() === uri) finish(true);
    });
    const disposed = editor.onDidDispose(() => finish(false));
    const timeout = setTimeout(() => finish(false), 2000);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function requestStillCurrent(
  model: Monaco.editor.ITextModel,
  version: number,
  token: Monaco.CancellationToken,
) {
  return (
    !token.isCancellationRequested &&
    !model.isDisposed() &&
    model.getVersionId() === version
  );
}

function monacoRangeFromLsp(monaco: Parameters<OnMount>[1], value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  const start = isRecord(value.start) ? value.start : undefined;
  const end = isRecord(value.end) ? value.end : undefined;
  if (
    !start ||
    !end ||
    ![start.line, start.character, end.line, end.character].every(
      (coordinate) =>
        typeof coordinate === "number" &&
        Number.isSafeInteger(coordinate) &&
        coordinate >= 0,
    )
  ) {
    return undefined;
  }
  const startLine = start.line as number,
    startColumn = start.character as number;
  const endLine = end.line as number,
    endColumn = end.character as number;
  if (endLine < startLine || (endLine === startLine && endColumn < startColumn))
    return undefined;
  return new monaco.Range(
    startLine + 1,
    startColumn + 1,
    endLine + 1,
    endColumn + 1,
  );
}

function monacoLocationsFromLsp(
  monaco: Parameters<OnMount>[1],
  value: unknown,
) {
  const locations = Array.isArray(value) ? value : value ? [value] : [];
  return locations.flatMap((location) => {
    if (!isRecord(location)) return [];
    const uri =
      typeof location.uri === "string"
        ? location.uri
        : typeof location.targetUri === "string"
          ? location.targetUri
          : undefined;
    const range = monacoRangeFromLsp(
      monaco,
      location.range ?? location.targetSelectionRange ?? location.targetRange,
    );
    const path = uri ? filePathFromUri(uri) : undefined;
    return path && range
      ? [{ uri: monaco.Uri.parse(canonicalFileUri(path)), range }]
      : [];
  });
}

function monacoCompletionKind(monaco: Parameters<OnMount>[1], value: unknown) {
  const kinds = monaco.languages.CompletionItemKind;
  switch (value) {
    case 2:
      return kinds.Method;
    case 3:
      return kinds.Function;
    case 4:
      return kinds.Constructor;
    case 5:
      return kinds.Field;
    case 6:
      return kinds.Variable;
    case 7:
      return kinds.Class;
    case 8:
      return kinds.Interface;
    case 9:
      return kinds.Module;
    case 10:
      return kinds.Property;
    case 13:
      return kinds.Enum;
    case 14:
      return kinds.Keyword;
    case 15:
      return kinds.Snippet;
    case 21:
      return kinds.Constant;
    default:
      return kinds.Text;
  }
}

function completionLabel(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return isRecord(value) && typeof value.label === "string"
    ? value.label
    : undefined;
}

function completionDocumentation(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.value === "string") {
    return { value: value.value };
  }
  return undefined;
}

function lspMarkdown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(lspMarkdown).filter(Boolean).join("\n\n");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.language === "string" && typeof value.value === "string") {
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
  }
  return typeof value.value === "string" ? value.value : "";
}
