import {
  getProviderModel,
  isProviderRuntimeUsable,
  providerDefaultModelId,
  providersForConfig,
} from "./provider-catalog.ts";
import type {
  CouncilConfig,
  CouncilPreset,
  GyroConfig,
  ModelProviderConfig,
  ProviderId,
  ProviderStatus,
} from "./types";

/**
 * Council is built but not released, so nothing may start a council run.
 *
 * The engine, presets, and synthesis stay in the tree — this is a freeze, not a
 * removal. It gates every entry point rather than each surface deciding for
 * itself, so Council cannot become reachable again by accident. Flip this to
 * `false` to unfreeze; nothing else needs to change.
 */
export const COUNCIL_COMING_SOON: boolean = true;

/** Shown wherever a frozen Council entry point is still visible. */
export const COUNCIL_COMING_SOON_LABEL = "Coming soon";

export const DEFAULT_COUNCIL_PRESETS: CouncilPreset[] = [
  {
    id: "code-focused",
    name: "Code-focused council",
    description:
      "Strong coding providers in parallel; best available synthesizer.",
    seatProviderIds: ["anthropic", "openai"],
    synthesizerProviderId: "anthropic",
    toolPolicy: "none",
    builtIn: true,
  },
  {
    id: "strong-reasoning",
    name: "Strong reasoning council",
    description:
      "Prefer deep-reasoning providers for architecture and hard bugs.",
    seatProviderIds: ["anthropic", "openai", "xai"],
    synthesizerProviderId: "anthropic",
    toolPolicy: "none",
    builtIn: true,
  },
  {
    id: "cheap-local",
    name: "Cheap + local council",
    description: "Lower-cost and local-capable seats when available.",
    seatProviderIds: ["kimi", "gemini"],
    synthesizerProviderId: "kimi",
    toolPolicy: "none",
    builtIn: true,
  },
];

export function defaultCouncilConfig(): CouncilConfig {
  return {
    defaultPresetId: "code-focused",
    presets: DEFAULT_COUNCIL_PRESETS.map((preset) => ({ ...preset })),
    maxSeats: 4,
    seatTimeoutSeconds: 300,
    synthesizerTimeoutSeconds: 180,
    synthesizeOnPartial: true,
    // Off while frozen, so a fresh install has no reachable council run.
    enabled: !COUNCIL_COMING_SOON,
  };
}

export function normalizedCouncilConfig(
  council?: CouncilConfig | null,
): CouncilConfig {
  const defaults = defaultCouncilConfig();
  if (!council) {
    return defaults;
  }
  const byId = new Map(defaults.presets.map((preset) => [preset.id, preset]));
  for (const preset of council.presets ?? []) {
    if (!preset?.id) continue;
    byId.set(preset.id, {
      ...byId.get(preset.id),
      ...preset,
      toolPolicy: preset.toolPolicy ?? "none",
    });
  }
  const presets = [
    ...defaults.presets.map((preset) => byId.get(preset.id) ?? preset),
    ...[...byId.values()].filter(
      (preset) => !defaults.presets.some((builtIn) => builtIn.id === preset.id),
    ),
  ];
  const defaultPresetId =
    presets.some((preset) => preset.id === council.defaultPresetId)
      ? council.defaultPresetId
      : defaults.defaultPresetId;
  return {
    defaultPresetId,
    presets,
    maxSeats: Math.min(4, Math.max(2, council.maxSeats || 4)),
    seatTimeoutSeconds: council.seatTimeoutSeconds || 300,
    synthesizerTimeoutSeconds: council.synthesizerTimeoutSeconds || 180,
    synthesizeOnPartial: council.synthesizeOnPartial !== false,
    // The freeze outranks whatever was persisted: an install that enabled
    // Council before it was frozen must not stay enabled after upgrading.
    enabled: COUNCIL_COMING_SOON ? false : council.enabled !== false,
  };
}

export function defaultCouncilPreset(config: GyroConfig): CouncilPreset {
  const council = normalizedCouncilConfig(config.council);
  return (
    council.presets.find((preset) => preset.id === council.defaultPresetId) ??
    council.presets[0] ??
    DEFAULT_COUNCIL_PRESETS[0]!
  );
}

