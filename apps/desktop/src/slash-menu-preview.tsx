// Standalone production-component fixture; actions are recorded locally.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatSurface } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const config = {
  commandProfiles: [],
  modelProviders: [],
  requireCommandApproval: false,
  requireFileEditApproval: false,
  telemetryEnabled: false,
};

function Fixture() {
  const [theme, setTheme] = useState("dark");
  const [draft, setDraft] = useState("/");
  const [revision, setRevision] = useState(0);
  const [workspace, setWorkspace] = useState(false);
  const [action, setAction] = useState("No action selected");
  const show = (value: string) => {
    setDraft(value);
    setRevision((current) => current + 1);
  };
  const changeTheme = (value: string) => {
    document.documentElement.dataset.theme = value;
    setTheme(value);
    show("/");
  };
  return (
    <div className="slash-preview">
      <style>{`
        .slash-preview { height:100dvh; display:flex; flex-direction:column; background:var(--gyro-app); color:var(--gyro-text); }
        .slash-preview-controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:16px 20px; border-bottom:1px solid var(--gyro-border-soft); }
        .slash-preview-controls strong { font-size:13px; margin-right:auto; }
        .slash-preview-controls button { background:var(--gyro-surface); color:var(--gyro-muted); border:1px solid var(--gyro-border); border-radius:6px; padding:6px 10px; font:inherit; font-size:12px; cursor:pointer; }
        .slash-preview-controls button[aria-pressed=true] { color:var(--gyro-text); border-color:var(--gyro-accent); }
        .slash-preview-caption { margin:0; padding:10px 20px; color:var(--gyro-faint); font-size:12px; }
        .slash-preview-stage { flex:1; min-height:0; display:grid; }
        .slash-preview-result { margin:0; padding:10px 20px; border-top:1px solid var(--gyro-border-soft); font-size:12px; color:var(--gyro-muted); }
      `}</style>
      <nav className="slash-preview-controls" aria-label="Preview fixture controls">
        <strong>Slash menu · component fixture</strong>
        <button aria-pressed={theme === "dark"} onClick={() => changeTheme("dark")}>Dark</button>
        <button aria-pressed={theme === "light"} onClick={() => changeTheme("light")}>Light</button>
        <button onClick={() => show("/")}>All commands</button>
        <button onClick={() => show("/permissions")}>Filter permissions</button>
        <button onClick={() => show("/help")}>Help command</button>
        <button aria-pressed={workspace} onClick={() => { setWorkspace(!workspace); show("/"); }}>Workspace commands</button>
      </nav>
      <p className="slash-preview-caption">Actual Gyro composer. Fixture actions stay in this preview. Type / to filter; use arrows, Enter, Tab, or Escape.</p>
      <main className="slash-preview-stage">
        <ChatSurface
          key={revision}
          config={config}
          events={[{
            id: "fixture-message",
            sessionId: "slash-preview",
            turnId: "fixture-turn",
            kind: "user-message",
            message: "Polish the command menu for both themes.",
            createdAt: new Date().toISOString(),
            payload: {},
          }]}
          draft={draft}
          onDraftChange={setDraft}
          chatMode="plan"
          workspacePath={workspace ? "/fixture/gyro-project" : undefined}
          sessionModel={{ modelLabel: "GPT-6.1 Sol" }}
          onComposerAction={(value) => setAction(value)}
          onSend={() => setAction("Fixture send")}
          shellReady
        />
      </main>
      <p className="slash-preview-result" role="status">Fixture action: {action}</p>
    </div>
  );
}

document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture />);
