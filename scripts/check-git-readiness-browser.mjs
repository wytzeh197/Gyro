// Production preparation component with simulated data. Browser fixture evidence.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1437";
const output = resolve("artifacts/git-readiness");
const executable = [process.env.GYRO_CAPTURE_BROWSER,
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((path) => path && existsSync(path));
assert.ok(executable, "An installed Chromium browser is required.");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "gyro-git-readiness-"));
const port = 9498;
const browser = spawn(executable, ["--headless=new", "--use-mock-keychain", "--password-store=basic",
  "--disable-background-networking", "--no-first-run", "--no-default-browser-check",
  "--force-color-profile=srgb", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank"],
  { stdio: "ignore" });
const pause = (ms = 100) => new Promise((done) => setTimeout(done, ms));
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch {}
    await pause();
  }
  throw new Error("Timed out: " + label);
}
let ws;
try {
  const pages = await until(async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json(), "browser");
  ws = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(message.error) : request.resolve(message.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timed out")); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  const click = async (label) => {
    assert.equal(await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)});
      if (!button) return false; button.click(); return true;
    })()`), true, label);
    await pause(100);
  };
  const state = () => evaluate(`document.querySelector('[data-testid="state"]')?.textContent`);
  const popover = () => evaluate(`document.querySelector('[aria-label="Workspace preparation details"]')?.textContent`);
  async function capture(name) {
    const screenshot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, name + ".png"), Buffer.from(screenshot.data, "base64"));
  }
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 860, height: 620, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: origin + "/git-readiness-fixture.html" });
  await until(() => evaluate("document.querySelector('h1')?.textContent.includes('Git readiness')"), "fixture");
  await click("No repository");
  assert.equal(await state(), "ready · 0 warnings");
  assert.match(await popover(), /Git · optional, not set up/);
  assert.match(await popover(), /Git isn’t set up/);
  assert.doesNotMatch(await popover(), /Retry|100%/);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-kind="optional"]')).backgroundColor`),
    "rgba(0, 0, 0, 0)", "Optional setup must not inherit the warning background");
  await capture("no-repository");
  await click("Git unavailable");
  assert.equal(await state(), "ready · 0 warnings");
  assert.match(await popover(), /Install Git/);
  await click("Git timeout");
  assert.match(await popover(), /Retry Git/);
  assert.match(await popover(), /Showing last-known changes/);
  assert.doesNotMatch(await popover(), /100%/);
  await capture("git-warning");
  await click("Recover status only");
  assert.equal(await state(), "degraded · 1 warnings");
  assert.match(await popover(), /Couldn’t refresh Git branches/);
  await click("Recover branches only");
  assert.equal(await state(), "ready · 0 warnings");
  await click("Git and watcher warnings");
  await click("Recover status only");
  await click("Recover branches only");
  assert.equal(await state(), "degraded · 1 warnings");
  assert.match(await popover(), /File watcher is unavailable/);
  assert.match(await popover(), /Retry preparation/);
  await click("Git timeout");
  await evaluate("document.querySelector('.gyro-workspace-preparation-button').focus()");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Close preparation details");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate("document.activeElement.textContent.trim()"), "Retry Git");
  const focus = await evaluate("getComputedStyle(document.activeElement).outlineStyle");
  assert.notEqual(focus, "none", "Retry action needs a visible keyboard focus outline");
  await capture("retry-keyboard-focus");
  await click("Retry Git");
  await until(async () => (await state()) === "ready · 0 warnings", "retry recovery");
  await capture("recovered");
  console.log("Browser checks passed: neutral setup, warning copy, independent recovery, mixed warnings, retry and keyboard focus.");
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  await new Promise(done => { if (browser.exitCode !== null) done(); else browser.once("exit", done); });
  await rm(profile, { recursive: true, force: true });
}
