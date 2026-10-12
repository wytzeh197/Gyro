// Production panes, transaction hook, reducer, journal and rename dialog.
// LSP transport and disk reads/writes are explicitly mocked local fixture state.
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  WorkspaceRenameDialog,
  WorkspaceEditBar,
  createInitialWorkbenchState,
  workbenchReducer,
  type ResolvedTheme,
  type WorkbenchAction,
  type WorkbenchState,
  type WorkspaceFileContent,
} from "@gyro-dev/ui";
import { MonacoEditorPane } from "./editor/workspace-code-editor";
import { canonicalFileUri } from "./editor/document-uri";
import {
  useWorkspaceRename,
  editorBufferFromFile,
} from "./editor/use-workspace-rename";
import { recoverWorkspaceBuffers } from "./editor/edit-recovery";
import { ManagedDiffEditor } from "./managed-diff-editor";
import * as monaco from "monaco-editor";
import "@gyro-dev/ui/styles.css";
import "./workspace-navigation-fixture.css";

const rootPath = "/fixture/project";
const mainPath = `${rootPath}/main.ts`;
const targetPath = `${rootPath}/greeting #é%.ts`;
const foreignRoot = "/fixture/other";
const foreignPath = `${foreignRoot}/consumer.ts`;
const diskKey = "gyro.fixture.workspace-disk.v1";
const originals = {
  [foreignPath]: "export function greet(name: string) { return name; }\n",
  [mainPath]:
    'import { greet } from "./greeting #é%";\n\nconst message = greet("Workspace");\nconsole.log(message);\n' +
    Array.from(
      { length: 90 },
      (_, index) => `// Navigation viewport ${index + 1}`,
    ).join("\n"),
  [targetPath]:
    "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n",
};
const range = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end },
});
const requests: Array<{ path: string; method: string }> = [];
const versions = new Map<string, number>();
const sent = new Map<string, string>();
function diskContents(): Record<string, string> {
  return JSON.parse(localStorage.getItem(diskKey) ?? JSON.stringify(originals));
}
function file(path: string): WorkspaceFileContent {
  const content = diskContents()[path];
  if (content === undefined)
    throw new Error("The mock disk file does not exist.");
  let hash = 0;
  for (const char of content) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return {
    path,
    content,
    contentHash: `fixture:${hash}`,
    sizeBytes: new TextEncoder().encode(content).length,
    truncated: false,
  };
}
function initial(): WorkbenchState {
  const base = createInitialWorkbenchState();
  const main = editorBufferFromFile(file(mainPath));
  // Existing dirty text must survive rename and transaction undo.
  if (!localStorage.getItem(diskKey)) {
    main.content += "\n// Unsaved fixture note";
    main.status = "dirty";
  }
  return recoverWorkspaceBuffers({
    ...base,
    ide: { ...base.ide, buffers: { [mainPath]: main } },
  });
}

