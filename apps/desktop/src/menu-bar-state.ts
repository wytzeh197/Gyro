import type {
  Automation,
  DesktopNotificationPreferences,
  MenuBarApproval,
  MenuBarJob,
  MenuBarOutcome,
  MenuBarSnapshot,
  ResolvedTheme,
  Session,
  SessionEvent,
} from "@gyro-dev/ui";
import {
  pendingSessionApprovals,
  pendingSessionQuestions,
} from "../../../packages/ui/src/session-approvals.ts";

type MenuBarStateInput = {
  automations: Automation[];
  finishedOutcomes?: MenuBarOutcome[];
  notifications: DesktopNotificationPreferences;
  outcome?: MenuBarOutcome;
  reduceMotion: boolean;
  sendingSessionIds: string[];
  sessionEventsById: Record<string, SessionEvent[]>;
  sessions: Session[];
  theme: ResolvedTheme;
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
    pendingSessionApprovals(events).length > 0 ||
    payloadStatus === "waiting" ||
    payloadStatus === "blocked"
  ) {
    return "waiting";
  }
  return "running";
}

/** The pending provider approval the latest turn is blocked on, if any.
    Capability approvals are left out: they need the turn context the chat
    view resolves them with, so the popover only offers to open those. */
function pendingApproval(events: SessionEvent[]): MenuBarApproval | undefined {
  const lastEvent = pendingSessionApprovals(events).find(
    (event) =>
      stringFromRecord(recordFromUnknown(event.payload), "kind") ===
      "provider-tool-approval",
  );
  if (!lastEvent) return undefined;
  const payload = recordFromUnknown(lastEvent.payload);
  if (stringFromRecord(payload, "kind") !== "provider-tool-approval") {
    return undefined;
  }
  if (stringFromRecord(payload, "status") !== "pending") return undefined;
  const id = stringFromRecord(payload, "approvalId");
  if (!id) return undefined;
  const approvalType = stringFromRecord(payload, "approvalType") ?? "tool";
  const summary = (
    stringFromRecord(payload, "command") ??
    stringFromRecord(payload, "reason") ??
    lastEvent.message
  ).trim();
  return { id, approvalType, summary };
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
  finishedOutcomes = [],
  sendingSessionIds,
  sessionEventsById,
  sessions,
}: Pick<
  MenuBarStateInput,
  | "automations"
  | "finishedOutcomes"
  | "sendingSessionIds"
  | "sessionEventsById"
  | "sessions"
>): MenuBarJob[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const activeSessionIds = new Set(sendingSessionIds);
  const jobs: MenuBarJob[] = [];

  const waitingForReplies = new Set<string>();
  for (const session of sessions) {
    const sessionId = session.id;
    const isSending = activeSessionIds.has(sessionId);
    if (session.parentSessionId && !isSending) continue;
    const events = sessionEventsById[sessionId] ?? [];
    // Use the same native-turn reconciliation as the chat/sidebar. A finished
    // reply can still need an answer; imported and superseded questions cannot.
    const question = !isSending ? pendingSessionQuestions(events) : undefined;
    const approvals = pendingSessionApprovals(events);
    if (!isSending && !question && !approvals.length) continue;
    if (question || approvals.length) waitingForReplies.add(sessionId);
    const status =
      question || approvals.length ? "waiting" : chatJobStatus(events);
    const approval = status === "waiting" ? pendingApproval(events) : undefined;
    jobs.push({
      id: `chat:${sessionId}`,
      kind: "chat",
      targetId: sessionId,
      title: session.title || "Untitled chat",
      detail: chatJobDetail(events, session),
      status,
      startedAt: chatJobStart(events, session),
      canStop: isSending,
      providerId: session.providerId,
      providerLabel: session.providerLabel,
      modelId: session.modelId,
      modelLabel: session.modelLabel,
      ...(approval ? { approval } : {}),
      ...(question
        ? {
            question: {
              id: question.id,
              summary: question.questions
                .map((item) => item.title)
                .join("\n\n"),
            },
          }
        : {}),
    });
  }

  for (const outcome of finishedOutcomes) {
    if (
      outcome.kind !== "chat" ||
      outcome.status !== "succeeded" ||
      activeSessionIds.has(outcome.targetId) ||
      waitingForReplies.has(outcome.targetId)
    ) {
      continue;
    }
    const session = sessionById.get(outcome.targetId);
    jobs.push({
      id: outcome.id,
      kind: "chat",
      targetId: outcome.targetId,
      title: outcome.title,
      detail: outcome.detail,
      status: "finished",
      startedAt: outcome.finishedAt,
      canStop: false,
      providerId: outcome.providerId ?? session?.providerId,
      providerLabel: outcome.providerLabel ?? session?.providerLabel,
      modelId: outcome.modelId ?? session?.modelId,
      modelLabel: outcome.modelLabel ?? session?.modelLabel,
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

  // Anything waiting on the user leads, so an approval is never hidden under
  // the "+N more" row; within each group the newest job comes first.
  return jobs.sort(
    (first, second) =>
      Number(second.status === "waiting") -
        Number(first.status === "waiting") ||
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
    const session = sessionById.get(sessionId);
    // Child runs are represented by their parent. A reply asking a question
    // is waiting for input rather than a completion notification.
    if (session?.parentSessionId || pendingSessionQuestions(events)) continue;
    for (const event of events) {
      if (event.kind !== "system-event") continue;
      const payload = recordFromUnknown(event.payload);
      if (stringFromRecord(payload, "kind") !== "provider-status") continue;
      const status = stringFromRecord(payload, "status");
      if (!status || !["done", "failed", "cancelled"].includes(status)) {
        continue;
      }
      const finishedAt =
        stringFromRecord(payload, "completedAt") ?? event.createdAt;
      const outcome: MenuBarOutcome = {
        id: `chat:${sessionId}:${event.turnId || event.id}`,
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
        providerId: session?.providerId,
        providerLabel: session?.providerLabel,
        modelId: session?.modelId,
        modelLabel: session?.modelLabel,
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
  const activeJobs = jobs.filter((job) => job.status !== "finished");
  const hasWaitingJob = jobs.some((job) => job.status === "waiting");
  const hasFailedOutcome = input.outcome?.status === "failed";
  const state =
    hasWaitingJob || hasFailedOutcome
      ? "attention"
      : activeJobs.length > 0
        ? "working"
        : jobs.some((job) => job.status === "finished") ||
            input.outcome?.status === "succeeded"
          ? "complete"
          : "idle";
  return {
    state,
    jobs,
    totalActive: activeJobs.length,
    recentOutcome: input.outcome,
    theme: input.theme,
    reduceMotion: input.reduceMotion,
    notifications: input.notifications,
  };
}
