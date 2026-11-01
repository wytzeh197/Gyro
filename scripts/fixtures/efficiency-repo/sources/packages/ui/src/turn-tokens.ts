import {
  formatDetailedTokenCount as formatTokenCount,
  isTokenCount as validCount,
} from "./token-count.ts";
import type { SessionEvent } from "./types";
export { formatTokenCount };

/** Provider observations for a turn. Input/output are inclusive of cache/reasoning. */
export type UsageAccounting = {
  source: "provider" | "character-estimate" | "mixed" | "legacy";
  scope: "request" | "turn" | "session" | "context" | "task";
  coverage: "complete" | "partial" | "estimated" | "unavailable";
  known: {
    input: boolean;
    output: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
    reasoning: boolean;
  };
  reason?: string;
};

export type TurnTokens = {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
  measured?: boolean;
  accounting?: UsageAccounting;
};

// `available` is false when the label only says usage is unknown; chat hides
// those rather than printing a placeholder under every answer.
export type TurnTokenReading = {
  label: string;
  title: string;
  available: boolean;
};
const countKeys = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;
const sources = ["provider", "character-estimate", "mixed", "legacy"];
const scopes = ["request", "turn", "session", "context", "task"];
const coverages = ["complete", "partial", "estimated", "unavailable"];

function readAccounting(value: unknown): UsageAccounting | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const a = value as Record<string, unknown>;
  const known = a.known as Record<string, unknown> | undefined;
  if (
    !sources.includes(String(a.source)) ||
    !scopes.includes(String(a.scope)) ||
    !coverages.includes(String(a.coverage)) ||
    !known ||
    ["input", "output", "cacheRead", "cacheWrite", "reasoning"].some(
      (k) => typeof known[k] !== "boolean",
    ) ||
    (a.reason !== undefined && typeof a.reason !== "string")
  )
    return undefined;
  return {
    source: a.source,
    scope: a.scope,
    coverage: a.coverage,
    known: { ...known },
    ...(typeof a.reason === "string" ? { reason: a.reason } : {}),
  } as UsageAccounting;
}

/** Invalid metadata never falls back to a confident legacy reading. */
export function turnTokensFromValue(value: unknown): TurnTokens | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (countKeys.some((key) => record[key] != null && !validCount(record[key])))
    return undefined;
  const count = (key: (typeof countKeys)[number]) =>
    validCount(record[key]) ? (record[key] as number) : undefined;
  const accounting =
    record.accounting == null ? undefined : readAccounting(record.accounting);
  if (record.accounting != null && !accounting) return undefined;
  const inputTokens = count("inputTokens");
  const outputTokens = count("outputTokens");
  const sum =
    inputTokens === undefined || outputTokens === undefined
      ? undefined
      : inputTokens + outputTokens;
  if (sum !== undefined && !Number.isSafeInteger(sum)) return undefined;
  const knownPair =
    !accounting || (accounting.known.input && accounting.known.output);
  const hasKnownCount =
    accounting &&
    ((accounting.known.input && inputTokens !== undefined) ||
      (accounting.known.output && outputTokens !== undefined));
  const knownSubtotal = accounting
    ? (accounting.known.input ? (inputTokens ?? 0) : 0) +
      (accounting.known.output ? (outputTokens ?? 0) : 0)
    : sum;
  const reported = count("totalTokens");
  const totalTokens =
    reported === undefined
      ? knownPair
        ? sum
        : hasKnownCount
          ? knownSubtotal
          : undefined
      : Math.max(reported, knownSubtotal ?? 0);
  if (totalTokens === undefined) return undefined;
  const cached = count("cachedInputTokens");
  const written = count("cacheWriteTokens");
  const reasoning = count("reasoningOutputTokens");
  const invalidCacheRead =
    cached !== undefined && inputTokens !== undefined && cached > inputTokens;
  const invalidCacheWrite =
    written !== undefined &&
    inputTokens !== undefined &&
    (written > inputTokens || written > inputTokens - (cached ?? 0));
  const invalidReasoning =
    reasoning !== undefined &&
    outputTokens !== undefined &&
    reasoning > outputTokens;
  // Known inclusive input and output must reconcile exactly with a reported total.
  // Numeric zero placeholders for unknown breakdowns are not contradictory.
  const missingKnownCount =
    accounting &&
    ((accounting.known.input && inputTokens === undefined) ||
      (accounting.known.output && outputTokens === undefined) ||
      (accounting.known.cacheRead && cached === undefined) ||
      (accounting.known.cacheWrite && written === undefined) ||
      (accounting.known.reasoning && reasoning === undefined));
  const inconsistent =
    (reported !== undefined &&
      knownSubtotal !== undefined &&
      (reported < knownSubtotal ||
        (knownPair && sum !== undefined && reported !== sum))) ||
    missingKnownCount ||
    invalidCacheRead ||
    invalidCacheWrite ||
    invalidReasoning;
  if (accounting && inconsistent) {
    if (accounting.coverage !== "unavailable")
      accounting.coverage = "estimated";
    accounting.reason = "inconsistent-counts";
    if (invalidCacheRead) accounting.known.cacheRead = false;
    if (invalidCacheWrite) accounting.known.cacheWrite = false;
    if (invalidReasoning) accounting.known.reasoning = false;
  } else if (
    accounting &&
    record.measured === false &&
    accounting.coverage === "complete"
  ) {
    accounting.coverage = "partial";
    accounting.reason = "provider-incomplete";
  } else if (
    accounting &&
    reported === undefined &&
    !knownPair &&
    accounting.coverage === "complete"
  ) {
    accounting.coverage = "partial";
    accounting.reason = "missing-usage";
  }
  // Coverage describes how many requests were observed; it cannot turn text
  // estimates or mixed observations into provider-measured token counts.
  if (
    accounting &&
    accounting.source !== "provider" &&
    accounting.coverage !== "unavailable"
  ) {
    accounting.coverage = "estimated";
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cached !== undefined && inputTokens !== undefined
      ? { cachedInputTokens: Math.min(cached, inputTokens) }
      : {}),
    ...(written !== undefined && inputTokens !== undefined
      ? { cacheWriteTokens: Math.min(written, inputTokens) }
      : {}),
    ...(reasoning !== undefined && outputTokens !== undefined
      ? { reasoningOutputTokens: Math.min(reasoning, outputTokens) }
      : {}),
    ...(inconsistent
      ? { measured: false }
      : typeof record.measured === "boolean"
        ? { measured: record.measured }
        : {}),
    ...(accounting ? { accounting } : {}),
  };
}

