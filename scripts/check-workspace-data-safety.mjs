import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  createInitialWorkbenchState,
  workbenchReducer,
} from "../packages/ui/src/workbench-state.ts";
import {
  draftSnapshot,
  mergeDurableEditRecovery,
  validateDraftSnapshot,
} from "../apps/desktop/src/editor/durable-edit-recovery.ts";

const path = "/project/extra/café notes.ts";
const buffer = (content, savedContent = "original") => ({
  path,
  content,
  savedContent,
  contentHash: "original-hash",
  sizeBytes: savedContent.length,
  status: "dirty",
  truncated: false,
  updatedAt: new Date(0).toISOString(),
});
let state = createInitialWorkbenchState();
state = workbenchReducer(state, {
  type: "ide-upsert-buffer",
  buffer: buffer("unsaved"),
});
const deleted = workbenchReducer(state, {
  type: "ide-delete-path",
  path: "/project/extra",
});
assert.equal(deleted.ide.buffers[path].content, "unsaved");
assert.equal(deleted.ide.buffers[path].status, "error");
assert(deleted.ide.tabs.some((tab) => tab.path === path));
const clean = workbenchReducer(state, {
  type: "ide-upsert-buffer",
  buffer: { ...buffer("original"), status: "ready" },
});
assert.equal(
  workbenchReducer(clean, { type: "ide-delete-path", path }).ide.buffers[path],
  undefined,
);

const replaced = {
  ...buffer("replacement", "replacement"),
  contentHash: "replacement-hash",
  status: "ready",
};
const action = {
  type: "ide-replace-buffer-saved",
  path,
  before: "original",
  beforeHash: "original-hash",
  buffer: replaced,
};
const completed = workbenchReducer(clean, action);
assert.equal(completed.ide.buffers[path].content, "replacement");
assert.equal(completed.ide.tabs.find((tab) => tab.path === path).dirty, false);
const raced = workbenchReducer(state, action);
assert.equal(raced.ide.buffers[path].content, "unsaved");
assert.equal(raced.ide.buffers[path].contentHash, "original-hash");
assert.equal(raced.ide.buffers[path].status, "conflict");

for (const status of ["dirty", "error", "conflict", "saving"]) {
  const large = {
    ...buffer("x".repeat(2 * 1024 * 1024), "y".repeat(2 * 1024 * 1024)),
    status,
  };
  const snapshot = validateDraftSnapshot(
    structuredClone(draftSnapshot({ [path]: large })),
  );
  const restored = mergeDurableEditRecovery(
    createInitialWorkbenchState(),
    snapshot,
  );
  assert.equal(restored.ide.buffers[path].content, large.content);
  assert.equal(
    restored.ide.buffers[path].status,
    status === "saving" ? "dirty" : status,
  );
  assert(
    restored.ide.tabs.some((tab) => tab.path === path),
    "Every recovered draft is reachable",
  );
}
const cleared = mergeDurableEditRecovery(state, draftSnapshot({}));
assert.deepEqual(
  cleared.ide.buffers,
  {},
  "A completed save/discard clears older recovery",
);
assert.throws(() => validateDraftSnapshot({ version: 1, buffers: {} }));

