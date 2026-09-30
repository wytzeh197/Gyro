import { KeyRound, Laptop, UserCircle } from "lucide-react";
import { Badge } from "./primitives";
import { providerSupportsApiKey } from "./provider-catalog";
import type { ProviderId } from "./types";

/*
 * Pieces of Settings > Providers that group the list into Connected and
 * Available. The rows themselves stay in surfaces.tsx with their handlers.
 */

/** Scroll a Providers anchor into view and move focus there for keyboard users. */
export function revealProviderAnchor(id: string) {
  const section = document.getElementById(id);
  section?.scrollIntoView({ behavior: "instant", block: "start" });
  section?.focus({ preventScroll: true });
}

/**
 * One quiet line of jump links. These used to be three bordered cards that
 * read as information, though each one scrolled the page.
 */
export function ProviderJumpLinks({
  accountsTarget,
}: {
  /** The group to land on for sign-in: Available, or Connected when empty. */
  accountsTarget: string;
}) {
  const links = [
    [
      accountsTarget,
      "Account sign-in",
      "Use your provider’s sign-in.",
      UserCircle,
    ],
    [
      "gyro-provider-api-keys",
      "API key",
      "Use a key from your provider.",
      KeyRound,
    ],
    [
      "gyro-provider-ollama",
      "Local models",
      "Connect to Ollama on this Mac.",
      Laptop,
    ],
  ] as const;
  return (
    <nav className="gyro-provider-connect-path" aria-label="Connection methods">
      <span>Jump to</span>
      {links.map(([target, label, detail, Icon]) => (
        <button
          className="gyro-button is-ghost is-small"
          key={label}
          onClick={() => revealProviderAnchor(target)}
          title={detail}
          type="button"
        >
          <Icon aria-hidden="true" size={13} />
          {label}
        </button>
      ))}
    </nav>
  );
}

/** The group title leads sentence-case column labels, so one line names both. */
export function ProviderGroupHead({
  count,
  id,
  label,
  statusLabel,
}: {
  count: number;
  id: string;
  label: string;
  statusLabel: string;
}) {
  return (
    <div className="gyro-provider-table-head">
      <h2 id={id}>
        {label}
        <Badge>{count}</Badge>
      </h2>
      <span>Default model</span>
      <span>{statusLabel}</span>
    </div>
  );
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
 * How a provider that is not connected yet would connect. The Available list
 * shows this where a "not connected" status would otherwise repeat on every row.
 */
export function providerConnectMethodLabel(provider: {
  authMode: string;
  id: ProviderId;
}) {
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