/** Final receipts fence stale streams; active turns keep their latest reading. */
export function turnTokensFromEvents(
  events: SessionEvent[],
): Map<string, TurnTokens> {
  const completedResponses = new Set<string>();
  const lifecycle = new Map<string, { status: unknown; at: number }>();
  for (const event of events) {
    if (
      !event.turnId ||
      !event.payload ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    )
      continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload.kind === "provider-response" && payload.streaming !== true)
      completedResponses.add(event.turnId);
    if (
      payload.kind !== "provider-run" &&
      payload.kind !== "provider-diagnostics"
    )
      continue;
    const at = Date.parse(
      String(payload.completedAt ?? payload.startedAt ?? event.createdAt),
    );
    const previous = lifecycle.get(event.turnId);
    if (
      !previous ||
      !Number.isFinite(at) ||
      !Number.isFinite(previous.at) ||
      at >= previous.at
    ) {
      lifecycle.set(event.turnId, { status: payload.status, at });
    }
  }
  const readings = new Map<
    string,
    { tokens: TurnTokens; transient: boolean; at: number }
  >();
  for (const event of events) {
    if (
      !event.turnId ||
      !event.payload ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    )
      continue;
    const payload = event.payload as Record<string, unknown>;
    const tokens = turnTokensFromValue(payload.turnTokens);
    if (!tokens) continue;
    const transient =
      payload.streaming === true ||
      (payload.kind === "provider-turn-tokens" &&
        event.id === `${event.sessionId}-turn-tokens-${event.turnId}`);
    const previous = readings.get(event.turnId);
    const at = Date.parse(event.createdAt);
    const finalized =
      completedResponses.has(event.turnId) ||
      ["blocked", "done", "failed", "cancelled"].includes(
        String(lifecycle.get(event.turnId)?.status),
      );
    if (
      previous &&
      ((finalized && transient && !previous.transient) ||
        ((!finalized || transient === previous.transient) &&
          Number.isFinite(at) &&
          Number.isFinite(previous.at) &&
          at < previous.at))
    )
      continue;
    readings.set(event.turnId, { tokens, transient, at });
  }
  return new Map(
    Array.from(readings, ([turnId, reading]) => [turnId, reading.tokens]),
  );
}

function coverage(tokens: TurnTokens): UsageAccounting["coverage"] {
  if (tokens.accounting)
    return tokens.accounting.source !== "provider" &&
      tokens.accounting.coverage !== "unavailable"
      ? "estimated"
      : tokens.accounting.coverage;
  return tokens.measured === false ? "estimated" : "unavailable";
}

function unavailable(tokens: TurnTokens): boolean {
  return (
    coverage(tokens) === "unavailable" ||
    coverage(tokens) === "estimated" ||
    tokens.accounting?.source !== "provider" ||
    tokens.accounting?.scope === "context" ||
    tokens.accounting?.scope === "session"
  );
}

export function turnTokensLabel(tokens: TurnTokens): string {
  if (unavailable(tokens)) return "Usage unavailable";
  const state = coverage(tokens);
  const prefix =
    state === "partial" || tokens.accounting?.scope === "request" ? "≥" : "";
  return `${prefix}${formatTokenCount(tokens.totalTokens)} tokens`;
}

