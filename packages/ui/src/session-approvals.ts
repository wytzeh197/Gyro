import { pendingSubagentApprovals } from "./subagents.ts";
import { latestChatQuestions } from "./chat-questions.ts";
import type { Session, SessionEvent } from "./types";

function payloadOf(event: SessionEvent): Record<string, unknown> {
  return event.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function turnId(event: SessionEvent) {
  const payloadTurnId = payloadOf(event).turnId;
  return (
    event.turnId ??
    (typeof payloadTurnId === "string" ? payloadTurnId : undefined)
  );
}

function latestNativeTurnEvents(events: SessionEvent[]) {
  events = events.filter(Boolean);
  const start = events.findLastIndex((event) => event.kind === "user-message");
  if (start < 0 || payloadOf(events[start]!).historical === true) return [];
  const currentTurnId = turnId(events[start]!) ?? events[start]!.id;
  return events
    .slice(start)
    .filter(
      (event) =>
        payloadOf(event).historical !== true &&
        (!turnId(event) || turnId(event) === currentTurnId),
    );
}

/** Navigation reflects the latest turn's reconciled approvals, never imported history. */
export function sessionApprovalCounts(
  sessions: Session[],
  eventsBySessionId: Record<string, SessionEvent[]>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const session of sessions) {
    const currentEvents = latestNativeTurnEvents(
      eventsBySessionId[session.id] ?? [],
    );
    const count = new Set(
      pendingSubagentApprovals(currentEvents).map((event) => {
        const payload = payloadOf(event);
        return payload?.proposalId
          ? `proposal:${payload.proposalId}`
          : payload?.approvalId
            ? `approval:${payload.approvalId}`
            : event.id;
      }),
    ).size;
    if (count) counts[session.id] = count;
  }
  return counts;
}

/** Match the question popup, including waiting until a reply finishes streaming. */
export function sessionQuestionCounts(
  sessions: Session[],
  eventsBySessionId: Record<string, SessionEvent[]>,
  sendingSessionIds: string[] = [],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const session of sessions) {
    if (sendingSessionIds.includes(session.id)) continue;
    const events = latestNativeTurnEvents(eventsBySessionId[session.id] ?? []);
    const count = latestChatQuestions(events)?.questions.length ?? 0;
    if (count) counts[session.id] = count;
  }
  return counts;
}
