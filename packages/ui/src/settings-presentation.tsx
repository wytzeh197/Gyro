import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { ProviderUsageState, UsageSafetySnapshot } from "./types";
import { settingsSearchKey } from "./settings-controls";
import { formatTokenCount, summarizeUsageSafety } from "./usage-ledger";
import { remainingUsage } from "./usage-remaining";
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
          <p className="gyro-settings-eyebrow">Settings</p>
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
  // Provider reports are spend; the meter presents the allowance still available.
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
  const remaining = remainingUsage(window.usedPercent, window.status === "exhausted");
  return (
    <article className={`gyro-usage-card is-${severity}`}>
      <header>
        <strong>{window.label}</strong>
        <span>
          {severity === "critical"
            ? remaining.percent === 0 ? "No allowance left" : "Almost empty"
            : severity === "warning"
              ? "Low allowance"
              : used === undefined
                ? "Unmeasured"
                : "Within limit"}
        </span>
      </header>
      {visualization === "wheels" ? (
        <div
          className="gyro-usage-wheel"
          role="progressbar"
          aria-label={remaining.percent === undefined ? `${window.label}: level not reported` : `${window.label}: ${remaining.percentLabel} left`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={remaining.percent}
          style={
            {
              "--usage": `${(remaining.percent ?? 0) * 3.6}deg`,
            } as CSSProperties
          }
        >
          <span>
            <strong>{remaining.percentLabel}</strong>
            <small>left</small>
          </span>
        </div>
      ) : (
        <div
          className={`gyro-usage-bar${used === undefined ? " is-unmeasured" : ""}`}
          aria-label={
            used === undefined
              ? `${window.label}: level not reported`
              : `${window.label}: ${remaining.percentLabel} left`
          }
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(remaining.percent !== undefined ? { "aria-valuenow": remaining.percent } : {})}
        >
          {used !== undefined ? (
            <span
              style={{
                width: `${remaining.percent}%`,
              }}
            />
          ) : null}
        </div>
      )}
      <div className="gyro-usage-card-meta">
        <strong>
          {remaining.percent === undefined ? "Level not reported" : `${remaining.percentLabel} left`}
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
