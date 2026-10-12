// Actual split panes and composers. Provider connections are labeled fixture data.
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatGridSurface, ChatSurface, createChatProjectLayout, providersForConfig,
  type GyroConfig,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const empty: GyroConfig = {
  commandProfiles: [], modelProviders: [], telemetryEnabled: false,
  requireCommandApproval: true, requireFileEditApproval: true,
};
const config: GyroConfig = {
  ...empty,
  selectedProviderId: "openai",
  modelProviders: providersForConfig(empty).map((provider) => ({
    ...provider,
    enabled: provider.id === "openai" || provider.id === "anthropic",
    authStatus: provider.id === "openai" || provider.id === "anthropic"
      ? "connected" : provider.authStatus,
  })),
};
const projectKey = "/fixture/Gyro";
const openai = config.modelProviders.find((provider) => provider.id === "openai")!;

function Preview() {
  const [count, setCount] = useState(3);
  const [arrangement, setArrangement] = useState<
    NonNullable<ReturnType<typeof createChatProjectLayout>["arrangement"]>
  >("columns");
  const [active, setActive] = useState("pane-1");
  const [width, setWidth] = useState(1280);
  const [theme, setTheme] = useState("dark");
  const [action, setAction] = useState("No model chosen");
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const layout = {
    ...createChatProjectLayout(projectKey),
    focusedPaneId: active,
    arrangement,
    slots: Array.from({ length: 4 }, (_, index) => index < count ? {
      paneId: `pane-${index}`, kind: "session" as const,
      sessionId: `session-${index}`, workspacePath: projectKey,
    } : null),
  };
  return (
    <div className="model-split-preview">
      <style>{`
        .model-split-preview { height:100dvh;display:flex;flex-direction:column;background:var(--gyro-app);color:var(--gyro-text);font-family:var(--gyro-font-sans); }
        .model-split-controls { display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px;font-size:12px;border-bottom:1px solid var(--gyro-border-soft); }
        .model-split-controls strong { margin-right:auto; }
        .model-split-controls button { border:1px solid var(--gyro-border);border-radius:6px;background:var(--gyro-surface);color:inherit;font:inherit;padding:5px 8px; }
        .model-split-controls button[aria-pressed=true] { border-color:var(--gyro-accent); }
        .model-split-controls label { display:flex;align-items:center;gap:6px; }
        .model-split-stage { flex:1;min-height:0;min-width:0;overflow:auto; }
        .model-split-window { height:100%;max-width:100%;margin:auto; }
        .model-split-result { padding:8px 12px;margin:0;font-size:12px;color:var(--gyro-muted);border-top:1px solid var(--gyro-border-soft); }
      `}</style>
      <nav className="model-split-controls" aria-label="Split selector fixture controls">
        <strong>Model selector · actual split components</strong>
        {[1, 2, 3, 4].map((value) => <button key={value} aria-pressed={count === value} onClick={() => setCount(value)}>{value} pane{value === 1 ? "" : "s"}</button>)}
        {(["columns", "grid", "rows"] as const).map((value) => <button key={value} aria-pressed={arrangement === value} onClick={() => setArrangement(value)}>{value}</button>)}
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>Toggle theme</button>
        <label>Fixture width <input aria-label="Fixture width" type="range" min="600" max="1600" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
      </nav>
      <main className="model-split-stage">
        <div className="model-split-window" style={{ width }}>
          <ChatGridSurface
            layout={layout}
            onDropSession={() => false}
            onFocusPane={(pane) => setActive(pane.paneId)}
            onMovePane={() => false}
            onToggleMaximize={() => undefined}
            renderPane={(pane, options) => (
              <ChatSurface
                config={config}
                events={[{
                  id: `message-${pane.paneId}`,
                  sessionId: pane.kind === "session" ? pane.sessionId : "",
                  kind: "user-message", createdAt: "2026-10-12T10:00:00Z",
                  message: "Open the model selector, then resize this split layout.",
                  payload: {},
                }]}
                paneKey={pane.paneId}
                sessionTitle={`Fixture ${pane.paneId}`}
                workspacePath={projectKey}
                sessionModel={{ providerId: "openai", modelId: openai.selectedModelId }}
                isTiled={options.isTiled}
                onPaneDragStart={options.onPaneDragStart}
                onPaneDragEnd={options.onPaneDragEnd}
                onPanePointerDown={options.onPanePointerDown}
                onComposerAction={(value) => setAction(value)}
                onSend={() => undefined}
                shellReady
              />
            )}
          />
        </div>
      </main>
      <p className="model-split-result" role="status">Fixture providers: OpenAI and Anthropic. Actions stay local. {action}</p>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
