// Development-only preview of the production automation surface and shell.
// All data and callbacks are in memory; no scheduler or provider is invoked.
import React, { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AppChrome,
  AutomationsSurface,
  type Automation,
  type Session,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";

const params = new URLSearchParams(location.search);
Object.assign(document.documentElement.dataset, {
  theme: params.get("theme") === "light" ? "light" : "dark",
  density: params.get("density") === "compact" ? "compact" : "comfortable",
  interfaceSize: params.get("size") ?? "default",
});
const project = "/Users/dev/Gyro";
const summary = "README.md updated and formatting verified.";
const now = Date.now();
const iso = (minutesAgo: number) =>
  new Date(now - minutesAgo * 60_000).toISOString();
const runs: Automation["runHistory"] = [
  {
    id: "passed",
    sessionId: "passed",
    status: "passed",
    startedAt: iso(360),
    finishedAt: iso(358),
    summary,
  },
  {
    id: "failed",
    sessionId: "failed",
    status: "failed",
    startedAt: iso(385),
    finishedAt: iso(384),
    summary:
      "Provider endpoint unavailable: Network Error while sending request.",
  },
  {
    id: "interrupted",
    sessionId: "interrupted",
    status: "failed",
    startedAt: iso(550),
    finishedAt: iso(549),
    summary: "Response interrupted while decoding the provider stream.",
  },
  {
    id: "previous",
    sessionId: "previous",
    status: "passed",
    startedAt: iso(7 * 24 * 60),
    finishedAt: iso(7 * 24 * 60 - 2),
    summary,
  },
];
const sessions: Session[] = runs.map((run) => ({
  id: run.id,
  title: "Automation: Update readme",
  workspacePath: project,
  origin: "desktop",
  providerId: "deepseek",
  providerLabel: "DeepSeek",
  createdAt: run.startedAt,
  updatedAt: run.startedAt,
  eventsPath: `preview://${run.id}`,
}));

function initialAutomation(): Automation {
  const scene = params.get("state");
  const history =
    scene === "empty" ? [] : scene === "failed" ? runs.slice(1) : runs;
  if (scene === "long") {
    history[0] = {
      ...runs[0]!,
      summary: `${summary} Verified the working tree and the formatting check for the documentation. ${"A long provider detail remains readable without covering the time or chat action. ".repeat(5)}`,
    };
  }
  if (scene === "running") {
    history.unshift({
      id: "running",
      status: "running",
      startedAt: iso(1),
      summary: "Updating README.md…",
    });
  }
  return {
    id: "update-readme",
    title:
      scene === "long"
        ? "Update the readme from the current project state and verify the documentation"
        : "Update readme",
    prompt:
      "I want you to update the readme file based on the current state of Gyro.",
    schedule: "weekly-at",
    status: scene === "paused" ? "paused" : "current",
    project: "Gyro",
    provider: "DeepSeek",
    branch:
      scene === "long"
        ? "codex/documentation-and-current-project-state"
        : "main",
    workspaceMode: "local",
    execution: {
      workspacePath: project,
      providerId: "deepseek",
      modelId: "deepseek-chat",
      modelLabel: "DeepSeek V4.1 Flash",
      calendar: { weekday: 4, time: "09:00", timezone: "Europe/Amsterdam" },
    },
    nextRunAt: scene === "paused" ? undefined : "2026-10-16T07:00:00Z",
    triageState: history.length ? "needs-review" : "none",
    lastResult: history[0]?.summary ?? "No result yet",
    unreadResults: history.length,
    runHistory: history,
  };
}

function Preview() {
  const [automation, setAutomation] = useState(initialAutomation);
  const [openedChat, setOpenedChat] = useState<string>();
  const [destination, setDestination] = useState<"automations" | "workspace">(
    "automations",
  );
  const noAction = () => undefined;
  return (
    <AppChrome
      sessions={sessions}
      commandProfiles={[]}
      savedProjects={[{ path: project, label: "Gyro" }]}
      activeDestination={destination}
      activeWorkspaceLayout="thread"
      workspacePath={project}
      workspaceSidebarWidth={240}
      onSelectSession={(id) => {
        setOpenedChat(id);
        setDestination("workspace");
      }}
      onSelectWorkspaceLayout={noAction}
      onSelectDestination={() => {
        setOpenedChat(undefined);
        setDestination("automations");
      }}
      onOpenToolPanel={noAction}
      onOpenSettings={noAction}
      onOpenCommandPalette={noAction}
      onCreateSession={noAction}
      onCreateCliSession={noAction}
      onSelectSessions={noAction}
      onOpenWorkspace={noAction}
    >
      {openedChat ? (
        <section style={{ padding: 28 }}>
          <h2>Automation chat preview</h2>
          <p>
            {
              automation.runHistory.find((run) => run.sessionId === openedChat)
                ?.summary
            }
          </p>
          <button
            onClick={() => {
              setOpenedChat(undefined);
              setDestination("automations");
            }}
          >
            Back to automations
          </button>
        </section>
      ) : (
        <AutomationsSurface
          automations={[automation]}
          selectedAutomationId={automation.id}
          providerChoices={[
            {
              id: "deepseek",
              label: "DeepSeek",
              ready: true,
              models: [{ id: "deepseek-chat", label: "DeepSeek V4.1 Flash" }],
            },
          ]}
          onSelectAutomation={noAction}
          onOpenSession={(id) => {
            setOpenedChat(id);
            setDestination("workspace");
          }}
          onArchiveAutomation={() =>
            setAutomation((item) => ({
              ...item,
              triageState: "archived",
              unreadResults: 0,
            }))
          }
          onToggleAutomation={() =>
            setAutomation((item) => ({
              ...item,
              status: item.status === "paused" ? "current" : "paused",
              nextRunAt:
                item.status === "paused" ? "2026-10-16T07:00:00Z" : undefined,
            }))
          }
          onRunAutomation={() => {
            const startedAt = new Date().toISOString();
            const run = {
              id: startedAt,
              startedAt,
              status: "running" as const,
              summary: "Updating README.md…",
            };
            setAutomation((item) => ({
              ...item,
              lastResult: run.summary,
              runHistory: [run, ...item.runHistory],
            }));
            window.setTimeout(
              () =>
                setAutomation((item) => ({
                  ...item,
                  lastResult: summary,
                  triageState: "needs-review",
                  unreadResults: item.unreadResults + 1,
                  runHistory: item.runHistory.map((entry) =>
                    entry.id === startedAt
                      ? {
                          ...entry,
                          status: "passed",
                          summary,
                          sessionId: "passed",
                          finishedAt: new Date().toISOString(),
                        }
                      : entry,
                  ),
                })),
              1500,
            );
          }}
          onEditAutomation={async (_id, details) => {
            setAutomation((item) => ({
              ...item,
              title: details.title,
              prompt: details.prompt,
              schedule: details.schedule,
              stopCondition: details.stopCondition,
              execution: { ...item.execution, calendar: details.calendar },
            }));
            return true;
          }}
          onCreateAutomation={async (details) => {
            setAutomation((item) => ({
              ...item,
              title: details.title,
              prompt: details.prompt,
              schedule: details.schedule,
              stopCondition: details.stopCondition,
              triageState: "none",
              lastResult: "No result yet",
              runHistory: [],
              unreadResults: 0,
              execution: { ...item.execution, calendar: details.calendar },
            }));
            return true;
          }}
        />
      )}
    </AppChrome>
  );
}

const root =
  (import.meta.hot?.data.root as Root | undefined) ??
  createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<Preview />);
