import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../apps/desktop/src/App.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
let turnGoal;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "changeChatMode")
    callback = node.initializer.arguments[0].getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "turnGoal")
    turnGoal = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(callback);
assert.ok(turnGoal);
const js = ts.transpileModule("globalThis.changeMode = " + callback, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
}).outputText;
for (const native of [false, true]) {
  for (const sessionId of [undefined, "session"]) {
    for (const mode of ["plan", "council"]) {
      const events = [];
      const calls = [];
      const pendingModes = [];
      const goal = {text:"Ship the outcome", status:"active"};
      const context = {
        activeSessionId:sessionId, activeChatMode:"normal", activeSessionGoal:goal,
        setPendingNewChatMode:mode => pendingModes.push(mode),
        setPendingNewChatGoal:() => assert.fail("Mode change cleared pending goal"),
        isTauriRuntime:() => native,
        setEvents:update => events.push(...update([])),
        invoke:async (command,args) => calls.push({command,args}),
        refreshEvents:async () => {},
        notify:() => assert.fail("Unexpected mode error"),
      };
      vm.runInNewContext(js, context);
      assert.equal(await context.changeMode(mode), true);
      assert.equal(context.activeSessionGoal, goal);
      if (!sessionId) {
        assert.deepEqual(pendingModes,[mode]);
        assert.equal(calls.length + events.length,0);
      } else if (native) {
        assert.equal(calls.length,1);
        assert.equal(calls[0].args.eventKind,"chat-mode-changed");
        assert.equal(calls[0].args.payload.mode,mode);
      } else {
        assert.equal(events.length,1);
        assert.equal(events[0].kind,"chat-mode-changed");
        assert.equal(events[0].payload.mode,mode);
      }
    }
  }
}
const saved = {text:"Saved outcome"};
const override = {text:"Override outcome"};
for (const mode of ["normal","plan","council"]) {
  assert.equal(vm.runInNewContext(turnGoal,{overrideContext:undefined, activeSessionGoal:saved, turnMode:mode}),saved);
  assert.equal(vm.runInNewContext(turnGoal,{overrideContext:{goal:override}, activeSessionGoal:saved, turnMode:mode}),override);
}
console.log("Goal mode preservation checks passed: new/existing chats, native/browser, Plan/Council and outgoing goals.");
