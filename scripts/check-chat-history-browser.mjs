import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1420";
const profile = await mkdtemp(join(tmpdir(), "gyro-history-qa-"));
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ||
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=" + profile,
    "--remote-debugging-port=9488",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let ws;
async function until(check, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out: " + label);
}
try {
  const pages = await until(
    async () => (await fetch("http://127.0.0.1:9488/json/list")).json(),
    "browser startup",
  );
  ws = new WebSocket(
    pages.find((page) => page.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const response = JSON.parse(String(data));
    const callback = pending.get(response.id);
    if (callback) {
      pending.delete(response.id);
      response.error
        ? callback.reject(response.error)
        : callback.resolve(response.result);
    }
  };
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 850,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: origin + "/chat-history-fixture.html" });
  await until(
    () =>
      evaluate("document.querySelectorAll('.gyro-chat-turn').length === 1550"),
    "entire saved chat",
  );
  const metrics = () =>
    evaluate(
      `(() => {const t=document.querySelector('.gyro-chat-transcript');return {top:t.scrollTop,height:t.scrollHeight,client:t.clientHeight,count:document.querySelectorAll('.gyro-chat-turn').length,first:t.textContent.includes('First message in the entire saved chat.'),last:t.textContent.includes('History answer 1549')};})()`,
    );
  assert.equal((await metrics()).first, true);
  assert.equal((await metrics()).last, true);
  await until(async () => {
    const m = await metrics();
    return m.height - m.client - m.top < 5;
  }, "initial latest position");
  const point = await evaluate(
    "(() => {const r=document.querySelector('.gyro-chat-transcript').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()",
  );
  await call("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...point,
    deltaX: 0,
    deltaY: -900,
  });
  await until(async () => {
    const m = await metrics();
    return m.height - m.client - m.top > 400;
  }, "wheel scroll away from latest");
  await evaluate(
    "(() => {const t=document.querySelector('.gyro-chat-transcript');t.scrollTop=700;t.dispatchEvent(new Event('scroll',{bubbles:true}));})()",
  );
  const before = (await metrics()).top;
  await evaluate(
    "[...document.querySelectorAll('button')].find(b=>b.textContent==='Append 500 turns').click()",
  );
  await until(
    () =>
      evaluate("document.querySelectorAll('.gyro-chat-turn').length === 2050"),
    "long-running history",
  );
  // Wait two paints so stream/resize observers have had an opportunity to pin.
  await evaluate(
    "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
  );
  assert.ok(
    Math.abs((await metrics()).top - before) < 2,
    "appended replies cannot move an upward reader",
  );
  assert.equal(
    (await metrics()).first,
    true,
    "first message remains after passing 2,500 events",
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b=>b.textContent==='Stream latest reply').click()",
  );
  await until(
    () =>
      evaluate(
        "Number(document.querySelector('#stream-render-cost').dataset.ms) > 0",
      ),
    "profiled stream",
  );
  assert.ok(
    Math.abs((await metrics()).top - before) < 2,
    "cached live replies preserve an upward reader",
  );
  console.log(
    "Fixture stream render mean: " +
      (await evaluate(
        "document.querySelector('#stream-render-cost').dataset.ms",
      )) +
      " ms",
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b=>b.textContent==='Reopen saved chat').click()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('[role=status]').textContent.startsWith('Reopened') && document.querySelectorAll('.gyro-chat-turn').length === 2050",
      ),
    "reopened entire history",
  );
  await evaluate(
    "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
  );
  assert.ok(
    Math.abs((await metrics()).top - before) < 2,
    "reopening preserves reading position",
  );
  await evaluate("document.querySelector('.gyro-chat-transcript').scrollTop=0");
  await call("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...point,
    deltaX: 0,
    deltaY: -200,
  });
  const firstBounds = await evaluate(
    "(() => {const t=document.querySelector('.gyro-chat-transcript'),f=t.querySelector('.gyro-chat-turn');return {first:f.getBoundingClientRect().top,top:t.getBoundingClientRect().top};})()",
  );
  assert.ok(
    Math.abs(firstBounds.first - firstBounds.top) < 80,
    "earliest message is reachable by scrolling",
  );
  const shot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(
    "/private/tmp/gyro-chat-history-verified.png",
    Buffer.from(shot.data, "base64"),
  );
  await evaluate(
    "document.querySelector('[aria-label=\"Jump to latest message\"]').click()",
  );
  await until(async () => {
    const m = await metrics();
    return m.height - m.client - m.top < 5;
  }, "explicit jump to latest");
  await evaluate(
    "[...document.querySelectorAll('button')].find(b=>b.textContent==='Append 500 turns').click()",
  );
  await until(
    () =>
      evaluate("document.querySelectorAll('.gyro-chat-turn').length === 2550"),
    "continued live chat",
  );
  await until(async () => {
    const m = await metrics();
    return m.height - m.client - m.top < 5;
  }, "following latest after append");
  console.log(
    "PASS: actual ChatSurface opens all 3,100 events, retains all 5,100 events as it grows, reaches the first message, preserves upward reading during append/remount, and follows latest only after an explicit jump. Disk/provider data are generated fixtures.",
  );
} finally {
  ws?.close();
  browser.kill();
  await new Promise((resolve) =>
    browser.exitCode !== null ? resolve() : browser.once("exit", resolve),
  );
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
