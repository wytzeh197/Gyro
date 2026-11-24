import type { ReactNode } from "react";
import type { GyroConfig, ModelProviderConfig, ProviderId } from "./types";
import { Select } from "./primitives";
import { providerDefaultModelId, providersForConfig } from "./provider-catalog";
import {
  SettingsGroup,
  SettingsRow,
  SettingsChoice,
} from "./settings-controls";

export function ProviderDefaultModelPicker({
  provider,
  selectedId,
  onChange,
}: {
  provider: ModelProviderConfig;
  selectedId: string;
  onChange: (id: ProviderId, model: string) => void;
}) {
  const items = provider.models.map((model) => ({
    value: model.id,
    label: model.displayName,
  }));
  if (!items.some((item) => item.value === selectedId)) {
    items.push({ value: selectedId, label: selectedId });
  }
  const modelLabel =
    items.find((item) => item.value === selectedId)?.label ?? selectedId;
  const label = `${provider.displayName} default model`;

  return (
    <div className="gyro-provider-default-picker">
      <Select.Root
        items={items}
        value={selectedId}
        onValueChange={(model) => {
          if (typeof model === "string" && model !== selectedId) {
            onChange(provider.id, model);
          }
        }}
      >
        <Select.Trigger
          aria-label={`${label}: ${modelLabel}`}
          className="gyro-provider-model-trigger"
          size="sm"
          title={modelLabel}
        />
        <Select.Content aria-label={label} className="gyro-provider-model-menu">
          {provider.models.map((model) => (
            <Select.Item key={model.id} title={model.displayName} value={model.id}>
              {model.displayName}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    </div>
  );
}

export function ProviderModelDefaults({
  config,
  onChange,
  mark,
}: {
  config: GyroConfig;
  onChange?: (id: ProviderId, model: string) => void;
  mark?: (id: ProviderId) => ReactNode;
}) {
  const providers = providersForConfig(config).filter((p) => p.enabled);
  return (
    <SettingsGroup
      id="provider-model-defaults"
      label="Per-provider model defaults"
      summary={
        providers.length
          ? `${providers.length} enabled providers`
          : "No enabled providers"
      }
    >
      {providers.length ? (
        providers.map((p) => (
          <SettingsRow
            key={p.id}
            label={p.displayName}
            detail="Shared by the provider picker and new-chat defaults."
          >
            <span aria-hidden="true">{mark?.(p.id)}</span>
            <SettingsChoice
              aria-label={`${p.displayName} default model`}
              disabled={!onChange || !p.models.length}
              value={providerDefaultModelId(p) ?? ""}
              onValueChange={(value) => onChange?.(p.id, value)}
              options={p.models.length
                ? p.models.map((m) => ({ value: m.id, label: m.displayName }))
                : [{ value: "", label: "Unavailable" }]
              }
            />
          </SettingsRow>
        ))
      ) : (
        <p>Connect a provider to choose its model default.</p>
      )}
    </SettingsGroup>
  );
}
