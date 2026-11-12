import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// Production ChatRun, simulated events, an isolated headless browser.
const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1438";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
const fixture = new URL("/command-failure-fixture.html", origin);
const response = await fetch(fixture, { signal: AbortSignal.timeout(5_000) });
assert.equal(response.status, 200, "Start the desktop Vite preview before running this check");
const executable = [
  process.env.GYRO_CAPTURE_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
].find(path => path && existsSync(path));
assert.ok(executable, "Set GYRO_CAPTURE_BROWSER to an installed Chromium browser");
const profile = await mkdtemp(join(tmpdir(), "gyro-failure-details-"));
const output = resolve("artifacts/screenshots/command-failures");
await mkdir(output, { recursive: true });
const browser = spawn(executable, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", "--hide-scrollbars", "--force-color-profile=srgb",
  "--user-data-dir=" + profile, "about:blank",
], { stdio: "ignore" });
let launchError;
browser.once("error", error => { launchError = error; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw Error("Browser exited with " + browser.exitCode);
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw Error("Timed out: " + label);
}
let socket;
const results = [];
const pageErrors = [];
try {
  const port = await until(async () => {
    const path = join(profile, "DevToolsActivePort");
    return existsSync(path) && Number((await readFile(path, "utf8")).split("\n")[0]);
  }, "browser startup");
  const pages = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    message.error ? call.reject(Error(message.error.message)) : call.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(method)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const key = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ["keyDown", "keyUp"])
      await call("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode,
        ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}),
      });
  };
  await call("Page.enable");
  await call("Runtime.enable");
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await call("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
      for (const state of ["done", "running", "empty"]) {
        await call("Page.navigate", { url: fixture + "?theme=" + theme + "&state=" + state });
        await until(() => evaluate('!!document.querySelector("main")'), "fixture");
        await evaluate("document.fonts.ready.then(() => true)");
        if (state === "done")
          await evaluate('document.querySelector(".gyro-run-header button, button.gyro-run-toggle, .gyro-run button")?.click()');
        if (state !== "empty") {
          await until(() => evaluate('document.querySelectorAll("summary.gyro-import-tool-summary").length === 2'), "failure rows");
          await until(() => evaluate('(() => { const el = document.querySelector("summary.gyro-import-tool-summary"); el?.focus(); return document.activeElement === el && el.getBoundingClientRect().height > 0 && !el.closest("[inert]"); })()'), "focusable failure summary");
          await key("Enter", "Enter", 13);
          assert.equal(await evaluate('document.querySelector(".gyro-import-tool-details").open'), true);
          const focus = await evaluate('({style:getComputedStyle(document.activeElement).outlineStyle,width:getComputedStyle(document.activeElement).outlineWidth})');
          assert.notEqual(focus.style, "none");
          assert.ok(parseFloat(focus.width) >= 1);
          await key("Enter", "Enter", 13);
          assert.equal(await evaluate('document.querySelector(".gyro-import-tool-details").open'), false);
          await evaluate('document.querySelectorAll("summary.gyro-import-tool-summary").forEach(node => node.click())');
          const detail = await evaluate('Array.from(document.querySelectorAll("pre[aria-label=\\"Tool failure details\\"]"), node => node.textContent)');
          assert.equal(detail.length, 2);
          assert.match(detail[0], /oldString was not found/);
          assert.match(detail[1], /Exit code: 1\nError: Chromium executable/);
          assert.match(detail[1], /<test-output> is plain text/);
          assert.equal(await evaluate('document.querySelectorAll("test-output").length'), 0);
          assert.equal(await evaluate('document.querySelectorAll(".gyro-run-call-meta.is-failed").length'), 2);
        } else {
          assert.equal(await evaluate('document.querySelectorAll(".gyro-import-tool-details").length'), 0);
        }
        assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false, "no page overflow");
        await pause(250);
        if (state === "done") {
          const shot = await call("Page.captureScreenshot", { format: "png" });
          await writeFile(join(output, theme + "-" + width + ".png"), Buffer.from(shot.data, "base64"));
        }
        results.push({ theme, width, state, passed: true });
      }
    }
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(results.length + " failure-detail browser cases passed; keyboard, literal output, themes, viewport and states checked.");
} finally {
  socket?.close();
  browser.kill("SIGTERM");
  await Promise.race([new Promise(resolve => browser.once("exit", resolve)), pause(2_000)]);
  if (browser.exitCode !== null || browser.signalCode !== null)
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
