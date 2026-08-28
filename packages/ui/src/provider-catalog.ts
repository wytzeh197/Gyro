import type {
  GyroConfig,
  ModelProviderConfig,
  ProviderAuthStatus,
  ProviderConnectionStatus,
  ProviderCapabilities,
  ProviderId,
  ProviderModel,
  ProviderRuntimeStatus,
  ProviderStatus,
  ReasoningEffort,
} from "./types";

export const LEGACY_OPENAI_REASONING_EFFORTS: ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

export const GPT_56_REASONING_EFFORTS: ReasoningEffort[] = [
  ...LEGACY_OPENAI_REASONING_EFFORTS,
  "max",
  "ultra",
];

/** The levels `claude --effort <level>` accepts. `ultra` has no equivalent. */
export const CLAUDE_REASONING_EFFORTS: ReasoningEffort[] = [
  ...LEGACY_OPENAI_REASONING_EFFORTS,
  "max",
];

/**
 * The levels Grok models offer for `--reasoning-effort`.
 *
 * The CLI's flag parser accepts more words than this, but each model publishes
 * its own selectable set and rejects the rest at turn time. Grok's shipped
 * models list low, medium, and high only.
 */
export const GROK_REASONING_EFFORTS: ReasoningEffort[] = [
  "low",
  "medium",
  "high",
];

/**
 * The thinking effort levels Kimi K3 accepts.
 *
 * The Kimi Code service provisions k3 with `support_efforts` of low, high,
 * and max (default high); any other value is rejected at turn time and the
 * session falls back to the model default.
 */
export const KIMI_K3_REASONING_EFFORTS: ReasoningEffort[] = [
  "low",
  "high",
  "max",
];

type ProviderCatalogEntry = ModelProviderConfig & {
  capabilities: ProviderCapabilities;
  defaultModelId: string;
  effort: ProviderStatus["effort"];
  allowedTools: string[];
};

