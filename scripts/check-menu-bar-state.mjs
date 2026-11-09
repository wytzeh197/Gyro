import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  deriveLatestMenuBarOutcome,
  deriveMenuBarJobs,
  deriveMenuBarSnapshot,
} from "../apps/desktop/src/menu-bar-state.ts";
import { menuBarModelProvider } from "../apps/desktop/src/menu-bar-model-provider.ts";
import {
  approvalCanBeAnsweredInline,
  menuBarPresentation,
  menuBarStatus,
} from "../apps/desktop/src/menu-bar-presentation.ts";

const notifications = {
  enabled: true,
  approvals: true,
  finished: true,
  failed: true,
};

// A mismatch clips request controls in the transparent native window.
const menuCss = readFileSync(
  new URL("../apps/desktop/src/menu-bar.css", import.meta.url),
  "utf8",
);
const menuRust = readFileSync(
  new URL("../apps/desktop/src-tauri/src/menu_bar.rs", import.meta.url),
  "utf8",
);
for (const [token, native] of Object.entries({
  header: "HEADER_HEIGHT",
  row: "ROW_HEIGHT",
  approval: "APPROVAL_HEIGHT",
  question: "QUESTION_HEIGHT",
  overflow: "OVERFLOW_HEIGHT",
  footer: "FOOTER_HEIGHT",
  "gutter-top": "GUTTER_TOP",
  "gutter-x": "GUTTER_X",
  "gutter-bottom": "GUTTER_BOTTOM",
})) {
  assert.equal(
    Number(menuCss.match(new RegExp(`--menu-${token}: (\\d+)px`))?.[1]),
    Number(
      menuRust.match(
        new RegExp(`const MENU_BAR_${native}: f64 = (\\d+)\\.0`),
      )?.[1],
    ),
    `${token} geometry agrees across CSS and Rust`,
  );
}

const session = {
  id: "session-1",
  title: "Build the menu bar",
  workspacePath: "/tmp/Gyro",
  origin: "desktop",
  createdAt: "2026-07-19T09:00:00.000Z",
  updatedAt: "2026-07-19T09:00:05.000Z",
  eventsPath: "/tmp/events.jsonl",
  providerId: "openai",
  providerLabel: "OpenAI",
  modelId: "gpt-5.6-sol",
  modelLabel: "GPT-5.6 Sol",
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
assert.equal(jobs[1].providerId, "openai");
assert.equal(jobs[1].modelLabel, "GPT-5.6 Sol");
assert.equal(menuBarModelProvider(jobs[1]), "openai");
assert.equal(
  menuBarModelProvider({
    ...jobs[1],
    providerId: undefined,
    providerLabel: undefined,
    modelId: "claude-sonnet-5",
    modelLabel: "Claude Sonnet 5",
  }),
  "anthropic",
);
assert.equal(
  menuBarModelProvider({
    ...jobs[1],
    providerId: undefined,
    providerLabel: undefined,
    modelId: "grok-4.3",
    modelLabel: "Grok 4.3",
  }),
  "xai",
);
assert.equal(
  menuBarModelProvider({
    ...jobs[1],
    providerId: undefined,
    providerLabel: undefined,
    modelId: "k3",
    modelLabel: "Kimi K3",
  }),
  "kimi",
);
assert.equal(
  menuBarModelProvider({
    ...jobs[1],
    providerId: undefined,
    providerLabel: undefined,
    modelId: "gemini-default",
    modelLabel: "Gemini",
  }),
  "gemini",
);
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
  notifications,
});
assert.equal(attention.state, "attention");
// An approval without a provider payload has nothing to answer inline.
assert.equal(attention.jobs[0].approval, undefined);

