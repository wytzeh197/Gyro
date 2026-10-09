import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { ProviderUsageState, UsageSafetySnapshot } from "./types";
import { settingsSearchKey } from "./settings-controls";
import { formatTokenCount, summarizeUsageSafety } from "./usage-ledger";
type IconComponent = LucideIcon;

export function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: IconComponent;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      className="gyro-settings-section"
      data-setting-key={settingsSearchKey(title)}
      tabIndex={-1}
    >
      <header>
        <div>
          <h1>
            <Icon aria-hidden="true" size={18} />
            {title}
          </h1>
          <span>{description}</span>
        </div>
      </header>
      <div className="gyro-settings-section-body">{children}</div>
    </section>
  );
}

export function SettingsStatus({
  status,
  children,
}: {
  status: "good" | "info" | "warning" | "critical" | "neutral";
  children: ReactNode;
}) {
  return (
    <span className={`gyro-settings-status is-${status}`}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

export function formatUsageReset(value?: string) {
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

/** Budget choices, in the units people actually think in. */
export function budgetOptions(current?: number) {
  const presets = [
    { label: "No limit", value: 0 },
    { label: "500K tokens / day", value: 500_000 },
    { label: "1M tokens / day", value: 1_000_000 },
    { label: "2M tokens / day", value: 2_000_000 },
    { label: "5M tokens / day", value: 5_000_000 },
    { label: "10M tokens / day", value: 10_000_000 },
  ];
  // A budget set by hand in config may not match a preset, and picking it must
  // not silently round the user's number to the nearest option.
  if (current && !presets.some((preset) => preset.value === current)) {
    presets.push({
      label: `${formatTokenCount(current)} tokens / day`,
      value: current,
    });
    presets.sort((left, right) => left.value - right.value);
  }
  return presets;
}

/** Why runs are held, for the Settings row rather than the composer banner. */
export function usagePauseDetail(snapshot: UsageSafetySnapshot) {
  const notice = summarizeUsageSafety(snapshot);
  return notice ? [notice.title, notice.detail].filter(Boolean).join(" ") : "";
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
  return (
    <article className={`gyro-usage-card is-${severity}`}>
      <header>
        <strong>{window.label}</strong>
        <span>
          {severity === "critical"
            ? "Limit reached"
            : severity === "warning"
              ? "High usage"
              : used === undefined
                ? "Unmeasured"
                : "Within limit"}
        </span>
      </header>
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
      <div className="gyro-usage-card-meta">
        <strong>
          {used === undefined ? "Level not reported" : `${usedLabel}% used`}
        </strong>
        <span>
          {resetCaption ??
            (window.resetsAt
              ? formatUsageReset(window.resetsAt)
              : "Resets with plan window")}
        </span>
      </div>
    </article>
  );
}
