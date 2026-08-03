import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isOrphanAssistantFragment,
  isTransientStatusGreeting,
  peelAssistantPreambleBlocks,
  structuredCommentaryBlocks,
} from "../packages/ui/src/chat-commentary.ts";
import {
  buildRunModel,
  formatRunDuration,
  isGenericProviderToolLabel,
  isRunPhaseLive,
  runHeaderLabel,
  runRowText,
  splitToolName,
  workItemFromEvent,
} from "../packages/ui/src/chat-run.ts";

let sequence = 0;
const at = (minutes) =>
  new Date(
    Date.parse("2026-08-02T09:00:00.000Z") + minutes * 60_000,
  ).toISOString();

const event = (kind, message, payload = {}, minutes = 0) => {
  sequence += 1;
  return {
    id: `evt_${sequence}`,
    sessionId: "ses_1",
    turnId: "turn_1",
    createdAt: at(minutes),
    kind,
    message,
    payload,
  };
};

const activity = (activityKind, label, extra = {}, minutes = 0) =>
  event(
    "system-event",
    label,
    {
      kind: "provider-activity",
      activityKind,
      label,
      status: "done",
      ...extra,
    },
    minutes,
  );

const say = (message, minutes = 0) =>
  event("assistant-message", message, {}, minutes);

// --- the defect that motivated the rebuild ------------------------------------

// A real MCP identifier keeps its server and tool. The shape this replaces threw
// both away and rendered the string "Used a tool".
assert.deepEqual(
  splitToolName("mcp__github__create_issue"),
  { server: "github", tool: "create issue" },
  "an MCP tool name should survive as server and tool",
);
assert.deepEqual(
  splitToolName("gyro_capabilities__terminal_open"),
  { tool: "Terminal open" },
  "a capability id should lose its prefix, not its name",
);
assert.deepEqual(
  splitToolName("Read surfaces.tsx"),
  { tool: "Read surfaces.tsx" },
  "a name that is already prose should be left alone",
);

assert.deepEqual(
  runRowText({
    kind: "work",
    id: "evt_x",
    at: at(0),
    item: workItemFromEvent(
      activity("tool", "Used mcp  github  create issue", {
        detail: "mcp__github__create_issue",
      }),
    ),
  }),
  { label: "github · create issue" },
  "the row should name the tool rather than say a tool was used",
);

// --- no batching --------------------------------------------------------------

// Parallel calls arrive milliseconds apart. The reference design is a flat rail,
// so each one is its own row; nothing collapses them.
const parallel = buildRunModel([
  activity("tool", "Read a.ts", {}, 0),
  activity("tool", "Read b.ts", {}, 0),
  activity("command", "pnpm test", { detail: "pnpm test" }, 0),
]);
assert.equal(parallel.steps.length, 3, "each activity should be its own beat");
assert.ok(
  parallel.steps.every((step) => step.kind === "work"),
  "activities should all be work steps",
);

// --- the rail interleaves prose and work --------------------------------------

const interleaved = buildRunModel([
  say("Adding subscription options.", 0),
  activity("command", "Check the plan file", { detail: "cat plan.md" }, 1),
  say("Updating the business plan document.", 2),
  activity(
    "file",
    "Updated create_gyro_bp.js",
    { detail: "create_gyro_bp.js", additions: 73 },
    3,
  ),
  say("Summarizing the recent changes.", 4),
]);
assert.deepEqual(
  interleaved.steps.map((step) =>
    step.kind === "say" ? `say:${step.text}` : `work:${step.item.kind}`,
  ),
  [
    "say:Adding subscription options.",
    "work:command",
    "say:Updating the business plan document.",
    "work:file",
  ],
  "narration should keep its place among the work it introduced",
);
assert.equal(
  interleaved.response?.message,
  "Summarizing the recent changes.",
  "the closing message should be the answer, not a rail step",
);

