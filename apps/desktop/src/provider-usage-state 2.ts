import type { ProviderId, ProviderUsageState } from "@gyro-dev/ui";

export type ProviderUsageSnapshot = {
  providerId: ProviderId;
  windows: ProviderUsageState["windows"];
  fetchedAt: string;
  stale?: boolean;
  error?: string;
};

export function providerUsageFromSnapshot(
  snapshot: ProviderUsageSnapshot,
): ProviderUsageState {
  const hasWindows = snapshot.windows.length > 0;
  return {
    providerId: snapshot.providerId,
    status: hasWindows ? "available" : "unavailable",
    windows: snapshot.windows,
    fetchedAt: snapshot.fetchedAt,
    stale: snapshot.stale,
    error:
      snapshot.error ??
      (hasWindows
        ? undefined
        : snapshot.providerId === "openai"
          ? "Codex did not report an active rolling usage window."
          : "No usage recorded yet for this provider. Send a message to start the ledger."),
  };
}

export function providerUsageAfterError(
  providerId: ProviderId,
  previous: ProviderUsageState | undefined,
  error: string,
): ProviderUsageState {
  const hasCachedWindows = Boolean(previous?.windows.length);
  return {
    providerId,
    status: hasCachedWindows ? "available" : "error",
    windows: previous?.windows ?? [],
    fetchedAt: previous?.fetchedAt,
    stale: hasCachedWindows,
    error,
  };
}
