// Actual composers with labeled connections; no provider updates or IPC run here.
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatSurface, providersForConfig, type GyroConfig } from "@gyro-dev/ui";
import { isComposerCliUpdating } from "./cli-update-scope";
import "@gyro-dev/ui/styles.css";

const empty: GyroConfig = {
  commandProfiles: [], modelProviders: [], telemetryEnabled: false,
  requireCommandApproval: true, requireFileEditApproval: true,
};
const config: GyroConfig = {
  ...empty,
  // Deliberately different from the left chat's bound provider.
  selectedProviderId: "xai",
  modelProviders: providersForConfig(empty).map((provider) => ({
    ...provider,
    enabled: provider.id === "openai" || provider.id === "xai",
    authStatus: provider.id === "openai" || provider.id === "xai"
      ? "connected" : provider.authStatus,
  })),
};
function Preview() {
  const [updatingIds, setUpdatingIds] = useState<readonly string[]>(["xai"]);
  const [theme, setTheme] = useState("dark");
  const [lastSend, setLastSend] = useState("No messages sent");
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return (
    <div className="cli-scope-preview">
      <style>{`
        .cli-scope-preview { height:100dvh;display:flex;flex-direction:column;background:var(--gyro-app);color:var(--gyro-text);font-family:var(--gyro-font-sans); }
        .cli-scope-controls { display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px;font-size:12px;border-bottom:1px solid var(--gyro-border-soft); }
        .cli-scope-controls strong { margin-right:auto; }
        .cli-scope-controls button { border:1px solid var(--gyro-border);border-radius:6px;background:var(--gyro-surface);color:inherit;font:inherit;padding:5px 8px; }
        .cli-scope-panes { flex:1;min-height:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr)); }
        .cli-scope-pane { min-height:0;min-width:0;overflow:hidden; }
        .cli-scope-pane + .cli-scope-pane { border-left:1px solid var(--gyro-border); }
        .cli-scope-result { padding:8px 12px;margin:0;font-size:12px;color:var(--gyro-muted);border-top:1px solid var(--gyro-border-soft); }
      `}</style>
      <nav className="cli-scope-controls" aria-label="Provider update fixture controls">
        <strong>Provider updates · actual composer fixtures</strong>
        <button onClick={() => setUpdatingIds(["xai"])}>Update Grok</button>
        <button onClick={() => setUpdatingIds(["openai"])}>Update OpenAI</button>
        <button onClick={() => setUpdatingIds(["openai", "xai"])}>Update both</button>
        <button onClick={() => setUpdatingIds([])}>Finish update</button>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>Toggle theme</button>
      </nav>
      <main className="cli-scope-panes">
        {(["openai", "xai"] as const).map((providerId) => {
          const sessionModel = {
            providerId,
            modelId: providerId === "openai" ? "gpt-6.1-sol" : "grok-4.7",
          };
          const name = providerId === "openai" ? "ChatGPT / OpenAI" : "Grok";
          return <section key={providerId} className="cli-scope-pane" data-provider={providerId} aria-label={name}>
            <ChatSurface
              config={config}
              sessionModel={sessionModel}
              paneKey={providerId}
              sessionTitle={name}
              workspacePath="/fixture/Gyro"
              isTiled
              isCliUpdating={isComposerCliUpdating(updatingIds, sessionModel, config.selectedProviderId)}
              events={[{
                id: providerId, sessionId: providerId, kind: "user-message",
                createdAt: "2026-10-12T10:00:00Z", payload: {},
                message: providerId === "openai"
                  ? "This chat uses ChatGPT. Updating Grok should let me keep sending here."
                  : "This chat uses Grok. Sending pauses only while Grok is updating.",
              }]}
              onComposerAction={() => undefined}
              onSend={(message) => setLastSend(name + ": " + message)}
              shellReady
            />
          </section>;
        })}
      </main>
      <p className="cli-scope-result" role="status">Simulated connected providers. Updating: {updatingIds.join(", ") || "none"}. Global default: Grok. {lastSend}</p>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
