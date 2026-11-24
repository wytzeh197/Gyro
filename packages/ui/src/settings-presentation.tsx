import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { ProviderUsageState, UsageSafetySnapshot } from "./types";
import { settingsSearchKey } from "./settings-controls";
import { StatusChip } from "./primitives/feedback";
import { formatTokenCount, summarizeUsageSafety } from "./usage-ledger";
import { remainingUsage } from "./usage-remaining";
type IconComponent = LucideIcon;

export function SettingsSection({
  title,
  description,
  children,
  dataTour,
  actions,
}: {
  icon?: IconComponent;
  title: string;
  description?: string;
  children: ReactNode;
  dataTour?: string;
  actions?: ReactNode;
}) {
  return (
    <section
      className="gyro-settings-section"
      data-setting-key={settingsSearchKey(title)}
      tabIndex={-1}
    >
      <header data-tour={dataTour}>
        <div>
          <h1>{title}</h1>
          {description ? <span>{description}</span> : null}
        </div>
        {actions ? (
          <div className="gyro-settings-header-actions">{actions}</div>
        ) : null}
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
  const tone = status === "good" ? "success" : status === "critical" ? "danger" : status;
  return (
    <StatusChip className="gyro-settings-status" dot tone={tone}>
      {children}
    </StatusChip>
  );
}

export function formatUsageReset(value?: string) {
  if (!value) return "Reset time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  const relativeMs = date.getTime() - Date.now();
  if (relativeMs > 0 && relativeMs < 24 * 60 * 60 * 1000) {
    // Round the whole span first so 1h 59m 40s reads "2h", never "1h 60m".
    const totalMinutes = Math.max(1, Math.round(relativeMs / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours) return `Resets in ${minutes}m`;
    return `Resets in ${hours}h${minutes ? ` ${minutes}m` : ""}`;
  }
  return `Resets ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
}

/** Relative countdown plus a calendar date, for the allowance card's side column. */
export function usageResetParts(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const relativeMs = date.getTime() - Date.now();
  if (relativeMs <= 0) return { relative: formatUsageReset(value) };
  // Round to the nearest hour so 3d 23h 59m reads "4d", not "3d 23h".
  const totalHours = Math.round(relativeMs / 3_600_000);
  const days = relativeMs >= 86_400_000 ? Math.floor(totalHours / 24) : 0;
  const hours = totalHours % 24;
  return {
    relative:
      days > 0
        ? `Resets in ${days}d${hours ? ` ${hours}h` : ""}`
        : formatUsageReset(value),
    date: new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date),
  };
}

const usageWindowLengthMs: Record<string, number> = {
  "five-hour": 5 * 3_600_000,
  weekly: 7 * 86_400_000,
};

/**
 * Allowance an even pace would leave by now. Only for windows whose length is
 * known, so the marker never guesses at a provider's custom plan period.
 */
export function expectedRemaining(id: string, resetsAt?: string) {
  const length =
    usageWindowLengthMs[id] ??
    (id.startsWith("weekly") ? usageWindowLengthMs.weekly : undefined);
  if (!length || !resetsAt) return undefined;
  const left = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(left) || left <= 0 || left > length) return undefined;
  return (left / length) * 100;
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
  const remaining = remainingUsage(
    window.usedPercent,
    window.status === "exhausted",
  );
  const statusLabel =
    severity === "critical"
      ? remaining.percent === 0
        ? "No allowance left"
        : "Almost empty"
      : severity === "warning"
        ? "Low allowance"
        : used === undefined
          ? "Unmeasured"
          : "Within limit";
  if (visualization === "bars") {
    const reset = resetCaption ? undefined : usageResetParts(window.resetsAt);
    const expected =
      remaining.percent === undefined || resetCaption
        ? undefined
        : expectedRemaining(window.id, window.resetsAt);
    const pace =
      expected === undefined || remaining.percent === undefined
        ? undefined
        : remaining.percent - expected;
    return (
      <article className={`gyro-usage-card is-${severity} is-bars`}>
        <header>
          <div className="gyro-usage-card-figure">
            <span>{window.label}</span>
            <strong>
              {remaining.percent === undefined ? "—" : remaining.percentLabel}
              {remaining.percent === undefined ? null : <small>left</small>}
            </strong>
          </div>
          <div className="gyro-usage-card-side">
            <span className={`gyro-usage-pill is-${severity}`}>
              {statusLabel}
            </span>
            <span>
              {resetCaption ?? reset?.relative ?? "Resets with plan window"}
            </span>
            {reset?.date ? <small>{reset.date}</small> : null}
          </div>
        </header>
        <div className="gyro-usage-track">
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
            {...(remaining.percent !== undefined
              ? { "aria-valuenow": remaining.percent }
              : {})}
          >
            {used !== undefined ? (
              <span style={{ width: `${remaining.percent}%` }} />
            ) : null}
          </div>
          {expected !== undefined ? (
            <i
              aria-hidden="true"
              className="gyro-usage-expected"
              style={{ left: `${expected}%` }}
              title={`Expected at an even pace: ${Math.round(expected)}% left`}
            />
          ) : null}
        </div>
        <div className="gyro-usage-scale" aria-hidden="true">
          <span>0%</span>
          {expected !== undefined ? (
            <span
              className="gyro-usage-scale-expected"
              style={{ left: `${Math.max(8, Math.min(92, expected))}%` }}
            >
              Expected
            </span>
          ) : null}
          <span>100%</span>
        </div>
        {pace !== undefined ? (
          <p className={`gyro-usage-pace${pace < -3 ? " is-ahead" : ""}`}>
            {pace < -3
              ? `Using it faster than an even pace — about ${Math.round(expected!)}% would be left by now.`
              : pace > 3
                ? `Under pace — ${Math.round(pace)}% more left than an even pace would leave.`
                : "Right on pace for this window."}
          </p>
        ) : null}
      </article>
    );
  }
  return (
    <article className={`gyro-usage-card is-${severity}`}>
      <header>
        <strong>{window.label}</strong>
        <span className={`gyro-usage-pill is-${severity}`}>{statusLabel}</span>
      </header>
      <div
        className="gyro-usage-wheel"
        role="progressbar"
        aria-label={
          remaining.percent === undefined
            ? `${window.label}: level not reported`
            : `${window.label}: ${remaining.percentLabel} left`
        }
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
      <div className="gyro-usage-card-meta">
        <strong>
          {remaining.percent === undefined
            ? "Level not reported"
            : `${remaining.percentLabel} left`}
        </strong>
        <span>
          {resetCaption ??
            (window.resetsAt
              ? (usageResetParts(window.resetsAt)?.relative ??
                formatUsageReset(window.resetsAt))
              : "Resets with plan window")}
        </span>
      </div>
    </article>
  );
}
