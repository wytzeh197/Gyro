/** Provider observations for a turn. Input/output are inclusive of cache/reasoning. */
export type UsageAccounting = {
  source: "provider" | "character-estimate" | "mixed" | "legacy";
  scope: "request" | "turn" | "session" | "context" | "task";
  coverage: "complete" | "partial" | "estimated" | "unavailable";
  known: { input: boolean; output: boolean; cacheRead: boolean; cacheWrite: boolean; reasoning: boolean };
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

export type TurnTokenReading = { label: string; title: string };
const countKeys = ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;
const sources = ["provider", "character-estimate", "mixed", "legacy"];
const scopes = ["request", "turn", "session", "context", "task"];
const coverages = ["complete", "partial", "estimated", "unavailable"];

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readAccounting(value: unknown): UsageAccounting | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const a = value as Record<string, unknown>;
  const known = a.known as Record<string, unknown> | undefined;
  if (!sources.includes(String(a.source)) || !scopes.includes(String(a.scope)) ||
      !coverages.includes(String(a.coverage)) || !known ||
      ["input", "output", "cacheRead", "cacheWrite", "reasoning"].some(k => typeof known[k] !== "boolean") ||
      (a.reason !== undefined && typeof a.reason !== "string")) return undefined;
  return { source: a.source, scope: a.scope, coverage: a.coverage, known: { ...known },
    ...(typeof a.reason === "string" ? { reason: a.reason } : {}) } as UsageAccounting;
}

/** Invalid metadata never falls back to a confident legacy reading. */
export function turnTokensFromValue(value: unknown): TurnTokens | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (countKeys.some(key => record[key] != null && !validCount(record[key]))) return undefined;
  const count = (key: (typeof countKeys)[number]) => validCount(record[key]) ? record[key] as number : undefined;
  const accounting = record.accounting == null ? undefined : readAccounting(record.accounting);
  if (record.accounting != null && !accounting) return undefined;
  const inputTokens = count("inputTokens");
  const outputTokens = count("outputTokens");
  const sum = inputTokens === undefined || outputTokens === undefined ? undefined : inputTokens + outputTokens;
  if (sum !== undefined && !Number.isSafeInteger(sum)) return undefined;
  const reported = count("totalTokens");
  const totalTokens = reported === undefined ? sum : Math.max(reported, sum ?? 0);
  if (totalTokens === undefined) return undefined;
  const inconsistent = reported !== undefined && sum !== undefined && reported < sum;
  if (accounting && inconsistent) {
    accounting.coverage = "estimated";
    accounting.reason = "inconsistent-counts";
  } else if (accounting && record.measured === false && accounting.coverage === "complete") {
    accounting.coverage = "partial";
    accounting.reason = "provider-incomplete";
  }
  const cached = count("cachedInputTokens");
  const written = count("cacheWriteTokens");
  const reasoning = count("reasoningOutputTokens");
  return {
    inputTokens, outputTokens, totalTokens,
    ...(cached !== undefined && inputTokens !== undefined ? { cachedInputTokens: Math.min(cached, inputTokens) } : {}),
    ...(written !== undefined && inputTokens !== undefined ? { cacheWriteTokens: Math.min(written, inputTokens) } : {}),
    ...(reasoning !== undefined && outputTokens !== undefined ? { reasoningOutputTokens: Math.min(reasoning, outputTokens) } : {}),
    ...(inconsistent ? { measured: false } : typeof record.measured === "boolean" ? { measured: record.measured } : {}),
    ...(accounting ? { accounting } : {}),
  };
}

function coverage(tokens: TurnTokens): UsageAccounting["coverage"] {
  if (tokens.accounting) return tokens.accounting.coverage;
  return tokens.measured === false ? "estimated" : "unavailable";
}

function unavailable(tokens: TurnTokens): boolean {
  return coverage(tokens) === "unavailable" ||
    tokens.accounting?.scope === "context" || tokens.accounting?.scope === "session";
}

