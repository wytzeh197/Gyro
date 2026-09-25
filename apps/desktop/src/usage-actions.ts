import { useCallback, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  NotificationKind,
  ProviderId,
  ProviderLedgerSummary,
} from "@gyro-dev/ui";

type UsageActionsDeps = {
  notify: (kind: NotificationKind, title: string, detail: string) => void;
  /** Re-reads the pause/budget snapshot the composer banner renders. */
  refreshUsageSafety: () => Promise<void>;
  setProviderLedgerById: Dispatch<
    SetStateAction<Partial<Record<ProviderId, ProviderLedgerSummary>>>
  >;
};

/**
 * The actions behind Usage Limits and the pause banner.
 *
 * Each one writes through a native command and then re-reads what the write
 * changed, so they are a domain of their own rather than component state. They
 * live here rather than in `App.tsx` because that file sits at its architecture
 * ceiling, and a setting that belongs to them must be addable without growing
 * the file that wires every surface.
 */
export function useUsageActions({
  notify,
  refreshUsageSafety,
  setProviderLedgerById,
}: UsageActionsDeps) {
  const refreshProviderLedger = useCallback(
    async (providerId: ProviderId) => {
      try {
        const summary = await invoke<ProviderLedgerSummary>(
          "get_provider_usage_ledger",
          { providerId },
        );
        setProviderLedgerById((current) => ({
          ...current,
          [providerId]: summary,
        }));
      } catch {
        // Settings falls back to the reference denominator.
      }
    },
    [setProviderLedgerById],
  );
  const setProviderBudget = useCallback(
    async (providerId: ProviderId, maxTokens: number) => {
      try {
        await invoke("set_provider_budget", { providerId, maxTokens });
        await refreshProviderLedger(providerId);
      } catch (error) {
        notify(
          "provider",
          "Could not save the budget",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [notify, refreshProviderLedger],
  );
  const setUsagePaused = useCallback(
    async (paused: boolean) => {
      try {
        await invoke("set_usage_paused", { paused });
        await refreshUsageSafety();
      } catch (error) {
        notify(
          "provider",
          paused ? "Could not pause" : "Could not resume",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [notify, refreshUsageSafety],
  );
  const resumeUsage = useCallback(async () => {
    try {
      await invoke("set_usage_paused", { paused: false });
      await refreshUsageSafety();
    } catch (error) {
      notify(
        "provider",
        "Could not resume",
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [notify, refreshUsageSafety]);
  return {
    refreshProviderLedger,
    setProviderBudget,
    setUsagePaused,
    resumeUsage,
  };
}
