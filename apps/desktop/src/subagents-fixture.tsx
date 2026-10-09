// Development replay of delegation using the production chat and companion UI.
import React, { useEffect, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatSurface,
  applyAppearancePreferences,
  openSubagentTab,
  closeSubagentTab,
  chatCompanionReducer,
  chatCompanionPane,
  activeChatCompanionPanel,
  createInitialChatCompanionState,
  isChatCompanionTabId,
  type ChatSidePanelId,
  type SubagentTabState,
  type SubagentSnapshot,
  type SubagentSurfaceState,
  type SessionEvent,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const now = new Date().toISOString();
const parent = "parent";
const turn = "parent-turn";
const event = (
  sessionId: string,
  turnId: string,
  id: string,
  kind: SessionEvent["kind"],
  message: string,
  payload = {},
): SessionEvent => ({
  sessionId,
  turnId,
  id,
  kind,
  message,
  payload,
  createdAt: now,
});
const base: SubagentSnapshot = {
  agentId: "parser",
  parentSessionId: parent,
  parentTurnId: turn,
  name: "Parser implementation",
  task: "Update the parser in src/parser.ts and verify its tests. Own that file only.",
  providerId: "openai",
  modelId: "fixture",
  readOnly: false,
  status: "running",
  createdAt: now,
  updatedAt: now,
  startedAt: now,
  elapsedMs: 0,
  tokens: {
    inputTokens: 1200,
    outputTokens: 40,
    totalTokens: 1240,
    measured: true,
  },
  runId: "parser-run",
};
const initial = [
  base,
  {
    ...base,
    agentId: "review",
    name: "Behavior review",
    task: "Inspect the existing behavior and report edge cases.",
    runId: "review-run",
    readOnly: true,
    status: "completed",
    startedAt: null,
    elapsedMs: 23_000,
    tokens: { totalTokens: 3300, measured: false },
    summary: "Found two boundary cases. No files changed.",
  },
  {
    ...base,
    agentId: "tests",
    name: "Test verification",
    task: "Run the tests; report failures.",
    runId: "tests-run",
    status: "failed",
    startedAt: null,
    elapsedMs: 15_000,
    tokens: null,
    error: "Test provider disconnected.",
  },
] as SubagentSnapshot[];
const parentEvents = [
  event(
    parent,
    turn,
    "user",
    "user-message",
    "Implement the parser change and verify it with sub-agents.",
  ),
  event(parent, turn, "status", "system-event", "Working", {
    kind: "provider-status",
    status: "running",
  }),
  event(parent, turn, "search", "system-event", "Read parser tests", {
    kind: "provider-activity",
    activityId: "search",
    activityKind: "read",
    label: "Read parser tests",
    status: "done",
  }),
  ...initial.map((agent) =>
    event(parent, turn, agent.agentId, "system-event", "Agent launched", {
      kind: "subagent-state",
      agent,
    }),
  ),
];
const childEvents = [
  event("parser", "parser-run", "child-user", "user-message", base.task),
  event("parser", "parser-run", "child-status", "system-event", "Working", {
    kind: "provider-status",
    status: "running",
  }),
  event("parser", "parser-run", "read", "system-event", "Read parser", {
    kind: "provider-activity",
    activityId: "read",
    activityKind: "read",
    label: "Read src/parser.ts",
    status: "done",
  }),
];
function Fixture() {
  const [environmentOpen, setEnvironmentOpen] = useState(true);
  const params = new URLSearchParams(location.search);
  const [theme, setTheme] = useState<"dark" | "light">(
    params.get("theme") === "light" ? "light" : "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density =
      params.get("density") === "compact" ? "compact" : "comfortable";
    applyAppearancePreferences(
      document.documentElement,
      {
        interfaceSize:
          params.get("size") === "large"
            ? "large"
            : params.get("size") === "small"
              ? "small"
              : "default",
        mainColor: "#0874df",
        secondaryColor: "#8b6fcb",
        motionSpeed: "default",
      },
      theme,
    );
  }, [theme]);
  const [agents, setAgents] = useState(initial);
  const [tabs, setTabs] = useState<SubagentTabState>({ openAgentIds: [] });
  const [companion, dispatchCompanion] = useReducer(
    chatCompanionReducer,
    undefined,
    () => createInitialChatCompanionState(),
  );
  const panel = activeChatCompanionPanel(companion, "fixture");
  const setPanel = (panel?: ChatSidePanelId) => {
    if (panel && isChatCompanionTabId(panel)) {
      dispatchCompanion({ type: "open-tab", tab: panel, paneId: "fixture" });
    } else {
      dispatchCompanion({
        type: panel === "tools" ? "show-launcher" : "close-dock",
        paneId: "fixture",
      });
    }
  };
  const [draft, setDraft] = useState("");
  const [events, setEvents] = useState(childEvents);
  useEffect(() => {
    const timer = window.setInterval(
      () =>
        setAgents((current) =>
          current.map((agent) =>
            agent.agentId === "parser" && agent.status === "running"
              ? {
                  ...agent,
                  updatedAt: new Date().toISOString(),
                  tokens: {
                    totalTokens: (agent.tokens?.totalTokens ?? 0) + 25,
                    measured: true,
                  },
                }
              : agent,
          ),
        ),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  const state: SubagentSurfaceState = {
    agents,
    openAgentIds: tabs.openAgentIds,
    selectedAgentId: tabs.selectedAgentId,
    eventsByAgentId: { parser: events },
    onSelect: (id) => {
      setTabs((current) => openSubagentTab(current, id));
      setPanel("agents");
    },
    onClose: (id) => {
      const next = closeSubagentTab(tabs, id);
      setTabs(next);
      if (!next.openAgentIds.length)
        dispatchCompanion({
          type: "close-tab",
          tab: "agents",
          paneId: "fixture",
        });
    },
    onStop: (id) =>
      setAgents((current) =>
        current.map((agent) =>
          agent.agentId === id
            ? {
                ...agent,
                status: "cancelled",
                elapsedMs: Date.now() - Date.parse(now),
                startedAt: null,
              }
            : agent,
        ),
      ),
  };
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <nav style={{ padding: 8 }}>
        <button
          onClick={() =>
            setTheme((current) => (current === "dark" ? "light" : "dark"))
          }
        >
          {theme === "dark" ? "Light theme" : "Dark theme"}
        </button>
        <button
          onClick={() => {
            setPanel(undefined);
            setEnvironmentOpen(true);
          }}
        >
          Environment
        </button>
        <button
          onClick={() => {
            setAgents((current) =>
              current.map((agent) =>
                agent.agentId === "parser"
                  ? { ...agent, status: "waiting" }
                  : agent,
              ),
            );
            setEvents((current) => [
              ...current,
              event(
                "parser",
                "parser-run",
                "approval",
                "approval-requested",
                "Approve test",
                {
                  kind: "capability-approval",
                  approvalId: "approval",
                  capabilityId: "terminal-open",
                  status: "waiting",
                  scopeKind: "command",
                  scopeValue: "pnpm test",
                },
              ),
            ]);
          }}
        >
          Require approval
        </button>
        <button
          onClick={() =>
            setAgents((current) =>
              current.map((agent) =>
                agent.agentId === "parser"
                  ? {
                      ...agent,
                      status: "completed",
                      startedAt: null,
                      elapsedMs: Date.now() - Date.parse(now),
                      summary: "Parser updated; tests passed.",
                    }
                  : agent,
              ),
            )
          }
        >
          Complete agent
        </button>
      </nav>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <ChatSurface
          events={parentEvents}
          draft={draft}
          onDraftChange={setDraft}
          onSend={() => {}}
          config={{
            commandProfiles: [],
            modelProviders: [],
            requireCommandApproval: true,
            requireFileEditApproval: true,
            telemetryEnabled: false,
          }}
          isComposerSending
          subagents={state}
          activeChatPanel={
            panel ?? (environmentOpen ? "environment" : undefined)
          }
          isEnvironmentRailOpen={environmentOpen}
          companionTabs={chatCompanionPane(companion, "fixture").openTabs}
          onOpenCompanionTab={setPanel}
          onSelectChatPanel={setPanel}
          onCloseCompanionTab={(tab) =>
            dispatchCompanion({ type: "close-tab", tab, paneId: "fixture" })
          }
          onShowCompanionLauncher={() => setPanel("tools")}
          onCloseCompanionDock={() => setPanel(undefined)}
          onToggleEnvironmentRail={() =>
            setEnvironmentOpen((current) => !current)
          }
          onProviderApprovalAction={() => {
            setEvents((current) =>
              current.map((item) =>
                item.id === "approval"
                  ? {
                      ...item,
                      payload: {
                        ...(item.payload as object),
                        status: "approved",
                      },
                    }
                  : item,
              ),
            );
            setAgents((current) =>
              current.map((agent) =>
                agent.agentId === "parser"
                  ? { ...agent, status: "running" }
                  : agent,
              ),
            );
          }}
        />
      </div>
    </div>
  );
}
const root =
  import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<Fixture />);
