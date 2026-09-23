import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
/** Readings the backend pushes: mid-turn plan checks and other windows' polls. */
const PROVIDER_USAGE_UPDATED_EVENT = "gyro://provider-usage-updated";

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
  // A fresh read asked for while another is in flight runs once that one
  // lands: the earlier request may predate the spend it was asked to show.
  const providerUsageFreshQueuedRef = useRef(new Set<ProviderId>());
  const refreshProviderUsage = useCallback(
    async (
      providerId: ProviderId,
      showFailureNotification = false,
      fresh = false,
    ): Promise<void> => {
      if (providerUsageInFlightRef.current.has(providerId)) {
        if (fresh) providerUsageFreshQueuedRef.current.add(providerId);
        return;
      }
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
          { providerId, fresh },
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
        if (providerUsageFreshQueuedRef.current.delete(providerId)) {
          void refreshProviderUsage(providerId, false, true);
        }
      }
    },
    [notify],
  );

  // A pushed reading replaces the shown one only when it is at least as new,
  // so a slow poll landing late cannot roll a live figure back.
  useEffect(() => {
    if (!hasDesktopRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ProviderUsageSnapshot>(PROVIDER_USAGE_UPDATED_EVENT, (event) => {
      const snapshot = event.payload;
      if (!snapshot?.providerId) return;
      setProviderUsageByProvider((current) => {
        const previous = current[snapshot.providerId];
        const previousMs = previous?.fetchedAt
          ? Date.parse(previous.fetchedAt)
          : Number.NaN;
        const nextMs = Date.parse(snapshot.fetchedAt);
        if (
          previous?.status === "available" &&
          !previous.stale &&
          Number.isFinite(previousMs) &&
          (!Number.isFinite(nextMs) || nextMs < previousMs)
        ) {
          return current;
        }
        return {
          ...current,
          [snapshot.providerId]: providerUsageFromSnapshot(snapshot),
        };
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (
      backgroundUsageProviderIds.length === 0 &&
      backgroundLedgerProviderIds.length === 0
    ) {
      return undefined;
    }
    const refreshInBackground = () => {
      // Background polling should not wake provider CLIs in a hidden window
      // or retry the network while offline. Focus/online events catch up.
      if (document.visibilityState !== "visible" || navigator.onLine === false)
        return;
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
    window.addEventListener("online", refreshInBackground);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshInBackground);
      window.removeEventListener("online", refreshInBackground);
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
