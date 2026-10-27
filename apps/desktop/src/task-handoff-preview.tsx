// Development-only check page: the production chat surface with a reply that
// carries suggested tasks (`payload.tasks`, as the desktop stores a GYRO_TASKS
// line), the new chat a started task opens, and the new-chat screen offering
// the suggestions nobody started. No bridge or provider call.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatSurface,
  providersForConfig,
  type ChatTaskStatus,
  type GyroConfig,
  type SessionEvent,
} from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import { taskPromptWithContext } from "./use-task-handoff";

const emptyConfig: GyroConfig = {
  telemetryEnabled: false,
  requireCommandApproval: false,
  requireFileEditApproval: false,
  modelProviders: [],
  commandProfiles: [],
};
const config: GyroConfig = {
  ...emptyConfig,
  selectedProviderId: "anthropic",
  modelProviders: providersForConfig(emptyConfig).map((provider) =>
    provider.id === "anthropic" || provider.id === "openai"
      ? { ...provider, enabled: true, authStatus: "connected" }
      : provider,
  ),
};

const sourceTitle = "Traffic lights, task handoff, fade";
const reply = `Grey traffic lights mean macOS doesn't think the Gyro window is active yet. I couldn't reproduce it without restarting the Gyro you're chatting in, so there's no cause yet.

- **Startup isn't the problem this time.** Gyro launched at 08:28:58 and its startup work was done by 08:29:00.
- **macOS logged no hang** for Gyro, which points to the window not getting focus rather than the app being busy.

I fixed the fade in image 2: it now starts 28px above the composer instead of 64px.`;

const tasks = [
  {
    title: "Catch what blocks Gyro when the traffic lights stay grey",
    why: "Needs a live reproduction and a process sample — separate from the fade fix.",
    prompt:
      "When Gyro's traffic lights stay grey after a click, find out why. Add a small debug-only watchdog that samples the main thread if it stops answering for more than 2 seconds, and write the sample to Gyro's logs folder. Then check whether the window is failing to become key rather than the app being busy.",
  },
  {
    title: "Run session-store recovery before the window appears",
    why: "A startup change in lib.rs with its own risk and tests.",
    prompt:
      "In apps/desktop/src-tauri/src/lib.rs, setup() shows and focuses the main window before it recovers the session store on the main thread. Move the window reveal after recovery, or move recovery off the main thread, so a slow launch never leaves a visible window that ignores clicks.",
  },
  {
    title: "Keep the fade start tied to the composer",
    why: "The fade offset changed once and can drift again.",
    prompt:
      "The chat fade should start 28px above the composer. Pin that offset to the composer instead of a fixed distance from the thread, and add a check so a later layout change cannot push it back up.",
  },
];

const sourceEvents: SessionEvent[] = [
  {
    id: "source-user",
    sessionId: "source",
    turnId: "turn-1",
    kind: "user-message",
    createdAt: "2026-10-27T07:32:00Z",
    message:
      "I'm clicking on the Gyro app but the traffic lights aren't coloring, but they are a minute later? Also the chat fades off too high.",
    payload: {},
  },
  {
    id: "source-reply",
    sessionId: "source",
    turnId: "turn-1",
    kind: "assistant-message",
    createdAt: "2026-10-27T07:33:10Z",
    message: reply,
    payload: { kind: "provider-response", status: "done", tasks },
  },
];

type Stage = "cards" | "new-chat" | "start";

const startSuggestions = tasks.map((task, index) => ({
  ...task,
  id: `source-reply:${index}`,
  sourceTitle,
}));