// A blocked open may finish after its caller has already retried. Retire that
// late connection instead of pinning an unusable promise or blocking upgrades.
const openRequests = [];
const recoveryExports = {};
vm.runInNewContext(
  ts.transpileModule(
    readFileSync(
      new URL(
        "../apps/desktop/src/editor/durable-edit-recovery.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText,
  {
    exports: recoveryExports,
    indexedDB: {
      open() {
        const request = {};
        openRequests.push(request);
        return request;
      },
    },
  },
);
const blockedOpen = recoveryExports.initializeDurableEditRecovery();
const blocked = assert.rejects(blockedOpen, /blocked/);
openRequests[0].onblocked();
await blocked;
const retriedOpen = recoveryExports.initializeDurableEditRecovery();
// Attach rejection handling before assertions, so a regression reports the
// failed invariant rather than an unrelated unhandled promise rejection.
void retriedOpen.catch(() => {});
assert.equal(
  openRequests.length,
  2,
  "Blocked storage must permit an explicit retry",
);
let lateClosed = 0;
openRequests[0].result = {
  close() {
    lateClosed++;
  },
};
openRequests[0].onsuccess();
assert.equal(
  lateClosed,
  1,
  "A blocked open's late success must close its connection",
);
const reads = [];
let currentClosed = 0;
const db = {
  close() {
    currentClosed++;
  },
  transaction() {
    return {
      objectStore() {
        return {
          get() {
            const request = {};
            reads.push(request);
            return request;
          },
        };
      },
    };
  },
};
openRequests[1].result = db;
openRequests[1].onsuccess();
await Promise.resolve();
reads[0].onsuccess();
await retriedOpen;
db.onversionchange();
assert.equal(
  currentClosed,
  1,
  "Version upgrades must release the old connection",
);
const reopened = recoveryExports.initializeDurableEditRecovery();
assert.equal(
  openRequests.length,
  3,
  "Version changes must invalidate the connection cache",
);
openRequests[2].result = db;
openRequests[2].onsuccess();
await Promise.resolve();
reads[1].onsuccess();
await reopened;

// The compact legacy snapshot must also retain failed/conflicted edits.
const persistenceSource = readFileSync(
  new URL("../apps/desktop/src/app-state.tsx", import.meta.url),
  "utf8",
);
const persistenceTree = ts.createSourceFile(
  "state.tsx",
  persistenceSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const persistenceFunction = persistenceTree.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "persistableDirtyEditorBuffers",
);
const persistenceJs = ts.transpileModule(
  persistenceFunction.getText(persistenceTree).replace(/^export /, "") +
    "\npersistableDirtyEditorBuffers",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const persistLegacy = vm.runInNewContext(persistenceJs, {
  MAX_PERSISTED_DIRTY_BUFFER_CHARS: 500_000,
  MAX_PERSISTED_DIRTY_BUFFERS_TOTAL_CHARS: 1_000_000,
});
for (const error of ["changed on disk", "Permission denied"]) {
  const failed = workbenchReducer(state, {
    type: "ide-mark-buffer-error",
    path,
    error,
  });
  assert.equal(persistLegacy(failed.ide.buffers)[path].content, "unsaved");
}

// Execute the actual quit hook with its external ports supplied; no native app is closed.
const source = readFileSync(
  new URL("../apps/desktop/src/use-quit-confirmation.ts", import.meta.url),
  "utf8",
);
const tree = ts.createSourceFile(
  "quit.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const hook = tree.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "useQuitConfirmation",
);
const js = ts.transpileModule(
  hook.getText(tree).replace(/^export /, "") + "\nuseQuitConfirmation",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const calls = [];
const useQuit = vm.runInNewContext(js, {
  useState: () => [true, () => {}],
  useEffect: () => {},
  invoke: async (...args) => calls.push(args),
});
let finish;
const pending = useQuit(
  () =>
    new Promise((resolve) => {
      finish = resolve;
    }),
).resolve(true);
assert.equal(calls.length, 0, "Quit must wait for recovery to commit");
finish();
await pending;
assert.equal(calls[0][1].quit, true);
calls.length = 0;
await assert.rejects(
  useQuit(async () => {
    throw Error("disk full");
  }).resolve(true),
  /disk full/,
);
assert.equal(calls.length, 0, "Failed recovery must not authorize native exit");
await useQuit(async () => {
  throw Error("unused");
}).resolve(false);
assert.equal(calls[0][1].quit, false);

// A newly registered command must receive an explicit main-window permission.
const read = (path) =>
  readFileSync(
    new URL(`../apps/desktop/src-tauri/${path}`, import.meta.url),
    "utf8",
  );
const registered = read("src/app/setup.rs")
  .split(".invoke_handler(tauri::generate_handler![")[1]
  .split("])")[0]
  .split("\n")
  .filter((line) => line.trim().startsWith("crate::"))
  .map((line) => line.trim().replace(/,$/, "").split("::").at(-1))
  .sort();
const permission = (name) =>
  [...read(`permissions/${name}.toml`).matchAll(/^  "([a-z0-9_]+)",$/gm)]
    .map((match) => match[1])
    .sort();
assert.deepEqual(permission("main-commands"), registered);
assert.deepEqual(permission("menu-bar-commands"), [
  "get_menu_bar_snapshot",
  "hide_menu_bar_popover",
  "open_menu_bar_target",
  "resolve_provider_approval",
  "show_main_window",
  "stop_provider_chat",
]);
for (const name of ["main-commands", "menu-bar-commands"]) {
  const capability = JSON.parse(read(`capabilities/${name}.json`));
  assert.deepEqual(capability.webviews, [
    name === "main-commands" ? "main" : "menu-bar-popover",
  ]);
  assert.equal(
    capability.windows,
    undefined,
    "Window-wide grants would authorize embedded webviews too",
  );
  assert.equal(capability.remote, undefined);
}
console.log(
  "Workspace data safety passed: deletion retention, replacement races, 2 MiB recovery, quit commit/failure and command ACL coverage.",
);
