import { humanModelName } from "./model-name.ts";
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
export const COUNCIL_COMING_SOON: boolean = false;

/** Shown wherever a frozen Council entry point is still visible. */
export const COUNCIL_COMING_SOON_LABEL = "Coming soon";

function rolePreset(
  id: string,
  name: string,
  description: string,
  seatProviderIds: string[],
  synthesizerProviderId = "anthropic",
): CouncilPreset {
  return {
    id,
    name,
    description,
    seatProviderIds,
    synthesizerProviderId,
    toolPolicy: "none",
    builtIn: true,
  };
}

/**
 * One built-in preset per kind of work. Each picks its seats by provider and
 * starts on the provider's default model; the user sets the standard model for
 * a role in Settings → Model Council.
 */
export const DEFAULT_COUNCIL_PRESETS: CouncilPreset[] = [
  rolePreset("backend", "Backend", "APIs, data, services and infrastructure.", ["anthropic", "openai"]),
  rolePreset("frontend", "Frontend", "UI, components, styling and accessibility.", ["anthropic", "google"]),
  rolePreset("debugging", "Debugging", "Find the cause of a bug or failing test.", ["openai", "anthropic", "xai"], "openai"),
  rolePreset("review", "Review", "Second opinions on a diff or a design.", ["openai", "anthropic"]),
  rolePreset("planning", "Planning", "Architecture, trade-offs and plans.", ["anthropic", "openai", "google"]),
];

/** Built-ins from before the role presets; dropped unless the user edited them. */
const LEGACY_COUNCIL_PRESETS: Record<string, string[]> = {
  "code-focused": ["anthropic", "openai"],
  "strong-reasoning": ["anthropic", "openai", "xai"],
  "cheap-local": ["kimi", "antigravity"],
};

function isUntouchedLegacyPreset(preset: CouncilPreset) {
  const seats = LEGACY_COUNCIL_PRESETS[preset.id];
  return (
    Boolean(seats) &&
    preset.builtIn !== false &&
    seats!.join() === preset.seatProviderIds.join() &&
    !Object.values(preset.seatModelIds ?? {}).some(Boolean) &&
    !preset.synthesizerModelId
  );
}