const approvalRequest = {
  id: "approval-3",
  sessionId: session.id,
  turnId: "turn-1",
  createdAt: "2026-07-19T09:00:13.000Z",
  kind: "approval-requested",
  message: "Run command",
  payload: {
    kind: "provider-tool-approval",
    approvalId: "approval-uuid",
    approvalType: "command",
    command: "pnpm   test\n  --filter desktop",
    status: "pending",
  },
};
const otherSession = { ...session, id: "session-2", title: "Other chat" };
const approvalJobs = deriveMenuBarJobs({
  automations: [],
  sendingSessionIds: [session.id, otherSession.id],
  sessionEventsById: {
    [session.id]: [...runningEvents, approvalRequest],
    [otherSession.id]: runningEvents.map((event) => ({
      ...event,
      sessionId: otherSession.id,
      createdAt: "2026-07-19T09:05:00.000Z",
    })),
  },
  sessions: [session, otherSession],
});
// Waiting work leads even though the other chat started later.
assert.equal(approvalJobs[0].targetId, session.id);
assert.deepEqual(approvalJobs[0].approval, {
  id: "approval-uuid",
  approvalType: "command",
  summary: "pnpm   test\n  --filter desktop",
});
assert.equal(approvalJobs[1].approval, undefined);

const questionEvent = {
  ...approvalRequest,
  id: "question-1",
  kind: "assistant-message",
  message: "A decision first.",
  payload: {
    questions: {
      questions: [
        {
          question: "Show all tasks or only the current one?",
          options: ["All tasks", "Current task"],
        },
      ],
    },
  },
};
const questionInput = {
  automations: [],
  sessions: [session, otherSession],
  sendingSessionIds: [otherSession.id],
  sessionEventsById: {
    [session.id]: [...runningEvents, questionEvent],
    [otherSession.id]: runningEvents,
  },
  theme: "dark",
  reduceMotion: false,
  notifications,
};
const reply = deriveMenuBarSnapshot(questionInput);
assert.equal(reply.state, "attention");
assert.equal(reply.totalActive, 2);
assert.equal(
  reply.jobs[0].canStop,
  false,
  "a completed question turn has no live process to stop",
);
assert.deepEqual(reply.jobs[0].question, {
  id: "question-1",
  summary: "Show all tasks or only the current one?",
});
assert.equal(
  reply.jobs[0].approval,
  undefined,
  "a written answer is not an inline approval",
);
assert.equal(menuBarStatus(reply).label, "1 needs reply");
assert.equal(menuBarPresentation(reply).visibleJobs.length, 1);
assert.equal(menuBarPresentation(reply).summary, "1 other task running");
const answered = deriveMenuBarSnapshot({
  ...questionInput,
  sessionEventsById: {
    ...questionInput.sessionEventsById,
    [session.id]: [
      ...runningEvents,
      questionEvent,
      {
        ...runningEvents[0],
        id: "answer",
        turnId: "turn-2",
        message: "All tasks",
      },
    ],
  },
});
assert.equal(
  answered.jobs.some((job) => job.question),
  false,
  "sending an answer clears the question",
);
const streaming = deriveMenuBarSnapshot({
  ...questionInput,
  sendingSessionIds: [session.id],
});
assert.equal(
  streaming.jobs[0].question,
  undefined,
  "partial streamed questions are not actionable",
);
const imported = deriveMenuBarSnapshot({
  ...questionInput,
  sendingSessionIds: [],
  sessionEventsById: {
    [session.id]: [...runningEvents, questionEvent].map((event) => ({
      ...event,
      payload: { ...event.payload, historical: true },
    })),
  },
});
assert.equal(
  imported.jobs.length,
  0,
  "imported questions do not become live requests",
);
const laterProgress = {
  ...runningEvents[1],
  id: "progress-after-request",
  createdAt: "2026-07-19T09:00:14.000Z",
};
const pendingAfterProgress = deriveMenuBarJobs({
  ...questionInput,
  sendingSessionIds: [session.id],
  sessionEventsById: {
    [session.id]: [...runningEvents, approvalRequest, laterProgress],
  },
});
assert.equal(
  pendingAfterProgress[0].approval.id,
  "approval-uuid",
  "progress cannot erase an unresolved approval",
);
const resolved = {
  ...approvalRequest,
  id: "approved",
  kind: "system-event",
  payload: { ...approvalRequest.payload, status: "approved" },
};
const approved = deriveMenuBarJobs({
  ...questionInput,
  sendingSessionIds: [session.id],
  sessionEventsById: {
    [session.id]: [...runningEvents, approvalRequest, resolved, laterProgress],
  },
});
assert.equal(approved[0].approval, undefined);
assert.equal(
  approved[0].status,
  "running",
  "the menu returns to running after approval",
);
assert.equal(
  approvalCanBeAnsweredInline({
    ...approvalJobs[0],
    approval: { ...approvalJobs[0].approval, approvalType: "file-change" },
  }),
  false,
);
const longCommand = "pnpm test\n" + "--filter=long-package ".repeat(30);
const fullRequest = deriveMenuBarJobs({
  ...questionInput,
  sendingSessionIds: [session.id],
  sessionEventsById: {
    [session.id]: [
      ...runningEvents,
      {
        ...approvalRequest,
        payload: { ...approvalRequest.payload, command: longCommand },
      },
    ],
  },
});
assert.equal(
  fullRequest[0].approval.summary,
  longCommand.trim(),
  "the approval must retain the exact full command",
);
const manyReplies = {
  ...reply,
  jobs: [
    ...Array.from({ length: 6 }, (_, i) => ({
      ...reply.jobs[0],
      id: `question-${i}`,
    })),
    reply.jobs[1],
  ],
};
assert.equal(menuBarPresentation(manyReplies).visibleJobs.length, 4);
assert.equal(
  menuBarPresentation(manyReplies).summary,
  "+2 more waiting · 1 other task running",
);

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
assert.equal(outcome.providerId, session.providerId);
assert.equal(outcome.modelLabel, session.modelLabel);
const resultWithoutSession = deriveMenuBarJobs({
  automations: [],
  sessions: [],
  sendingSessionIds: [],
  sessionEventsById: {},
  finishedOutcomes: [outcome],
});
assert.equal(
  resultWithoutSession[0].providerId,
  session.providerId,
  "finished chats retain their AI logo identity without a session lookup",
);
assert.equal(
  deriveLatestMenuBarOutcome(
    [session],
    { [session.id]: [...completedEvents, questionEvent] },
    [],
  ),
  undefined,
  "a question is awaiting a reply, not completed work",
);
const waitingWithOldResult = deriveMenuBarSnapshot({
  ...questionInput,
  finishedOutcomes: [outcome],
});
assert.equal(
  waitingWithOldResult.jobs.filter((job) => job.targetId === session.id).length,
  1,
);

