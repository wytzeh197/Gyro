import type { CommandProfile, ModelProviderConfig, ProviderStatus } from "./types";

// Interactive entry points, verified against each provider's CLI docs.
export function terminalDefaultProfiles(): CommandProfile[] {
  return [
    { id: "shell", displayName: "Shell", command: "zsh", args: ["-il"] },
    { id: "claude-code", displayName: "Claude Code", command: "claude", args: [], providerId: "anthropic" },
    { id: "codex", displayName: "Codex CLI", command: "codex", args: [], providerId: "openai" },
    { id: "kimi-code", displayName: "Kimi Code", command: "kimi", args: [], providerId: "kimi" },
    { id: "grok-build", displayName: "Grok Build", command: "grok", args: [], providerId: "xai" },
    { id: "gemini-cli", displayName: "Gemini CLI", command: "gemini", args: [], providerId: "gemini" },
    { id: "ollama", displayName: "Ollama (local)", command: "ollama", args: ["run"], providerId: "ollama" },
    { id: "cursor", displayName: "Cursor", command: "cursor-agent", args: [], providerId: "cursor" },
    { id: "opencode", displayName: "OpenCode", command: "opencode", args: [], providerId: "opencode" },
  ];
}

const aliases: Record<string, string> = {
  claude: "claude-code", kimi: "kimi-code", grok: "grok-build",
  gemini: "gemini-cli", "cursor-agent": "cursor",
};

export function terminalLaunchProfiles(
  saved: CommandProfile[], providers: ModelProviderConfig[], statuses: ProviderStatus[],
): CommandProfile[] {
  const defaults = terminalDefaultProfiles();
  const profiles = [...saved];
  for (const entry of defaults) {
    if (!profiles.some((profile) => (aliases[profile.id] ?? profile.id) === entry.id)) profiles.push(entry);
  }
  return profiles.map((profile): CommandProfile => {
    const builtin = defaults.find((entry) => entry.id === (aliases[profile.id] ?? profile.id));
    const providerId = profile.providerId || builtin?.providerId;
    const provider = providers.find((entry) => entry.id === providerId);
    const health = statuses.find((entry) => entry.id === providerId);
    let command = profile.command.trim() || builtin?.command || "";
    let args = profile.args;
    // Migrate the old HTTP-only marker only for terminal launches.
    if (command === "ollama-api") { command = "ollama"; args = ["run"]; }
    let launchUnavailableReason: string | undefined;
    const checkedDisconnected = Boolean(health?.healthCheckedAt &&
      (health.connectionStatus === "disconnected" || health.connectionStatus === "failed"));
    if (providerId && (!provider?.enabled || provider.authStatus !== "connected" || health?.signInRejectedAt || checkedDisconnected)) {
      launchUnavailableReason = "Not connected";
    } else if (profile.readiness === "blocked" && !profile.launchUnavailableReason) {
      launchUnavailableReason = "Unavailable";
    }
    if (providerId === "ollama" && command === "ollama" && args.length === 1 && args[0] === "run") {
      const model = profile.defaultModel || provider?.defaultModelId || provider?.selectedModelId;
      if (model) args = ["run", model];
      else launchUnavailableReason ??= "Choose a model";
    }
    return { ...profile, providerId, command, args, launchUnavailableReason,
      readiness: launchUnavailableReason ? "blocked" : "ready" };
  });
}
