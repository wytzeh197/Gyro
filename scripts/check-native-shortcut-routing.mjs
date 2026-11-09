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
    ts.isCallExpression(node) &&
    node.expression.getText(parsed) === "listen" &&
    node.arguments[0]?.getText(parsed) === '"desktop-shortcut"'
  )
    callback = node.arguments[1];
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.ok(callback);
const { outputText } = ts.transpileModule(
  `result=(${callback.getText(parsed)});`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
const calls = [];
const ref = {
  current: (event) => calls.push(["initial", event.key, event.metaKey]),
};
class KeyboardEvent {
  constructor(type, options) {
    this.type = type;
    Object.assign(this, options);
  }
}
const context = {
  disposed: false,
  appShortcutHandler: ref,
  KeyboardEvent,
  result: undefined,
};
vm.runInNewContext(outputText, context);
context.result({ payload: { key: "k" } });
assert.deepEqual(calls, [["initial", "k", true]]);
ref.current = (event) => calls.push(["latest", event.key, event.metaKey]);
context.result({ payload: { key: "k" } });
assert.deepEqual(calls.at(-1), ["latest", "k", true]);
context.result({ payload: { key: "t" } });
assert.equal(
  calls.length,
  2,
  "unknown native commands cannot invoke a shortcut",
);
context.disposed = true;
context.result({ payload: { key: "k" } });
assert.equal(calls.length, 2, "a disposed subscription cannot dispatch");
console.log(
  JSON.stringify(
    {
      passed: true,
      checks: [
        "native Search calls the existing handler",
        "native Search uses the latest handler",
        "unknown keys ignored",
        "disposed listener ignored",
      ],
    },
    null,
    2,
  ),
);
