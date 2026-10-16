import type { GyroConfig } from "./types";

// Model-specific support, verified against provider docs and Codex's model
// metadata. Unknown models and routed/custom providers stay at standard speed.
const fastModels: Record<string, readonly string[]> = {
  openai: [
    "gpt-6.1-sol",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ],
  anthropic: ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"],
  // The fast pool is a launch id, not a picker row. The toggle rewrites grok-4.7.
  xai: ["grok-4.7"],
};

const XAI_FAST_LAUNCH_MODEL_ID = "grok-4.7-build-fast";

/** Picker identity for a model. The xAI fast pool shows as Grok 4.7. */
export function pickerModelId(providerId?: string, modelId?: string) {
  if (
    providerId === "xai" &&
    modelId?.trim().toLowerCase() === XAI_FAST_LAUNCH_MODEL_ID
  ) {
    return "grok-4.7";
  }
  return modelId;
}

/** Chip label for a stored fast-pool id or an old "Grok 4.7 Fast" name. */
export function pickerModelLabel(
  providerId: string | undefined,
  modelId: string | undefined,
  label: string | undefined,
) {
  if (!label) return label;
  if (pickerModelId(providerId, modelId) !== modelId && providerId === "xai") {
    return "Grok 4.7";
  }
  return label === "Grok 4.7 Fast" ? "Grok 4.7" : label;
}

export function supportsFastMode(providerId?: string, modelId?: string) {
  const canonical = pickerModelId(providerId, modelId);
  const models =
    providerId && Object.hasOwn(fastModels, providerId)
      ? fastModels[providerId]
      : undefined;
  return Boolean(
    canonical && models?.includes(canonical.trim().toLowerCase()),
  );
}

export function fastModeModelKey(providerId: string, modelId: string) {
  return `${providerId}:${modelId.trim().toLowerCase()}`;
}

export function composerFastMode(
  config: GyroConfig,
  providerId: string | undefined,
  modelId: string | undefined,
  onAction: ((action: string) => void) | undefined,
) {
  // Only the active model's explicit identity establishes compatibility.
  // Never infer support from its label or the provider's default model.
  const canonical = pickerModelId(providerId, modelId);
  if (
    !providerId ||
    !canonical ||
    !onAction ||
    !supportsFastMode(providerId, canonical)
  )
    return undefined;
  const key =
    config.fastModeModels?.[fastModeModelKey(providerId, canonical)];
  // A chat still bound to the fast-pool id is Fast until the user turns it off.
  const launchedFast =
    providerId === "xai" &&
    modelId?.trim().toLowerCase() === XAI_FAST_LAUNCH_MODEL_ID;
  const enabled = key === true || (launchedFast && key !== false);
  return {
    enabled,
    onToggle: () =>
      onAction(
        `set-provider-fast-mode:${providerId}:${canonical}:${enabled ? "off" : "on"}`,
      ),
  };
}
export function fastModeConfigFromAction(config: GyroConfig, action: string) {
  const [command, providerId, ...parts] = action.split(":");
  const speed = parts.pop();
  const modelId = parts.join(":");
  if (
    command !== "set-provider-fast-mode" ||
    !providerId ||
    (speed !== "on" && speed !== "off") ||
    !supportsFastMode(providerId, modelId)
  )
    return undefined;
  return {
    ...config,
    fastModeModels: {
      ...config.fastModeModels,
      [fastModeModelKey(providerId, modelId)]: speed === "on",
    },
  };
}
