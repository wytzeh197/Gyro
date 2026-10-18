import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  SettingsSurface,
  type GyroConfig,
  type ThemeMode,
  type SessionEvent,
} from "@gyro-dev/ui";
import { EfficiencyDetails } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
const sample: SessionEvent[] = [
  {
    id: "receipt",
    sessionId: "chat",
    createdAt: "2026-10-12T12:00:00Z",
    kind: "system-event",
    message: "",
    payload: {
      kind: "efficiency-receipt",
      contextAttribution: {
        instructions: 2000,
        toolSchemas: 8000,
        sourceExcerpts: 1200,
        toolResults: 400,
        taskState: 700,
        history: 600,
        otherText: 200,
        hiddenContent: true,
      },
      estimatedCost: { currency: "USD", micros: 12345 },
      taskTotals: {
        calls: 3,
        failedCalls: 1,
        unpricedCalls: 0,
        verified: false,
      },
    },
  },
  {
    id: "cp",
    sessionId: "chat",
    createdAt: "2026-10-12T12:00:01Z",
    kind: "task-checkpoint",
    message: "Task checkpoint saved",
    payload: {
      version: 1,
      objective: "Fix reconnect without changing the public API",
      agentAssertions: { decisions: ["Approach A failed; try B"] },
      files: [{ path: "src/session.rs", availability: "stale; reread" }],
      verified: false,
    },
  },
];
function Fixture() {
  const initial =
    new URL(location.href).searchParams.get("theme") === "dark"
      ? "dark"
      : "light";
  const [theme, setTheme] = useState<ThemeMode>(initial);
  const [config, setConfig] = useState<GyroConfig>({
    telemetryEnabled: false,
    requireCommandApproval: true,
    requireFileEditApproval: true,
    modelProviders: [],
    commandProfiles: [],
  });
  document.documentElement.dataset.theme = theme;
  document.body.dataset.theme = theme;
  return (
    <main style={{ maxWidth: 1000, margin: "24px auto", padding: "0 20px" }}>
      <SettingsSurface
        config={config}
        activeSection="efficiency"
        themeMode={theme}
        onThemeChange={setTheme}
        onEfficiencyChange={async (efficiency) =>
          setConfig((current) => ({ ...current, efficiency }))
        }
        onEfficiencyRoute={async (phase) => {
          document.body.dataset.route = phase;
        }}
      />
      <EfficiencyDetails events={sample} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