export const providerCatalog: ProviderCatalogEntry[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    apiKeyRef: "provider-cli:codex",
    enabled: false,
    authMode: "cli",
    authStatus: "not-connected",
    baseUrl: null,
    defaultModelId: "gpt-5.6-sol",
    selectedModelId: "gpt-5.6-sol",
    selectedReasoningEffort: "medium",
    capabilities: {
      executionKind: "codex-cli",
      executable: true,
      supportsApprovals: true,
      supportsImages: true,
      supportsResume: true,
      supportsUsage: true,
      visibility: "standard",
    },
    models: [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Frontier model for complex professional work.",
        contextWindowTokens: 1_050_000,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: GPT_56_REASONING_EFFORTS,
      },
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        description: "Balances intelligence and cost for everyday work.",
        contextWindowTokens: 1_050_000,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: GPT_56_REASONING_EFFORTS,
      },
      {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        description: "Fast, cost-sensitive model for lighter workloads.",
        contextWindowTokens: 1_050_000,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: GPT_56_REASONING_EFFORTS,
      },
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Flagship model for complex reasoning and coding.",
        contextWindowTokens: 1_050_000,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: LEGACY_OPENAI_REASONING_EFFORTS,
      },
      {
        id: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "Balanced coding model with lower cost.",
        contextWindowTokens: 1_050_000,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: LEGACY_OPENAI_REASONING_EFFORTS,
      },
      {
        id: "gpt-5.4-mini",
        displayName: "GPT-5.4 mini",
        description: "Lower-latency model for lighter agent work.",
        contextWindowTokens: 400_000,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: LEGACY_OPENAI_REASONING_EFFORTS,
      },
    ],
    effort: "extra-high",
    allowedTools: ["files", "terminal", "diff", "browser"],
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    apiKeyRef: "provider-cli:claude",
    enabled: false,
    authMode: "cli",
    authStatus: "not-connected",
    baseUrl: null,
    defaultModelId: "claude-sonnet-5",
    selectedModelId: "claude-sonnet-5",
    selectedReasoningEffort: "high",
    capabilities: {
      executionKind: "claude-code",
      executable: true,
      supportsApprovals: true,
      supportsImages: true,
      supportsResume: true,
      // Plan windows stream mid-answer and are stored for poll/display.
      supportsUsage: true,
      visibility: "standard",
    },
    models: [
      {
        id: "claude-fable-5",
        displayName: "Claude Fable 5",
        description: "Most capable broadly released Claude model.",
        contextWindowTokens: 1_000_000,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS,
      },
      {
        id: "claude-opus-5",
        displayName: "Claude Opus 5",
        description:
          "Frontier model for complex agentic coding and long-horizon work.",
        contextWindowTokens: 1_000_000,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS,
      },
      {
        id: "claude-opus-4-8",
        displayName: "Claude Opus 4.8",
        description: "Strong model for complex agentic coding.",
        contextWindowTokens: 1_000_000,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS,
      },
      {
        id: "claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        description: "Best speed and intelligence balance.",
        contextWindowTokens: 1_000_000,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS,
      },
      {
        id: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        description: "Fastest option for lighter work.",
        contextWindowTokens: 200_000,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS,
      },
    ],
    effort: "high",
    allowedTools: ["files", "terminal", "diff"],
  },
  {
    id: "kimi",
    displayName: "Kimi",
    apiKeyRef: "provider-cli:kimi",
    enabled: false,
    authMode: "cli",
    authStatus: "not-connected",
    baseUrl: null,
    defaultModelId: "k3",
    selectedModelId: "k3",
    selectedReasoningEffort: "high",
    capabilities: {
      executionKind: "kimi-acp",
      executable: true,
      supportsApprovals: true,
      supportsImages: true,
      supportsResume: true,
      // Plan windows read from the Kimi account endpoint behind the CLI's own
      // usage view, using the sign-in the CLI already holds.
      supportsUsage: true,
      visibility: "standard",
    },
    models: [
      {
        id: "k3",
        displayName: "Kimi K3",
        description:
          "Kimi's flagship model for long-horizon coding and knowledge work.",
        // Every model Kimi Code defines caps at 256K, K3 included. Claiming a
        // megatoken window made the composer meter measure against a window the
        // run never had, and disagree with the one `/usage` reported back.
        contextWindowTokens: 262_144,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: KIMI_K3_REASONING_EFFORTS,
      },
    ],
    effort: "extra-high",
    allowedTools: ["files", "terminal", "diff"],
  },
  {
    id: "xai",
    displayName: "xAI",
    apiKeyRef: "provider-cli:grok",
    enabled: false,
    authMode: "cli",
    authStatus: "not-connected",
    baseUrl: null,
    defaultModelId: "grok-4.5",
    selectedModelId: "grok-4.5",
    selectedReasoningEffort: "high",
    capabilities: {
      executionKind: "acp-cli",
      executable: true,
      supportsApprovals: true,
      supportsImages: true,
      supportsResume: true,
      // Weekly plan % via Grok ACP `_x.ai/billing` (creditUsagePercent).
      supportsUsage: true,
      visibility: "standard",
    },
    models: [
      {
        id: "grok-4.5",
        displayName: "Grok 4.5",
        description: "xAI's coding-capable model through Grok Build.",
        contextWindowTokens: 131_072,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: GROK_REASONING_EFFORTS,
      },
      {
        id: "grok-4.3",
        displayName: "Grok 4.3",
        description: "General xAI model for chat and reasoning.",
        contextWindowTokens: 131_072,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: GROK_REASONING_EFFORTS,
      },
    ],
    effort: "medium",
    allowedTools: ["files", "terminal", "diff"],
  },
  {
    id: "gemini",
    displayName: "Gemini",
    apiKeyRef: "provider-cli:gemini",
    enabled: false,
    authMode: "cli",
    authStatus: "not-connected",
    baseUrl: null,
    defaultModelId: "gemini-default",
    selectedModelId: "gemini-default",
    capabilities: {
      executionKind: "acp-cli",
      executable: true,
      supportsApprovals: true,
      supportsImages: true,
      supportsResume: true,
      // No plan-window API; spend is the local ledger only (not fake 5h/weekly).
      supportsUsage: false,
      visibility: "standard",
    },
    models: [
      {
        id: "gemini-default",
        displayName: "Gemini",
        description:
          "Uses Gemini credentials from the local environment or Google-owned tooling.",
        contextWindowTokens: 1_000_000,
      },
    ],
    effort: "medium",
    allowedTools: ["files", "terminal", "diff"],
  },
  {
    id: "ollama",
    displayName: "Ollama",
    apiKeyRef: "local-runtime:ollama",
    enabled: false,
    authMode: "sdk",
    authStatus: "not-connected",
    baseUrl: "http://localhost:11434/api",
    // The installed-model list is supplied by the local runtime rather than
    // shipping a catalog that could advertise a model this Mac does not have.
    defaultModelId: "",
    selectedModelId: "",
    capabilities: {
      executionKind: "ollama-api",
      executable: true,
      supportsApprovals: true,
      supportsImages: false,
      supportsResume: true,
      supportsUsage: false,
      visibility: "standard",
    },
    models: [],
    effort: "medium",
    allowedTools: ["files", "terminal", "diff", "browser"],
  },
];

