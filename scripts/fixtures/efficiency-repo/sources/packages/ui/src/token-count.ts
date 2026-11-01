/** Token counts are nonnegative integers that JavaScript can represent exactly. */
export function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Shared compact units for context, turns, agents, and usage totals. */
export function formatCompactTokenCount(tokens: number): string {
  if (!isTokenCount(tokens)) return "—";
  const trim = (value: string) => value.replace(/\.?0+$/, "");
  if (tokens >= 999_500) return `${trim((tokens / 1_000_000).toFixed(2))}M`;
  if (tokens >= 1_000) {
    const value = (tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0);
    return `${value.includes(".") ? trim(value) : value}K`;
  }
  return String(tokens);
}

/** Keep small turn readings exact while sharing larger units with the meters. */
export function formatDetailedTokenCount(tokens: number): string {
  if (!isTokenCount(tokens)) return "—";
  return tokens < 10_000 ? tokens.toLocaleString() : formatCompactTokenCount(tokens);
}
