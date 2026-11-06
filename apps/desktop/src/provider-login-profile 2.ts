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
