import assert from "node:assert/strict";
import {
  CLOUD_CONTINUATION_MAX_CHARS,
  cloudChatContinuationContext,
  reviewedCloudContinuation,
} from "../packages/ui/src/cloud-chat-continuation.ts";
import {
  chatGridReducer,
  chatProjectKey,
  createInitialChatGridState,
  persistableChatGridState,
} from "../packages/ui/src/workbench-state.ts";

// Provider/runtime authority must have no serialization path into a new draft.
const context = cloudChatContinuationContext({
  title: "Reviewed archive",
  projectId: "remote-project-id",
  providerId: "remote-provider",
  approvals: [{ command: "remote-approval" }],
  messages: [
    { role: "user", text: "First complete message", runtimeId: "remote-run" },
    { role: "assistant", text: "Final complete answer", toolCalls: ["remote-tool"] },
  ],
});
assert.ok(context.includes("First complete message"));
assert.ok(context.includes("Final complete answer"));
assert.ok(context.includes("My new request:"));
for (const forbidden of ["remote-project-id", "remote-provider", "remote-approval", "remote-run", "remote-tool"])
  assert.ok(!context.includes(forbidden));
assert.throws(() => cloudChatContinuationContext({ title: "Unsupported", messages: [{ role: "tool", text: "execute" }] }));

// Do not silently lose any historical text when it exceeds the normal composer.
assert.throws(() => reviewedCloudContinuation("x".repeat(CLOUD_CONTINUATION_MAX_CHARS + 1)));
assert.equal(reviewedCloudContinuation("😀".repeat(CLOUD_CONTINUATION_MAX_CHARS)).length, 2 * CLOUD_CONTINUATION_MAX_CHARS);
assert.throws(() => reviewedCloudContinuation(" \u0000 "));
assert.equal(reviewedCloudContinuation("  reviewed text\u0000  "), "reviewed text");

// The actual layout reducer preserves existing drafts and refuses full grids.
const workspacePath = "/local/picked-project";
const projectKey = chatProjectKey(workspacePath);
let grid = createInitialChatGridState();
const append = (state, key) => chatGridReducer(state, {
  type: "select-pane", projectKey, mode: "drop",
  pane: { paneId: key, kind: "draft", draftKey: key, workspacePath },
});
grid = append(grid, "existing-local-draft");
grid = append(grid, "cloud-context:new-uuid");
assert.deepEqual(grid.layouts[projectKey].slots.filter(Boolean).map(p => p.draftKey), ["existing-local-draft", "cloud-context:new-uuid"]);
assert.equal(grid.layouts[projectKey].slots[1].kind, "draft");
assert.equal(persistableChatGridState(grid).layouts[projectKey].slots[1].draftKey, "cloud-context:new-uuid");
grid = append(grid, "third");
grid = append(grid, "fourth");
assert.equal(append(grid, "fifth"), grid);
console.log("Cloud continuation checks passed: text-only context, explicit bounded editing, durable fresh draft, existing-pane preservation and full-grid rejection. No provider request or native picker acceptance claimed.");
