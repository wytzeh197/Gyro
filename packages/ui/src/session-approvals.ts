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
export function pendingSessionApprovals(events: SessionEvent[]) {
  return pendingSubagentApprovals(latestNativeTurnEvents(events));
}

export function sessionApprovalCounts(
  sessions: Session[],
  eventsBySessionId: Record<string, SessionEvent[]>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const session of sessions) {
    const count = new Set(
      pendingSessionApprovals(eventsBySessionId[session.id] ?? []).map(
        (event) => {
          const payload = payloadOf(event);
          return payload?.proposalId
            ? `proposal:${payload.proposalId}`
            : payload?.approvalId
              ? `approval:${payload.approvalId}`
              : event.id;
        },
      ),
    ).size;
    if (count) counts[session.id] = count;
  }
  return counts;
}

/** Match the question popup, including waiting until a reply finishes streaming. */
export function pendingSessionQuestions(events: SessionEvent[]) {
  return latestChatQuestions(latestNativeTurnEvents(events));
}

export function sessionQuestionCounts(
  sessions: Session[],
  eventsBySessionId: Record<string, SessionEvent[]>,
  sendingSessionIds: string[] = [],
  resolvedQuestionIdsBySessionId: Record<string, string> = {},
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const session of sessions) {
    if (sendingSessionIds.includes(session.id)) continue;
    const request = pendingSessionQuestions(
      eventsBySessionId[session.id] ?? [],
    );
    if (request && request.id !== resolvedQuestionIdsBySessionId[session.id]) {
      counts[session.id] = request.questions.length;
    }
  }
  return counts;
}
