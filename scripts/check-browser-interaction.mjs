// Execute the normal App's native-browser owner routing callback.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const source = readFileSync(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
const parsed = ts.createSourceFile(
  "App.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let callback;
function visit(node) {
  if (
    ts.isBinaryExpression(node) &&
    node.left.getText(parsed) === "nativeBrowserInteraction.current"
  )
    callback = node.right;
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.ok(callback);
const { outputText } = ts.transpileModule(
  `result = (${callback.getText(parsed)});`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
const alpha = {
  paneId: "draft-migrated-alpha",
  kind: "session",
  sessionId: "alpha",
};
const beta = { paneId: "beta-pane", kind: "session", sessionId: "beta" };
const draft = {
  paneId: "draft-pane",
  kind: "draft",
  workspacePath: "/Project with spaces",
};
const results = [];
for (const test of [
  {
    name: "native Alpha click selects its stable migrated pane",
    sessionId: "alpha",
    resourceId: "live",
    expected: alpha,
  },
  {
    name: "native Beta click selects Beta",
    sessionId: "beta",
    resourceId: "live",
    expected: beta,
  },
  {
    name: "closed browser resource is ignored",
    sessionId: "alpha",
    resourceId: "old",
  },
  { name: "removed pane is ignored", sessionId: "removed", resourceId: "live" },
  {
    name: "maximized-away Alpha is ignored",
    sessionId: "alpha",
    resourceId: "live",
    maximized: beta.paneId,
  },
  {
    name: "visible maximized Beta remains selectable",
    sessionId: "beta",
    resourceId: "live",
    maximized: beta.paneId,
    expected: beta,
  },
  {
    name: "project draft click selects that draft",
    sessionId: "workbench:/Project with spaces",
    resourceId: "live",
    expected: draft,
  },
  {
    name: "folderless draft click selects that draft",
    sessionId: "workbench",
    resourceId: "live",
    slots: [{ paneId: "empty-draft", kind: "draft" }],
    expected: { paneId: "empty-draft", kind: "draft" },
  },
]) {
  const calls = [];
  const context = {
    result: undefined,
    displayedChatLayout: { slots: test.slots || [alpha, beta, draft, null] },
    chatGrid: { maximizedPaneId: test.maximized },
    workbench: {
      browserPreviewsBySession: {
        [test.sessionId]: { nativeResourceId: "live" },
      },
    },
    focusChatPane: (pane) => calls.push(pane),
  };
  try {
    vm.runInNewContext(outputText, context);
    context.result({ sessionId: test.sessionId, resourceId: test.resourceId });
    assert.deepEqual(calls, test.expected ? [test.expected] : []);
    results.push({ name: test.name, passed: true });
  } catch (error) {
    results.push({ name: test.name, passed: false, error: String(error) });
  }
}
console.log(
  JSON.stringify(
    { passed: results.every((r) => r.passed), checks: results },
    null,
    2,
  ),
);
if (results.some((r) => !r.passed)) process.exitCode = 1;
