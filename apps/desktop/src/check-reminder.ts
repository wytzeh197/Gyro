import type { SessionEvent } from "@gyro-dev/ui";
export type CheckReminder = { sessionId: string; turnId: string };
/** Only structured applied edits or completed file activities count, never prose. */
export function completedCheckReminder(
  sessionId: string,
  events: readonly SessionEvent[],
  after: number,
): CheckReminder | undefined {
  const statuses = events.filter(
    (e) =>
      e.kind === "system-event" &&
      (e.payload as Record<string, unknown> | undefined)?.kind ===
        "provider-status" &&
      e.turnId &&
      Date.parse(
        String(
          (e.payload as Record<string, unknown>).completedAt ?? e.createdAt,
        ),
      ) >= after,
  );
  const completion = statuses.at(-1);
  if (
    !completion ||
    (completion.payload as Record<string, unknown>).status !== "done"
  )
    return;
  const edits = events.some((e) => {
    if (e.turnId !== completion.turnId || e.kind !== "system-event")
      return false;
    const p = e.payload as Record<string, unknown> | undefined;
    if (!p) return false;
    if (
      p.status === "applied" &&
      ["gyro.mutation.v1", "gyro.provider-approval.v1"].includes(
        String(p.schema),
      )
    )
      return (
        Array.isArray(p.fileChanges) &&
        p.fileChanges.some((f) => f && typeof f.path === "string")
      );
    return (
      p.kind === "provider-activity" &&
      p.activityKind === "file" &&
      p.status === "done" &&
      typeof p.path === "string"
    );
  });
  return edits ? { sessionId, turnId: completion.turnId! } : undefined;
}

/** In-memory observation means restored history cannot create reminders. */
export function createCheckReminderTracker() {
  const started = new Map<string, number>();
  const seen = new Set<string>();
  return {
    observe(
      enabled: boolean,
      sending: readonly string[],
      events: Record<string, SessionEvent[]>,
      now = Date.now(),
    ): CheckReminder[] {
      if (!enabled) {
        started.clear();
        return [];
      }
      for (const id of sending) if (!started.has(id)) started.set(id, now);
      const fresh: CheckReminder[] = [];
      for (const [id, at] of started) {
        const history = events[id] ?? [];
        const reminder = completedCheckReminder(id, history, at);
        if (reminder) {
          const key = `${id}/${reminder.turnId}`;
          if (!seen.has(key)) {
            seen.add(key);
            fresh.push(reminder);
          }
          started.delete(id);
        } else if (
          !sending.includes(id) &&
          history.some((e) => {
            const p = e.payload as Record<string, unknown> | undefined;
            return (
              p?.kind === "provider-status" &&
              Date.parse(String(p.completedAt ?? e.createdAt)) >= at &&
              ["done", "failed", "cancelled", "stopped"].includes(
                String(p.status),
              )
            );
          })
        )
          started.delete(id);
      }
      return fresh;
    },
  };
}
