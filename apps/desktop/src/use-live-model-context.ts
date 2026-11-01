import { useCallback, useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  applyModelContextWindows, providersForConfig,
  type GyroConfig, type ModelContextWindow,
} from "@gyro-dev/ui";

/** Refresh metadata without delaying startup or changing the selected provider. */
export function useLiveModelContext(
  config: GyroConfig,
  setConfig: (update: (current: GyroConfig) => GyroConfig) => void,
  optimizing: boolean,
) {
  const current = useRef(config);
  current.current = config;
  const pending = useRef(new Map<string, Promise<ModelContextWindow[]>>());
  const scopeKey = JSON.stringify(providersForConfig(config).map((provider) => [
    provider.id, provider.baseUrl, provider.authStatus,
    provider.models.map((model) => model.id),
  ]));

  const refresh = useCallback(async (providerId?: string, force = false) => {
    if (!isTauri()) return [];
    const providers = providersForConfig(current.current)
      .filter((provider) => !providerId || provider.id === providerId);
    const results = await Promise.all(providers.map(async (provider) => {
      if (!provider.models.length) return [];
      const key = JSON.stringify([provider.id, provider.baseUrl, provider.models.map((model) => model.id), force]);
      const existing = pending.current.get(key);
      if (existing) return existing;
      const modelIds = provider.models.map((model) => model.id);
      const batches = Array.from({ length: Math.ceil(modelIds.length / 500) }, (_, index) =>
        modelIds.slice(index * 500, (index + 1) * 500),
      );
      const request = Promise.all(batches.map((modelIds) =>
        invoke<ModelContextWindow[]>("refresh_model_context_windows", {
          providerId: provider.id, modelIds, force,
        }),
      )).then((results) => results.flat()).then((windows) => {
        setConfig((saved) => {
          const latest = providersForConfig(saved);
          const match = latest.find((item) => item.id === provider.id);
          // A response for an old endpoint/sign-in cannot overwrite the new configuration.
          if (!match || match.baseUrl !== provider.baseUrl || match.authStatus !== provider.authStatus) return saved;
          const base = { ...saved, modelProviders: latest };
          const next = applyModelContextWindows(base, windows);
          return next === base ? saved : next;
        });
        return windows;
      }).catch(() => []).finally(() => pending.current.delete(key));
      pending.current.set(key, request);
      return request;
    }));
    return results.flat();
  }, [setConfig]);

  useEffect(() => {
    if (!isTauri() || optimizing) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const refreshVisible = () => {
      if (!cancelled && document.visibilityState === "visible") void refresh();
    };
    void refresh();
    const timer = window.setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    window.addEventListener("online", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    void listen<{
      providerId?: string; modelId?: string; phase?: string; status?: string;
      contextWindowSource?: string;
      contextUsage?: { modelContextWindow?: number };
    }>("gyro://provider-chat-event", ({ payload }) => {
      if (cancelled || !payload.providerId) return;
      if (payload.phase === "context-usage" && payload.modelId &&
          payload.contextWindowSource === "runtime" && payload.contextUsage?.modelContextWindow) {
        // Apply real runtime limits immediately, even if an older metadata request is pending.
        const reading: ModelContextWindow = {
          providerId: payload.providerId, modelId: payload.modelId,
          contextWindowTokens: payload.contextUsage.modelContextWindow,
          source: "runtime", checkedAt: new Date().toISOString(),
        };
        setConfig((saved) => applyModelContextWindows({
          ...saved, modelProviders: providersForConfig(saved),
        }, [reading]));
      } else if (payload.phase === "context-usage" || payload.status === "done") {
        void refresh(payload.providerId);
      }
    }).then((stop) => { if (cancelled) stop(); else unlisten = stop; }).catch(() => {});
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unlisten?.();
      window.removeEventListener("focus", refreshVisible);
      window.removeEventListener("online", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [scopeKey, optimizing, refresh, setConfig]);
  return refresh;
}
