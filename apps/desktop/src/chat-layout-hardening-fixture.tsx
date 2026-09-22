// Development-only regression fixture. Uses the production grid, chat surface,
// reducer and persistence sanitizer; no desktop bridge or provider calls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatGridSurface,
  ChatSurface,
  chatGridReducer,
  createChatProjectLayout,
  providersForConfig,
  sanitizeStoredChatGridState,
  type ChatGridAction,
  type ChatGridState,
  type ChatPaneRef,
  type GyroConfig,
  type SessionEvent,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const projectKey = "/Users/dev/Gyro";
const firstPane = {
  paneId: "running-pane",
  kind: "session",
  sessionId: "running-session",
  workspacePath: projectKey,
} satisfies ChatPaneRef;
const emptyConfig: GyroConfig = {
  telemetryEnabled: false,
  requireCommandApproval: false,
  requireFileEditApproval: false,
  modelProviders: [],
  commandProfiles: [],
};
const config: GyroConfig = {
  ...emptyConfig,
  selectedProviderId: "openai",
  modelProviders: providersForConfig(emptyConfig).map((provider) =>
    provider.id === "openai"
      ? { ...provider, enabled: true, authStatus: "connected" }
      : provider,
  ),
};
const startedAt = new Date(Date.now() - 17_000).toISOString();
const title = "Do A Full Reliability, Performance, And Security Upgrade";
function initialState(): ChatGridState {
  return {
    activeProjectKey: projectKey,
    layouts: { [projectKey]: createChatProjectLayout(projectKey, firstPane) },
  };
}
function transcript(
  sessionId: string,
  long: boolean,
  completed: boolean,
): SessionEvent[] {
  const history: SessionEvent[] = long
    ? Array.from({ length: 12 }, (_, index) => ({
        id: `history-${index}`,
        sessionId,
        turnId: `history-${Math.floor(index / 2)}`,
        kind: index % 2 ? "assistant-message" : "user-message",
        createdAt: "2026-09-21T10:00:00Z",
        message:
          index % 2
            ? "The transcript scrolls independently while the composer remains reachable.\n\n- Keep one instance of each chat.\n- Preserve pane focus and the active run.\n- Fit content within the pane after resizing."
            : `Check layout regression ${Math.floor(index / 2) + 1}.`,
        payload: index % 2 ? { kind: "provider-response", status: "done" } : {},
      }))
    : [];
  return [
    ...history,
    {
      id: "request",
      sessionId,
      turnId: "active-turn",
      kind: "user-message",
      createdAt: startedAt,
      message: completed
        ? "Polish the project navigation and conversation spacing. Keep the controls clear when the window is narrow."
        : "Do a full reliability, performance, and security upgrade for ai models, pages, and more (everything) in Gyro.",
      payload: {},
    },
    ...(completed ? completedEvents(sessionId) : []),
  ];
}

function completedEvents(sessionId: string): SessionEvent[] {
  const event = (
    id: string,
    kind: SessionEvent["kind"],
    message: string,
    payload: Record<string, unknown>,
    sequence: number,
  ): SessionEvent => ({
    id,
    sessionId,
    turnId: "active-turn",
    kind,
    message,
    createdAt: new Date(Date.parse(startedAt) + sequence * 1000).toISOString(),
    payload: { ...payload, timelineSequence: sequence },
  });
  return [
    ...["src/navigation.tsx", "src/navigation.css"].map((path, index) =>
      event(
        `completed-file-${index}`,
        "system-event",
        `Updated ${path}`,
        {
          kind: "provider-activity",
          activityId: `completed-file-${index}`,
          activityKind: "file",
          label: `Updated ${path}`,
          path,
          status: "done",
        },
        index + 1,
      ),
    ),
    event(
      "completed-edit-receipt",
      "system-event",
      "Applied navigation changes",
      {
        schema: "gyro.mutation.v1",
        kind: "mutation-approval",
        proposalId: "fixture-navigation-edit",
        status: "applied",
        fileChanges: [
          { path: "src/navigation.tsx", additions: 24, deletions: 8 },
          { path: "src/navigation.css", additions: 18, deletions: 6 },
        ],
      },
      3,
    ),
    event(
      "completed-checks",
      "system-event",
      "Checked responsive layouts",
      {
        kind: "provider-activity",
        activityId: "completed-checks",
        activityKind: "command",
        label: "Checked responsive layouts",
        command: "pnpm test:layout",
        status: "done",
      },
      4,
    ),
    event(
      "completed-answer",
      "assistant-message",
      "Updated the project navigation and conversation spacing.\n\n- Grouped recent projects so they are easier to scan.\n- Kept the selected project clear with a quiet background.\n- Aligned messages and the composer on one readable column.\n\nThe layout checks pass at desktop and narrow pane widths. The review notes cover the remaining interaction details.",
      {
        kind: "provider-response",
        status: "done",
        artifacts: [
          {
            id: "navigation-review",
            kind: "workspace",
            title: "Navigation review",
            status: "ready",
            files: [
              {
                path: "docs/navigation-review.md",
                description:
                  "Project grouping, selection, and keyboard behavior",
              },
              {
                path: "docs/responsive-checks.md",
                description: "Desktop, split pane, and narrow window checks",
              },
            ],
          },
        ],
      },
      5,
    ),
    event(
      "completed-status",
      "system-event",
      "Finished navigation polish",
      { kind: "provider-status", status: "done", durationMs: 14_000 },
      6,
    ),
  ];
}

