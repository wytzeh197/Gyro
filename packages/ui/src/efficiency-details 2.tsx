import type { SessionEvent } from "./types";
import "./efficiency.css";
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
        contextAttribution?: Record<string, number | boolean>;
        estimatedCost?: { currency: string; micros: number };
        subscriptionBilling?: boolean;
        taskTotals?: {
          calls: number;
          failedCalls: number;
          unpricedCalls: number;
          verified: boolean;
        };
      }
    | undefined;
  const attribution = payload?.contextAttribution;
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
        </>
      ) : null}
      {payload?.taskTotals ? (
        <p>
          {payload.taskTotals.calls} calls · {payload.taskTotals.failedCalls}{" "}
          failed or cancelled · {payload.taskTotals.unpricedCalls} unpriced.{" "}
          {payload.taskTotals.verified
            ? "Independently verified."
            : "Task completion has not been independently verified."}
        </p>
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
