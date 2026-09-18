import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  providersForConfig,
  providerSupportsApiKey,
  CUSTOM_PROVIDER_PREFIX,
  type CustomProviderDraft,
  type CustomProviderId,
  type GyroConfig,
  type ModelProviderConfig,
  type NotificationKind,
} from "@gyro-dev/ui";

/**
 * A stable `custom:` id for a display name.
 *
 * The user names the provider; the id is Gyro's business, so it is derived and
 * de-duplicated rather than asked for.
 */
function customProviderIdFor(
  displayName: string,
  taken: string[],
): CustomProviderId {
  const slug =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider";
  // Annotated so the template literal keeps the `custom:` shape instead of
  // widening to `string`, which is what `ProviderId` accepts.
  const base: CustomProviderId = `${CUSTOM_PROVIDER_PREFIX}${slug}`;
  if (!taken.includes(base)) return base;
  let suffix = 2;
  while (taken.includes(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function useProviderApiKeys(
  config: GyroConfig,
  native: boolean,
  notify: (kind: NotificationKind, title: string, detail: string) => void,
  testProvider: (providerId: string) => Promise<void>,
  /** Persists a whole config object; App owns the optimistic state update. */
  persistConfig: (config: GyroConfig) => Promise<unknown>,
) {
  const [providerApiKeyConfigured, setProviderApiKeyConfigured] = useState<
    Partial<Record<string, boolean>>
  >({});
  const [savingProviderApiKeyId, setSavingProviderApiKeyId] =
    useState<string>();
  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    void Promise.all(
      providersForConfig(config)
        .filter((provider) => providerSupportsApiKey(provider.id))
        .map(async (provider) => {
          try {
            const status = await invoke<{ configured: boolean }>(
              "provider_api_key_status",
              { providerId: provider.id },
            );
            if (!cancelled)
              setProviderApiKeyConfigured((current) => ({
                ...current,
                [provider.id]: status.configured,
              }));
          } catch {
            // Leave status unknown when Keychain is unavailable.
          }
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [config, native]);

  const updateProviderApiKey = useCallback(
    async (providerId: string, value?: string) => {
      if (!native) {
        notify(
          "command-failed",
          "API key unavailable",
          "Open the desktop app to save a key.",
        );
        return false;
      }
      setSavingProviderApiKeyId(providerId);
      try {
        const status = await invoke<{ configured: boolean }>(
          value === undefined
            ? "clear_provider_api_key"
            : "set_provider_api_key",
          { providerId, ...(value === undefined ? {} : { value }) },
        );
        setProviderApiKeyConfigured((current) => ({
          ...current,
          [providerId]: status.configured,
        }));
        notify(
          "provider",
          status.configured ? "API key saved" : "API key removed",
          providerId,
        );
        await testProvider(providerId);
        return true;
      } catch {
        notify(
          "command-failed",
          "Could not update API key",
          "Check Keychain access and try again.",
        );
        return false;
      } finally {
        setSavingProviderApiKeyId(undefined);
      }
    },
    [native, notify, testProvider],
  );

  /**
   * Add a user-defined endpoint.
   *
   * The config entry is what makes the provider exist; the key is a separate
   * Keychain write, so a failed key save still leaves a usable provider the
   * user can add a key to. `custom:` is the prefix the Rust side routes to the
   * HTTPS runner, and `enabled` is required for a run to be allowed at all.
   */
  const addCustomProvider = useCallback(
    async (draft: CustomProviderDraft) => {
      if (!native) {
        notify(
          "command-failed",
          "Provider unavailable",
          "Open the desktop app to add a provider.",
        );
        return false;
      }
      const displayName = draft.displayName.trim();
      const baseUrl = draft.baseUrl.trim();
      const modelIds = draft.modelIds
        .map((model) => model.trim())
        .filter(Boolean);
      if (!displayName || !baseUrl || modelIds.length === 0) {
        notify(
          "command-failed",
          "Provider incomplete",
          "A name, a base URL, and at least one model id are required.",
        );
        return false;
      }
      const id = customProviderIdFor(
        displayName,
        config.modelProviders.map((provider) => provider.id),
      );
      // Only the persisted fields exist yet: `models`, `authMode`, and
      // `authStatus` are derived by `providersForConfig` on the next render,
      // and are deliberately not written to the config file.
      const entry = {
        id,
        displayName,
        baseUrl,
        apiKeyRef: `provider:${id}`,
        enabled: true,
        defaultModelId: modelIds[0],
        kind: "openai-compatible",
        modelIds,
      } as ModelProviderConfig;
      try {
        await persistConfig({
          ...config,
          modelProviders: [...config.modelProviders, entry],
        });
      } catch {
        notify("command-failed", "Could not add provider", displayName);
        return false;
      }
      if (draft.apiKey?.trim()) {
        const saved = await updateProviderApiKey(id, draft.apiKey.trim());
        if (!saved) return false;
      }
      notify("provider", "Custom provider added", displayName);
      await testProvider(id);
      return true;
    },
    [config, native, notify, persistConfig, testProvider, updateProviderApiKey],
  );

  const removeCustomProvider = useCallback(
    async (providerId: string) => {
      if (!native) {
        notify(
          "command-failed",
          "Provider unavailable",
          "Open the desktop app to remove a provider.",
        );
        return false;
      }
      try {
        await persistConfig({
          ...config,
          // A removed provider cannot stay the default for new chats.
          selectedProviderId:
            config.selectedProviderId === providerId
              ? undefined
              : config.selectedProviderId,
          modelProviders: config.modelProviders.filter(
            (provider) => provider.id !== providerId,
          ),
        });
      } catch {
        notify("command-failed", "Could not remove provider", providerId);
        return false;
      }
      // The entry is gone either way, so a Keychain failure is reported by the
      // key path itself rather than blocking the removal.
      await updateProviderApiKey(providerId);
      notify("provider", "Custom provider removed", providerId);
      return true;
    },
    [config, native, notify, persistConfig, updateProviderApiKey],
  );

  /**
   * Ask an endpoint which models it serves.
   *
   * The draft key is passed so the button works before the provider is saved;
   * the backend falls back to a stored key when the form has none.
   */
  const fetchCustomProviderModels = useCallback(
    async (baseUrl: string, apiKey?: string) => {
      const result = await invoke<{
        models: { id: string; displayName: string }[];
      }>("list_custom_provider_models", {
        baseUrl,
        apiKey: apiKey?.trim() ? apiKey.trim() : undefined,
      });
      return result.models;
    },
    [],
  );

  return {
    providerApiKeyConfigured,
    savingProviderApiKeyId,
    onSaveProviderApiKey: updateProviderApiKey,
    onClearProviderApiKey: (providerId: string) => {
      void updateProviderApiKey(providerId);
    },
    onAddCustomProvider: addCustomProvider,
    onRemoveCustomProvider: removeCustomProvider,
    onFetchCustomProviderModels: fetchCustomProviderModels,
  };
}
