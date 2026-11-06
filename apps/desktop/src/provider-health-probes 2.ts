import type {
  ModelProviderConfig,
  ProviderHealthDetails,
} from "@gyro-dev/ui";

/**
 * Readiness probing is a domain of its own: what a probe may reuse, which
 * changes make a previous answer worthless, and how a probe result is folded
 * into already-known details. Keeping it here keeps the desktop root under its
 * architecture ceiling and gives those rules one place to be read together.
 */

/** What the native readiness command answers with. */
export type ProviderHealthCheck = {
  providerId: string;
  output: string;
  runtimeStatus: string;
  authOwner: string;
  authCommand?: string | null;
  loginCommand?: string | null;
  accountLabel?: string | null;
  subscriptionLabel?: string | null;
  providerMode?: string | null;
  secretStorage: string;
  privacyNote: string;
  diagnosticsOptIn: boolean;
};

/**
 * Build the request the desktop sends for one provider's readiness.
 *
 * `force` marks an explicit user action. Pressing Connect, using "Test
 * provider", or a sign-in that just finished must never be answered by an
 * earlier probe: the person is asking precisely because the recorded state is
 * not good enough. Background readiness sweeps leave it unset so their repeats
 * can be served from a recent probe instead of starting another provider CLI.
 */
export function providerHealthRequest(
  provider: ModelProviderConfig | undefined,
  providerId?: string,
  options?: { force?: boolean },
) {
  return {
    apiKeyRef: provider?.apiKeyRef,
    baseUrl: provider?.baseUrl,
    force: options?.force ? true : undefined,
    providerId: provider?.id ?? providerId,
  };
}

/**
 * A value that changes only when a probe would read something different.
 *
 * The desktop's readiness sweep keys on this rather than on the provider array,
 * because `providersForConfig` returns a fresh array on every config write —
 * including the background Ollama model discovery, which changes only the local
 * model list. Keying on probe inputs means an unrelated update cannot start a
 * second round of provider CLI probes.
 */
export function providerProbeKey(provider: ModelProviderConfig) {
  return [
    provider.id,
    provider.enabled ? "on" : "off",
    provider.authStatus,
    provider.authMode,
    provider.apiKeyRef ?? "",
    provider.baseUrl ?? "",
  ].join("\u001f");
}

/** The stable dependency value for the readiness sweep. */
export function providerProbeKeyFor(
  providers: readonly ModelProviderConfig[],
): string {
  return providers.map(providerProbeKey).join("\u001e");
}

/**
 * What a probe learned, layered over what the renderer already inferred from the
 * probe's text output.
 *
 * The structured check wins where it has an answer, because parsing a CLI's
 * stdout is a fallback for providers that only give prose. The fallback still
 * supplies every field the check leaves absent.
 */
export function providerHealthDetailsFromCheck(
  check: ProviderHealthCheck,
  fallback: ProviderHealthDetails,
): ProviderHealthDetails {
  return {
    ...fallback,
    accountLabel: check.accountLabel ?? fallback.accountLabel,
    authCommand: check.authCommand ?? fallback.authCommand,
    authOwner: check.authOwner as ProviderHealthDetails["authOwner"],
    diagnosticsOptIn: check.diagnosticsOptIn,
    loginCommand: check.loginCommand ?? fallback.loginCommand,
    privacyNote: check.privacyNote,
    providerMode: check.providerMode ?? fallback.providerMode,
    runtimeStatus:
      check.runtimeStatus as ProviderHealthDetails["runtimeStatus"],
    secretStorage: check.secretStorage,
    subscriptionLabel: check.subscriptionLabel ?? fallback.subscriptionLabel,
  };
}
