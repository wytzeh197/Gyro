import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1420";
const browserPath =
  process.env.GYRO_CAPTURE_BROWSER ||
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const profile = await mkdtemp(join(tmpdir(), "gyro-efficiency-test-"));
const port = 9477;
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
  console.error(
    `Could not launch Canvas test browser at ${browserPath}: ${error.message}`,
  );
});
browser.once("exit", (code, signal) => {
  if (code !== null && code !== 0) {
    console.error(
      `Canvas test browser exited early (code ${code}, signal ${signal})`,
    );
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
    `Timed out waiting for efficiency UI (browser exit ${browser.exitCode}, signal ${browser.signalCode}, CDP port ${port})`,
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
    if (result.method === "Runtime.exceptionThrown")
      console.error(JSON.stringify(result.params.exceptionDetails));
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
  await call("Page.navigate", {
    url: origin + "/efficiency-fixture.html?theme=light",
  });
  await until(() =>
    evaluate(
      "!!document.querySelector('[aria-label=\"Efficiency experiments\"]')",
    ),
  ).catch(async (error) => {
    console.error(
      await evaluate(
        "JSON.stringify({url:location.href,text:document.body.innerText,html:document.body.innerHTML.slice(0,2000)})",
      ),
    );
    throw error;
  });
  assert.equal(
    await evaluate(
      "document.querySelector('[aria-label=\"Efficiency experiments\"]').getAttribute('aria-checked')",
    ),
    "false",
  );
  await evaluate(
    "document.querySelector('[aria-label=\"Efficiency experiments\"]').click()",
  );
  await until(() =>
    evaluate(
      "document.querySelector('[aria-label=\"Efficiency experiments\"]').getAttribute('aria-checked') === 'true'",
    ),
  );
  await evaluate(
    "document.querySelector('[aria-label=\"Task profile\"]').value='deep'; document.querySelector('[aria-label=\"Task profile\"]').dispatchEvent(new Event('change',{bubbles:true}))",
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b=>b.textContent==='Reset').click()",
  );
  await until(() =>
    evaluate(
      "document.querySelector('[aria-label=\"Efficiency experiments\"]').getAttribute('aria-checked') === 'false'",
    ),
  );
  await evaluate(
    "document.querySelector('.gyro-efficiency-details').open=true",
  );
  assert.equal(await evaluate("document.body.scrollWidth <= innerWidth"), true);
  const screenshot = await call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  await writeFile(
    "/private/tmp/gyro-efficiency-light.png",
    Buffer.from(screenshot.data, "base64"),
  );
  await call("Page.navigate", {
    url: origin + "/efficiency-fixture.html?theme=dark",
  });
  await until(() =>
    evaluate(
      "document.documentElement.dataset.theme==='dark' && !!document.querySelector('[aria-label=\"Context efficiency\"]')",
    ),
  );
  await evaluate(
    "document.querySelector('.gyro-efficiency-details').open=true",
  );
  const dark = await call("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  await writeFile(
    "/private/tmp/gyro-efficiency-dark.png",
    Buffer.from(dark.data, "base64"),
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(await evaluate("document.body.scrollWidth <= innerWidth"), true);
  console.log(
    "Efficiency settings interactions and light/dark/narrow layouts passed",
  );
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  await new Promise((resolve) => {
    if (browser.exitCode !== null) resolve();
    else browser.once("exit", resolve);
  });
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
