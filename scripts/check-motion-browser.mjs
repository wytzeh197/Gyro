import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1420";
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
let devServer;
try { await fetch(origin + "/motion-upgrade.html"); }
catch {
  devServer = spawn("pnpm", ["--filter", "@gyro-dev/desktop", "dev"], { stdio: "ignore" });
  await until(async () => (await fetch(origin + "/motion-upgrade.html")).ok, "fixture server");
}
const profile = await mkdtemp(join(tmpdir(), "gyro-motion-qa-"));
const browser = spawn(process.env.GYRO_CAPTURE_BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`, "--remote-debugging-port=9478", "about:blank",
], { stdio: "ignore" });
let ws;
async function until(check, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await pause();
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const pages = await until(async () => (await fetch("http://127.0.0.1:9478/json/list")).json(), "browser startup");
  ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const reply = JSON.parse(String(data));
    const handler = pending.get(reply.id);
    if (handler) { pending.delete(reply.id); reply.error ? handler.reject(reply.error) : handler.resolve(reply.result); }
  };
  function call(method, params = {}) {
    return new Promise((resolve, reject) => { const request = ++id; pending.set(request, { resolve, reject }); ws.send(JSON.stringify({ id: request, method, params })); });
  }
  async function evaluate(expression) {
    const reply = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  }
  const click = (label) => evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: origin + "/motion-upgrade.html" });
  await until(() => evaluate('!!document.querySelector(".motion-qa-chat .gyro-chat-surface")'), "production fixture render");
  async function trace(label, selector = ".gyro-chat-companion", duration = 330) {
    return evaluate(`(async () => {
      const button = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(label)});
      const values = []; const start = performance.now(); button.click();
      await new Promise(resolve => {
        function frame() {
          const node = document.querySelector(${JSON.stringify(selector)});
          values.push(node ? { width: node.getBoundingClientRect().width, opacity: Number(getComputedStyle(node).opacity), inert: node.inert } : null);
          performance.now() - start < ${duration} ? requestAnimationFrame(frame) : resolve();
        }
        requestAnimationFrame(frame);
      });
      return values;
    })()`);
  }
  await pause(250);
  const opened = await trace("Open Files panel");
  console.log("panel opening trace", JSON.stringify(opened));
  assert.ok(opened.filter(Boolean).length > 0, `opening retains the real dock: ${JSON.stringify(opened)}`);
  const endWidth = opened.at(-1).width;
  assert.ok(endWidth > 250, "dock reaches its full usable width");
  assert.ok(opened.some(x => x && x.width > 1 && x.width < endWidth - 1), "open has intermediate widths");
  const closed = await trace("Close panel");
  assert.equal(closed.at(-1), null, "closed dock unmounts after exit");
  assert.ok(closed.some(x => x && x.width > 1 && x.width < endWidth - 1 && x.inert), "closing animates while inert");
  const reversed = await trace("Reverse panel quickly", ".gyro-chat-companion", 450);
  assert.ok(reversed.at(-1)?.width > 250, "open-close-open interruption settles open");
  await click("Close panel");
  await pause(300);
  // The overflow is the shared Base UI Menu: CSS transitions driven by
  // data-starting-style / data-ending-style, unmounted after the exit.
  const menuMotion = await evaluate(`(async () => {
    const trigger = document.querySelector('[aria-label="Preview actions"]');
    const getMenu = () => document.querySelector(".gyro-toolbar-overflow-menu");
    const frame = () => new Promise(requestAnimationFrame);
    const frames = async (n) => { for (let i = 0; i < n; i += 1) await frame(); };
    const transitions = menu => menu.getAnimations().filter(track => track.transitionProperty);
    const settle = async (test) => { for (let i = 0; i < 90 && !test(); i += 1) await frame(); return test(); };
    trigger.click();
    await frames(2);
    const menu = getMenu();
    const opening = transitions(menu);
    const openTime = Math.max(0, ...opening.map(t => Number(t.effect.getComputedTiming().duration)));
    await Promise.all(opening.map(t => t.finished.catch(() => undefined)));
    const openSettled = menu.hasAttribute("data-open") && getComputedStyle(menu).opacity === "1";
    trigger.click();
    await frames(2);
    const exiting = menu.hasAttribute("data-ending-style") || transitions(menu).length > 0;
    const removed = await settle(() => !getMenu());
    trigger.click();
    await frames(2);
    const reopenedMenu = getMenu();
    trigger.click();
    await frames(1);
    trigger.click();
    const reopened = await settle(() => {
      const current = getMenu();
      return !!current && current.hasAttribute("data-open") && !current.hasAttribute("data-ending-style") && getComputedStyle(current).opacity === "1";
    });
    return { openTime, openSettled, exiting, removed, reopened: reopened && !!reopenedMenu };
  })()`);
  assert.ok(menuMotion.openTime > 0 && menuMotion.openTime <= 220, "overflow keeps a short entrance transition");
  assert.ok(menuMotion.openSettled && menuMotion.exiting && menuMotion.removed && menuMotion.reopened, JSON.stringify(menuMotion));
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
  await until(() => evaluate('!document.querySelector(".gyro-toolbar-overflow-menu")'), "overflow exits after Escape");
  assert.equal(await evaluate("document.activeElement?.getAttribute('aria-label')"), "Preview actions");
  await evaluate('document.querySelector(".motion-qa-disclosure-content")?.style.setProperty("height", "201.25px")');
  await click("Run disclosure frame checks");
  const normal = await until(() => evaluate('document.querySelector("[data-motion-result]")?.textContent.startsWith("PASS") && document.querySelector("[data-motion-result]").textContent'), "disclosure opening, closing and reversal");
  assert.match(normal, /removed after close true/);
  // Verify real run groups use the same retained disclosure, not only the helper.
  await evaluate('document.querySelector(".motion-qa-detail .gyro-run-header-toggle").click()');
  await pause(250);
  assert.ok(await evaluate('!!document.querySelector(".motion-qa-detail .gyro-run-group-toggle")'), "finished run expands");
  await evaluate('document.querySelector(".motion-qa-detail .gyro-run-group-toggle").click()');
  await pause(250);
  assert.ok(await evaluate('!!document.querySelector(".motion-qa-detail .gyro-run-group-details")'), "nested file group expands");
  await evaluate('document.querySelector(".motion-qa-detail .gyro-run-group-toggle").click()');
  await pause(250);
  assert.equal(await evaluate('!!document.querySelector(".motion-qa-detail .gyro-run-group-details")'), false, "nested file details unmount after closing");
  await click("Open branch dialog");
  await pause(250);
  assert.ok(await evaluate('document.querySelector(".gyro-branch-name-dialog")?.getAttribute("role") === "dialog"'), "branch dialog opens");
  await evaluate('document.querySelector(".gyro-branch-name-dialog .gyro-btn--outline").click()');
  await until(() => evaluate('!document.querySelector(".gyro-branch-name-dialog")'), "cancel dismisses dialog");
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reducedOpened = await trace("Open Files panel");
  assert.ok(reducedOpened.at(-1)?.width > 250);
  assert.ok(reducedOpened.filter(Boolean).every(x => Math.abs(x.width - reducedOpened.at(-1).width) < 1), "reduced motion has no intermediate panel width");
  const reducedClosed = await trace("Close panel");
  assert.equal(reducedClosed.filter(Boolean).length, 0, "reduced motion removes dock immediately");
  await evaluate("document.querySelector('[aria-label=\"Preview actions\"]').click()");
  await until(() => evaluate('!!document.querySelector(".gyro-toolbar-overflow-menu")'), "reduced motion overflow opens");
  await evaluate("document.querySelector('[aria-label=\"Preview actions\"]').click()");
  await until(() => evaluate('!document.querySelector(".gyro-toolbar-overflow-menu")'), "reduced motion overflow closes");
  await click("Run disclosure frame checks");
  const reduced = await until(() => evaluate('document.querySelector("[data-motion-result]")?.textContent.includes("reduced motion true") && document.querySelector("[data-motion-result]").textContent'), "reduced motion disclosure");
  assert.match(reduced, /^PASS/);
  console.log(JSON.stringify({ result: "PASS", openingFrames: opened.filter(Boolean).length, closingFrames: closed.filter(Boolean).length, fullWidth: endWidth, disclosure: normal, reducedMotion: reduced }, null, 2));
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  await new Promise(resolve => browser.exitCode !== null ? resolve() : browser.once("exit", resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  devServer?.kill("SIGTERM");
}
