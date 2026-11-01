import type { ProviderUsageState, ProviderUsageWindow } from "./types";
import { formatLimitReset } from "./context-usage.ts";
import { remainingUsage } from "./usage-remaining.ts";

function remainingIn(window: ProviderUsageWindow) {
  return remainingUsage(window.usedPercent, window.status === "exhausted").percent;
}

/** A single ring must reflect the window that will stop work first. Never
 * infer a percentage from a reset time, or reuse an expired allowance. */
export function providerAllowance(
  usage?: ProviderUsageState,
  now = Date.now(),
) {
  const windows =
    usage?.windows.filter((window) => {
      const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      return !Number.isFinite(reset) || reset > now;
    }) ?? [];
  const measured = windows
    .flatMap((window) => {
      const remaining = remainingIn(window);
      return remaining === undefined ? [] : [{ window, remaining }];
    })
    .sort((a, b) => a.remaining - b.remaining);
  const limiting = measured[0];
  const remaining = limiting?.remaining;
  const stale = Boolean(
    usage?.stale || (usage?.status === "error" && windows.length),
  );
  const label =
    remaining !== undefined
      ? `${remainingUsage(limiting!.window.usedPercent, limiting!.window.status === "exhausted").percentLabel} left`
      : usage?.status === "loading"
        ? "Loading usage"
        : usage?.windows.length && !windows.length
          ? "Awaiting reset"
          : "Usage unavailable";
  const detail = windows.length
    ? windows
        .map((window) => {
          const left = remainingIn(window);
          return [
            window.label,
            left === undefined
              ? "Level not reported"
              : `${remainingUsage(window.usedPercent, window.status === "exhausted").percentLabel} left`,
            formatLimitReset(window.resetsAt, now),
          ]
            .filter(Boolean)
            .join(" · ");
        })
        .join("\n")
    : usage?.status === "loading"
      ? "Checking account allowance."
      : usage?.windows.length
        ? "Waiting for the provider to report the new allowance."
        : "This CLI has not reported an account allowance.";
  const severity =
    remaining === undefined
      ? "unknown"
      : remaining <= 5
        ? "critical"
        : remaining <= 25 || limiting?.window.status === "warning"
          ? "warning"
          : "normal";
  return {
    remaining,
    label,
    detail: stale ? `Last reported allowance.\n${detail}` : detail,
    severity,
    stale,
  };
}
