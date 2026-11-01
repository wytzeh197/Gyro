import { useEffect, useRef, useState } from "react";
import type { SessionEvent } from "@gyro-dev/ui";
import {
  createCheckReminderTracker,
  type CheckReminder,
} from "./check-reminder";
export function useCheckReminders(
  enabled: boolean,
  sending: readonly string[],
  events: Record<string, SessionEvent[]>,
) {
  const tracker = useRef(createCheckReminderTracker());
  const [reminders, setReminders] = useState<CheckReminder[]>([]);
  useEffect(() => {
    const fresh = tracker.current.observe(enabled, sending, events);
    if (!enabled) setReminders((current) => (current.length ? [] : current));
    else if (fresh.length)
      setReminders((current) => [...current, ...fresh].slice(-10));
  }, [enabled, sending, events]);
  return {
    reminders,
    dismiss: (turnId: string) =>
      setReminders((current) => current.filter((r) => r.turnId !== turnId)),
  };
}
