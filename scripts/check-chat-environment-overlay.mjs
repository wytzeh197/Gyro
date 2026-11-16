// Production chat/grid fixture: Environment must not replace the companion.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1459";
const output = process.env.GYRO_TEST_ARTIFACTS ?? "/private/tmp/gyro-environment-overlay";
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "gyro-environment-overlay-"));
const port = 9498;
const browser = spawn(process.env.GYRO_CAPTURE_BROWSER ??
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank",
], { stdio: "ignore" });
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause();
  }
  throw Error("Timed out: " + label);
}
let socket, call, evaluate;
const errors = [];
try {
  let page;
  await until(async () => {
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find(page => page.type === "page");
      return Boolean(page);
    } catch { return false; }
  }, "browser startup");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => { socket.onopen = resolve; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    message.error ? task.reject(message.error) : task.resolve(message.result);
  };
  call = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Runtime.enable");
  await call("Page.enable");
  const geometry = `(() => {
    const s = document.querySelector('.gyro-chat-surface.is-thread');
    const box = el => { if (!el) return null; const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
    return {
      canvas:box(s.querySelector('.gyro-chat-thread-canvas')),
      composer:box(s.querySelector('.gyro-composer-shell')),
      panel:box(document.querySelector('.gyro-chat-companion')),
      overlay:box(s.querySelector('.gyro-chat-environment-popover')),
      trigger:box(s.querySelector('.gyro-chat-thread-topbar button[aria-label="Environment"]')),
      panelTriggers:document.querySelectorAll('.gyro-chat-companion button[aria-label="Environment"]').length,
      overlays:document.querySelectorAll('.gyro-chat-environment-popover').length,
    };
  })()`;
  const sameBox = (a,b,label) => {
    assert.ok(a && b, label + " exists");
    for (const key of ["left","right","top","bottom"])
      assert.ok(Math.abs(a[key]-b[key]) < 1, label + " must not move: " + key);
  };
  for (const scenario of [
    {name:"wide-dark",width:1440,theme:"dark"},
    {name:"narrow-light",width:980,theme:"light"},
    {name:"split-dark",width:1920,theme:"dark",split:true},
  ]) {
    await call("Emulation.setDeviceMetricsOverride", {width:scenario.width,height:1000,deviceScaleFactor:1,mobile:false});
    await call("Page.navigate", {url:`${origin}/first-run-tour-fixture.html?scene=thread&panel=files&provider=connected&theme=${scenario.theme}${scenario.split ? "&split=1" : ""}`});
    await until(() => evaluate("Boolean(document.querySelector('.gyro-chat-companion'))"), "companion ready");
    await until(() => evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Skip tour')"), "tour ready");
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Skip tour').click()");
    await until(() => evaluate("![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Skip tour')"), "tour dismissed");
    await pause(600);
    const before = await evaluate(geometry);
    assert.ok(before.trigger, "Environment stays in the chat header");
    assert.equal(before.panelTriggers, 0, "Environment does not migrate into the companion");
    await evaluate("document.querySelector('.gyro-chat-surface.is-thread .gyro-chat-thread-topbar button[aria-label=\"Environment\"]').focus()");
    await call("Input.dispatchKeyEvent", {type:"keyDown",key:" ",code:"Space",windowsVirtualKeyCode:32});
    await call("Input.dispatchKeyEvent", {type:"keyUp",key:" ",code:"Space",windowsVirtualKeyCode:32});
    await until(() => evaluate("Boolean(document.querySelector('.gyro-chat-environment-popover'))"), "Environment opens by keyboard");
    await pause(300);
    const after = await evaluate(geometry);
    sameBox(before.canvas,after.canvas,"Chat canvas");
    sameBox(before.composer,after.composer,"Composer");
    sameBox(before.panel,after.panel,"Right panel");
    assert.equal(after.overlays,1,"Environment opens only in the selected chat");
    assert.ok(after.overlay.left >= after.canvas.left - 1 && after.overlay.right <= after.canvas.right + 1,
      "Environment remains over the chat, outside the right panel");
    assert.ok(after.overlay.top >= after.canvas.top - 1 && after.overlay.bottom <= after.canvas.bottom + 1,
      "Environment stays vertically inside the chat");
    const shot = await call("Page.captureScreenshot", {format:"png"});
    await writeFile(join(output, scenario.name+".png"), Buffer.from(shot.data,"base64"));
    await evaluate("document.querySelector('button[aria-label=\"Close environment\"]').click()");
    await until(() => evaluate("!document.querySelector('.gyro-chat-environment-popover')"), "Environment closes independently");
    sameBox(before.panel,(await evaluate(geometry)).panel,"Right panel after closing Environment");
    await evaluate("document.querySelector('.gyro-chat-surface.is-thread .gyro-chat-thread-topbar button[aria-label=\"Environment\"]').click()");
    await until(() => evaluate("Boolean(document.querySelector('.gyro-chat-environment-popover'))"), "Environment opens by click");
    sameBox(before.panel,(await evaluate(geometry)).panel,"Right panel after clicking Environment");
    await evaluate("document.querySelector('.gyro-chat-surface.is-thread .gyro-chat-thread-topbar button[aria-label=\"Environment\"]').click()");
    await until(() => evaluate("!document.querySelector('.gyro-chat-environment-popover')"), "header toggle closes Environment");
  }
  assert.deepEqual(errors, [], "no browser exceptions");
  console.log("Environment overlay checks passed: header location, keyboard activation, unchanged chat/composer/panel geometry, pane bounds, independent close; wide, narrow and split layouts.");
} catch (error) {
  if (call && evaluate) {
    console.error(await evaluate("document.body.innerText").catch(() => ""));
    const shot = await call("Page.captureScreenshot", {format:"png"}).catch(() => null);
    if (shot) await writeFile(join(output,"failure.png"),Buffer.from(shot.data,"base64"));
  }
  throw error;
} finally {
  socket?.close();
  browser.kill("SIGTERM");
  if (browser.exitCode === null) await new Promise(resolve=>browser.once("exit",resolve));
  await rm(profile,{recursive:true,force:true});
}
