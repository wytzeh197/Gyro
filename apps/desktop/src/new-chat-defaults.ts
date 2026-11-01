import type { SessionModelSelection } from "./use-session-model-save";
import type { GyroConfig, WorkbenchPreferences } from "@gyro-dev/ui";
import {
  providersForConfig,
  providerDefaultModelId,
  getProviderModel,
} from "../../../packages/ui/src/provider-catalog.ts";
/** Snapshot once at draft creation, never while rendering an existing draft. */
export function newChatDefaultSelection(
  config: GyroConfig,
  preferences: WorkbenchPreferences,
): SessionModelSelection | undefined {
  if (!preferences.defaultChatProviderId && !preferences.defaultChatEffort)
    return undefined;
  const providerId =
    preferences.defaultChatProviderId ?? config.selectedProviderId;
  const provider = providersForConfig(config).find((p) => p.id === providerId);
  if (!provider)
    return { providerId, modelId: "", modelLabel: "Provider unavailable" };
  const modelId = providerDefaultModelId(provider);
  const model = getProviderModel(provider, modelId);
  const supported = model?.supportedReasoningEfforts ?? [];
  const effort =
    supported.find((e) => e === preferences.defaultChatEffort) ??
    model?.defaultReasoningEffort;
  return {
    providerId: provider.id,
    modelId,
    modelLabel: model?.displayName ?? modelId,
    reasoningEffort: effort,
  };
}
