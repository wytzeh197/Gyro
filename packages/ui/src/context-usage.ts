import type { ProviderId, ProviderUsageWindow, SessionEvent } from "./types";
import { providerCatalog } from "./provider-catalog.ts";
import { remainingUsage } from "./usage-remaining.ts";
import { formatCompactTokenCount, isTokenCount } from "./token-count.ts";

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
  remainingPercent?: number;
  remainingPercentLabel: string;
  resetsLabel?: string;
  severity: "normal" | "warning" | "critical";
  status: "ok" | "warning" | "exhausted" | "unknown";
};

export type ComposerContextUsage = {
  providerId?: ProviderId;
  modelId?: string;
  reportedContextWindowTokens?: number;
  detail: string;
  label: string;
  modelLabel: string;
  percent: number;
  /** Raw counts, for callers that must do arithmetic rather than render text. */
  usedTokens: number;
  contextWindowTokens: number;
  percentLabel: string;
  remainingLabel: string;
  remainingPercent?: number;
  remainingPercentLabel: string;
  source: "estimated" | "reported";
  title: string;
  usedLabel: string;
  windowLabel: string;
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

export function estimatedEventCharacters(event: SessionEvent) {
  const payload = eventPayload(event);
  if (event.kind === "system-event" && payload?.kind === "provider-activity") {
    return [event.message, payload.detail, payload.note]
      .filter((value): value is string => typeof value === "string")
      .join("\n").length;
  }
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

function tokenCount(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return isTokenCount(value) ? value : undefined;
}

/**
 * The window the next send will actually have.
 *
 * A runtime report for the selected provider and model leads: CLI settings,
 * account entitlements, and local allocations can differ from the catalog.
 * The caller excludes reports from other models before resolving the window.
 * Until a session reports its window, use the selected model's catalog value.
 */
function resolveContextWindow(
  reportedContextWindow: number | undefined,
  model: ContextModelSelection,
) {
  return (
    (reportedContextWindow && reportedContextWindow > 0
      ? reportedContextWindow
      : undefined) ??
    (model.contextWindowTokens && model.contextWindowTokens > 0
      ? model.contextWindowTokens
      : undefined) ??
    providerCatalog
      .find((provider) => provider.id === model.providerId)
      ?.models.find((entry) => entry.id === model.modelId)?.contextWindowTokens
  );
}

/**
 * The tokens a usage record says the conversation occupies.
 *
 * Reject malformed or contradictory counts rather than label them measured.
 * Repeated request consumption is kept separate from this occupancy reading.
 */
function occupiedTokens(usage: Record<string, unknown>) {
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "modelContextWindow",
  ]) {
    if (usage[key] != null && !isTokenCount(usage[key])) return undefined;
  }
  const input = tokenCount(usage, "inputTokens");
  const output = tokenCount(usage, "outputTokens");
  const total = tokenCount(usage, "totalTokens");
  if (input === undefined) return undefined;
  const sum = input + (output ?? 0);
  if (
    !isTokenCount(sum) ||
    (total !== undefined &&
      (total < sum || (output !== undefined && total !== sum)))
  )
    return undefined;
  return total ?? sum;
}

function usableOccupancy(
  usage: Record<string, unknown>,
  payload: Record<string, unknown> | undefined,
  model: ContextModelSelection,
) {
  const occupancy = occupiedTokens(usage);
  if (occupancy === undefined) return undefined;
  const providerId = stringValue(payload, "providerId") as
    ProviderId | undefined;
  const modelId = stringValue(payload, "modelId");
  const matchesModel =
    (!model.providerId || providerId === model.providerId) &&
    (!model.modelId || modelId === model.modelId);
  const observationWindow =
    tokenCount(usage, "modelContextWindow") ||
    resolveContextWindow(
      undefined,
      matchesModel ? model : { providerId, modelId },
    );
  // Switching to a smaller model does not empty the previous model's context.
  // Reject impossible observations against the window that produced them.
  return occupancy <= (observationWindow ?? Infinity) ? occupancy : undefined;
}

/**
 * A completed `/compact` turn: its compaction activity finished and no
 * response followed. Compaction inside a normal turn is excluded — that turn's
 * own response carries the reading taken after it.
 */
