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
