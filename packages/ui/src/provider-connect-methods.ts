import { providerSupportsApiKey } from "./provider-catalog.ts";
import type { ProviderId } from "./types";

/*
 * How a provider that is not connected yet would connect, in the words the
 * Available list of Settings > Providers uses. Kept free of JSX so the smoke
 * check can test the copy against the real catalog.
 */

type ConnectableProvider = { authMode: string; id: ProviderId };

/** What Connect does: a CLI sign-in, the API key form, or a local runtime check. */
export type ProviderConnectKind = "sign-in" | "api-key" | "local" | "environment";

export function providerConnectKind(
  provider: ConnectableProvider,
): ProviderConnectKind {
  if (provider.authMode === "env") {
    return providerSupportsApiKey(provider.id) ? "api-key" : "environment";
  }
  return provider.id === "ollama" ? "local" : "sign-in";
}

const CONNECT_METHOD_LABELS: Partial<Record<ProviderId, string>> = {
  anthropic: "Claude Code sign-in",
  gemini: "Gemini CLI sign-in",
  kimi: "Kimi Code sign-in",
  ollama: "Ollama on this Mac",
  openai: "Codex sign-in",
  xai: "Grok Build sign-in",
};

/**
 * The Available list shows this where a "not connected" status would
 * otherwise repeat on every row.
 */
export function providerConnectMethodLabel(provider: ConnectableProvider) {
  if (provider.authMode === "env") {
    return providerSupportsApiKey(provider.id)
      ? "API key"
      : "Environment variable";
  }
  return (
    CONNECT_METHOD_LABELS[provider.id] ??
    (provider.authMode === "cli" ? "CLI sign-in" : "Account sign-in")
  );
}

// One sentence per connect method, in the order the rows usually appear.
const AVAILABLE_NOTE_SENTENCES: Record<ProviderConnectKind, string> = {
  "sign-in":
    "Sign-in opens a terminal and may continue in your browser. Finish there, and the provider moves to Connected.",
  "api-key": "API key providers take a key in the form below.",
  local: "Ollama connects to the Ollama app running on this Mac.",
  environment:
    "Environment variable providers look for their key in your environment.",
};

/**
 * The note above the Available group. It only describes the connect methods
 * the listed providers use, so an API key provider is never told that a
 * terminal will open.
 */
export function providerAvailableNote(providers: ConnectableProvider[]) {
  const kinds = new Set(providers.map(providerConnectKind));
  return (Object.keys(AVAILABLE_NOTE_SENTENCES) as ProviderConnectKind[])
    .filter((kind) => kinds.has(kind))
    .map((kind) => AVAILABLE_NOTE_SENTENCES[kind])
    .join(" ");
}
