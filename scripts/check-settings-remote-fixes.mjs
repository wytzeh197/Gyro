import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { RemoteHostClient } from "../apps/desktop/src/remote-access/client.ts";
import { mergeTerminalUpdate } from "../apps/desktop/src/remote-access/terminal-stream.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const input = (text) => ({
  op: "terminal",
  action: "input",
  sessionId: "s",
  paneId: "p",
  input: text,
});
const calls = [];
const terminal = new RemoteHostClient("ordered", {
  async invoke(_command, args) {
    const op = args.request.operation;
    calls.push(op);
    await sleep(50);
    return op.op === "claim" ? { generation: 9 } : {};
  },
});
const start = performance.now();
await Promise.all(
  Array.from({ length: 20 }, (_, n) =>
    terminal.input(input(String.fromCharCode(97 + n))),
  ),
);
const elapsed = Math.round(performance.now() - start);
assert.equal(calls.filter((op) => op.op === "claim").length, 1);
assert.deepEqual(
  calls.filter((op) => op.op === "terminal").map((op) => op.input),
  ["abcdefghijklmnopqrst"],
);
assert.ok(elapsed < 500, `burst took ${elapsed} ms`);
console.log(
  `20 ordered inputs at simulated 50 ms RTT: ${elapsed} ms including control claim; 1 input frame.`,
);
await terminal.input(input("!"));
assert.equal(
  calls.filter((op) => op.op === "claim").length,
  1,
  "reuse recent control without reclaims",
);

const pastedFrames = [];
const pastedClient = new RemoteHostClient("unicode-paste", {
  async invoke(_command, { request: { operation: op } }) {
    if (op.op === "claim") return { generation: 3 };
    if (new TextEncoder().encode(op.input).length > 64 * 1024)
      throw Error("Host rejected an oversized terminal input frame");
    pastedFrames.push(op.input);
    return {};
  },
});
const pastedText = "x".repeat(60 * 1024 - 1) + "😀" + "z".repeat(14 * 1024);
await pastedClient.input(input(pastedText));
assert.ok(
  pastedFrames.join("") === pastedText,
  "Large terminal paste preserves exact Unicode text and order",
);
assert.ok(
  pastedFrames.every(
    (text) => new TextEncoder().encode(text).length <= 60 * 1024,
  ),
);
assert.equal(pastedFrames.length, 2);
const admittedPaste = pastedClient.input(input("a".repeat(100 * 1024)));
await assert.rejects(
  pastedClient.input(input("b".repeat(40 * 1024))),
  /backed up|too large/,
);
await admittedPaste;
assert.ok(
  pastedFrames.slice(2).join("") === "a".repeat(100 * 1024),
  "Backpressure rejects the whole newer paste without corrupting admitted input",
);
const framesBeforeRejectedPaste = pastedFrames.length;
await assert.rejects(
  pastedClient.input(input("😀".repeat(40 * 1024))),
  /too large/,
);
assert.equal(pastedFrames.length, framesBeforeRejectedPaste);
await pastedClient.input(input(""));
assert.equal(
  pastedFrames.at(-1),
  "",
  "An explicit empty input settles without stalling the queue",
);
await pastedClient.input(input(""));
assert.equal(pastedFrames.at(-1), "", "An explicitly empty input settles once");
const beforeRejectedPaste = pastedFrames.length;
await assert.rejects(
  pastedClient.input(input("😀".repeat(33 * 1024))),
  /paste is too large/,
);
assert.equal(
  pastedFrames.length,
  beforeRejectedPaste,
  "Queue admission rejects an oversized UTF-8 paste before sending any portion",
);
let pasteAttempts = 0;
const uncertainPasteFrames = [];
const uncertainPaste = new RemoteHostClient("uncertain-paste", {
  async invoke(_command, { request: { operation: op } }) {
    if (op.op === "claim") return { generation: 1 };
    uncertainPasteFrames.push(op.input);
    if (++pasteAttempts === 2)
      throw Error("connection lost after a partial paste");
    return {};
  },
});
await assert.rejects(uncertainPaste.input(input(pastedText)), /partial paste/);
await sleep(30);
assert.equal(
  uncertainPasteFrames.length,
  2,
  "A failed chunk never replays the earlier applied part",
);
assert.ok(uncertainPasteFrames.join("") === pastedText);

