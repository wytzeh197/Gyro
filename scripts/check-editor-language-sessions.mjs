import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import ts from "typescript";

// Execute the complete shipped modules; transpilation only removes TypeScript
// and resolves the local import for a dependency-free transport harness.
const sourceRoot = new URL("../apps/desktop/src/editor/", import.meta.url);
const compile = async (file) => ts.transpileModule(
  await readFile(new URL(file, sourceRoot), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
).outputText;
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const uriUrl = moduleUrl(await compile("document-uri.ts"));
const sessionsCode = (await compile("language-sessions.ts"))
  .replace(/from (["'])\.\/document-uri\1/, `from ${JSON.stringify(uriUrl)}`);
const { LanguageSessions } = await import(moduleUrl(sessionsCode));
const { canonicalFileUri } = await import(uriUrl);

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
const document = (path = "/workspace/src/a.ts", content = "export const value = 1;\n", root = "/workspace") => ({
  path, root, content, languageId: "typescript", command: "typescript-language-server --stdio",
});
const fixture = (overrides = {}) => {
  const starts = [], calls = [], stops = [], states = [], messages = [];
  const manager = new LanguageSessions({
    transport: {
      async start(value) {
        starts.push(structuredClone(value));
        return overrides.start ? overrides.start(value, starts.length) : {
          serverId: `server-${starts.length}`, message: "ready",
          capabilities: { definitionProvider: true }, positionEncoding: "utf-16",
        };
      },
      async send(serverId, method, params) {
        calls.push({ serverId, method, params: structuredClone(params) });
        return overrides.send ? overrides.send(serverId, method, params) : {
          status: method.startsWith("textDocument/did") ? "sent" : "ok",
          result: { answer: "current" },
        };
      },
      async stop(serverId) { stops.push(serverId); },
    },
    onState(value, status, session, error) { states.push({ path: value.path, status, session, error }); },
    onMessages(value, root) { if (value !== undefined) messages.push({ value, root }); },
  });
  return { manager, starts, calls, stops, states, messages };
};
const tests = [];
const test = (name, run) => tests.push({ name, run });

test("panes and same-root documents share a session; roots stay isolated", async () => {
  const f = fixture();
  const a = document("/workspace/src/a file.ts");
  const b = document("/workspace/src/b.ts", "export const dirty = 2;\n");
  const tsx = { ...document("/workspace/src/component.tsx"), languageId: "typescriptreact" };
  const other = document("/other/src/a.ts", a.content, "/other");
  await Promise.all([f.manager.sync(a), f.manager.sync(a), f.manager.sync(b), f.manager.sync(tsx), f.manager.sync(other)]);
  assert.equal(f.starts.length, 2);
  const opens = f.calls.filter(call => call.method === "textDocument/didOpen");
  assert.equal(opens.length, 4, "two panes must not open the same document twice");
  const aOpen = opens.find(call => call.params.textDocument.uri === canonicalFileUri(a.path));
  const bOpen = opens.find(call => call.params.textDocument.uri === canonicalFileUri(b.path));
  const otherOpen = opens.find(call => call.params.textDocument.uri === canonicalFileUri(other.path));
  const tsxOpen = opens.find(call => call.params.textDocument.uri === canonicalFileUri(tsx.path));
  assert.equal(aOpen.serverId, bOpen.serverId);
  assert.equal(aOpen.serverId, tsxOpen.serverId, "TS and TSX must share project text snapshots");
  assert.equal(tsxOpen.params.textDocument.languageId, "typescriptreact");
  assert.notEqual(aOpen.serverId, otherOpen.serverId);
  assert.equal(bOpen.params.textDocument.text, b.content, "inactive dirty text must reach the server");
  await f.manager.dispose();
  assert.equal(new Set(f.stops).size, 2);
});

test("semantic requests wait for their pending dirty-buffer change", async () => {
  const changeSeen = deferred(), finishChange = deferred();
  const f = fixture({ send: async (_server, method) => {
    if (method === "textDocument/didChange") {
      changeSeen.resolve();
      await finishChange.promise;
    }
    return { status: "ok", result: "definition" };
  } });
  const a = document();
  await f.manager.sync(a);
  const dirty = { ...a, content: "export const renamed = 2;\n" };
  const synchronization = f.manager.sync(dirty);
  const query = f.manager.request(dirty, "textDocument/definition", { position: { line: 0, character: 13 } });
  await changeSeen.promise;
  assert.equal(f.calls.some(call => call.method === "textDocument/definition"), false);
  finishChange.resolve();
  await synchronization;
  assert.equal(await query, "definition");
  assert.deepEqual(f.calls.map(call => call.method), ["textDocument/didOpen", "textDocument/didChange", "textDocument/definition"]);
  assert.equal(f.calls[1].params.contentChanges[0].text, dirty.content);
  await f.manager.dispose();
});

test("a cross-file query waits for inactive dirty documents on its server", async () => {
  const changeSeen = deferred(), finishChange = deferred(), querySent = deferred();
  const f = fixture({ send: async (_server, method) => {
    if (method === "textDocument/didChange") { changeSeen.resolve(); await finishChange.promise; }
    if (method === "textDocument/definition") querySent.resolve("query");
    return { status: "ok", result: "definition" };
  } });
  const a = document(), b = document("/workspace/src/b.ts");
  await f.manager.reconcile([a, b]);
  const change = f.manager.sync({ ...b, content: "export const unsavedTarget = 2;\n" });
  await changeSeen.promise;
  const query = f.manager.request(a, "textDocument/definition", { position: { line: 0, character: 13 } });
  // A turn checkpoint drains pending promise continuations without a timed
  // sleep; an unfinished inactive change must still prevent query dispatch.
  let premature = false;
  querySent.promise.then(() => { premature = true; });
  await nextTurn();
  const sentBeforeChangeFinished = premature;
  finishChange.resolve();
  await change;
  await query;
  assert.equal(sentBeforeChangeFinished, false, "cross-file queries must wait for other dirty buffers");
  await f.manager.dispose();
});

test("edit target synchronization must use the requesting server family and root", async () => {
  const f = fixture();
  const source = document();
  await f.manager.sync(source);
  await assert.rejects(f.manager.syncForRequest(source, document("/other/b.ts", "const foreign = 1;", "/other")), /different language-server workspace/i);
  await assert.rejects(f.manager.syncForRequest(source, { ...document("/workspace/settings.json", "{}"), languageId: "json", command: "vscode-json-language-server --stdio" }), /different language-server workspace/i);
  const tsx = { ...document("/workspace/component.tsx", "export const view = <div />;"), languageId: "typescriptreact" };
  await f.manager.syncForRequest(source, tsx);
  assert.equal(f.starts.length, 1, "compatible TS/TSX targets use the request's server");
  assert.deepEqual(f.calls.filter(call => call.method === "textDocument/didOpen").map(call => call.params.textDocument.uri), [canonicalFileUri(source.path), canonicalFileUri(tsx.path)]);
  await f.manager.dispose();
});

test("renderer versions adopt server takeover versions and then increase", async () => {
  const f = fixture({ send: async (_server, method, params) => ({
    status: "sent",
    documentVersion: method === "textDocument/didOpen" ? 41 : params.textDocument.version,
  }) });
  const a = document();
  await f.manager.sync(a);
  assert.equal(f.manager.version(a.path), 41);
  await f.manager.sync({ ...a, content: "export const value = 2;\n" });
  await f.manager.sync({ ...a, content: "export const value = 3;\n" });
  assert.deepEqual(f.calls.map(call => call.params.textDocument.version), [1, 42, 43]);
  assert.equal(f.manager.version(a.path), 43);
  await f.manager.dispose();
});

test("changed documents reject old results and suppress stale diagnostics", async () => {
  const querySeen = deferred(), finishQuery = deferred();
  const f = fixture({ send: async (_server, method) => {
    if (method === "textDocument/definition") {
      querySeen.resolve();
      await finishQuery.promise;
      return { status: "ok", result: "old location", messages: ["stale-diagnostic"] };
    }
    return { status: "sent" };
  } });
  const a = document();
  await f.manager.sync(a);
  const query = f.manager.request(a, "textDocument/definition", {});
  const rejected = assert.rejects(query, /document changed/i);
  await querySeen.promise;
  await f.manager.sync({ ...a, content: "export const changed = 2;\n" });
  finishQuery.resolve();
  await rejected;
  assert.equal(f.messages.some(message => message.value.includes("stale-diagnostic")), false);
  await f.manager.dispose();
});

test("closing a document rejects an in-flight result for its released snapshot", async () => {
  const querySeen = deferred(), finishQuery = deferred();
  const f = fixture({ send: async (_server, method) => {
    if (method === "textDocument/definition") { querySeen.resolve(); await finishQuery.promise; }
    return { status: "ok", result: "released location" };
  } });
  const a = document();
  await f.manager.sync(a);
  const query = f.manager.request(a, "textDocument/definition", {});
  const rejected = assert.rejects(query, /changed|unavailable|closed/i);
  await querySeen.promise;
  await f.manager.reconcile([]);
  finishQuery.resolve();
  await rejected;
  await f.manager.dispose();
});

test("reconciliation closes only released documents and reopening reacquires ownership", async () => {
  const f = fixture();
  const a = document(), b = document("/workspace/src/b.ts");
  await f.manager.reconcile([a, b]);
  await f.manager.reconcile([b]);
  await f.manager.reconcile([b]);
  const closes = f.calls.filter(call => call.method === "textDocument/didClose");
  assert.equal(closes.length, 1);
  assert.equal(closes[0].params.textDocument.uri, canonicalFileUri(a.path));
  assert.equal(f.manager.version(a.path), undefined);
  await f.manager.sync(a);
  assert.equal(f.calls.filter(call => call.method === "textDocument/didOpen" && call.params.textDocument.uri === canonicalFileUri(a.path)).length, 2);
  assert.equal(f.starts.length, 1);
  await f.manager.dispose();
});

test("a failed start is reported and a later request retries it", async () => {
  const f = fixture({ start: async (_document, count) => {
    if (count === 1) throw new Error("server not found");
    return { serverId: "recovered-server", message: "ready", positionEncoding: "utf-16" };
  } });
  const a = document();
  await assert.rejects(f.manager.sync(a), /server not found/);
  assert.deepEqual(await f.manager.request(a, "textDocument/definition", {}), { answer: "current" });
  assert.equal(f.starts.length, 2);
  assert.deepEqual(f.states.map(state => state.status), ["starting", "error", "starting", "ready"]);
  assert.equal(f.calls[0].method, "textDocument/didOpen");
  assert.equal(f.calls[0].params.textDocument.version, 1);
  await f.manager.dispose();
});

test("language overrides close the old document before opening its new identity", async () => {
  const closeSeen = deferred(), finishClose = deferred();
  const f = fixture({ send: async (_server, method) => {
    if (method === "textDocument/didClose") { closeSeen.resolve(); await finishClose.promise; }
    return { status: "sent" };
  } });
  const a = document();
  await f.manager.sync(a);
  const overridden = { ...a, languageId: "javascript" };
  const reopening = f.manager.sync(overridden);
  await closeSeen.promise;
  const opensBeforeCloseFinished = f.calls.filter(call => call.method === "textDocument/didOpen").length;
  finishClose.resolve();
  await reopening;
  assert.equal(opensBeforeCloseFinished, 1, "an override must wait for its old ownership to close");
  assert.deepEqual(f.calls.map(call => call.method), ["textDocument/didOpen", "textDocument/didClose", "textDocument/didOpen"]);
  assert.equal(f.calls[2].params.textDocument.languageId, "javascript");
  assert.equal(f.starts.length, 1, "the same server family can retain its process");
  await f.manager.dispose();
});

test("disposing before queued synchronization starts never acquires a server", async () => {
  const f = fixture();
  const queued = f.manager.sync(document());
  await f.manager.dispose();
  await queued;
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.stops, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.states, []);
});

test("disposing during startup stops the eventual server and opens no documents", async () => {
  const startSeen = deferred(), finishStart = deferred();
  const f = fixture({ start: async () => { startSeen.resolve(); return finishStart.promise; } });
  const sync = f.manager.sync(document());
  const rejected = assert.rejects(sync, /session closed/i);
  await startSeen.promise;
  const disposal = f.manager.dispose();
  finishStart.resolve({ serverId: "late-server", message: "ready" });
  await disposal;
  await rejected;
  assert.deepEqual(f.stops, ["late-server"]);
  assert.deepEqual(f.calls, []);
});

const outcomes = await Promise.allSettled(tests.map(async ({ name, run }) => {
  let timeout;
  try {
    await Promise.race([run(), new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("transport operation did not settle")), 10_000);
    })]);
  }
  catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
  finally { clearTimeout(timeout); }
}));
const failures = outcomes.filter(outcome => outcome.status === "rejected");
for (const failure of failures) console.error(failure.reason);
assert.equal(failures.length, 0, `${failures.length} language-session behavior check(s) failed`);
console.log(`editor language-session checks passed (${tests.length} behaviors)`);
