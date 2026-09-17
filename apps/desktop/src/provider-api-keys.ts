import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  providersForConfig,
  providerSupportsApiKey,
  type GyroConfig,
  type NotificationKind,
} from "@gyro-dev/ui";

export function useProviderApiKeys(
  config: GyroConfig,
  native: boolean,
  notify: (kind: NotificationKind, title: string, detail: string) => void,
  testProvider: (providerId: string) => Promise<void>,
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

  return {
    providerApiKeyConfigured,
    savingProviderApiKeyId,
    onSaveProviderApiKey: updateProviderApiKey,
    onClearProviderApiKey: (providerId: string) => {
      void updateProviderApiKey(providerId);
    },
  };
}
