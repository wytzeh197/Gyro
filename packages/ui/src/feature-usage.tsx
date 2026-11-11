export type FeatureUsage = {
  calls: number;
  totalTokens: number;
  estimatedCalls: number;
  unavailableCalls: number;
};
/** Ledger measurements only; no inferred prices or zero-cost claims. */
export function FeatureUsageLine({
  usage,
  createdAt,
  finishedAt,
}: {
  usage?: FeatureUsage;
  createdAt: string;
  finishedAt?: string;
}) {
  const seconds = Math.max(
    0,
    Math.floor(
      ((finishedAt ? Date.parse(finishedAt) : Date.now()) -
        Date.parse(createdAt)) /
        1000,
    ),
  );
  return (
    <p>
      {Number.isFinite(seconds)
        ? `Elapsed ${Math.floor(seconds / 60)}m ${seconds % 60}s · `
        : ""}
      {usage
        ? `${usage.calls} recorded calls · ${usage.totalTokens.toLocaleString()} recorded tokens${usage.estimatedCalls ? " · includes estimates" : ""}${usage.unavailableCalls ? " · missing receipts" : ""}`
        : "Usage receipt unavailable"}
    </p>
  );
}
