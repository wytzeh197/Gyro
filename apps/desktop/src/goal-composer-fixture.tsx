// Local production-component preview. Sample goals only; no IPC/provider calls.
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatGridSurface,
  ChatSurface,
  createChatProjectLayout,
  providersForConfig,
  type GyroConfig,
  type SessionGoal,
  type SessionEvent,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const query = new URLSearchParams(location.search);
const workspace = "/fixture/Gyro";
const empty: GyroConfig = {
  commandProfiles: [],
  modelProviders: [],
  telemetryEnabled: false,
  requireCommandApproval: false,
  requireFileEditApproval: false,
};
const config: GyroConfig = {
  ...empty,
  selectedProviderId: "openai",
  modelProviders: providersForConfig(empty).map((provider) => ({
    ...provider,
    enabled: provider.id === "openai",
    authStatus: provider.id === "openai" ? "connected" : provider.authStatus,
  })),
};
function sampleGoal(): SessionGoal {
  const startedAt = new Date(Date.now() - 16_000).toISOString();
  return {
    text: "Improve browser tool use in Gyro",
    status: "active",
    createdAt: startedAt,
    updatedAt: new Date().toISOString(),
    run: { id: "fixture", status: "running", startedAt },
  };
}

function GoalPane({
  paneId,
  isTiled,
  scenario,
}: {
  paneId: string;
  isTiled: boolean;
  scenario: string;
}) {
  const [goal, setGoal] = useState<SessionGoal | undefined>(() => {
    const value = sampleGoal();
    if (scenario === "finished") value.run!.status = "paused";
    if (scenario === "blocked") {
      value.run!.status = "blocked";
      value.run!.reason = "Waiting for access to the browser test environment.";
    }
    return value;
  });
  const [editing, setEditing] = useState(false);
  const [lastAction, setLastAction] = useState("Ready");
  const stacked = scenario === "stacked";
  const withFiles = ["files", "stacked", "finished"].includes(scenario);
  const stamp = goal?.createdAt ?? new Date().toISOString();
  const event = (
    id: string,
    kind: SessionEvent["kind"],
    message: string,
    payload = {},
  ): SessionEvent => ({
    id: `${paneId}-${id}`,
    sessionId: paneId,
    turnId: `${paneId}-turn`,
    kind,
    message,
    payload,
    createdAt: stamp,
  });
  const events: SessionEvent[] = [
    event("request", "user-message", "Improve browser tool use in Gyro."),
    ...(withFiles
      ? [
          event(
            "edits",
            "system-event",
            "Updated browser handling and checks",
            {
              schema: "gyro.mutation.v1",
              kind: "mutation-approval",
              proposalId: `${paneId}-edits`,
              status: "applied",
              fileChanges: [
                "src/browser.ts",
                "src/browser.test.ts",
                "src/permissions.ts",
              ].map((path, index) => ({
                path,
                additions: 8 + index,
                deletions: 2,
                patch: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+updated`,
              })),
              timelineSequence: 1,
            },
          ),
        ]
      : []),
    ...(scenario === "finished"
      ? [
          event("done", "system-event", "Completed", {
            kind: "provider-status",
            status: "done",
            durationMs: 16000,
            timelineSequence: 2,
          }),
          event(
            "reply",
            "assistant-message",
            "Updated browser handling and verified the changes.",
            { kind: "provider-response", status: "done", timelineSequence: 3 },
          ),
        ]
      : []),
  ];
  return (
    <>
      <ChatSurface
        config={config}
        events={events}
        attachments={
          stacked
            ? [
                {
                  id: "file",
                  kind: "workspace-file",
                  name: "browser-notes.md",
                  path: "/fixture/Gyro/browser-notes.md",
                  size: 1200,
                },
              ]
            : []
        }
        queuedMessages={
          stacked
            ? [
                {
                  id: "queue-1",
                  message:
                    "Also check the browser permission prompts in split view.",
                  attachmentCount: 0,
                  hasFailed: false,
                  isDispatching: false,
                },
                {
                  id: "queue-2",
                  message:
                    "Keep the patch focused and summarize the verification.",
                  attachmentCount: 0,
                  hasFailed: false,
                  isDispatching: false,
                },
              ]
            : []
        }
        onEditQueuedMessage={() => setLastAction("edit-queued")}
        onRemoveQueuedMessage={() => setLastAction("remove-queued")}
        onSteerQueuedMessage={() => setLastAction("steer-queued")}
        chatNotice={
          stacked ? (
            <p className="gyro-goal-save-notice" role="status">
              Fixture notice: browser verification is still running.
            </p>
          ) : undefined
        }
        subagents={
          stacked
            ? {
                agents: ["Browser checks", "Permission review"].map(
                  (name, index) => ({
                    agentId: `${paneId}-agent-${index}`,
                    parentSessionId: paneId,
                    parentTurnId: `${paneId}-turn`,
                    name,
                    task: name,
                    providerId: "openai",
                    modelId: "gpt-6-astra",
                    readOnly: true,
                    status: "running" as const,
                    createdAt: stamp,
                    updatedAt: stamp,
                    elapsedMs: 16000,
                    runId: `run-${index}`,
                  }),
                ),
                eventsByAgentId: {},
                onSelect: () => setLastAction("select-agent"),
                onStop: () => setLastAction("stop-agent"),
              }
            : undefined
        }
        isTiled={isTiled}
        paneKey={paneId}
        sessionTitle="Goal composer preview"
        workspacePath={workspace}
        sessionModel={{
          providerId: "openai",
          modelId: "gpt-6-astra",
          reasoningEffort: "high",
        }}
        sessionGoal={goal}
        isComposerSending={
          goal?.status === "active" && goal.run?.status === "running"
        }
        isGoalComposerActive={editing}
        isGoalModeActive={Boolean(goal)}
        onComposerAction={(action) => {
          setLastAction(action);
          if (action === "add-goal") setEditing(true);
        }}
        onCancelGoalComposer={() => setEditing(false)}
        onCloseGoalComposer={() => setEditing(false)}
        onGoalAction={(action, value) => {
          setLastAction(action);
          if (action === "clear") setGoal(undefined);
          else
            setGoal((current) => {
              if (!current) return sampleGoal();
              if (action === "edit" || action === "set")
                return { ...current, text: value ?? current.text };
              if (action === "complete" || action === "reopen")
                return {
                  ...current,
                  status: action === "complete" ? "complete" : "active",
                };
              return {
                ...current,
                updatedAt: new Date().toISOString(),
                run: {
                  ...current.run!,
                  status: action === "pause" ? "paused" : "running",
                },
              };
            });
          setEditing(false);
        }}
        onSend={() => undefined}
        onStopChat={() =>
          setGoal((current) =>
            current
              ? { ...current, run: { ...current.run!, status: "paused" } }
              : current,
          )
        }
        shellReady
      />
      <output
        className="goal-fixture-result"
        aria-label={`${paneId} last action`}
      >
        {lastAction}
      </output>
    </>
  );
}

function Fixture() {
  const [split, setSplit] = useState(query.get("split") === "1");
  const [theme, setTheme] = useState(
    query.get("theme") === "light" ? "light" : "dark",
  );
  const [revision, setRevision] = useState(0);
  const [focused, setFocused] = useState("main");
  const [scenario, setScenario] = useState(query.get("scenario") ?? "plain");
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.body.style.zoom = query.get("zoom") === "1.1" ? "1.1" : "1";
  }, [theme]);
  const layout = {
    ...createChatProjectLayout(workspace),
    focusedPaneId: focused,
    arrangement: "columns" as const,
    slots: [
      {
        paneId: "main",
        kind: "session" as const,
        sessionId: "main",
        workspacePath: workspace,
      },
      split
        ? {
            paneId: "second",
            kind: "session" as const,
            sessionId: "second",
            workspacePath: workspace,
          }
        : null,
      null,
      null,
    ],
  };
  return (
    <div className="goal-fixture">
      <style>{`
      .goal-fixture {height:${query.get("zoom") === "1.1" ? "calc(100dvh / 1.1)" : "100dvh"};display:flex;flex-direction:column;background:var(--gyro-app);color:var(--gyro-text);font-family:var(--gyro-font-sans)}
      .goal-fixture nav {display:flex;align-items:center;gap:12px;padding:10px;font-size:12px}
      .goal-fixture nav span {margin-right:auto}
      .goal-fixture nav button, .goal-fixture nav select {font:inherit;color:inherit;background:var(--gyro-surface);border:1px solid var(--gyro-border);border-radius:6px;padding:4px 8px}
      .goal-fixture main {flex:1;min-height:0}
      .goal-fixture-result {position:absolute;top:52px;right:12px;font-size:10px;color:var(--gyro-faint);pointer-events:none}
    `}</style>
      <nav aria-label="Fixture controls">
        <span>Goal preview · local sample data</span>
        <select
          aria-label="Scenario"
          value={scenario}
          onChange={(event) => setScenario(event.target.value)}
        >
          <option value="plain">Goal only</option>
          <option value="files">Files edited</option>
          <option value="stacked">
            Files, agents, queue, notice, attachment
          </option>
          <option value="finished">Finished turn with file summary</option>
          <option value="blocked">Blocked goal</option>
        </select>
        <button onClick={() => setSplit(!split)}>
          {split ? "Single pane" : "Split view"}
        </button>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          Toggle theme
        </button>
        <button onClick={() => setRevision(revision + 1)}>Reset goal</button>
      </nav>
      <main>
        <ChatGridSurface
          key={`${revision}-${scenario}`}
          layout={layout}
          onDropSession={() => false}
          onFocusPane={(pane) => setFocused(pane.paneId)}
          onMovePane={() => false}
          onToggleMaximize={() => undefined}
          renderPane={(pane, options) => (
            <GoalPane
              paneId={pane.paneId}
              isTiled={options.isTiled}
              scenario={scenario}
            />
          )}
        />
      </main>
    </div>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
