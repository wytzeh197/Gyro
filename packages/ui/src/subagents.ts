import type { SessionEvent } from "./types.ts";
import {
  formatTokenCount,
  turnTokensFromValue,
  turnTokensLabel,
  type TurnTokens,
  type UsageAccounting,
} from "./turn-tokens.ts";

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
    cacheWriteTokens?: number;
    reasoningOutputTokens?: number;
    measured?: boolean;
    accounting?: UsageAccounting;
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
  onStop?: (agentId: string) => void;
  stopRequest?: { pending?: boolean; error?: string };
  error?: string;
  errorDetail?: string;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  history?: {
    isLoading?: boolean;
    error?: string;
    onRetry?: () => void;
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

/** Identity colors stay the same in summaries, rows, and process tabs. */
export function subagentHue(agentId: string) {
  let hue = 0;
  for (const character of agentId)
    hue = (hue * 31 + character.charCodeAt(0)) % 360;
  return hue;
}

export function subagentsForStatus(
  agents: SubagentSnapshot[],
  view: "working" | "done",
) {
  return sortedSubagents(
    agents.filter((agent) => isSubagentLive(agent) === (view === "working")),
  );
}

/** Preview/draft chat IDs are renderer-only and cannot be queried natively. */
export function nativeSubagentParents(ids: string[]) {
  return [...new Set(ids)]
    .filter((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      ),
    )
    .sort();
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
  return tokens ? cumulativeAgentConsumptionLabel(tokens) : "Usage unavailable";
}

/** Agent snapshots aggregate Gyro's consumption ledger across agent followups. */
function cumulativeAgentConsumptionLabel(tokens: TurnTokens) {
  const accounting = tokens.accounting;
  // Session scope is valid here because the dedicated snapshot field contains
  // ledger consumption for this agent, rather than a provider session counter
  // or a single turn's usage. Keep that exception outside the turn formatter.
  if (accounting?.scope === "session") {
    if (
      accounting.source !== "provider" ||
      (accounting.coverage !== "complete" && accounting.coverage !== "partial")
    )
      return "Usage unavailable";
    return `${accounting.coverage === "partial" ? "≥" : ""}${formatTokenCount(tokens.totalTokens)} tokens total`;
  }
  const label = turnTokensLabel(tokens);
  return label === "Usage unavailable" ? label : `${label} total`;
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
    running: "Working",
    waiting: "Needs approval",
    stopping: "Stopping",
    completed: "Done",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
  }[status];
}

export function subagentStatusCounts(agents: SubagentSnapshot[]) {
  const counts = new Map<SubagentSnapshot["status"], number>();
  for (const { status } of agents)
    counts.set(status, (counts.get(status) ?? 0) + 1);
  const order = [
    "waiting",
    "failed",
    "interrupted",
    "running",
    "stopping",
    "completed",
    "cancelled",
  ] as const;
  return order.flatMap((status) => {
    const count = counts.get(status);
    if (!count) return [];
    const label =
      status === "waiting"
        ? count === 1
          ? "needs approval"
          : "need approval"
        : subagentStatusLabel(status).toLowerCase();
    return [{ status, count, label }];
  });
}

/** Live approval controls are scoped to the agent's current invocation. */
export function currentSubagentApprovals(
  agent: SubagentSnapshot,
  events: SessionEvent[],
) {
  if (agent.status !== "running" && agent.status !== "waiting") return [];
  return pendingSubagentApprovals(
    events.filter((event) => event.turnId === agent.runId),
  );
}

function approvalKey(event: SessionEvent) {
  const { kind, proposalId, approvalId } = (event.payload ?? {}) as Record<
    string,
    unknown
  >;
  const id = proposalId ?? approvalId;
  return id ? `${event.turnId ?? ""}:${kind ?? ""}:${id}` : undefined;
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
    (delta === 0 && !isSubagentLive(current) && isSubagentLive(incoming)) ||
    (current.runId === incoming.runId &&
      current.status === "stopping" &&
      (incoming.status === "running" || incoming.status === "waiting"))
  )
    return current;
  return incoming;
}

/** Reconcile durable tool/approval updates before rendering a child transcript. */
export function subagentProcessEvents(
  events: SessionEvent[],
  allowApprovals = true,
) {
  const decisions = new Map<string, Record<string, unknown>>();
  const calls = new Map<string, SessionEvent>();
  const anchors = new Map<string, string>();
  const renderedApprovals = new Set<string>();
  const payloadOf = (event: SessionEvent) =>
    (event.payload ?? {}) as Record<string, unknown>;
  for (const event of events) {
    const payload = payloadOf(event);
    if (
      [
        "mutation-approval",
        "provider-tool-approval",
        "capability-approval",
      ].includes(String(payload.kind)) &&
      payload.historical !== true &&
      payload.status &&
      !["pending", "waiting", "requested"].includes(String(payload.status))
    ) {
      const key = approvalKey(event);
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
    const key = approvalKey(event);
    const decision = key ? decisions.get(key) : undefined;
    if (
      event.kind === "approval-requested" &&
      !decision &&
      (!allowApprovals || payload.historical === true) &&
      ["pending", "waiting", "requested"].includes(
        String(payload.status ?? "pending"),
      )
    ) {
      return [];
    }
    if (
      event.kind === "approval-requested" &&
      key &&
      payload.historical !== true
    ) {
      if (renderedApprovals.has(key)) return [];
      renderedApprovals.add(key);
    }
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
