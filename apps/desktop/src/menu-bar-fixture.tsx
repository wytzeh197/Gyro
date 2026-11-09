import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  MenuBarJob,
  MenuBarSnapshot,
  Session,
  SessionEvent,
} from "@gyro-dev/ui";
import { MenuBarPopoverView } from "./MenuBarPopover";
import { deriveMenuBarSnapshot } from "./menu-bar-state";
import "@gyro-dev/ui/styles.css";
import "./menu-bar.css";

document.documentElement.dataset.surface = "menu-bar";
document.documentElement.dataset.theme = "dark";

const now = Date.parse("2026-11-07T15:00:00Z");
const session: Session = {
  id: "layout",
  title: "Fix menu bar layout",
  workspacePath: "/tmp/menu-bar-fixture",
  origin: "desktop",
  createdAt: "2026-11-07T14:57:46Z",
  updatedAt: "2026-11-07T14:57:46Z",
  eventsPath: "/tmp/menu-bar-fixture/events.jsonl",
  providerId: "anthropic",
  providerLabel: "Claude",
};
const user: SessionEvent = {
  id: "user",
  sessionId: session.id,
  turnId: "turn",
  kind: "user-message",
  createdAt: session.createdAt,
  message: "Improve the menu",
  payload: {},
};
const running: SessionEvent = {
  ...user,
  id: "activity",
  kind: "system-event",
  message: "Editing components",
  payload: { kind: "provider-status", status: "running" },
};
const other: MenuBarJob = {
  id: "other",
  kind: "chat",
  targetId: "review",
  title: "Review changes",
  detail: "Reading files",
  status: "running",
  startedAt: "2026-11-07T14:59:12Z",
  canStop: true,
  providerId: "openai",
  providerLabel: "OpenAI",
};
const third: MenuBarJob = {
  ...other,
  id: "tests",
  targetId: "tests",
  title: "Write tests",
  detail: "Writing tests",
  startedAt: "2026-11-07T14:58:57Z",
  providerId: "gemini",
  providerLabel: "Gemini",
};
const base: MenuBarSnapshot = {
  state: "idle",
  jobs: [],
  totalActive: 0,
  theme: "dark",
  reduceMotion: false,
  notifications: {
    enabled: true,
    approvals: true,
    finished: true,
    failed: true,
  },
};
const modes = [
  "Idle",
  "Working",
  "Approval",
  "Reply",
  "Finished",
  "Failure",
  "File review",
  "Long question",
  "Many requests",
  "Loading",
  "Unavailable",
] as const;
type Mode = (typeof modes)[number];

function initial(mode: Mode): MenuBarSnapshot {
  if (mode === "Idle" || mode === "Loading" || mode === "Unavailable")
    return base;
  const question =
    mode === "Reply" || mode === "Long question" || mode === "Many requests";
  const approval = mode === "Approval" || mode === "File review";
  const currentSession: Session = question
    ? {
        ...session,
        id: "review",
        title: "Review changes",
        providerId: "openai",
        providerLabel: "OpenAI",
      }
    : session;
  const event: SessionEvent = question
    ? {
        ...user,
        id: "question",
        kind: "assistant-message",
        payload: {
          questions: {
            questions: [
              {
                question:
                  mode === "Long question"
                    ? "Which behavior should the menu use? ".repeat(35)
                    : "Should I review the whole branch or only the latest commit?",
                options: ["Whole branch", "Latest commit"],
              },
            ],
          },
        },
        message: "A decision first.",
      }
    : approval
      ? {
          ...user,
          id: "approval",
          kind: "approval-requested",
          message: "Permission to run a command",
          payload: {
            kind: "provider-tool-approval",
            approvalId: "approval-1",
            approvalType: mode === "File review" ? "file-change" : "command",
            command:
              mode === "File review"
                ? "Update src/MenuBarPopover.tsx"
                : "pnpm typecheck",
            status: "pending",
          },
        }
      : running;
  const snapshot = deriveMenuBarSnapshot({
    automations: [],
    sessions: [currentSession],
    sendingSessionIds: question ? [] : [currentSession.id],
    sessionEventsById: {
      [currentSession.id]: [
        { ...user, sessionId: currentSession.id },
        { ...event, sessionId: currentSession.id },
      ],
    },
    theme: "dark",
    reduceMotion: false,
    notifications: base.notifications,
  });
  if (mode === "Finished" || mode === "Failure")
    return {
      ...base,
      state: mode === "Failure" ? "attention" : "complete",
      recentOutcome: {
        id: "outcome",
        kind: "chat",
        targetId: mode === "Finished" ? third.targetId : session.id,
        title: mode === "Finished" ? third.title : session.title,
        detail: "Result",
        status: mode === "Failure" ? "failed" : "succeeded",
        finishedAt: "2026-11-07T15:00:00Z",
        providerId: mode === "Finished" ? third.providerId : session.providerId,
        providerLabel:
          mode === "Finished" ? third.providerLabel : session.providerLabel,
      },
    };
  if (mode === "Many requests")
    return {
      ...snapshot,
      totalActive: 8,
      jobs: [
        ...Array.from({ length: 6 }, (_, index) => ({
          ...snapshot.jobs[0]!,
          id: `request-${index}`,
          targetId: `chat-${index}`,
          title: `Question ${index + 1}`,
        })),
        other,
        third,
      ],
    };
  const background = question
    ? [
        {
          ...other,
          id: session.id,
          targetId: session.id,
          title: session.title,
          detail: "Editing components",
          providerId: session.providerId,
          providerLabel: session.providerLabel,
        },
        third,
      ]
    : [other, third];
  return {
    ...snapshot,
    jobs: [...snapshot.jobs, ...background],
    totalActive: 3,
  };
}