export function isProviderId(value: unknown): value is ProviderId {
  return providerCatalog.some((provider) => provider.id === value);
}

export function getProviderCatalogEntry(providerId: ProviderId) {
  return providerCatalog.find((provider) => provider.id === providerId);
}

export function providerCapabilities(providerId: ProviderId) {
  return getProviderCatalogEntry(providerId)?.capabilities;
}

export function isProviderExecutable(providerId: ProviderId) {
  return providerCapabilities(providerId)?.executable === true;
}

export function providerSupportsUsage(providerId: ProviderId) {
  return providerCapabilities(providerId)?.supportsUsage === true;
}

export function getProviderModel(
  provider: ModelProviderConfig,
  modelId?: string,
): ProviderModel | undefined {
  return provider.models.find(
    (model) => model.id === (modelId ?? provider.selectedModelId),
  );
}

export function selectedModelLabel(provider: ModelProviderConfig) {
  return (
    getProviderModel(provider)?.displayName ??
    provider.selectedModelId ??
    provider.models[0]?.displayName ??
    "Choose model"
  );
}

/**
 * Model a new session on this provider starts with.
 *
 * Falls back through the catalog default and then the first listed model so a
 * provider always resolves to something selectable, even if a saved default
 * points at a model the catalog has since dropped.
 */
export function providerDefaultModelId(provider: ModelProviderConfig) {
  const models = provider.models;
  if (
    provider.defaultModelId &&
    models.some((model) => model.id === provider.defaultModelId)
  ) {
    return provider.defaultModelId;
  }
  const catalogDefault = getProviderCatalogEntry(provider.id)?.defaultModelId;
  if (catalogDefault && models.some((model) => model.id === catalogDefault)) {
    return catalogDefault;
  }
  return models[0]?.id;
}

export function providerDefaultModel(
  provider: ModelProviderConfig,
): ProviderModel | undefined {
  return getProviderModel(provider, providerDefaultModelId(provider));
}

export function defaultModelLabel(provider: ModelProviderConfig) {
  return (
    providerDefaultModel(provider)?.displayName ??
    providerDefaultModelId(provider) ??
    "Choose model"
  );
}

export function selectedReasoningEffort(provider: ModelProviderConfig) {
  const model = getProviderModel(provider);
  const supported = model?.supportedReasoningEfforts ?? [];
  if (
    provider.selectedReasoningEffort &&
    supported.includes(provider.selectedReasoningEffort)
  ) {
    return provider.selectedReasoningEffort;
  }
  return model?.defaultReasoningEffort ?? supported[0];
}

