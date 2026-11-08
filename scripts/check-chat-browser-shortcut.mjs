import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const source = readFileSync(
  process.env.GYRO_SHORTCUT_APP_SOURCE ||
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
let handler;
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(parsed) === "onKeyDown" &&
    node.initializer?.getText(parsed).includes("workspaceCommandForKeybinding")
  )
    handler = node.initializer;
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.ok(handler);
const { outputText } = ts.transpileModule(
  `result=(${handler.getText(parsed)});`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
const results = [];
for (const test of [
  {
    name: "closed chat dock opens Browser for the focused pane",
    expected: [
      ["clear", "alpha"],
      ["browser", "alpha"],
    ],
  },
  {
    name: "split Beta receives Browser shortcut",
    pane: "beta-stable-id",
    expected: [
      ["clear", "beta-stable-id"],
      ["browser", "beta-stable-id"],
    ],
  },
  {
    name: "folderless draft can open Browser",
    workspace: "",
    pane: "solo-chat",
    expected: [
      ["clear", "solo-chat"],
      ["browser", "solo-chat"],
    ],
  },
  { name: "IDE keeps New Terminal", layout: "code", expected: [["terminal"]] },
  {
    name: "terminal grid keeps New Terminal",
    layout: "terminal-grid",
    expected: [["terminal"]],
  },
  {
    name: "a consumed companion shortcut is not run twice",
    prevented: true,
    expected: [],
  },
  {
    name: "a consumed editor/search shortcut stays consumed",
    key: "k",
    prevented: true,
    expected: [],
  },
  {
    name: "Cmd+K still opens global search",
    key: "k",
    expected: [["search", "global"]],
  },
  {
    name: "explicit workspace shortcut keeps precedence",
    custom: true,
    expected: [["command", "user-command"]],
  },
  { name: "plain typing does not invoke Browser", meta: false, expected: [] },
]) {
  const calls = [];
  const event = {
    key: test.key || "t",
    metaKey: test.meta ?? true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: !!test.prevented,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  const context = {
    result: undefined,
    navigator: { platform: "MacIntel" },
    workbench: {
      activeDestination: "workspace",
      activeWorkspaceLayout: test.layout || "thread",
      preferences: { workspaceKeybindings: {} },
      ide: {},
    },
    workspaceCommandForKeybinding: () =>
      test.custom ? { id: "user-command" } : undefined,
    activeSession: undefined,
    workspacePath: test.workspace ?? "/fixture",
    workspaceTrusted: true,
    companionFocusPaneId: test.pane || "alpha",
    clearPaneLegacyPanel: (p) => calls.push(["clear", p]),
    openCompanionTab: (tab, p) => calls.push([tab, p]),
    addTerminalPane: () => calls.push(["terminal"]),
    openGlobalSearch: (kind) => calls.push(["search", kind]),
    runCommandPaletteCommand: (id) => calls.push(["command", id]),
  };
  try {
    vm.runInNewContext(outputText, context);
    context.result(event);
    assert.deepEqual(calls, test.expected);
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
