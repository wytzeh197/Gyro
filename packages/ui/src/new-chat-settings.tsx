import type { GyroConfig, WorkbenchPreferences, ProviderId } from "./types";
import {
  getProviderModel,
  providerDefaultModelId,
  providersForConfig,
} from "./provider-catalog";
import {
  SettingsGroup,
  SettingsRow,
  SettingsChoice,
  SettingsSwitch,
} from "./settings-controls";
import { WorkspaceDefaultSettings } from "./settings-workspace-defaults";
import type { ThemePreferences } from "./theme/theme-engine";
export type SettingsPreferencePatch = Partial<
  Pick<
    WorkbenchPreferences,
    | "settingsSections"
    | "defaultChatProviderId"
    | "defaultChatEffort"
    | "checkReminders"
  >
> & ThemePreferences;
export function NewChatSettings({
  config,
  preferences,
  onChange,
  onDefaultModel,
  onWorkspaceMode,
}: {
  config: GyroConfig;
  preferences: Partial<WorkbenchPreferences>;
  onChange?: (patch: SettingsPreferencePatch) => void;
  onDefaultModel?: (id: ProviderId, model: string) => void;
  onWorkspaceMode?: (mode: "local" | "worktree") => void;
}) {
  const providers = providersForConfig(config);
  const provider = providers.find(
    (p) =>
      p.id === (preferences.defaultChatProviderId ?? config.selectedProviderId),
  );
  const model =
    provider && getProviderModel(provider, providerDefaultModelId(provider));
  const missing =
    preferences.defaultChatProviderId &&
    (!provider?.enabled || provider.authStatus !== "connected");
  return (
    <>
      <SettingsGroup
        id="new-chat-defaults"
        label="New-chat defaults"
        description="Used when a new draft is created. Existing drafts and running chats keep their choices."
      >
        {missing ? (
          <p role="alert">
            The fixed provider is unavailable. Connect it or choose another
            provider before sending a new chat.
          </p>
        ) : null}
        <SettingsRow
          label="Provider for new chats"
          detail="Use the last selection, or always begin with one connected provider."
        >
          <SettingsChoice
            aria-label="Default chat provider"
            value={preferences.defaultChatProviderId ?? "last"}
            onValueChange={(value) =>
              onChange?.({
                defaultChatProviderId:
                  value === "last" ? undefined : (value as ProviderId),
                defaultChatEffort: undefined,
              })
            }
            options={[
              { value: "last", label: "Last used" },
              ...(preferences.defaultChatProviderId && !provider
                ? [{
                    value: preferences.defaultChatProviderId,
                    label: "Unavailable provider",
                  }]
                : []),
              ...providers
                .filter(
                  (p) =>
                    p.authStatus === "connected" ||
                    p.id === preferences.defaultChatProviderId,
                )
                .map((p) => ({
                  value: p.id,
                  label: p.authStatus === "connected"
                    ? p.displayName
                    : `${p.displayName} — unavailable`,
                })),
            ]}
          />
        </SettingsRow>
        {provider ? (
          <>
            <SettingsRow
              label="Default model"
              detail={`Uses ${provider.displayName}'s existing model default.`}
            >
              <SettingsChoice
                aria-label="Default new-chat model"
                value={providerDefaultModelId(provider) ?? null}
                onValueChange={(value) => {
                  onDefaultModel?.(provider.id, value);
                  onChange?.({ defaultChatEffort: undefined });
                }}
                options={provider.models.map((m) => ({ value: m.id, label: m.displayName }))}
              />
            </SettingsRow>
            {model?.supportedReasoningEfforts?.length ? (
              <SettingsRow
                label="Reasoning effort"
                detail="Only supported effort levels are available. Provider default follows the selected model."
              >
                <SettingsChoice
                  aria-label="Default reasoning effort"
                  value={preferences.defaultChatEffort ?? "default"}
                  onValueChange={(value) =>
                    onChange?.({
                      defaultChatEffort: value === "default" ? undefined : value,
                    })
                  }
                  options={[
                    { value: "default", label: "Provider default" },
                    ...model.supportedReasoningEfforts.map((effort) => ({ value: effort, label: effort })),
                  ]}
                />
              </SettingsRow>
            ) : null}
          </>
        ) : null}
        <WorkspaceDefaultSettings
          mode={preferences.defaultWorkspaceMode ?? "local"}
          onChange={onWorkspaceMode}
        />
      </SettingsGroup>
    </>
  );
}
export function CheckReminderSettings({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange?: (value: boolean) => void;
}) {
  return (
    <SettingsGroup
      id="check-reminders"
      label="Check reminders"
      summary={
        enabled ? "Suggest checks after recorded edits" : "Manual checks only"
      }
    >
      <SettingsRow
        label="Suggest checking finished work"
        detail="Show a reminder after a completed chat turn with recorded file changes. Checks still need your review and approval."
      >
        <SettingsSwitch
          label="Suggest checking finished work"
          checked={enabled}
          onChange={(value) => onChange?.(value)}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
