// Execute actual App callbacks for draft browsers and stable chat-pane owners.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createSessionBrowserQueue } from "../apps/desktop/src/session-browser-queue.ts";
import { chatGridReducer } from "../packages/ui/src/workbench-state.ts";

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
function callback(name, dependencies) {
  let declaration;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name)
      declaration = node;
    if (!declaration) ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(declaration, `${name} is present in the App`);
  const { outputText } = ts.transpileModule(
    `${declaration.parent.parent.getText(parsed)}\nexports.callback = ${name};`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  );
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    useCallback: (value) => value,
    ...dependencies,
  });
  return exports.callback;
}
const results = [];
async function check(name, run) {
  try {
    await run();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}
const url = "http://127.0.0.1:4319/browser-observation.html";
await check(
  "folderless draft navigation reaches the native open command",
  async () => {
    const owner = { sessionId: "workbench", workspaceKey: "", draftKey: "new" };
    const calls = [];
    const snapshot = {
      ...owner,
      resourceId: "draft-page",
      url,
      loading: false,
      viewport: { mode: "auto" },
    };
    const invoke = async (command, args) => {
      calls.push([command, args]);
      return snapshot;
    };
    const open = callback("ensureSessionBrowser", {
      activeBrowserOwner: owner,
      isTauriRuntime: () => true,
      sendBrowserAction() {},
      previewForBrowser: () => ({}),
      sessionBrowserNative: createSessionBrowserQueue(invoke),
      invoke,
      normalizedPreviewUrl: (value) => value,
      notify() {},
      workbench: {},
    });
    await open(url);
    assert.equal(
      calls.filter(([name]) => name === "session_browser_open").length,
      1,
    );
  },
);
for (const sessionId of [
  "workbench",
  "workbench:/tmp/Project with spaces",
  "00000000-0000-4000-8000-000000000001",
]) {
  await check(`capture attaches to its draft for ${sessionId}`, async () => {
    const owner = {
      sessionId,
      workspaceKey: "",
      draftKey: `draft:${sessionId}`,
    };
    let attachments = {};
    const attach = callback("attachBrowserCaptureToChat", {
      isTauriRuntime: () => true,
      NEW_CHAT_DRAFT_KEY: "new",
      invoke: async (command, { request }) => {
        assert.equal(command, "prepare_chat_attachment");
        // The native attachment API accepts "new" or a durable chat UUID.
        assert.match(request.sessionId, /^(new|[0-9a-f-]{36})$/);
        return { kind: "image", path: "/tmp/prepared.png" };
      },
      setChatAttachments: (update) => {
        attachments = update(attachments);
      },
      convertFileSrc: (value) => value,
    });
    await attach(
      {
        path: "/tmp/capture.png",
        filename: "capture.png",
        src: "asset://capture",
      },
      owner,
    );
    assert.equal(attachments[owner.draftKey]?.length, 1);
    assert.equal(attachments[owner.draftKey][0].previewUrl, "asset://capture");
  });
}
const project = "/tmp/Browser review project";
const alpha = "00000000-0000-4000-8000-000000000001";
const beta = "00000000-0000-4000-8000-000000000002";
const replacement = "00000000-0000-4000-8000-000000000003";
const draftPane = {
  kind: "draft",
  paneId: "draft:alpha",
  draftKey: "alpha",
  workspacePath: project,
};
const betaPane = {
  kind: "session",
  paneId: `session:${beta}`,
  sessionId: beta,
  workspacePath: project,
};
const grid = {
  activeProjectKey: project,
  layouts: {
    [project]: {
      projectKey: project,
      slots: [draftPane, betaPane, null, null],
      focusedPaneId: betaPane.paneId,
      arrangement: "grid",
    },
  },
};
const migrated = chatGridReducer(grid, {
  type: "migrate-draft-pane",
  draftKey: "alpha",
  sessionId: alpha,
  workspacePath: project,
});
const originalPane = {
  kind: "session",
  paneId: `session:${alpha}`,
  sessionId: alpha,
  workspacePath: project,
};
const rekeyed = chatGridReducer(
  {
    ...grid,
    layouts: {
      [project]: {
        ...grid.layouts[project],
        slots: [originalPane, betaPane, null, null],
      },
    },
  },
  {
    type: "rekey-session-pane",
    fromSessionId: alpha,
    toSessionId: replacement,
    workspacePath: project,
  },
);
for (const [name, layout, paneId, expected] of [
  [
    "closing a migrated draft pane closes its own chat browser",
    migrated.layouts[project],
    draftPane.paneId,
    [alpha],
  ],
  [
    "closing a rekeyed pane closes its current chat browser",
    rekeyed.layouts[project],
    originalPane.paneId,
    [replacement],
  ],
  [
    "closing an unfocused draft preserves the active chat browser",
    grid.layouts[project],
    draftPane.paneId,
    [`workbench:${project}`],
  ],
  [
    "a removed pane cannot close the active chat browser",
    grid.layouts[project],
    "pane:removed",
    [],
  ],
  [
    "a solo pane closes the active browser",
    grid.layouts[project],
    "solo",
    [beta],
  ],
  [
    "an ordinary session pane closes its own browser",
    grid.layouts[project],
    betaPane.paneId,
    [beta],
  ],
]) {
  await check(name, async () => {
    const closed = [],
      actions = [];
    const props = callback("companionSurfaceProps", {
      workspaceReviewEntry: undefined,
      codeReviewClient: () => ({}),
      projectMemoryClient: () => ({}),
      workbench: { preferences: {} },
      providerLedgerById: {},
      sideChatFor() {},
      subagentController: { forPane() {} },
      SOLO_CHAT_PANE_ID: "solo",
      activeSessionId: beta,
      sessionForPane: (id) =>
        layout.slots.find((pane) => pane?.paneId === id)?.sessionId,
      chatCompanionPane: () => ({ openTabs: ["browser"] }),
      companion: {},
      setCompanionWidth() {},
      closeLegacyRail() {},
      openCompanionTab() {},
      dispatchCompanion() {},
      displayedChatLayout: layout,
      sessionBrowserKey: beta,
      isTauriRuntime: () => true,
      sessionBrowserNative: {
        close(id) {
          closed.push(id);
          return Promise.resolve();
        },
      },
      notify() {},
      dispatchWorkbench: (action) => actions.push(action),
    });
    props(paneId).onCloseCompanionTab("browser");
    assert.deepEqual(closed, expected);
    assert.deepEqual(
      actions
        .filter((action) => action.type === "browser-session")
        .map((action) => action.sessionId),
      expected,
    );
  });
}
console.log(
  JSON.stringify(
    { passed: results.every((result) => result.passed), checks: results },
    null,
    2,
  ),
);
if (!results.every((result) => result.passed)) process.exitCode = 1;
