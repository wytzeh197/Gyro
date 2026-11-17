import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Actual xterm renderer in an isolated browser; no native IPC or provider calls.
const profile = await mkdtemp(join(tmpdir(), "gyro-terminal-renderer-"));
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
  const end = Date.now() + 20000;
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

  const output =
    process.env.GYRO_CAPTURE_OUTPUT ?? "/tmp/gyro-terminal-renderer";
  await mkdir(output, { recursive: true });
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 650,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", {
    url:
      (process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1437") +
      "/terminal-renderer-fixture.html",
  });
  await until(
    () => evaluate("window.terminalFixture?.events.sizes.length > 0"),
    "terminal mount",
  );
  await pause(500);
  assert.equal(
    await evaluate("window.terminalFixture.events.rejectedResizes"),
    2,
    "failed initial resizes must retry",
  );
  const geometry = () =>
    evaluate(`(() => {
    const rect = e => { const r = e.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
    const host = document.querySelector('.gyro-xterm-host');
    const style = getComputedStyle(host);
    return {host:rect(host), frame:rect(document.querySelector('.gyro-xterm-frame')),
      screen:rect(host.querySelector('.xterm-screen')), actualWidth:parseFloat(host.querySelector('.xterm-screen').style.width),actualHeight:parseFloat(host.querySelector('.xterm-screen').style.height), viewport:rect(host.querySelector('.xterm-viewport')),
      padding: {right:parseFloat(style.paddingRight),bottom:parseFloat(style.paddingBottom)},
      overflowY:getComputedStyle(host.querySelector('.xterm-viewport')).overflowY,
      sizes:window.terminalFixture.events.sizes};
  })()`);
  const checkGeometry = async (label) => {
    const g = await geometry();
    console.log(label, JSON.stringify(g));
    assert.ok(
      g.actualWidth <= g.screen.width + 1 &&
        g.actualHeight <= g.screen.height + 1,
      label + ": declared terminal grid must fit unclipped",
    );
    assert.ok(
      g.screen.right <= g.host.right - g.padding.right + 1,
      label + ": last column fits inside padding",
    );
    assert.ok(
      g.screen.bottom <= g.host.bottom - g.padding.bottom + 1,
      label + ": last row fits inside padding",
    );
    assert.ok(
      g.host.bottom <= g.frame.bottom + 1,
      label + ": terminal fits below notice",
    );
    assert.equal(
      g.overflowY,
      "scroll",
      label + ": native scrollback scrollbar is available",
    );
  };
  // Cursor-addressed TUI frame using exactly the dimensions reported to the PTY.
  const drawFrame = () =>
    evaluate(`(() => {
    const [cols,rows] = window.terminalFixture.events.sizes.at(-1);
    const esc=String.fromCharCode(27);
    let output = esc+'[?7l'+esc+'[2J'+esc+'[H';
    for(let row=1;row<=rows;row++) output += esc+'['+row+';1H'+(row===1||row===rows?'+'+'-'.repeat(cols-2)+'+':'|'+' '.repeat(cols-2)+'|');
    window.terminalFixture.pane({output});
  })()`);
  // Continue through cases when collecting pre-fix evidence.
  const failures = [];
  const check = async (label) => {
    try {
      // A fixture has no child receiving SIGWINCH; explicitly redraw its TUI
      // frame at the reported dimensions before capturing the resized state.
      if (label !== "failed process") { await drawFrame(); await pause(80); }
      await checkGeometry(label);
      if (["model notice", "small pane / large text", "failed process"].includes(label)) {
        const capture = await call("Page.captureScreenshot", { format: "png" });
        await writeFile(join(output, label.replaceAll(/[^a-z]+/g, "-") + ".png"), Buffer.from(capture.data, "base64"));
      }
    } catch (error) {
      failures.push(error.message);
    }
  };
  await drawFrame();
  await pause(100);
  await check("plain");
  await evaluate(
    "window.terminalFixture.pane({owner:{kind:'model',sessionId:'fixture-chat',turnId:'fixture-turn'}})",
  );
  await pause(400);
  await check("model notice");
  await evaluate("window.terminalFixture.pane({owner:undefined})");
  await evaluate("window.terminalFixture.update({scale:1.15,theme:'light'})");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 460,
    height: 300,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause(400);
  await check("small pane / large text");
  await evaluate("window.terminalFixture.update({hidden:true})");
  await pause(150);
  await evaluate("window.terminalFixture.update({hidden:false})");
  await pause(400);
  await check("revealed");
  await evaluate("window.terminalFixture.pane({status:'done'})");
  await pause(150);
  const beforeRestart = await evaluate(
    "window.terminalFixture.events.sizes.length",
  );
  await evaluate("window.terminalFixture.pane({status:'running',output:''})");
  await pause(250);
  const afterRestart = await evaluate(
    "window.terminalFixture.events.sizes.length",
  );
  if (afterRestart <= beforeRestart)
    failures.push(
      "restarted process must receive dimensions even when container size is unchanged",
    );
  // Ordinary typing, terminal control keys and inactive-process input suppression.
  await evaluate(
    "document.querySelector('.xterm-helper-textarea').focus();window.terminalFixture.events.input.length=0",
  );
  await call("Input.insertText", { text: "echo hello" });
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "c",
    code: "KeyC",
    windowsVirtualKeyCode: 67,
    modifiers: 2,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "c",
    code: "KeyC",
    windowsVirtualKeyCode: 67,
    modifiers: 2,
  });
  assert.equal(
    await evaluate("window.terminalFixture.events.input.join('')"),
    "echo hello\r\x03",
  );
  await evaluate(
    "window.terminalFixture.events.input.length=0;window.terminalFixture.pane({output:'\\x1b[?2004h'})",
  );
  await pause(100);
  await evaluate(
    `(() => { const data = new DataTransfer(); data.setData('text/plain', 'paste\\n😀'); document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', {clipboardData:data,bubbles:true,cancelable:true})); })()`,
  );
  assert.equal(
    await evaluate("window.terminalFixture.events.input.join('')"),
    "\x1b[200~paste\r😀\x1b[201~",
    "bracketed paste preserves unicode and newline semantics",
  );
  await evaluate(
    "document.querySelector('input').focus();window.terminalFixture.update({theme:'dark',scale:1})",
  );
  await pause(150);
  assert.equal(
    await evaluate("document.activeElement.getAttribute('aria-label')"),
    "Other input",
    "appearance changes must not steal focus",
  );
  await evaluate(
    "window.terminalFixture.pane({status:'done'});window.terminalFixture.events.input.length=0",
  );
  await pause(100);
  await evaluate("document.querySelector('.xterm-helper-textarea').focus()");
  await call("Input.insertText", { text: "must not send" });
  assert.equal(await evaluate("window.terminalFixture.events.input.length"), 0);
  await evaluate("window.terminalFixture.pane({status:'running'})");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 650,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause(400);
  await drawFrame();
  await pause(150);
  const shot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(output, "terminal-frame.png"),
    Buffer.from(shot.data, "base64"),
  );
  await evaluate("document.querySelector('.xterm-helper-textarea').focus()");
  assert.equal(
    await evaluate("window.terminalFixture.clear()"),
    true,
    "native clear routes to focused terminal",
  );
  await evaluate("document.querySelector('input').focus()");
  assert.equal(
    await evaluate("window.terminalFixture.clear()"),
    false,
    "global search remains available outside terminal",
  );
  await evaluate("window.terminalFixture.pane({status:'failed',output:'Fixture command failed\\r\\nExit code: 1\\r\\nOutput remains available to select and copy.'})");
  await pause(400);
  await check("failed process");
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-xterm-host').getBoundingClientRect().bottom <= document.querySelector('.gyro-terminal-recovery').getBoundingClientRect().top",
    ),
    true,
    "recovery action must not cover output",
  );
  await evaluate("document.querySelector('.gyro-xterm-host').focus()");
  assert.equal(
    await evaluate(
      "document.activeElement.classList.contains('xterm-helper-textarea')",
    ),
    true,
    "keyboard focus on the host reaches terminal input",
  );
  await evaluate("document.querySelector('.gyro-xterm-host').click()");
  assert.equal(
    await evaluate("window.terminalFixture.events.reconnects"),
    0,
    "clicking failed output must not restart",
  );
  await evaluate("document.querySelector('.gyro-terminal-reconnect').click()");
  assert.equal(
    await evaluate("window.terminalFixture.events.reconnects"),
    1,
    "explicit restart remains available",
  );
  assert.deepEqual(failures, []);
  console.log(
    "Terminal geometry, notice, reveal, restart, typing, Ctrl-C, focus and stopped-input checks passed. Browser fixture only.",
  );
} finally {
  ws?.close();
  browser.kill("SIGTERM");
}
