// Evaluate the actual split ChatSurface props, including the native-bounds callback.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(
  process.env.GYRO_PANE_VISIBILITY_SOURCE ||
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
let paneSurface;
function visit(node) {
  if (
    ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(parsed) === "ChatSurface" &&
    node.attributes
      .getText(parsed)
      .includes("previewForBrowser(paneBrowserOwner)")
  )
    paneSurface = node;
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.ok(paneSurface, "real pane ChatSurface exists");
function evaluateProp(name, dependencies) {
  const attr = paneSurface.attributes.properties.find(
    (prop) => prop.name?.getText(parsed) === name,
  );
  assert.ok(attr?.initializer && ts.isJsxExpression(attr.initializer));
  const expression = attr.initializer.expression.getText(parsed);
  const { outputText } = ts.transpileModule(`result = (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  const context = { result: undefined, ...dependencies };
  vm.runInNewContext(outputText, context);
  return context.result;
}
const results = [];
for (const isFocused of [false, true])
  for (const browserOverlayOccluded of [false, true]) {
    try {
      const calls = [];
      const owner = { sessionId: "left-pane-owner" };
      const bounds = { x: 224, y: 160, width: 520, height: 330 };
      const dependencies = {
        isFocused,
        browserOverlayOccluded,
        paneBrowserOwner: owner,
        handleBrowserHostBoundsChange: (...args) => calls.push(args),
      };
      assert.equal(
        evaluateProp("browserOverlayOccluded", dependencies),
        browserOverlayOccluded,
        "pane focus must not hide a visible browser; global overlays still must",
      );
      evaluateProp("onBrowserHostBoundsChange", dependencies)(bounds);
      assert.deepEqual(
        calls,
        [[bounds, owner]],
        "every visible pane reports bounds to its own native owner",
      );
      evaluateProp("onBrowserHostBoundsChange", dependencies)(null);
      assert.deepEqual(
        calls.at(-1),
        [null, owner],
        "unmount/occlusion hides that same owner",
      );
      results.push({ isFocused, browserOverlayOccluded, passed: true });
    } catch (error) {
      results.push({
        isFocused,
        browserOverlayOccluded,
        passed: false,
        error: String(error),
      });
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
