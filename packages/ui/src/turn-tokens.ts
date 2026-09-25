/**
 * What one turn cost. Reported counts and estimates use the same shape, with
 * `measured` keeping the difference visible to the reader.
 *
 * Deliberately separate from `context-usage.ts`. That module answers "how full
 * is the window", which is the last request's input; this one answers "what did
 * this message cost", which is every request added together. A turn that ran ten
 * tools bills far more than it ever held in context.
 */
export type TurnTokens = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number;
  measured?: boolean;
};

export type TurnTokenReading = {
  label: string;
  title: string;
};

function countFrom(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Read a reported total off an event payload.
 *
 * Both the live checkpoint and the finished response carry the field under the
 * same name, so the caller does not have to know which one it is holding.
 */
export function turnTokensFromValue(value: unknown): TurnTokens | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const inputTokens = countFrom(record, "inputTokens");
  const outputTokens = countFrom(record, "outputTokens");
  // A reported total is authoritative; falling back to the sum keeps a provider
  // that reports only the two halves from rendering nothing.
  const totalTokens =
    countFrom(record, "totalTokens") ??
    (inputTokens === undefined || outputTokens === undefined
      ? undefined
      : inputTokens + outputTokens);
  if (totalTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(typeof record.measured === "boolean"
      ? { measured: record.measured }
      : {}),
  };
}

/**
 * Token counts read as a quantity, not an identifier, so they are grouped in
 * thousands rather than printed raw. Past ten thousand the exact figure stops
 * carrying information a reader can use, so it rounds to `12.4k` — but below
 * that every digit still reads as a real number and is kept.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 10_000) {
    return tokens.toLocaleString();
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** `1,204 tokens`, for the line under a finished message. */
export function turnTokensLabel(tokens: TurnTokens): string {
  return `${formatTokenCount(tokens.totalTokens)} tokens`;
}

/** The breakdown behind the label, for a title attribute. */
export function turnTokensDetail(tokens: TurnTokens): string {
  const parts = [
    tokens.inputTokens === undefined
      ? undefined
      : `${tokens.inputTokens.toLocaleString()} in`,
    tokens.outputTokens === undefined
      ? undefined
      : `${tokens.outputTokens.toLocaleString()} out`,
  ].filter(Boolean);
  const total = `${tokens.totalTokens.toLocaleString()} tokens ${tokens.measured === false ? "estimated for" : "billed this"} turn`;
  return parts.length > 0 ? `${total} · ${parts.join(", ")}` : total;
}

/** One readable count beside the final answer's copy action. */
export function turnTokenReadingForResponse(
  turnTokens: TurnTokens | undefined,
  lastRequestTokens: TurnTokens | undefined,
  prompt: string,
  response: string,
): TurnTokenReading {
  if (turnTokens) {
    return {
      label: `${turnTokens.measured === false ? "~" : ""}${turnTokensLabel(turnTokens)}`,
      title:
        turnTokens.measured === false
          ? `${turnTokensDetail(turnTokens)}. The provider supplied no count, so Gyro estimated this from the prompt and response.`
          : turnTokensDetail(turnTokens),
    };
  }
  if (lastRequestTokens) {
    return {
      label: `≥${turnTokensLabel(lastRequestTokens)}`,
      title: `${lastRequestTokens.totalTokens.toLocaleString()} tokens reported for the last request. The full turn total was not recorded.`,
    };
  }
  const estimated = {
    totalTokens: Math.ceil(prompt.length / 4) + Math.ceil(response.length / 4),
  };
  return {
    label: `~${turnTokensLabel(estimated)}`,
    title:
      "Estimated from the visible prompt and answer. Earlier context and tool calls are not included.",
  };
}
