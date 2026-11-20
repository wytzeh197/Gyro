import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Actual production composer, isolated browser profile, no IPC/provider calls.
const profile = await mkdtemp(join(tmpdir(), "gyro-activity-ui-"));
const artifacts =
  process.env.GYRO_TEST_ARTIFACTS ??
  join(tmpdir(), "gyro-activity-composer-check");
await mkdir(artifacts, { recursive: true });
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ??
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=BraveRewards,BraveVPN",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await pause(100);
  }
  throw Error("Timed out: " + label);
}
let ws;
try {
  const port = await until(
    async () =>
      Number(
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
          "\n",
        )[0],
      ),
    "browser start",
  );
  const page = await until(
    async () =>
      (
        await (await fetch("http://127.0.0.1:" + port + "/json/list")).json()
      ).find((item) => item.type === "page"),
    "page",
  );
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    message.error
      ? callback.reject(message.error)
      : callback.resolve(message.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const click = async (selector) => {
    const point = await evaluate(
      "(()=>{const e=document.querySelector(" +
        JSON.stringify(selector) +
        ");if(!e)throw Error('missing');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()",
    );
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    });
  };
  const key = async (key, code, windowsVirtualKeyCode) => {
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode,
      ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode,
    });
  };
  const receipts = [];
  for (const width of [1280, 900, 420]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", {
      url:
        (process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1420") +
        "/goal-composer-fixture.html",
    });
    await until(
      () =>
        evaluate(
          "!!document.querySelector('button[aria-label=\"Add context\"]')",
        ),
      "composer",
    );
    await click('button[aria-label="Add context"]');
    await until(
      () => evaluate("!!document.querySelector('.gyro-context-picker')"),
      "Add menu",
    );
    const settleMenu = () =>
      evaluate(
        "Promise.all(document.querySelector('.gyro-context-picker').getAnimations({subtree:true}).filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})))",
      );
    await settleMenu();
    const result = await evaluate(
      "(()=>{const m=document.querySelector('.gyro-context-picker'),r=m.getBoundingClientRect(),b=document.querySelector('button[aria-label=\"Add context\"]').getBoundingClientRect();return{width:r.width,left:r.left,right:r.right,top:r.top,bottom:r.bottom,triggerLeft:b.left,triggerTop:b.top,composerTop:m.closest('.gyro-composer-shell').getBoundingClientRect().top,titles:[...m.querySelectorAll('[role=\"menuitem\"]')].map(e=>e.getAttribute('title')),labels:[...m.querySelectorAll('[role=\"menuitem\"]')].map(e=>e.innerText)}})()",
    );
    assert.ok(result.width <= 257, JSON.stringify(result));
    assert.ok(
      result.left >= 0 && result.right <= width,
      JSON.stringify(result),
    );
    assert.ok(result.top >= 0 && result.bottom <= 800, JSON.stringify(result));
    assert.ok(result.titles.every((title) => title === null));
    assert.ok(
      result.bottom <= result.triggerTop - 7,
      "the Add menu must clear its trigger with the shared popover gap",
    );
    await key("Escape", "Escape", 27);
    await until(
      () => evaluate("!document.querySelector('.gyro-context-picker')"),
      "Escape dismiss",
    );
    await evaluate(
      "document.querySelector('button[aria-label=\"Add context\"]').focus()",
    );
    await key("Enter", "Enter", 13);
    await until(
      () => evaluate("!!document.querySelector('.gyro-context-picker')"),
      "keyboard open",
    );
    await key("ArrowDown", "ArrowDown", 40);
    const focus = await evaluate("document.activeElement.getAttribute('role')");
    assert.equal(focus, "menuitem");
    await settleMenu();
    const { data } = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(
      join(artifacts, "add-menu-" + width + ".png"),
      Buffer.from(data, "base64"),
    );
    receipts.push({ viewport: width, ...result, keyboardFocus: focus });
    console.log(JSON.stringify(receipts.at(-1)));
  }
  await call("Page.navigate", {
    url: (process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1420") + "/slash-menu-preview.html",
  });
  await until(() => evaluate("!!document.querySelector('.slash-preview textarea')"), "slash composer");
  const field = "document.querySelector('.slash-preview textarea')";
  await evaluate(`${field}.focus(); ${field}.select()`);
  await call("Input.insertText", { text: "Fix duplicate saves. /pl" });
  await key("Tab", "Tab", 9);
  await until(() => evaluate(`${field}.value === "Fix duplicate saves. /plan "`), "inline completion");
  await call("Input.insertText", { text: "Start with the retry path." });
  assert.equal(await evaluate("document.querySelector('.gyro-inline-command svg text').textContent"), "/plan");
  await key("Enter", "Enter", 13);
  await until(() => evaluate(`${field}.value === ""`), "submitted draft cleared");
  assert.equal(
    await evaluate("document.querySelector('.slash-preview-result').textContent"),
    "Fixture action: Sent Fix duplicate saves. Start with the retry path.",
  );
  console.log("Inline slash completion, continued typing and submitted prose passed.");
  await call("Page.navigate", {
    url: (process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1420") + "/slash-menu-preview.html?reviewer",
  });
  await until(() => evaluate("!!document.querySelector('.slash-preview textarea')"), "second opinion composer");
  await evaluate(`${field}.focus(); ${field}.select()`);
  await call("Input.insertText", { text: "Fix duplicate saves. /sec" });
  await key("Enter", "Enter", 13);
  await until(() => evaluate("!!document.querySelector('.gyro-reviewer-menu')"), "reviewer picker");
  assert.equal(await evaluate(`${field}.value.trimEnd()`), "Fix duplicate saves. /second-opinion");
  const popup = ".gyro-reviewer-menu";
  const search = ".gyro-reviewer-search input";
  const results = ".gyro-reviewer-results";
  const changeProvider = async label => {
    await evaluate(`[...document.querySelectorAll('.gyro-reviewer-providers button')].find(el => el.textContent === ${JSON.stringify(label)}).click()`);
  };
  const saveReviewerView = async name => {
    await evaluate(`Promise.all(document.querySelector('${popup}').getAnimations({subtree:true}).filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))`);
    const clip = await evaluate(`(() => {
      const rect = document.querySelector('${popup}').getBoundingClientRect();
      return { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y - 8), width: rect.width + 16, height: rect.height + 16, scale: 1 };
    })()`);
    const { data } = await call("Page.captureScreenshot", { format: "png", clip });
    await writeFile(join(artifacts, name + ".png"), Buffer.from(data, "base64"));
  };
  assert.equal(await evaluate(`document.activeElement.matches('${search}')`), true);
  await changeProvider("DeepSeek");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.gyro-reviewer-group')].map(el => el.ariaLabel)"), ["DeepSeek"]);
  const bounds = await evaluate(`document.querySelector('${popup}').getBoundingClientRect().toJSON()`);
  assert.ok(bounds.left >= 0 && bounds.right <= 420, "reviewer fits narrow chat");
  await changeProvider("All");
  await call("Emulation.setDeviceMetricsOverride", { width: 960, height: 940, deviceScaleFactor: 2, mobile: false });
  await saveReviewerView("choose-reviewer");
  const headerTop = await evaluate("document.querySelector('.gyro-reviewer-controls').getBoundingClientRect().top");
  const point = await evaluate(`(() => {const r=document.querySelector('${results}').getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 };})()`);
  await call("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: 420 });
  await until(() => evaluate(`document.querySelector('${results}').scrollTop > 0`), "model list scroll");
  assert.ok(Math.abs(await evaluate("document.querySelector('.gyro-reviewer-controls').getBoundingClientRect().top") - headerTop) < 1, "picker controls stay pinned while scrolling");
  await changeProvider("Anthropic");
  assert.equal(await evaluate(`document.querySelector('${results}').scrollTop`), 0);
  await click(search);
  await call("Input.insertText", { text: "CLAUDE-OPUS-5-5" });
  await until(() => evaluate("document.querySelectorAll('.gyro-reviewer-option').length === 1"), "case-insensitive model ID search");
  await changeProvider("DeepSeek");
  await until(() => evaluate("document.querySelector('.gyro-reviewer-empty')?.textContent === 'No matching models'"), "empty model search");
  assert.equal(await evaluate(`document.querySelector('${search}').value`), "CLAUDE-OPUS-5-5");
  await click('button[aria-label="Clear model search"]');
  assert.equal(await evaluate(`document.activeElement.matches('${search}')`), true);
  await changeProvider("Anthropic");
  await click(search);
  await call("Input.insertText", { text: "opus" });
  await until(() => evaluate("[...document.querySelectorAll('.gyro-reviewer-option')].every(el => el.textContent.toLowerCase().includes('opus'))"), "matching reviewer names");
  await key("ArrowDown", "ArrowDown", 40);
  assert.equal(await evaluate("document.activeElement.querySelector('.gyro-reviewer-model-name')?.textContent"), "Claude Opus 5.5");
  await key("Enter", "Enter", 13);
  await until(() => evaluate("!!document.querySelector('.gyro-inline-reviewer')"), "selected reviewer");
  const builder = await evaluate(`document.querySelector('button[aria-label^="Model: "]').ariaLabel`);
  await evaluate(`[...document.querySelectorAll('.slash-preview-controls button')].find(el => el.textContent === "Light").click()`);
  await until(() => evaluate("!!document.querySelector('.gyro-inline-reviewer .gyro-provider-logo')"), "restored reviewer");
  await click(".gyro-inline-reviewer");
  await until(() => evaluate("document.querySelector('.gyro-reviewer-menu [aria-current=true]')?.textContent.includes('Claude Opus 5.5')"), "reopened reviewer");
  await call("Input.insertText", { text: "opus" });
  await until(() => evaluate("document.querySelector('.gyro-reviewer-search input').value === 'opus'"), "search focused after reopen");
  await saveReviewerView("choose-reviewer-filtered-light");
  await key("Escape", "Escape", 27);
  await until(() => evaluate(`document.activeElement === ${field}`), "reviewer dismissal returns focus");
  await key("Enter", "Enter", 13);
  await until(() => evaluate(`${field}.value === ""`), "review selection submitted");
  assert.equal(await evaluate("document.querySelector('.slash-preview-result').textContent"),
    "Fixture action: Sent Fix duplicate saves. · Reviewer: claude-opus-5-5");
  assert.equal(await evaluate(`document.querySelector('button[aria-label^="Model: "]').ariaLabel`), builder);
  console.log("Reviewer provider filters, model ID and name search, fixed controls while scrolling, keyboard selection and draft restoration passed.");
  await writeFile(
    join(artifacts, "browser-checks.json"),
    JSON.stringify(receipts, null, 2),
  );
  console.log(
    "Compact Add-menu layout, absence of native tooltips, Escape, Enter, and arrow navigation passed.",
  );
} finally {
  ws?.close();
  browser.kill("SIGTERM");
}
