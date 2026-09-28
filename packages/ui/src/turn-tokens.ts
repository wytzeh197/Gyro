/**
 * Usage across every request in a turn, distinct from context-window occupancy.
 * Cached input is included in input; reasoning output is included in output.
 */
export type TurnTokens = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
  measured?: boolean;
};

export type TurnTokenReading = { label: string; title: string };

const countKeys = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Reject corrupt readings rather than turn missing/invalid counts into zero. */
export function turnTokensFromValue(value: unknown): TurnTokens | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (countKeys.some((key) => record[key] != null && !validCount(record[key])))
    return undefined;
  const count = (key: (typeof countKeys)[number]) =>
    validCount(record[key]) ? (record[key] as number) : undefined;
  const inputTokens = count("inputTokens");
  const outputTokens = count("outputTokens");
  const sum =
    inputTokens === undefined || outputTokens === undefined
      ? undefined
      : inputTokens + outputTokens;
  if (sum !== undefined && !Number.isSafeInteger(sum)) return undefined;
  const reported = count("totalTokens");
  const totalTokens =
    reported === undefined ? sum : Math.max(reported, sum ?? 0);
  if (totalTokens === undefined) return undefined;
  const cached = count("cachedInputTokens");
  const reasoning = count("reasoningOutputTokens");
  const inconsistent =
    reported !== undefined && sum !== undefined && reported < sum;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cached !== undefined && inputTokens !== undefined
      ? { cachedInputTokens: Math.min(cached, inputTokens) }
      : {}),
    ...(reasoning !== undefined && outputTokens !== undefined
      ? { reasoningOutputTokens: Math.min(reasoning, outputTokens) }
      : {}),
    ...(inconsistent
      ? { measured: false }
      : typeof record.measured === "boolean"
        ? { measured: record.measured }
        : {}),
  };
}

export function formatTokenCount(tokens: number): string {
  if (!validCount(tokens)) return "—";
  if (tokens < 10_000) return tokens.toLocaleString();
  if (tokens < 999_500) {
    return `${(tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Keep the estimate marker on both the running and completed readings. */
export function turnTokensLabel(tokens: TurnTokens): string {
  return `${tokens.measured === false ? "~" : ""}${formatTokenCount(tokens.totalTokens)} tokens`;
}

export function turnTokensDetail(tokens: TurnTokens): string {
  // A total-only backend reading has zero placeholders for the unknown split.
  const hasBreakdown =
    tokens.totalTokens === 0 ||
    (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0) > 0;
  const parts = hasBreakdown
    ? [
        tokens.inputTokens === undefined
          ? undefined
          : `${tokens.inputTokens.toLocaleString()} input`,
        tokens.outputTokens === undefined
          ? undefined
          : `${tokens.outputTokens.toLocaleString()} output`,
      ].filter(Boolean)
    : [];
  const detail = [
    `${tokens.totalTokens.toLocaleString()} tokens ${tokens.measured === false ? "estimated or partially observed" : "reported"} for this turn`,
    ...parts,
  ].join(" · ");
  const cache = tokens.cachedInputTokens
    ? ` Includes ${tokens.cachedInputTokens.toLocaleString()} cached input tokens; these are already part of input, not additional tokens.`
    : "";
  const reasoning = tokens.reasoningOutputTokens
    ? ` Output includes ${tokens.reasoningOutputTokens.toLocaleString()} reasoning tokens.`
    : "";
  return `${detail}.${cache}${reasoning} Tokens count usage across requests, not the current context size or a monetary charge.`;
}

/** One readable count beside the final answer's copy action. */
export function turnTokenReadingForResponse(
  turnTokens: TurnTokens | undefined,
  lastRequestTokens: TurnTokens | undefined,
  _prompt: string,
  _response: string,
): TurnTokenReading {
  if (turnTokens) {
    const cache = turnTokens.cachedInputTokens
      ? ` · ${formatTokenCount(turnTokens.cachedInputTokens)} cached`
      : "";
    return {
      label: `${turnTokensLabel(turnTokens)}${cache}`,
      title:
        turnTokensDetail(turnTokens) +
        (turnTokens.measured === false
          ? " The full count could not be verified; provider-owned context, images, or unobserved requests may be missing."
          : ""),
    };
  }
  if (lastRequestTokens) {
    const estimated = lastRequestTokens.measured === false;
    return {
      label: `${estimated ? "~" : "≥"}${formatTokenCount(lastRequestTokens.totalTokens)} tokens`,
      title: `${lastRequestTokens.totalTokens.toLocaleString()} tokens ${estimated ? "estimated" : "reported"} for the last request. The full turn total was not recorded.`,
    };
  }
  return {
    label: "Usage unavailable",
    title:
      "No reliable token usage was recorded for this turn. Visible text alone cannot account for context, tools, images, or reasoning.",
  };
}
