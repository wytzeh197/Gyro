import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  mergeSubagentSnapshot,
  openSubagentTab,
  closeSubagentTab,
  currentSubagentApprovals,
  isSubagentLive,
  nativeSubagentParents,
  type SubagentSnapshot,
  type SubagentSurfaceState,
  type SubagentTabState,
  type SessionEvent,
} from "@gyro-dev/ui";

export function useSubagents({
  parentIds,
  eventsBySessionId,
  readEvents,
  openPanel,
  closePanel,
  hasMoreBeforeBySession,
  loadingEarlierSessionIds,
  loadEarlier,
}: {
  parentIds: string[];
  eventsBySessionId: Record<string, SessionEvent[]>;
  readEvents: (
    sessionId: string,
    reportErrorToCaller?: boolean,
  ) => Promise<void>;
  openPanel: (paneId: string) => void;
  closePanel: (paneId: string) => void;
  hasMoreBeforeBySession: Record<string, boolean>;
  loadingEarlierSessionIds: string[];
  loadEarlier: (sessionId: string) => Promise<void>;
}) {
  const [byId, setById] = useState<Record<string, SubagentSnapshot>>({});
  const [tabsByPane, setTabsByPane] = useState<
    Record<string, SubagentTabState>
  >({});
  const [errors, setErrors] = useState<
    Record<string, { message: string; detail: string } | undefined>
  >({});
  const [refreshing, setRefreshing] = useState<string[]>([]);
  const [historyReads, setHistoryReads] = useState<
    Record<string, { isLoading?: boolean; error?: string } | undefined>
  >({});
  const [stopRequests, setStopRequests] = useState<
    Record<
      string,
      { runId: string; pending?: boolean; error?: string } | undefined
    >
  >({});
  const inFlight = useRef(new Set<string>());
  const loadedParents = useRef(new Set<string>());
  const historyRequested = useRef(new Set<string>());
  const historyInFlight = useRef(new Set<string>());
  const stopInFlight = useRef(new Set<string>());
  const observedHistory = useRef(new Map<string, SessionEvent[]>());
  const native =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const merge = useCallback((agent: SubagentSnapshot) => {
    setById((current) => {
      const next = mergeSubagentSnapshot(current[agent.agentId], agent);
      return next === current[agent.agentId]
        ? current
        : { ...current, [agent.agentId]: next };
    });
  }, []);
  const parentKey = nativeSubagentParents(parentIds).join("\n");
  const refresh = useCallback(
    async (id: string) => {
      if (
        !native ||
        !nativeSubagentParents([id]).length ||
        inFlight.current.has(id)
      )
        return;
      inFlight.current.add(id);
      setRefreshing((current) => [...current, id]);
      try {
        const agents = await invoke<SubagentSnapshot[]>("list_subagents", {
          parentSessionId: id,
        });
        agents.forEach(merge);
        loadedParents.current.add(id);
        setErrors((current) => ({ ...current, [id]: undefined }));
      } catch (reason) {
        loadedParents.current.delete(id);
        setErrors((current) => ({
          ...current,
          [id]: {
            message: "Could not refresh sub-agents.",
            detail: String(reason),
          },
        }));
      } finally {
        inFlight.current.delete(id);
        setRefreshing((current) => current.filter((parent) => parent !== id));
      }
    },
    [merge, native],
  );
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<SubagentSnapshot>("gyro://subagent-event", ({ payload }) => {
      if (!disposed) merge(payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [merge, native]);
  useEffect(() => {
    if (!native) return;
    for (const id of parentKey.split("\n").filter(Boolean)) {
      if (loadedParents.current.has(id)) continue;
      loadedParents.current.add(id);
      void refresh(id);
    }
  }, [refresh, native, parentKey]);
  // Persisted lifecycle events also feed browser fixtures and refreshes. They
  // never override a newer live snapshot from the dedicated event channel.
  useEffect(() => {
    const updates: SubagentSnapshot[] = [];
    for (const id of observedHistory.current.keys())
      if (!(id in eventsBySessionId)) observedHistory.current.delete(id);
    for (const [id, events] of Object.entries(eventsBySessionId)) {
      if (observedHistory.current.get(id) === events) continue;
      observedHistory.current.set(id, events);
      for (const event of events) {
        const payload = event.payload as
          { kind?: string; agent?: SubagentSnapshot } | undefined;
        if (payload?.kind === "subagent-state" && payload.agent)
          updates.push(payload.agent);
      }
    }
    if (!updates.length) return;
    // One state update for changed histories. Unrelated streaming chats no
    // longer replay every saved sub-agent event through React's update queue.
    setById((current) => {
      let result = current;
      for (const agent of updates) {
        const next = mergeSubagentSnapshot(result[agent.agentId], agent);
        if (next === result[agent.agentId]) continue;
        if (result === current) result = { ...current };
        result[agent.agentId] = next;
      }
      return result;
    });
  }, [eventsBySessionId]);
  const readHistory = useCallback(
    async (agentId: string) => {
      if (historyInFlight.current.has(agentId)) return;
      historyInFlight.current.add(agentId);
      const firstRead = !historyRequested.current.has(agentId);
      historyRequested.current.add(agentId);
      setHistoryReads((current) =>
        firstRead || current[agentId]?.error
          ? { ...current, [agentId]: { isLoading: true } }
          : current,
      );
      try {
        await readEvents(agentId, true);
        setHistoryReads((current) => ({ ...current, [agentId]: undefined }));
      } catch (reason) {
        setHistoryReads((current) => ({
          ...current,
          [agentId]: { error: String(reason) },
        }));
      } finally {
        historyInFlight.current.delete(agentId);
      }
    },
    [readEvents],
  );
  useEffect(() => {
    for (const agent of Object.values(byId)) {
      if (isSubagentLive(agent) && !historyRequested.current.has(agent.agentId))
        void readHistory(agent.agentId);
    }
  }, [byId, readHistory]);
  const select = useCallback(
    (paneId: string, agentId: string, parentSessionId: string) => {
      const key = `${paneId}:${parentSessionId}`;
      setTabsByPane((current) => ({
        ...current,
        [key]: openSubagentTab(current[key] ?? { openAgentIds: [] }, agentId),
      }));
      openPanel(paneId);
      void readHistory(agentId);
    },
    [openPanel, readHistory],
  );
  const forPane = (
    parentSessionId: string | undefined,
    paneId: string,
  ): SubagentSurfaceState => {
    const key = `${paneId}:${parentSessionId ?? ""}`;
    const tabs = tabsByPane[key] ?? { openAgentIds: [] };
    const selectedAgentId = tabs.selectedAgentId;
    const selectedAgent = selectedAgentId ? byId[selectedAgentId] : undefined;
    const stopRequest = selectedAgentId
      ? stopRequests[selectedAgentId]
      : undefined;
    return {
      agents: Object.values(byId)
        .filter((agent) => agent.parentSessionId === parentSessionId)
        .map((agent) =>
          agent.status === "running" &&
          currentSubagentApprovals(
            agent,
            eventsBySessionId[agent.agentId] ?? [],
          ).length
            ? { ...agent, status: "waiting" }
            : agent,
        ),
      openAgentIds: tabs.openAgentIds,
      selectedAgentId,
      history: {
        ...(selectedAgentId ? historyReads[selectedAgentId] : undefined),
        onRetry: selectedAgentId
          ? () => void readHistory(selectedAgentId)
          : undefined,
        hasMoreBefore: Boolean(hasMoreBeforeBySession[selectedAgentId ?? ""]),
        isLoadingEarlier: loadingEarlierSessionIds.includes(
          selectedAgentId ?? "",
        ),
        onLoadEarlier: () => {
          if (selectedAgentId) void loadEarlier(selectedAgentId);
        },
      },
      eventsByAgentId: eventsBySessionId,
      onSelect: (agentId) => {
        if (parentSessionId) select(paneId, agentId, parentSessionId);
      },
      onClose: (agentId) => {
        const next = closeSubagentTab(tabs, agentId);
        setTabsByPane((current) => ({ ...current, [key]: next }));
        if (!next.openAgentIds.length) closePanel(paneId);
      },
      stopRequest:
        stopRequest && stopRequest.runId === selectedAgent?.runId
          ? stopRequest
          : undefined,
      onStop:
        native && parentSessionId
          ? (agentId) => {
              const agent = byId[agentId];
              if (
                !agent ||
                !isSubagentLive(agent) ||
                agent.status === "stopping" ||
                agent.parentSessionId !== parentSessionId ||
                stopInFlight.current.has(agentId)
              )
                return;
              stopInFlight.current.add(agentId);
              const runId = agent.runId;
              setStopRequests((current) => ({
                ...current,
                [agentId]: { runId, pending: true },
              }));
              void invoke<SubagentSnapshot>("stop_subagent", {
                parentSessionId,
                agentId,
              })
                .then((snapshot) => {
                  merge(snapshot);
                  setStopRequests((current) => ({
                    ...current,
                    [agentId]: undefined,
                  }));
                })
                .catch((reason) =>
                  setStopRequests((current) => ({
                    ...current,
                    [agentId]: { runId, error: String(reason) },
                  })),
                )
                .finally(() => stopInFlight.current.delete(agentId));
            }
          : undefined,
      error: errors[parentSessionId ?? ""]?.message,
      errorDetail: errors[parentSessionId ?? ""]?.detail,
      isRefreshing: refreshing.includes(parentSessionId ?? ""),
      onRefresh:
        native &&
        parentSessionId &&
        nativeSubagentParents([parentSessionId]).length
          ? () => {
              void refresh(parentSessionId);
            }
          : undefined,
    };
  };
  return { forPane, select };
}
