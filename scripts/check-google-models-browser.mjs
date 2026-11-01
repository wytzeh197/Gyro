import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profile = await mkdtemp(join(tmpdir(), "gyro-google-picker-"));
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ||
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let launchError;
browser.on("error", (error) => {
  launchError = error;
});
let ws;
async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw new Error("Test browser exited");
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out checking the Google picker fixture");
}
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
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      message.error
        ? request.reject(new Error(JSON.stringify(message.error)))
        : request.resolve(message.result);
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
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Page.enable");
  await call("Page.navigate", {
    url:
      (process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1437") +
      "/model-metadata-preview.html",
  });
  await until(() =>
    evaluate(
      `!!document.querySelector('select[aria-label="Model fixture"] option[value="antigravity|gemini-3.8-flash"]')`,
    ),
  );
  await evaluate(
    `(() => { const select = document.querySelector('select[aria-label="Model fixture"]'); select.value = "antigravity|gemini-3.8-flash"; select.dispatchEvent(new Event("change", {bubbles:true})); })()`,
  );
  await until(() =>
    evaluate(
      `document.querySelector('[role="status"]')?.textContent.includes("Gemini 3.8 Flash (discovery fixture)")`,
    ),
  );
  assert.match(
    await evaluate(`document.querySelector('[role="status"]').textContent`),
    /Unknown.*Unavailable/,
  );
  assert.equal(
    await evaluate(
      `!!document.querySelector('button[aria-label^="Reasoning effort:"]')`,
    ),
    false,
  );
  await evaluate(
    `document.querySelector('button[aria-label^="Model:"]').click()`,
  );
  await until(() =>
    evaluate(`!!document.querySelector('.gyro-model-rail-model-name')`),
  );
  const labels = await evaluate(
    `Array.from(document.querySelectorAll('.gyro-model-rail-model-name')).map(node => node.textContent)`,
  );
  assert.ok(labels.includes("Gemini 3.8 Flash (discovery fixture)"));
  assert.ok(labels.includes("Automatic"));
  assert.ok(labels.every((label) => !/Argon|Gemini 4/.test(label)));
  console.log(
    "Production Google picker selection, discovered models, unknown context, and absent effort control passed.",
  );
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  if (browser.exitCode === null && !launchError) {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        browser.kill("SIGKILL");
        resolve();
      }, 5000);
      browser.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