// The model exposes no per-step clock: the rail is timestamp-free by design.
assert.ok(
  interleaved.steps.every((step) => !("clock" in step) && !("offset" in step)),
  "steps should not carry a gutter clock",
);

// --- files are live ------------------------------------------------------------

// The shape this replaces gated the file summary on the run being finished, so
// edits were invisible for the whole run.
const live = buildRunModel(
  [
    activity(
      "file",
      "Updated src/a.ts",
      { detail: "src/a.ts", additions: 12, deletions: 3 },
      0,
    ),
  ],
  { isRunning: true },
);
assert.deepEqual(
  live.files,
  [{ path: "src/a.ts", status: "done", additions: 12, deletions: 3 }],
  "a file edit should be tallied while the run is still going",
);

// A file touched twice is one entry carrying the latest status.
const touchedTwice = buildRunModel([
  activity(
    "file",
    "Updated src/a.ts",
    { detail: "src/a.ts", status: "running" },
    0,
  ),
  activity("file", "Updated src/a.ts", { detail: "src/a.ts", additions: 4 }, 1),
]);
assert.deepEqual(
  touchedTwice.files,
  [{ path: "src/a.ts", status: "done", additions: 4, deletions: undefined }],
  "repeat edits to one path should merge",
);

// Diff stats come from source control, not from the provider payload. Dropping
// that during the rewrite would leave every file row as a bare path.
const withStats = buildRunModel(
  [activity("file", "Updated src/b.ts", { detail: "src/b.ts" }, 0)],
  {
    fileStats: (path) =>
      path === "src/b.ts" ? { additions: 9, deletions: 2 } : undefined,
  },
);
assert.deepEqual(
  withStats.files,
  [{ path: "src/b.ts", status: "done", additions: 9, deletions: 2 }],
  "source-control stats should reach the file row",
);
// A payload that carries its own counts wins over the workspace lookup.
assert.deepEqual(
  buildRunModel(
    [
      activity(
        "file",
        "Updated src/b.ts",
        { detail: "src/b.ts", additions: 1 },
        0,
      ),
    ],
    { fileStats: () => ({ additions: 9, deletions: 2 }) },
  ).files[0].additions,
  1,
  "payload stats should win over the workspace lookup",
);

// --- phases --------------------------------------------------------------------

assert.deepEqual(
  buildRunModel([], { isRunning: true }).phase,
  { name: "thinking" },
  "a running turn with nothing yet is thinking",
);
assert.deepEqual(
  buildRunModel([activity("command", "pnpm test", {}, 0)], { isRunning: true })
    .phase,
  { name: "working" },
  "a running turn with work is working",
);
assert.deepEqual(
  buildRunModel([activity("command", "pnpm test", {}, 0), say("All set.", 1)], {
    isRunning: true,
  }).phase,
  { name: "finalizing" },
  "a running turn whose answer has arrived is finalizing",
);
assert.deepEqual(
  buildRunModel([say("All set.", 0)], { durationMs: 231_000 }).phase,
  { name: "done", durationMs: 231_000 },
  "a settled turn reports its duration",
);
assert.deepEqual(
  buildRunModel([], { status: { status: "failed", message: "Provider error" } })
    .phase,
  {
    name: "failed",
    message: "Provider error",
    recoveryKind: undefined,
    recoveryMessage: undefined,
  },
  "a failed turn carries its message",
);
// A turn left in flight by a restart is interrupted, not still working.
assert.deepEqual(
  buildRunModel([], { isRunning: false, status: { status: "running" } }).phase,
  { name: "interrupted" },
  "a stale in-flight turn is interrupted",
);

// --- the response rule ----------------------------------------------------------

// While running, an opening line with no work behind it is a preamble.
assert.equal(
  buildRunModel([say("I'll take a look.", 0)], { isRunning: true }).response,
  undefined,
  "an opening line should stay in the rail while the run is young",
);
assert.equal(
  buildRunModel([say("I'll take a look.", 0)]).response?.message,
  "I'll take a look.",
  "the same line closes the turn once the run has settled",
);