function Fixture() {
  const [mode, setMode] = useState<Mode>("Idle");
  const [snapshot, setSnapshot] = useState(base);
  const [lastAction, setLastAction] = useState("None");
  const [failActions, setFailActions] = useState(false);
  async function action(label: string) {
    setLastAction(label);
    if (failActions)
      throw new Error("Request could not be completed. Try again.");
  }
  return (
    <>
      <style>{`
      :root[data-surface="menu-bar"] body, :root[data-surface="menu-bar"] #root { height: 100%; overflow: auto; background: #ececeb !important; }
      .menu-fixture-tools { font: 13px system-ui; color: #161617; padding: 20px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      .menu-fixture-tools button { padding: 6px 10px; }
      .menu-fixture-stage { width: 404px; margin: 24px auto; }
      .menu-fixture-stage .gyro-menu-bar-shell, .menu-fixture-stage .gyro-menu-bar-popover { height: auto; }
      .menu-fixture-stage .gyro-menu-bar-header { height: calc(var(--menu-header) - 1px); }
      .menu-fixture-stage .gyro-menu-bar-content { max-height: 520px; }
      .menu-fixture-actions { font: 13px system-ui; color: #161617; text-align: center; padding: 12px; }
    `}</style>
      <nav aria-label="Fixture controls" className="menu-fixture-tools">
        {modes.map((item) => (
          <button
            aria-pressed={mode === item}
            key={item}
            onClick={() => {
              setMode(item);
              setSnapshot({ ...initial(item), theme: snapshot.theme });
              setLastAction("None");
            }}
          >
            {item}
          </button>
        ))}
        <button
          onClick={() => {
            const theme = snapshot.theme === "dark" ? "light" : "dark";
            document.documentElement.dataset.theme = theme;
            setSnapshot({ ...snapshot, theme });
          }}
        >
          Toggle theme
        </button>
        <label>
          <input
            type="checkbox"
            checked={failActions}
            onChange={(event) => setFailActions(event.target.checked)}
          />
          Fail actions
        </label>
      </nav>
      <div className="menu-fixture-stage">
        <MenuBarPopoverView
          key={mode}
          snapshot={snapshot}
          now={now}
          loading={mode === "Loading"}
          unavailable={mode === "Unavailable"}
          onOpen={async (target) => {
            await action(`Open ${target.kind}:${target.targetId}`);
          }}
          onOpenGyro={async () => {
            await action("Open Gyro");
          }}
          onOpenSettings={async () => {
            await action("Open settings:general");
          }}
          onApprove={async (job) => {
            await action(`Approve ${job.approval?.id}`);
            setSnapshot((current) => ({
              ...current,
              state: "working",
              jobs: current.jobs.map((item) =>
                item.id === job.id
                  ? {
                      ...item,
                      status: "running",
                      detail: "Continuing after approval",
                      approval: undefined,
                    }
                  : item,
              ),
            }));
          }}
          onStop={async (job) => {
            await action(`Stop ${job.targetId}`);
            setSnapshot((current) => ({
              ...current,
              jobs: current.jobs.filter((item) => item.id !== job.id),
              totalActive: current.totalActive - 1,
            }));
          }}
        />
      </div>
      <p className="menu-fixture-actions" role="status">
        Last action: {lastAction}
      </p>
    </>
  );
}

const fixtureRoot =
  import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot)
  import.meta.hot.dispose((data) => {
    data.root = fixtureRoot;
  });
fixtureRoot.render(<Fixture />);
