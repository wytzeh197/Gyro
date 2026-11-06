import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../apps/desktop/src/App.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
let consumeCallback;
let turnGoal;
let loadDraftModes;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "changeChatMode")
    callback = node.initializer.arguments[0].getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "consumeDraftMode")
    consumeCallback = node.initializer.arguments[0].getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "turnGoal")
    turnGoal = node.initializer.getText(ast);
  if (ts.isFunctionDeclaration(node) && node.name?.getText(ast) === "loadChatDraftModes")
    loadDraftModes = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback);
assert.ok(consumeCallback);
assert.ok(turnGoal);
assert.ok(loadDraftModes);
const js = ts.transpileModule("globalThis.changeMode = " + callback + "; globalThis.consumeMode = " + consumeCallback, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
}).outputText;
const updates = [];
const goal = {text:"Ship the outcome", status:"active"};
const context = {
  activeDraftKey:"draft",
  activeSessionGoal:goal,
  chatDraftModesRef:{current:{}},
  chatDraftModeRevisionsRef:{current:{}},
  setChatDraftModes:modes => updates.push(modes),
  setPendingNewChatGoal:() => assert.fail("Mode change cleared pending goal"),
  setEvents:() => assert.fail("Choosing a draft mode changed the running turn"),
  invoke:() => assert.fail("Choosing a draft mode wrote a session event"),
};
vm.runInNewContext(js, context);
context.changeChatMode = context.changeMode;
assert.equal(context.changeMode("plan", "session-a"), true);
assert.equal(context.chatDraftModesRef.current["session-a"], "plan");
assert.equal(context.chatDraftModesRef.current.draft, undefined);
assert.equal(context.activeSessionGoal, goal);
const revision = context.chatDraftModeRevisionsRef.current["session-a"];
context.consumeMode("session-a", revision);
assert.equal(context.chatDraftModesRef.current["session-a"], undefined);
assert.equal(context.changeMode("plan", "session-a"), true);
context.changeMode("normal", "session-a");
context.changeMode("plan", "session-a");
context.consumeMode("session-a", revision + 1);
assert.equal(context.chatDraftModesRef.current["session-a"], "plan", "an older send must not clear a newer selection");
assert.ok(updates.length >= 4);
const loaderJs = ts.transpileModule(loadDraftModes + "; globalThis.loadModes = loadChatDraftModes", {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
}).outputText;
const storedModeContext = {
  CHAT_DRAFT_MODES_STORAGE_KEY:"gyro.chat-draft-modes-v1",
  readBoundedLocalStorage:() => JSON.stringify({draft:"plan", chat:"council", old:"normal", bad:"unexpected"}),
};
vm.runInNewContext(loaderJs, storedModeContext);
assert.deepEqual(JSON.parse(JSON.stringify(storedModeContext.loadModes())), {draft:"plan", chat:"council"});
storedModeContext.readBoundedLocalStorage = () => "not json";
assert.deepEqual(JSON.parse(JSON.stringify(storedModeContext.loadModes())), {});
const saved = {text:"Saved outcome"};
const override = {text:"Override outcome"};
for (const mode of ["normal","plan","council"]) {
  assert.equal(vm.runInNewContext(turnGoal,{overrideContext:undefined, activeSessionGoal:saved, turnMode:mode}),saved);
  assert.equal(vm.runInNewContext(turnGoal,{overrideContext:{goal:override}, activeSessionGoal:saved, turnMode:mode}),override);
  assert.equal(vm.runInNewContext(turnGoal,{overrideContext:{goal:undefined}, activeSessionGoal:saved, turnMode:mode}),undefined);
}
console.log("Goal and draft-only mode checks passed: no event on selection, one-shot consumption, restart restoration, and outgoing goals.");
