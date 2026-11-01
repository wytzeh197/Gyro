// Production ChatSurface; model choices and context usage are labeled local fixtures.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatSurface,
  providersForConfig,
  createModelCatalogClient,
  applyGoogleModelDiscovery,
  type GyroConfig,
  type ProviderId,
  type ReasoningEffort,
} from "@gyro-dev/ui";
import catalog from "../../../site/model-catalog.json";
import "@gyro-dev/ui/styles.css";

// Restore a local catalog through the same exported client used by the app.
createModelCatalogClient(
  {
    getItem: (key) => (key.endsWith(".bucket") ? "0" : JSON.stringify(catalog)),
    setItem: () => undefined,
  },
  async () => JSON.stringify(catalog),
  () => 0,
).restore();
const empty: GyroConfig = {
  commandProfiles: [],
  modelProviders: [],
  requireCommandApproval: true,
  requireFileEditApproval: true,
  telemetryEnabled: false,
};
// Antigravity inventory fixture: labels only, no inferred context or effort.
const googleFixture = applyGoogleModelDiscovery(empty, "antigravity", {
  models: [{ id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash (discovery fixture)" }],
  currentModelId: "gemini-3.8-flash",
});
const providers = providersForConfig(googleFixture).map((p) => ({
  ...p,
  enabled: true,
  authStatus: "connected" as const,
}));
function Preview() {
  const [selection, setSelection] = useState({
    providerId: "openai" as ProviderId,
    modelId: "gpt-6.1-sol",
    reasoningEffort: "low" as ReasoningEffort | undefined,
  });
  const [draft, setDraft] = useState("");
  const provider = providers.find((p) => p.id === selection.providerId)!;
  const model = provider.models.find((m) => m.id === selection.modelId)!;
  const choose = (providerId: ProviderId, modelId: string) => {
    const model = providers
      .find((p) => p.id === providerId)!
      .models.find((m) => m.id === modelId)!;
    setSelection({
      providerId,
      modelId,
      reasoningEffort: model.defaultReasoningEffort,
    });
  };
  const config: GyroConfig = {
    ...empty,
    selectedProviderId: provider.id,
    modelProviders: providers.map((p) =>
      p.id === provider.id
        ? {
            ...p,
            selectedModelId: model.id,
            selectedReasoningEffort: selection.reasoningEffort,
          }
        : p,
    ),
  };
  return (
    <main
      className="model-metadata-preview"
      style={{
        height: "100dvh",
        display: "grid",
        gridTemplateRows: "auto minmax(0,1fr)",
        background: "var(--gyro-app)",
        color: "var(--gyro-text)",
        fontFamily: "var(--gyro-font-sans)",
      }}
    >
      <style>{`html,body,#root {height:100%;overflow:hidden} .model-metadata-preview > .gyro-chat-surface {min-height:0;height:100%}`}</style>
      <header
        style={{ padding: 16, borderBottom: "1px solid var(--gyro-border)" }}
      >
        <strong>
          Model metadata fixtures · production composer · no provider requests
        </strong>
        <p>
          Use the model menu below to inspect context labels and effort choices.
        </p>
        <select
          aria-label="Model fixture"
          value={provider.id + "|" + model.id}
          onChange={(e) => {
            const [p, m] = e.target.value.split("|");
            if (p && m) choose(p as ProviderId, m);
          }}
        >
          {providers.flatMap((p) =>
            p.models.map((m) => (
              <option key={p.id + "|" + m.id} value={p.id + "|" + m.id}>
                {p.displayName}: {m.displayName}
              </option>
            )),
          )}
        </select>
        <p role="status">
          {model.displayName} ·{" "}
          {model.contextWindowTokens?.toLocaleString() ?? "Unknown"} token
          catalog context · effort {selection.reasoningEffort ?? "Unavailable"}
        </p>
      </header>
      <ChatSurface
        key={provider.id + "|" + model.id}
        events={[]}
        config={config}
        draft={draft}
        onDraftChange={setDraft}
        onSend={() => undefined}
        dailyPaceWarning={false}
        shellReady
        sessionModel={{
          ...selection,
          modelLabel: model.displayName,
          providerLabel: provider.displayName,
        }}
        onComposerAction={(action) => {
          if (action.startsWith("select-provider-model:")) {
            const [, p, ...m] = action.split(":");
            choose(p as ProviderId, m.join(":"));
          } else if (action.startsWith("select-provider-effort:")) {
            const effort = action.split(":").at(-1) as ReasoningEffort;
            setSelection({ ...selection, reasoningEffort: effort });
          }
        }}
      />
    </main>
  );
}
if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(<Preview />);