// A file edit reported after the closing text must not strand the answer.
const trailingFile = buildRunModel([
  activity("command", "pnpm build", {}, 0),
  say("Done — the build passes.", 1),
  activity("file", "Updated src/a.ts", { detail: "src/a.ts" }, 1),
]);
assert.equal(
  trailingFile.response?.message,
  "Done — the build passes.",
  "trailing file activity should not unseat the answer",
);
assert.equal(
  trailingFile.files.length,
  1,
  "the trailing edit should still be tallied",
);

// Work after the closing text does unseat it — the turn kept going.
assert.equal(
  buildRunModel([say("Done.", 0), activity("command", "pnpm test", {}, 1)])
    .response,
  undefined,
  "a command after the last message means it was not the answer",
);

// Multi-paragraph answers after tools must not swallow plan lines into the body.
const planThenAnswer = buildRunModel([
  say(
    "I'll look up the Gyro README and return its first sentence.\n\nChat, CLI, and IDE in one place.\n\nThat's the first sentence in README.md.",
    0,
  ),
  activity("tool", "Read README.md", { path: "README.md" }, 0),
  say(
    "I'll look up the Gyro README and return its first sentence.\n\nChat, CLI, and IDE in one place.\n\nThat's the first sentence in README.md.",
    1,
  ),
]);
// When the cumulative message lands after tools, preambles peel to the rail.
const afterTools = buildRunModel([
  activity("tool", "Read README.md", { path: "README.md" }, 0),
  say(
    "I'll look up the Gyro README and return its first sentence.\n\ne.\n\nChat, CLI, and IDE in one place.\n\nThat's the first sentence in README.md.",
    1,
  ),
]);
assert.equal(
  afterTools.response?.message.includes("Chat, CLI, and IDE in one place."),
  true,
  "the answer body should keep the real first sentence",
);
assert.equal(
  afterTools.response?.message.includes("I'll look up"),
  false,
  "plan preambles should not sit in the final response body",
);
assert.equal(
  (afterTools.response?.message ?? "")
    .split(/\n\s*\n/)
    .some((block) => block.trim() === "e."),
  false,
  "orphan stream fragments like 'e.' must not reach the answer",
);
assert.ok(
  afterTools.steps.some(
    (step) =>
      step.kind === "say" && step.text.includes("I'll look up the Gyro README"),
  ),
  "peeled plan lines should remain visible on the run rail",
);
assert.equal(isOrphanAssistantFragment("e."), true);
assert.equal(isOrphanAssistantFragment("Chat, CLI, and IDE in one place."), false);
assert.equal(isTransientStatusGreeting("Gyro chat mode is up."), true);
assert.equal(
  isTransientStatusGreeting("Chat, CLI, and IDE in one place."),
  false,
);
assert.deepEqual(
  structuredCommentaryBlocks(
    "Gyro chat mode is up.\n\nI received your Test message.\n\nWhat would you like to do next?",
  ),
  ["I received your Test message.", "What would you like to do next?"],
  "status greetings should be stripped from the final answer body",
);
assert.deepEqual(
  peelAssistantPreambleBlocks([
    "I'll look up the README.",
    "Chat, CLI, and IDE in one place.",
  ]),
  {
    preambles: ["I'll look up the README."],
    answer: ["Chat, CLI, and IDE in one place."],
  },
);
// Silence unused-binding noise when the first multi-block scenario is only for coverage.
assert.ok(planThenAnswer.steps.length >= 1);

// --- kinds and wording ------------------------------------------------------------

const rowText = (activityKind, label, extra) =>
  runRowText({
    kind: "work",
    id: "evt_x",
    at: at(0),
    item: workItemFromEvent(activity(activityKind, label, extra)),
  });

