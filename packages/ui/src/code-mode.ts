import type { SessionEvent } from "./types.ts";

export type WorkflowOutcome = {
  ok?: boolean;
  value?: unknown;
  warnings?: unknown[];
  error?: { kind?: string; message?: string };
  truncated?: boolean;
  incomplete?: boolean;
};
export type WorkflowDetails = {
  label: string;
  source: string;
  outcome?: {
    outcome?: WorkflowOutcome;
    completed?: number;
    partial?: boolean;
    calls?: unknown[];
  };
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
export function workflowDetails(
  event: SessionEvent,
): WorkflowDetails | undefined {
  const payload = object(event.payload);
  const details = object(payload?.codeMode);
  if (
    payload?.kind !== "capability-call" ||
    payload.capabilityId !== "code-mode-execute" ||
    !details
  )
    return undefined;
  return {
    label:
      typeof details.label === "string"
        ? details.label.slice(0, 100)
        : "Inspecting workspace",
    source:
      typeof details.source === "string" ? details.source.slice(0, 16384) : "",
    outcome: object(details.outcome) as WorkflowDetails["outcome"],
  };
}
export function workflowChildren(event: SessionEvent): SessionEvent[] {
  const children = object(event.payload)?.workflowChildren;
  return Array.isArray(children) ? (children as SessionEvent[]) : [];
}
function key(event: SessionEvent, id: string) {
  return JSON.stringify([event.sessionId, event.turnId, id]);
}
function latest(previous: SessionEvent | undefined, event: SessionEvent) {
  if (!previous) return event;
  const terminal = (item: SessionEvent) =>
    ["completed", "failed", "denied", "cancelled", "inactive"].includes(
      String(object(item.payload)?.status),
    );
  if (terminal(previous) && !terminal(event)) return previous;
  if (!terminal(previous) && terminal(event)) return event;
  return Date.parse(previous.createdAt) > Date.parse(event.createdAt)
    ? previous
    : event;
}
function receiptEvents(event: SessionEvent): SessionEvent[] {
  const names: Record<string, string> = {
    gyro_workspace_list: "workspace-list",
    gyro_workspace_search: "workspace-search",
    gyro_workspace_read: "workspace-read",
    gyro_workspace_read_range: "workspace-read-range",
  };
  const details = workflowDetails(event);
  const calls = details?.outcome?.calls;
  if (!Array.isArray(calls)) return [];
  return calls.slice(0, 32).flatMap((value) => {
    const call = object(value);
    if (
      !call ||
      typeof call.callId !== "string" ||
      typeof call.name !== "string" ||
      !names[call.name]
    )
      return [];
    return [
      {
        ...event,
        id: event.id + ":" + call.callId,
        message: String(call.summary ?? call.name),
        payload: {
          ...object(event.payload),
          codeMode: undefined,
          callId: call.callId,
          capabilityId: names[call.name],
          groupId: object(event.payload)?.callId,
          status: call.status,
          summary: call.summary,
          resource: call.resource,
          durationMs: call.durationMs,
        },
      },
    ];
  });
}
/** Collapse explicit workflow membership only; orphan/paged children remain visible. */
export function groupWorkflowEvents(
  events: SessionEvent[],
  runStatus?: string,
): SessionEvent[] {
  const parents = new Map<string, SessionEvent>();
  const children = new Map<string, Map<string, SessionEvent>>();
  for (const event of events) {
    const payload = object(event.payload);
    if (workflowDetails(event) && typeof payload?.callId === "string")
      parents.set(
        key(event, payload.callId),
        latest(parents.get(key(event, payload.callId)), event),
      );
    if (
      payload?.kind === "capability-call" &&
      typeof payload.groupId === "string" &&
      typeof payload.callId === "string"
    ) {
      const group = children.get(key(event, payload.groupId)) ?? new Map();
      group.set(payload.callId, latest(group.get(payload.callId), event));
      children.set(key(event, payload.groupId), group);
    }
  }
  const emitted = new Set<string>();
  return events.flatMap((event) => {
    const payload = object(event.payload);
    if (
      payload?.kind === "capability-call" &&
      typeof payload.groupId === "string" &&
      parents.has(key(event, payload.groupId))
    )
      return [];
    if (workflowDetails(event) && typeof payload?.callId === "string") {
      const groupKey = key(event, payload.callId);
      if (emitted.has(groupKey)) return [];
      emitted.add(groupKey);
      const parentEvent = parents.get(groupKey)!;
      const terminalRun = ["done", "failed", "cancelled", "blocked"].includes(
        runStatus ?? "",
      );
      const memberMap = new Map<string, SessionEvent>();
      for (const child of receiptEvents(parentEvent))
        memberMap.set(String(object(child.payload)?.callId), child);
      for (const child of children.has(groupKey)
        ? [...children.get(groupKey)!.values()]
        : workflowChildren(parentEvent)) {
        const id = String(object(child.payload)?.callId);
        const receipt = memberMap.get(id);
        const current = latest(receipt, child);
        memberMap.set(id, {
          ...current,
          payload: {
            ...object(current.payload),
            durationMs:
              object(receipt?.payload)?.durationMs ??
              object(child.payload)?.durationMs,
          },
        });
      }
      const members = [...memberMap.values()];
      const interrupted =
        terminalRun &&
        ["requested", "waiting", "running"].includes(
          String(object(parentEvent.payload)?.status),
        );
      return [
        {
          ...event,
          payload: {
            ...object(parentEvent.payload),
            ...(interrupted ? { status: "inactive" } : {}),
            workflowChildren: members.map((child) => ({
              ...child,
              payload: {
                ...object(child.payload),
                ...(interrupted &&
                ["requested", "waiting", "running"].includes(
                  String(object(child.payload)?.status),
                )
                  ? { status: "inactive" }
                  : {}),
              },
            })),
          },
        },
      ];
    }
    return [event];
  });
}
export function workflowState(event: SessionEvent) {
  const payload = object(event.payload);
  const children = workflowChildren(event);
  const details = workflowDetails(event);
  const outcome = details?.outcome?.outcome;
  const status = String(payload?.status ?? "running");
  const counts = { completed: 0, failed: 0, denied: 0, running: 0 };
  for (const child of children) {
    const state = object(child.payload)?.status;
    if (state === "completed") counts.completed++;
    else if (state === "denied") counts.denied++;
    else if (state === "failed") counts.failed++;
    else if (["requested", "waiting", "running"].includes(String(state)))
      counts.running++;
  }
  const waiting = children.some(
    (child) => object(child.payload)?.status === "waiting",
  );
  const busy = ["requested", "waiting", "running"].includes(status);
  const partial =
    details?.outcome?.partial ||
    counts.failed > 0 ||
    counts.denied > 0 ||
    outcome?.incomplete;
  const label =
    status === "inactive"
      ? "Interrupted"
      : status === "cancelled" || outcome?.error?.kind === "Cancelled"
        ? "Cancelled"
        : busy
          ? waiting || status === "waiting"
            ? "Waiting for approval"
            : "Working"
          : status === "denied"
            ? "Denied"
            : partial
              ? counts.completed
                ? "Partial"
                : "Failed"
              : status === "failed" || outcome?.ok === false
                ? "Failed"
                : "Done";
  return { label, busy, counts, outcome };
}