export function defaultCouncilConfig(): CouncilConfig {
  return {
    defaultPresetId: "backend",
    activePresetIds: ["backend"],
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
    if (!preset?.id || isUntouchedLegacyPreset(preset)) continue;
    const builtIn = byId.get(preset.id);
    byId.set(preset.id, {
      ...builtIn,
      ...preset,
      // An edited legacy built-in has nothing to reset to any more.
      builtIn: Boolean(builtIn),
      toolPolicy: preset.toolPolicy ?? "none",
    });
  }
  const presets = [
    ...defaults.presets.map((preset) => byId.get(preset.id) ?? preset),
    ...[...byId.values()].filter(
      (preset) => !defaults.presets.some((builtIn) => builtIn.id === preset.id),
    ),
  ];
  const defaultPresetId = presets.some(
    (preset) => preset.id === council.defaultPresetId,
  )
    ? council.defaultPresetId
    : defaults.defaultPresetId;
  const known = new Set(presets.map((preset) => preset.id));
  const activePresetIds = [
    ...new Set((council.activePresetIds ?? []).filter((id) => known.has(id))),
  ];
  return {
    defaultPresetId: activePresetIds[0] ?? defaultPresetId,
    activePresetIds: activePresetIds.length ? activePresetIds : [defaultPresetId],
    synthesizer: council.synthesizer?.providerId ? council.synthesizer : null,
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

/** Most seats a preset can hold; the backend and the composer clamp to it. */
export const COUNCIL_MAX_SEATS = 4;
export const COUNCIL_MIN_SEATS = 2;

export function builtInCouncilPreset(id: string): CouncilPreset | undefined {
  const preset = DEFAULT_COUNCIL_PRESETS.find((item) => item.id === id);
  return preset ? { ...preset } : undefined;
}

function presetShape(preset: CouncilPreset) {
  return JSON.stringify({
    name: preset.name.trim(),
    description: (preset.description ?? "").trim(),
    seats: preset.seatProviderIds,
    models: preset.seatProviderIds.map((id) => preset.seatModelIds?.[id] ?? null),
    synth: preset.synthesizerProviderId,
    synthModel: preset.synthesizerModelId ?? null,
  });
}

/** A built-in preset the user has changed, so Reset has something to undo. */
export function isEditedBuiltInCouncilPreset(preset: CouncilPreset): boolean {
  const original = builtInCouncilPreset(preset.id);
  return Boolean(original) && presetShape(original!) !== presetShape(preset);
}

/** Why a preset cannot be saved, or undefined when it can. */
export function councilPresetProblem(preset: CouncilPreset): string | undefined {
  if (!preset.name.trim()) return "Give the preset a name.";
  if (preset.seatProviderIds.length < COUNCIL_MIN_SEATS) {
    return `A council needs at least ${COUNCIL_MIN_SEATS} seats.`;
  }
  if (preset.seatProviderIds.length > COUNCIL_MAX_SEATS) {
    return `A council holds at most ${COUNCIL_MAX_SEATS} seats.`;
  }
  if (new Set(preset.seatProviderIds).size !== preset.seatProviderIds.length) {
    return "Each seat needs a different provider.";
  }
  if (!preset.synthesizerProviderId) return "Pick who writes the final answer.";
  return undefined;
}

/** An id no preset in the list already uses, derived from the name. */
export function newCouncilPresetId(name: string, presets: CouncilPreset[]) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "council";
  const taken = new Set(presets.map((preset) => preset.id));
  let id = `custom-${base}`;
  for (let n = 2; taken.has(id); n += 1) id = `custom-${base}-${n}`;
  return id;
}

/** Keep only the model choices of providers that still have a seat. */
export function cleanCouncilPreset(preset: CouncilPreset): CouncilPreset {
  const seatModelIds: Record<string, string | null> = {};
  for (const id of preset.seatProviderIds) {
    const model = preset.seatModelIds?.[id];
    if (model) seatModelIds[id] = model;
  }
  return {
    ...preset,
    name: preset.name.trim(),
    description: preset.description?.trim() || undefined,
    seatModelIds,
    synthesizerModelId: preset.synthesizerModelId || null,
    toolPolicy: "none",
  };
}

export function upsertCouncilPreset(
  council: CouncilConfig,
  preset: CouncilPreset,
): CouncilConfig {
  const clean = cleanCouncilPreset(preset);
  const exists = council.presets.some((item) => item.id === clean.id);
  return {
    ...council,
    presets: exists
      ? council.presets.map((item) => (item.id === clean.id ? clean : item))
      : [...council.presets, clean],
  };
}

/** Removes a custom preset, or puts a built-in back the way it shipped. */
export function removeCouncilPreset(
  council: CouncilConfig,
  presetId: string,
): CouncilConfig {
  const original = builtInCouncilPreset(presetId);
  if (original) {
    return {
      ...council,
      presets: council.presets.map((item) =>
        item.id === presetId ? original : item,
      ),
    };
  }
  const presets = council.presets.filter((item) => item.id !== presetId);
  const activePresetIds = (council.activePresetIds ?? []).filter(
    (id) => id !== presetId,
  );
  return {
    ...council,
    presets,
    activePresetIds: activePresetIds.length
      ? activePresetIds
      : presets[0]
        ? [presets[0].id]
        : [],
    defaultPresetId:
      council.defaultPresetId === presetId
        ? (presets[0]?.id ?? DEFAULT_COUNCIL_PRESETS[0]!.id)
        : council.defaultPresetId,
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

/** The presets a council chat runs, in the order they were loaded. */
export function activeCouncilPresets(config: GyroConfig): CouncilPreset[] {
  const council = normalizedCouncilConfig(config.council);
  const loaded = (council.activePresetIds ?? [])
    .map((id) => council.presets.find((preset) => preset.id === id))
    .filter((preset): preset is CouncilPreset => Boolean(preset));
  return loaded.length ? loaded : [defaultCouncilPreset({ ...config, council })];
}

/** Loads or unloads a preset for council chats; at least one stays loaded. */
export function toggleCouncilActivePreset(
  council: CouncilConfig,
  presetId: string,
): CouncilConfig {
  const normalized = normalizedCouncilConfig(council);
  const current = normalized.activePresetIds ?? [];
  const next = current.includes(presetId)
    ? current.filter((id) => id !== presetId)
    : [...current, presetId];
  if (!next.length) return normalized;
  return { ...normalized, activePresetIds: next, defaultPresetId: next[0]! };
}

function seatRequest(
  provider: ModelProviderConfig,
  preferredModelId?: string | null,
): CouncilSeatRequest {
  const modelId =
    preferredModelId ??
    provider.defaultModelId ??
    providerDefaultModelId(provider);
  const model = getProviderModel(provider, modelId ?? undefined);
  return {
    providerId: provider.id,
    providerLabel: provider.displayName,
    modelId: modelId ?? null,
    modelLabel: model?.displayName ?? humanModelName(modelId) ?? null,
  };
}

export function resolveCouncilSeatRequests(
  config: GyroConfig,
  readyProviders: ModelProviderConfig[],
): CouncilSeatResolution {
  const council = normalizedCouncilConfig(config.council);
  const presets = activeCouncilPresets({ ...config, council });
  const lead = presets[0]!;
  const presetId = presets.map((preset) => preset.id).join("+");
  const presetName = presets.map((preset) => preset.name).join(" + ");
  const readyById = new Map(
    readyProviders.map((provider) => [provider.id, provider] as const),
  );
  const maxSeats = council.maxSeats;
  // Loaded presets merge in order. A provider sits once, with the model of the
  // first preset that seats it, because one run cannot hold a provider twice.
  const seatProviders: CouncilSeatRequest[] = [];
  for (const preset of presets) {
    for (const id of preset.seatProviderIds) {
      const provider = readyById.get(id as ProviderId);
      if (!provider || seatProviders.some((seat) => seat.providerId === id)) {
        continue;
      }
      if (seatProviders.length >= maxSeats) break;
      seatProviders.push(seatRequest(provider, preset.seatModelIds?.[id]));
    }
  }

  const seats =
    seatProviders.length >= 2
      ? seatProviders
      : readyProviders
          .slice(0, maxSeats)
          .map((provider) => seatRequest(provider));

  if (seats.length < 2) {
    return {
      seats,
      synthesizerProviderId: lead.synthesizerProviderId,
      presetId,
      presetName,
      error:
        "Council needs at least two ready providers. Connect more providers or pick a different preset.",
    };
  }

  const chosen = council.synthesizer
    ? readyById.get(council.synthesizer.providerId as ProviderId)
    : undefined;
  const synthProvider =
    chosen ??
    readyById.get(lead.synthesizerProviderId as ProviderId) ??
    readyProviders.find((provider) => provider.id === seats[0]?.providerId) ??
    readyProviders[0];
  if (!synthProvider) {
    return {
      seats,
      synthesizerProviderId: lead.synthesizerProviderId,
      presetId,
      presetName,
      error: "Council synthesizer provider is not ready.",
    };
  }
  const synth = seatRequest(
    synthProvider,
    chosen
      ? council.synthesizer?.modelId
      : synthProvider.id === lead.synthesizerProviderId
        ? lead.synthesizerModelId
        : undefined,
  );

  return {
    seats,
    synthesizerProviderId: synthProvider.id,
    synthesizerProviderLabel: synthProvider.displayName,
    synthesizerModelId: synth.modelId,
    synthesizerModelLabel: synth.modelLabel,
    presetId,
    presetName,
  };
}

export function councilPreflightLabel(
  resolution: CouncilSeatResolution,
): string {
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
