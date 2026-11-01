import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../apps/desktop/src/session-context-events.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "session-context-events.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const names = new Set([
  "deriveSessionPlan",
  "normalizePlanItem",
  "normalizePlanStatus",
  "turnIdFromSessionEvent",
  "recordFromUnknown",
  "stringFromRecord",
  "slugify",
]);
const functions = ast.statements.filter(
  (node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text),
);
assert.equal(functions.length, names.size);
const context = {};
vm.runInNewContext(
  ts.transpileModule(
    functions
      .map((node) => node.getText(ast).replace(/^export /, ""))
      .join("\n"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText,
  context,
);
const event = (kind, payload, message = "", turnId = "turn-1") => ({
  id: kind + turnId,
  kind,
  payload,
  message,
  turnId,
  createdAt: "2026-09-13T14:53:56Z",
});
const response = event(
  "assistant-message",
  {},
  "Implemented and verified the change.",
);
const checklist = event("plan-updated", {
  action: "replace",
  providerId: "kimi",
  items: [{ id: "kimi-plan-0", title: "Implement", status: "complete" }],
});
const mode = (chatMode) =>
  event("system-event", { kind: "provider-status", chatMode });
const derive = (events) => context.deriveSessionPlan(events, "session-1");
// Rehydrate the reported legacy normal run, including status after the plan event.
const normal = derive([response, checklist, mode("normal")]);
assert.equal(normal.content, undefined);
assert.equal(normal.sourceTurnId, undefined);
assert.equal(normal.items.length, 0);
const planned = derive([mode("plan"), response, checklist]);
assert.equal(planned.content, response.message);
assert.equal(planned.sourceTurnId, "turn-1");
assert.equal(planned.items.length, 1);
// Execution progress must retain an existing document and its original response link.
const progress = event(
  "plan-updated",
  {
    action: "update-items",
    items: [{ id: "kimi-plan-0", status: "complete" }],
  },
  "",
  "turn-2",
);
const updated = derive([
  mode("plan"),
  response,
  checklist,
  event("system-event", { chatMode: "normal" }, "", "turn-2"),
  progress,
]);
assert.equal(updated.content, response.message);
assert.equal(updated.sourceTurnId, "turn-1");
assert.equal(updated.items[0].status, "complete");
// Explicit document payloads are not inferred execution checklists.
assert.equal(
  derive([
    mode("normal"),
    event("plan-updated", {
      action: "replace",
      content: "Explicit document",
      items: [],
    }),
  ]).content,
  "Explicit document",
);
// Replaying the saved progress sequence must advance the reported 7/8 case.
const eightStepPlan = event("plan-updated", {
  action: "replace",
  content: "# UI upgrade",
  items: Array.from({ length: 8 }, (_, index) => ({
    id: `step-${index}`,
    title: index === 7 ? "Verify themes and accessibility" : `Step ${index + 1}`,
    status: index === 7 ? "in-progress" : "complete",
  })),
});
const finishVerification = event("plan-updated", {
  action: "update-items",
  items: [{ id: "step-7", status: "complete" }],
}, "", "turn-2");
const savedEvents = [eightStepPlan, response, finishVerification];
const finished = derive(JSON.parse(JSON.stringify(savedEvents)));
assert.equal(finished.items.filter(item => item.status === "complete").length, 8);
assert.equal(finished.items.some(item => item.status === "in-progress"), false);
assert.equal(finished.content, "# UI upgrade");
// Ending a reply alone is not evidence that unfinished acceptance passed.
const unfinished = derive([eightStepPlan, response]);
assert.equal(unfinished.items[7].status, "in-progress");
const blocked = derive([eightStepPlan, event("plan-updated", {
  action: "update-items",
  items: [{
    id: "step-7",
    status: "blocked",
    detail: "Requires native packaged-app acceptance",
  }],
}, "", "turn-2")]);
assert.equal(blocked.items[7].status, "blocked");
assert.equal(blocked.items[7].detail, "Requires native packaged-app acceptance");
console.log("Plan document regression checks passed.");
