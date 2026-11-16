// Descriptive task diagnostics, not an additional qualification gate.
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const verified = (row) => row.outcome === "done" && row.verified === true;

export function pairedQuality(pairs, complete) {
  const outcomes = {
    bothVerified: 0,
    improved: 0,
    regressed: 0,
    neitherVerified: 0,
    unknown: 0,
  };
  for (const [baseline, candidate] of pairs) {
    if (
      typeof baseline.verified !== "boolean" ||
      typeof candidate.verified !== "boolean"
    ) {
      outcomes.unknown++;
      continue;
    }
    if (verified(baseline)) {
      outcomes[verified(candidate) ? "bothVerified" : "regressed"]++;
    } else {
      outcomes[verified(candidate) ? "improved" : "neitherVerified"]++;
    }
  }
  return {
    ...outcomes,
    coverage: complete ? "complete" : "incomplete",
    // Do not imply an improvement from an incomplete or duplicate cohort.
    successRateChange:
      complete && pairs.length && outcomes.unknown === 0
        ? (outcomes.improved - outcomes.regressed) / pairs.length
        : null,
    interpretation:
      "Observed paired outcomes; not statistical evidence of production quality.",
  };
}

function known(tokens, field, flag) {
  const a = tokens?.accounting;
  return (
    tokens?.measured === true &&
    a?.source === "provider" &&
    a?.coverage === "complete" &&
    ["turn", "task"].includes(a?.scope) &&
    a?.known?.[flag] === true &&
    count(tokens?.[field])
  );
}

function tokenValue(tokens, field, flag) {
  if (!known(tokens, field, flag)) return null;
  if (["cachedInputTokens", "cacheWriteTokens"].includes(field)) {
    if (
      !known(tokens, "inputTokens", "input") ||
      tokens[field] > tokens.inputTokens
    )
      return null;
    if (
      known(tokens, "cachedInputTokens", "cacheRead") &&
      known(tokens, "cacheWriteTokens", "cacheWrite") &&
      tokens.cachedInputTokens > tokens.inputTokens - tokens.cacheWriteTokens
    )
      return null;
  }
  if (
    field === "reasoningOutputTokens" &&
    (!known(tokens, "outputTokens", "output") ||
      tokens[field] > tokens.outputTokens)
  )
    return null;
  return tokens[field];
}

function total(rows, read) {
  const values = rows
    .map((row) => read(row.tokens))
    .filter((value) => value !== null);
  const subtotal = values.reduce((sum, value) => sum + value, 0);
  const safe = Number.isSafeInteger(subtotal);
  return {
    total:
      rows.length > 0 && values.length === rows.length && safe
        ? subtotal
        : null,
    observedSubtotal: safe ? subtotal : null,
    knownRuns: values.length,
    runs: rows.length,
  };
}

export function tokenBreakdown(rows) {
  const fields = {
    inputTokens: "input",
    outputTokens: "output",
    cachedInputTokens: "cacheRead",
    cacheWriteTokens: "cacheWrite",
    reasoningOutputTokens: "reasoning",
  };
  const result = Object.fromEntries(
    Object.entries(fields).map(([field, flag]) => [
      field,
      total(rows, (tokens) => tokenValue(tokens, field, flag)),
    ]),
  );
  result.uncachedInputTokens = total(rows, (tokens) => {
    const input = tokenValue(tokens, "inputTokens", "input");
    const read = tokenValue(tokens, "cachedInputTokens", "cacheRead");
    const write = tokenValue(tokens, "cacheWriteTokens", "cacheWrite");
    return input !== null && read !== null && write !== null
      ? input - read - write
      : null;
  });
  return result;
}

export function failureBreakdown(rows) {
  // Use fixed classes; raw provider errors can contain private data and paths.
  const counts = {
    executionFailed: 0,
    verificationFailed: 0,
    verificationUnknown: 0,
    budgetStopped: 0,
    unavailable: 0,
  };
  for (const row of rows) {
    if (verified(row)) continue;
    if (row.outcome === "failed") counts.executionFailed++;
    else if (row.outcome === "done") {
      counts[
        row.verified === false ? "verificationFailed" : "verificationUnknown"
      ]++;
    } else if (row.outcome?.includes("budget-stop")) counts.budgetStopped++;
    else counts.unavailable++;
  }
  return counts;
}
