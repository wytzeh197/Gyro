import { useLayoutEffect, useState, type ReactNode } from "react";
import { MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { SettingsGroup } from "./settings-controls";
import { useOutsidePointerDismiss } from "./menu-dismiss";
import { clippingBounds } from "./composer-popover-bounds";
import { providerDetailsPosition } from "./provider-details-position";
import {
  providersForConfig,
  providerSupportsApiKey,
  providerDefaultModelId,
  isProviderRuntimeUsable,
  providerNeedsSignInRepair,
  providerApiKeyEnvName,
  isCustomProviderId,
  getProviderCatalogEntry,
} from "./provider-catalog";
import type { GyroConfig, ProviderId } from "./types";
import type { SettingsSurfaceProps } from "./surfaces";

/** HTTPS presets first, then the CLIs that can also take a pasted key. */
const API_KEY_CHOICE_ORDER = [
  "deepseek",
  "mistral",
  "openrouter",
  "openai",
  "anthropic",
  "xai",
  "kimi",
  "antigravity",
  "cursor",
];

function apiKeyProviders(config: GyroConfig) {
  const rank = (id: string) => {
    const index = API_KEY_CHOICE_ORDER.indexOf(id);
    return index === -1 ? API_KEY_CHOICE_ORDER.length : index;
  };
  return providersForConfig(config)
    .filter((provider) => providerSupportsApiKey(provider.id))
    .sort((left, right) => {
      const byRank = rank(left.id) - rank(right.id);
      if (byRank !== 0) return byRank;
      return left.displayName.localeCompare(right.displayName);
    });
}

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
  renderProviderMark,
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
  /** The provider's own mark, so the picker reads like a row in the list. */
  renderProviderMark?: (id: ProviderId) => ReactNode;
}) {
  const providers = apiKeyProviders(config);
  const [selectedId, setSelectedId] = useState(
    () => selectedProviderId ?? providers[0]?.id ?? "deepseek",
  );
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
        <div
          aria-label="API key provider"
          className="gyro-provider-api-key-choices"
          role="listbox"
        >
          {providers.map((item) => {
            const selected = item.id === provider.id;
            return (
              <button
                aria-selected={selected}
                className={selected ? "is-selected" : undefined}
                disabled={Boolean(savingProviderApiKeyId)}
                key={item.id}
                onClick={() => {
                  setSelectedId(item.id);
                  onSelectedProviderChange?.(item.id as ProviderId);
                }}
                role="option"
                type="button"
              >
                {renderProviderMark?.(item.id as ProviderId)}
                <span>{item.displayName}</span>
              </button>
            );
          })}
        </div>
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
          action={
            canUse && onUseProvider ? (
              <button
                className="gyro-primary-button"
                type="button"
                onClick={() => onUseProvider(provider.id, modelId!)}
              >
                Use in chat
              </button>
            ) : null
          }
        />
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
  action,
  children,
  configured,
  envName,
  onClear,
  onSave,
  saving = false,
}: {
  /** The row's last action, so the band stays one line. */
  action?: ReactNode;
  /** Optional mark or picker, laid out inline with the key field. */
  children?: ReactNode;
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
        {action}
      </div>
      <span>
        Kept on this Mac.
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
 * A custom provider is a config entry plus a key kept on this Mac. The form collects
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
  useLayoutEffect(() => {
    const details = detailsRef.current;
    const summary = details?.querySelector("summary");
    const menu = details?.querySelector<HTMLElement>(":scope > div");
    if (!isOpen || !details || !summary || !menu) return;
    const position = () => {
      const scrollTop = menu.scrollTop;
      menu.style.top = "";
      menu.style.bottom = "";
      menu.style.translate = "";
      menu.style.maxHeight = "";
      const bounds = clippingBounds(menu);
      const availableWidth = Math.max(0, bounds.right - bounds.left - 16);
      menu.style.maxWidth = `${availableWidth}px`;
      menu.style.minWidth = `${Math.min(230, availableWidth)}px`;
      const anchor = summary.getBoundingClientRect();
      const natural = menu.getBoundingClientRect();
      const prefersUp = natural.bottom <= anchor.top;
      const gap = Math.max(
        0,
        prefersUp ? anchor.top - natural.bottom : natural.top - anchor.bottom,
      );
      const fitted = providerDetailsPosition({
        anchorTop: anchor.top,
        anchorBottom: anchor.bottom,
        boundsTop: bounds.top,
        boundsBottom: bounds.bottom,
        menuHeight: natural.height,
        prefersUp,
        gap,
      });
      menu.style.maxHeight = `${fitted.maxHeight}px`;
      menu.style.bottom = "auto";
      menu.style.top = `${fitted.top - details.getBoundingClientRect().top}px`;
      const rect = menu.getBoundingClientRect();
      const shift = Math.max(
        bounds.left + 8 - rect.left,
        Math.min(0, bounds.right - 8 - rect.right),
      );
      menu.style.translate = `${shift}px 0`;
      menu.scrollTop = scrollTop;
    };
    position();
    const observer = new ResizeObserver(position);
    for (
      let ancestor: HTMLElement | null = details;
      ancestor && ancestor !== document.body;
      ancestor = ancestor.parentElement
    ) {
      observer.observe(ancestor);
    }
    const onScroll = (event: Event) => {
      // Scrolling the capped menu must not reset its own scroll position.
      if (event.target === menu) return;
      position();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [isOpen, children]);

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

function providerRemoveCopy(provider: {
  id: string;
  displayName: string;
  capabilities?: { executionKind?: string };
}) {
  const name = provider.displayName;
  const kind = provider.capabilities?.executionKind;
  const cli =
    kind === "codex-cli" ||
    kind === "claude-code" ||
    kind === "kimi-acp" ||
    kind === "acp-cli";
  if (provider.id === "ollama" || kind === "ollama-api") {
    return `Removes ${name} from Gyro. The app on this Mac stays installed.`;
  }
  if (cli && providerSupportsApiKey(provider.id)) {
    return `Removes ${name} from Gyro and deletes a stored API key. The CLI on this Mac stays signed in.`;
  }
  if (cli) {
    return `Removes ${name} from Gyro. The CLI on this Mac stays signed in.`;
  }
  if (providerSupportsApiKey(provider.id)) {
    return `Removes ${name} from Gyro and deletes its stored API key.`;
  }
  return `Removes ${name} from Gyro.`;
}

/** Two-step remove for a shipped or custom provider. */
export function ProviderRemoveControl({
  provider,
  onRemove,
}: {
  provider: {
    id: string;
    displayName: string;
    capabilities?: { executionKind?: string };
  };
  onRemove?: (providerId: string) => Promise<boolean> | boolean | void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  if (!confirming) {
    return (
      <button
        className="gyro-danger-button"
        disabled={pending || !onRemove}
        onClick={() => setConfirming(true)}
        type="button"
      >
        Remove from Gyro
      </button>
    );
  }
  return (
    <>
      <p className="gyro-provider-remove-copy">{providerRemoveCopy(provider)}</p>
      <button
        className="gyro-danger-button"
        disabled={pending || !onRemove}
        onClick={() => {
          setPending(true);
          void Promise.resolve(onRemove?.(provider.id))
            .then((removed) => {
              if (removed !== false) setConfirming(false);
            })
            .finally(() => setPending(false));
        }}
        type="button"
      >
        {pending ? "Removing\u2026" : `Remove ${provider.displayName}`}
      </button>
      <button
        className="gyro-secondary-button"
        disabled={pending}
        onClick={() => setConfirming(false)}
        type="button"
      >
        Cancel
      </button>
    </>
  );
}

/** Shipped providers hidden by Remove, with a way back. */
export function RemovedProvidersSection({
  config,
  onRestoreProvider,
}: Pick<SettingsSurfaceProps, "config" | "onRestoreProvider">) {
  const removed = config.removedProviderIds ?? [];
  const [pendingId, setPendingId] = useState<string>();
  if (removed.length === 0) return null;
  return (
    <SettingsGroup label="Removed providers">
      <ul className="gyro-provider-custom-list">
        {removed.map((id) => {
          const name =
            getProviderCatalogEntry(id as ProviderId)?.displayName ?? id;
          return (
            <li key={id}>
              <div>
                <strong>{name}</strong>
                <span>Hidden from Gyro until you restore it.</span>
              </div>
              <button
                className="gyro-secondary-button"
                disabled={pendingId === id || !onRestoreProvider}
                onClick={() => {
                  setPendingId(id);
                  void Promise.resolve(onRestoreProvider?.(id)).finally(() =>
                    setPendingId(undefined),
                  );
                }}
                type="button"
              >
                {pendingId === id ? "Restoring\u2026" : "Restore"}
              </button>
            </li>
          );
        })}
      </ul>
    </SettingsGroup>
  );
}
