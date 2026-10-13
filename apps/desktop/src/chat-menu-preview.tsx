// Production chat header with labeled local action callbacks; no native IPC.
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatSurface, type GyroConfig } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const config: GyroConfig = {
  commandProfiles: [], modelProviders: [], telemetryEnabled: false,
  requireCommandApproval: true, requireFileEditApproval: true,
};

function Preview() {
  const query = new URLSearchParams(location.search);
  const [width, setWidth] = useState(Number(query.get("width") ?? 720));
  const [theme, setTheme] = useState(query.get("theme") ?? "dark");
  const [environment, setEnvironment] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [action, setAction] = useState("No fixture action invoked");
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    delete document.documentElement.dataset.nativeMaterial;
  }, [theme]);
  return (
    <div className="chat-menu-preview">
      <style>{`
        .chat-menu-preview { height:100dvh;display:flex;flex-direction:column;background:var(--gyro-app);color:var(--gyro-text);font-family:var(--gyro-font-sans); }
        .chat-menu-preview nav { display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px;font-size:12px;border-bottom:1px solid var(--gyro-border); }
        .chat-menu-preview nav button { font:inherit;color:inherit;background:var(--gyro-surface);border:1px solid var(--gyro-border);border-radius:6px;padding:6px 10px; }
        .chat-menu-preview-stage { flex:1;min-height:0;overflow:auto;padding:20px; }
        .chat-menu-preview .gyro-app-shell { display:block;min-height:0;height:100%;margin:0 auto; }
        .chat-menu-preview .gyro-chat-grid-slot { height:100%; }
        .chat-menu-preview .gyro-chat-surface { height:100%;min-height:0; }
        .chat-menu-preview .gyro-app-shell *, .chat-menu-preview .gyro-app-shell *::before, .chat-menu-preview .gyro-app-shell *::after { animation:none !important;transition:none !important; }
        .chat-menu-preview output { padding:12px;font-size:12px;border-top:1px solid var(--gyro-border); }
      `}</style>
      <nav aria-label="Chat menu fixture controls">
        <strong>Three-dot menu · actual chat component</strong>
        <button onClick={() => setWidth(720)}>Wide pane</button>
        <button onClick={() => setWidth(320)}>Narrow pane</button>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>Toggle theme</button>
        <span>Sample chat; actions stay local to this fixture.</span>
      </nav>
      <div className="chat-menu-preview-stage">
        <div className="gyro-app-shell is-chat-shell is-thread-layout" style={{ width }}>
          <div className="gyro-chat-grid-slot is-window-origin">
            <ChatSurface
              config={config} isTiled shellReady sessionTitle="Update"
              paneKey="menu-fixture" workspacePath="/fixture/Gyro"
              events={[{
                id: "fixture-message", sessionId: "menu-fixture",
                kind: "user-message", createdAt: "2026-10-13T15:00:00Z",
                message: "Open More to access the chat surfaces.", payload: {},
              }]}
              isEnvironmentRailOpen={environment}
              onToggleEnvironmentRail={() => {
                setEnvironment(!environment);
                setAction(environment ? "Environment closed" : "Environment opened");
              }}
              isToolPanelOpen={drawer}
              onToggleToolPanel={() => {
                setDrawer(!drawer);
                setAction(drawer ? "Bottom drawer closed" : "Bottom drawer opened");
              }}
              onReopenCompanionDock={() => setAction("Companion reopened")}
              onSend={() => undefined}
            />
          </div>
        </div>
      </div>
      <output role="status">{action}</output>
    </div>
  );
}
if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Preview />);
