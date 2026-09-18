/**
 * What one turn cost, for the providers Gyro meters itself.
 *
 * The API-key presets and custom endpoints reach their model over Gyro's own
 * HTTPS, so nothing else is counting: there is no vendor plan window to read and
 * no dashboard behind them. The backend adds up every request the tool loop
 * made and reports the total — live while the turn runs, then persisted on the
 * response — and this reads it back.
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
  return { inputTokens, outputTokens, totalTokens };
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
  const total = `${tokens.totalTokens.toLocaleString()} tokens billed this turn`;
  return parts.length > 0 ? `${total} · ${parts.join(", ")}` : total;
}
