import { useCallback, useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  applyGoogleModelDiscovery,
  providersForConfig,
  type GoogleModelDiscovery,
  type GyroConfig,
  type ProviderId,
} from "@gyro-dev/ui";

/** Discover once after connection; explicit refresh retries failed metadata checks. */
export function useGoogleModels(
  config: GyroConfig,
  setConfig: (update: (current: GyroConfig) => GyroConfig) => void,
  optimizing: boolean,
) {
  const current = useRef(config);
  current.current = config;
  const pending = useRef(
    new Map<string, Promise<GoogleModelDiscovery | undefined>>(),
  );
  const checked = useRef(new Set<string>());
  const scopeKey = JSON.stringify(
    providersForConfig(config)
      .filter(
        (provider) => provider.id === "antigravity",
      )
      .map((provider) => [
        provider.id,
        provider.enabled,
        provider.authStatus,
        provider.apiKeyRef,
      ]),
  );

  const refresh = useCallback(
    async (providerId: ProviderId, force = false) => {
      if (
        !isTauri() ||
        (providerId !== "antigravity")
      )
        return undefined;
      const provider = providersForConfig(current.current).find(
        (item) => item.id === providerId,
      );
      if (!provider) return undefined;
      const key = JSON.stringify([
        provider.id,
        provider.enabled,
        provider.authStatus,
        provider.apiKeyRef,
      ]);
      const running = pending.current.get(key);
      if (running) return running;
      if (!force && checked.current.has(key)) return undefined;
      checked.current.add(key);
      const request = invoke<GoogleModelDiscovery>(
        "discover_google_models_command",
        { providerId },
      )
        .then((discovery) => {
          setConfig((saved) => {
            const latest = providersForConfig(saved).find(
              (item) => item.id === providerId,
            );
            if (
              !latest ||
              latest.enabled !== provider.enabled ||
              latest.authStatus !== provider.authStatus ||
              latest.apiKeyRef !== provider.apiKeyRef
            )
              return saved;
            return applyGoogleModelDiscovery(saved, providerId, discovery);
          });
          return discovery;
        })
        .catch(() => undefined)
        .finally(() => pending.current.delete(key));
      pending.current.set(key, request);
      return request;
    },
    [setConfig],
  );

  useEffect(() => {
    if (optimizing || !isTauri()) return;
    for (const provider of providersForConfig(current.current)) {
      if (
        (provider.id === "antigravity") &&
        provider.enabled &&
        provider.authStatus === "connected"
      )
        void refresh(provider.id);
    }
  }, [scopeKey, optimizing, refresh]);
  return refresh;
}
