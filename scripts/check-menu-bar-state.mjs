import assert from "node:assert/strict";

import {
  deriveLatestMenuBarOutcome,
  deriveMenuBarJobs,
  deriveMenuBarSnapshot,
} from "../apps/desktop/src/menu-bar-state.ts";

const session = {
  id: "session-1",
  title: "Build the menu bar",
  workspacePath: "/tmp/Gyro",
  origin: "desktop",
  createdAt: "2026-07-19T09:00:00.000Z",
  updatedAt: "2026-07-19T09:00:05.000Z",
  eventsPath: "/tmp/events.jsonl",
};

const runningEvents = [
  {
    id: "user-1",
    sessionId: session.id,
    turnId: "turn-1",
    createdAt: "2026-07-19T09:00:10.000Z",
    kind: "user-message",
    message: "Implement it",
    payload: {},
  },
  {
    id: "status-1",
    sessionId: session.id,
    turnId: "turn-1",
    createdAt: "2026-07-19T09:00:11.000Z",
    kind: "system-event",
    message: "Inspecting the app",
    payload: { kind: "provider-status", status: "running" },
  },
];

const automation = {
  id: "automation-1",
  title: "Nightly smoke",
  prompt: "Run smoke checks",
  schedule: "daily",
  status: "current",
  triageState: "none",
  project: "Gyro",
  provider: "OpenAI",
  branch: "main",
  workspaceMode: "local",
  lastResult: "Automation is running",
  unreadResults: 0,
  runHistory: [
    {
      id: "run-1",
      status: "running",
      startedAt: "2026-07-19T09:01:00.000Z",
      summary: "Running smoke checks",
    },
  ],
};

const jobs = deriveMenuBarJobs({
  automations: [automation],
  sendingSessionIds: [session.id],
  sessionEventsById: { [session.id]: runningEvents },
  sessions: [session],
});
assert.equal(jobs.length, 2);
assert.equal(jobs[0].kind, "automation");
assert.equal(jobs[1].kind, "chat");
assert.equal(jobs[1].status, "running");
assert.equal(
  jobs.some((job) => job.kind === "terminal"),
  false,
);

const waitingJobs = deriveMenuBarJobs({
  automations: [],
  sendingSessionIds: [session.id],
  sessionEventsById: {
    [session.id]: [
      ...runningEvents,
      {
        id: "approval-1",
        sessionId: session.id,
        turnId: "turn-1",
        createdAt: "2026-07-19T09:00:12.000Z",
        kind: "approval-requested",
        message: "Allow file edit?",
        payload: { status: "waiting" },
      },
    ],
  },
  sessions: [session],
});
assert.equal(waitingJobs[0].status, "waiting");

const attention = deriveMenuBarSnapshot({
  automations: [],
  sendingSessionIds: [session.id],
  sessionEventsById: {
    [session.id]: [
      ...runningEvents,
      {
        id: "approval-2",
        sessionId: session.id,
        turnId: "turn-1",
        createdAt: "2026-07-19T09:00:13.000Z",
        kind: "approval-requested",
        message: "Allow command?",
        payload: {},
      },
    ],
  },
  sessions: [session],
  theme: "dark",
  reduceMotion: false,
});
assert.equal(attention.state, "attention");

const completedEvents = [
  ...runningEvents,
  {
    id: "done-1",
    sessionId: session.id,
    turnId: "turn-1",
    createdAt: "2026-07-19T09:02:00.000Z",
    kind: "system-event",
    message: "OpenAI answered",
    payload: {
      kind: "provider-status",
      status: "done",
      completedAt: "2026-07-19T09:02:00.000Z",
    },
  },
];
const outcome = deriveLatestMenuBarOutcome(
  [session],
  { [session.id]: completedEvents },
  [],
);
assert.equal(outcome?.status, "succeeded");
const complete = deriveMenuBarSnapshot({
  automations: [],
  outcome,
  reduceMotion: true,
  sendingSessionIds: [],
  sessionEventsById: { [session.id]: completedEvents },
  sessions: [session],
  theme: "light",
});
assert.equal(complete.state, "complete");
assert.equal(complete.reduceMotion, true);

const failed = deriveMenuBarSnapshot({
  automations: [],
  outcome: { ...outcome, id: "failed-1", status: "failed" },
  reduceMotion: false,
  sendingSessionIds: [],
  sessionEventsById: {},
  sessions: [session],
  theme: "dark",
});
assert.equal(failed.state, "attention");

console.log("Menu bar state checks passed.");
