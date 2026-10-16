// Standalone production marker. Every event below is labeled fixture data.
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionEvent } from "@gyro-dev/ui";
import { ModelSwitchMarker } from "../../../packages/ui/src/surfaces";
import "@gyro-dev/ui/styles.css";

const fixtures = [
  {
    label: "Grok → GPT",
    message: "Switched to GPT-6.1 Sol",
    payload: {
      previousProviderId: "xai", previousModelId: "grok-4.20",
      providerId: "openai", modelId: "gpt-6.1-sol", modelLabel: "GPT-6.1 Sol",
    },
  },
  {
    label: "GPT → Claude",
    message: "Switched to Claude Sonnet 4.6",
    payload: {
      previousProviderId: "openai", previousModelId: "gpt-6.1-sol",
      providerId: "anthropic", modelId: "claude-sonnet-4.6", modelLabel: "Claude Sonnet 4.6",
    },
  },
  {
    label: "Same family · GPT Sol → GPT Astra",
    message: "Switched to GPT-6.1 Astra",
    payload: {
      previousProviderId: "openai", previousModelId: "gpt-6.1-sol",
      providerId: "openai", modelId: "gpt-6.1-astra", modelLabel: "GPT-6.1 Astra",
    },
  },
  {
    label: "Gateway · Claude → Grok through OpenRouter",
    message: "Switched to Grok 4.20",
    payload: {
      previousProviderId: "openrouter", previousModelId: "anthropic/claude-sonnet-4.6",
      providerId: "openrouter", modelId: "x-ai/grok-4.20", modelLabel: "Grok 4.20",
    },
  },
  {
    label: "Custom endpoint · monogram fallback and long label",
    message: "Switched to My studio experimental model with an extended display name",
    payload: {
      previousProviderId: "gemini", previousModelId: "gemini-3.8-flash",
      providerId: "custom:studio", providerLabel: "My studio", modelId: "studio-experimental",
    },
  },
  {
    label: "First selection · destination only",
    message: "Model set to GPT-6.1 Sol",
    payload: { providerId: "openai", modelId: "gpt-6.1-sol" },
  },
  {
    label: "Legacy event · missing previous identity",
    message: "Switched to GPT-6 Sol",
    payload: { modelId: "gpt-6-sol" },
  },
  {
    label: "Selection cleared · text fallback",
    message: "Model selection cleared",
    payload: { previousProviderId: "openai", previousModelId: "gpt-6.1-sol" },
  },
];

function Preview() {
  const [theme, setTheme] = useState("dark");
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <main className="model-switch-preview">
      <style>{`
        html, body, #root { margin: 0; min-height: 100%; }
        .model-switch-preview { min-height: 100dvh; box-sizing: border-box; padding: 24px; background: var(--gyro-app); color: var(--gyro-text); font-family: var(--gyro-font-sans); }
        .model-switch-preview header { max-width: 900px; margin: 0 auto 28px; }
        .model-switch-preview h1 { margin: 0 0 8px; font-size: 18px; }
        .model-switch-preview p, .model-switch-preview h2 { color: var(--gyro-muted); font-size: 12px; font-weight: 400; }
        .model-switch-preview button { margin-right: 8px; padding: 7px 10px; border: 1px solid var(--gyro-border-soft); border-radius: 6px; background: var(--gyro-surface); color: inherit; cursor: pointer; }
        .model-switch-fixtures { max-width: 900px; margin: auto; }
        .model-switch-fixtures section { margin: 0 auto 24px; max-width: 100%; }
        .model-switch-fixtures .gyro-chat-transcript { display: block; overflow: visible; padding: 0; }
        .model-switch-fixtures .gyro-model-switch-marker { margin: 12px 0 0; max-width: none; }
      `}</style>
      <header>
        <h1>Model switch · production component fixtures</h1>
        <p>Local sample events only. No provider connections or native app calls.</p>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>Toggle theme</button>
        <button aria-pressed={narrow} onClick={() => setNarrow(!narrow)}>Narrow layout</button>
      </header>
      <div className="model-switch-fixtures">
        {fixtures.map((fixture, index) => {
          const event: SessionEvent = {
            id: `switch-${index}`, sessionId: "fixture-session",
            kind: "system-event", createdAt: "2026-10-16T10:00:00Z",
            message: fixture.message, payload: { kind: "model-switch", ...fixture.payload },
          };
          return (
            <section key={event.id} style={{ width: narrow ? 280 : "100%" }}>
              <h2>{fixture.label}</h2>
              <div className="gyro-chat-transcript"><ModelSwitchMarker event={event} /></div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Preview />);
