import type {
  GyroConfig,
  ModelProviderConfig,
  ProviderId,
  ProviderModel,
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

type ProviderCatalogEntry = ModelProviderConfig & {
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
    models: [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Frontier model for complex professional work.",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: GPT_56_REASONING_EFFORTS,
      },
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        description: "Balances intelligence and cost for everyday work.",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: GPT_56_REASONING_EFFORTS,
      },
      {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        description: "Fast, cost-sensitive model for lighter workloads.",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: GPT_56_REASONING_EFFORTS,
      },
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Flagship model for complex reasoning and coding.",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: LEGACY_OPENAI_REASONING_EFFORTS,
      },
      {
        id: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "Balanced coding model with lower cost.",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: LEGACY_OPENAI_REASONING_EFFORTS,
      },
      {
        id: "gpt-5.4-mini",
        displayName: "GPT-5.4 mini",
        description: "Lower-latency model for lighter agent work.",
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
    models: [
      {
        id: "claude-fable-5",
        displayName: "Claude Fable 5",
        description: "Most capable broadly released Claude model.",
      },
      {
        id: "claude-opus-4-8",
        displayName: "Claude Opus 4.8",
        description: "Strong model for complex agentic coding.",
      },
      {
        id: "claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        description: "Best speed and intelligence balance.",
      },
      {
        id: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        description: "Fastest option for lighter work.",
      },
    ],
    effort: "high",
    allowedTools: ["files", "terminal", "diff"],
  },
  {
    id: "xai",
    displayName: "xAI",
    apiKeyRef: "provider-env:XAI_API_KEY",
    enabled: false,
    authMode: "env",
    authStatus: "not-connected",
    baseUrl: null,
    defaultModelId: "grok-build-0.1",
    selectedModelId: "grok-build-0.1",
    models: [
      {
        id: "grok-build-0.1",
        displayName: "Grok Build 0.1",
        description: "xAI coding model using an xAI API key.",
      },
      {
        id: "grok-4.3",
        displayName: "Grok 4.3",
        description: "General xAI model for chat and reasoning.",
      },
    ],
    effort: "medium",
    allowedTools: ["files", "terminal", "diff"],
  },
  {
    id: "gemini",
    displayName: "Gemini",
    apiKeyRef: "provider-env:GEMINI_API_KEY",
    enabled: false,
    authMode: "env",
    authStatus: "not-connected",
    baseUrl: null,
    defaultModelId: "gemini-default",
    selectedModelId: "gemini-default",
    models: [
      {
        id: "gemini-default",
        displayName: "Gemini",
        description:
          "Uses Gemini credentials from the local environment or Google-owned tooling.",
      },
    ],
    effort: "medium",
    allowedTools: ["files", "terminal", "diff"],
  },
];

export function isProviderId(value: unknown): value is ProviderId {
  return providerCatalog.some((provider) => provider.id === value);
}

export function getProviderCatalogEntry(providerId: ProviderId) {
  return providerCatalog.find((provider) => provider.id === providerId);
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
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: model.supportedReasoningEfforts,
      })),
      ...(savedProvider?.models ?? []).filter(
        (model) => !catalogModelIds.has(model.id),
      ),
    ];
    const selectedModelId =
      savedProvider?.selectedModelId &&
      models.some((model) => model.id === savedProvider.selectedModelId)
        ? savedProvider.selectedModelId
        : catalogProvider.selectedModelId;
    const authStatus =
      savedProvider?.authStatus ??
      (savedProvider?.enabled ? "connected" : catalogProvider.authStatus);

    return {
      ...catalogProvider,
      ...savedProvider,
      apiKeyRef: savedProvider?.apiKeyRef ?? catalogProvider.apiKeyRef,
      authMode:
        savedProvider?.authMode === "cli" ||
        savedProvider?.authMode === "env" ||
        savedProvider?.authMode === "sdk"
          ? savedProvider.authMode
          : catalogProvider.authMode,
      authStatus,
      baseUrl: savedProvider?.baseUrl ?? catalogProvider.baseUrl,
      enabled: authStatus === "connected",
      models,
      selectedModelId,
      selectedReasoningEffort: (() => {
        const model = models.find((item) => item.id === selectedModelId);
        const requested =
          savedProvider?.selectedReasoningEffort ??
          catalogProvider.selectedReasoningEffort;
        return requested && model?.supportedReasoningEfforts?.includes(requested)
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
