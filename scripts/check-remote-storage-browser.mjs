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
    new URL("../apps/desktop/src/remote-access/view-state.ts", import.meta.url)
      .pathname,
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
      : '<script type="module">import * as recovery from "/recovery.js"; window.recovery = recovery;</script>',
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
  await evaluate(`localStorage.setItem('gyro.remote.view.legacy', JSON.stringify({
    ...recovery.emptyView(), drafts: { s: 'draft' }, buffers: { 's:file': {
      file: { path:'file', content:'a'.repeat(2*1024*1024), contentHash:'original', sizeBytes:2097152, truncated:false },
      text:'b'.repeat(2*1024*1024)
    } }
  }))`);
  assert.equal(
    await evaluate(`(async () => {
    const view = await recovery.hydrateView('legacy');
    return view.buffers['s:file'].text.length === 2097152 && await recovery.persistViewAsync('legacy', view);
  })()`),
    true,
  );
  assert.ok(
    await evaluate(
      `localStorage.getItem('gyro.remote.view.legacy').length < 1024`,
    ),
  );
  await call("Page.reload");
  await ready();
  assert.deepEqual(
    await evaluate(`(async () => {
    const view = await recovery.hydrateView('legacy');
    return [view.buffers['s:file'].text.length, view.buffers['s:file'].file.content.length, view.drafts.s];
  })()`),
    [2097152, 2097152, "draft"],
  );
  assert.equal(
    await evaluate(`(async () => {
    const view = await recovery.hydrateView('other');
    return Object.keys(view.buffers).length;
  })()`),
    0,
  );
  assert.equal(
    await evaluate(`recovery.persistViewAsync('legacy', recovery.emptyView())`),
    true,
  );
  await call("Page.reload");
  await ready();
  assert.equal(
    await evaluate(
      `(async () => Object.keys((await recovery.hydrateView('legacy')).buffers).length)()`,
    ),
    0,
  );
  assert.equal(
    await evaluate(`(async () => {
    const view = {...recovery.emptyView(), buffers: {'s:reopened': {
      file: {path:'reopened',content:'base',contentHash:'original',sizeBytes:4,truncated:false},
      text:'still unsaved'
    }}};
    if (!await recovery.persistViewAsync('reopened', view)) return false;
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('gyro.remote.buffers');
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('Draft connection prevented deletion'));
    });
    // Same object: a connection-local identity cache must not claim this is
    // still persisted after its underlying store has been replaced.
    return recovery.persistViewAsync('reopened', view);
  })()`),
    true,
  );
  await call("Page.reload");
  await ready();
  assert.equal(
    await evaluate(
      `(async () => (await recovery.hydrateView('reopened')).buffers['s:reopened']?.text)()`,
    ),
    "still unsaved",
    "Reopened storage must persist unchanged live buffers again",
  );
  await call("Page.reload");
  await ready();
  assert.equal(
    await evaluate(
      `recovery.persistViewAsync('reopened', recovery.emptyView())`,
    ),
    true,
  );
  await call("Page.reload");
  await ready();
  assert.equal(
    await evaluate(
      `(async () => Object.keys((await recovery.hydrateView('reopened')).buffers).length)()`,
    ),
    0,
    "A replacement snapshot must remove persisted keys even before this connection hydrated them",
  );
  assert.equal(await evaluate(`recovery.persistViewAsync('late-rename', {
    ...recovery.emptyView(), buffers: {
      opened: {file: {path:'opened',content:'base',contentHash:'base',sizeBytes:4,truncated:false},text:'older persisted draft'},
      unrelated: {file: {path:'unrelated',content:'base',contentHash:'base',sizeBytes:4,truncated:false},text:'recover this'}
    }
  })`), true);
  await call("Page.reload");
  await ready();
  assert.deepEqual(await evaluate(`(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('gyro.remote.buffers', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let holding = true;
    const transaction = db.transaction('buffers', 'readwrite');
    const held = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
    const keepAlive = () => {
      const request = transaction.objectStore('buffers').get(['late-rename', 'opened']);
      request.onsuccess = () => { if (holding) keepAlive(); };
    };
    keepAlive();
    const hydration = recovery.hydrateView('late-rename');
    await new Promise(resolve => setTimeout(resolve, 10));
    const initial = recovery.readView('late-rename');
    const opened = {file: {path:'opened',content:'base',contentHash:'base',sizeBytes:4,truncated:false},text:'opened while loading'};
    recovery.rememberView('late-rename', {...initial, buffers: {opened}});
    recovery.rememberView('late-rename', {...initial, buffers: {renamed: opened}});
    holding = false;
    await held;
    db.close();
    const result = await hydration;
    return [result.buffers.opened === undefined, result.buffers.renamed.text, result.buffers.unrelated.text];
  })()`), [true, 'opened while loading', 'recover this'],
    'A buffer first opened and renamed during real IndexedDB hydration must not revive its persisted key');
  console.log(
    "Remote storage browser checks passed: real IndexedDB, 4 MiB legacy buffer migration, reload, host isolation, deletion without resurrection, open-rename during hydration; localStorage view < 1 KiB.",
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
