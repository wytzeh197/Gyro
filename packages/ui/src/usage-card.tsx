import type { CSSProperties } from "react";
import { Badge, type Tone } from "./primitives";
import type { ProviderUsageState } from "./types";

/**
 * One plan or spend window on Settings > Usage Limits.
 *
 * It lives beside `surfaces.tsx` rather than inside it because that file sits
 * at its architecture ceiling. Each window is a compact row: its name, how full
 * it is, the amount behind the percentage (or when it resets), and whether it
 * is within its limit. "Bars" draws the level as a bar across the row;
 * "Wheels" as a small ring beside the name.
 */

function formatUsageReset(value?: string) {
  if (!value) return "Reset time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  const relativeMs = date.getTime() - Date.now();
  if (relativeMs > 0 && relativeMs < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(relativeMs / 3_600_000);
    const minutes = Math.max(1, Math.round((relativeMs % 3_600_000) / 60_000));
    return `Resets in ${hours ? `${hours}h ` : ""}${minutes}m`;
  }
  return `Resets ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
}

export function UsageCard({
  window,
  visualization,
  resetCaption,
}: {
  window?: ProviderUsageState["windows"][number];
  visualization: "bars" | "wheels";
  /** Replaces the reset line — ledger windows carry their spend detail here. */
  resetCaption?: string;
}) {
  if (!window) return null;
  // Plan windows report how much of the allowance is *spent* this period.
  // The bar fills as spend builds up.
  const measured =
    typeof window.usedPercent === "number" &&
    Number.isFinite(window.usedPercent);
  const used = measured
    ? Math.max(0, Math.min(100, Math.round(window.usedPercent!)))
    : window.status === "exhausted"
      ? 100
      : undefined;
  const severity =
    window.status === "exhausted" || (used !== undefined && used >= 95)
      ? "critical"
      : window.status === "warning" || (used !== undefined && used >= 80)
        ? "warning"
        : "normal";
  const usedLabel =
    used === undefined
      ? "—"
      : used === 0 && measured && (window.usedPercent ?? 0) > 0
        ? "<1"
        : String(used);
  // Within limit stays quiet; only a window that needs attention takes colour.
  const status: { label: string; tone: Tone } =
    severity === "critical"
      ? { label: "Limit reached", tone: "danger" }
      : severity === "warning"
        ? { label: "High usage", tone: "warn" }
        : {
            label: used === undefined ? "Unmeasured" : "Within limit",
            tone: "neutral",
          };
  const caption =
    resetCaption ??
    (window.resetsAt
      ? formatUsageReset(window.resetsAt)
      : "Resets with plan window");
  return (
    <article
      className={`gyro-usage-card is-${severity}`}
      data-visualization={visualization}
    >
      <strong className="gyro-usage-card-label" title={window.label}>
        {window.label}
      </strong>
      {visualization === "wheels" ? (
        <div
          className="gyro-usage-wheel"
          style={
            {
              "--usage": `${(used ?? 0) * 3.6}deg`,
            } as CSSProperties
          }
        >
          <span>
            <strong>{used === undefined ? "—" : `${usedLabel}%`}</strong>
            <small>used</small>
          </span>
        </div>
      ) : (
        <div
          className={`gyro-usage-bar${used === undefined ? " is-unmeasured" : ""}`}
          aria-label={
            used === undefined
              ? `${window.label}: level not reported`
              : `${usedLabel}% used`
          }
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(used !== undefined ? { "aria-valuenow": used } : {})}
        >
          {used !== undefined ? (
            <span
              style={{
                width: `${Math.max(used, used > 0 ? 2 : 0)}%`,
              }}
            />
          ) : null}
        </div>
      )}
      <span className="gyro-usage-card-meta">
        {/* The ring already carries the percentage; bars say it here. */}
        {visualization === "bars" ? (
          <strong>
            {used === undefined ? "Level not reported" : `${usedLabel}% used`}
          </strong>
        ) : null}
        <span>{caption}</span>
      </span>
      <Badge className="gyro-usage-card-status" tone={status.tone}>
        {status.label}
      </Badge>
    </article>
  );
}
