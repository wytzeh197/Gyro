import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1420";
const browserPath =
  process.env.GYRO_CAPTURE_BROWSER ||
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const profile = await mkdtemp(join(tmpdir(), "gyro-canvas-test-"));
const port = 9473;
const browser = spawn(
  browserPath,
  [
    "--headless=new",
    "--disable-gpu",
    "--disable-site-isolation-trials",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
browser.once("error", (error) => {
  console.error(`Could not launch Canvas test browser at ${browserPath}: ${error.message}`);
});
browser.once("exit", (code, signal) => {
  if (code !== null && code !== 0) {
    console.error(`Canvas test browser exited early (code ${code}, signal ${signal})`);
  }
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function until(check) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await pause();
  }
  throw new Error(
    `Timed out waiting for Canvas (browser exit ${browser.exitCode}, signal ${browser.signalCode}, CDP port ${port})`,
  );
}
let ws;
try {
  const pages = await until(async () =>
    (await fetch(`http://127.0.0.1:${port}/json/list`)).json(),
  );
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
    const result = JSON.parse(String(event.data));
    const callback = pending.get(result.id);
    if (callback) {
      pending.delete(result.id);
      result.error
        ? callback.reject(result.error)
        : callback.resolve(result.result);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
  const evaluate = async (expression, contextId) => {
    const result = await call("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.navigate", { url: origin + "/canvas-fixture.html" });
  await until(() =>
    evaluate(
      `[...document.querySelectorAll('button')].some(x=>x.textContent==='Build UI piece')`,
    ),
  );
  const click = (label) =>
    evaluate(
      `[...document.querySelectorAll('button')].find(x=>x.textContent===${JSON.stringify(label)}).click()`,
    );
  await click("Build UI piece");
  await until(() =>
    evaluate("!!document.querySelector('.gyro-canvas iframe')"),
  );
  async function frameContext() {
    const tree = await call("Page.getFrameTree");
    const frame = tree.frameTree.childFrames?.find((item) =>
      item.frame.url.includes("canvas-runtime"),
    );
    assert.ok(frame, "Canvas runtime frame exists");
    return (
      await call("Page.createIsolatedWorld", {
        frameId: frame.frame.id,
        worldName: "canvas-test",
      })
    ).executionContextId;
  }
  let context = await until(frameContext);
  await until(() =>
    evaluate(
      "document.querySelector('#count')?.textContent === '0 of 3 complete'",
      context,
    ),
  );
  await evaluate("document.querySelector('#finish').click()", context);
  assert.equal(
    await evaluate("document.querySelector('#count').textContent", context),
    "3 of 3 complete",
  );
  assert.equal(
    await evaluate(
      "try { parent.document.body; false } catch { true }",
      context,
    ),
    true,
    "Parent DOM is isolated",
  );
  assert.equal(
    await evaluate(
      "try { localStorage.setItem('probe', 'x'); false } catch { true }",
      context,
    ),
    true,
    "Storage is isolated",
  );
  assert.equal(
    await evaluate("typeof window.__TAURI_INTERNALS__", context),
    "undefined",
  );
  assert.equal(
    await evaluate(
      `fetch('${origin}/canvas-network-probe').then(()=>false,()=>true)`,
      context,
    ),
    true,
    "Network fetch is blocked",
  );
  await click("Revise UI piece");
  context = await until(frameContext);
  await until(() =>
    evaluate(
      "document.querySelector('h1')?.textContent === 'Make it yours.'",
      context,
    ),
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('select[aria-label=\"Canvas item\"] option').length",
    ),
    1,
    "Revision replaces the same item",
  );
  await click("Code");
  assert.equal(
    await evaluate(
      "document.querySelector('textarea[aria-label=\"Project card content\"]').value.includes('Make it yours.')",
    ),
    true,
  );
  await evaluate(
    `const input=document.querySelector('textarea[aria-label="Project card content"]'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(input,input.value.replace('Make it yours.','My edited UI')); input.dispatchEvent(new Event('input',{bubbles:true}));`,
  );
  await click("Preview");
  context = await until(frameContext);
  await until(() =>
    evaluate(
      "document.querySelector('h1')?.textContent === 'My edited UI'",
      context,
    ),
  );
  await click("Build UI piece");
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-canvas-draft-status').textContent.includes('preserved')",
    ),
    true,
    "A model revision preserves an unsent draft",
  );
  await click("Send to chat");
  assert.equal(
    await evaluate(
      "document.querySelector('output').textContent.includes('My edited UI')",
    ),
    true,
  );
  await click("Use model version");
  context = await until(frameContext);
  await until(() =>
    evaluate(
      "document.querySelector('h1')?.textContent === 'Ready for the next step.'",
      context,
    ),
  );
  await evaluate(
    `const select=document.querySelector('select[aria-label="Preview width"]'); select.value='375'; select.dispatchEvent(new Event('change',{bubbles:true}));`,
  );
  assert.equal(
    await evaluate("document.querySelector('.gyro-canvas iframe').style.width"),
    "375px",
  );
  console.log(
    "Canvas browser checks passed: interaction, revision, draft preservation/restore, responsive sizing, request handoff, parent/storage isolation, blocked network.",
  );
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  await new Promise((resolve) => {
    if (browser.exitCode !== null) resolve();
    else browser.once("exit", resolve);
  });
  await rm(profile, { recursive: true, force: true });
}