let chunkAttempts = 0;
const interruptedPaste = new RemoteHostClient("interrupted-paste", {
  async invoke(_command, { request: { operation: op } }) {
    if (op.op === "claim") return { generation: 5 };
    if (++chunkAttempts === 2) throw Error("Connection lost after input write");
    return {};
  },
});
const interrupted = await Promise.allSettled([
  interruptedPaste.input(input(pastedText)),
  interruptedPaste.input(input("!")),
]);
assert.ok(interrupted.every((result) => result.status === "rejected"));
await sleep(25);
assert.equal(
  chunkAttempts,
  2,
  "Uncertain paste chunks and later keystrokes are never replayed",
);

let attempts = 0;
const failed = new RemoteHostClient("lost", {
  async invoke(_command, args) {
    if (args.request.operation.op === "claim") return { generation: 1 };
    attempts++;
    await sleep(10);
    throw Error("connection lost after write");
  },
});
const failures = await Promise.allSettled([
  failed.input(input("a")),
  failed.input(input("b")),
]);
assert.ok(failures.every((r) => r.status === "rejected"));
assert.equal(attempts, 1, "uncertain bytes are never replayed");

let active = 0,
  peak = 0;
const ports = {
  async invoke() {
    peak = Math.max(peak, ++active);
    await sleep(5);
    active--;
    return [];
  },
};
const first = new RemoteHostClient("budget", ports),
  second = new RemoteHostClient("budget", ports);
await Promise.all(
  Array.from({ length: 50 }, (_, i) =>
    (i % 2 ? first : second).request({ op: "sessions", projectId: String(i) }),
  ),
);
assert.equal(peak, 8, "budget is shared by catalog and workspace clients");

const admission = [],
  releases = [];
const backgroundClient = new RemoteHostClient("input-priority", {
  async invoke(_command, { request: { operation } }) {
    admission.push(operation);
    await new Promise((resolve) => releases.push(resolve));
    return operation.op === "claim" ? { generation: 1 } : {};
  },
});
const priorityReads = Array.from({ length: 16 }, (_, index) =>
  backgroundClient.request({ op: "sessions", projectId: String(index) }),
);
const priorityInput = backgroundClient.request(input("x"));
await Promise.resolve();
releases.shift()();
await sleep(0);
const firstAfterSlot = admission[8]?.op;
for (let index = 0; index < 5; index++) {
  for (const release of releases.splice(0)) release();
  await sleep(0);
}
await Promise.all([...priorityReads, priorityInput]);
assert.equal(
  firstAfterSlot,
  "terminal",
  "Interactive terminal input must not queue behind catalog refreshes",
);
backgroundClient.dispose();

const fairAdmission = [],
  fairReleases = [];
let fairActive = 0,
  fairPeak = 0;
const fairClient = new RemoteHostClient("fair-budget", {
  invoke(_command, { request: { operation } }) {
    fairAdmission.push(operation.op);
    fairPeak = Math.max(fairPeak, ++fairActive);
    return new Promise((resolve) =>
      fairReleases.push(() => {
        fairActive--;
        resolve({ generation: 1 });
      }),
    );
  },
});
const fairWork = [
  ...Array.from({ length: 10 }, (_, i) =>
    fairClient.request({ op: "sessions", projectId: String(i) }),
  ),
  ...Array.from({ length: 8 }, (_, i) =>
    fairClient.request({ op: "claim", sessionId: String(i) }),
  ),
];
for (let i = 0; i < 4; i++) {
  fairReleases.shift()();
  await sleep(0);
}
const admittedAfterSaturation = fairAdmission.slice(8, 12);
for (let i = 0; i < 5; i++) {
  for (const release of fairReleases.splice(0)) release();
  await sleep(0);
}
await Promise.all(fairWork);
assert.equal(admittedAfterSaturation[0], "claim");
assert.ok(
  admittedAfterSaturation.includes("sessions"),
  "Interactive traffic cannot starve catalog work",
);
assert.equal(
  fairPeak,
  8,
  "Mixed-priority work retains the shared eight-request limit",
);
fairClient.dispose();

