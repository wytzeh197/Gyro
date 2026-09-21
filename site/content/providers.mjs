// Verified against the published v0.1.0-alpha.49 provider registry.
export const providers = [
  {
    id: "codex",
    name: "Codex",
    kind: "CLI account",
    status: "Supported",
    requires:
      "Install Codex CLI and sign in with an account that has Codex access.",
    command: "codex login",
    url: "https://developers.openai.com/codex/cli/",
    limits: "Provider-owned access and usage limits apply.",
  },
  {
    id: "claude",
    name: "Claude Code",
    kind: "CLI account",
    status: "Supported",
    requires:
      "Install Claude Code and complete its own authentication before opening a Gyro session.",
    command: "claude",
    url: "https://code.claude.com/docs/en/setup",
    limits: "A Claude subscription is not interchangeable with API credit.",
  },
  {
    id: "kimi",
    name: "Kimi Code",
    kind: "CLI account",
    status: "Supported",
    requires:
      "Install Kimi Code CLI and complete its login. Gyro connects through ACP.",
    command: "kimi",
    url: "https://github.com/MoonshotAI/kimi-cli",
    limits: "Your Kimi Code account controls model access and allowance.",
  },
  {
    id: "grok",
    name: "Grok",
    kind: "CLI account",
    status: "Supported",
    requires:
      "Install and authenticate the Grok CLI with ACP support using the provider’s instructions.",
    url: "https://github.com/wytzeh197/Gyro/blob/v0.1.0-alpha.49/docs/architecture.md",
    limits: "An ordinary chat subscription does not establish CLI access.",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    kind: "CLI account",
    status: "Supported",
    requires:
      "Install Gemini CLI, start it, and complete its authentication flow.",
    command: "gemini",
    url: "https://geminicli.com/docs/get-started/installation/",
    limits:
      "Gyro does not report a remaining provider quota for this integration.",
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "Local runtime",
    status: "Supported",
    requires:
      "Run Ollama locally, download a model, then refresh models in Settings → Providers.",
    command: "ollama pull qwen3:0.6b",
    url: "/docs/local-models/",
    limits:
      "Models with tool support can use governed tools; other models are chat-only. Hardware needs depend on the model.",
  },
  {
    id: "cursor",
    name: "Cursor CLI",
    kind: "CLI account",
    status: "Experimental",
    requires: "Install and authenticate Cursor CLI with ACP support.",
    url: "https://cursor.com/docs/cli/overview",
    limits:
      "Experimental in Gyro. Image attachments are not supported by this adapter.",
  },
  {
    id: "opencode",
    name: "OpenCode",
    kind: "CLI account",
    status: "Experimental",
    requires:
      "Install OpenCode and configure its model credentials before starting a Gyro chat.",
    url: "https://opencode.ai/docs/",
    limits:
      "ACP readiness does not verify model credentials; access is checked when a prompt runs.",
  },
  ...[
    ["deepseek", "DeepSeek", "https://api.deepseek.com/v1"],
    ["mistral", "Mistral", "https://api.mistral.ai/v1"],
    ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1"],
  ].map(([id, name, endpoint]) => ({
    id,
    name,
    endpoint,
    kind: "API key",
    status: "Experimental",
    requires:
      "In Settings → Providers, choose the preset under Connect with an API key, then Save key.",
    url: "/docs/providers/#api-keys",
    limits:
      "Desktop chat only. Provider API billing is separate from subscriptions; Gyro reports observed usage, not remaining allowance.",
  })),
  {
    id: "custom",
    name: "Custom endpoint",
    kind: "API key / local",
    status: "Experimental",
    requires:
      "Add an OpenAI-compatible endpoint and model IDs in Settings → Providers → Add custom provider.",
    url: "/docs/providers/#custom",
    limits:
      "Use HTTPS remotely. Loopback HTTP endpoints can run without a key. Desktop chat only; compatibility depends on the endpoint.",
  },
];
