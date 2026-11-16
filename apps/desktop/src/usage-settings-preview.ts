import { useState } from "react";
import type { ComponentProps } from "react";
import {
  SettingsSurface,
  type ProviderId,
  type ProviderUsageState,
  type ProviderLedgerSummary,
  type SessionUsageTotals,
} from "@gyro-dev/ui";

/** Explicit opt-in fixtures only; never queries or changes a real provider. */
export function useUsageSettingsPreview(
  scene: string | null,
): Partial<ComponentProps<typeof SettingsSurface>> {
  const [providerId, setProviderId] = useState<ProviderId>("openai");
  const [visualization, setVisualization] = useState<"bars" | "wheels">("bars");
  const [warning, setWarning] = useState(true);
  const [paused, setPaused] = useState(false);
  const [budgets, setBudgets] = useState<Partial<Record<ProviderId, number>>>(
    {},
  );
  const [refreshed, setRefreshed] = useState(false);
  if (!scene) return {};
  const empty = scene === "empty";
  const mixed = scene === "estimated";
  const missing = scene === "missing";
  const factor = providerId === "anthropic" ? 2 : 1;
  const totals = (scale: number): SessionUsageTotals => ({
    calls: empty ? 0 : 12,
    measuredCalls: empty || missing ? 0 : mixed ? 8 : 12,
    estimatedCalls: !empty && mixed ? 2 : 0,
    partialCalls: !empty && mixed ? 1 : 0,
    unavailableCalls: !empty && missing ? 12 : !empty && mixed ? 1 : 0,
    inputTokens: empty || missing ? 0 : 80_000 * scale * factor,
    outputTokens: empty || missing ? 0 : 20_000 * scale * factor,
    cachedInputTokens: empty || missing ? 0 : 40_000 * scale * factor,
    totalTokens: empty || missing ? 0 : 100_000 * scale * factor,
    byOrigin: [],
  });
  const maxTokens = budgets[providerId] ?? 0;
  const budget = maxTokens
    ? {
        providerId,
        maxTokens,
        usedTokens: totals(3).totalTokens,
        percent: Math.min(100, (totals(3).totalTokens / maxTokens) * 100),
        level: "ok" as const,
        windowHours: 24,
        windowResetsAt: new Date(Date.now() + 86_400_000).toISOString(),
        hasEstimates: mixed,
      }
    : undefined;
  const ledger: ProviderLedgerSummary = {
    providerId,
    fiveHour: totals(1),
    day: totals(3),
    week: totals(10),
    dailyReferenceTokens: 1_000_000,
    budget,
  };
  const status: ProviderUsageState["status"] =
    !refreshed && scene === "loading"
      ? "loading"
      : !refreshed && scene === "error"
        ? "error"
        : "available";
  return {
    selectedUsageProviderId: providerId,
    onUsageProviderChange: setProviderId,
    usageVisualization: visualization,
    onUsageVisualizationChange: setVisualization,
    dailyPaceWarning: warning,
    onDailyPaceWarningChange: setWarning,
    onProviderBudgetChange: (id, value) =>
      setBudgets((current) => ({ ...current, [id]: value })),
    usageSafety: {
      pause: { active: paused, scope: "all", reason: { kind: "manual" } },
      budgets: budget ? [budget] : [],
    },
    onUsagePauseChange: setPaused,
    providerLedger: scene === "unavailable" ? undefined : ledger,
    providerUsage: {
      providerId,
      status,
      stale: scene === "stale" && !refreshed,
      error:
        status === "error" || (scene === "stale" && !refreshed)
          ? "Could not refresh. Try again."
          : undefined,
      fetchedAt: new Date().toISOString(),
      windows:
        ["empty", "unavailable", "loading", "error"].includes(scene) &&
        !refreshed
          ? []
          : [
              {
                id: "five-hour",
                label: "5-hour window",
                usedPercent: 35,
                resetsAt: new Date(Date.now() + 7_200_000).toISOString(),
              },
              {
                id: "weekly",
                label: "Weekly window",
                usedPercent: providerId === "anthropic" ? 85 : 62,
                resetsAt: new Date(Date.now() + 345_600_000).toISOString(),
              },
            ],
    },
    onRefreshProviderUsage: () => setRefreshed(true),
  };
}
