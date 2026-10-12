import { useState, type ReactNode } from "react";
import { MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { SettingsGroup, SettingsSelect } from "./settings-controls";
import { useOutsidePointerDismiss } from "./menu-dismiss";
import {
  providersForConfig,
  providerSupportsApiKey,
  providerDefaultModelId,
  isProviderRuntimeUsable,
  providerNeedsSignInRepair,
  providerApiKeyEnvName,
  isCustomProviderId,
} from "./provider-catalog";
import type { ProviderId } from "./types";
import type { SettingsSurfaceProps } from "./surfaces";

export function ProviderApiKeySection({
  config,
  selectedProviderId,
  onSelectedProviderChange,
  onUseProvider,
  providerStatuses,
  connectingProviderIds = [],
  providerApiKeyConfigured,
  savingProviderApiKeyId,
  onSaveProviderApiKey,
  onClearProviderApiKey,
}: Pick<
  SettingsSurfaceProps,
  | "config"
  | "onUseProvider"
  | "providerStatuses"
  | "connectingProviderIds"
  | "providerApiKeyConfigured"
  | "savingProviderApiKeyId"
  | "onSaveProviderApiKey"
  | "onClearProviderApiKey"
> & {
  selectedProviderId?: ProviderId;
  onSelectedProviderChange?: (id: ProviderId) => void;
}) {
  const providers = providersForConfig(config).filter((provider) =>
    providerSupportsApiKey(provider.id),
  );
  const [selectedId, setSelectedId] = useState("openai");
  const provider =
    providers.find((item) => item.id === (selectedProviderId ?? selectedId)) ??
    providers[0];
  if (!provider) return null;
  const health = providerStatuses?.find((status) => status.id === provider.id);
  const modelId = providerDefaultModelId(provider);
  const canUse =
    modelId &&
    !savingProviderApiKeyId &&
    !connectingProviderIds.includes(provider.id) &&
    providerApiKeyConfigured?.[provider.id] &&
    isProviderRuntimeUsable(provider, health) &&
    !providerNeedsSignInRepair(provider, health) &&
    health?.connectionStatus !== "failed" &&
    health?.connectionStatus !== "checking";
  return (
    <SettingsGroup label="Connect with an API key">
      <div className="gyro-provider-api-key-section">
        <ProviderApiKeyField
          key={provider.id}
          configured={Boolean(providerApiKeyConfigured?.[provider.id])}
          envName={providerApiKeyEnvName(provider.id)}
          onClear={() => onClearProviderApiKey?.(provider.id)}
          onSave={
            onSaveProviderApiKey
              ? (value) => onSaveProviderApiKey(provider.id, value)
              : undefined
          }
          saving={Boolean(savingProviderApiKeyId)}
        >
          <SettingsSelect
            aria-label="API key provider"
            disabled={Boolean(savingProviderApiKeyId)}
            onChange={(event) => {
              setSelectedId(event.target.value);
              onSelectedProviderChange?.(event.target.value as ProviderId);
            }}
            value={provider.id}
          >
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </SettingsSelect>
        </ProviderApiKeyField>
        {canUse && onUseProvider ? (
          <button
            className="gyro-primary-button"
            type="button"
            onClick={() => onUseProvider(provider.id, modelId!)}
          >
            Use in chat
          </button>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

/**
 * Picker, key and action on one line.
 *
 * The group is already titled "Connect with an API key", so the field carries
 * no heading of its own and keeps a single line of consequence underneath:
 * where the key is kept, and what quietly overrides it.
 */
function ProviderApiKeyField({
  children,
  configured,
  envName,
  onClear,
  onSave,
  saving = false,
}: {
  /** The provider picker, laid out inline with the key field. */
  children: ReactNode;
  configured: boolean;
  envName?: string;
  onClear?: () => void;
  onSave?: (value: string) => Promise<boolean> | undefined;
  saving?: boolean;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="gyro-provider-api-key">
      <div className="gyro-provider-api-key-row">
        {children}
        <input
          aria-label="Provider API key"
          autoComplete="off"
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            configured ? "Key saved — paste to replace" : "Paste API key"
          }
          spellCheck={false}
          type="password"
          value={draft}
        />
        <button
          className="gyro-primary-button"
          disabled={saving || !onSave || draft.trim().length === 0}
          onClick={async () => {
            if (await onSave?.(draft.trim())) setDraft("");
          }}
          type="button"
        >
          {saving ? "Saving…" : configured ? "Replace" : "Save"}
        </button>
        {configured ? (
          <button
            className="gyro-danger-button"
            disabled={saving}
            onClick={() => onClear?.()}
            type="button"
          >
            Remove
          </button>
        ) : null}
      </div>
      <span>
        Kept in the macOS Keychain.
        {envName ? (
          <>
            {" "}
            An existing <code>{envName}</code> takes priority.
          </>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Add or remove an endpoint the user defines.
 *
 * A custom provider is a config entry plus a Keychain key. The form collects
 * the endpoint and its model ids; the id itself is derived by the desktop layer
 * so the `custom:` prefix stays an implementation detail the user never types.
 */
export function CustomProviderSection({
  config,
  savingProviderApiKeyId,
  onAddCustomProvider,
  onRemoveCustomProvider,
  onFetchCustomProviderModels,
}: Pick<
  SettingsSurfaceProps,
  | "config"
  | "savingProviderApiKeyId"
  | "onAddCustomProvider"
  | "onRemoveCustomProvider"
  | "onFetchCustomProviderModels"
>) {
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelIds, setModelIds] = useState("");
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const busy = saving || fetching || Boolean(savingProviderApiKeyId);
  const customProviders = providersForConfig(config).filter((provider) =>
    isCustomProviderId(provider.id),
  );
  const parsedModelIds = modelIds
    .split(/[\n,]/)
    .map((model) => model.trim())
    .filter(Boolean);
  const canSubmit =
    Boolean(onAddCustomProvider) &&
    !busy &&
    displayName.trim().length > 0 &&
    baseUrl.trim().length > 0 &&
    parsedModelIds.length > 0;
  return (
    <SettingsGroup label="Custom providers">
      <div className="gyro-provider-custom-section">
        {customProviders.length > 0 ? (
          <ul className="gyro-provider-custom-list">
            {customProviders.map((provider) => (
              <li key={provider.id}>
                <div>
                  <strong>{provider.displayName}</strong>
                  <span>
                    <code>{provider.baseUrl}</code> · {provider.models.length}{" "}
                    model{provider.models.length === 1 ? "" : "s"}
                  </span>
                </div>
                <button
                  className="gyro-danger-button"
                  disabled={busy}
                  onClick={async () => {
                    setError(undefined);
                    setSaving(true);
                    try {
                      await onRemoveCustomProvider?.(provider.id);
                    } catch (failure) {
                      setError(String(failure));
                    } finally {
                      setSaving(false);
                    }
                  }}
                  type="button"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="gyro-provider-custom-form">
          <label>
            <span>Display name</span>
            <input
              aria-label="Custom provider display name"
              disabled={busy}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="My gateway"
              value={displayName}
            />
          </label>
          <label>
            <span>Base URL</span>
            <input
              aria-label="Custom provider base URL"
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://gateway.example.com/v1"
              spellCheck={false}
              value={baseUrl}
            />
          </label>
          <label>
            <span>API key</span>
            <input
              aria-label="Custom provider API key"
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Leave empty for a local server"
              spellCheck={false}
              type="password"
              value={apiKey}
            />
          </label>
          <div className="gyro-provider-custom-fetch">
            <button
              className="gyro-secondary-button"
              disabled={
                !onFetchCustomProviderModels ||
                busy ||
                baseUrl.trim().length === 0
              }
              onClick={async () => {
                setError(undefined);
                setFetching(true);
                try {
                  const models = await onFetchCustomProviderModels?.(
                    baseUrl.trim(),
                    apiKey,
                  );
                  if (models && models.length > 0) {
                    setModelIds(models.map((model) => model.id).join("\n"));
                  } else {
                    setError("The endpoint reported no models.");
                  }
                } catch (failure) {
                  setError(String(failure));
                } finally {
                  setFetching(false);
                }
              }}
              type="button"
            >
              <RefreshCw size={14} />
              {fetching ? "Fetching…" : "Fetch models"}
            </button>
          </div>
          <label className="is-wide">
            <span>Model ids</span>
            <textarea
              aria-label="Custom provider model ids"
              disabled={busy}
              onChange={(event) => setModelIds(event.target.value)}
              placeholder={"llama-3.3-70b\nqwen3-coder"}
              rows={3}
              spellCheck={false}
              value={modelIds}
            />
          </label>
          <div className="gyro-provider-custom-actions">
            <button
              className="gyro-primary-button"
              disabled={!canSubmit}
              onClick={async () => {
                setError(undefined);
                setSaving(true);
                try {
                  const added = await onAddCustomProvider?.({
                    displayName: displayName.trim(),
                    baseUrl: baseUrl.trim(),
                    apiKey,
                    modelIds: parsedModelIds,
                  });
                  if (added) {
                    setDisplayName("");
                    setBaseUrl("");
                    setApiKey("");
                    setModelIds("");
                  }
                } catch (failure) {
                  setError(String(failure));
                } finally {
                  setSaving(false);
                }
              }}
              type="button"
            >
              <Plus size={15} />
              Add provider
            </button>
          </div>
          {error ? <p className="gyro-provider-custom-error">{error}</p> : null}
          <p className="gyro-provider-custom-note">
            Plain HTTP is accepted only for localhost.
          </p>
        </div>
      </div>
    </SettingsGroup>
  );
}

/** Dismiss the disclosure when clicking outside its controls. */
export function ProviderDetailsMenu({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const detailsRef = useOutsidePointerDismiss<HTMLDetailsElement>(isOpen, () =>
    setIsOpen(false),
  );

  return (
    <details
      className="gyro-provider-details"
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      open={isOpen}
      ref={detailsRef}
    >
      <summary aria-label={label}>
        <MoreHorizontal size={16} />
      </summary>
      {children}
    </details>
  );
}