function Fixture() {
  const params = new URLSearchParams(location.search);
  const [stage, setStage] = useState<Stage>(
    params.get("stage") === "new-chat" || params.get("stage") === "start"
      ? (params.get("stage") as Stage)
      : "cards",
  );
  const [statuses, setStatuses] = useState<Record<string, ChatTaskStatus>>(
    params.get("started")
      ? { "source-reply:0": { status: "started", chatTitle: tasks[0]!.title } }
      : {},
  );
  const [started, setStarted] = useState({
    title: tasks[0]!.title,
    message: taskPromptWithContext(tasks[0]!.prompt, sourceTitle, reply),
    modelId: "claude-opus-5",
    effort: "high" as const,
  });
  const [draft, setDraft] = useState("");

  const newChatEvents: SessionEvent[] = [
    {
      id: "new-user",
      sessionId: "new",
      turnId: "turn-1",
      kind: "user-message",
      createdAt: "2026-10-27T07:40:00Z",
      message: started.message,
      payload: {},
    },
  ];

  return (
    <div
      className="gyro-workspace-route is-thread task-handoff-preview"
      style={{ gridTemplateRows: "auto minmax(0, 1fr)", height: "100vh" }}
    >
      <style>{`
        .task-handoff-preview *, .task-handoff-preview *::before, .task-handoff-preview *::after {
          animation: none !important;
        }
      `}</style>
      <nav
        aria-label="Fixture controls"
        style={{ alignItems: "center", display: "flex", fontSize: 12, gap: 6, minHeight: 40, padding: "6px 12px" }}
      >
        <span style={{ color: "var(--gyro-muted)" }}>Task handoff · actual components</span>
        <button onClick={() => setStage("cards")} type="button">source chat</button>
        <button onClick={() => setStage("new-chat")} type="button">new chat</button>
        <button onClick={() => setStage("start")} type="button">start screen</button>
        <button onClick={() => setStatuses({})} type="button">reset cards</button>
        <button
          onClick={() => {
            const root = document.documentElement;
            root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
          }}
          type="button"
        >
          theme
        </button>
      </nav>
      <section className="gyro-workspace-primary" aria-label="Chat">
        <ChatSurface
          key={stage}
          chatMode="normal"
          config={config}
          events={
            stage === "start"
              ? []
              : stage === "new-chat"
                ? newChatEvents
                : sourceEvents
          }
          sessionTitle={stage === "new-chat" ? started.title : sourceTitle}
          paneKey="task-handoff-preview"
          workspacePath="/Users/dev/Gyro"
          branchName="v0.1.0"
          sessionModel={{
            providerId: "anthropic",
            modelId: stage === "new-chat" ? started.modelId : "claude-opus-5",
            reasoningEffort: stage === "new-chat" ? started.effort : "high",
          }}
          taskSuggestions={{
            statusFor: (taskId) => statuses[taskId],
            onStart: ({ task, start, event }) => {
              setStatuses((current) => ({
                ...current,
                [task.id]: { status: "started", chatTitle: task.title },
              }));
              setStarted({
                title: task.title,
                message: start.includeContext
                  ? taskPromptWithContext(start.prompt, sourceTitle, event.message)
                  : start.prompt,
                modelId: start.modelId,
                effort: (start.reasoningEffort ?? "high") as "high",
              });
            },
            onDismiss: (task) =>
              setStatuses((current) => ({
                ...current,
                [task.id]: { status: "dismissed" },
              })),
            onOpenStarted: () => setStage("new-chat"),
          }}
          startTaskSuggestions={{
            load: async () =>
              startSuggestions.filter((task) => !statuses[task.id]),
            onStart: (task) => {
              setStatuses((current) => ({
                ...current,
                [task.id]: { status: "started", chatTitle: task.title },
              }));
              setStage("new-chat");
            },
            onDismiss: (task) =>
              setStatuses((current) => ({
                ...current,
                [task.id]: { status: "dismissed" },
              })),
          }}
          taskOrigin={
            stage === "new-chat"
              ? {
                  sourceTitle,
                  withSummary: started.message.includes("\n---\nContext from"),
                  onOpenSource: () => setStage("cards"),
                }
              : undefined
          }
          draft={draft}
          onDraftChange={setDraft}
          onComposerAction={() => {}}
          onSend={() => {}}
          onStopChat={() => {}}
        />
      </section>
    </div>
  );
}

document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
if (import.meta.env.DEV) {
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
