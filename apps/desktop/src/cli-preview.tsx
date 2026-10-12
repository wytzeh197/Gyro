// Standalone preview: real CLI components, local fixture sessions, no native IPC.
import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CliSessionList, TerminalPanel, type TerminalPane } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import "./cli-preview.css";

const fixturePanes: TerminalPane[] = [
  {
    id: "codex",
    title: "Codex CLI",
    profileId: "codex",
    command: "codex",
    output: "",
    status: "running",
    lastEvent: "Fixture process started",
    workspaceMode: "local",
    branch: "v0.1.0",
    projectPath: "/Projects/Gyro",
    createdAt: "2026-10-11T10:00:00Z",
  },
  {
    id: "review",
    title: "Claude Code",
    taskTitle: "Review terminal layout and keyboard navigation",
    profileId: "claude",
    command: "claude",
    output: "",
    status: "waiting",
    lastEvent: "Fixture waiting for input",
    workspaceMode: "local",
    branch: "v0.1.0",
    projectPath: "/Projects/Gyro",
    createdAt: "2026-10-11T10:01:00Z",
  },
  {
    id: "shell",
    title: "Shell",
    profileId: "shell",
    command: "zsh",
    output: "",
    status: "running",
    hasForegroundJob: false,
    lastEvent: "Fixture shell idle",
    workspaceMode: "local",
    branch: "v0.1.0",
    workingDirectory: "/Projects/Gyro",
    createdAt: "2026-10-11T10:02:00Z",
  },
];
function Preview() {
  const [panes, setPanes] = useState(fixturePanes);
  const [selected, setSelected] = useState("codex");
  const [theme, setTheme] = useState("dark");
  const [density, setDensity] = useState("comfortable");
  const [size, setSize] = useState("default");
  const [width, setWidth] = useState("auto");
  const [accent, setAccent] = useState(false);
  const [notice, setNotice] = useState(
    "Fixture sessions only · no commands are executed",
  );
  useLayoutEffect(() => {
    Object.assign(document.documentElement.dataset, {
      theme,
      density,
      interfaceSize: size,
    });
    document.documentElement.style.setProperty(
      "--gyro-user-main",
      accent ? "#a56be8" : "#0874df",
    );
  }, [theme, density, size, accent]);
  const close = (id: string) => {
    const next = panes.filter((pane) => pane.id !== id);
    setPanes(next);
    if (selected === id) setSelected(next[0]?.id ?? "");
    setNotice("Closed fixture session");
  };
  const add = () => {
    const id = `shell-${Date.now()}`;
    setPanes([
      ...panes,
      { ...fixturePanes[2]!, id, title: `Shell ${panes.length + 1}` },
    ]);
    setSelected(id);
    setNotice("Added fixture shell");
  };
  return (
    <main className="cli-preview">
      <header className="cli-preview-controls">
        <strong>CLI view · component preview</strong>
        <label>
          Theme{" "}
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option>dark</option>
            <option>light</option>
          </select>
        </label>
        <label>
          Density{" "}
          <select value={density} onChange={(e) => setDensity(e.target.value)}>
            <option>comfortable</option>
            <option>compact</option>
          </select>
        </label>
        <label>
          Size{" "}
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            <option>small</option>
            <option>default</option>
            <option>large</option>
          </select>
        </label>
        <label>
          Width{" "}
          <select value={width} onChange={(e) => setWidth(e.target.value)}>
            <option value="auto">Fit panel</option>
            {[860, 1280, 1440, 1728].map((w) => (
              <option key={w} value={w}>
                {w}px
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setAccent(!accent)}>Toggle accent</button>
        <button
          onClick={() => {
            setPanes(fixturePanes);
            setSelected("codex");
          }}
        >
          Reset fixtures
        </button>
      </header>
      <p className="cli-preview-notice" role="status">
        {notice}
      </p>
      <div className="cli-preview-scroll">
        <div
          className="cli-preview-window"
          style={
            width === "auto"
              ? undefined
              : {
                  width: Number(width),
                  height:
                    Number(width) === 860
                      ? 620
                      : Number(width) === 1280
                        ? 720
                        : Number(width) === 1440
                          ? 900
                          : 1117,
                }
          }
        >
          <aside className="gyro-sidebar">
            <div className="cli-preview-sidebar-title">
              Gyro <span>CLI workspace</span>
            </div>
            <CliSessionList
              items={panes.map((pane) => ({
                pane,
                status:
                  pane.id.startsWith("shell") && pane.status === "running"
                    ? "idle"
                    : pane.status,
              }))}
              selectedId={selected}
              onSelect={setSelected}
              onClose={close}
              onBack={() =>
                setNotice(
                  "Back to chats selected · this preview stays on CLI components",
                )
              }
            />
          </aside>
          <div className="gyro-workspace-tool-panel is-primary">
            <TerminalPanel
              profiles={[]}
              activeProfileId="codex"
              output=""
              terminalPanes={panes}
              selectedTerminalPaneId={selected}
              onProfileChange={() => {}}
              onRunProfile={add}
              onAddTerminalPane={add}
              onSelectTerminalPane={setSelected}
              onCloseTerminalPane={close}
              onRestartTerminalPane={(id) =>
                setNotice(`Restart requested for fixture ${id}`)
              }
              onKillTerminalPane={(id) => {
                setPanes(
                  panes.map((p) =>
                    p.id === id ? { ...p, status: "done" } : p,
                  ),
                );
                setNotice("Stopped fixture process");
              }}
              onMoveTerminalPane={(id, target) => {
                const next = panes.filter((p) => p.id !== id);
                next.splice(
                  next.findIndex((p) => p.id === target),
                  0,
                  panes.find((p) => p.id === id)!,
                );
                setPanes(next);
              }}
              renderTerminalPaneBody={(pane) => (
                <div className="gyro-xterm-host cli-preview-output">
                  <div>
                    <p>
                      <strong>{pane.title}</strong>{" "}
                      <span className="cli-preview-muted">
                        · fixture output
                      </span>
                    </p>
                    <p className="cli-preview-muted">~/Projects/Gyro</p>
                    <p className="cli-preview-request">
                      ›{" "}
                      {pane.id === "review"
                        ? "Review terminal layout and keyboard navigation"
                        : pane.id.startsWith("shell")
                          ? "pnpm typecheck"
                          : "Polish the CLI view"}
                    </p>
                    <p>
                      {pane.id === "review"
                        ? "Waiting for input before continuing."
                        : pane.id.startsWith("shell")
                          ? "Type check completed. Ready for the next command."
                          : "• The workspace is ready for your next task."}
                    </p>
                  </div>
                  <div className="cli-preview-prompt">
                    <p>
                      ›{" "}
                      <span className="cli-preview-muted">
                        {pane.id.startsWith("shell")
                          ? "gyro %"
                          : "Ask a follow-up…"}
                      </span>
                    </p>
                    <p className="cli-preview-muted">
                      ~/Projects/Gyro · v0.1.0
                    </p>
                  </div>
                </div>
              )}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