export type CouncilSeatRequest = {
  providerId: string;
  providerLabel?: string;
  modelId?: string | null;
  modelLabel?: string | null;
};

export type CouncilSeatResolution = {
  seats: CouncilSeatRequest[];
  synthesizerProviderId: string;
  synthesizerProviderLabel?: string;
  synthesizerModelId?: string | null;
  synthesizerModelLabel?: string | null;
  presetId: string;
  presetName: string;
  error?: string;
};

export function readyCouncilProviders(
  config: GyroConfig,
  providerStatuses?: ProviderStatus[],
): ModelProviderConfig[] {
  return providersForConfig(config).filter((provider) => {
    const status = providerStatuses?.find((item) => item.id === provider.id);
    return isProviderRuntimeUsable(provider, status);
  });
}

export function resolveCouncilSeatRequests(
  config: GyroConfig,
  readyProviders: ModelProviderConfig[],
): CouncilSeatResolution {
  const council = normalizedCouncilConfig(config.council);
  const preset = defaultCouncilPreset({ ...config, council });
  const readyById = new Map(
    readyProviders.map((provider) => [provider.id, provider] as const),
  );
  const maxSeats = council.maxSeats;
  const seatProviders = preset.seatProviderIds
    .map((id) => readyById.get(id as ProviderId) ?? readyById.get(id as never))
    .filter((provider): provider is ModelProviderConfig => Boolean(provider))
    .slice(0, maxSeats)
    .map((provider) => {
      const modelId =
        preset.seatModelIds?.[provider.id] ??
        provider.defaultModelId ??
        providerDefaultModelId(provider);
      const model = getProviderModel(provider, modelId ?? undefined);
      return {
        providerId: provider.id,
        providerLabel: provider.displayName,
        modelId: modelId ?? null,
        modelLabel: model?.displayName ?? modelId ?? null,
      };
    });

  const seats =
    seatProviders.length >= 2
      ? seatProviders
      : readyProviders.slice(0, maxSeats).map((provider) => {
          const modelId =
            provider.defaultModelId ?? providerDefaultModelId(provider);
          const model = getProviderModel(provider, modelId ?? undefined);
          return {
            providerId: provider.id,
            providerLabel: provider.displayName,
            modelId: modelId ?? null,
            modelLabel: model?.displayName ?? modelId ?? null,
          };
        });

  if (seats.length < 2) {
    return {
      seats,
      synthesizerProviderId: preset.synthesizerProviderId,
      presetId: preset.id,
      presetName: preset.name,
      error:
        "Council needs at least two ready providers. Connect more providers or pick a different preset.",
    };
  }

  const synthProvider =
    readyById.get(preset.synthesizerProviderId as ProviderId) ??
    readyProviders.find((provider) => provider.id === seats[0]?.providerId) ??
    readyProviders[0];
  if (!synthProvider) {
    return {
      seats,
      synthesizerProviderId: preset.synthesizerProviderId,
      presetId: preset.id,
      presetName: preset.name,
      error: "Council synthesizer provider is not ready.",
    };
  }
  const synthModelId =
    preset.synthesizerModelId ??
    synthProvider.defaultModelId ??
    providerDefaultModelId(synthProvider);
  const synthModel = getProviderModel(synthProvider, synthModelId ?? undefined);

  return {
    seats,
    synthesizerProviderId: synthProvider.id,
    synthesizerProviderLabel: synthProvider.displayName,
    synthesizerModelId: synthModelId ?? null,
    synthesizerModelLabel: synthModel?.displayName ?? synthModelId ?? null,
    presetId: preset.id,
    presetName: preset.name,
  };
}

export function councilPreflightLabel(resolution: CouncilSeatResolution): string {
  const seatCount = resolution.seats.length;
  const names = resolution.seats
    .map((seat) => seat.providerLabel ?? seat.providerId)
    .join(" · ");
  const synth =
    resolution.synthesizerProviderLabel ?? resolution.synthesizerProviderId;
  if (resolution.error) {
    return resolution.error;
  }
  return `${seatCount} seats (${names}) · synth ${synth} · wall ≈ max(seats)+synth`;
}
