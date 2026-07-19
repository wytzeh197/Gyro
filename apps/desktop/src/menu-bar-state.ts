import type {
  Automation,
  MenuBarJob,
  MenuBarOutcome,
  MenuBarSnapshot,
  Session,
  SessionEvent,
  ThemeMode,
} from "@gyro-dev/ui";

type MenuBarStateInput = {
  automations: Automation[];
  outcome?: MenuBarOutcome;
  reduceMotion: boolean;
  sendingSessionIds: string[];
  sessionEventsById: Record<string, SessionEvent[]>;
  sessions: Session[];
  theme: ThemeMode;
};

function recordFromUnknown(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringFromRecord(
  value: Record<string, unknown> | undefined,
  key: string,
) {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function latestTurnEvents(events: SessionEvent[]) {
  let latestUserIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.kind === "user-message") {
      latestUserIndex = index;
      break;
    }
  }
  return latestUserIndex >= 0 ? events.slice(latestUserIndex) : events;
}

function chatJobStatus(events: SessionEvent[]): MenuBarJob["status"] {
  const turnEvents = latestTurnEvents(events);
  const lastEvent = turnEvents.at(-1);
  const payload = recordFromUnknown(lastEvent?.payload);
  const payloadStatus = stringFromRecord(payload, "status");
  if (
    lastEvent?.kind === "approval-requested" ||
    payloadStatus === "waiting" ||
    payloadStatus === "blocked"
  ) {
    return "waiting";
  }
  return "running";
}

function chatJobDetail(events: SessionEvent[], session: Session) {
  const lastEvent = latestTurnEvents(events).at(-1);
  if (lastEvent?.message.trim()) return lastEvent.message.trim();
  return session.providerLabel
    ? `${session.providerLabel} is working`
    : "Gyro is working";
}

function chatJobStart(events: SessionEvent[], session: Session) {
  const latestUserEvent = [...events]
    .reverse()
    .find((event) => event.kind === "user-message");
  return latestUserEvent?.createdAt ?? session.updatedAt ?? session.createdAt;
}

export function deriveMenuBarJobs({
  automations,
  sendingSessionIds,
  sessionEventsById,
  sessions,
}: Pick<
  MenuBarStateInput,
  "automations" | "sendingSessionIds" | "sessionEventsById" | "sessions"
>): MenuBarJob[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const jobs: MenuBarJob[] = [];

  for (const sessionId of sendingSessionIds) {
    const session = sessionById.get(sessionId);
    if (!session) continue;
    const events = sessionEventsById[sessionId] ?? [];
    const status = chatJobStatus(events);
    jobs.push({
      id: `chat:${sessionId}`,
      kind: "chat",
      targetId: sessionId,
      title: session.title || "Untitled chat",
      detail: chatJobDetail(events, session),
      status,
      startedAt: chatJobStart(events, session),
      canStop: true,
    });
  }

  for (const automation of automations) {
    const run = automation.runHistory[0];
    if (!run || (run.status !== "queued" && run.status !== "running")) {
      continue;
    }
    jobs.push({
      id: `automation:${automation.id}:${run.id}`,
      kind: "automation",
      targetId: automation.id,
      title: automation.title,
      detail:
        run.summary.trim() ||
        (run.status === "queued"
          ? "Waiting for the local scheduler"
          : "Automation is running"),
      status: run.status,
      startedAt: run.startedAt,
      canStop: false,
    });
  }

  return jobs.sort(
    (first, second) =>
      new Date(second.startedAt).getTime() -
      new Date(first.startedAt).getTime(),
  );
}

function providerOutcome(
  sessions: Session[],
  sessionEventsById: Record<string, SessionEvent[]>,
): MenuBarOutcome | undefined {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  let latest: MenuBarOutcome | undefined;
  for (const [sessionId, events] of Object.entries(sessionEventsById)) {
    for (const event of events) {
      if (event.kind !== "system-event") continue;
      const payload = recordFromUnknown(event.payload);
      if (stringFromRecord(payload, "kind") !== "provider-status") continue;
      const status = stringFromRecord(payload, "status");
      if (!status || !["done", "failed", "cancelled"].includes(status)) {
        continue;
      }
      const session = sessionById.get(sessionId);
      const finishedAt =
        stringFromRecord(payload, "completedAt") ?? event.createdAt;
      const outcome: MenuBarOutcome = {
        id: `chat:${sessionId}:${event.id}`,
        kind: "chat",
        targetId: sessionId,
        title: session?.title || "Gyro chat",
        detail: event.message,
        status:
          status === "done"
            ? "succeeded"
            : status === "cancelled"
              ? "stopped"
              : "failed",
        finishedAt,
      };
      if (
        !latest ||
        new Date(outcome.finishedAt).getTime() >
          new Date(latest.finishedAt).getTime()
      ) {
        latest = outcome;
      }
    }
  }
  return latest;
}

function automationOutcome(automations: Automation[]) {
  let latest: MenuBarOutcome | undefined;
  for (const automation of automations) {
    const run = automation.runHistory[0];
    if (
      !run?.finishedAt ||
      !["passed", "failed", "stopped"].includes(run.status)
    ) {
      continue;
    }
    const outcome: MenuBarOutcome = {
      id: `automation:${automation.id}:${run.id}`,
      kind: "automation",
      targetId: automation.id,
      title: automation.title,
      detail: run.summary,
      status:
        run.status === "passed"
          ? "succeeded"
          : run.status === "stopped"
            ? "stopped"
            : "failed",
      finishedAt: run.finishedAt,
    };
    if (
      !latest ||
      new Date(outcome.finishedAt).getTime() >
        new Date(latest.finishedAt).getTime()
    ) {
      latest = outcome;
    }
  }
  return latest;
}

export function deriveLatestMenuBarOutcome(
  sessions: Session[],
  sessionEventsById: Record<string, SessionEvent[]>,
  automations: Automation[],
) {
  const chat = providerOutcome(sessions, sessionEventsById);
  const automation = automationOutcome(automations);
  if (!chat) return automation;
  if (!automation) return chat;
  return new Date(chat.finishedAt).getTime() >=
    new Date(automation.finishedAt).getTime()
    ? chat
    : automation;
}

export function deriveMenuBarSnapshot(
  input: MenuBarStateInput,
): MenuBarSnapshot {
  const jobs = deriveMenuBarJobs(input);
  const hasWaitingJob = jobs.some((job) => job.status === "waiting");
  const hasFailedOutcome = input.outcome?.status === "failed";
  const state =
    hasWaitingJob || hasFailedOutcome
      ? "attention"
      : jobs.length > 0
        ? "working"
        : input.outcome?.status === "succeeded"
          ? "complete"
          : "idle";
  return {
    state,
    jobs,
    totalActive: jobs.length,
    recentOutcome: input.outcome,
    theme: input.theme,
    reduceMotion: input.reduceMotion,
  };
}
