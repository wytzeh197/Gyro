import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const p95 = (values) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
    : null;
const key = (r) =>
  JSON.stringify([
    r.task,
    r.provider,
    r.model,
    r.effort,
    r.trial,
    r.sessionCondition,
  ]);
export function report(records, expectedPairs = 120) {
  const variants = [...new Set(records.map((r) => r.variant))];
  const baseline = new Map(
    records.filter((r) => r.variant === "baseline").map((r) => [key(r), r]),
  );
  const groups = [];
  for (const provider of [...new Set(records.map((r) => r.provider))])
    for (const model of [
      ...new Set(
        records.filter((r) => r.provider === provider).map((r) => r.model),
      ),
    ])
      for (const variant of variants) {
        const selected = records.filter(
          (r) =>
            r.provider === provider &&
            r.model === model &&
            r.variant === variant,
        );
        if (!selected.length) continue;
        const evaluated = selected.filter((r) =>
          ["done", "failed"].includes(r.outcome),
        );
        const successes = evaluated.filter((r) => r.verified === true).length;
        const pairs = evaluated
          .map((r) => [baseline.get(key(r)), r])
          .filter(([a]) => a && ["done", "failed"].includes(a.outcome));
        const regressions = pairs
          .filter(([a, b]) => a.verified && !b.verified)
          .map(([, b]) => ({
            task: b.task,
            trial: b.trial,
            sessionCondition: b.sessionCondition,
          }));
        const completePairs = pairs.filter(
          ([a, b]) =>
            a.tokens?.measured &&
            b.tokens?.measured &&
            a.estimatedCost &&
            b.estimatedCost &&
            a.estimatedCost.currency === b.estimatedCost.currency,
        );
        const currencies = [
          ...new Set(completePairs.map(([, b]) => b.estimatedCost.currency)),
        ];
        const costSum = (xs, i) =>
          xs.reduce((n, p) => n + p[i].estimatedCost.micros, 0);
        const baselineSuccess = completePairs.filter(
          ([a]) => a.verified,
        ).length;
        const variantSuccess = completePairs.filter(
          ([, b]) => b.verified,
        ).length;
        const basePerTask =
          baselineSuccess &&
          currencies.length === 1 &&
          completePairs.length === pairs.length
            ? costSum(completePairs, 0) / baselineSuccess
            : null;
        const perTask =
          variantSuccess &&
          currencies.length === 1 &&
          completePairs.length === pairs.length
            ? costSum(completePairs, 1) / variantSuccess
            : null;
        const reduction =
          basePerTask > 0 && perTask !== null
            ? 1 - perTask / basePerTask
            : null;
        const baselineP95 = p95(
          pairs.map(([a]) => a.elapsedMs).filter(Number.isFinite),
        );
        const variantP95 = p95(
          pairs.map(([, b]) => b.elapsedMs).filter(Number.isFinite),
        );
        const slowdown =
          baselineP95 > 0 && variantP95 !== null
            ? variantP95 / baselineP95 - 1
            : null;
        const baselineRows = records.filter(
          (r) =>
            r.provider === provider &&
            r.model === model &&
            r.variant === "baseline",
        );
        const complete =
          pairs.length === expectedPairs &&
          new Set(pairs.map(([, b]) => key(b))).size === pairs.length &&
          selected.length === evaluated.length &&
          new Set(baselineRows.map(key)).size === baselineRows.length;
        const tokenPairs = pairs.filter(
          ([a, b]) =>
            a.tokens?.measured &&
            b.tokens?.measured &&
            Number.isFinite(a.tokens.totalTokens) &&
            Number.isFinite(b.tokens.totalTokens),
        );
        const baseSuccess = tokenPairs.filter(([a]) => a.verified).length;
        const optimizedSuccess = tokenPairs.filter(
          ([, b]) => b.verified,
        ).length;
        const baseTokens = baseSuccess
          ? tokenPairs.reduce((n, [a]) => n + a.tokens.totalTokens, 0) /
            baseSuccess
          : null;
        const tokensPerTask = optimizedSuccess
          ? tokenPairs.reduce((n, [, b]) => n + b.tokens.totalTokens, 0) /
            optimizedSuccess
          : null;
        const tokenReduction =
          tokenPairs.length === pairs.length &&
          baseTokens > 0 &&
          tokensPerTask !== null
            ? 1 - tokensPerTask / baseTokens
            : null;
        const qualifies =
          complete &&
          regressions.length === 0 &&
          slowdown !== null &&
          slowdown <= 0.1 &&
          reduction !== null &&
          reduction >= 0.2 &&
          completePairs.length === pairs.length;
        groups.push({
          provider,
          model,
          variant,
          attempts: selected.length,
          evaluated: evaluated.length,
          successes,
          budgetStops: selected.filter((r) =>
            r.outcome?.includes("budget-stop"),
          ).length,
          unavailable: selected.filter(
            (r) =>
              !evaluated.includes(r) && !r.outcome?.includes("budget-stop"),
          ).length,
          failedAttempts: evaluated.length - successes,
          retries: selected.reduce((n, r) => n + (r.retries ?? 0), 0),
          pairs: pairs.length,
          pricedPairs: completePairs.length,
          currency: currencies.length === 1 ? currencies[0] : null,
          tokensPerVerifiedTask: tokensPerTask,
          tokenReduction,
          costPerVerifiedTaskMicros: perTask,
          costReduction: reduction,
          p95Ms: variantP95,
          p95Slowdown: slowdown,
          regressions,
          gate:
            variant === "baseline"
              ? "baseline"
              : qualifies
                ? "pilot-qualified"
                : !complete
                  ? "incomplete"
                  : regressions.length
                    ? "correctness-regression"
                    : slowdown > 0.1
                      ? "latency-regression"
                      : reduction === null
                        ? "unknown-cost"
                        : "target-not-met",
        });
      }
  return {
    schema: "gyro.efficiency-report.v2",
    expectedPairs,
    groups,
    limitations: [
      "Pilot evidence does not prove production-wide quality equivalence.",
      "All failed attempts and budget stops remain represented.",
      "Unpriced or incomplete usage cannot qualify a monetary savings claim.",
      "Native comparisons and subscription observations are reported separately.",
    ],
  };
}
export function markdown(result) {
  return (
    "# Gyro efficiency pilot\n\n| Provider / model | Variant | Verified / attempts | Paired / priced | Cost reduction | p95 change | Gate |\n|---|---|---:|---:|---:|---:|---|\n" +
    result.groups
      .map(
        (g) =>
          `| ${g.provider} / ${g.model} | ${g.variant} | ${g.successes}/${g.attempts} | ${g.pairs}/${g.pricedPairs} | ${g.costReduction === null ? "unknown" : (g.costReduction * 100).toFixed(1) + "%"} | ${g.p95Slowdown === null ? "unknown" : (g.p95Slowdown * 100).toFixed(1) + "%"} | ${g.gate} |`,
      )
      .join("\n") +
    "\n\n" +
    result.limitations.map((l) => `- ${l}`).join("\n") +
    "\n\nTask regressions:\n\n" +
    result.groups
      .flatMap((g) =>
        g.regressions.map(
          (r) =>
            `- ${g.provider} / ${g.variant}: ${r.task}, repetition ${r.trial}, ${r.sessionCondition}`,
        ),
      )
      .join("\n") +
    "\n"
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw Error(
      "Usage: node scripts/efficiency-report.mjs RESULTS_JSON OUTPUT_DIRECTORY",
    );
  const source = JSON.parse(await readFile(input, "utf8"));
  const spec = await readFile(join(resolve(input, ".."), "spec.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const expected = spec
    ? spec.tasks.length * spec.trials * spec.cacheConditions.length
    : 120;
  const result = report(source.records, expected);
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "efficiency-report.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  await writeFile(join(output, "efficiency-report.md"), markdown(result));
}
