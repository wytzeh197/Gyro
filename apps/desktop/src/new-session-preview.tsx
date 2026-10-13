// Standalone production-sidebar fixture. No native IPC or commands.
import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppChrome, type CommandProfile, type TerminalPane } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const profiles: CommandProfile[] = [
  { id: "shell", displayName: "Shell", command: "zsh", args: [], readiness: "ready" },
  { id: "claude-code", displayName: "Claude Code", command: "claude", args: [], providerId: "anthropic", readiness: "ready" },
  { id: "codex", displayName: "Codex CLI", command: "codex", args: [], providerId: "openai", readiness: "ready" },
  { id: "kimi-code", displayName: "Kimi Code", command: "kimi", args: [], providerId: "kimi", readiness: "ready" },
  { id: "grok-build", displayName: "Grok Build", command: "grok", args: [], providerId: "xai", readiness: "ready" },
  { id: "ollama", displayName: "Ollama (local)", command: "ollama", args: [], providerId: "ollama", readiness: "ready" },
  { id: "gemini", displayName: "Gemini CLI", command: "gemini", args: [], providerId: "google", readiness: "blocked" },
  { id: "opencode", displayName: "OpenCode", command: "opencode", args: [], readiness: "blocked" },
  { id: "qwen", displayName: "Qwen Code with a longer fixture name", command: "qwen", args: [], providerId: "qwen", readiness: "blocked" },
];
const panes: TerminalPane[] = [{
  id: "fixture-terminal", title: "Shell", profileId: "shell", command: "zsh", output: "",
  status: "running", lastEvent: "Fixture only", workspaceMode: "local", branch: "v0.1.0",
  projectPath: "/fixture/Gyro", createdAt: "2026-10-13T10:00:00Z",
}];

function Preview() {
  const [theme, setTheme] = useState("dark");
  const [large, setLarge] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [project, setProject] = useState(true);
  const [terminals, setTerminals] = useState(true);
  const [notice, setNotice] = useState("Fixture actions only. No commands are executed.");
  const [geometry, setGeometry] = useState("Open New Session to inspect the menu.");
  useLayoutEffect(() => {
    Object.assign(document.documentElement.dataset, {
      theme, interfaceSize: large ? "large" : "default",
    });
    document.documentElement.style.setProperty("--gyro-ui-scale", large ? "1.15" : "1");
    document.documentElement.style.setProperty("--preview-sidebar-width", narrow ? "210px" : "224px");
    const measure = () => {
      const menu = document.querySelector<HTMLElement>(".gyro-sidebar-new-session-menu");
      if (!menu) { setGeometry("Open New Session to inspect the menu."); return; }
      const rows = Array.from(menu.querySelectorAll<HTMLElement>("button"));
      const overlap = rows.some((row, index) => {
        const next = rows[index + 1];
        return next && row.getBoundingClientRect().bottom > next.getBoundingClientRect().top + 0.5;
      });
      const width = Math.round(menu.getBoundingClientRect().width);
      const viewportOverflow = menu.getBoundingClientRect().right > innerWidth;
      setGeometry(`Menu ${width}px · ${rows.length} rows · ${overlap || viewportOverflow ? "layout issue" : "no overlap or viewport overflow"}`);
    };
    const schedule = () => queueMicrotask(measure);
    const observer = new MutationObserver(schedule);
    observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
    addEventListener("resize", schedule);
    schedule();
    return () => { observer.disconnect(); removeEventListener("resize", schedule); };
  }, [theme, large, narrow, project, terminals]);
  return <>
    <style>{`
      /* Static fixture captures remain visible when the preview is backgrounded. */
      :root .gyro-sidebar-persistent-header ~ .gyro-sidebar-actions,
      :root .gyro-sidebar-persistent-header ~ .gyro-sidebar-section,
      :root .gyro-sidebar-persistent-header ~ .gyro-sidebar-project-chat-list,
      :root .gyro-sidebar-new-session-menu { animation: none; }
      /* Keep the desktop sidebar visible inside Gyro's narrow preview panel. */
      :root .gyro-app-shell.is-chat-shell {
        grid-template-columns: var(--preview-sidebar-width, 224px) minmax(0, 1fr) !important;
      }
      :root .gyro-app-shell.is-chat-shell > .gyro-sidebar {
        display: flex !important;
        grid-column: 1 !important;
        grid-row: 1 !important;
        width: 100% !important;
        min-width: 0 !important;
      }
      :root .gyro-app-shell.is-chat-shell > .gyro-main {
        grid-column: 2 !important;
        grid-row: 1 !important;
        min-width: 0 !important;
      }
      :root .gyro-compact-navigation-toolbar { display: none !important; }
      .session-preview { padding: 36px; color: var(--gyro-text); max-width: 620px; }
      .session-preview h1 { font-size: 22px; font-weight: 600; margin: 0 0 10px; }
      .session-preview p { color: var(--gyro-muted); font-size: 13px; line-height: 1.6; }
      .session-preview-controls { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0; }
      .session-preview-controls button { background: var(--gyro-surface-raised); border: 1px solid var(--gyro-border-soft); border-radius: 7px; padding: 7px 10px; color: var(--gyro-text); font: inherit; font-size: 12px; }
      .session-preview output { display: block; font-size: 12px; margin: 12px 0; color: var(--gyro-muted); }
    `}</style>
    <AppChrome
      activeDestination="workspace" activeWorkspaceLayout="thread"
      commandProfiles={profiles} savedProjects={[]} sessions={[]}
      workspacePath={project ? "/fixture/Gyro" : undefined}
      terminalPanes={terminals ? panes : []}
      onCreateCliSession={(id, path) => setNotice(`CLI callback received: ${id} in ${path}`)}
      onCreateSession={() => setNotice("New Chat callback received")}
      onOpenCommandPalette={() => setNotice("Search callback received")}
      onOpenSettings={() => setNotice("Settings callback received")}
      onOpenToolPanel={() => undefined}
      onOpenWorkspace={() => { setProject(true); setNotice("Open project callback received; fixture project selected"); }}
      onSelectDestination={() => undefined}
      onSelectSession={() => undefined}
      onSelectSessions={() => undefined}
      onSelectWorkspaceLayout={(layout) => setNotice(`Layout callback received: ${layout}`)}
    >
      <main className="session-preview">
        <p style={{fontSize: 11, letterSpacing: "0.04em", marginBottom: 10}}>GYRO · COMPONENT PREVIEW</p>
        <h1>New Session</h1>
        <p>Real sidebar component with sample CLI readiness and terminal data.</p>
        <div className="session-preview-controls">
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>Toggle theme</button>
          <button onClick={() => setLarge(!large)}>Toggle interface size</button>
          <button onClick={() => setNarrow(!narrow)}>Toggle narrow sidebar</button>
          <button onClick={() => setProject(!project)}>Toggle project</button>
          <button onClick={() => setTerminals(!terminals)}>Toggle terminals</button>
        </div>
        <output aria-label="Fixture action" role="status">{notice}</output>
        <output aria-label="Layout check">{geometry}</output>
      </main>
    </AppChrome>
  </>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