/** Health probes observe provider state; they do not represent logout actions. */
export function providerAuthStatusAfterHealth(
  current: ProviderAuthStatus,
  connectionStatus: ProviderConnectionStatus,
): ProviderAuthStatus {
  return connectionStatus === "connected" ? "connected" : current;
}

export const PROVIDER_SIGN_IN_REJECTED_SUMMARY =
  "The provider rejected the sign-in Gyro sent with. Its status command still reports a stored login, so sign in again to repair it.";

/**
 * Health a provider carries once it has rejected the sign-in Gyro sent with.
 *
 * The provider CLIs answer their status commands from stored credentials
 * without checking them: `claude auth status` reports `loggedIn: true` for a
 * token the API expired weeks ago. A rejected send is the one observation that
 * proves otherwise, so it is recorded as health and, until a sign-in completes,
 * outranks every later probe. Without that precedence the next status command
 * would restore the "verified" claim the send just disproved.
 */
export function providerHealthAfterSignInRejection<
  T extends Pick<
    ProviderStatus,
    "connectionStatus" | "runtimeStatus" | "healthSummary" | "signInRejectedAt"
  >,
>(health: T, rejectedAt: string): T {
  return {
    ...health,
    connectionStatus: "not-configured",
    runtimeStatus: "not-logged-in",
    healthSummary: PROVIDER_SIGN_IN_REJECTED_SUMMARY,
    signInRejectedAt: rejectedAt,
  };
}

/** Whether a provider Gyro believes is connected can actually be used. */
export function providerNeedsSignInRepair(
  provider: Pick<ModelProviderConfig, "authStatus" | "enabled">,
  health?: Pick<ProviderStatus, "connectionStatus" | "runtimeStatus">,
) {
  return (
    provider.authStatus === "connected" &&
    !isProviderRuntimeUsable(provider, health)
  );
}

export function providerConnectionStatusFromRuntime(
  runtimeStatus: ProviderRuntimeStatus,
  fallback: ProviderConnectionStatus = "disconnected",
): ProviderConnectionStatus {
  switch (runtimeStatus) {
    case "ready":
      return "connected";
    case "not-installed":
    case "not-logged-in":
      return "not-configured";
    case "warning":
      return "failed";
    case "unknown":
    default:
      return fallback;
  }
}

/**
 * Definitive setup failures block execution. Transient warnings retain an
 * enabled provider so an offline or flaky probe cannot disable recoverable
 * work.
 */
export function isProviderRuntimeUsable(
  provider: Pick<ModelProviderConfig, "authStatus" | "enabled">,
  health?: Pick<ProviderStatus, "connectionStatus" | "runtimeStatus">,
) {
  if (!provider.enabled) {
    return false;
  }
  if (
    health?.runtimeStatus === "not-installed" ||
    health?.runtimeStatus === "not-logged-in"
  ) {
    return false;
  }
  return (
    provider.authStatus === "connected" ||
    (health?.connectionStatus === "connected" &&
      health.runtimeStatus === "ready")
  );
}