const reasons: Record<string, string> = {
  "missing-baseline": "the resumed session has no verified starting count",
  "missing-usage": "some usage was not reported",
  "unsupported-runtime": "this runtime does not expose turn usage",
  "inconsistent-counts": "the provider counts are inconsistent",
  interrupted: "generation ended before its accounting was complete",
  "provider-incomplete": "the provider marked this reading incomplete",
  "unverified-runtime":
    "the runtime's accounting contract has not been verified",
  "unknown-scope": "the accounting scope is unknown",
};

export function turnTokensDetail(tokens: TurnTokens): string {
  if (unavailable(tokens)) {
    const accounting = tokens.accounting;
    const reason =
      accounting?.source === "character-estimate"
        ? "this reading was estimated from visible text, without a provider-reported total"
        : accounting?.source === "mixed"
          ? "this total combines provider counts with estimated or unverified counts"
          : !accounting || accounting.source === "legacy"
            ? "this saved reading has no verified provider accounting"
            : accounting.scope === "context" || accounting.scope === "session"
              ? "context occupancy and session totals do not measure this turn"
              : accounting.coverage === "estimated"
                ? accounting.reason === "inconsistent-counts"
                  ? "the provider counts are inconsistent, so a reliable total cannot be established"
                  : "this total includes estimated or unverified counts"
                : (reasons[accounting.reason ?? ""] ??
                  "no reliable provider total was recorded");
    return `Usage unavailable: ${reason}. Only provider-reported totals or observed partial counts are shown in chat.`;
  }
  const state = coverage(tokens);
  const known = tokens.accounting?.known;
  const parts: string[] = [];
  if (
    tokens.inputTokens !== undefined &&
    (known ? known.input : tokens.inputTokens > 0)
  )
    parts.push(`${tokens.inputTokens.toLocaleString()} input`);
  if (
    tokens.outputTokens !== undefined &&
    (known ? known.output : tokens.outputTokens > 0)
  )
    parts.push(`${tokens.outputTokens.toLocaleString()} output`);
  const scope =
    tokens.accounting?.scope === "request"
      ? "last request"
      : tokens.accounting?.scope === "task"
        ? "task"
        : "turn";
  const status =
    state === "complete" ? "reported" : "reported with incomplete coverage";
  let detail =
    [
      `${tokens.totalTokens.toLocaleString()} tokens ${status} for this ${scope}`,
      ...parts,
    ].join(" · ") + ".";
  if (tokens.cachedInputTokens && (known ? known.cacheRead : true))
    detail += ` Includes ${tokens.cachedInputTokens.toLocaleString()} cached input tokens, already part of input, not additional tokens.`;
  if (tokens.cacheWriteTokens && known?.cacheWrite)
    detail += ` Includes ${tokens.cacheWriteTokens.toLocaleString()} cache-write tokens, already part of input.`;
  if (tokens.reasoningOutputTokens && (known ? known.reasoning : true))
    detail += ` Output includes ${tokens.reasoningOutputTokens.toLocaleString()} reasoning tokens.`;
  if (state !== "complete")
    detail += ` ${reasons[tokens.accounting?.reason ?? "unverified-runtime"] ?? "The full count could not be verified"}.`;
  if (tokens.accounting)
    detail += ` Source: ${tokens.accounting.source}; scope: ${tokens.accounting.scope}.`;
  return (
    detail +
    " Usage across requests is separate from current context size and monetary cost."
  );
}

export function turnTokenReadingForResponse(
  turnTokens: TurnTokens | undefined,
  lastRequestTokens: TurnTokens | undefined,
  _prompt: string,
  _response: string,
): TurnTokenReading {
  if (turnTokens && !unavailable(turnTokens)) {
    const cache =
      !unavailable(turnTokens) &&
      turnTokens.cachedInputTokens &&
      turnTokens.accounting?.known.cacheRead
        ? ` · includes ${formatTokenCount(turnTokens.cachedInputTokens)} cached`
        : "";
    return {
      label: turnTokensLabel(turnTokens) + cache,
      title: turnTokensDetail(turnTokens),
      available: true,
    };
  }
  // Only a typed request observation can establish a lower bound. Old context
  // objects carry no provenance and may be turn/session totals.
  if (lastRequestTokens?.accounting?.scope === "request") {
    return {
      label: turnTokensLabel(lastRequestTokens),
      title: turnTokensDetail(lastRequestTokens),
      available: !unavailable(lastRequestTokens),
    };
  }
  if (turnTokens)
    return {
      label: turnTokensLabel(turnTokens),
      title: turnTokensDetail(turnTokens),
      available: false,
    };
  return {
    available: false,
    label: "Usage unavailable",
    title:
      "No reliable token usage was recorded for this turn. Visible text alone cannot account for context, tools, images, or reasoning.",
  };
}
