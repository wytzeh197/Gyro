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
};

export function supportsFastMode(providerId?: string, modelId?: string) {
  const models =
    providerId && Object.hasOwn(fastModels, providerId)
      ? fastModels[providerId]
      : undefined;
  return Boolean(modelId && models?.includes(modelId.trim().toLowerCase()));
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
  if (
    !providerId ||
    !modelId ||
    !onAction ||
    !supportsFastMode(providerId, modelId)
  )
    return undefined;
  const enabled =
    config.fastModeModels?.[fastModeModelKey(providerId, modelId)] === true;
  return {
    enabled,
    onToggle: () =>
      onAction(
        `set-provider-fast-mode:${providerId}:${modelId}:${enabled ? "off" : "on"}`,
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
