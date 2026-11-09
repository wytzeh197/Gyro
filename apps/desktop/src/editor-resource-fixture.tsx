// Production reducer and Monaco panes. Synthetic text only; no native/filesystem
// transport, model provider, user state, or preloaded corpus retaining old files.
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createInitialWorkbenchState,
  workbenchReducer,
  type WorkbenchAction,
  type WorkbenchState,
} from "@gyro-dev/ui";
import * as monaco from "monaco-editor";
import { MonacoEditorPane } from "./editor/workspace-code-editor";
import { canonicalFileUri } from "./editor/document-uri";
import { useEditorModelLifecycle } from "./editor/use-editor-model-lifecycle";
import "@gyro-dev/ui/styles.css";

const prefix = "/resource-fixture/";
const noop = () => {};
function Fixture() {
  const [state, setState] = useState(createInitialWorkbenchState);
  useEditorModelLifecycle(state.ide);
  const latest = useRef(state);
  latest.current = state;
  const dispatch = (action: WorkbenchAction) =>
    setState((current) => workbenchReducer(current, action));
  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
    Object.assign(window, {
      __editorResourceFixture: {
        monaco,
        preview(index: number) {
          const path = `${prefix}preview-${index}.txt`;
          const content = Array.from(
            { length: 1024 },
            (_, line) =>
              `File ${index}, line ${line}: ${String((index * 104729 + line * 7919) >>> 0).padStart(10, "0")} ${"sample text ".repeat(8)}\n`,
          ).join("");
          setState((current) =>
            workbenchReducer(
              workbenchReducer(current, {
                type: "ide-open-tab",
                tab: {
                  path,
                  title: `Preview ${index}`,
                  dirty: false,
                  preview: true,
                },
              }),
              {
                type: "ide-upsert-buffer",
                buffer: {
                  path,
                  content,
                  savedContent: content,
                  contentHash: `fixture-${index}`,
                  sizeBytes: content.length,
                  truncated: false,
                  status: "ready",
                  updatedAt: new Date().toISOString(),
                },
              },
            ),
          );
          return canonicalFileUri(path);
        },
        close() {
          const path = latest.current.ide.activePath;
          if (!path) return;
          dispatch({ type: "ide-close-tab", path });
          // Production committed-ownership cleanup also handles explicit closes.
        },
        pin() {
          const path = latest.current.ide.activePath;
          if (path) dispatch({ type: "ide-pin-tab", path });
        },
        select(index: number) {
          dispatch({
            type: "ide-select-tab",
            path: `${prefix}preview-${index}.txt`,
          });
        },
        split() {
          dispatch({ type: "ide-split-group", direction: "right" });
        },
        closeGroup(id: string) {
          dispatch({ type: "ide-close-group", groupId: id });
        },
        clear() {
          setState((current) =>
            current.ide.tabs.reduce(
              (state, tab) =>
                workbenchReducer(state, {
                  type: "ide-close-tab",
                  path: tab.path,
                }),
              current,
            ),
          );
        },
        groups() {
          return latest.current.ide.layout.groups.map((group) => ({
            id: group.id,
            path: group.activePath,
          }));
        },
        activeContent() {
          const ide = latest.current.ide;
          return ide.buffers[ide.activePath ?? ""]?.content;
        },
        stats() {
          const ide = latest.current.ide;
          const models = monaco.editor
            .getModels()
            .filter((model) => model.uri.path.startsWith(prefix));
          return {
            tabs: ide.tabs.length,
            buffers: Object.keys(ide.buffers).length,
            bufferCharacters: Object.values(ide.buffers).reduce(
              (n, buffer) => n + buffer.content.length,
              0,
            ),
            models: models.length,
            modelCharacters: models.reduce(
              (n, model) => n + model.getValueLength(),
              0,
            ),
            editorCount: monaco.editor.getEditors().length,
          };
        },
      },
    });
    return () => {
      delete (window as typeof window & { __editorResourceFixture?: unknown })
        .__editorResourceFixture;
    };
  }, []);
  return (
    <main
      style={{
        height: "100vh",
        background: "var(--gyro-app)",
        color: "var(--gyro-text)",
      }}
    >
      <div style={{ display: "flex", height: "100%" }}>
        {state.ide.layout.groups.map((group) => (
          <section key={group.id} style={{ flex: 1, minWidth: 0 }}>
            {group.activePath ? (
              <MonacoEditorPane
                path={group.activePath}
                buffer={state.ide.buffers[group.activePath]}
                loadState="ready"
                minimapEnabled={false}
                theme="dark"
                onChange={(content) =>
                  dispatch({
                    type: "ide-update-buffer",
                    path: group.activePath!,
                    content,
                  })
                }
                onSelectionChange={noop}
              />
            ) : (
              <p>
                Isolated resource fixture: synthetic editor previews, no
                provider calls.
              </p>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
