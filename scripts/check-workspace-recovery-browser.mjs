import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const { outputFiles } = await build({
  entryPoints: [
    new URL(
      "../apps/desktop/src/editor/durable-edit-recovery.ts",
      import.meta.url,
    ).pathname,
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  logLevel: "silent",
});
const server = createServer((request, response) => {
  response.setHeader(
    "Content-Type",
    request.url === "/recovery.js" ? "text/javascript" : "text/html",
  );
  response.end(
    request.url === "/recovery.js"
      ? outputFiles[0].text
      : '<script type="module">import * as recovery from "/recovery.js"; await recovery.initializeDurableEditRecovery(); window.recovery = recovery;</script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "gyro-recovery-browser-"));
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ??
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function until(check) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await pause();
  }
  throw Error("Recovery browser check timed out");
}
let ws;
try {
  const port = await until(
    async () =>
      (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
        "\n",
      )[0],
  );
  const pages = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  ws = new WebSocket(
    pages.find((page) => page.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const value = JSON.parse(event.data);
    if (value.id) {
      const waiter = pending.get(value.id);
      pending.delete(value.id);
      value.error ? waiter?.reject(value.error) : waiter?.resolve(value.result);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const ready = () => until(() => evaluate("Boolean(window.recovery)"));
  await call("Page.navigate", { url: origin });
  await ready();
  await evaluate(`recovery.persistDurableEditRecovery({ '/workspace/café notes.txt': {
    path: '/workspace/café notes.txt', content: 'x'.repeat(2*1024*1024), savedContent: 'y'.repeat(2*1024*1024),
    status: 'conflict', contentHash: 'original', sizeBytes: 2*1024*1024, truncated: false, updatedAt: new Date(0).toISOString()
  } })`);
  await call("Page.navigate", { url: "about:blank" });
  await until(() => evaluate("location.href === 'about:blank'"));
  await call("Page.navigate", { url: origin });
  await ready();
  const recovered =
    await evaluate(`(() => { const state = recovery.mergeDurableEditRecovery({ ide: {
    buffers: {}, tabs: [], layout: { groups: [{ id: 'main', tabs: [] }], activeGroupId: 'main' }
  }}); const draft = state.ide.buffers['/workspace/café notes.txt']; return { chars: draft.content.length,
    savedChars: draft.savedContent.length, status: draft.status, tab: state.ide.tabs[0].path }; })()`);
  assert.deepEqual(recovered, {
    chars: 2 * 1024 * 1024,
    savedChars: 2 * 1024 * 1024,
    status: "conflict",
    tab: "/workspace/café notes.txt",
  });
  // A later empty transaction must clear the old draft, including after another reload.
  await evaluate("recovery.persistDurableEditRecovery({})");
  await evaluate("recovery.initializeDurableEditRecovery()");
  assert.equal(
    await evaluate(
      "Object.keys(recovery.mergeDurableEditRecovery({ide:{buffers:{},tabs:[],layout:{groups:[]}}}).ide.buffers).length",
    ),
    0,
  );
  // A synchronous journal can advance while an IDB commit is pending, even
  // within the same Date.now() millisecond. Neither retirement nor boot may lose it.
  const journalRace = await evaluate(`(async () => {
    const key = 'gyro.workspace-edit-recovery.v1';
    const clock = Date.now; Date.now = () => 12345;
    try {
      localStorage.setItem(key, JSON.stringify({version:1, writtenAt:12345, revision:'old', buffers:{}}));
      const pending = recovery.persistDurableEditRecovery({});
      const path = '/workspace/race.txt';
      const buffers = {[path]: {path, content:'new draft', savedContent:'base', contentHash:'base',
        status:'dirty', sizeBytes:4, truncated:false, updatedAt:new Date(0).toISOString()}};
      const journal = JSON.stringify({version:1, writtenAt:12345, revision:'new', buffers});
      localStorage.setItem(key, journal);
      await pending;
      await recovery.initializeDurableEditRecovery();
      const state = {ide:{buffers,tabs:[],layout:{groups:[]}}};
      return {retained:localStorage.getItem(key)===journal,
        content:recovery.recoverDurableEditRecovery(state).ide.buffers[path]?.content};
    } finally { Date.now = clock; }
  })()`);
  assert.deepEqual(journalRace, { retained: true, content: "new draft" });
  console.log(
    "Browser recovery passed: real IndexedDB committed and restored a 2 MiB conflict draft across reload; clearing did not resurrect it.",
  );
} finally {
  ws?.close();
  browser.kill();
  await new Promise((resolve) => {
    if (browser.exitCode !== null) resolve();
    else browser.once("exit", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
