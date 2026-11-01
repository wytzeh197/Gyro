import type { GyroConfig, WorkbenchPreferences, ProviderId } from "./types";
import {
  getProviderModel,
  providerDefaultModelId,
  providersForConfig,
} from "./provider-catalog";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from "./settings-controls";
import { WorkspaceDefaultSettings } from "./settings-workspace-defaults";
export type SettingsPreferencePatch = Partial<
  Pick<
    WorkbenchPreferences,
    | "settingsSections"
    | "defaultChatProviderId"
    | "defaultChatEffort"
    | "checkReminders"
  >
>;
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
          <SettingsSelect
            aria-label="Default chat provider"
            value={preferences.defaultChatProviderId ?? "last"}
            onChange={(e) =>
              onChange?.({
                defaultChatProviderId:
                  e.target.value === "last"
                    ? undefined
                    : (e.target.value as ProviderId),
                defaultChatEffort: undefined,
              })
            }
          >
            <option value="last">Last used</option>
            {preferences.defaultChatProviderId && !provider ? (
              <option value={preferences.defaultChatProviderId}>
                Unavailable provider
              </option>
            ) : null}
            {providers
              .filter(
                (p) =>
                  p.authStatus === "connected" ||
                  p.id === preferences.defaultChatProviderId,
              )
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                  {p.authStatus !== "connected" ? " — unavailable" : ""}
                </option>
              ))}
          </SettingsSelect>
        </SettingsRow>
        {provider ? (
          <>
            <SettingsRow
              label="Default model"
              detail={`Uses ${provider.displayName}'s existing model default.`}
            >
              <SettingsSelect
                aria-label="Default new-chat model"
                value={providerDefaultModelId(provider)}
                onChange={(e) => {
                  onDefaultModel?.(provider.id, e.target.value);
                  onChange?.({ defaultChatEffort: undefined });
                }}
              >
                {provider.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </SettingsSelect>
            </SettingsRow>
            {model?.supportedReasoningEfforts?.length ? (
              <SettingsRow
                label="Reasoning effort"
                detail="Only supported effort levels are available. Provider default follows the selected model."
              >
                <SettingsSelect
                  aria-label="Default reasoning effort"
                  value={preferences.defaultChatEffort ?? "default"}
                  onChange={(e) =>
                    onChange?.({
                      defaultChatEffort:
                        e.target.value === "default"
                          ? undefined
                          : e.target.value,
                    })
                  }
                >
                  <option value="default">Provider default</option>
                  {model.supportedReasoningEfforts.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </SettingsSelect>
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
