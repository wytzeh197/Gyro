// Standalone production-component fixtures. All actions use local sample state.
import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppChrome,
  ChatFileActionsContext,
  ChatGridSurface,
  ChatSurface,
  chatGridReducer,
  createChatProjectLayout,
  providersForConfig,
  type ChatGridAction,
  type ChatGridState,
  type ChatPaneRef,
  type GyroConfig,
  type Session,
  type SessionEvent,
} from "@gyro-dev/ui";
import screenshot from "../../../site/assets/screenshots/current-chat-dark.webp";
import "@gyro-dev/ui/styles.css";
import "./ui-upgrade-fixture.css";

type Scenario =
  "completed" | "running" | "approval" | "failed" | "attachments" | "welcome";
const projectKey = "/fixture/Gyro";
const firstPane: ChatPaneRef = {
  kind: "session",
  paneId: "main",
  sessionId: "main",
  workspacePath: projectKey,
};
const empty: GyroConfig = {
  commandProfiles: [],
  modelProviders: [],
  requireCommandApproval: true,
  requireFileEditApproval: true,
  telemetryEnabled: false,
};
const config: GyroConfig = {
  ...empty,
  selectedProviderId: "openai",
  modelProviders: providersForConfig(empty).map((p) =>
    p.id === "openai" ? { ...p, enabled: true, authStatus: "connected" } : p,
  ),
};
const sessions: Session[] = [
  "UI Upgrade",
  "Review Workspace Changes",
  "Long Conversation Title With Important Project Context",
].map((title, i) => ({
  id: String(i),
  title,
  workspacePath: projectKey,
  origin: "desktop",
  createdAt: "2026-10-10T10:00:00Z",
  updatedAt: "2026-10-10T10:00:00Z",
  eventsPath: "/fixture/events.jsonl",
}));
const start = Date.now() - 12_000;
function event(
  id: string,
  kind: SessionEvent["kind"],
  message: string,
  payload: Record<string, unknown> = {},
): SessionEvent {
  return {
    id,
    kind,
    message,
    payload,
    sessionId: "main",
    turnId: "turn",
    createdAt: new Date(
      start + Number(payload.timelineSequence ?? 0) * 1000,
    ).toISOString(),
  };
}
function eventsFor(scenario: Scenario): SessionEvent[] {
  if (scenario === "welcome") return [];
  const images = [
    {
      id: "screenshot",
      kind: "image",
      name: "Screenshot.png",
      path: "/fixture/screenshot.png",
      size: 24000,
      previewUrl: screenshot,
    },
    {
      id: "unavailable",
      kind: "image",
      name: "Unavailable screenshot.png",
      path: "/fixture/missing.png",
      size: 1000,
      available: false,
    },
    {
      id: "document",
      kind: "workspace-file",
      name: "UI upgrade plan.pdf",
      path: "/fixture/plan.pdf",
      size: 44000,
    },
  ];
  const user = event(
    "user",
    "user-message",
    scenario === "attachments"
      ? "Compare these screenshots and keep unavailable files understandable."
      : "Polish the chat layout and make the interface easier to scan.",
    { attachments: scenario === "attachments" ? images : [images[0]] },
  );
  if (scenario === "approval")
    return [
      user,
      event("approval", "approval-requested", "Update the chat stylesheet", {
        schema: "gyro.mutation.v1",
        kind: "mutation-approval",
        proposalId: "fixture-edit",
        path: "src/chat.css",
        operation: "update",
        status: "pending",
        timelineSequence: 1,
      }),
    ];
  const work = event("read", "system-event", "Read chat styles", {
    kind: "provider-activity",
    activityKind: "read",
    activityId: "read",
    path: "src/chat.css",
    label: "Read chat styles",
    status: "done",
    timelineSequence: 1,
  });
  if (scenario === "running")
    return [
      user,
      work,
      event(
        "say",
        "assistant-message",
        "I found the spacing rules. I’m checking the narrow layout next.",
        { kind: "provider-commentary", timelineSequence: 2 },
      ),
      event("check", "system-event", "Checking layouts", {
        kind: "provider-activity",
        activityKind: "command",
        activityId: "check",
        command: "pnpm test:layout",
        status: "running",
        timelineSequence: 3,
      }),
      event("live", "system-event", "Working", {
        kind: "provider-status",
        status: "running",
        timelineSequence: 4,
      }),
    ];
  if (scenario === "failed")
    return [
      user,
      work,
      event(
        "failed",
        "system-event",
        "The provider disconnected. Retry to continue this task.",
        { kind: "provider-status", status: "failed", timelineSequence: 2 },
      ),
    ];
  return [
    user,
    work,
    event("file", "system-event", "Updated src/chat.css", {
      kind: "provider-activity",
      activityKind: "file",
      activityId: "file",
      path: "src/chat.css",
      status: "done",
      timelineSequence: 2,
    }),
    event("receipt", "system-event", "Applied stylesheet update", {
      schema: "gyro.mutation.v1",
      kind: "mutation-approval",
      proposalId: "fixture-edit",
      status: "applied",
      fileChanges: [{ path: "src/chat.css", additions: 24, deletions: 8 }],
      timelineSequence: 3,
    }),
    event(
      "answer",
      "assistant-message",
      "The layout is ready for review.\n\n- User messages fit their content.\n- Screenshots open from compact thumbnails.\n- The composer stays reachable in a split pane.",
      { kind: "provider-response", status: "done", timelineSequence: 4 },
    ),
    event("done", "system-event", "Finished", {
      kind: "provider-status",
      status: "done",
      durationMs: 12000,
      timelineSequence: 5,
    }),
  ];
}
function initial(): ChatGridState {
  return {
    activeProjectKey: projectKey,
    layouts: { [projectKey]: createChatProjectLayout(projectKey, firstPane) },
  };
}
function Fixture() {
  const query = new URLSearchParams(location.search);
  const [theme, setTheme] = useState(query.get("theme") ?? "light");
  const [size, setSize] = useState(query.get("size") ?? "default");
  const [scenario, setScenario] = useState<Scenario>(
    (query.get("scenario") as Scenario) ?? "completed",
  );
  const [width, setWidth] = useState(Number(query.get("width") ?? 1440));
  const [sidebar, setSidebar] = useState(query.get("sidebar") !== "off");
  const [reduced, setReduced] = useState(false);
  const [grid, setGrid] = useState(initial);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [environment, setEnvironment] = useState<string>();
  const [action, setAction] = useState(
    "Sample data · no provider or native actions",
  );
  const layout =
    grid.layouts[projectKey] ?? createChatProjectLayout(projectKey);
  const dispatch = (a: ChatGridAction) => setGrid((g) => chatGridReducer(g, a));
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.interfaceSize = size;
    document.documentElement.dataset.fixtureReducedMotion = String(reduced);
  }, [theme, size, reduced]);
  const newChat = () => {
    setScenario("welcome");
    setGrid({
      activeProjectKey: projectKey,
      layouts: { [projectKey]: createChatProjectLayout(projectKey) },
    });
  };
  const split = () =>
    dispatch({
      type: "select-pane",
      projectKey,
      mode: "drop",
      slotIndex: 0,
      insertPosition: "after",
      splitDirection: "horizontal",
      arrangement: "columns",
      pane: {
        kind: "draft",
        paneId: "draft",
        draftKey: "draft",
        workspacePath: projectKey,
      },
    });
  const renderChat = (pane?: ChatPaneRef, isTiled = false) => {
    const key = pane?.paneId ?? "new";
    const state = pane?.kind === "draft" ? "welcome" : scenario;
    return (
      <ChatSurface
        config={config}
        events={eventsFor(state).map((e) => ({
          ...e,
          sessionId: pane?.kind === "session" ? pane.sessionId : key,
        }))}
        paneKey={key}
        isTiled={isTiled}
        sessionTitle={
          pane?.kind === "draft"
            ? "Previous title must not leak"
            : "Gyro UI Upgrade"
        }
        workspacePath={projectKey}
        branchName="v0.1.0"
        shellReady
        sessionModel={{
          providerId: "openai",
          modelId: "gpt-6.1-sol",
          modelLabel: "GPT-6.1 Sol",
          reasoningEffort: "high",
        }}
        draft={drafts[key] ?? ""}
        onDraftChange={(v) => setDrafts((d) => ({ ...d, [key]: v }))}
        isComposerSending={state === "running"}
        onSend={() => setAction("Fixture send received")}
        onStopChat={() => setScenario("completed")}
        onCloseChat={
          pane
            ? () =>
                dispatch({
                  type: "close-pane",
                  projectKey,
                  paneId: pane.paneId,
                })
            : undefined
        }
        onComposerAction={setAction}
        onMutationApprovalAction={() => setScenario("completed")}
        onProviderStatusAction={() => setScenario("running")}
        isEnvironmentRailOpen={environment === key}
        onToggleEnvironmentRail={() =>
          setEnvironment((v) => (v === key ? undefined : key))
        }
      />
    );
  };
  const chat = (
    <ChatGridSurface
      key={scenario}
      layout={layout}
      maximizedPaneId={grid.maximizedPaneId}
      onFocusPane={(p) =>
        dispatch({ type: "focus-pane", projectKey, paneId: p.paneId })
      }
      onMovePane={(paneId, slotIndex) =>
        dispatch({ type: "move-pane", projectKey, paneId, slotIndex })
      }
      onToggleMaximize={(paneId) =>
        dispatch({ type: "toggle-maximize-pane", paneId })
      }
      onDropSession={() => setAction("Fixture drop received")}
      renderPane={(p, o) => renderChat(p, o.isTiled)}
    >
      {renderChat()}
    </ChatGridSurface>
  );
  return (
    <ChatFileActionsContext.Provider
      value={{
        preview: async (p) => (p.includes("missing") ? undefined : screenshot),
        open: (p) => setAction("Fixture file: " + p),
      }}
    >
      <main className="upgrade-fixture">
        <nav
          className="upgrade-fixture-controls"
          aria-label="UI upgrade fixtures"
        >
          <strong>UI upgrade · fixtures</strong>
          <label>
            Theme{" "}
            <select
              aria-label="Fixture theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              <option>light</option>
              <option>dark</option>
            </select>
          </label>
          <label>
            Size{" "}
            <select
              aria-label="Fixture interface size"
              value={size}
              onChange={(e) => setSize(e.target.value)}
            >
              <option>small</option>
              <option>default</option>
              <option>large</option>
            </select>
          </label>
          <label>
            State{" "}
            <select
              aria-label="Fixture state"
              value={scenario}
              onChange={(e) => {
                setScenario(e.target.value as Scenario);
                setGrid(initial());
              }}
            >
              {[
                "completed",
                "running",
                "approval",
                "failed",
                "attachments",
                "welcome",
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Width{" "}
            <select
              aria-label="Fixture width"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
            >
              {[1440, 1280, 900, 620, 480, 380].map((v) => (
                <option key={v} value={v}>
                  {v}px
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => setSidebar(!sidebar)}>Toggle sidebar</button>
          <button
            onClick={split}
            disabled={layout.slots.filter(Boolean).length > 1}
          >
            Split chat
          </button>
          <button onClick={newChat}>New chat</button>
          <button aria-pressed={reduced} onClick={() => setReduced(!reduced)}>
            Reduced motion
          </button>
        </nav>
        <div
          className="upgrade-fixture-stage"
          style={{ width, maxWidth: "100%" }}
        >
          {sidebar ? (
            <AppChrome
              activeDestination="workspace"
              activeSessionId="0"
              activeWorkspaceLayout="thread"
              commandProfiles={[]}
              savedProjects={[]}
              sessions={sessions}
              workspacePath={projectKey}
              onCreateCliSession={() => setAction("Fixture CLI action")}
              onCreateSession={newChat}
              onOpenCommandPalette={() => setAction("Fixture search action")}
              onOpenSettings={() => setAction("Fixture settings action")}
              onOpenToolPanel={() => setAction("Fixture panel action")}
              onOpenWorkspace={() => setAction("Fixture workspace action")}
              onSelectDestination={() =>
                setAction("Fixture destination action")
              }
              onSelectSession={() => {
                setScenario("completed");
                setGrid(initial());
              }}
              onSelectSessions={() => setAction("Fixture session list action")}
              onSelectWorkspaceLayout={() => setAction("Fixture layout action")}
            >
              {chat}
            </AppChrome>
          ) : (
            chat
          )}
        </div>
        <output className="upgrade-fixture-output" aria-live="polite">
          {action} · {layout.slots.filter(Boolean).length || 1} pane(s)
        </output>
      </main>
    </ChatFileActionsContext.Provider>
  );
}
if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(<Fixture />);
