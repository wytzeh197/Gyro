import { useState } from "react";
import { askTextValue, confirmAction } from "@gyro-dev/ui";
import type {
  Session,
  TerminalPane,
  WorkspaceFileContent,
  WorkspaceSearchResult,
} from "@gyro-dev/ui";
import { MonacoEditorPane } from "../editor/workspace-code-editor";
import { LiveTerminalPaneBody } from "../live-terminal-pane";
import type { RemoteWorkspaceController } from "./use-workspace";
import type { GitAction, TerminalSnapshot } from "./types";
import { useRemoteTheme } from "./context";

type Props = { workspace: RemoteWorkspaceController; session: Session };
export function RemoteFiles({
  workspace: w,
  session,
  hostId,
}: Props & { hostId: string }) {
  const { view, setView, data, run } = w;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearchResult[]>();
  const key = `${session.id}:${view.selectedFile ?? ""}`;
  const buffer = view.buffers[key];
  const theme = useRemoteTheme();
  async function openFile(path: string, reload = false) {
    const existing = view.buffers[`${session.id}:${path}`];
    if (existing && !reload) {
      setView((previous) => ({ ...previous, selectedFile: path }));
      return;
    }
    if (
      reload &&
      existing &&
      existing.text !== existing.file.content &&
      !(await confirmAction(
        `Discard your unsaved changes to ${path} and reload from the host?`,
      ))
    )
      return;
    const file = await run<WorkspaceFileContent>({
      op: "readFile",
      sessionId: session.id,
      path,
    });
    if (file)
      setView((previous) => ({
        ...previous,
        selectedFile: path,
        buffers: {
          ...previous.buffers,
          [`${session.id}:${path}`]: { file, text: file.content },
        },
      }));
  }
  async function save() {
    if (!buffer || !view.selectedFile) return;
    const file = await run<WorkspaceFileContent>({
      op: "writeFile",
      sessionId: session.id,
      path: view.selectedFile,
      content: buffer.text,
      expectedHash: buffer.file.contentHash,
    });
    if (file)
      setView((previous) => ({
        ...previous,
        buffers: {
          ...previous.buffers,
          [key]: { file, text: previous.buffers[key]?.text ?? file.content },
        },
      }));
  }
  async function pathAction(
    action: "createFile" | "createDirectory" | "rename" | "delete",
  ) {
    const path = action.startsWith("create")
      ? await askTextValue({
          title: action === "createFile" ? "New file path" : "New folder path",
        })
      : view.selectedFile;
    if (!path) return;
    const name =
      action === "rename"
        ? ((await askTextValue({
            title: "New relative path",
            initialValue: path,
          })) ?? undefined)
        : undefined;
    if (action === "rename" && !name) return;
    if (
      action === "delete" &&
      !(await confirmAction(`Move ${path} to the host's trash?`))
    )
      return;
    const result = await run({
      op: "path",
      sessionId: session.id,
      action,
      path,
      name,
      expectedHash: buffer?.file.contentHash,
    });
    if (result !== undefined && (action === "delete" || action === "rename")) {
      setView((previous) => {
        const buffers = { ...previous.buffers };
        const oldKey = `${session.id}:${path}`;
        const old = buffers[oldKey];
        delete buffers[oldKey];
        if (action === "rename" && name && old)
          buffers[`${session.id}:${name}`] = {
            ...old,
            file: { ...old.file, path: name },
          };
        return {
          ...previous,
          buffers,
          selectedFile: action === "rename" ? name : undefined,
        };
      });
    }
    await w.loadTools();
  }
  return (
    <section className="gyro-remote-files" aria-label="Remote files">
      <aside className="gyro-remote-file-list">
        <form
          className="gyro-remote-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void run<WorkspaceSearchResult[]>({
              op: "search",
              sessionId: session.id,
              query,
            }).then(setResults);
          }}
        >
          <input
            className="gyro-settings-input"
            aria-label="Search remote files"
            placeholder="Search project"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (!event.target.value) setResults(undefined);
            }}
          />
          <button
            type="submit"
            className="gyro-secondary-button"
            disabled={!w.online || w.busy}
          >
            Search
          </button>
        </form>
        {results
          ? results.map((result, index) => (
              <button
                type="button"
                className="gyro-sidebar-row"
                key={`${result.path}:${index}`}
                onClick={() => void openFile(result.path)}
              >
                {result.path}
              </button>
            ))
          : data.files.map((file) => (
              <button
                type="button"
                className="gyro-sidebar-row"
                key={file.path}
                disabled={file.kind !== "file"}
                onClick={() => void openFile(file.path)}
              >
                {file.kind === "directory" ? "▸ " : ""}
                {file.path}
              </button>
            ))}
        {!data.files.length && !results && w.toolsLoading && (
          <p>Loading files…</p>
        )}
        {!data.files.length && !results && !w.toolsLoading && (
          <p>
            No files loaded.{" "}
            <button
              type="button"
              className="gyro-secondary-button"
              onClick={() => void w.loadTools()}
            >
              Refresh
            </button>
          </p>
        )}
        <div className="gyro-remote-actions">
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={!w.owns || w.busy}
            onClick={() => void pathAction("createFile")}
          >
            New file
          </button>
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={!w.owns || w.busy}
            onClick={() => void pathAction("createDirectory")}
          >
            New folder
          </button>
        </div>
      </aside>
      <div className="gyro-remote-editor">
        <nav className="gyro-remote-toolbar" aria-label="Remote editor tabs">
          {Object.keys(view.buffers)
            .filter((k) => k.startsWith(`${session.id}:`))
            .map((k) => {
              const path = k.slice(session.id.length + 1);
              return (
                <button
                  key={k}
                  type="button"
                  className="gyro-secondary-button"
                  aria-pressed={view.selectedFile === path}
                  onClick={() =>
                    setView((previous) => ({ ...previous, selectedFile: path }))
                  }
                >
                  {path}
                  {view.buffers[k]?.text !== view.buffers[k]?.file.content
                    ? " •"
                    : ""}
                </button>
              );
            })}
        </nav>
        {buffer ? (
          <>
            <div className="gyro-remote-toolbar">
              <span>{view.selectedFile}</span>
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={!w.owns || w.busy || buffer.file.truncated}
                onClick={() => void save()}
              >
                Save on host
              </button>
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={!w.online || w.busy}
                onClick={() =>
                  view.selectedFile && void openFile(view.selectedFile, true)
                }
              >
                Reload from host
              </button>
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={!w.owns || w.busy}
                onClick={() => void pathAction("rename")}
              >
                Rename
              </button>
              <button
                type="button"
                className="gyro-secondary-button"
                disabled={!w.owns || w.busy}
                onClick={() => void pathAction("delete")}
              >
                Delete
              </button>
            </div>
            {buffer.file.truncated && (
              <p role="status">
                This file exceeds the editable size limit. Its preview cannot be
                saved.
              </p>
            )}
            <div className="gyro-remote-editor-body">
              <MonacoEditorPane
                key={`${hostId}:${session.id}:${view.selectedFile}`}
                theme={theme}
                loadState="ready"
                minimapEnabled={false}
                readOnly={!w.owns || !w.online || buffer.file.truncated}
                path={`/.gyro-remote/${hostId}/${session.id}/${view.selectedFile}`}
                fileContent={{
                  ...buffer.file,
                  path: `/.gyro-remote/${hostId}/${session.id}/${view.selectedFile}`,
                }}
                buffer={{
                  path: `/.gyro-remote/${hostId}/${session.id}/${view.selectedFile}`,
                  content: buffer.text,
                  savedContent: buffer.file.content,
                  contentHash: buffer.file.contentHash,
                  sizeBytes: buffer.file.sizeBytes,
                  truncated: buffer.file.truncated,
                  status: "ready",
                  updatedAt: new Date().toISOString(),
                }}
                onChange={(text) =>
                  setView((previous) => ({
                    ...previous,
                    buffers: {
                      ...previous.buffers,
                      [key]: { ...(previous.buffers[key] ?? buffer), text },
                    },
                  }))
                }
                onSelectionChange={() => {}}
              />
            </div>
          </>
        ) : (
          <div className="gyro-remote-empty">
            <p>Select a remote file to edit it.</p>
          </div>
        )}
      </div>
    </section>
  );
}