assert.deepEqual(rowText("command", "Ran it", { detail: "pnpm test" }), {
  label: "Ran command",
  description: "pnpm test",
});
assert.deepEqual(
  rowText("command", "Ran it", {
    detail: "pnpm test",
    intent: "Check the suite",
  }),
  { label: "Ran command", description: "Check the suite" },
  "a provider intent should win over the raw command",
);
assert.deepEqual(rowText("file", "Updated create_gyro_bp.js"), {
  label: "Edited file",
  description: "create_gyro_bp.js",
});
assert.deepEqual(
  rowText("search", "Searched", { scope: "project", query: "palette" }),
  {
    label: "Searched project",
    description: "palette",
  },
);
assert.deepEqual(rowText("memory", "Edited memory"), {
  label: "Edited memory",
});
assert.deepEqual(rowText("context", "Compacted context"), {
  label: "Compacted context",
});

// An unknown kind stays a beat rather than vanishing.
assert.deepEqual(rowText("something-new", "Rendered a diagram"), {
  label: "Rendered a diagram",
});

// ACP provider placeholders must not double as "Used tool · xAI tool".
assert.equal(isGenericProviderToolLabel("xAI tool"), true);
assert.equal(isGenericProviderToolLabel("Kimi tool"), true);
assert.equal(isGenericProviderToolLabel("Read README.md"), false);
assert.deepEqual(rowText("tool", "xAI tool"), { label: "Used tool" });
assert.deepEqual(
  rowText("read", "Read README.md", { path: "README.md" }),
  { label: "Read README.md" },
  "ACP read kinds should keep the read verb and path",
);
assert.deepEqual(
  splitToolName(
    '{"tool_input":{},"tool_name":"gyro_capabilities__gyro_workspace_get_context"}',
  ),
  { tool: "Workspace context" },
  "JSON tool payloads should unwrap to a human capability name",
);
assert.deepEqual(
  splitToolName("gyro_capabilities__gyro_workspace_get_context"),
  { tool: "Workspace context" },
  "capability tool ids should drop the gyro_capabilities prefix",
);
assert.deepEqual(
  rowText("tool", "gyro_capabilities__gyro_workspace_get_context"),
  { label: "Workspace context" },
  "the rail should show a clean capability name, not Used tool + machine id",
);

// Repeated updates for the same tool collapse to one beat.
const repeatedTool = buildRunModel([
  activity("tool", "gyro_capabilities__gyro_workspace_get_context", {}, 0),
  activity(
    "tool",
    '{"tool_name":"gyro_capabilities__gyro_workspace_get_context"}',
    {},
    0,
  ),
  activity(
    "tool",
    '{"tool_input":{},"tool_name":"gyro_capabilities__gyro_workspace_get_context","variant":"UseTool"}',
    {},
    0,
  ),
]);
assert.equal(
  repeatedTool.steps.filter((step) => step.kind === "work").length,
  1,
  "adjacent identical tool calls should coalesce on the rail",
);

// A running file edit says so.
assert.deepEqual(
  rowText("file", "Updated src/a.ts", {
    detail: "src/a.ts",
    status: "running",
  }),
  { label: "Editing file", description: "src/a.ts" },
);

// The backend names each kind's material explicitly rather than overloading
// `detail`. The named field wins, and `detail` stays the fallback so events
// persisted before that change keep rendering.
assert.deepEqual(
  rowText("command", "Ran it", { command: "pnpm build", detail: "ignored" }),
  { label: "Ran command", description: "pnpm build" },
  "the named command field should win over detail",
);
assert.deepEqual(
  rowText("file", "Updated x", { path: "src/c.ts", detail: "ignored" }),
  { label: "Edited file", description: "src/c.ts" },
  "the named path field should win over detail",
);
assert.deepEqual(
  rowText("tool", "Used it", { tool: "mcp__linear__create_issue" }),
  { label: "linear · create issue" },
  "the named tool field should win over detail",
);
assert.deepEqual(
  rowText("search", "Searched", { query: "backoff", scope: "project" }),
  { label: "Searched project", description: "backoff" },
  "the named query field should win over detail",
);

