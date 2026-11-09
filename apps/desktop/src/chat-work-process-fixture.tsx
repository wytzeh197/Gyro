// Development-only acceptance surface: production parser and run UI, sample events.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatRun, type SessionEvent } from "@gyro-dev/ui";
import { buildRunModel } from "../../../packages/ui/src/chat-run";
import "@gyro-dev/ui/styles.css";
import "./chat-work-process-fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme =
  params.get("theme") === "light" ? "light" : "dark";
const startedAt = Date.now() - 42_000;
let sequence = 0;
function activity(
  kind: string,
  label: string,
  extra: Record<string, unknown> = {},
): SessionEvent {
  sequence += 1;
  return {
    id: `work-process-${sequence}`,
    sessionId: "work-process",
    turnId: "turn-1",
    kind: "system-event",
    createdAt: new Date(startedAt + sequence * 1000).toISOString(),
    message: label,
    payload: {
      kind: "provider-activity",
      activityKind: kind,
      label,
      status: "done",
      ...extra,
    },
  };
}
const initial: SessionEvent[] = [
  activity(
    "commentary",
    "I’ll trace the retry loop, then add a limit and check the failure case.",
  ),
  activity("read", "Read file", { path: "src/sync.ts" }),
  activity("read", "Read file", { path: "src/sync.test.ts" }),
  activity("command", "Ran command", { command: "git status --short" }),
  activity(
    "commentary",
    "The retry loop has no ceiling. I’ve added a five-attempt limit and I’m checking how it handles the last error.",
  ),
  activity("file", "Edited file", {
    path: "src/sync.ts",
    additions: 12,
    deletions: 4,
  }),
  activity("file", "Edited file", {
    path: "src/sync.test.ts",
    additions: 6,
    deletions: 0,
  }),
  activity("command", "Ran command", { command: "pnpm lint" }),
  activity(
    "commentary",
    "The checks are clean. I’m running the retry tests now.",
  ),
  activity("command", "Running tests", {
    command: "pnpm test",
    status: "running",
  }),
];

function Fixture() {
  const [events, setEvents] = useState(initial);
  const [state, setState] = useState<
    "running" | "done" | "failed" | "cancelled"
  >("running");
  const [selection, setSelection] = useState("");
  const model = buildRunModel(events, {
    isRunning: state === "running",
    startedAt: new Date(startedAt).toISOString(),
    status:
      state === "failed"
        ? {
            status: "failed",
            error: "The retry test failed.",
            recoveryKind: "invalid-request",
          }
        : state === "cancelled"
          ? { status: "cancelled" }
          : undefined,
    ...(state === "done" ? { durationMs: 42_000 } : {}),
  });
  const settle = (failed = false) =>
    setEvents((current) =>
      current.map((event) => {
        const payload = event.payload as Record<string, unknown>;
        return payload?.status === "running"
          ? {
              ...event,
              payload: { ...payload, status: failed ? "failed" : "done" },
            }
          : event;
      }),
    );
  return (
    <>
      <nav aria-label="Fixture controls" className="work-process-controls">
        <button onClick={() => settle()}>Complete current command</button>
        <button
          onClick={() => {
            settle();
            setEvents((current) => [
              ...current,
              activity(
                "commentary",
                "The retry tests pass. I’m checking the production build next.",
              ),
              activity("command", "Building project", {
                command: "pnpm build",
                status: "running",
              }),
            ]);
            setState("running");
          }}
        >
          Add progress update
        </button>
        <button
          onClick={() => {
            settle(true);
            setState("failed");
          }}
        >
          Fail command
        </button>
        <button
          onClick={() => {
            settle();
            setState("done");
          }}
        >
          Finish turn
        </button>
        <button
          onClick={() => {
            setEvents(initial);
            setState("running");
          }}
        >
          Reset
        </button>
      </nav>
      <main className="gyro-chat-surface is-thread work-process-fixture">
        <ChatRun
          model={model}
          headerActions={
            state === "running" ? (
              <button
                aria-label="Stop response"
                onClick={() => setState("cancelled")}
              >
                Stop
              </button>
            ) : undefined
          }
          renderSay={(text) => <span>{text}</span>}
          onOpenChanges={() => setSelection("Opened recorded changes")}
        />
        {selection ? <p role="status">{selection}</p> : null}
      </main>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