function Fixture() {
  const fault = useRef({
    duringRename: false,
    renameCalls: 0,
    delaySecondRename: false,
    failNextSaveTarget: false,
    foreignTargetOnce: false,
    release: undefined as (() => void) | undefined,
  });
  const [theme, setTheme] = useState<ResolvedTheme>("dark");
  const [workbench, setWorkbench] = useState(initial);
  const [main, setMain] = useState(mainPath);
  const [split, setSplit] = useState(false);
  const [reveal, setReveal] = useState<{
    path: string;
    lineNumber: number;
    column: number;
    nonce: number;
  }>();
  const [status, setStatus] = useState(
    "Target starts unopened. Main has unsaved text. LSP and disk are mocked.",
  );
  const state = useRef({ main, workbench });
  state.current = { main, workbench };
  const dispatch = (action: WorkbenchAction) =>
    setWorkbench((previous) => workbenchReducer(previous, action));
  async function mockLsp(
    path: string,
    method: string,
    params: Record<string, unknown>,
  ) {
    requests.push({ path, method });
    for (const buffer of Object.values(state.current.workbench.ide.buffers)) {
      if (sent.get(buffer.path) !== buffer.content) {
        sent.set(buffer.path, buffer.content);
        versions.set(buffer.path, (versions.get(buffer.path) ?? 0) + 1);
      }
    }
    if (method === "textDocument/definition")
      return [
        {
          targetUri: canonicalFileUri(targetPath),
          targetRange: range(0, 0, 44),
          targetSelectionRange: range(0, 16, 21),
        },
      ];
    if (method === "textDocument/references")
      return [
        { uri: canonicalFileUri(mainPath), range: range(0, 9, 14) },
        { uri: canonicalFileUri(mainPath), range: range(2, 16, 21) },
        { uri: canonicalFileUri(targetPath), range: range(0, 16, 21) },
      ];
    if (method === "textDocument/hover")
      return {
        contents: {
          kind: "markdown",
          value: "**Mock fixture symbol:** greet(name: string)",
        },
      };
    if (method === "textDocument/completion") return [];
    if (method === "textDocument/prepareRename") {
      fault.current.renameCalls = 0;
      return { range: range(2, 16, 21), placeholder: "greet" };
    }
    if (method === "textDocument/rename") {
      if (fault.current.foreignTargetOnce) {
        fault.current.foreignTargetOnce = false;
        return {
          documentChanges: [
            {
              textDocument: {
                uri: canonicalFileUri(foreignPath),
                version: null,
              },
              edits: [
                { range: range(0, 16, 21), newText: String(params.newName) },
              ],
            },
          ],
        };
      }
      const response = {
        documentChanges: (path === foreignPath
          ? [foreignPath]
          : [mainPath, targetPath]
        ).map((path) => {
          const content =
            state.current.workbench.ide.buffers[path]?.content ??
            diskContents()[path]!;
          const edits = content.split("\n").flatMap((line, index) =>
            [...line.matchAll(/\bgreet\b/g)].map((match) => ({
              range: range(index, match.index!, match.index! + 5),
              newText: String(params.newName),
            })),
          );
          return {
            textDocument: {
              uri: canonicalFileUri(path),
              version: versions.get(path) ?? null,
            },
            edits,
          };
        }),
      };
      fault.current.renameCalls++;
      if (fault.current.delaySecondRename && fault.current.renameCalls >= 2) {
        fault.current.delaySecondRename = false;
        return await new Promise((resolve) => {
          fault.current.release = () => {
            fault.current.release = undefined;
            resolve(response);
          };
        });
      }
      if (fault.current.duringRename && fault.current.renameCalls >= 2) {
        fault.current.duringRename = false;
        localStorage.setItem(
          diskKey,
          JSON.stringify({
            ...diskContents(),
            [targetPath]:
              diskContents()[targetPath] + "\n// Disk changed during rename",
          }),
        );
      }
      return response;
    }
    return null;
  }
  const rename = useWorkspaceRename({
    buffers: workbench.ide.buffers,
    roots: [rootPath, foreignRoot],
    trust: { [rootPath]: "trusted", [foreignRoot]: "trusted" },
    read: async (path) => file(path),
    request: mockLsp,
    synchronize: async (path) => {
      await mockLsp(path, "$/gyro/poll", {});
    },
    isOpen: (path) =>
      monaco.editor
        .getEditors()
        .some(
          (editor) =>
            (editor.getDomNode()?.closest(".workspace-fixture-main") ||
              editor.getDomNode()?.closest(".workspace-fixture-split")) &&
            editor.getModel()?.uri.path === path,
        ),
    version: (path) => versions.get(path),
    capabilities: () => ({ renameProvider: { prepareProvider: true } }),
    dispatch,
    save: async (path) => {
      if (path === targetPath && fault.current.failNextSaveTarget) {
        fault.current.failNextSaveTarget = false;
        return false;
      }
      const buffer = state.current.workbench.ide.buffers[path];
      if (!buffer) return false;
      localStorage.setItem(
        diskKey,
        JSON.stringify({ ...diskContents(), [path]: buffer.content }),
      );
      const saved = file(path);
      dispatch({
        type: "ide-upsert-buffer",
        buffer: editorBufferFromFile(saved),
      });
      return true;
    },
    notify: setStatus,
  });
  const renameState = useRef(rename);
  renameState.current = rename;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    Object.assign(window, {
      __workspaceFixture: {
        monaco,
        mainPath,
        targetPath,
        foreignPath,
        foreignDirtyTargetOnce: () => {
          const buffer = editorBufferFromFile(file(foreignPath));
          buffer.content = "// Existing foreign-root edits\n" + buffer.content;
          buffer.status = "dirty";
          dispatch({
            type: "ide-apply-buffer-batch",
            updates: [{ path: foreignPath, buffer }],
          });
          fault.current.foreignTargetOnce = true;
        },
        openForeign: () => {
          setMain(foreignPath);
          setReveal({
            path: foreignPath,
            lineNumber: 2,
            column: 18,
            nonce: Date.now(),
          });
        },
        clearForeignDraft: () => {
          const buffer = state.current.workbench.ide.buffers[foreignPath];
          if (buffer)
            dispatch({
              type: "ide-apply-buffer-batch",
              updates: [
                {
                  path: foreignPath,
                  expectedContent: buffer.content,
                  expectedHash: buffer.contentHash,
                  buffer: null,
                },
              ],
            });
          setMain(mainPath);
          setReveal(undefined);
        },
        failTargetSaveOnce: () => {
          fault.current.failNextSaveTarget = true;
        },
        delayFinalRename: () => {
          fault.current.delaySecondRename = true;
          fault.current.renameCalls = 0;
        },
        releaseDelayedRename: () => fault.current.release?.(),
        mutateTargetDisk: () =>
          localStorage.setItem(
            diskKey,
            JSON.stringify({
              ...diskContents(),
              [targetPath]:
                diskContents()[targetPath] + "\n// Disk changed after preview",
            }),
          ),
        restoreTargetDisk: () =>
          localStorage.setItem(
            diskKey,
            JSON.stringify({
              ...diskContents(),
              [targetPath]: originals[targetPath],
            }),
          ),
        raceTargetDuringRename: () => {
          fault.current.duringRename = true;
          fault.current.renameCalls = 0;
        },
        getState: () => ({
          ...state.current,
          requests,
          draft: renameState.current.draft,
          canUndo: renameState.current.canUndo,
          pendingRename: Boolean(fault.current.release),
          disk: diskContents(),
          files: Object.fromEntries(
            Object.entries(state.current.workbench.ide.buffers).map(
              ([path, buffer]) => [path, buffer.content],
            ),
          ),
        }),
      },
    });
  }, []);
  const editorProps = (path: string, primary: boolean) => ({
    buffer: workbench.ide.buffers[path],
    loadState: "ready" as const,
    minimapEnabled: false,
    path,
    theme,
    onChange: (content: string) =>
      dispatch({ type: "ide-update-buffer", path, content }),
    onSelectionChange: () => undefined,
    onLspRequest: mockLsp,
    onOpenLocation: async (
      path: string,
      lineNumber: number,
      column: number,
    ) => {
      if (!primary || !(path in originals)) return false;
      if (!state.current.workbench.ide.buffers[path])
        dispatch({
          type: "ide-upsert-buffer",
          buffer: editorBufferFromFile(file(path)),
        });
      setMain(path);
      setReveal({ path, lineNumber, column, nonce: Date.now() });
      setStatus(`Opened ${path}:${lineNumber}:${column} from mocked LSP.`);
      return true;
    },
    onRenameSymbol: rename.begin,
    revealTarget: primary ? reveal : undefined,
  });
  return (
    <main className="workspace-fixture">
      <header>
        <strong>Workspace production components</strong>
        <span>Mock LSP + disk · production transactions and recovery</span>
        <button
          type="button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          Switch to {theme === "dark" ? "light" : "dark"}
        </button>
        <button
          type="button"
          onClick={() => {
            setMain(mainPath);
            setReveal(undefined);
          }}
        >
          Open main.ts
        </button>
        <button type="button" onClick={() => setSplit(!split)}>
          {split ? "Close split" : "Split same file"}
        </button>
        <button
          type="button"
          onClick={() => {
            localStorage.clear();
            location.reload();
          }}
        >
          Reset fixture
        </button>
      </header>
      <div className="gyro-workspace-primary">
        <WorkspaceEditBar
          paths={rename.paths}
          canUndo={rename.canUndo}
          busy={rename.busy}
          error={rename.error}
          onUndo={rename.undo}
          onSaveAll={rename.saveAll}
          onOpenFile={(path) => {
            setMain(path);
            setReveal(undefined);
          }}
        />
        <section
          className={`workspace-fixture-editors ${split ? "is-split" : ""}`}
        >
          <div className="workspace-fixture-main">
            <div className="workspace-fixture-tab">{main}</div>
            <MonacoEditorPane {...editorProps(main, true)} />
          </div>
          {split && (
            <div className="workspace-fixture-split">
              <div className="workspace-fixture-tab">
                {mainPath} · independent viewport
              </div>
              <MonacoEditorPane {...editorProps(mainPath, false)} />
            </div>
          )}
        </section>
      </div>
      <output aria-live="polite">{status}</output>
      {rename.draft && (
        <WorkspaceRenameDialog
          name={rename.draft.name}
          files={rename.draft.plan?.files}
          busy={rename.draft.busy}
          error={rename.draft.error}
          onPreview={(name) => void rename.preview(name)}
          onApply={() => void rename.apply()}
          onCancel={rename.cancel}
          renderDiff={(file) => (
            <ManagedDiffEditor
              height="100%"
              language="typescript"
              original={file.before}
              modified={file.after}
              theme={theme === "light" ? "gyro-light" : "gyro-dark"}
              options={{
                readOnly: true,
                originalEditable: false,
                renderSideBySide: false,
                minimap: { enabled: false },
                automaticLayout: true,
              }}
            />
          )}
        />
      )}
    </main>
  );
}
if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
