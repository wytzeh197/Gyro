import { useEffect } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import {
  createModelCatalogClient,
  MODEL_CATALOG_REFRESH_MS,
  type GyroConfig,
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

export function useModelCatalog(
  isShellOptimizing: boolean,
  setConfig: (update: (current: GyroConfig) => GyroConfig) => void,
  normalize: (config: GyroConfig) => GyroConfig,
) {
  useEffect(() => {
    if (!isTauri() || isShellOptimizing) return;
    let cancelled = false;
    const refresh = async () => {
      if (await client.refresh()) {
        if (!cancelled) setConfig((current) => normalize(current));
      }
    };
    void refresh();
    const timer = window.setInterval(
      () => void refresh(),
      MODEL_CATALOG_REFRESH_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isShellOptimizing, setConfig, normalize]);
}
