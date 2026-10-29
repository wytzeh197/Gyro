import type { CommandProfile, ProviderId } from "@gyro-dev/ui";

export function providerLoginProfile(providerId: ProviderId): CommandProfile {
  if (providerId === "anthropic") {
    return {
      args: ["auth", "login"],
      command: "claude",
      displayName: "Anthropic Login",
      id: "anthropic-login",
      workingDirectory: null,
    };
  }
  if (providerId === "cursor") {
    return {
      args: ["login"],
      command: "cursor-agent",
      displayName: "Cursor Login",
      id: "cursor-login",
      workingDirectory: null,
    };
  }
  if (providerId === "opencode") {
    return {
      args: ["auth", "login"],
      command: "opencode",
      displayName: "OpenCode Login",
      id: "opencode-login",
      workingDirectory: null,
    };
  }
  if (providerId === "kimi") {
    return {
      args: ["login"],
      command: "kimi",
      displayName: "Kimi Login",
      id: "kimi-login",
      workingDirectory: null,
    };
  }
  if (providerId === "xai") {
    return {
      args: ["login"],
      command: "grok",
      displayName: "xAI Login",
      id: "xai-login",
      workingDirectory: null,
    };
  }
  if (providerId === "gemini") {
    return {
      args: [],
      command: "gemini",
      displayName: "Gemini Login",
      id: "gemini-login",
      workingDirectory: null,
    };
  }

  return {
    args: ["login", "--device-auth"],
    command: "codex",
    displayName: "OpenAI Login",
    id: "openai-login",
    workingDirectory: null,
  };
}

export function providerLoginCommandText(profile: CommandProfile) {
  return [profile.command, ...profile.args].join(" ");
}

/** `provider_cli_install_plan_command`: how this machine can install a CLI. */
export type CliInstallPlanReport = {
  plan?: {
    providerId: string;
    program: string;
    command: string;
    args: string[];
    displayCommand: string;
    method: "npm-global" | "npm-user-prefix" | "installer";
  } | null;
  unavailable?: "unsupported" | "needsNode" | null;
  message?: string | null;
};

export function providerInstallProfile(
  providerId: ProviderId,
  plan: NonNullable<CliInstallPlanReport["plan"]>,
): CommandProfile {
  const login = providerLoginProfile(providerId);
  return {
    args: plan.args,
    command: plan.command,
    displayName: login.displayName.replace(/Login$/, "Install"),
    id: `${providerId}-install`,
    workingDirectory: null,
  };
}

const PROVIDER_CLI_NAMES: Partial<Record<ProviderId, string>> = {
  anthropic: "Claude Code",
  cursor: "Cursor Agent",
  gemini: "Gemini CLI",
  kimi: "Kimi CLI",
  openai: "Codex",
  opencode: "OpenCode",
  xai: "Grok CLI",
};

/** What people call the CLI a provider signs in through. */
export function providerCliName(providerId: ProviderId, providerLabel: string) {
  return PROVIDER_CLI_NAMES[providerId] ?? `the ${providerLabel} CLI`;
}
