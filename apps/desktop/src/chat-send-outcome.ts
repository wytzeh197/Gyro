/** Delivery and provider completion are distinct: a saved failed turn must
 * never become another queued copy of the same user instruction. */
export type ChatSendOutcome = {
  kind: "completed" | "queued" | "not-started" | "failed" | "cancelled";
  persisted: boolean;
  sessionId?: string;
  turnId?: string;
  reason?: "busy" | "precondition";
};

export function chatSendAccepted(outcome: ChatSendOutcome): boolean {
  return ["completed", "queued", "cancelled"].includes(outcome.kind);
}

/** Steer explicitly authorizes the next queued instruction after cancellation.
 * Saving the interrupted turn must not turn that handoff into a queue pause. */
export function shouldPauseQueueAfterSendError(
  persisted: boolean,
  cancelled: boolean,
  steering: boolean,
): boolean {
  return !steering && (persisted || cancelled);
}

export function queuedDeliveryDisposition(outcome: ChatSendOutcome) {
  if (outcome.persisted || ["completed", "cancelled"].includes(outcome.kind))
    return "settled" as const;
  return outcome.reason === "busy" ? ("waiting" as const) : ("failed" as const);
}
