// Standalone production-component fixture; actions are recorded locally.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatSurface, createModelCatalogClient, providersForConfig, type ChatMode, type ComposerReviewer, type GyroConfig } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import catalog from "../../../catalog/model-catalog.json";

const reviewerPreview = new URLSearchParams(location.search).has("reviewer");
if (reviewerPreview) {
  createModelCatalogClient({
    getItem: key => key.endsWith(".bucket") ? "0" : JSON.stringify(catalog),
    setItem: () => undefined,
  }, async () => JSON.stringify(catalog), () => 0).restore();
}

const baseConfig: GyroConfig = {
  commandProfiles: [],
  modelProviders: [],
  requireCommandApproval: false,
  requireFileEditApproval: false,
  telemetryEnabled: false,
};

const config: GyroConfig = {
  ...baseConfig,
  selectedProviderId: "openai",
  modelProviders: providersForConfig(baseConfig).map((provider) =>
    (provider.id === "openai" || (reviewerPreview && ["anthropic", "deepseek", "mistral"].includes(provider.id))) ? { ...provider, enabled: true, authStatus: "connected" } : provider
  ),
};

function Fixture() {
  const [mode, setMode] = useState<ChatMode>("normal");
  const [theme, setTheme] = useState("dark");
  const [draft, setDraft] = useState("/");
  const [reviewer, setReviewer] = useState<ComposerReviewer>();
  const [revision, setRevision] = useState(0);
  const [workspace, setWorkspace] = useState(reviewerPreview);
  const [action, setAction] = useState("No action selected");
  const show = (value: string) => {
    setDraft(value);
    setReviewer(undefined);
    setRevision((current) => current + 1);
  };
  const changeTheme = (value: string) => {
    document.documentElement.dataset.theme = value;
    setTheme(value);
    if (reviewerPreview) setRevision(current => current + 1);
    else show("/");
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
          supportsSecondOpinion={reviewerPreview}
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
          draftReviewer={reviewer}
          onDraftChange={(text, selection) => {
            setDraft(text);
            setReviewer(selection);
          }}
          chatMode={mode}
          workspacePath={workspace ? "/fixture/gyro-project" : undefined}
          sessionModel={{ modelLabel: "GPT-6.1 Sol" }}
          onComposerAction={(value) => {
            setAction(value);
            if (value === "set-chat-mode-plan") setMode("plan");
            if (value === "set-chat-mode-normal") setMode("normal");
          }}
          onSend={(message, context) => {
            setAction(`Sent ${message}${context?.secondOpinion ? " · Reviewer: " + context.secondOpinion.modelId : ""}`);
            setDraft("");
            setReviewer(undefined);
          }}
          shellReady
        />
      </main>
      <p className="slash-preview-result" role="status">Fixture action: {action}</p>
    </div>
  );
}

document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture />);
