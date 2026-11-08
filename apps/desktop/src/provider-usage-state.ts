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
  previous?: ProviderUsageState,
): ProviderUsageState {
  // Poll replies and pushed readings share one ordering rule. A request can
  // finish after a newer push, including while recovering from an error.
  const previousMs = Date.parse(previous?.fetchedAt ?? "");
  const nextMs = Date.parse(snapshot.fetchedAt);
  if (
    previous &&
    Number.isFinite(previousMs) &&
    (!Number.isFinite(nextMs) || nextMs < previousMs)
  ) {
    return previous;
  }
  const hasWindows = snapshot.windows.length > 0;
  const next: ProviderUsageState = {
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
          : "The provider has not reported plan limits for this account."),
  };
  // An IPC poll and its broadcast often carry the very same cached reading.
  // Preserve identity so neither delivery rebuilds the full app unnecessarily.
  if (
    previous && previous.providerId === next.providerId &&
    previous.status === next.status && previous.fetchedAt === next.fetchedAt &&
    previous.stale === next.stale && previous.error === next.error &&
    previous.windows.length === next.windows.length &&
    previous.windows.every((window, index) => {
      const other = next.windows[index];
      return other && window.id === other.id && window.label === other.label &&
        window.usedPercent === other.usedPercent && window.status === other.status &&
        window.resetsAt === other.resetsAt;
    })
  ) return previous;
  return next;
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
