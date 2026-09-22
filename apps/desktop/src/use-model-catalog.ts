import { useEffect } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import {
  createModelCatalogClient,
  MODEL_CATALOG_POLL_MS,
  MODEL_CATALOG_REFRESH_MS,
  type GyroConfig,
  type ModelCatalogAddition,
  type NotificationKind,
} from "@gyro-dev/ui";

const client = createModelCatalogClient(
  {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  },
  () => invoke<string>("fetch_model_catalog"),
);

export function restoreModelCatalog() {
  client.restore();
}

/** Announce an addition the way the picker names it, so the two agree. */
function announcement(additions: ModelCatalogAddition[]) {
  const names = additions.map(
    (addition) => `${addition.displayName} (${addition.providerLabel})`,
  );
  if (names.length === 1) {
    return {
      title: "New model available",
      detail: `${names[0]} is now available in the model picker.`,
    };
  }
  return {
    title: `${names.length} new models available`,
    detail: `${names.join(", ")} are now available in the model picker.`,
  };
}

export function useModelCatalog(
  isShellOptimizing: boolean,
  setConfig: (update: (current: GyroConfig) => GyroConfig) => void,
  normalize: (config: GyroConfig) => GyroConfig,
  notify: (kind: NotificationKind, title: string, detail: string) => void,
) {
  useEffect(() => {
    if (!isTauri() || isShellOptimizing) return;
    let cancelled = false;
    let timer: number | undefined;
    let ticking = false;
    // A focused, visible window is the only time the picker can be read, so it
    // is the only time a fast poll earns its requests. Every other state falls
    // back to the slow cadence, and regaining focus checks immediately, so the
    // slow interval is never a delay anyone waits through.
    const watching = () =>
      document.visibilityState === "visible" && document.hasFocus();
    const cadence = () =>
      watching() ? MODEL_CATALOG_POLL_MS : MODEL_CATALOG_REFRESH_MS;
    const schedule = (delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
      if (cancelled || ticking) return;
      ticking = true;
      try {
        const result = await client.refresh();
        if (!cancelled && result.applied) {
          setConfig((current) => normalize(current));
          if (result.additions.length > 0) {
            const { title, detail } = announcement(result.additions);
            notify("provider", title, detail);
          }
        }
      } finally {
        ticking = false;
      }
      if (!cancelled) schedule(cadence());
    };
    const refreshNow = () => void tick();
    const onVisibilityChange = () => {
      if (watching()) refreshNow();
    };
    void tick();
    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isShellOptimizing, setConfig, normalize, notify]);
}