export function RemoteGit({ workspace: w, session }: Props) {
  const [message, setMessage] = useState("");
  const [diff, setDiff] = useState("");
  const git = w.data.git;
  async function action(kind: GitAction, path?: string, text?: string) {
    if (
      kind === "discard" &&
      !(await confirmAction(`Discard changes to ${path} on the host?`))
    )
      return;
    const result = await w.run<{ stdout?: string; stderr?: string }>({
      op: "git",
      sessionId: session.id,
      action: kind,
      path,
      message: text,
      expectedRevision: git?.revision,
    });
    if (kind === "diff" && result)
      setDiff(result.stdout ?? result.stderr ?? "No diff");
    await w.loadTools();
  }
  return (
    <section
      className="gyro-remote-stack gyro-remote-panel"
      aria-label="Remote Source Control"
    >
      <div className="gyro-remote-toolbar">
        <strong>{git?.status.branch ?? "Source Control"}</strong>
        <button
          type="button"
          className="gyro-secondary-button"
          onClick={() => void w.loadTools()}
        >
          Refresh
        </button>
        {(["fetch", "pull", "push"] as const).map((kind) => (
          <button
            type="button"
            className="gyro-secondary-button"
            key={kind}
            disabled={!w.owns || w.busy || !git?.status.available}
            onClick={() => void action(kind)}
          >
            {kind}
          </button>
        ))}
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={!w.owns || w.busy || !git?.status.available}
          onClick={() => {
            void askTextValue({ title: "New host branch" }).then((branch) => {
              if (branch) void action("createBranch", undefined, branch);
            });
          }}
        >
          New branch
        </button>
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={!w.owns || w.busy || !git?.status.available}
          onClick={() => {
            void askTextValue({ title: "Switch to existing host branch" }).then(
              (branch) => {
                if (branch) void action("checkout", undefined, branch);
              },
            );
          }}
        >
          Switch branch
        </button>
      </div>
      {!git && w.toolsLoading && <p>Loading changes…</p>}
      {git && !git.status.available && (
        <p>{git.status.error ?? "This project is not a Git repository."}</p>
      )}
      {git?.status.files.length === 0 && <p>Working tree clean.</p>}
      {git?.status.files.map((file) => (
        <div
          className="gyro-remote-toolbar"
          key={`${file.path}:${file.staged}`}
        >
          <button
            type="button"
            className="gyro-secondary-button"
            onClick={() =>
              void action("diff", file.path, file.staged ? "staged" : undefined)
            }
          >
            {file.path} · {file.staged ? "Staged" : "Unstaged"}
          </button>
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={!w.owns || w.busy}
            onClick={() =>
              void action(file.staged ? "unstage" : "stage", file.path)
            }
          >
            {file.staged ? "Unstage" : "Stage"}
          </button>
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={!w.owns || w.busy}
            onClick={() => void action("discard", file.path)}
          >
            Discard
          </button>
        </div>
      ))}
      <label className="gyro-remote-stack">
        Commit message
        <input
          className="gyro-settings-input"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="gyro-secondary-button"
        disabled={!w.owns || w.busy || !message.trim()}
        onClick={() => void action("commit", undefined, message)}
      >
        Commit staged changes on host
      </button>
      <pre className="gyro-remote-output">
        {diff || "Select a changed file to inspect its diff."}
      </pre>
    </section>
  );
}

