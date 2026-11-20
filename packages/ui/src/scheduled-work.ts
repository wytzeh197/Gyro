import type { ReactNode } from "react";
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

export type RenderScheduleIndex = (options: {
  automations: Automation[];
  onCreatePrompt: () => void;
  onOpenPrompt: (id: string) => void;
  busy: boolean;
}) => ReactNode;

export function automationDateLabel(value: string, timezone?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: timezone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", options).format(date);
  }
}

export function isRecordedAutomationRun(
  run: Pick<
    Automation["runHistory"][number],
    "summary" | "finishedAt" | "sessionId"
  > & { status: string },
) {
  return !(
    run.status === "queued" &&
    run.summary === "Automation created locally" &&
    !run.finishedAt &&
    !run.sessionId
  );
}
