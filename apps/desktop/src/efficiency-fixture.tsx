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
        retiredBytes: 2048,
        retirementAccountingVersion: 2,
        efficiencyEvents: {
          catalogDiscoveries: 2,
          catalogRediscoveries: 1,
          catalogFallbacks: 0,
          spillRecoveries: 3,
          spillFailures: 1,
          repeatedCallNotices: 1,
          repeatedCallPauses: 0,
        },
        generationAttempts: {
          started: 3,
          completed: 2,
          rejected: 1,
          retries: 1,
        },
        toolClassCounts: { "workspace-read": 2, terminal: 1 },
      },
      estimatedCost: { currency: "USD", micros: 12345 },
      usageTokens: { cachedInputTokens: 1000 },
      usageAccounting: {
        source: "provider",
        coverage: "complete",
        known: { cacheRead: true },
      },
      taskTotals: {
        calls: 3,
        failedCalls: 1,
        unpricedCalls: 0,
        verified: false,
        retiredBytes: 2048,
        retirementCoverage: "complete",
        generationAttempts: {
          started: 3,
          completed: 2,
          rejected: 1,
          retries: 1,
        },
        generationCoverage: "complete",
        toolClassCounts: { "workspace-read": 2, terminal: 1 },
        toolClassCoverage: "complete",
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
const legacy: SessionEvent[] = [
  {
    id: "legacy-receipt",
    sessionId: "legacy-chat",
    createdAt: "2026-10-12T11:00:00Z",
    kind: "system-event",
    message: "",
    payload: {
      kind: "efficiency-receipt",
      subscriptionBilling: true,
      contextAttribution: { retiredBytes: 0, hiddenContent: true },
      taskTotals: {
        calls: 1,
        failedCalls: 0,
        unpricedCalls: 1,
        verified: false,
        retiredBytes: 0,
      },
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
      <EfficiencyDetails events={legacy} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
