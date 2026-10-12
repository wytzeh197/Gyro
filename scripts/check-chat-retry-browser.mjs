import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Production ChatRun/ChatSurface + explicit local host/native simulations.
// Real provider continuation and stream ordering are checked separately.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1420";
const artifactDirectory =
  process.env.GYRO_TEST_ARTIFACTS ?? join(root, "docs/design/chat-auto-retry");
await mkdir(artifactDirectory, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "gyro-chat-retry-browser-"));
const port = Number(process.env.GYRO_BROWSER_DEBUG_PORT ?? "9479");
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ??
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=BraveRewards,BraveVPN",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
let ws;
let screenshot;
const errors = [];
const snapshots = [];
const pause = (ms = 100) =>
  new Promise((resolvePause) => setTimeout(resolvePause, ms));
async function until(check, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await pause();
  }
  throw Error(`Timed out: ${description}`);
}
try {
  const page = await until(async () => {
    const pages = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    return pages.find((page) => page.type === "page");
  }, "browser startup");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    ws.onopen = resolveOpen;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    message.error
      ? callback.reject(message.error)
      : callback.resolve(message.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve: resolveCall, reject });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  screenshot = async (name) => {
    const { data } = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(join(artifactDirectory, name), Buffer.from(data, "base64"));
  };
  const screenshotPreview = async (name) => {
    const clip = await evaluate(
      `(()=>{const rect=document.querySelector('.gyro-chat-surface').getBoundingClientRect();const bottom=document.querySelector('.gyro-run-problem').getBoundingClientRect().bottom;return {x:rect.x-16,y:rect.y-16,width:rect.width+32,height:Math.max(rect.bottom,bottom)-rect.y+32,scale:2};})()`,
    );
    const { data } = await call("Page.captureScreenshot", {
      format: "png",
      clip,
      captureBeyondViewport: false,
    });
    await writeFile(join(artifactDirectory, name), Buffer.from(data, "base64"));
  };
  const key = async (name, virtual, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"]) {
      await call("Input.dispatchKeyEvent", {
        type,
        key: name,
        code: name,
        windowsVirtualKeyCode: virtual,
        modifiers,
        ...(name === "Enter" && type === "keyDown"
          ? { text: "\r", unmodifiedText: "\r" }
          : {}),
      });
    }
  };
  const click = (label) =>
    evaluate(
      `[...document.querySelectorAll('.gyro-run-problem-actions button')].find(button=>button.textContent===${JSON.stringify(label)}).click()`,
    );
  const state = `window.__gyroRetryFixture.getState()`;
  const countdown = `document.querySelector('.gyro-run-retry-countdown')?.textContent`;
  const problem = `document.querySelector('.gyro-run-problem.gyro-run-recovery')`;
  const header = `document.querySelector('.gyro-run-header')?.textContent`;
  const load = async (params = {}, width = 1440, height = 900) => {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", {
      url: `${origin}/chat-retry-fixture.html?${new URLSearchParams(params)}`,
    });
    await until(
      () =>
        evaluate(
          `!!window.__gyroRetryFixture && !!document.querySelector('.gyro-run')`,
        ),
      "fixture render",
    );
    await evaluate(`document.fonts.ready`);
  };
  const inspectLayout = async (name) => {
    const snapshot = await evaluate(`(()=>{
      const notice=${problem}; const style=notice&&getComputedStyle(notice);
      const rect=notice?.getBoundingClientRect();
      const controls=[...document.querySelectorAll('.gyro-run-problem-actions button')];
      const overflows=[...document.querySelectorAll('.gyro-run-problem,.gyro-run-problem-text,.gyro-run-problem-actions')]
        .filter(element=>element.scrollWidth>element.clientWidth+1)
        .map(element=>({className:element.className,client:element.clientWidth,scroll:element.scrollWidth}));
      return {theme:document.documentElement.dataset.theme,interfaceSize:document.documentElement.dataset.interfaceSize,
        density:document.documentElement.dataset.density,bodyOverflow:document.documentElement.scrollWidth>innerWidth+1,
        notice:rect&&{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
        styles:style&&{background:style.backgroundColor,border:style.borderColor,color:style.color,paddingLeft:style.paddingLeft},
        buttons:controls.map(button=>({label:button.textContent,fontSize:getComputedStyle(button).fontSize,height:button.getBoundingClientRect().height,
          inside:button.getBoundingClientRect().left>=rect.left&&button.getBoundingClientRect().right<=rect.right+1})),overflows};
    })()`);
    snapshots.push({ name, ...snapshot });
    assert.equal(snapshot.bodyOverflow, false, `${name}: no viewport overflow`);
    assert.deepEqual(
      snapshot.overflows,
      [],
      `${name}: no notice content overflow`,
    );
    assert.equal(
      snapshot.buttons.every((button) => button.inside),
      true,
      `${name}: controls stay within notice`,
    );
    if (snapshot.styles)
      assert.ok(
        Number.parseFloat(snapshot.styles.paddingLeft) > 0,
        `${name}: inset notice copy`,
      );
    await screenshot(`${name}.png`);
    return snapshot;
  };
  await call("Page.enable");
  await call("Runtime.enable");

  await load({ theme: "light" });
  assert.equal(
    await evaluate(countdown),
    "Retrying in 30s",
    "30-second schedule starts at 30",
  );
  assert.match(
    await evaluate(header),
    /Waiting to retry/,
    "scheduled header explains waiting",
  );
  assert.equal(
    await evaluate(`${problem}.getAttribute('role')`),
    "status",
    "transient failure is a polite status",
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.gyro-run-retry-countdown').getAttribute('aria-hidden')`,
    ),
    "true",
    "seconds are excluded from repeated announcements",
  );
  const deadlineBefore = await evaluate(
    `${state}.pending['fixture-failed-status'].retryAt`,
  );
  await inspectLayout("scheduled-light");
  await screenshotPreview("preview-light.png");
  await pause(2_200);
  const remaining = await evaluate(countdown);
  assert.match(
    remaining,
    /Retrying in 2[78]s/,
    "countdown follows actual elapsed seconds",
  );
  assert.equal(
    await evaluate(`${state}.pending['fixture-failed-status'].retryAt`),
    deadlineBefore,
    "repaints preserve the host deadline",
  );
  await evaluate(
    `[...document.querySelectorAll('.gyro-run-problem-actions button')].find(button=>button.textContent==='Retry now').focus()`,
  );
  await key("Tab", 9);
  assert.equal(
    await evaluate(`document.activeElement?.textContent`),
    "Cancel",
    "scheduled controls follow keyboard order",
  );
  assert.equal(
    await evaluate(`document.activeElement.matches(':focus-visible')`),
    true,
    "Cancel has visible keyboard focus",
  );
  await key("Enter", 13);
  await until(
    () => evaluate(`${state}.state==='cancelled'`),
    "cancelled schedule",
  );
  assert.equal(
    await evaluate(countdown),
    undefined,
    "cancel removes countdown",
  );
  assert.equal(await evaluate(`${state}.cancels`), 1, "cancel dispatched once");
  assert.equal(
    await evaluate(`${state}.retries`),
    0,
    "cancel has not sent retry",
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.gyro-run-problem-actions').textContent.trim()`,
    ),
    "Retry",
    "manual retry remains",
  );
  await inspectLayout("cancelled-light");
  await evaluate(
    `document.querySelector('.gyro-run-problem-actions button').focus()`,
  );
  await key("Tab", 9, 8);
  await key("Tab", 9);
  assert.equal(
    await evaluate(`document.activeElement?.textContent`),
    "Retry",
    "retry reachable through keyboard navigation",
  );
  assert.equal(
    await evaluate(`document.activeElement.matches(':focus-visible')`),
    true,
    "keyboard focus is visible",
  );
  assert.equal(
    await evaluate(`getComputedStyle(document.activeElement).outlineStyle`),
    "solid",
    "shared focus outline is rendered",
  );
  await screenshot("cancelled-keyboard-focus.png");
  await key("Enter", 13);
  await until(
    () => evaluate(`${state}.state==='retrying'`),
    "keyboard retry starts",
  );
  assert.equal(
    await evaluate(`${state}.retries`),
    1,
    "keyboard retry dispatches once",
  );
  assert.equal(
    await evaluate(`!!${problem}`),
    false,
    "active retry removes failure notice",
  );

  await load({ theme: "dark" });
  await inspectLayout("scheduled-dark");
  await screenshotPreview("preview-dark.png");
  await click("Retry now");
  await until(
    () => evaluate(`${state}.state==='retrying'`),
    "manual immediate retry",
  );
  assert.equal(
    await evaluate(`${state}.retries`),
    1,
    "Retry now dispatches once",
  );
  assert.deepEqual(
    await evaluate(`${state}.pending`),
    {},
    "Retry now clears scheduled attempt",
  );
  assert.equal(
    await evaluate(countdown),
    undefined,
    "Retry now clears countdown",
  );
  await inspectLayout("retrying-dark");

  for (const theme of ["light", "dark"]) {
    await load({ theme }, 860, 620);
    await inspectLayout(`scheduled-${theme}-860`);
    await load(
      {
        theme,
        narrow: "1",
        size: "large",
        density: "compact",
        accent: "#805ad5",
      },
      860,
      620,
    );
    await inspectLayout(`scheduled-${theme}-narrow-large-compact`);
  }
  await load(
    { theme: "light", size: "small", density: "compact", accent: "#007a5a" },
    860,
    620,
  );
  await inspectLayout("scheduled-light-small-compact");
  await load({ theme: "dark", state: "permanent" });
  assert.equal(
    await evaluate(countdown),
    undefined,
    "permanent failures have no automatic retry",
  );
  assert.equal(
    await evaluate(`${problem}.getAttribute('role')`),
    "alert",
    "permanent failure remains announced",
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.gyro-run-problem-actions').textContent.trim()`,
    ),
    "Sign in",
    "existing sign-in action remains",
  );
  await inspectLayout("permanent-dark");
  await click("Sign in");
  await until(() => evaluate(`${state}.reconnects===1`), "reconnect dispatch");
  assert.equal(
    await evaluate(`${state}.retries`),
    0,
    "reconnect does not resend",
  );
  await load({ theme: "light", state: "interrupted" }, 860, 620);
  assert.equal(
    await evaluate(countdown),
    undefined,
    "interrupted turns have no automatic schedule",
  );
  await inspectLayout("interrupted-light-860");
  await load({ theme: "dark", seconds: "3" });
  assert.equal(
    await evaluate(countdown),
    "Retrying in 3s",
    "fixture uses the actual shorter deadline",
  );
  await until(
    () => evaluate(`${state}.state==='retrying'`),
    "scheduled retry at its deadline",
  );
  assert.equal(
    await evaluate(`${state}.retries`),
    1,
    "automatic retry dispatches once",
  );
  assert.deepEqual(
    await evaluate(`${state}.pending`),
    {},
    "automatic retry clears deadline",
  );
  await pause(1_200);
  assert.equal(
    await evaluate(`${state}.retries`),
    1,
    "no duplicate automatic callback",
  );
  await load({ theme: "light", state: "done" });
  assert.equal(
    await evaluate(`!!${problem}`),
    false,
    "successful turn has no recovery notice",
  );
  await screenshot("done-light.png");

  // Native recovery keeps the original live turn, work, and approvals. It does
  // not start the host's failed-send scheduler or expose a second send action.
  await load({ theme: "light", state: "native-wait" });
  assert.equal(
    await evaluate(countdown),
    "Retrying in 30s",
    "native deadline starts at30s",
  );
  assert.match(
    await evaluate(header),
    /Waiting to retry/,
    "live native wait is explicit even with an approval",
  );
  assert.equal(
    await evaluate(`document.querySelector('.gyro-run').dataset.runState`),
    "retrying",
    "native waiting turn remains live",
  );
  assert.equal(
    await evaluate(`${problem}.getAttribute('role')`),
    "status",
    "native recovery announces politely",
  );
  assert.deepEqual(
    await evaluate(`${state}.pending`),
    {},
    "native recovery creates no host schedule",
  );
  assert.deepEqual(
    await evaluate(
      `[...document.querySelectorAll('.gyro-run-problem-actions button')].map(button=>button.textContent)`,
    ),
    ["Cancel"],
    "native wait offers only Cancel",
  );
  assert.equal(
    await evaluate(
      `!!document.querySelector('.gyro-run-retry,.gyro-run-pulse')`,
    ),
    false,
    "countdown replaces duplicate activity pulses",
  );
  assert.match(
    await evaluate(`${problem}.textContent`),
    /Recorded work and active tasks are preserved.*Retry 1 of 3/s,
    "continuation explains preserved work and bounded attempts",
  );
  assert.match(
    await evaluate(`document.querySelector('.gyro-run-rail').textContent`),
    /pnpm test/,
    "recorded command remains in timeline",
  );
  assert.equal(
    await evaluate(
      `!!document.querySelector('.gyro-inline-approval.is-pending')`,
    ),
    true,
    "existing approval stays actionable during native wait",
  );
  await inspectLayout("native-wait-light");
  await click("Cancel");
  await until(
    () => evaluate(`${state}.state==='native-cancelled'`),
    "native Cancel stops continuation",
  );
  assert.deepEqual(
    await evaluate(`${state}.lastStatusAction`),
    { action: "cancel-retry", eventId: "native-status" },
    "Cancel forwards the owning native status event",
  );
  assert.equal(
    await evaluate(`${state}.cancels`),
    1,
    "native cancellation dispatched once",
  );
  assert.equal(
    await evaluate(`${state}.retries`),
    0,
    "native cancellation does not resend",
  );
  assert.equal(
    await evaluate(`!!${problem}`),
    false,
    "stopped native wait removes recovery notice",
  );
  assert.match(
    await evaluate(header),
    /Stopped/,
    "native stop remains neutral",
  );
  await inspectLayout("native-cancelled-light");

  for (const theme of ["light", "dark"]) {
    await load(
      {
        theme,
        state: "native-wait",
        narrow: "1",
        size: "large",
        density: "compact",
      },
      860,
      620,
    );
    await inspectLayout(`native-wait-${theme}-narrow-large-compact`);
  }
  await load({ theme: "dark", state: "native-wait", seconds: "3" });
  assert.equal(
    await evaluate(countdown),
    "Retrying in 3s",
    "native fixture uses real short deadline",
  );
  await until(
    () => evaluate(`${state}.state==='native-resumed'`),
    "native retry-started resumes live turn",
  );
  assert.equal(
    await evaluate(`!!${problem}`),
    false,
    "native retry-started clears notice",
  );
  assert.equal(
    await evaluate(countdown),
    undefined,
    "native retry-started clears deadline",
  );
  assert.equal(
    await evaluate(`${state}.retries`),
    1,
    "native continuation starts once",
  );
  assert.equal(
    await evaluate(`document.querySelector('.gyro-run').classList.contains('is-live')`),
    true,
    "resumed turn returns to working",
  );
  assert.match(
    await evaluate(`document.querySelector('.gyro-run-rail').textContent`),
    /pnpm test/,
    "native resume keeps original tool work",
  );
  assert.equal(
    await evaluate(
      `!!document.querySelector('.gyro-inline-approval.is-pending')`,
    ),
    true,
    "approval survives native continuation",
  );
  await inspectLayout("native-resumed-dark");
  await evaluate(
    `[...document.querySelectorAll('.gyro-inline-approval-actions button')].find(button=>button.textContent==='Run command').click()`,
  );
  await until(
    () => evaluate(`${state}.approvals===1`),
    "existing approval still responds after continuation",
  );
  await evaluate(
    `[...document.querySelectorAll('nav[aria-label="Fixture controls"] button')].find(button=>button.textContent==='Finish native turn').click()`,
  );
  await until(
    () => evaluate(`${state}.state==='native-done'`),
    "native continued turn completes",
  );
  assert.match(
    await evaluate(`document.querySelector('.gyro-chat-surface').textContent`),
    /The existing turn finished successfully/,
    "final native reply is visible",
  );
  assert.equal(
    await evaluate(`!!${problem}`),
    false,
    "final native reply has no recovery notice",
  );
  await inspectLayout("native-done-dark");

  await load({ theme: "light", state: "native-exhausted" });
  assert.equal(
    await evaluate(countdown),
    undefined,
    "exhausted native attempts never re-arm countdown",
  );
  assert.match(
    await evaluate(`${problem}.textContent`),
    /after 3 automatic retries.*Retry or choose a different model/s,
    "exhausted capacity retains the actual reason and next actions",
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.gyro-run-problem-actions').textContent.trim()`,
    ),
    "Retry",
    "exhausted recovery offers manual retry",
  );
  await inspectLayout("native-exhausted-light");
  await click("Retry");
  await until(
    () => evaluate(`${state}.state==='native-resumed'`),
    "manual native continuation after exhausted attempts",
  );
  assert.equal(
    await evaluate(`${state}.retries`),
    1,
    "manual native continuation dispatches once",
  );
  assert.match(
    await evaluate(`document.querySelector('.gyro-run-rail').textContent`),
    /pnpm test/,
    "manual continuation retains original tools",
  );
  await writeFile(
    join(artifactDirectory, "browser-qa.json"),
    JSON.stringify({ snapshots, errors }, null, 2),
  );
  assert.deepEqual(errors, [], "no browser exceptions");
  await rm(join(artifactDirectory, "failure.png"), { force: true });
  console.log(
    `Chat recovery browser checks passed: countdown, cancel, keyboard/manual/automatic retry, native wait/resume/cancel/completion/exhaustion with preserved work and approvals, sign in, themes, sizes and no overflow. Screenshots: ${artifactDirectory}`,
  );
} catch (error) {
  await screenshot?.("failure.png");
  await writeFile(
    join(artifactDirectory, "browser-qa.json"),
    JSON.stringify({ snapshots, errors }, null, 2),
  );
  throw error;
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  await new Promise((resolveStop) =>
    browser.exitCode !== null
      ? resolveStop()
      : browser.once("exit", resolveStop),
  );
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