export function isManualCompaction(
  events: SessionEvent[],
  event: SessionEvent,
) {
  const payload = eventPayload(event);
  const activityId = stringValue(payload, "activityId");
  return (
    payload?.kind === "provider-activity" &&
    payload.activityKind === "context" &&
    payload.status === "done" &&
    Boolean(activityId?.startsWith("context-compaction-")) &&
    !events.some(
      (item) =>
        item.turnId === event.turnId &&
        item.sessionId === event.sessionId &&
        eventPayload(item)?.kind === "provider-response",
    )
  );
}

/**
 * What a finished `/compact` may claim it did.
 *
 * A Codex session compacts itself, so its earlier conversation really is
 * summarized. Every other provider rewrites the transcript locally, where the
 * only honest outcomes are "condensed" (full turns replaced by a digest) and
 * "kept" (the history already fit). Events recorded before the marker existed
 * are read from the checkpoint payload: only the local path ever wrote one.
 */
export type ManualCompactionMode = "summarized" | "condensed" | "kept";

export function manualCompactionMode(
  events: SessionEvent[],
  event: SessionEvent,
): ManualCompactionMode | null {
  if (!isManualCompaction(events, event)) return null;
  const payload = eventPayload(event);
  const mode = stringValue(payload, "compactionMode");
  if (mode === "summarized" || mode === "condensed" || mode === "kept") {
    return mode;
  }
  return stringValue(payload, "contextSummary") ? "condensed" : "summarized";
}

/**
 * The sentence a finished `/compact` turn shows in the transcript.
 *
 * Each mode says only what happened: a model summary, a local digest, or a
 * history that already fit. An unmarked event is described without claiming
 * either, so a turn recorded by an older build cannot assert a summary.
 */
export function manualCompactionResultText(
  mode: ManualCompactionMode | null,
): string {
  switch (mode) {
    case "summarized":
      return "Context compacted. Earlier conversation was summarized so this chat has room to continue.";
    case "condensed":
      return "Context compacted. Earlier turns were condensed into a short digest \u2014 their full text is no longer sent, so this chat has room to continue.";
    case "kept":
      return "Context compacted. This chat already fit its window, so no earlier turn was dropped.";
    default:
      return "Context compacted.";
  }
}

