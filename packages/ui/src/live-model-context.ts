import type { GyroConfig, ProviderModel } from "./types";

export type LiveModelContext = {
  baseUrl?: string | null;
  tokens: number;
  source: "runtime" | "provider" | "local";
  checkedAt: string;
};
export type ModelContextWindow = {
  providerId: string;
  modelId: string;
  contextWindowTokens?: number | null;
  source: "runtime" | "provider" | "local" | "catalog" | "unknown";
  checkedAt: string;
};

const readings = new Map<string, LiveModelContext>();
const keyFor = (providerId: string, modelId: string, baseUrl?: string | null) =>
  JSON.stringify([providerId, modelId, baseUrl ?? null]);

export function getLiveModelContext(providerId: string, modelId: string, baseUrl?: string | null): LiveModelContext | undefined {
  const reading = readings.get(keyFor(providerId, modelId, baseUrl));
  return liveModelContextTokens({ liveContextWindow: reading }, Date.now(), baseUrl ?? null) ? reading : undefined;
}

export function liveModelContextTokens(
  model: Pick<ProviderModel, "liveContextWindow">,
  now = Date.now(),
  baseUrl?: string | null,
): number | undefined {
  const reading = model.liveContextWindow;
  if (reading?.baseUrl !== undefined && baseUrl !== undefined && reading.baseUrl !== baseUrl) return undefined;
  if (!reading || !["runtime", "provider", "local"].includes(reading.source) ||
      !Number.isSafeInteger(reading.tokens) || reading.tokens <= 0 ||
      reading.tokens > 100_000_000) return undefined;
  const age = now - Date.parse(reading.checkedAt);
  const ttl = reading.source === "runtime" ? 900_000 : 300_000;
  return Number.isFinite(age) && age >= -60_000 && age < ttl ? reading.tokens : undefined;
}

/** Native metadata is applied only to an existing provider/model pair. */
export function applyModelContextWindows(
  config: GyroConfig,
  windows: ModelContextWindow[],
  now = Date.now(),
): GyroConfig {
  const byModel = new Map(windows.map((window) => [
    JSON.stringify([window.providerId, window.modelId]), window,
  ]));
  let changed = false;
  const modelProviders = config.modelProviders.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => {
      const window = byModel.get(JSON.stringify([provider.id, model.id]));
      if (!window || !["runtime", "provider", "local", "catalog", "unknown"].includes(window.source)) return model;
      const liveContextWindow = window.source === "runtime" || window.source === "provider" || window.source === "local"
        ? { tokens: window.contextWindowTokens ?? 0, source: window.source, checkedAt: window.checkedAt, baseUrl: provider.baseUrl ?? null }
        : undefined;
      const tokens = liveModelContextTokens({ liveContextWindow }, now);
      if (tokens === undefined && liveContextWindow) return model; // Malformed metadata never erases a valid reading.
      const key = keyFor(provider.id, model.id, provider.baseUrl);
      const previous = readings.get(key);
      if (previous && liveModelContextTokens({ liveContextWindow: previous }, now)) {
        const previousAt = Date.parse(previous.checkedAt);
        const nextAt = Date.parse(window.checkedAt);
        if (previousAt > nextAt || (previousAt === nextAt &&
            previous.source === "runtime" && liveContextWindow?.source !== "runtime")) return model;
      }
      if (JSON.stringify(previous) !== JSON.stringify(liveContextWindow)) {
        changed = true;
        if (liveContextWindow) readings.set(key, liveContextWindow);
        else readings.delete(key);
      }
      if (JSON.stringify(model.liveContextWindow) === JSON.stringify(liveContextWindow)) return model;
      changed = true;
      return { ...model, liveContextWindow, contextWindowTokens: tokens };
    }),
  }));
  return changed ? { ...config, modelProviders } : config;
}