function paneFromSnapshot(snapshot: TerminalSnapshot): TerminalPane {
  return {
    id: snapshot.paneId,
    title: snapshot.title,
    profileId: "remote-shell",
    command: "/bin/zsh",
    output: snapshot.output ?? "",
    status: snapshot.status,
    lastEvent: "Remote host terminal",
    workspaceMode: "local",
    branch: "",
    projectPath: snapshot.workspacePath,
    createdAt: "",
    exitCode: snapshot.exitCode,
  };
}
export function RemoteTerminals({ workspace: w, session }: Props) {
  const [selected, setSelected] = useState<string>();
  const pane =
    w.data.terminals.find((p) => p.paneId === selected) ?? w.data.terminals[0];
  const theme = useRemoteTheme();
  const create = () =>
    w
      .run<TerminalSnapshot>({
        op: "terminal",
        sessionId: session.id,
        action: "create",
      })
      .then((snapshot) => {
        update(snapshot);
        if (snapshot) setSelected(snapshot.paneId);
      });
  const update = (snapshot?: TerminalSnapshot) => {
    if (snapshot)
      w.setData((previous) => {
        const current = previous.terminals.find(
          (p) => p.paneId === snapshot.paneId,
        );
        if (current && current.outputRevision > snapshot.outputRevision)
          return previous;
        return {
          ...previous,
          terminals: [
            ...previous.terminals.filter((p) => p.paneId !== snapshot.paneId),
            { ...snapshot, output: snapshot.output ?? current?.output ?? "" },
          ],
        };
      });
  };
  return (
    <section className="gyro-remote-terminal" aria-label="Remote terminals">
      <nav className="gyro-remote-toolbar" aria-label="Host terminal tabs">
        {w.data.terminals.map((item) => (
          <button
            type="button"
            className="gyro-secondary-button"
            key={item.paneId}
            aria-pressed={item.paneId === pane?.paneId}
            onClick={() => setSelected(item.paneId)}
          >
            {item.title}
          </button>
        ))}
        <button
          type="button"
          className="gyro-secondary-button"
          disabled={!w.owns || w.busy}
          onClick={() =>
            void w
              .run<TerminalSnapshot>({
                op: "terminal",
                sessionId: session.id,
                action: "create",
              })
              .then((snapshot) => {
                update(snapshot);
                if (snapshot) setSelected(snapshot.paneId);
              })
          }
        >
          New host terminal
        </button>
        {pane && (
          <button
            type="button"
            className="gyro-secondary-button"
            disabled={!w.owns}
            onClick={() => {
              void confirmAction(
                "Close this host terminal and stop its process?",
              ).then((yes) => {
                if (yes)
                  void w
                    .run({
                      op: "terminal",
                      sessionId: session.id,
                      action: "close",
                      paneId: pane.paneId,
                    })
                    .then(() => w.loadTools());
              });
            }}
          >
            Close terminal
          </button>
        )}
      </nav>
      {!w.online && (
        <p role="status">
          Disconnected. Terminal output is last known; input is disabled.
        </p>
      )}
      {pane ? (
        <div
          className="gyro-remote-terminal-body"
          ref={(node) => node?.toggleAttribute("inert", !w.online || !w.owns)}
        >
          <LiveTerminalPaneBody
            key={pane.paneId}
            pane={paneFromSnapshot(pane)}
            theme={theme}
            isActive={w.online && w.owns}
            onSelect={setSelected}
            onBell={() => {}}
            onReconnect={() => void create()}
            onResize={(paneId, cols, rows) => {
              if (w.owns)
                void w
                  .run<TerminalSnapshot>({
                    op: "terminal",
                    sessionId: session.id,
                    action: "resize",
                    paneId,
                    cols,
                    rows,
                  })
                  .then(update);
            }}
            onWrite={(paneId, input) => {
              if (w.owns)
                void w
                  .run<TerminalSnapshot>({
                    op: "terminal",
                    sessionId: session.id,
                    action: "input",
                    paneId,
                    input,
                  })
                  .then(update);
            }}
          />
        </div>
      ) : (
        <div className="gyro-remote-empty">
          <p>
            {w.toolsLoading
              ? "Loading terminals…"
              : "No remote terminals. Take control and create one."}
          </p>
        </div>
      )}
      <small>
        Output uses bounded host scrollback. Earlier output may no longer be
        available.
      </small>
    </section>
  );
}
