import type { SessionEvent } from "./types.ts";

export const PROVIDER_QUOTA_RECOVERY =
  "The provider rejected this turn because of a usage or credit limit. Reported plan windows may not include this limit. Check usage with the provider or switch provider; retry after the restriction is resolved.";

export function isProviderQuotaError(message: string) {
  return /\bquota[ _-]exceeded\b|\binsufficient_quota\b|\busage[ _-]?limit[ _-]?exceeded\b/i.test(message);
}

/** A provider rejection is independent of its reported rolling percentages. */
export function providerQuotaNotice(
  events: readonly SessionEvent[],
  providerId: string | undefined,
): string | undefined {
  if (!providerId) return undefined;
  let latest: SessionEvent | undefined;
  for (const event of events) {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (
      event.kind !== "system-event" ||
      payload?.kind !== "provider-status" ||
      payload.providerId !== providerId
    ) continue;
    if (!latest || event.createdAt >= latest.createdAt) latest = event;
  }
  const payload = latest?.payload as Record<string, unknown> | undefined;
  if (payload?.status !== "failed") return undefined;
  return payload.recoveryKind === "quota-exceeded" ||
    (typeof payload.error === "string" && isProviderQuotaError(payload.error))
    ? "The last turn was rejected by a provider quota. These plan windows may not include the limit that blocked it."
    : undefined;
}
