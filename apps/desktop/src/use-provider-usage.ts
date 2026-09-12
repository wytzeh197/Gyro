import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  providerSupportsUsage,
  type ProviderId,
  type ProviderUsageState,
} from "@gyro-dev/ui";
import {
  providerUsageFromSnapshot,
  providerUsageAfterError,
  type ProviderUsageSnapshot,
} from "./provider-usage-state";

const PROVIDER_USAGE_REFRESH_INTERVAL_MS = 45_000;

export function useProviderUsage(options: {
  notify: (kind: "command-failed", title: string, detail: string) => void;
  backgroundUsageProviderIds: ProviderId[];
  backgroundLedgerProviderIds: ProviderId[];
  refreshProviderLedger: (providerId: ProviderId) => Promise<void>;
}) {
  const {
    notify,
    backgroundUsageProviderIds,
    backgroundLedgerProviderIds,
    refreshProviderLedger,
  } = options;
  const [providerUsageByProvider, setProviderUsageByProvider] = useState<
    Partial<Record<ProviderId, ProviderUsageState>>
  >({});
  const providerUsageRequestRef = useRef<Partial<Record<ProviderId, number>>>(
    {},
  );
  const providerUsageInFlightRef = useRef(new Set<ProviderId>());
  const refreshProviderUsage = useCallback(
    async (providerId: ProviderId, showFailureNotification = false) => {
      if (providerUsageInFlightRef.current.has(providerId)) return;
      const request = (providerUsageRequestRef.current[providerId] ?? 0) + 1;
      providerUsageRequestRef.current[providerId] = request;
      setProviderUsageByProvider((current) => ({
        ...current,
        [providerId]: {
          providerId,
          status: current[providerId]?.windows.length ? "available" : "loading",
          windows: current[providerId]?.windows ?? [],
          fetchedAt: current[providerId]?.fetchedAt,
          stale: current[providerId]?.stale,
        },
      }));

      if (!providerSupportsUsage(providerId)) {
        setProviderUsageByProvider((current) => ({
          ...current,
          [providerId]: {
            providerId,
            status: "unavailable",
            windows: [],
            // No plan windows (5h/weekly) on this account type — spend is the ledger.
            error: undefined,
          },
        }));
        return;
      }

      if (!hasDesktopRuntime()) {
        setProviderUsageByProvider((current) => ({
          ...current,
          [providerId]: {
            providerId,
            status: "unavailable",
            windows: [],
            error: "Live account usage is available in the Gyro desktop app.",
          },
        }));
        return;
      }

      providerUsageInFlightRef.current.add(providerId);
      try {
        const snapshot = await invoke<ProviderUsageSnapshot>(
          "get_provider_usage",
          { providerId },
        );
        if (request !== providerUsageRequestRef.current[providerId]) return;
        setProviderUsageByProvider((current) => ({
          ...current,
          [providerId]: providerUsageFromSnapshot(snapshot),
        }));
      } catch (error) {
        if (request !== providerUsageRequestRef.current[providerId]) return;
        const detail = String(error);
        setProviderUsageByProvider((current) => ({
          ...current,
          [providerId]: providerUsageAfterError(
            providerId,
            current[providerId],
            detail,
          ),
        }));
        if (showFailureNotification) {
          notify(
            "command-failed",
            "Provider usage could not be loaded",
            detail,
          );
        }
      } finally {
        providerUsageInFlightRef.current.delete(providerId);
      }
    },
    [notify],
  );

  useEffect(() => {
    if (
      backgroundUsageProviderIds.length === 0 &&
      backgroundLedgerProviderIds.length === 0
    ) {
      return undefined;
    }
    const refreshInBackground = () => {
      for (const providerId of backgroundUsageProviderIds) {
        void refreshProviderUsage(providerId);
      }
      for (const providerId of backgroundLedgerProviderIds) {
        void refreshProviderLedger(providerId);
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        refreshInBackground();
      }
    };
    refreshInBackground();
    const interval = window.setInterval(
      refreshInBackground,
      PROVIDER_USAGE_REFRESH_INTERVAL_MS,
    );
    window.addEventListener("focus", refreshInBackground);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshInBackground);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [
    backgroundLedgerProviderIds,
    backgroundUsageProviderIds,
    refreshProviderLedger,
    refreshProviderUsage,
  ]);

  return { providerUsageByProvider, refreshProviderUsage };
}

function hasDesktopRuntime() {
  return "__TAURI_INTERNALS__" in window;
}