// A research sub-agent keeps its transcript in a session of its own. That run
// is not a chat the user started, so finishing it is not a chat outcome: the
// turn waiting on it reports its own.
const researchSession = {
  ...session,
  id: "session-research",
  title: "Research: where do sidebar chats come from?",
  parentSessionId: session.id,
};
assert.equal(
  deriveLatestMenuBarOutcome(
    [session, researchSession],
    { [researchSession.id]: completedEvents },
    [],
  ),
  undefined,
);
const complete = deriveMenuBarSnapshot({
  automations: [],
  finishedOutcomes: [outcome],
  outcome,
  reduceMotion: true,
  sendingSessionIds: [],
  sessionEventsById: { [session.id]: completedEvents },
  sessions: [session],
  theme: "light",
  notifications,
});
assert.equal(complete.state, "complete");
assert.equal(complete.jobs.length, 1);
assert.equal(complete.jobs[0].status, "finished");
assert.equal(complete.jobs[0].canStop, false);
assert.equal(complete.jobs[0].providerId, "openai");
assert.equal(complete.jobs[0].modelLabel, "GPT-5.6 Sol");
assert.equal(complete.totalActive, 0);
assert.equal(complete.reduceMotion, true);
assert.equal(
  menuBarStatus({ ...complete, state: "idle" }).label,
  "Finished",
  "a settled tray icon does not relabel a visible result Ready",
);

const mixed = deriveMenuBarSnapshot({
  automations: [automation],
  finishedOutcomes: [outcome],
  outcome,
  reduceMotion: false,
  sendingSessionIds: [],
  sessionEventsById: { [session.id]: completedEvents },
  sessions: [session],
  theme: "dark",
  notifications,
});
assert.equal(mixed.state, "working");
assert.equal(mixed.jobs.length, 2);
assert.equal(mixed.totalActive, 1);

const failed = deriveMenuBarSnapshot({
  automations: [],
  outcome: { ...outcome, id: "failed-1", status: "failed" },
  reduceMotion: false,
  sendingSessionIds: [],
  sessionEventsById: {},
  sessions: [session],
  theme: "dark",
  notifications,
});
assert.equal(failed.state, "attention");

console.log("Menu bar state checks passed.");
