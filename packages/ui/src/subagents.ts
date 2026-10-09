import type { SessionEvent } from "./types.ts";
import { turnTokensFromValue } from "./turn-tokens.ts";

export type SubagentSnapshot = {
  agentId: string;
  parentSessionId: string;
  parentTurnId?: string | null;
  name: string;
  task: string;
  providerId: string;
  modelId?: string | null;
  readOnly: boolean;
  status:
    | "running"
    | "waiting"
    | "stopping"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  elapsedMs: number;
  tokens?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
    measured?: boolean;
  } | null;
  runId: string;
  summary?: string | null;
  error?: string | null;
};

export type SubagentSurfaceState = {
  agents: SubagentSnapshot[];
  openAgentIds?: string[];
  selectedAgentId?: string;
  eventsByAgentId: Record<string, SessionEvent[]>;
  onSelect: (agentId: string) => void;
  /** Closes the process tab without stopping the agent. */
  onClose?: (agentId: string) => void;
  onStop: (agentId: string) => void;
  error?: string;
  history?: {
    hasMoreBefore: boolean;
    isLoadingEarlier: boolean;
    onLoadEarlier: () => void;
  };
};

export type SubagentTabState = {
  openAgentIds: string[];
  selectedAgentId?: string;
};

export function openSubagentTab(
  state: SubagentTabState,
  agentId: string,
): SubagentTabState {
  return {
    openAgentIds: state.openAgentIds.includes(agentId)
      ? state.openAgentIds
      : [...state.openAgentIds, agentId],
    selectedAgentId: agentId,
  };
}

export function closeSubagentTab(
  state: SubagentTabState,
  agentId: string,
): SubagentTabState {
  const index = state.openAgentIds.indexOf(agentId);
  if (index < 0) return state;
  const openAgentIds = state.openAgentIds.filter((id) => id !== agentId);
  return {
    openAgentIds,
    selectedAgentId:
      state.selectedAgentId === agentId
        ? openAgentIds[Math.max(0, index - 1)]
        : state.selectedAgentId,
  };
}

export function isSubagentLive(agent: SubagentSnapshot) {
  return ["running", "waiting", "stopping"].includes(agent.status);
}

export function subagentElapsedMs(agent: SubagentSnapshot, now: number) {
  const start = agent.startedAt ? Date.parse(agent.startedAt) : NaN;
  return (
    Math.max(0, agent.elapsedMs) +
    (isSubagentLive(agent) && Number.isFinite(start)
      ? Math.max(0, now - start)
      : 0)
  );
}

export function subagentTokensLabel(agent: SubagentSnapshot) {
  const tokens = turnTokensFromValue(agent.tokens);
  return tokens
    ? `${tokens.measured === false ? "~" : ""}${tokens.totalTokens.toLocaleString()} tokens`
    : "Usage unavailable";
}

export function sortedSubagents(agents: SubagentSnapshot[]) {
  const priority: Record<SubagentSnapshot["status"], number> = {
    waiting: 0,
    failed: 1,
    interrupted: 2,
    running: 3,
    stopping: 4,
    cancelled: 5,
    completed: 6,
  };
  return [...agents].sort(
    (a, b) =>
      priority[a.status] - priority[b.status] ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.agentId.localeCompare(b.agentId),
  );
}

export function subagentStatusLabel(status: SubagentSnapshot["status"]) {
  return {
    running: "Running",
    waiting: "Needs approval",
    stopping: "Stopping",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
  }[status];
}

export function subagentActivitySummary(agents: SubagentSnapshot[]) {
  const count = (statuses: SubagentSnapshot["status"][]) =>
    agents.filter((agent) => statuses.includes(agent.status)).length;
  const waiting = count(["waiting"]);
  const failed = count(["failed", "interrupted"]);
  const parts = [
    waiting ? `${waiting} ${waiting === 1 ? "needs" : "need"} approval` : "",
    failed ? `${failed} ${failed === 1 ? "needs" : "need"} attention` : "",
    count(["running"]) ? `${count(["running"])} running` : "",
    count(["stopping"]) ? `${count(["stopping"])} stopping` : "",
  ].filter(Boolean);
  if (!parts.length) {
    if (count(["completed"])) parts.push(`${count(["completed"])} completed`);
    if (count(["cancelled"])) parts.push(`${count(["cancelled"])} cancelled`);
  }
  return {
    label: parts.join(" · "),
    needsAttention: waiting > 0 || failed > 0,
  };
}

export function pendingSubagentApprovals(events: SessionEvent[]) {
  return subagentProcessEvents(events).filter((event) => {
    if (event.kind !== "approval-requested") return false;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload?.historical === true) return false;
    return ["pending", "waiting", "requested"].includes(
      String(payload?.status ?? "pending"),
    );
  });
}

export function mergeSubagentSnapshot(
  current: SubagentSnapshot | undefined,
  incoming: SubagentSnapshot,
) {
  if (!current) return incoming;
  // Snapshot timestamps arbitrate reload/event races; a settled snapshot wins
  // ties so a delayed started event cannot restart a completed stopwatch.
  const delta = Date.parse(incoming.updatedAt) - Date.parse(current.updatedAt);
  if (
    delta < 0 ||
    (delta === 0 && !isSubagentLive(current) && isSubagentLive(incoming))
  )
    return current;
  return incoming;
}

/** Reconcile durable tool/approval updates before rendering a child transcript. */
export function subagentProcessEvents(events: SessionEvent[]) {
  const decisions = new Map<string, Record<string, unknown>>();
  const calls = new Map<string, SessionEvent>();
  const anchors = new Map<string, string>();
  const payloadOf = (event: SessionEvent) =>
    (event.payload ?? {}) as Record<string, unknown>;
  const approvalKey = (payload: Record<string, unknown>) =>
    payload.proposalId
      ? `proposal:${payload.proposalId}`
      : payload.approvalId
        ? `approval:${payload.approvalId}`
        : undefined;
  for (const event of events) {
    const payload = payloadOf(event);
    if (
      [
        "mutation-approval",
        "provider-tool-approval",
        "capability-approval",
      ].includes(String(payload.kind)) &&
      payload.status &&
      !["pending", "waiting", "requested"].includes(String(payload.status))
    ) {
      const key = approvalKey(payload);
      if (key) decisions.set(key, payload);
    }
    if (payload.kind === "capability-call" && payload.callId) {
      const key = String(payload.callId);
      calls.set(key, event);
      if (!anchors.has(key)) anchors.set(key, event.id);
    }
  }
  return events.flatMap((event) => {
    const payload = payloadOf(event);
    if (
      ["user-message", "session-created", "file-edit-proposed"].includes(
        event.kind,
      )
    )
      return [];
    if (
      event.kind === "system-event" &&
      !["provider-activity", "capability-call", "file-review"].includes(
        String(payload.kind),
      ) &&
      payload.status !== "applied"
    )
      return [];
    if (payload.kind === "capability-call" && payload.callId) {
      const key = String(payload.callId);
      return anchors.get(key) === event.id
        ? [{ ...event, payload: calls.get(key)!.payload }]
        : [];
    }
    const key = approvalKey(payload);
    const decision = key ? decisions.get(key) : undefined;
    return [
      {
        ...event,
        payload: decision
          ? { ...payload, status: decision.status, error: decision.error }
          : event.payload,
      },
    ];
  });
}