export function estimateComposerContextUsage(
  events: SessionEvent[],
  draft: string,
  model: ContextModelSelection,
): ComposerContextUsage {
  let reportedEventIndex = -1;
  let reportedUsage: Record<string, unknown> | undefined;
  let reportedModelId: string | undefined;
  let reportedProviderId: string | undefined;
  // The window and the token counts come from different places. Every provider
  // reports the window Gyro resolved for its model, but only some report what
  // the turn spent, so a run that carries a window and no counts still has to
  // size the meter correctly while the estimate fills in the usage.
  let reportedContextWindow: number | undefined;
  let compactedSummaryCharacters = 0;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const payload = eventPayload(event);
    const usage = recordFromUnknown(payload?.contextUsage);
    // A manual compaction replaced the thread's history. Any reading taken
    // before it measures a conversation the provider no longer holds, so when
    // the compaction did not report its own, the estimate starts over here.
    if (!usage && !reportedUsage && isManualCompaction(events, event)) {
      reportedEventIndex = index;
      compactedSummaryCharacters =
        stringValue(payload, "contextSummary")?.length ?? 0;
      break;
    }
    if (!usage) continue;
    // A completed response replaces the live checkpoint only when it contains
    // a usable observation. Some runtimes publish occupancy in a stream frame
    // but omit it from the closing response.
    if (
      payload?.kind === "provider-context-usage" &&
      events.some(
        (item) =>
          item.turnId === event.turnId &&
          item.sessionId === event.sessionId &&
          eventPayload(item)?.kind === "provider-response" &&
          usableOccupancy(
            recordFromUnknown(eventPayload(item)?.contextUsage) ?? {},
            eventPayload(item),
            model,
          ) !== undefined,
      )
    )
      continue;

    const eventModelId = stringValue(payload, "modelId");
    const matchesModel =
      (!model.providerId ||
        stringValue(payload, "providerId") === model.providerId) &&
      (!model.modelId || eventModelId === model.modelId);
    // The window is only meaningful for the model that reported it.
    if (
      matchesModel &&
      reportedContextWindow === undefined &&
      payload?.contextWindowSource !== "catalog"
    ) {
      reportedContextWindow = tokenCount(usage, "modelContextWindow");
    }
    if (reportedUsage) continue;
    const occupancy = usableOccupancy(usage, payload, model);
    if (occupancy === undefined) continue;
    // A run that used tools bills the re-sent conversation once per request, so
    // some CLIs report a turn total several times the window. Nothing can
    // occupy more of the window than it holds, so a reading that large is
    // ignored and the thread estimate stands in — including for turns recorded
    // before Gyro stopped storing those totals.
    // How full the thread is belongs to the conversation, not to the model that
    // last read it: switching model or provider mid-chat does not empty it. The
    // newest reading therefore stands even when another model produced it,
    // rather than dropping the meter back to an estimate that counts only the
    // text Gyro stored and reads as near-empty.
    reportedEventIndex = index;
    reportedUsage = usage;
    reportedModelId = eventModelId;
    reportedProviderId = stringValue(payload, "providerId");
    if (matchesModel) break;
  }

  const reportedInputTokens = tokenCount(reportedUsage, "inputTokens");
  const reportedOutputTokens = tokenCount(reportedUsage, "outputTokens") ?? 0;
  const reportedTotalTokens = tokenCount(reportedUsage, "totalTokens");
  const occupancyEstimated = reportedUsage?.estimated === true;
  const contextWindowTokens =
    resolveContextWindow(reportedContextWindow, model) ?? 0;

  const checkpoint =
    reportedEventIndex >= 0 && reportedUsage
      ? recordFromUnknown(
          eventPayload(events[reportedEventIndex]!)?.contextCharacterBaseline,
        )
      : undefined;
  let estimatedCharacters = draft.length + compactedSummaryCharacters;
  for (
    let index = checkpoint
      ? 0
      : reportedEventIndex >= 0
        ? reportedEventIndex + 1
        : 0;
    index < events.length;
    index += 1
  ) {
    const event = events[index];
    if (event) {
      const previous = checkpoint ? (tokenCount(checkpoint, event.id) ?? 0) : 0;
      estimatedCharacters += Math.max(
        0,
        estimatedEventCharacters(event) - previous,
      );
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
  const isReported = reportedInputTokens !== undefined;
  const modelLabel = model.modelLabel ?? model.modelId ?? "Selected model";
  const isOtherModelReading = Boolean(
    isReported &&
    ((reportedModelId && model.modelId && reportedModelId !== model.modelId) ||
      (reportedProviderId &&
        model.providerId &&
        reportedProviderId !== model.providerId)),
  );
  const detail = occupancyEstimated
    ? liveEstimatedTokens > 0
      ? "Estimated from prompt and tool traffic seen so far, plus newer thread content and this draft. The provider has not reported window occupancy."
      : "Estimated from prompt and tool traffic seen so far. The provider has not reported window occupancy."
    : isReported
      ? isOtherModelReading
        ? `The last turn ran on ${reportedModelId ?? reportedProviderId}; its token count is an estimate for this model. Newer thread content and this draft are estimated too.`
        : liveEstimatedTokens > 0
          ? "Provider-reported usage plus an estimate for newer thread content and this draft."
          : "Latest context usage reported by the provider."
      : "Estimated from context-bearing thread content and this draft; provider usage is not available yet.";

  return finishComposerContextUsage({
    providerId: model.providerId,
    modelId: model.modelId,
    reportedContextWindowTokens: reportedContextWindow,
    contextWindowTokens,
    detail,
    modelLabel,
    source:
      isReported &&
      liveEstimatedTokens === 0 &&
      !isOtherModelReading &&
      !occupancyEstimated
        ? "reported"
        : "estimated",
    usedTokens,
  });
}

/**
 * Re-read the same occupancy against another model's window.
 *
 * The thread does not shrink when you browse the picker. Only the window
 * changes, so remaining tokens and the fill level have to follow the model
 * under the pointer — not stay locked to whichever model last answered.
 */
export function composerContextUsageForModel(
  usage: ComposerContextUsage,
  model: ContextModelSelection,
): ComposerContextUsage {
  const matchesModel = Boolean(
    model.modelId &&
    model.modelId === usage.modelId &&
    model.providerId === usage.providerId,
  );
  const contextWindowTokens =
    resolveContextWindow(
      matchesModel ? usage.reportedContextWindowTokens : undefined,
      model,
    ) ?? 0;
  const modelLabel = model.modelLabel ?? model.modelId ?? usage.modelLabel;
  if (
    model.providerId === usage.providerId &&
    model.modelId === usage.modelId &&
    contextWindowTokens === usage.contextWindowTokens &&
    modelLabel === usage.modelLabel
  ) {
    return usage;
  }
  return finishComposerContextUsage({
    providerId: model.providerId,
    modelId: model.modelId,
    reportedContextWindowTokens: matchesModel
      ? usage.reportedContextWindowTokens
      : undefined,
    contextWindowTokens,
    detail: `Thread occupancy shown against ${modelLabel}'s context window.`,
    modelLabel,
    source: matchesModel ? usage.source : "estimated",
    usedTokens: usage.usedTokens,
  });
}

function finishComposerContextUsage({
  providerId,
  modelId,
  reportedContextWindowTokens,
  contextWindowTokens,
  detail,
  modelLabel,
  source,
  usedTokens,
}: {
  providerId?: ProviderId;
  modelId?: string;
  reportedContextWindowTokens?: number;
  contextWindowTokens: number;
  detail: string;
  modelLabel: string;
  source: ComposerContextUsage["source"];
  usedTokens: number;
}): ComposerContextUsage {
  // Zero is an unknown window, never a token limit. Adapter defaults and
  // hand-entered endpoints have no published model-specific size to assume.
  if (contextWindowTokens <= 0) {
    return {
      providerId,
      modelId,
      reportedContextWindowTokens,
      contextWindowTokens: 0,
      detail: `${detail} The selected model's context window is not available.`,
      label: `${modelLabel} context: ${formatCompactTokenCount(usedTokens)} tokens used; context window unknown`,
      modelLabel,
      percent: 0,
      usedTokens,
      percentLabel: "—",
      remainingLabel: "Unknown",
      remainingPercent: undefined,
      remainingPercentLabel: "—",
      source,
      title: `${modelLabel} context`,
      usedLabel: formatCompactTokenCount(usedTokens),
      windowLabel: "Unknown",
    };
  }
  const remainingTokens = Math.max(0, contextWindowTokens - usedTokens);
  const remaining = remainingUsage((usedTokens / contextWindowTokens) * 100);
  const percent = Math.min(
    100,
    Math.max(0, Math.round((usedTokens / contextWindowTokens) * 100)),
  );
  const percentLabel = usedTokens > 0 && percent === 0 ? "<1%" : `${percent}%`;
  const usedLabel = formatCompactTokenCount(usedTokens);
  const remainingLabel = formatCompactTokenCount(remainingTokens);
  const windowLabel = formatCompactTokenCount(contextWindowTokens);
  return {
    providerId,
    modelId,
    reportedContextWindowTokens,
    contextWindowTokens,
    detail,
    label: `${modelLabel} context: ${usedLabel} of ${windowLabel} tokens used (${percentLabel} used)`,
    modelLabel,
    percent,
    usedTokens,
    percentLabel,
    remainingLabel,
    remainingPercent: remaining.percent,
    remainingPercentLabel: remaining.percentLabel,
    source,
    title: `${modelLabel} context`,
    usedLabel,
    windowLabel,
  };
}

const LIMIT_WINDOW_ORDER = ["five-hour", "weekly"];

/**
 * How far apart two reset times can be and still name the same window.
 *
 * The account API says `13:59:59.836` where the chat stream says `14:00:00`;
 * comparing whole seconds split them into two windows and lost the level.
 */
const SAME_RESET_TOLERANCE_MS = 60_000;

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

/**
 * Compact reset copy for a linked provider in the model picker.
 *
 * Providers can expose more than one allowance (for example a five-hour and
 * weekly window), so keep each real reset beside its window label. Windows
 * without a valid timestamp stay silent instead of implying a schedule the
 * provider did not report.
 */
export function providerResetSummary(
  windows: ProviderUsageWindow[],
  now = Date.now(),
) {
  return windows
    .flatMap((window) => {
      const resetMs = window.resetsAt
        ? Date.parse(window.resetsAt)
        : Number.NaN;
      const formatted = formatLimitReset(window.resetsAt, now);
      if (!Number.isFinite(resetMs) || !formatted) return [];
      const label = window.label.replace(/\s+(?:limit|window)$/i, "");
      const reset =
        formatted === "Resetting now"
          ? "resets now"
          : formatted.replace(/^Resets /, "resets ");
      return [{ resetMs, text: `${label} ${reset}` }];
    })
    .sort((left, right) => left.resetMs - right.resetMs)
    .map((item) => item.text)
    .join(" · ");
}

/**
 * The chat, plus the releases that have reset its thread.
 *
 * A reading only describes the thread it measured, so a compaction has to
 * invalidate every reading from before it. The newest completed compaction is
 * enough to identify that boundary: nothing else releases context inside one
 * session, and a new chat arrives with a different session id.
 */
export function contextOccupancyEpoch(events: SessionEvent[]): string {
  let release = "";
  for (const event of events) {
    const payload = eventPayload(event);
    if (payload?.kind !== "provider-activity") continue;
    if (payload.activityKind !== "context") continue;
    const activityId: unknown = payload.activityId;
    if (typeof activityId !== "string") continue;
    if (!activityId.startsWith("context-compaction-")) continue;
    release = activityId;
  }
  return `${events[0]?.sessionId ?? ""}#${release}`;
}

/** The highest occupancy one epoch of one chat has shown. */
export type ContextOccupancyPeak = { epoch: string; usedTokens: number };

/**
 * The composer meter shows the highest occupancy this chat has reached since
 * its last release, not the newest single reading.
 *
 * A reading measures one request. Resending, stopping, or retrying abandons
 * the attempt that was running, so the next reading describes a much smaller
 * prompt while the conversation itself is untouched — and a context bar that
 * falls reads as history going missing. Holding the peak answers the question
 * the meter is asked ("how close is this chat to the window?") and never
 * reports a drop that no release explains. A compaction or a new chat changes
 * the epoch, which starts the peak over.
 *
 * The rule compares reported numbers and never inspects a provider, so a
 * hosted API, a local model, and a CLI harness all behave the same way.
 */
export function holdContextOccupancyPeak(
  peak: ContextOccupancyPeak | undefined,
  usage: ComposerContextUsage,
  epoch: string,
): { peak: ContextOccupancyPeak; usage: ComposerContextUsage } {
  const held = peak?.epoch === epoch ? peak.usedTokens : 0;
  const highest = Math.max(held, usage.usedTokens);
  const nextPeak = { epoch, usedTokens: highest };
  // A peak that does not fit the selected window belongs to a model this chat
  // has moved away from. Pinning the bar at 100% there would claim a window is
  // full when the thread is not, so the live reading wins until a model large
  // enough to hold the peak is selected again.
  if (
    highest === usage.usedTokens ||
    (usage.contextWindowTokens > 0 && highest > usage.contextWindowTokens)
  ) {
    return { peak: nextPeak, usage };
  }
  return {
    peak: nextPeak,
    usage: finishComposerContextUsage({
      providerId: usage.providerId,
      modelId: usage.modelId,
      reportedContextWindowTokens: usage.reportedContextWindowTokens,
      contextWindowTokens: usage.contextWindowTokens,
      detail: `${usage.detail} This is the highest occupancy this chat has reached since its last compaction; the newest request is smaller because it no longer carries the attempt that was abandoned.`,
      modelLabel: usage.modelLabel,
      source: usage.source,
      usedTokens: highest,
    }),
  };
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
  const remaining = remainingUsage(window.usedPercent, status === "exhausted");
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
    remainingPercent: remaining.percent,
    remainingPercentLabel: remaining.percentLabel,
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
  }

  for (const window of polledWindows) {
    const previous = byId.get(window.id);
    const sameReset =
      window.resetsAt &&
      previous?.resetsAt &&
      Math.abs(Date.parse(window.resetsAt) - Date.parse(previous.resetsAt)) <
        SAME_RESET_TOLERANCE_MS;
    byId.set(window.id, {
      ...window,
      usedPercent:
        window.usedPercent ?? (sameReset ? previous?.usedPercent : undefined),
    });
  }

  // Cached readings and thread events must not survive their allowance reset.
  for (const [id, window] of byId) {
    if (window.resetsAt && Date.parse(window.resetsAt) <= now) byId.delete(id);
  }

  // Only show allowances actually reported for this account. Provider identity
  // alone does not establish which plan windows a user has.
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
