import type { Automation } from "./types.ts";

export function automationScheduleLabel(
  automation: Pick<Automation, "schedule" | "execution">,
): string {
  const calendar = automation.execution?.calendar;
  if (
    calendar &&
    ["once", "daily-at", "weekly-at"].includes(automation.schedule)
  ) {
    const cadence =
      automation.schedule === "once"
        ? (calendar.date ?? "Once")
        : automation.schedule === "weekly-at"
          ? ([
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
              "Sunday",
            ][calendar.weekday ?? -1] ?? "Weekly")
          : "Daily";
    return `${cadence} at ${calendar.time} · ${calendar.timezone}`;
  }
  return {
    manual: "Manual only",
    hourly: "Every hour",
    daily: "Every 24 hours",
    weekly: "Every 7 days",
    heartbeat: "Hourly heartbeat",
    once: "Once",
    "daily-at": "Daily",
    "weekly-at": "Weekly",
  }[automation.schedule];
}
