// Actual composer; model catalog and simulated backend readings are clearly labeled.
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatSurface, applyModelContextWindows, providersForConfig,
  type GyroConfig, type SessionEvent } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const empty: GyroConfig = { commandProfiles: [], modelProviders: [], telemetryEnabled: false,
  requireCommandApproval: true, requireFileEditApproval: true };
const initial: GyroConfig = { ...empty, modelProviders: providersForConfig(empty).map(provider => ({
  ...provider, enabled: true, authStatus: "connected" as const,
})) };
const choices = initial.modelProviders.flatMap(provider => provider.models.map(model => ({
  key: JSON.stringify([provider.id, model.id]), provider, model,
})));

function Preview() {
  const [selected, setSelected] = useState(choices.find(item => item.provider.id === "xai" && item.model.id === "grok-4.7")!.key);
  const [config, setConfig] = useState(initial);
  const [theme, setTheme] = useState("dark");
  const [used, setUsed] = useState(32_000);
  const [readings, setReadings] = useState<SessionEvent[]>([{
    id: "live-reading", sessionId: "context-fixture", turnId: "fixture-turn",
    kind: "system-event", createdAt: new Date().toISOString(), message: "",
    payload: { kind: "provider-context-usage", providerId: "xai", modelId: "grok-4.7",
      contextWindowSource: "catalog",
      contextUsage: { inputTokens: 32_000, totalTokens: 32_000, modelContextWindow: 500_000 } },
  }]);
  const choice = choices.find(item => item.key === selected)!;
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; delete document.documentElement.dataset.nativeMaterial; }, [theme]);
  const selectedConfig = { ...config, selectedProviderId: choice.provider.id,
    modelProviders: config.modelProviders.map(provider => provider.id === choice.provider.id
      ? { ...provider, selectedModelId: choice.model.id } : provider) };
  const update = (runtime = false) => {
    const tokens = runtime ? 128_000 : used + 8_000;
    const window = runtime ? 128_000
      : providersForConfig(selectedConfig).find(provider => provider.id === choice.provider.id)!
          .models.find(model => model.id === choice.model.id)?.contextWindowTokens;
    const nextUsed = runtime ? 50_000 : Math.min(tokens, window ?? tokens);
    const checkedAt = new Date().toISOString();
    if (runtime) setConfig(current => applyModelContextWindows(current, [{
      providerId: choice.provider.id, modelId: choice.model.id,
      contextWindowTokens: window, source: "runtime", checkedAt,
    }]));
    setUsed(nextUsed);
    setReadings([{
      id: "live-reading", sessionId: "context-fixture", turnId: "fixture-turn",
      kind: "system-event", createdAt: checkedAt, message: "",
      payload: { kind: "provider-context-usage", providerId: choice.provider.id,
        modelId: choice.model.id, contextWindowSource: "runtime",
        contextUsage: { inputTokens: nextUsed, totalTokens: nextUsed, modelContextWindow: window } },
    }]);
  };
  return <main className="context-window-preview">
    <style>{`
      .context-window-preview { height:100dvh;display:flex;flex-direction:column;background:var(--gyro-app);color:var(--gyro-text);font-family:var(--gyro-font-sans); }
      .context-window-preview > header { padding:12px;display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:12px;border-bottom:1px solid var(--gyro-border); }
      .context-window-preview > header select,.context-window-preview > header button { background:var(--gyro-surface);color:inherit;border:1px solid var(--gyro-border);border-radius:6px;padding:6px;font:inherit; }
      .context-window-preview-stage { flex:1;min-height:0; }
      .context-window-preview-stage > .gyro-chat-surface { height:100%; }
      .context-window-preview *, .context-window-preview *::before, .context-window-preview *::after { animation:none !important;transition:none !important; }
      .context-window-preview > output { padding:10px;font-size:12px;color:var(--gyro-muted);border-top:1px solid var(--gyro-border); }
    `}</style>
    <header>
      <strong>Live context · actual composer / simulated readings</strong>
      <select aria-label="Fixture model" value={selected} onChange={event => setSelected(event.target.value)}>
        {choices.map(item => <option key={item.key} value={item.key}>{item.provider.displayName} · {item.model.displayName}</option>)}
      </select>
      <button onClick={() => update(true)}>Provider allocates 128K</button>
      <button onClick={() => update()}>Live usage +8K</button>
      <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>Toggle theme</button>
    </header>
    <section className="context-window-preview-stage">
      <ChatSurface config={selectedConfig} shellReady onSend={() => undefined}
        sessionTitle="Model context fixture"
        sessionModel={{ providerId: choice.provider.id, modelId: choice.model.id, modelLabel: choice.model.displayName }}
        events={[{ id:"fixture-message", sessionId:"context-fixture", kind:"user-message",
          createdAt:"2026-10-13T15:00:00Z", message:"Inspect the context ring beside the model selector.", payload:{} }, ...readings]}
        providerUsageByProvider={{ [choice.provider.id]: { providerId:choice.provider.id, status:"available" as const, fetchedAt:new Date().toISOString(),
          windows:[{ id:"weekly",label:"Weekly limit",usedPercent:20,status:"ok" as const }] } }}
      />
    </section>
    <output role="status">Fixture only: {choice.provider.displayName} / {choice.model.displayName}. Last simulated usage: {used.toLocaleString()} tokens. Hover the context ring.</output>
  </main>;
}
if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Preview />);
