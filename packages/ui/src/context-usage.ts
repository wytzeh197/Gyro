import type { ProviderId, SessionEvent } from "./types";

export type ContextModelSelection = {
  providerId?: ProviderId;
  modelId?: string;
  modelLabel?: string;
  contextWindowTokens?: number;
};

export type ComposerContextUsage = {
  detail: string;
  label: string;
  modelLabel: string;
  percent: number;
  percentLabel: string;
  remainingLabel: string;
  source: "estimated" | "reported";
  title: string;
  usedLabel: string;
  windowLabel: string;
};

const PROVIDER_CONTEXT_WINDOW_FALLBACKS: Partial<Record<ProviderId, number>> = {
  anthropic: 200_000,
  gemini: 1_000_000,
  kimi: 1_000_000,
  openai: 128_000,
  xai: 131_072,
};

function recordFromUnknown(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function eventPayload(event: SessionEvent) {
  return recordFromUnknown(event.payload);
}

function estimatedEventCharacters(event: SessionEvent) {
  return event.kind === "session-created" ||
    event.kind === "system-event" ||
    event.kind === "chat-mode-changed" ||
    event.kind === "approval-requested" ||
    event.kind === "command-requested"
    ? 0
    : event.message.length;
}

function estimateTokens(characters: number) {
  return Math.ceil(Math.max(0, characters) / 4);
}

function formatCompactTokenCount(tokens: number) {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 2).replace(/\.0+$/, "")}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  }
  return String(tokens);
}

export function estimateComposerContextUsage(
  events: SessionEvent[],
  draft: string,
  model: ContextModelSelection,
): ComposerContextUsage {
  let reportedEventIndex = -1;
  let reportedUsage: Record<string, unknown> | undefined;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const payload = eventPayload(event);
    const usage = recordFromUnknown(payload?.contextUsage);
    if (finiteNumber(usage, "inputTokens") === undefined) continue;

    const eventProviderId = stringValue(payload, "providerId");
    const eventModelId = stringValue(payload, "modelId");
    if (model.providerId && eventProviderId !== model.providerId) continue;
    if (model.modelId && eventModelId !== model.modelId) continue;

    reportedEventIndex = index;
    reportedUsage = usage;
    break;
  }

  const reportedInputTokens = finiteNumber(reportedUsage, "inputTokens");
  const reportedOutputTokens = finiteNumber(reportedUsage, "outputTokens") ?? 0;
  const reportedTotalTokens = finiteNumber(reportedUsage, "totalTokens");
  const reportedContextWindow = finiteNumber(
    reportedUsage,
    "modelContextWindow",
  );
  const contextWindowTokens =
    (reportedContextWindow && reportedContextWindow > 0
      ? reportedContextWindow
      : undefined) ??
    (model.contextWindowTokens && model.contextWindowTokens > 0
      ? model.contextWindowTokens
      : undefined) ??
    PROVIDER_CONTEXT_WINDOW_FALLBACKS[model.providerId ?? "openai"] ??
    128_000;

  const estimatedCharacters = events
    .slice(reportedEventIndex >= 0 ? reportedEventIndex + 1 : 0)
    .reduce(
      (total, event) => total + estimatedEventCharacters(event),
      draft.length,
    );
  const liveEstimatedTokens = estimateTokens(estimatedCharacters);
  const reportedTokens =
    reportedInputTokens === undefined
      ? 0
      : Math.max(
          reportedInputTokens + reportedOutputTokens,
          reportedTotalTokens ?? 0,
        );
  const usedTokens = Math.max(0, reportedTokens + liveEstimatedTokens);
  const remainingTokens = Math.max(0, contextWindowTokens - usedTokens);
  const percent = Math.min(
    100,
    Math.max(0, Math.round((usedTokens / contextWindowTokens) * 100)),
  );
  const percentLabel = usedTokens > 0 && percent === 0 ? "<1%" : `${percent}%`;
  const usedLabel = formatCompactTokenCount(usedTokens);
  const remainingLabel = formatCompactTokenCount(remainingTokens);
  const windowLabel = formatCompactTokenCount(contextWindowTokens);
  const isReported = reportedInputTokens !== undefined;
  const modelLabel = model.modelLabel ?? model.modelId ?? "Selected model";
  const detail = isReported
    ? liveEstimatedTokens > 0
      ? "Provider-reported usage plus an estimate for newer thread content and this draft."
      : "Reported by the provider for the latest completed turn on this model."
    : "Estimated from context-bearing thread content and this draft; provider usage is not available yet.";

  return {
    detail,
    label: `${modelLabel} context: ${usedLabel} used, ${remainingLabel} remaining of ${windowLabel} tokens (${percentLabel})`,
    modelLabel,
    percent,
    percentLabel,
    remainingLabel,
    source: isReported ? "reported" : "estimated",
    title: `${modelLabel} context`,
    usedLabel,
    windowLabel,
  };
}
