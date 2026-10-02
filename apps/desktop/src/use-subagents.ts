import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  mergeSubagentSnapshot,
  openSubagentTab,
  closeSubagentTab,
  pendingSubagentApprovals,
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
  readEvents: (sessionId: string) => Promise<void>;
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
  const [error, setError] = useState<string>();
  const loadedParents = useRef(new Set<string>());
  const loadedAgents = useRef(new Set<string>());
  const native =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const merge = useCallback((agent: SubagentSnapshot) => {
    setById((current) => ({
      ...current,
      [agent.agentId]: mergeSubagentSnapshot(current[agent.agentId], agent),
    }));
  }, []);
  const parentKey = [...new Set(parentIds)].sort().join("\n");
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
      void invoke<SubagentSnapshot[]>("list_subagents", { parentSessionId: id })
        .then((agents) => agents.forEach(merge))
        .catch((reason) => {
          loadedParents.current.delete(id);
          setError(`Could not load sub-agents: ${String(reason)}`);
        });
    }
  }, [merge, native, parentKey]);
  // Persisted lifecycle events also feed browser fixtures and refreshes. They
  // never override a newer live snapshot from the dedicated event channel.
  useEffect(() => {
    for (const events of Object.values(eventsBySessionId))
      for (const event of events) {
        const payload = event.payload as
          { kind?: string; agent?: SubagentSnapshot } | undefined;
        if (payload?.kind === "subagent-state" && payload.agent) {
          const agent = payload.agent;
          setById((current) => {
            const next = mergeSubagentSnapshot(current[agent.agentId], agent);
            return next === current[agent.agentId]
              ? current
              : { ...current, [agent.agentId]: next };
          });
        }
      }
  }, [eventsBySessionId]);
  useEffect(() => {
    for (const agent of Object.values(byId)) {
      if (loadedAgents.current.has(agent.agentId)) continue;
      loadedAgents.current.add(agent.agentId);
      void readEvents(agent.agentId);
    }
  }, [byId, readEvents]);
  const select = useCallback(
    (paneId: string, agentId: string, parentSessionId?: string) => {
      const key = `${paneId}:${parentSessionId ?? ""}`;
      setTabsByPane((current) => ({
        ...current,
        [key]: openSubagentTab(current[key] ?? { openAgentIds: [] }, agentId),
      }));
      openPanel(paneId);
      void readEvents(agentId);
    },
    [openPanel, readEvents],
  );
  const forPane = (
    parentSessionId: string | undefined,
    paneId: string,
  ): SubagentSurfaceState => {
    const key = `${paneId}:${parentSessionId ?? ""}`;
    const tabs = tabsByPane[key] ?? { openAgentIds: [] };
    const selectedAgentId = tabs.selectedAgentId;
    return {
      agents: Object.values(byId)
        .filter((agent) => agent.parentSessionId === parentSessionId)
        .map((agent) =>
          pendingSubagentApprovals(eventsBySessionId[agent.agentId] ?? [])
            .length && agent.status === "running"
            ? { ...agent, status: "waiting" }
            : agent,
        ),
      openAgentIds: tabs.openAgentIds,
      selectedAgentId,
      history: {
        hasMoreBefore: Boolean(hasMoreBeforeBySession[selectedAgentId ?? ""]),
        isLoadingEarlier: loadingEarlierSessionIds.includes(
          selectedAgentId ?? "",
        ),
        onLoadEarlier: () => {
          if (selectedAgentId) void loadEarlier(selectedAgentId);
        },
      },
      eventsByAgentId: eventsBySessionId,
      onSelect: (agentId) => select(paneId, agentId, parentSessionId),
      onClose: (agentId) => {
        const next = closeSubagentTab(tabs, agentId);
        setTabsByPane((current) => ({ ...current, [key]: next }));
        if (!next.openAgentIds.length) closePanel(paneId);
      },
      onStop: (agentId) => {
        if (!parentSessionId || !native) return;
        setError(undefined);
        void invoke<SubagentSnapshot>("stop_subagent", {
          parentSessionId,
          agentId,
        })
          .then(merge)
          .catch((reason) =>
            setError(`Could not stop agent: ${String(reason)}`),
          );
      },
      error,
    };
  };
  return { forPane, select };
}