export function providersForConfig(config: GyroConfig): ModelProviderConfig[] {
  const savedProviders = new Map(
    config.modelProviders.map((provider) => [provider.id, provider]),
  );

  return providerCatalog.map((catalogProvider) => {
    const savedProvider = savedProviders.get(catalogProvider.id);
    const savedModels = new Map(
      (savedProvider?.models ?? []).map((model) => [model.id, model]),
    );
    const catalogModelIds = new Set(
      catalogProvider.models.map((model) => model.id),
    );
    const models = [
      ...catalogProvider.models.map((model) => ({
        ...model,
        ...savedModels.get(model.id),
        contextWindowTokens: model.contextWindowTokens,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: model.supportedReasoningEfforts,
      })),
      ...(savedProvider?.models ?? []).filter(
        (model) => !catalogModelIds.has(model.id),
      ),
    ];
    const defaultModelId =
      savedProvider?.defaultModelId &&
      models.some((model) => model.id === savedProvider.defaultModelId)
        ? savedProvider.defaultModelId
        : catalogProvider.defaultModelId;
    const selectedModelId =
      savedProvider?.selectedModelId &&
      models.some((model) => model.id === savedProvider.selectedModelId)
        ? savedProvider.selectedModelId
        : defaultModelId;
    const authStatus =
      savedProvider?.authStatus ??
      (savedProvider?.enabled ? "connected" : catalogProvider.authStatus);
    const authMode =
      savedProvider?.authMode === "cli" ||
      savedProvider?.authMode === "env" ||
      savedProvider?.authMode === "sdk"
        ? savedProvider.authMode
        : catalogProvider.authMode;

    return {
      ...catalogProvider,
      ...savedProvider,
      // Where a credential lives follows the auth mode, so a CLI-auth provider
      // takes the catalog's ref rather than whatever an older release saved.
      // xAI was once env-key based, and its stale `provider-env:XAI_API_KEY`
      // otherwise outlived the switch to CLI sign-in: the provider card claimed
      // an environment variable held the key while the same card said the Grok
      // CLI owned the session, and the `provider-env:` prefix steers the health
      // check toward reading an env var instead of the CLI login.
      apiKeyRef:
        authMode === "cli"
          ? catalogProvider.apiKeyRef
          : (savedProvider?.apiKeyRef ?? catalogProvider.apiKeyRef),
      authMode,
      authStatus,
      capabilities: catalogProvider.capabilities,
      baseUrl: savedProvider?.baseUrl ?? catalogProvider.baseUrl,
      enabled: authStatus === "connected",
      models,
      defaultModelId,
      selectedModelId,
      selectedReasoningEffort: (() => {
        const model = models.find((item) => item.id === selectedModelId);
        const requested =
          savedProvider?.selectedReasoningEffort ??
          catalogProvider.selectedReasoningEffort;
        return requested &&
          model?.supportedReasoningEfforts?.includes(requested)
          ? requested
          : model?.defaultReasoningEffort;
      })(),
    };
  });
}

export function normalizedConfig(config: GyroConfig): GyroConfig {
  const providers = providersForConfig(config);
  return {
    ...config,
    accountOidc: config.accountOidc ?? {
      issuerUrl: "local-device://gyro",
      clientId: "gyro-local-device",
      redirectLoopbackBase: "http://127.0.0.1",
      scopes: ["openid", "profile", "email", "offline_access"],
    },
    accountSession: config.accountSession ?? { signedIn: false },
    selectedProviderId: isProviderId(config.selectedProviderId)
      ? config.selectedProviderId
      : undefined,
    modelProviders: providers,
  };
}

export function defaultProviderStatuses(): ProviderStatus[] {
  return providerCatalog.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    connectionStatus: "not-configured",
    defaultModel:
      provider.models.find((model) => model.id === provider.defaultModelId)
        ?.displayName ?? provider.defaultModelId,
    effort: provider.effort,
    allowedTools: provider.allowedTools,
    approvalPolicy: "ask",
    authOwner:
      provider.authMode === "env"
        ? "provider-env"
        : provider.authMode === "sdk"
          ? "provider-sdk"
          : "provider-cli",
    runtimeStatus: "unknown",
    healthDetails: {
      authOwner:
        provider.authMode === "env"
          ? "provider-env"
          : provider.authMode === "sdk"
            ? "provider-sdk"
            : "provider-cli",
      diagnosticsOptIn: false,
      privacyNote:
        "Gyro stores readiness summaries only; provider tokens stay outside Gyro.",
      runtimeStatus: "unknown",
      secretStorage:
        provider.authMode === "env"
          ? "Environment variable or provider SDK store"
          : "Provider CLI, OS Keychain, or provider-owned files",
    },
  }));
}
