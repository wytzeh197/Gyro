// Development-only replay of chat lifecycle regressions, using the real surface.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatThread } from "@gyro-dev/ui";
import type { SessionEvent } from "@gyro-dev/ui";
import "@gyro-dev/ui/styles.css";
import {
  mergePersistedAndOptimisticEvents,
  mergeProviderResponseEvents,
} from "./provider-stream-events";

const makeEvent = (
  id: string,
  kind: SessionEvent["kind"],
  message: string,
  payload: SessionEvent["payload"] = {},
): SessionEvent => ({
  id,
  kind,
  message,
  payload,
  sessionId: "fixture-session",
  turnId: "fixture-turn",
  createdAt: "2026-09-13T10:00:00.000Z",
});
const user = makeEvent("user", "user-message", "Fix the missing final reply.");
const tool = makeEvent("tool", "system-event", "Ran tests", {
  kind: "provider-activity",
  activityId: "tool",
  activityKind: "command",
  label: "Ran tests",
  status: "done",
  timelineSequence: 100,
});
const answer = makeEvent(
  "answer",
  "assistant-message",
  "**Fixed.** The final reply stays below the work timeline.\n\nThe regression checks pass.",
  {
    kind: "provider-response",
    status: "done",
    timelineSequence: 2,
  },
);
const status = makeEvent("status", "system-event", "Answered", {
  kind: "provider-status",
  status: "done",
  durationMs: 2400,
});
const saved = [
  user,
  answer,
  { ...tool, payload: { ...(tool.payload as object), timelineSequence: 1 } },
  status,
];
const live = [
  user,
  {
    ...answer,
    message: "GYRO_SESSION_TITLE: Fix final reply",
    payload: {
      kind: "provider-stream",
      streaming: true,
      timelineSequence: 1,
      segments: [{ start: 0, sequence: 1 }],
    },
  },
  tool,
];

function Fixture() {
  const [events, setEvents] = useState(() =>
    mergeProviderResponseEvents(live, saved),
  );
  const [draft, setDraft] = useState("");
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <nav
        aria-label="Replay controls"
        style={{ display: "flex", gap: 16, padding: 16 }}
      >
        <button
          onClick={() =>
            setEvents([
              ...live,
              {
                ...status,
                payload: { kind: "provider-status", status: "running" },
              },
            ])
          }
        >
          Start turn
        </button>
        <button
          onClick={() => setEvents(mergeProviderResponseEvents(live, saved))}
        >
          Complete turn
        </button>
        <button
          onClick={() =>
            setEvents((current) =>
              mergePersistedAndOptimisticEvents(saved, current),
            )
          }
        >
          Reload saved turn
        </button>
        <button
          onClick={() => setEvents([user, { ...answer, message: "7" }, status])}
        >
          Short answer
        </button>
      </nav>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatThread
          isSending={events.some(
            (event) =>
              event.id === "status" &&
              (event.payload as { status?: string }).status === "running",
          )}
          events={events}
          draft={draft}
          onDraftChange={setDraft}
          onSend={() => {}}
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
