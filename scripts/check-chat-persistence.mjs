import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(
  new URL("../apps/desktop/src/App.tsx", import.meta.url),
  "utf8",
);
const tree = ts.createSourceFile(
  "App.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function callback(name, context) {
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name)
      initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(initializer, name);
  const js = ts.transpileModule(
    `const callback = ${initializer.getText(tree)}; callback;`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;
  return vm.runInNewContext(js, { useCallback: (fn) => fn, ...context });
}

const draftKey = "new:/project";
let drafts = {
  [draftKey]: "Unsent first message",
  existing: "Existing chat draft",
};
let attachments = { [draftKey]: [{ id: "attachment" }] };
let selectedPane;
const context = {
  activeSession: { workspacePath: "/project" },
  activeSessionId: "existing",
  workspacePath: "/project",
  activeDraftKey: draftKey,
  chatProjectKey: (path) => path,
  suppressSessionAutoSelectRef: { current: false },
  activeSessionIdRef: { current: "existing" },
  SOLO_CHAT_PANE_ID: "solo",
  dispatchCompanion: () => {},
  dispatchWorkbench: () => {},
  dispatchChatGrid: (action) => {
    selectedPane = action.pane;
  },
  setIsStartingFirstTurn: () => {},
  setActiveSessionId: () => {},
  setDraftResetToken: () => {},
  setChatDrafts: (update) => {
    drafts = update(drafts);
  },
  setChatAttachments: (update) => {
    attachments = update(attachments);
  },
};
// Returning after another session replaced the draft pane must restore its text.
callback("startNewChat", context)();
assert.equal(selectedPane.draftKey, draftKey);
assert.equal(drafts[draftKey], "Unsent first message");
assert.equal(drafts.existing, "Existing chat draft");
assert.equal(attachments[draftKey][0].id, "attachment");
// Sending the first message must clear that project draft, not a global key.
callback("resetChatDraft", context)();
assert.equal(drafts[draftKey], "");
assert.equal(attachments[draftKey].length, 0);
assert.equal(drafts.existing, "Existing chat draft");
console.log("Chat draft navigation and send regression checks passed.");

// Stop must pause before awaiting the provider, so completion cannot race the queue.
const stoppedChatSessionsRef = { current: new Set() };
let resolveStop;
const stopChat = callback("stopChatSession", {
  stoppedChatSessionsRef,
  invoke: () =>
    new Promise((resolve) => {
      resolveStop = resolve;
    }),
  setQueueRetryTick: () => {},
  notify: () => {},
});
stopChat("existing");
assert.ok(stoppedChatSessionsRef.current.has("existing"));
resolveStop(true);
await Promise.resolve();
assert.ok(stoppedChatSessionsRef.current.has("existing"));
console.log(
  "Manual stop pauses queue delivery synchronously and stays paused.",
);
