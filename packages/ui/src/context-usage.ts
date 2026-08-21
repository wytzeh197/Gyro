import type { ProviderId, ProviderUsageWindow, SessionEvent } from "./types";

export type ContextModelSelection = {
  providerId?: ProviderId;
  modelId?: string;
  modelLabel?: string;
  contextWindowTokens?: number;
};

/** A plan limit as the composer meter renders it. */
export type ComposerLimitWindow = {
  id: string;
  label: string;
  /** Absent when the provider names the window but never measures it. */
  percent?: number;
  /** `<1%`, `84%`, or an em dash when the level is unknown. */
  percentLabel: string;
  resetsLabel?: string;
  severity: "normal" | "warning" | "critical";
  status: "ok" | "warning" | "exhausted" | "unknown";
};

export type ComposerContextUsage = {
  detail: string;
  label: string;
  modelLabel: string;
  percent: number;
  /** Raw counts, for callers that must do arithmetic rather than render text. */
  usedTokens: number;
  contextWindowTokens: number;
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

function trimTrailingZeros(value: string) {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

/**
 * Tokens above which rounding to the nearest thousand reaches four digits.
 *
 * The unit is chosen from the rounded value, not the raw one. Picking it from
 * the raw value let 999,666 remaining tokens round up inside the thousands
 * branch and print "1000K remaining" against a 1M window — more headroom than
 * the window holds, written in a unit the meter never otherwise uses.
 */
const COMPACT_MILLIONS_THRESHOLD = 999_500;

function formatCompactTokenCount(tokens: number) {
  if (tokens >= COMPACT_MILLIONS_THRESHOLD) {
    const millions = (tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 2);
    return `${trimTrailingZeros(millions)}M`;
  }
  if (tokens >= 1_000) {
    const thousands = (tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1);
    return `${trimTrailingZeros(thousands)}K`;
  }
  return String(tokens);
}

/**
 * The window the next send will actually have.
 *
 * Gyro's catalog answers for the model that is selected *now*, so it leads. A
 * reported window is a record of what some earlier turn ran with: a chat that
 * spoke to Claude Code before it served Opus 5 its full window carries a 200K
 * reading forever, and the meter would keep measuring a 1M model against it.
 * The reported figure still answers for models the catalog does not list.
 */
function resolveContextWindow(
  reportedContextWindow: number | undefined,
  model: ContextModelSelection,
) {
  return (
    (model.contextWindowTokens && model.contextWindowTokens > 0
      ? model.contextWindowTokens
      : undefined) ??
    (reportedContextWindow && reportedContextWindow > 0
      ? reportedContextWindow
      : undefined) ??
    PROVIDER_CONTEXT_WINDOW_FALLBACKS[model.providerId ?? "openai"] ??
    128_000
  );
}

/**
 * The tokens a usage record says the conversation occupies.
 *
 * `totalTokens` and the input/output pair disagree often enough that the
 * larger of the two is the honest reading.
 */
function occupiedTokens(usage: Record<string, unknown>) {
  const inputTokens = finiteNumber(usage, "inputTokens") ?? 0;
  const outputTokens = finiteNumber(usage, "outputTokens") ?? 0;
  return Math.max(
    inputTokens + outputTokens,
    finiteNumber(usage, "totalTokens") ?? 0,
  );
}

export function estimateComposerContextUsage(
  events: SessionEvent[],
  draft: string,
  model: ContextModelSelection,
): ComposerContextUsage {
  let reportedEventIndex = -1;
  let reportedUsage: Record<string, unknown> | undefined;
  let reportedModelId: string | undefined;
  // The window and the token counts come from different places. Every provider
  // reports the window Gyro resolved for its model, but only some report what
  // the turn spent, so a run that carries a window and no counts still has to
  // size the meter correctly while the estimate fills in the usage.
  let reportedContextWindow: number | undefined;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const payload = eventPayload(event);
    const usage = recordFromUnknown(payload?.contextUsage);
    if (!usage) continue;

    const eventModelId = stringValue(payload, "modelId");
    const matchesModel =
      (!model.providerId ||
        stringValue(payload, "providerId") === model.providerId) &&
      (!model.modelId || eventModelId === model.modelId);
    // The window is only meaningful for the model that reported it.
    if (matchesModel && reportedContextWindow === undefined) {
      reportedContextWindow = finiteNumber(usage, "modelContextWindow");
    }
    if (reportedUsage) continue;
    if (finiteNumber(usage, "inputTokens") === undefined) continue;
    // A run that used tools bills the re-sent conversation once per request, so
    // some CLIs report a turn total several times the window. Nothing can
    // occupy more of the window than it holds, so a reading that large is
    // ignored and the thread estimate stands in — including for turns recorded
    // before Gyro stopped storing those totals.
    if (
      occupiedTokens(usage) > resolveContextWindow(reportedContextWindow, model)
    ) {
      continue;
    }

    // How full the thread is belongs to the conversation, not to the model that
    // last read it: switching model or provider mid-chat does not empty it. The
    // newest reading therefore stands even when another model produced it,
    // rather than dropping the meter back to an estimate that counts only the
    // text Gyro stored and reads as near-empty.
    reportedEventIndex = index;
    reportedUsage = usage;
    reportedModelId = eventModelId;
    if (matchesModel) break;
  }

  const reportedInputTokens = finiteNumber(reportedUsage, "inputTokens");
  const reportedOutputTokens = finiteNumber(reportedUsage, "outputTokens") ?? 0;
  const reportedTotalTokens = finiteNumber(reportedUsage, "totalTokens");
  const contextWindowTokens = resolveContextWindow(
    reportedContextWindow,
    model,
  );

  let estimatedCharacters = draft.length;
  for (
    let index = reportedEventIndex >= 0 ? reportedEventIndex + 1 : 0;
    index < events.length;
    index += 1
  ) {
    const event = events[index];
    if (event) {
      estimatedCharacters += estimatedEventCharacters(event);
    }
  }
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
  const isOtherModelReading = Boolean(
    isReported &&
      reportedModelId &&
      model.modelId &&
      reportedModelId !== model.modelId,
  );
  const detail = isReported
    ? isOtherModelReading
      ? `Measured on the last turn, which ran on ${reportedModelId}; the thread carries the same content into this model.`
      : liveEstimatedTokens > 0
        ? "Provider-reported usage plus an estimate for newer thread content and this draft."
        : "Reported by the provider for the latest completed turn on this model."
    : "Estimated from context-bearing thread content and this draft; provider usage is not available yet.";

  return {
    contextWindowTokens,
    detail,
    label: `${modelLabel} context: ${usedLabel} used, ${remainingLabel} remaining of ${windowLabel} tokens (${percentLabel})`,
    modelLabel,
    percent,
    usedTokens,
    percentLabel,
    remainingLabel,
    source: isReported ? "reported" : "estimated",
    title: `${modelLabel} context`,
    usedLabel,
    windowLabel,
  };
}

const LIMIT_WINDOW_ORDER = ["five-hour", "weekly"];

/**
 * Providers whose accounts actually meter plan windows we can surface.
 *
 * OpenAI/Claude: 5h + weekly. xAI/Grok Build: weekly credit window only.
 * Kimi: the context window its `/usage` reports (plan quota lines join when
 * the CLI prints them). Gemini: no plan-window API — local ledger only.
 */
const PLAN_LIMIT_PROVIDERS = new Set<ProviderId>([
  "anthropic",
  "kimi",
  "openai",
  "xai",
]);

/**
 * Default empty plan rows before the first poll, per provider shape.
 *
 * Listed from the start so a fresh session does not look like “no limits”
 * before the first reading arrives.
 */
function defaultPlanLimitWindows(
  providerId: ProviderId | undefined,
): ProviderUsageWindow[] {
  if (providerId === "xai") {
    return [{ id: "weekly", label: "Weekly limit" }];
  }
  if (providerId === "kimi") {
    return [{ id: "context", label: "Context window" }];
  }
  return [
    { id: "five-hour", label: "5-hour limit" },
    { id: "weekly", label: "Weekly limit" },
  ];
}

/**
 * When a window resets, phrased the way a limit is actually read.
 *
 * A reset inside the day is a countdown — what matters is how long until work
 * can resume. A reset further out is a calendar point, where "in 4 days" says
 * less than the weekday and time do.
 */
export function formatLimitReset(
  resetsAt: string | undefined,
  now = Date.now(),
) {
  if (!resetsAt) return undefined;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return undefined;
  const remainingMs = resetMs - now;
  if (remainingMs <= 0) return "Resetting now";
  if (remainingMs < 24 * 60 * 60 * 1_000) {
    const totalMinutes = Math.ceil(remainingMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `Resets in ${minutes} min`;
    if (minutes === 0) return `Resets in ${hours} hr`;
    return `Resets in ${hours} hr ${minutes} min`;
  }
  return `Resets ${new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetMs))}`;
}

function limitSeverity(percent: number | undefined, status: string) {
  if (status === "exhausted" || (percent !== undefined && percent >= 95)) {
    return "critical" as const;
  }
  if (status === "warning" || (percent !== undefined && percent >= 80)) {
    return "warning" as const;
  }
  return "normal" as const;
}

function toLimitWindow(
  window: ProviderUsageWindow,
  now: number,
): ComposerLimitWindow {
  const percent =
    typeof window.usedPercent === "number" &&
    Number.isFinite(window.usedPercent)
      ? Math.min(100, Math.max(0, Math.round(window.usedPercent)))
      : undefined;
  const status = window.status ?? (percent === undefined ? "unknown" : "ok");
  return {
    id: window.id,
    label: window.label,
    percent,
    percentLabel:
      percent === undefined
        ? status === "exhausted"
          ? "Limit reached"
          : "—"
        : percent === 0 && window.usedPercent
          ? "<1%"
          : `${percent}%`,
    resetsLabel: formatLimitReset(window.resetsAt, now),
    severity: limitSeverity(percent, status),
    status,
  };
}

/**
 * The plan limits to show beneath the context bar.
 *
 * Two providers answer this two different ways. Codex is polled on demand and
 * arrives as a snapshot; Claude Code announces its windows mid-answer and they
 * are read back off the thread. A polled snapshot is the newer of the two by
 * construction, so it wins where both describe the same window.
 */
export function composerLimitWindows(
  events: SessionEvent[],
  model: ContextModelSelection,
  polledWindows: ProviderUsageWindow[] = [],
  now = Date.now(),
): ComposerLimitWindow[] {
  const byId = new Map<string, ProviderUsageWindow>();

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const payload = eventPayload(event);
    const reported = payload?.rateLimits;
    if (!Array.isArray(reported) || reported.length === 0) continue;

    const eventProviderId = stringValue(payload, "providerId");
    if (model.providerId && eventProviderId !== model.providerId) continue;

    for (const entry of reported) {
      const record = recordFromUnknown(entry);
      const id = stringValue(record, "id");
      const label = stringValue(record, "label");
      if (!id || !label || byId.has(id)) continue;
      byId.set(id, {
        id,
        label,
        usedPercent: finiteNumber(record, "usedPercent"),
        status: stringValue(record, "status") as ProviderUsageWindow["status"],
        resetsAt: stringValue(record, "resetsAt"),
      });
    }
    break;
  }

  for (const window of polledWindows) {
    byId.set(window.id, window);
  }

  // A provider that names windows Gyro does not model is describing its own
  // allowance, and padding it with the standard pair would invent limits it
  // never claimed. Only a provider still speaking the standard vocabulary gets
  // the missing halves filled in. Local ledger spend rows ("ledger-*") sit
  // beside the plan vocabulary and never suppress it.
  const speaksDefaultWindows = [...byId.keys()].every(
    (id) => LIMIT_WINDOW_ORDER.includes(id) || id.startsWith("ledger-"),
  );
  if (
    model.providerId &&
    PLAN_LIMIT_PROVIDERS.has(model.providerId) &&
    speaksDefaultWindows
  ) {
    for (const window of defaultPlanLimitWindows(model.providerId)) {
      if (!byId.has(window.id)) byId.set(window.id, window);
    }
  }

  return [...byId.values()]
    .sort((left, right) => {
      const leftRank = LIMIT_WINDOW_ORDER.indexOf(left.id);
      const rightRank = LIMIT_WINDOW_ORDER.indexOf(right.id);
      return (
        (leftRank === -1 ? LIMIT_WINDOW_ORDER.length : leftRank) -
        (rightRank === -1 ? LIMIT_WINDOW_ORDER.length : rightRank)
      );
    })
    .map((window) => toLimitWindow(window, now));
}
