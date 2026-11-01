/** Resolve the same provider as the composer: session/draft binding before the global default. */
export function isComposerCliUpdating(
  updatingProviderIds: readonly string[],
  sessionModel: { providerId?: string } | undefined,
  selectedProviderId: string | undefined,
): boolean {
  const providerId = sessionModel?.providerId || selectedProviderId;
  return Boolean(providerId && updatingProviderIds.includes(providerId));
}
