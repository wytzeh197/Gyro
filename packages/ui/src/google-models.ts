import { antigravityModelName } from "./antigravity-model-names.ts";
import { providersForConfig } from "./provider-catalog.ts";
import type { GyroConfig, ProviderId, ProviderModel } from "./types";

export type GoogleModelDiscovery = {
  models: Array<{
    id: string;
    displayName: string;
    description?: string | null;
  }>;
  currentModelId?: string | null;
};

/** Replace only agent-discovered models; preserve catalog entries and custom selections. */
export function applyGoogleModelDiscovery(
  config: GyroConfig,
  providerId: ProviderId,
  discovery: GoogleModelDiscovery,
): GyroConfig {
  if (providerId !== "antigravity") return config;
  return {
    ...config,
    modelProviders: providersForConfig(config).map((provider) => {
      if (provider.id !== providerId) return provider;
      const retained = provider.models.filter((model) => !model.cliDiscovered);
      const ids = new Set(retained.map((model) => model.id));
      const models: ProviderModel[] = [...retained];
      for (const model of discovery.models.slice(0, 500)) {
        const id = model.id.trim();
        if (
          !id ||
          id.length > 200 ||
          /[\u0000-\u001f\u007f]/.test(id) ||
          ids.has(id)
        )
          continue;
        ids.add(id);
        models.push({
          id,
          displayName: discoveredName(id, model.displayName),
          description: model.description?.slice(0, 500),
          cliDiscovered: true,
        });
      }
      const fallback =
        discovery.currentModelId && ids.has(discovery.currentModelId)
          ? discovery.currentModelId
          : provider.defaultModelId;
      return {
        ...provider,
        models,
        selectedModelId:
          provider.selectedModelId && ids.has(provider.selectedModelId)
            ? provider.selectedModelId
            : fallback,
        defaultModelId:
          provider.defaultModelId && ids.has(provider.defaultModelId)
            ? provider.defaultModelId
            : fallback,
      };
    }),
  };
}

/** The agent's own label wins; a bare id (no label sent) gets Antigravity's name. */
function discoveredName(id: string, label: string | undefined | null) {
  const name = label?.trim().slice(0, 160);
  return name && name !== id ? name : antigravityModelName(id);
}