function Fixture() {
  const [grid, setGrid] = useState(initialState);
  const [sequence, setSequence] = useState(0);
  const [width, setWidth] = useState(1440);
  const [height, setHeight] = useState<number>();
  const [long, setLong] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [environment, setEnvironment] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [stopped, setStopped] = useState<Record<string, boolean>>({});
  const layout =
    grid.layouts[projectKey] ?? createChatProjectLayout(projectKey);
  const paneCount = layout.slots.filter(Boolean).length;
  const dispatch = (action: ChatGridAction) =>
    setGrid((current) => chatGridReducer(current, action));
  const close = (paneId: string) =>
    dispatch({ type: "close-pane", projectKey, paneId });
  const addPane = (direction: "horizontal" | "vertical", running = false) => {
    const nextId = sequence + 1;
    setSequence(nextId);
    const pane: ChatPaneRef = running
      ? {
          paneId: `pane-${nextId}`,
          kind: "session",
          sessionId: `session-${nextId}`,
          workspacePath: projectKey,
        }
      : {
          paneId: `pane-${nextId}`,
          kind: "draft",
          draftKey: `draft-${nextId}`,
          workspacePath: projectKey,
        };
    dispatch({
      type: "select-pane",
      projectKey,
      pane,
      mode: "drop",
      slotIndex: Math.max(
        0,
        layout.slots.findIndex((item) => item?.paneId === layout.focusedPaneId),
      ),
      insertPosition: "after",
      splitDirection: direction,
      arrangement: direction === "horizontal" ? "columns" : "rows",
    });
  };
  const restoreDuplicates = () =>
    setGrid(
      sanitizeStoredChatGridState({
        activeProjectKey: projectKey,
        layouts: {
          [projectKey]: {
            projectKey,
            focusedPaneId: "duplicate-pane",
            splitDirection: "vertical",
            arrangement: "rows",
            slots: [
              null,
              firstPane,
              { ...firstPane, paneId: "duplicate-pane" },
              null,
            ],
          },
        },
      }),
    );
  const renderChat = (pane?: ChatPaneRef, isTiled = false, dragProps = {}) => {
    const key = pane?.paneId ?? "empty";
    const isSession = pane?.kind === "session";
    return (
      <ChatSurface
        {...dragProps}
        config={config}
        events={isSession ? transcript(pane.sessionId, long, completed) : []}
        sessionTitle={
          isSession
            ? pane.sessionId === firstPane.sessionId
              ? completed
                ? "Project navigation polish"
                : title
              : `Independent running chat ${pane.sessionId}`
            : undefined
        }
        paneKey={key}
        workspacePath={projectKey}
        branchName="main"
        sessionModel={{
          providerId: "openai",
          modelId: "gpt-6-astra",
          modelLabel: "GPT-6 Astra",
          reasoningEffort: "ultra",
        }}
        isTiled={isTiled}
        isComposerSending={isSession && !completed && !stopped[key]}
        draft={drafts[key] ?? ""}
        onDraftChange={(draft) =>
          setDrafts((current) => ({ ...current, [key]: draft }))
        }
        isEnvironmentRailOpen={environment === key}
        onToggleEnvironmentRail={() =>
          setEnvironment((current) => (current === key ? undefined : key))
        }
        onStopChat={() =>
          setStopped((current) => ({ ...current, [key]: true }))
        }
        onCloseChat={pane ? () => close(pane.paneId) : undefined}
        onComposerAction={() => {}}
        onSend={() => {}}
      />
    );
  };
  return (
    <main
      style={{
        height: "100dvh",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gridTemplateRows: "auto minmax(0, 1fr)",
        background: "var(--gyro-sidebar)",
        color: "var(--gyro-text)",
      }}
    >
      <nav
        aria-label="Layout regression controls"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          padding: 10,
          alignItems: "center",
        }}
      >
        <button
          onClick={() => {
            setGrid(initialState());
            setEnvironment(undefined);
            setStopped({});
            setCompleted(false);
          }}
        >
          Reset
        </button>
        <button disabled={paneCount >= 4} onClick={() => addPane("horizontal")}>
          Split right
        </button>
        <button disabled={paneCount >= 4} onClick={() => addPane("vertical")}>
          Split down
        </button>
        <button
          disabled={paneCount >= 4}
          onClick={() => addPane("horizontal", true)}
        >
          Add running chat
        </button>
        <button
          disabled={!layout.focusedPaneId}
          onClick={() => layout.focusedPaneId && close(layout.focusedPaneId)}
        >
          Close focused
        </button>
        <button onClick={restoreDuplicates}>
          Restore duplicate stored chats
        </button>
        <button aria-pressed={long} onClick={() => setLong(!long)}>
          Long transcript
        </button>
        <button
          aria-pressed={completed}
          onClick={() => setCompleted((current) => !current)}
        >
          Completed answer
        </button>
        <label>
          Width{" "}
          <select
            aria-label="Fixture width"
            value={width}
            onChange={(event) => setWidth(Number(event.target.value))}
          >
            {[1440, 900, 620, 440].map((value) => (
              <option key={value} value={value}>
                {value}px
              </option>
            ))}
          </select>
        </label>
        <label>
          Height{" "}
          <select
            aria-label="Fixture height"
            value={height ?? "fill"}
            onChange={(event) =>
              setHeight(
                event.target.value === "fill"
                  ? undefined
                  : Number(event.target.value),
              )
            }
          >
            <option value="fill">Fill window</option>
            <option value={700}>700px</option>
            <option value={440}>440px</option>
          </select>
        </label>
        <output aria-live="polite">
          {paneCount} pane{paneCount === 1 ? "" : "s"} · focused{" "}
          {layout.focusedPaneId ?? "none"} · {layout.arrangement ?? "single"}
        </output>
      </nav>
      <div
        className="gyro-app-shell"
        style={{
          display: "block",
          width,
          maxWidth: "100%",
          height: height ?? "100%",
          maxHeight: "100%",
          minHeight: 0,
          minWidth: 0,
          margin: "0 auto",
        }}
      >
        <div
          className="gyro-workspace-route is-thread"
          style={{ height: "100%" }}
        >
          <section
            className="gyro-workspace-primary"
            aria-label="Thread fixture"
          >
            <ChatGridSurface
              layout={layout}
              maximizedPaneId={grid.maximizedPaneId}
              onFocusPane={(pane) =>
                dispatch({
                  type: "focus-pane",
                  projectKey,
                  paneId: pane.paneId,
                })
              }
              onMovePane={(paneId, slotIndex) =>
                dispatch({ type: "move-pane", projectKey, paneId, slotIndex })
              }
              onToggleMaximize={(paneId) =>
                dispatch({ type: "toggle-maximize-pane", paneId })
              }
              onDropSession={(sessionId, _source, slotIndex, placement) =>
                dispatch({
                  type: "select-pane",
                  projectKey,
                  mode: "drop",
                  slotIndex,
                  ...placement,
                  pane: {
                    paneId: `drop-${sessionId}`,
                    kind: "session",
                    sessionId,
                    workspacePath: projectKey,
                  },
                })
              }
              renderPane={(pane, options) =>
                renderChat(pane, options.isTiled, {
                  onPaneDragStart: options.onPaneDragStart,
                  onPaneDragEnd: options.onPaneDragEnd,
                })
              }
            >
              {renderChat()}
            </ChatGridSurface>
          </section>
        </div>
      </div>
    </main>
  );
}

if (import.meta.env.DEV) {
  document.documentElement.dataset.theme = "dark";
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
