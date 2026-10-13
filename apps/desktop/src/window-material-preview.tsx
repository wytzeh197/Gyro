// Actual chrome and content components; no IPC or saved project data.
// The colored desktop is a labeled simulation of the native window backdrop.
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppChrome, ChatSurface, IdeSurface, createInitialWorkbenchState,
  type Session, type WorkspaceLayoutId,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const sessions: Session[] = [
  { id: "active", title: "Subtle window material", workspacePath: "/fixture/Gyro",
    origin: "desktop", createdAt: "2026-10-12T10:00:00Z",
    updatedAt: "2026-10-12T10:00:00Z", eventsPath: "/fixture/active.jsonl" },
  { id: "other", title: "Polish slash command menu", workspacePath: "/fixture/Gyro",
    origin: "desktop", createdAt: "2026-10-12T09:00:00Z",
    updatedAt: "2026-10-12T09:00:00Z", eventsPath: "/fixture/other.jsonl" },
];
const config = { commandProfiles: [], modelProviders: [], requireCommandApproval: true,
  requireFileEditApproval: true, telemetryEnabled: false };
const initialIde = createInitialWorkbenchState().ide;

function Preview() {
  const [theme, setTheme] = useState("dark");
  const [layout, setLayout] = useState<WorkspaceLayoutId>("thread");
  const [active, setActive] = useState("active");
  const [ide, setIde] = useState(initialIde);
  const [backdrop, setBackdrop] = useState(false);
  const [solid, setSolid] = useState(false);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.nativeMaterial = "sidebar";
    if (solid) document.documentElement.style.setProperty("--gyro-window-tint", "100%");
    else document.documentElement.style.removeProperty("--gyro-window-tint");
  }, [theme, solid]);
  return (
    <div className="material-preview">
      <style>{`
        .material-preview { height:100dvh;display:flex;flex-direction:column;color:var(--gyro-text);font-family:var(--gyro-font-sans); }
        .material-preview-controls { background:var(--gyro-app);display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 16px;font-size:12px; }
        .material-preview-controls strong { margin-right:auto; }
        .material-preview-controls button { border:1px solid var(--gyro-border);border-radius:6px;background:var(--gyro-surface);color:var(--gyro-text);font:inherit;padding:6px 10px; }
        .material-preview-controls button[aria-pressed=true] { border-color:var(--gyro-accent); }
        .material-preview-desktop { flex:1;min-height:0;position:relative;padding:20px;background:linear-gradient(140deg,#37556d 0%,#617d8e 25%,#aa9f94 45%,#93627b 67%,#313747 100%);background-size:160% 160%; }
        .material-preview-desktop.is-shifted { background-position:100% 100%; }
        .material-preview-window { height:100%;overflow:hidden;border:1px solid var(--gyro-premium-hairline-strong);border-radius:14px;box-shadow:0 14px 40px rgb(0 0 0 / 25%); }
        .material-preview-window .gyro-app-shell { height:100%;min-height:0;grid-template-rows:minmax(0,1fr); }
        .material-preview-window .gyro-main { height:100%;max-height:100%;min-height:0; }
        .material-preview-window .gyro-sidebar,.material-preview-window .gyro-workspace-activity-rail { height:100%;max-height:100%;min-height:0; }
        .material-preview-caption { margin:0;padding:8px 16px;background:var(--gyro-app);color:var(--gyro-muted);font-size:12px; }
      `}</style>
      <nav className="material-preview-controls" aria-label="Material fixture controls">
        <strong>Subtle translucency · actual components</strong>
        <button aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>Dark</button>
        <button aria-pressed={theme === "light"} onClick={() => setTheme("light")}>Light</button>
        <button aria-pressed={layout === "thread"} onClick={() => setLayout("thread")}>Sessions</button>
        <button aria-pressed={layout === "code"} onClick={() => setLayout("code")}>Workspace</button>
        <button onClick={() => setBackdrop(!backdrop)}>Move backdrop</button>
        <button aria-pressed={solid} onClick={() => setSolid(!solid)}>Compare opaque</button>
      </nav>
      <div className={`material-preview-desktop${backdrop ? " is-shifted" : ""}`}>
        <div className="material-preview-window">
          <AppChrome
            activeDestination="workspace" activeSessionId={active}
            activeWorkspaceLayout={layout} commandProfiles={[]} savedProjects={[]}
            sessions={sessions} workspacePath="/fixture/Gyro" ide={ide}
            onSelectSession={setActive} onSelectWorkspaceLayout={setLayout}
            onSelectIdeView={(activeView) => setIde((current) => ({ ...current, activeView }))}
            onSelectDestination={() => undefined} onOpenToolPanel={() => undefined}
            onOpenSettings={() => undefined} onOpenCommandPalette={() => undefined}
            onCreateSession={() => undefined} onCreateCliSession={() => undefined}
            onSelectSessions={() => setLayout("thread")} onOpenWorkspace={() => setLayout("code")}
          >
            {layout === "code" ? (
              <div className="gyro-workspace-route is-code" style={{ gridTemplateRows: "minmax(0,1fr)" }}>
                <section className="gyro-workspace-primary" aria-label="Workspace">
                  <IdeSurface
                    workspacePath="/fixture/Gyro" files={[]} editorTabs={[]}
                    activePaneTab="terminal" terminalOutput="" showEmbeddedPanel={false}
                    onSelectFile={() => undefined} onPaneTabChange={() => undefined}
                  />
                </section>
              </div>
            ) : (
              <ChatSurface
                config={config} events={[]} sessionTitle="Subtle window material"
                sessionModel={{ modelLabel: "GPT-6.1 Sol" }}
                onSend={() => undefined} shellReady
              />
            )}
          </AppChrome>
        </div>
      </div>
      <p className="material-preview-caption">Simulated desktop backdrop. In the native app, macOS supplies the frosted material. Editor canvases remain opaque.</p>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