// Execute the real catalog hook with one failed project; retain the host and other projects.
const effects = [];
let catalogs = [];
const hooks = {
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useState: (v) => [
    v,
    (fn) => {
      catalogs = typeof fn === "function" ? fn(catalogs) : fn;
    },
  ],
  useEffect: (fn) => effects.push(fn),
};
const catalogPorts = {
  async invoke(_command, { request: { operation: op } }) {
    if (op.op === "hello") return { protocol: 1 };
    if (op.op === "projects")
      return Array.from({ length: 17 }, (_, i) => ({ id: String(i) }));
    if (op.projectId === "3") throw Error("one inaccessible project");
    return [{ id: `session-${op.projectId}` }];
  },
};
const exports = {};
const context = {
  exports,
  require: (id) => (id === "react" ? hooks : { RemoteHostClient }),
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
};
vm.createContext(context);
vm.runInContext(
  ts.transpileModule(
    fs.readFileSync(
      new URL("../apps/desktop/src/remote-access/catalog.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText,
  context,
);
const catalogController = exports.useRemoteCatalog(catalogPorts, [
  { id: "catalog", name: "Mac", role: "host" },
]);
const cleanup = effects[0]();
await sleep(40);
assert.equal(catalogs[0].online, true);
assert.equal(catalogs[0].projects.length, 17);
assert.equal(catalogs[0].projects[0].sessions.length, 1);
assert.match(catalogs[0].error, /Some projects/);

const catalogInvoke = catalogPorts.invoke;
let releaseCatalog;
const catalogGate = new Promise((resolve) => {
  releaseCatalog = resolve;
});
let catalogRefreshes = 0;
catalogPorts.invoke = async (...args) => {
  if (args[1].request.operation.op === "hello" && ++catalogRefreshes === 1)
    await catalogGate;
  return catalogInvoke(...args);
};
const refreshingCatalog = catalogController.refresh();
const queuedRefreshes = Array.from({ length: 5 }, () =>
  catalogController.refresh(),
);
releaseCatalog();
await Promise.all([refreshingCatalog, ...queuedRefreshes]);
await sleep(40);
cleanup();
assert.equal(
  catalogRefreshes,
  2,
  "Refreshes requested during an active catalog load coalesce into one follow-up",
);

let catalogEvent;
const eventCounts = new Map();
const eventPorts = {
  async invoke(_command, { hostId, request: { operation } }) {
    if (operation.op === "hello") {
      eventCounts.set(hostId, (eventCounts.get(hostId) ?? 0) + 1);
      return { protocol: 1 };
    }
    return [];
  },
  async listen(_event, handler) {
    catalogEvent = handler;
    return () => {};
  },
};
const eventEffect = effects.length;
exports.useRemoteCatalog(eventPorts, [
  { id: "catalog-a", name: "Mac A", role: "host" },
  { id: "catalog-b", name: "Mac B", role: "host" },
]);
const cleanupEvents = effects[eventEffect]();
await sleep(20);
eventCounts.clear();
catalogEvent({ payload: { hostId: "catalog-a", event: { topic: "refresh" } } });
catalogEvent({ payload: { hostId: "catalog-b", event: { topic: "refresh" } } });
await sleep(300);
assert.equal(
  eventCounts.get("catalog-a"),
  1,
  "Debouncing must retain the first host's refresh",
);
assert.equal(
  eventCounts.get("catalog-b"),
  1,
  "Debouncing must retain the second host's refresh",
);
cleanupEvents();

const snapshot = (output, start, end, generation = "g") => ({
  paneId: "p",
  output,
  outputRevision: end,
  outputCursor: { generation, start, end },
});
const initial = snapshot("aé", 0, 3);
const appended = mergeTerminalUpdate(initial, snapshot("b", 3, 4));
assert.equal(appended.output, "aéb");
assert.equal(
  mergeTerminalUpdate(appended, snapshot("b", 3, 4)),
  appended,
  "duplicate frame is ignored",
);
assert.equal(
  mergeTerminalUpdate(initial, snapshot("x", 4, 5)),
  undefined,
  "gap requires full catch-up",
);
assert.equal(
  mergeTerminalUpdate(initial, snapshot("new", 0, 3, "replacement")).output,
  "new",
);
console.log(
  "Remote regressions passed: ordered/coalesced input, uncertain-send failure, shared request budget, partial catalog, terminal cursor gap/duplicate/restart.",
);

// Blocked IDB opens can eventually succeed after a retry. Their obsolete
// connection must close rather than keep the database pinned behind an upgrade.
const requests = [];
const storage = {};
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync(
      new URL(
        "../apps/desktop/src/remote-access/buffer-storage.ts",
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
    exports: storage,
    indexedDB: {
      open() {
        const request = {};
        requests.push(request);
        return request;
      },
    },
    IDBKeyRange: { bound() {} },
  },
);
const blocked = storage.readBuffers("host");
const rejected = assert.rejects(blocked, /blocked/);
requests[0].onblocked();
await rejected;
const retried = storage.readBuffers("host");
assert.equal(requests.length, 2);
let lateClosed = 0;
requests[0].result = {
  close() {
    lateClosed++;
  },
};
requests[0].onsuccess();
assert.equal(
  lateClosed,
  1,
  "Abandoned remote storage connections must close on late success",
);
const transactions = [];
const db = {
  close() {},
  transaction() {
    const transaction = {
      objectStore() {
        return {
          openCursor() {
            return {};
          },
        };
      },
    };
    transactions.push(transaction);
    return transaction;
  },
};
requests[1].result = db;
requests[1].onsuccess();
await Promise.resolve();
transactions[0].oncomplete();
await retried;
db.onclose();
const reopened = storage.readBuffers("host");
assert.equal(
  requests.length,
  3,
  "Unexpected storage closure must permit reopening",
);
requests[2].result = db;
requests[2].onsuccess();
await Promise.resolve();
transactions[1].oncomplete();
await reopened;
console.log(
  "Remote storage lifecycle passed: blocked retry, abandoned connection cleanup and unexpected-close recovery.",
);

const viewExports = {};
let finishHydration;
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync(
      new URL(
        "../apps/desktop/src/remote-access/view-state.ts",
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
    exports: viewExports,
    localStorage: {
      getItem() {
        return null;
      },
    },
    require: () => ({
      readBuffers: () =>
        new Promise((resolve) => {
          finishHydration = resolve;
        }),
    }),
  },
);
const earlierView = { ...viewExports.emptyView(), drafts: { chat: "earlier" } };
viewExports.rememberView("hydrating", earlierView);
const hydration = viewExports.hydrateView("hydrating");
const latestView = {
  ...earlierView,
  drafts: { chat: "typed during hydration" },
  pendingSubmissions: { chat: { requestId: "latest-pending" } },
  buffers: { local: { text: "local edit" } },
};
viewExports.rememberView("hydrating", latestView);
finishHydration({ disk: { text: "recovered edit" } });
const hydrated = await hydration;
assert.equal(
  hydrated.drafts.chat,
  "typed during hydration",
  "Hydration must retain newer in-memory drafts",
);
assert.equal(
  hydrated.pendingSubmissions.chat.requestId,
  "latest-pending",
  "Hydration must retain current submit receipts",
);
assert.equal(hydrated.buffers.local.text, "local edit");
assert.equal(hydrated.buffers.disk.text, "recovered edit");
assert.equal(viewExports.readView("hydrating"), hydrated);
console.log(
  "Remote hydration preserves concurrent draft, pending-receipt and editor changes.",
);

const initialRenameView = {
  ...viewExports.emptyView(),
  buffers: { old: { text: "unsaved" } },
};
viewExports.rememberView("rename-during-hydration", initialRenameView);
const renameHydration = viewExports.hydrateView("rename-during-hydration");
viewExports.rememberView("rename-during-hydration", {
  ...initialRenameView,
  buffers: { renamed: { text: "unsaved" } },
});
finishHydration({
  old: { text: "earlier persisted content" },
  unrelated: { text: "another recovered draft" },
});
const renamedHydration = await renameHydration;
assert.equal(
  renamedHydration.buffers.old,
  undefined,
  "Hydration must not recreate a buffer removed during a rename",
);
assert.equal(renamedHydration.buffers.renamed.text, "unsaved");
assert.equal(
  renamedHydration.buffers.unrelated.text,
  "another recovered draft",
);

viewExports.rememberView("opened-and-renamed-during-hydration", viewExports.emptyView());
const lateRenameHydration = viewExports.hydrateView("opened-and-renamed-during-hydration");
viewExports.rememberView("opened-and-renamed-during-hydration", {
  ...viewExports.emptyView(), buffers: { old: { text: "opened while reading" } },
});
viewExports.rememberView("opened-and-renamed-during-hydration", {
  ...viewExports.emptyView(), buffers: { renamed: { text: "newer draft" } },
});
finishHydration({ old: { text: "older disk draft" } });
const lateRenamedView = await lateRenameHydration;
assert.equal(lateRenamedView.buffers.old, undefined,
  "Hydration cannot revive a buffer opened and then renamed while its read was pending");
assert.equal(lateRenamedView.buffers.renamed.text, "newer draft");

// Execute the actual component handlers against deferred host responses.
const panelsSource = fs.readFileSync(
  new URL(
    "../apps/desktop/src/remote-access/workspace-panels.tsx",
    import.meta.url,
  ),
  "utf8",
);
const panelsTree = ts.createSourceFile(
  "panels.tsx",
  panelsSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const filesComponent = panelsTree.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "RemoteFiles",
);
const componentReturn = filesComponent.body.statements.find(
  ts.isReturnStatement,
);
const handlersSource =
  panelsSource.slice(
    filesComponent.getStart(panelsTree),
    componentReturn.getStart(panelsTree),
  ) + "return {openFile, save, pathAction}; }";
const remoteFile = (content) => ({
  path: "file.txt",
  content,
  contentHash: content,
  sizeBytes: content.length,
  truncated: false,
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fileHandlers(view, response) {
  let current = view;
  const errors = [];
  const w = {
    view,
    data: {},
    setView: (update) => {
      current = typeof update === "function" ? update(current) : update;
    },
    loadTools: async () => {},
    setError: (error) => errors.push(error),
    run: (...args) =>
      typeof response === "function" ? response(...args) : response.promise,
  };
  const module = {};
  vm.runInNewContext(
    ts.transpileModule(handlersSource, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    {
      exports: module,
      useState: () => ["", () => {}],
      useRef: (value) =>
        value === view
          ? {
              get current() {
                return current;
              },
              set current(_value) {},
            }
          : { current: value },
      useEffect: () => {},
      useRemoteTheme: () => "dark",
      confirmAction: async () => true,
      askTextValue: async () => "renamed.txt",
    },
  );
  return {
    handlers: module.RemoteFiles({
      workspace: w,
      session: { id: "chat" },
      hostId: "host",
    }),
    get: () => current,
    errors,
    set: (value) => {
      current = value;
    },
  };
}
const beforeFile = remoteFile("before");
const initialFileView = {
  ...viewExports.emptyView(),
  sessionId: "chat",
  panel: "files",
  selectedFile: "file.txt",
  buffers: { "chat:file.txt": { file: beforeFile, text: "unsaved" } },
};
const reloadResponse = deferred();
const reloadCase = fileHandlers(initialFileView, reloadResponse);
const reloading = reloadCase.handlers.openFile("file.txt", true);
await Promise.resolve();
reloadCase.set({
  ...initialFileView,
  buffers: {
    "chat:file.txt": { file: beforeFile, text: "typed during reload" },
  },
});
reloadResponse.resolve(remoteFile("host revision"));
await reloading;
assert.equal(
  reloadCase.get().buffers["chat:file.txt"].text,
  "typed during reload",
  "A late reload must preserve edits made while reading",
);
const saveResponse = deferred();
const saveCase = fileHandlers(initialFileView, saveResponse);
const saving = saveCase.handlers.save();
saveCase.set({ ...initialFileView, buffers: {}, selectedFile: undefined });
saveResponse.resolve(remoteFile("unsaved"));
await saving;
assert.equal(
  saveCase.get().buffers["chat:file.txt"],
  undefined,
  "A late save must not resurrect a removed buffer",
);
const deleteResponse = deferred();
const deleteCase = fileHandlers(initialFileView, deleteResponse);
const deleting = deleteCase.handlers.pathAction("delete");
await Promise.resolve();
deleteCase.set({
  ...initialFileView,
  buffers: {
    "chat:file.txt": { file: beforeFile, text: "typed during delete" },
  },
});
deleteResponse.resolve({ path: "file.txt" });
await deleting;
assert.equal(
  deleteCase.get().buffers["chat:file.txt"]?.text,
  "typed during delete",
  "A completed deletion must preserve text typed after confirmation",
);

assert.match(deleteCase.errors[0], /kept/);
const normalDeleteResponse = deferred();
const normalDeleteCase = fileHandlers(initialFileView, normalDeleteResponse);
const normalDeleting = normalDeleteCase.handlers.pathAction("delete");
await Promise.resolve();
normalDeleteResponse.resolve({ path: "file.txt" });
await normalDeleting;
assert.equal(normalDeleteCase.get().buffers["chat:file.txt"], undefined);
const renameResponse = deferred();
const renameCase = fileHandlers(initialFileView, renameResponse);
const renaming = renameCase.handlers.pathAction("rename");
await Promise.resolve();
renameCase.set({ ...initialFileView, selectedFile: "other.txt" });
renameResponse.resolve({ path: "renamed.txt" });
await renaming;
assert.equal(renameCase.get().selectedFile, "other.txt");
assert.equal(renameCase.get().buffers["chat:renamed.txt"].text, "unsaved");
assert.equal(renameCase.get().buffers["chat:file.txt"], undefined);
const collisionResponse = deferred();
const collisionCase = fileHandlers(initialFileView, collisionResponse);
const collidingRename = collisionCase.handlers.pathAction("rename");
await Promise.resolve();
collisionCase.set({
  ...initialFileView,
  buffers: {
    ...initialFileView.buffers,
    "chat:renamed.txt": {
      file: remoteFile("destination"),
      text: "destination draft",
    },
  },
});
collisionResponse.resolve({ path: "renamed.txt" });
await collidingRename;
assert.equal(
  collisionCase.get().buffers["chat:renamed.txt"].text,
  "destination draft",
  "A rename response cannot replace a newer destination draft",
);
assert.equal(
  collisionCase.get().buffers["chat:file.txt"].text,
  "unsaved",
  "Both competing editor drafts remain recoverable",
);

const typingResponse = deferred();
const typingCase = fileHandlers(initialFileView, typingResponse);
const typingSave = typingCase.handlers.save();
typingCase.set({
  ...initialFileView,
  buffers: { "chat:file.txt": { file: beforeFile, text: "typed during save" } },
});
typingResponse.resolve(remoteFile("unsaved"));
await typingSave;
assert.equal(
  typingCase.get().buffers["chat:file.txt"].text,
  "typed during save",
);
assert.equal(
  typingCase.get().buffers["chat:file.txt"].file.content,
  "unsaved",
  "Save updates the base without discarding newer typing",
);
const olderOpen = deferred(),
  newerOpen = deferred();
const openCase = fileHandlers(initialFileView, ({ path }) =>
  path === "older.txt" ? olderOpen.promise : newerOpen.promise,
);
const olderOpening = openCase.handlers.openFile("older.txt");
const newerOpening = openCase.handlers.openFile("newer.txt");
newerOpen.resolve({ ...remoteFile("newer"), path: "newer.txt" });
await newerOpening;
olderOpen.resolve({ ...remoteFile("older"), path: "older.txt" });
await olderOpening;
assert.equal(
  openCase.get().selectedFile,
  "newer.txt",
  "Earlier reads cannot take selection back from a later open",
);
const navigationResponse = deferred();
const navigationCase = fileHandlers(initialFileView, navigationResponse);
const navigatingRead = navigationCase.handlers.openFile("other.txt");
navigationCase.set({
  ...initialFileView,
  sessionId: "different",
  selectedFile: undefined,
});
navigationResponse.resolve({ ...remoteFile("other"), path: "other.txt" });
await navigatingRead;
assert.equal(
  navigationCase.get().selectedFile,
  undefined,
  "Old-session reads cannot select a file in the new session",
);
const workspaceSource = fs.readFileSync(
  new URL(
    "../apps/desktop/src/remote-access/use-workspace.ts",
    import.meta.url,
  ),
  "utf8",
);
const workspaceTree = ts.createSourceFile(
  "workspace.ts",
  workspaceSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const workspaceHook = workspaceTree.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "useRemoteWorkspace",
);
const viewSetter = workspaceHook.body.statements.find(
  (node) => ts.isVariableStatement(node) && node.declarationList.declarations.some(
    (declaration) => declaration.name.getText(workspaceTree) === "setView",
  ),
);
const hydrationEffect = workspaceHook.body.statements.find(
  (node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(workspaceTree) === "useEffect"
    && node.getText(workspaceTree).includes("const ready = hydrateView(hostId)"),
).expression.arguments[0];
let hydrationHookView = {...viewExports.emptyView(), buffers: {}};
const queuedViewUpdates = [];
const hookHydration = deferred();
const seenBuffers = {current: undefined};
const hydrationHandlers = vm.runInNewContext(
  ts.transpileModule(
    viewSetter.getText(workspaceTree) + "\nconst stop = (" + hydrationEffect.getText(workspaceTree)
      + ")();\n({setView, stop});",
    {compilerOptions: {target: ts.ScriptTarget.ES2022}},
  ).outputText,
  {
    useCallback: (callback) => callback,
    updateView: (update) => { queuedViewUpdates.push(update); },
    hydrationSeenBuffers: seenBuffers,
    viewRef: {get current() {return hydrationHookView;}},
    storageReady: {current: undefined},
    hostId: "hook-hydration",
    hydrateView: () => hookHydration.promise,
    mergeHydratedBuffers: viewExports.mergeHydratedBuffers,
    setBuffersLoaded() {},
    setStorageWarning() {},
  },
);
hydrationHandlers.setView((current) => ({...current, buffers: {opened: {text: "opened while loading"}}}));
hydrationHandlers.setView((current) => ({...current, buffers: {renamed: current.buffers.opened}}));
hookHydration.resolve({buffers: {opened: {text: "older persisted draft"}, unrelated: {text: "recover this"}}});
await hookHydration.promise;
await Promise.resolve();
for (const update of queuedViewUpdates) {
  // React batches functional updates and may replay an updater before commit.
  // Both applications receive the same previous state.
  const previous = hydrationHookView;
  update(previous);
  hydrationHookView = update(previous);
}
assert.equal(hydrationHookView.buffers.opened, undefined,
  "The React hydration merge must retain removal of a buffer first opened during the read");
assert.equal(hydrationHookView.buffers.renamed.text, "opened while loading");
assert.equal(hydrationHookView.buffers.unrelated.text, "recover this");
assert.ok(seenBuffers.current, "Tracking survives until React commits hydration");
const persistenceEffect = workspaceHook.body.statements.find(
  (node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(workspaceTree) === "useEffect"
    && node.getText(workspaceTree).includes("rememberView(hostId, view)"),
).expression.arguments[0];
const stopPersistence = vm.runInNewContext(
  ts.transpileModule("(" + persistenceEffect.getText(workspaceTree) + ")();",
    {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText,
  {
    rememberView() {}, hostId: "hook-hydration", view: hydrationHookView,
    buffersLoaded: true, hydrationSeenBuffers: seenBuffers,
    window: {setTimeout: () => 1}, clearTimeout() {},
    persistViewAsync: async () => true, setStorageWarning() {},
  },
);
assert.equal(seenBuffers.current, undefined, "Committed hydration releases temporary tracking");
stopPersistence();
hydrationHandlers.stop();
const linkedOpener = workspaceHook.body.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "openRemoteFile",
);
function linkedFileHandlers(response) {
  let current = initialFileView;
  const generation = { current: 0 },
    fileReadGeneration = { current: 0 };
  const open = vm.runInNewContext(
    ts.transpileModule(
      linkedOpener.getText(workspaceTree) + "\nopenRemoteFile;",
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    {
      viewRef: {
        get current() {
          return current;
        },
      },
      data: {},
      generation,
      fileReadGeneration,
      mounted: { current: true },
      setError() {},
      run: response,
      setView: (update) => {
        current = typeof update === "function" ? update(current) : update;
      },
    },
  );
  return {
    open,
    get: () => current,
    set: (value) => {
      current = value;
      generation.current++;
    },
  };
}
const earlierLinkedRead = deferred(),
  laterLinkedRead = deferred();
const linkedCase = linkedFileHandlers(({ path }) =>
  path === "earlier.txt" ? earlierLinkedRead.promise : laterLinkedRead.promise,
);
const earlierLinkedOpening = linkedCase.open("earlier.txt");
const laterLinkedOpening = linkedCase.open("later.txt");
laterLinkedRead.resolve({ ...remoteFile("later"), path: "later.txt" });
await laterLinkedOpening;
earlierLinkedRead.resolve({ ...remoteFile("earlier"), path: "earlier.txt" });
await earlierLinkedOpening;
assert.equal(
  linkedCase.get().selectedFile,
  "later.txt",
  "Slow linked-file opens cannot take selection back",
);
console.log(
  "Remote file reload, save, overlapping opens and navigation preserve current edits and selection.",
);
