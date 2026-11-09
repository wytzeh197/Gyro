import type { SessionEvent } from "./types.ts";

const terminal = new Set(["completed", "failed", "denied", "cancelled"]);

function payload(event: SessionEvent): Record<string, unknown> {
  const value = event.payload;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function key(event: SessionEvent): string | undefined {
  const value = payload(event);
  if (
    value.kind !== "capability-call" ||
    (value.schema !== undefined && value.schema !== "gyro.capability.v1") ||
    typeof value.callId !== "string" ||
    !value.callId
  ) {
    return undefined;
  }
  return JSON.stringify([
    event.sessionId,
    event.turnId ?? value.turnId ?? "",
    value.callId,
  ]);
}

function clock(event: SessionEvent): number {
  return Date.parse(event.createdAt) || 0;
}

/** One projected row per call, including interleaved live updates and cold replay.
 * Keep the original position and latest result. A delayed start cannot reopen a
 * completed call. Raw durable events remain intact for inspection.
 */
export function reconcileCapabilityCalls(
  events: SessionEvent[],
): SessionEvent[] {
  const calls = new Map<
    string,
    { anchor: SessionEvent; latest: SessionEvent; slot: number }
  >();
  const result: SessionEvent[] = [];
  for (const event of events) {
    const identity = key(event);
    if (!identity) {
      result.push(event);
      continue;
    }
    let call = calls.get(identity);
    if (!call) {
      call = { anchor: event, latest: event, slot: result.length };
      calls.set(identity, call);
      result.push(event);
    } else {
      if (clock(event) < clock(call.anchor)) call.anchor = event;
      const prior = payload(call.latest);
      const next = payload(event);
      const priorTerminal = terminal.has(String(prior.status));
      const nextTerminal = terminal.has(String(next.status));
      if (
        (nextTerminal && !priorTerminal) ||
        (nextTerminal === priorTerminal && clock(event) >= clock(call.latest))
      ) {
        call.latest = {
          ...event,
          payload: {
            ...prior,
            ...next,
            ...(prior.inspection || next.inspection
              ? {
                  inspection: {
                    ...((prior.inspection as Record<string, unknown>) ?? {}),
                    ...((next.inspection as Record<string, unknown>) ?? {}),
                  },
                }
              : {}),
          },
        };
      }
    }
    const first = payload(call.anchor);
    const latest = payload(call.latest);
    result[call.slot] = {
      ...call.latest,
      id: call.anchor.id,
      createdAt: call.anchor.createdAt,
      payload: {
        ...latest,
        ...Object.fromEntries(
          [
            "timelineOrder",
            "timelineCreatedAt",
            "timelineSequence",
            "providerSequence",
          ]
            .filter((field) => first[field] !== undefined)
            .map((field) => [field, first[field]]),
        ),
      },
    };
  }
  return result;
}
