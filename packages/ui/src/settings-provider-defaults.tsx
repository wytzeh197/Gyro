import type { ReactNode } from "react";
import type { GyroConfig, ProviderId } from "./types";
import { providerDefaultModelId, providersForConfig } from "./provider-catalog";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
} from "./settings-controls";

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
            <SettingsSelect
              aria-label={`${p.displayName} default model`}
              disabled={!onChange || !p.models.length}
              value={providerDefaultModelId(p) ?? ""}
              onChange={(e) => onChange?.(p.id, e.target.value)}
            >
              {!p.models.length ? (
                <option value="">Unavailable</option>
              ) : (
                p.models.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.displayName}
                  </option>
                ))
              )}
            </SettingsSelect>
          </SettingsRow>
        ))
      ) : (
        <p>Connect a provider to choose its model default.</p>
      )}
    </SettingsGroup>
  );
}
