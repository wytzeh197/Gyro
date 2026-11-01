import type { SessionEvent } from "./types";
import "./efficiency.css";

type GenerationAttempts = {
  started: number;
  completed: number;
  rejected: number;
  retries: number;
};
type Attribution = Record<string, unknown> & {
  retiredBytes?: number;
  retirementAccountingVersion?: number;
  generationAttempts?: GenerationAttempts;
  toolClassCounts?: Record<string, number>;
  efficiencyEvents?: Record<string, number>;
};
const efficiencyEventLabels: Record<string, string> = {
  catalogDiscoveries: "Tool discoveries",
  catalogRediscoveries: "Rediscoveries after compaction",
  catalogFallbacks: "Catalog fallbacks",
  spillRecoveries: "Evidence recoveries",
  spillFailures: "Evidence storage or recovery failures",
  repeatedCallNotices: "Repeated-work notices",
  repeatedCallPauses: "Repeated-work pauses",
};
const toolClasses: Record<string, string> = {
  "workspace-read": "Workspace reads",
  "workspace-search": "Workspace searches",
  "workspace-list": "Workspace listings",
  "workspace-write": "Workspace writes",
  terminal: "Terminal",
  browser: "Browser",
  git: "Git",
  web: "Web",
  code: "Code",
  agent: "Agent",
  memory: "Memory",
  other: "Other",
};
function toolCounts(counts?: Record<string, number>) {
  if (!counts) return "Unavailable";
  const observed = Object.entries(toolClasses).flatMap(([key, label]) => {
    const count = counts[key];
    return typeof count === "number" && Number.isFinite(count) && count > 0
      ? [`${label}: ${count.toLocaleString()}`]
      : [];
  });
  return observed.length ? observed.join(" · ") : "No tool requests observed";
}
export function EfficiencyDetails({ events }: { events: SessionEvent[] }) {
  const receipt = [...events]
    .reverse()
    .find(
      (e) =>
        (e.payload as { kind?: string } | undefined)?.kind ===
        "efficiency-receipt",
    );
  const checkpoint = [...events]
    .reverse()
    .find((e) => e.kind === "task-checkpoint");
  if (!receipt && !checkpoint) return null;
  const payload = receipt?.payload as
    | {
        contextAttribution?: Attribution;
        estimatedCost?: { currency: string; micros: number };
        subscriptionBilling?: boolean;
        usageTokens?: { cachedInputTokens?: number };
        usageAccounting?: {
          source?: string;
          coverage?: string;
          known?: { cacheRead?: boolean };
        };
        taskTotals?: {
          calls: number;
          failedCalls: number;
          unpricedCalls: number;
          verified: boolean;
          retiredBytes?: number;
          retirementCoverage?: "complete" | "partial" | "unavailable";
          generationAttempts?: GenerationAttempts;
          generationCoverage?: "complete" | "partial" | "unavailable";
          toolClassCounts?: Record<string, number>;
          toolClassCoverage?: "complete" | "partial" | "unavailable";
        };
      }
    | undefined;
  const attribution = payload?.contextAttribution;
  const attempts = attribution?.generationAttempts;
  const cacheKnown =
    payload?.usageAccounting?.source === "provider" &&
    payload.usageAccounting.coverage === "complete" &&
    payload.usageAccounting.known?.cacheRead === true &&
    Number.isFinite(payload.usageTokens?.cachedInputTokens);
  return (
    <details className="gyro-efficiency-details">
      <summary>
        Efficiency details
        {payload?.estimatedCost
          ? ` · ~${payload.estimatedCost.currency} ${(payload.estimatedCost.micros / 1e6).toFixed(4)}`
          : ""}
      </summary>
      <p>
        {payload?.subscriptionBilling
          ? "Provider subscription usage is separate from API pricing."
          : payload?.estimatedCost
            ? "Last turn API cost is an estimate using the saved price snapshot."
            : "API cost is unknown: a price or complete usage breakdown is unavailable."}
      </p>
      {attribution?.efficiencyEvents ? (
        <p>
          {Object.entries(efficiencyEventLabels)
            .map(
              ([key, label]) =>
                `${label}: ${(attribution.efficiencyEvents?.[key] ?? 0).toLocaleString()}`,
            )
            .join(" · ")}
        </p>
      ) : (
        <p>Efficiency event counts unavailable for this turn.</p>
      )}
      {attribution ? (
        <>
          <p>
            Gyro-supplied context, in characters. Token conversion is estimated.
            {attribution.hiddenContent
              ? " Provider-owned or image context is not measured here."
              : ""}
          </p>
          <dl>
            {[
              "instructions",
              "toolSchemas",
              "sourceExcerpts",
              "toolResults",
              "taskState",
              "history",
              "otherText",
            ].map((key) => (
              <div key={key}>
                <dt>
                  {
                    {
                      instructions: "Instructions",
                      toolSchemas: "Tool definitions",
                      sourceExcerpts: "Source excerpts",
                      toolResults: "Tool results",
                      taskState: "Task state",
                      history: "History",
                      otherText: "Other supplied text",
                    }[key]
                  }
                </dt>
                <dd>{Number(attribution[key] ?? 0).toLocaleString()}</dd>
              </div>
            ))}
          </dl>
          <p>
            {attempts
              ? `Generation attempts this turn: ${attempts.started.toLocaleString()} · ${attempts.completed.toLocaleString()} completed · ${attempts.rejected.toLocaleString()} rejected · ${attempts.retries.toLocaleString()} retries.`
              : "Generation attempts inside the provider are unavailable."}
          </p>
          <p>
            Validated tool requests this turn:{" "}
            {toolCounts(attribution.toolClassCounts)}.
          </p>
          <p>
            {attribution.retirementAccountingVersion === 2 &&
            Number.isFinite(attribution.retiredBytes)
              ? `Newly retired context this turn: ${attribution.retiredBytes!.toLocaleString()} bytes. This is not a token or billing estimate.`
              : "Newly retired context for this turn is unavailable."}
          </p>
          <p>
            {cacheKnown
              ? `Provider-reported cache reads this turn: ${payload!.usageTokens!.cachedInputTokens!.toLocaleString()} tokens.`
              : "Provider cache-read coverage for this turn is unavailable or incomplete."}
          </p>
        </>
      ) : null}
      {payload?.taskTotals ? (
        <>
          <p>
            {payload.taskTotals.calls} calls · {payload.taskTotals.failedCalls}{" "}
            failed or cancelled · {payload.taskTotals.unpricedCalls} unpriced.{" "}
            {payload.taskTotals.verified
              ? "Independently verified."
              : "Task completion has not been independently verified."}
          </p>
          <p>
            {payload.taskTotals.generationCoverage === "complete" &&
            payload.taskTotals.generationAttempts
              ? `Task generation attempts: ${payload.taskTotals.generationAttempts.started.toLocaleString()}.`
              : `Task generation coverage: ${payload.taskTotals.generationCoverage ?? "unavailable"}.`}{" "}
            {payload.taskTotals.retirementCoverage === "complete" &&
            Number.isFinite(payload.taskTotals.retiredBytes)
              ? `Newly retired context: ${payload.taskTotals.retiredBytes!.toLocaleString()} bytes.`
              : `Retirement coverage: ${payload.taskTotals.retirementCoverage ?? "unavailable"}.`}
          </p>
          <p>
            {payload.taskTotals.toolClassCoverage === "complete"
              ? `Task validated tool requests: ${toolCounts(payload.taskTotals.toolClassCounts)}.`
              : `Task tool coverage: ${payload.taskTotals.toolClassCoverage ?? "unavailable"}.`}
          </p>
        </>
      ) : null}
      {checkpoint ? (
        <details>
          <summary>Task checkpoint</summary>
          <p>
            Decisions and constraints below are agent assertions. Older file and
            output evidence must be revalidated.
          </p>
          <pre>{JSON.stringify(checkpoint.payload, null, 2)}</pre>
        </details>
      ) : null}
    </details>
  );
}
