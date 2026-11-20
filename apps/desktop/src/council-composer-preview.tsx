// Standalone fixture for the Council composer bar; preset toggles update local state.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  normalizedCouncilConfig,
  providersForConfig,
  readyCouncilProviders,
  resolveCouncilSeatRequests,
  toggleCouncilActivePreset,
  type GyroConfig,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import { COUNCIL_TOGGLE_PRESET_ACTION, CouncilPreflight } from "../../../packages/ui/src/council-composer";

const connected = ["anthropic", "openai", "google"];
const baseConfig: GyroConfig = {
  commandProfiles: [],
  modelProviders: [],
  requireCommandApproval: false,
  requireFileEditApproval: false,
  telemetryEnabled: false,
};
const initial: GyroConfig = {
  ...baseConfig,
  modelProviders: providersForConfig(baseConfig).map((provider) =>
    connected.includes(provider.id) ? { ...provider, enabled: true, authStatus: "connected" } : provider,
  ),
  council: { ...normalizedCouncilConfig(undefined), enabled: true, activePresetIds: ["backend", "frontend"] },
};

function Preview() {
  const [config, setConfig] = useState(initial);
  const resolution = resolveCouncilSeatRequests(config, readyCouncilProviders(config));
  return (
    <main className="gyro-app" data-theme={new URLSearchParams(location.search).get("theme") ?? "dark"}
      style={{ minHeight: "100vh", padding: 40, background: "var(--gyro-pane)" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <CouncilPreflight config={config} costLabel="~$0.08" enabled resolution={resolution}
          onAction={(action) => {
            if (!action.startsWith(COUNCIL_TOGGLE_PRESET_ACTION)) return;
            const id = action.slice(COUNCIL_TOGGLE_PRESET_ACTION.length);
            setConfig((current) => ({ ...current, council: toggleCouncilActivePreset(normalizedCouncilConfig(current.council), id) }));
          }} />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