export function formatTokenCount(tokens: number): string {
  if (!validCount(tokens)) return "—";
  if (tokens < 10_000) return tokens.toLocaleString();
  if (tokens < 999_500) return `${(tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function turnTokensLabel(tokens: TurnTokens): string {
  if (unavailable(tokens)) return "Usage unavailable";
  const state = coverage(tokens);
  const prefix = state === "estimated" ? "~" :
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
  "unverified-runtime": "the runtime's accounting contract has not been verified",
  "unknown-scope": "the accounting scope is unknown",
};

export function turnTokensDetail(tokens: TurnTokens): string {
  if (unavailable(tokens)) return `Usage unavailable: ${reasons[tokens.accounting?.reason ?? ""] ?? "no complete turn observation exists"}. Context occupancy and session totals do not measure this turn.`;
  const state = coverage(tokens);
  const known = tokens.accounting?.known;
  const parts: string[] = [];
  if (tokens.inputTokens !== undefined && (known ? known.input : tokens.inputTokens > 0))
    parts.push(`${tokens.inputTokens.toLocaleString()} input`);
  if (tokens.outputTokens !== undefined && (known ? known.output : tokens.outputTokens > 0))
    parts.push(`${tokens.outputTokens.toLocaleString()} output`);
  const scope = tokens.accounting?.scope === "request" ? "last request" : "turn";
  const status = state === "complete" ? "reported" : state === "partial" ? "reported with incomplete coverage" : tokens.accounting?.reason === "inconsistent-counts" ? "uncertain" : tokens.accounting?.source === "character-estimate" ? "estimated from observed text" : "estimated or partially estimated";
  let detail = [`${tokens.totalTokens.toLocaleString()} tokens ${status} for this ${scope}`, ...parts].join(" · ") + ".";
  if (tokens.cachedInputTokens && (known ? known.cacheRead : true))
    detail += ` Includes ${tokens.cachedInputTokens.toLocaleString()} cached input tokens, already part of input, not additional tokens.`;
  if (tokens.cacheWriteTokens && known?.cacheWrite)
    detail += ` Includes ${tokens.cacheWriteTokens.toLocaleString()} cache-write tokens, already part of input.`;
  if (tokens.reasoningOutputTokens && (known ? known.reasoning : true))
    detail += ` Output includes ${tokens.reasoningOutputTokens.toLocaleString()} reasoning tokens.`;
  if (state !== "complete") detail += ` ${reasons[tokens.accounting?.reason ?? "unverified-runtime"] ?? "The full count could not be verified"}.`;
  if (state === "estimated") detail += " This estimate can omit provider-owned context, images, reasoning, and unobserved requests.";
  if (tokens.accounting) detail += ` Source: ${tokens.accounting.source}; scope: ${tokens.accounting.scope}.`;
  return detail + " Usage across requests is separate from current context size and monetary cost.";
}

export function turnTokenReadingForResponse(
  turnTokens: TurnTokens | undefined,
  lastRequestTokens: TurnTokens | undefined,
  _prompt: string,
  _response: string,
): TurnTokenReading {
  if (turnTokens) {
    const cache = !unavailable(turnTokens) && turnTokens.cachedInputTokens && turnTokens.accounting?.known.cacheRead
      ? ` · ${formatTokenCount(turnTokens.cachedInputTokens)} cached` : "";
    return { label: turnTokensLabel(turnTokens) + cache, title: turnTokensDetail(turnTokens) };
  }
  // Only a typed request observation can establish a lower bound. Old context
  // objects carry no provenance and may be turn/session totals.
  if (lastRequestTokens?.accounting?.scope === "request") {
    return { label: turnTokensLabel(lastRequestTokens), title: turnTokensDetail(lastRequestTokens) };
  }
  return {
    label: "Usage unavailable",
    title: "No reliable token usage was recorded for this turn. Visible text alone cannot account for context, tools, images, or reasoning.",
  };
}