// --- what never reaches the rail ----------------------------------------------------

// Commentary is prose; it arrives as an assistant message, never as a work row.
assert.equal(
  workItemFromEvent(activity("commentary", "Let me check the config.")),
  undefined,
  "commentary should not become a work row",
);

// The hidden title marker is an instruction to the app, not a beat.
assert.equal(
  buildRunModel([
    activity("commentary", "GYRO_SESSION_TITLE: Rebuild the run UI", {}, 0),
    activity("command", "pnpm test", {}, 1),
  ]).steps.length,
  1,
  "the session title marker should be dropped",
);

// A non-activity system event becomes an approval beat rather than being lost.
const approval = buildRunModel([
  event("approval-requested", "Allow writing to src/a.ts?", {}, 0),
]);
assert.equal(approval.steps[0].kind, "ask", "approvals stay on the rail");

// --- the header ---------------------------------------------------------------

assert.equal(formatRunDuration(231), "3m 51s", "the reference header format");
assert.equal(
  formatRunDuration(0),
  "0s",
  "a run with no elapsed time still reads",
);
assert.equal(formatRunDuration(3_600), "1h", "whole hours drop empty places");
assert.equal(formatRunDuration(3_661), "1h 1m 1s");

assert.equal(runHeaderLabel({ name: "working" }, "12s"), "Working for 12s");
assert.equal(runHeaderLabel({ name: "thinking" }, "1s"), "Working for 1s");
assert.equal(
  runHeaderLabel({ name: "done", durationMs: 231_000 }, "3m 51s"),
  "Worked for 3m 51s",
);

// A failed or interrupted turn has no recorded end, so the header must not
// invent a duration from whenever the component happened to mount.
assert.equal(
  runHeaderLabel({ name: "failed", message: "Provider error" }, "9s"),
  "Stopped",
  "a failed turn should not claim a duration",
);
assert.equal(runHeaderLabel({ name: "interrupted" }, "9s"), "Interrupted");
assert.equal(
  runHeaderLabel({ name: "done" }, undefined),
  "Worked",
  "a settled turn with no duration recorded says so",
);

assert.ok(isRunPhaseLive({ name: "finalizing" }), "finalizing still ticks");
assert.ok(
  !isRunPhaseLive({ name: "interrupted" }),
  "interrupted does not tick",
);

// --- token discipline ------------------------------------------------------------

// Light mode is free only while the rail stays on tokens: `--gyro-*` values
// already flip at `:root[data-theme="light"]`. One hardcoded colour and the rail
// grows a ghost line in one theme, which is how `styles.css` accumulated its 280
// light overrides. The rule is only real if it is checked.
const stylesheet = readFileSync(
  new URL("../packages/ui/src/styles.css", import.meta.url),
  "utf8",
);
const railStart = stylesheet.indexOf("Run rail (gyro-run-*)");
assert.ok(railStart > 0, "the run rail block should be findable in styles.css");
// The marker sits inside the banner comment, and comments explain the rule by
// quoting the selector. Start past the banner, then drop the remaining comments,
// so only declarations are measured.
const bannerEnd = stylesheet.indexOf("*/", railStart);
const rail = stylesheet.slice(bannerEnd).replace(/\/\*[\s\S]*?\*\//g, "");

const literalColour = rail.match(
  /(?<![\w-])(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/gi,
);
assert.equal(
  literalColour,
  null,
  `the run rail must use only --gyro-* tokens, found: ${literalColour?.join(", ")}`,
);

const lightOverrides = rail.match(/:root\[data-theme="light"\]/g) ?? [];
assert.equal(
  lightOverrides.length,
  1,
  "the run rail allows exactly one light override (icon opacity, which is optical)",
);

console.log("chat run checks passed");
