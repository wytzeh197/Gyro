// Development-only replay of chat lifecycle regressions, using the real surface.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatThread } from "@gyro-dev/ui";
import type { SessionEvent, TerminalPane } from "@gyro-dev/ui";
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
const meteredAnswer: SessionEvent = {
  ...answer,
  payload: {
    ...(answer.payload as object),
    turnTokens: {
      inputTokens: 1_200,
      outputTokens: 340,
      totalTokens: 1_540,
      measured: true,
    },
  },
};
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

// A long live turn: narration splits the work into stretches, a reasoning
// headline stands in for "Thinking", and the tail holds more calls than the
// live window shows, one of them failed.
const activity = (
  id: string,
  activityKind: string,
  label: string,
  extra: Record<string, unknown> = {},
) =>
  makeEvent(id, "system-event", label, {
    kind: "provider-activity",
    activityId: id,
    activityKind,
    label,
    status: "done",
    ...extra,
  });
const narrate = (id: string, message: string) =>
  makeEvent(id, "assistant-message", message, { kind: "provider-commentary" });
const longWork = [
  user,
  activity("think-1", "reasoning", "**Inspecting the chat run**"),
  activity("c1", "command", "git remote -v", { command: "git remote -v" }),
  activity("c2", "read", "Read chat-run.ts", {
    path: "packages/ui/src/chat-run.ts",
  }),
  activity("c3", "command", "git status --short", {
    command: "git status --short",
  }),
  activity("c4", "tool", "Used Skill", { tool: "Skill", note: "review" }),
  narrate(
    "say-1",
    "I found where the rail is built. Next I'll check the styles.",
  ),
  ...[
    "rg gyro-run packages/ui/src",
    "pnpm typecheck",
    "pnpm test",
    "cargo test --workspace",
    "git diff --check",
  ].map((command, index) =>
    activity(`t${index}`, "command", command, {
      command,
      ...(index === 2 ? { status: "failed" } : {}),
    }),
  ),
  activity("t5", "read", "Read styles.css", {
    path: "packages/ui/src/styles.css",
  }),
  activity("t6", "file", "Edited chat-design.css", {
    path: "packages/ui/src/chat-design.css",
    additions: 120,
    deletions: 4,
  }),
  activity("t7", "command", "pnpm test", {
    command: "pnpm test",
    status: "running",
  }),
  { ...status, payload: { kind: "provider-status", status: "running" } },
];

/** Stamps the long turn as just started so its elapsed clocks read sensibly. */
const freshLongWork = (): SessionEvent[] => {
  const start = Date.now() - 20_000;
  return longWork.map((event, index) => ({
    ...event,
    createdAt: new Date(start + index * 1_000).toISOString(),
  }));
};

// Counts arrive on hidden guarded-edit receipts, independently of provider rows.
// Replaying these through ChatThread catches transcript filtering before the
// shared run model feeds both the live dock and completed file summary.
const countedFileActivity = [
  activity("counted-a", "file", "Updated src/a.ts", { path: "src/a.ts" }),
  activity("counted-b", "file", "Updated src/b.ts", { path: "src/b.ts" }),
];
const editReceipt = (
  id: string,
  fileChanges: Array<{ path: string; additions: number; deletions: number }>,
  extra: Record<string, unknown> = {},
) =>
  makeEvent(id, "system-event", "Applied fixture edits", {
    schema: "gyro.mutation.v1",
    kind: "mutation-approval",
    proposalId: id,
    status: "applied",
    fileChanges,
    ...extra,
  });
