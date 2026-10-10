import assert from "node:assert/strict";
import { sessionApprovalCounts } from "../packages/ui/src/session-approvals.ts";
import {
  subagentElapsedMs,
  subagentTokensLabel,
  sortedSubagents,
  subagentStatusLabel,
  subagentActivitySummary,
  mergeSubagentSnapshot,
  pendingSubagentApprovals,
  subagentProcessEvents,
  openSubagentTab,
  closeSubagentTab,
  subagentHue,
  subagentsForStatus,
  nativeSubagentParents,
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
assert.equal(subagentStatusLabel("waiting"), "Needs approval");
assert.equal(subagentStatusLabel("failed"), "Failed");
assert.deepEqual(
  sortedSubagents(
    ["completed", "running", "failed", "waiting"].map((status) => ({
      ...agent,
      agentId: status,
      status,
    })),
  ).map((item) => item.status),
  ["waiting", "failed", "running", "completed"],
  "approval and failures must remain visible ahead of ordinary progress",
);
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

assert.deepEqual(
  subagentActivitySummary([
    { status: "waiting" },
    { status: "failed" },
    { status: "running" },
  ]),
  {
    label: "1 needs approval · 1 needs attention · 1 working",
    needsAttention: true,
  },
);
assert.equal(
  subagentActivitySummary([{ status: "stopping" }]).label,
  "1 stopping",
);
assert.equal(
  subagentActivitySummary([{ status: "cancelled" }]).label,
  "1 cancelled",
);
assert.equal(
  subagentActivitySummary([{ status: "completed" }]).needsAttention,
  false,
);

// Sidebar approval state uses the same reconciliation as worker transcripts.
const attentionUser = {
  id: "attention-user",
  kind: "user-message",
  turnId: "attention-turn",
  payload: {},
};
const attentionRequest = (id, payload) => ({
  id,
  kind: "approval-requested",
  turnId: "attention-turn",
  payload,
});
const attentionProvider = attentionRequest("provider", {
  kind: "provider-tool-approval",
  approvalId: "shared-id",
  status: "pending",
});
const attentionMutation = attentionRequest("mutation", {
  kind: "mutation-approval",
  proposalId: "shared-id",
  status: "pending",
});
const attentionCapability = attentionRequest("capability", {
  kind: "capability-approval",
  approvalId: "capability-id",
  status: "waiting",
});
const attentionSessions = [
  { id: "first" },
  { id: "second" },
  { id: "imported", importSource: { sourceKind: "codex" } },
];
const attentionEvents = [
  attentionUser,
  attentionProvider,
  attentionMutation,
  attentionCapability,
];
assert.deepEqual(
  sessionApprovalCounts(attentionSessions, {
    first: attentionEvents,
    second: [attentionUser],
    imported: attentionEvents.map((event) => ({
      ...event,
      payload: { ...event.payload, historical: true },
    })),
  }),
  { first: 3 },
  "imported history cannot become a live approval and other chats keep independent state",
);
assert.deepEqual(
  sessionApprovalCounts(attentionSessions, { imported: attentionEvents }),
  { imported: 3 },
  "a new native turn in an imported chat still exposes its live approvals",
);
assert.equal(
  pendingSubagentApprovals([
    {
      ...attentionProvider,
      payload: { ...attentionProvider.payload, historical: true },
    },
  ]).length,
  0,
  "historical approval requests never force a live decision surface",
);
assert.deepEqual(
  sessionApprovalCounts(attentionSessions, {
    first: [...attentionEvents, { ...attentionProvider, id: "persisted-copy" }],
  }),
  { first: 3 },
  "optimistic and persisted copies count one approval",
);
const attentionDecisions = [
  {
    kind: "system-event",
    turnId: "attention-turn",
    payload: {
      kind: "provider-tool-approval",
      approvalId: "shared-id",
      status: "approved",
    },
  },
  {
    kind: "system-event",
    turnId: "attention-turn",
    payload: {
      kind: "mutation-approval",
      proposalId: "shared-id",
      status: "rejected",
    },
  },
  {
    kind: "system-event",
    turnId: "attention-turn",
    payload: {
      kind: "capability-approval",
      approvalId: "capability-id",
      status: "allowed",
    },
  },
];
assert.deepEqual(
  sessionApprovalCounts(attentionSessions, {
    first: [...attentionEvents, ...attentionDecisions],
  }),
  {},
  "decisions remove the approval marker without changing send or completion state",
);
assert.deepEqual(
  sessionApprovalCounts(attentionSessions, {
    first: [
      ...attentionEvents,
      { ...attentionUser, id: "next-user", turnId: "next-turn" },
      attentionProvider,
    ],
  }),
  {},
  "a late request from an older turn cannot mark the new turn",
);
assert.deepEqual(
  sessionApprovalCounts(attentionSessions, { first: [attentionProvider] }),
  {},
  "missing current-turn history cannot invent live approval state",
);
assert.deepEqual(
  sessionApprovalCounts(attentionSessions, {
    first: [
      { ...attentionUser, turnId: undefined },
      { ...attentionProvider, turnId: undefined },
    ],
  }),
  { first: 1 },
  "legacy untagged requests remain visible in their chronological turn",
);
console.log(
  "Sidebar approval checks passed: reconciliation, independent chats, imports, deduplication, and turn boundaries.",
);

// The status views partition lifecycle states without dropping failures or approvals.
const lifecycleAgents = [
  "running",
  "waiting",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
].map((status) => ({ ...agent, agentId: status, status }));
assert.deepEqual(
  subagentsForStatus(lifecycleAgents, "working").map((item) => item.status),
  ["waiting", "running", "stopping"],
);
assert.deepEqual(
  subagentsForStatus(lifecycleAgents, "done").map((item) => item.status),
  ["failed", "interrupted", "cancelled", "completed"],
);
assert.equal(
  subagentsForStatus(lifecycleAgents, "working").length +
    subagentsForStatus(lifecycleAgents, "done").length,
  lifecycleAgents.length,
);
assert.equal(subagentStatusLabel("running"), "Working");
assert.equal(subagentStatusLabel("completed"), "Done");
assert.equal(subagentHue("parser"), subagentHue("parser"));
assert.equal(new Set(["parser", "review", "tests"].map(subagentHue)).size, 3);
const nativeParent = "a8b13411-24ef-4d02-82aa-112233445566";
assert.deepEqual(
  nativeSubagentParents([
    "preview-123",
    nativeParent,
    "parent",
    "",
    nativeParent,
  ]),
  [nativeParent],
);
console.log(
  "Sub-agent status filters, stable identity colors, and native parent ID checks passed.",
);
