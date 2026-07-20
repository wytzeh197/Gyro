import type { MenuBarJob } from "@gyro-dev/ui";

export type MenuBarModelProvider =
  "anthropic" | "gemini" | "kimi" | "openai" | "xai" | "unknown";

const PROVIDER_ALIASES: Array<[MenuBarModelProvider, readonly RegExp[]]> = [
  ["openai", [/openai/, /chatgpt/, /\bgpt(?:-|\s|$)/, /\bcodex\b/]],
  ["anthropic", [/anthropic/, /\bclaude\b/]],
  ["kimi", [/\bkimi\b/, /moonshot/]],
  ["xai", [/\bxai\b/, /\bx\.ai\b/, /\bgrok\b/]],
  ["gemini", [/\bgemini\b/, /google ai/]],
];

export function menuBarModelProvider(job: MenuBarJob): MenuBarModelProvider {
  const providerId = job.providerId?.trim().toLowerCase();
  const exact = PROVIDER_ALIASES.find(([provider]) => provider === providerId);
  if (exact) return exact[0];

  const identity = [
    job.providerId,
    job.providerLabel,
    job.modelId,
    job.modelLabel,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    PROVIDER_ALIASES.find(([, aliases]) =>
      aliases.some((alias) => alias.test(identity)),
    )?.[0] ?? "unknown"
  );
}
