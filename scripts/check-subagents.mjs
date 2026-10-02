import assert from "node:assert/strict";
import {
  subagentElapsedMs,
  subagentTokensLabel,
  sortedSubagents,
  mergeSubagentSnapshot,
  pendingSubagentApprovals,
  subagentProcessEvents,
  openSubagentTab,
  closeSubagentTab,
} from "../packages/ui/src/subagents.ts";
import { applyProviderChatStreamPresentation } from "../apps/desktop/src/provider-stream-events.ts";
import {
  chatCompanionReducer,
  createInitialChatCompanionState,
  chatCompanionPane,
} from "../packages/ui/src/chat-companion.ts";
const agent = {
  agentId: "a",
  parentSessionId: "parent",
  name: "Parser",
  status: "running",
  createdAt: "2026-10-02T10:00:00Z",
  updatedAt: "2026-10-02T10:00:00Z",
  startedAt: "2026-10-02T10:00:00Z",
  elapsedMs: 5000,
  tokens: { totalTokens: 100, cachedInputTokens: 80, measured: true },
};
const now = Date.parse("2026-10-02T10:00:07Z");
assert.equal(subagentElapsedMs(agent, now), 12000);
assert.equal(
  subagentElapsedMs(
    { ...agent, status: "completed", startedAt: null, elapsedMs: 12000 },
    now + 60000,
  ),
  12000,
);
assert.equal(subagentElapsedMs({ ...agent, startedAt: "invalid" }, now), 5000);
assert.equal(subagentTokensLabel(agent), "100 tokens");
assert.equal(
  subagentTokensLabel({
    ...agent,
    tokens: { totalTokens: 123456, measured: true },
  }),
  `${(123456).toLocaleString()} tokens`,
);
assert.equal(
  subagentTokensLabel({
    ...agent,
    tokens: { totalTokens: 100, measured: false },
  }),
  "~100 tokens",
);
assert.equal(
  subagentTokensLabel({ ...agent, tokens: null }),
  "Usage unavailable",
);
assert.equal(
  subagentTokensLabel({ ...agent, tokens: { totalTokens: 0 } }),
  "0 tokens",
);
const settled = {
  ...agent,
  status: "completed",
  updatedAt: "2026-10-02T10:00:10Z",
  startedAt: null,
};
assert.equal(mergeSubagentSnapshot(settled, agent), settled);
assert.equal(
  mergeSubagentSnapshot(settled, { ...agent, updatedAt: settled.updatedAt }),
  settled,
);
assert.deepEqual(
  sortedSubagents([settled, { ...agent, agentId: "live" }]).map(
    (item) => item.agentId,
  ),
  ["live", "a"],
);
assert.equal(
  pendingSubagentApprovals([
    { kind: "approval-requested", payload: { status: "waiting" } },
    { kind: "approval-requested", payload: { status: "approved" } },
  ]).length,
  1,
);
const ref = { current: new Map() };
let events = [];
const frame = {
  sessionId: "child",
  turnId: "run",
  providerId: "openai",
  eventId: "tokens",
  sequence: 1,
  phase: "turn-tokens",
  turnTokens: { totalTokens: 100, measured: true },
};
const apply = (value) => {
  events = typeof value === "function" ? value(events) : value;
};
applyProviderChatStreamPresentation(ref, apply, frame);
applyProviderChatStreamPresentation(ref, apply, frame);
assert.equal(events.length, 1);
assert.equal(events[0].payload.turnTokens.totalTokens, 100);
applyProviderChatStreamPresentation(ref, apply, {
  ...frame,
  sequence: 2,
  turnTokens: { totalTokens: 250, measured: true },
});
assert.equal(events.length, 1);
assert.equal(events[0].payload.turnTokens.totalTokens, 250);
let state = createInitialChatCompanionState();
state = chatCompanionReducer(state, {
  type: "open-tab",
  tab: "agents",
  paneId: "parent-pane",
});
assert.equal(chatCompanionPane(state, "parent-pane").activeTab, "agents");
assert.equal(chatCompanionPane(state, "other-pane").activeTab, undefined);
state = chatCompanionReducer(state, {
  type: "close-dock",
  paneId: "parent-pane",
});
assert.deepEqual(chatCompanionPane(state, "parent-pane").openTabs, ["agents"]);
console.log(
  "sub-agent metrics, stream updates, history ordering, approvals, and companion checks passed",
);

const approvalHistory = [
  { id: "task", kind: "user-message", message: "Work" },
  {
    id: "state",
    kind: "system-event",
    payload: { kind: "provider-status", status: "running" },
  },
  {
    id: "ask",
    kind: "approval-requested",
    payload: {
      kind: "mutation-approval",
      proposalId: "edit",
      status: "pending",
    },
  },
  {
    id: "decision",
    kind: "system-event",
    payload: {
      kind: "mutation-approval",
      proposalId: "edit",
      status: "denied",
    },
  },
  {
    id: "call",
    kind: "system-event",
    payload: { kind: "capability-call", callId: "read", status: "running" },
  },
  {
    id: "done",
    kind: "system-event",
    payload: { kind: "capability-call", callId: "read", status: "completed" },
  },
];
assert.equal(
  pendingSubagentApprovals(approvalHistory).length,
  0,
  "reload must not revive decided child approvals",
);
const processEvents = subagentProcessEvents(approvalHistory);
assert.deepEqual(
  processEvents.map((event) => event.id),
  ["ask", "call"],
);
assert.equal(processEvents[1].payload.status, "completed");
assert.equal(processEvents[0].payload.status, "denied");

// Closing a process tab preserves its agent and the other open processes.
const firstTab = openSubagentTab({ openAgentIds: [] }, "parser");
const twoTabs = openSubagentTab(firstTab, "review");
const threeTabs = openSubagentTab(twoTabs, "tests");
const selectedParser = openSubagentTab(threeTabs, "parser");
assert.deepEqual(selectedParser.openAgentIds, ["parser", "review", "tests"]);
assert.equal(selectedParser.selectedAgentId, "parser");
assert.deepEqual(
  firstTab.openAgentIds,
  ["parser"],
  "opening tabs does not mutate earlier state",
);
const closedInactive = closeSubagentTab(selectedParser, "tests");
assert.equal(closedInactive.selectedAgentId, "parser");
assert.deepEqual(closedInactive.openAgentIds, ["parser", "review"]);
const closedSelected = closeSubagentTab(
  openSubagentTab(threeTabs, "review"),
  "review",
);
assert.equal(closedSelected.selectedAgentId, "parser");
assert.deepEqual(closedSelected.openAgentIds, ["parser", "tests"]);
const lastClosed = closeSubagentTab(firstTab, "parser");
assert.deepEqual(lastClosed.openAgentIds, []);
assert.equal(lastClosed.selectedAgentId, undefined);
assert.deepEqual(openSubagentTab(lastClosed, "parser"), firstTab);
assert.equal(closeSubagentTab(firstTab, "missing"), firstTab);