const countedReceipts = [
  editReceipt("edit-a-1", [{ path: "src/a.ts", additions: 2, deletions: 1 }]),
  editReceipt("edit-a-2", [{ path: "src/a.ts", additions: 3, deletions: 0 }]),
  editReceipt("edit-b", [{ path: "src/b.ts", additions: 2, deletions: 2 }], {
    schema: "gyro.provider-approval.v1",
    kind: "provider-tool-approval",
    approvalId: "edit-b",
  }),
  // Redelivery must not count the same applied operation twice.
  editReceipt(
    "edit-a-replayed",
    [{ path: "src/a.ts", additions: 2, deletions: 1 }],
    {
      proposalId: "edit-a-1",
    },
  ),
  editReceipt(
    "rejected-edit",
    [{ path: "ignored.ts", additions: 99, deletions: 99 }],
    {
      status: "rejected",
    },
  ),
];
function fileCountsReplay(phase: "before" | "live" | "done"): SessionEvent[] {
  const start = Date.now() - 10_000;
  return [
    { ...user, message: "Show the line counts for this turn's edits." },
    // This approval anchor carries no counts. Its applied update does.
    makeEvent("edit-a-request", "approval-requested", "Update src/a.ts", {
      schema: "gyro.mutation.v1",
      kind: "mutation-approval",
      proposalId: "edit-a-1",
      path: "src/a.ts",
      operation: "update",
      status: "pending",
    }),
    ...countedFileActivity,
    ...(phase === "before" ? [] : countedReceipts),
    ...(phase === "done"
      ? [
          {
            ...answer,
            message: "Updated both files. The recorded edits total +7/−3.",
          },
        ]
      : []),
    {
      ...status,
      payload: {
        kind: "provider-status",
        status: phase === "done" ? "done" : "running",
      },
    },
  ].map((event, index) => ({
    ...event,
    createdAt: new Date(start + index * 100).toISOString(),
    payload: { ...(event.payload as object), timelineSequence: index },
  }));
}

// The chat design layer is scoped to a themed root, as in the app.
document.documentElement.dataset.theme = "dark";

const keepAlivePane: TerminalPane = {
  id: "model:fixture-session",
  title: "Desktop",
  profileId: "shell",
  command: "pnpm --filter @gyro-dev/desktop dev",
  output: "Local: http://127.0.0.1:1420/",
  status: "running",
  lastEvent: "running",
  workspaceMode: "local",
  branch: "main",
  createdAt: "2026-09-14T12:00:00.000Z",
  owner: {
    kind: "model",
    sessionId: "fixture-session",
    turnId: "fixture-turn",
    callId: "keep-alive",
  },
  keepAlive: { turnId: "fixture-turn", restartCount: 0, phase: "watching" },
};

function Fixture() {
  const [events, setEvents] = useState(() =>
    mergeProviderResponseEvents(live, saved),
  );
  const [draft, setDraft] = useState("");
  const [keepAlivePanes, setKeepAlivePanes] = useState<TerminalPane[]>([]);
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Hidden browser previews pause entrance animations at opacity zero. */}
      <style>{`.gyro-chat-thread-canvas, .gyro-chat-composer-dock, .gyro-chat-run-timeline > .gyro-message.is-assistant { animation: none !important; }`}</style>
      <nav
        aria-label="Replay controls"
        style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: 16 }}
      >
        <button
          onClick={() => {
            setKeepAlivePanes([]);
            setEvents([
              ...live,
              {
                ...status,
                payload: { kind: "provider-status", status: "running" },
              },
            ]);
          }}
        >
          Start turn
        </button>
        <button
          onClick={() => {
            setKeepAlivePanes([]);
            setEvents(mergeProviderResponseEvents(live, saved));
          }}
        >
          Complete turn
        </button>
        <button
          onClick={() => {
            setKeepAlivePanes([]);
            setEvents([user, meteredAnswer, status]);
          }}
        >
          Reported tokens
        </button>
        <button
          onClick={() => {
            setKeepAlivePanes([]);
            setEvents((current) =>
              mergePersistedAndOptimisticEvents(saved, current),
            );
          }}
        >
          Reload saved turn
        </button>
        <button
          onClick={() => {
            setKeepAlivePanes([]);
            setEvents([user, { ...answer, message: "7" }, status]);
          }}
        >
          Short answer
        </button>
        <button
          onClick={() => {
            setKeepAlivePanes([]);
            setEvents([user, answer, tool, status]);
          }}
        >
          Late activity after answer
        </button>
        <button
          onClick={() => {
            setKeepAlivePanes([]);
            setEvents(freshLongWork());
          }}
        >
          Long work
        </button>
        <button
          onClick={() => {
            setEvents(saved);
            setKeepAlivePanes([keepAlivePane]);
          }}
        >
          Keep-alive
        </button>
        {(
          [
            ["before", "Before file counts"],
            ["live", "Live file counts"],
            ["done", "Completed file counts"],
          ] as const
        ).map(([phase, label]) => (
          <button
            key={phase}
            onClick={() => {
              setKeepAlivePanes([]);
              setEvents(fileCountsReplay(phase));
            }}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => {
            setKeepAlivePanes([]);
            // A fresh durable read, without optimistic rows to fill gaps.
            setEvents(JSON.parse(JSON.stringify(fileCountsReplay("done"))));
          }}
        >
          Reload file counts
        </button>
      </nav>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
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
          terminalPanes={keepAlivePanes}
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
