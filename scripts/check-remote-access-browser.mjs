import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1449";
const artifacts =
  process.env.GYRO_TEST_ARTIFACTS ?? "/private/tmp/gyro-remote-browser";
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "gyro-remote-browser-profile-"));
const port = 9481;
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
let socket;
const errors = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await pause(100);
  }
  throw Error(`Timed out: ${description}`);
}
try {
  const page = await until(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (page) => page.type === "page",
      ),
    "browser startup",
  );
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails);
    const task = pending.get(message.id);
    if (task) {
      pending.delete(message.id);
      message.error ? task.reject(message.error) : task.resolve(message.result);
    }
  };
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
  const shot = async (name) => {
    const { data } = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(join(artifacts, name), Buffer.from(data, "base64"));
  };
  const click = (label) =>
    evaluate(
      `(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled && b.checkVisibility()); if (!button) throw Error('Button unavailable: ' + ${JSON.stringify(label)}); button.click(); return true; })()`,
    );
  const environment = async () => {
    if (
      !(await evaluate(
        "Boolean(document.querySelector('.gyro-env-panel-context'))",
      ))
    ) {
      await evaluate(
        "document.querySelector('button[aria-label=\"Environment\"]').click()",
      );
      await until(
        () =>
          evaluate(
            "Boolean(document.querySelector('.gyro-env-panel-context'))",
          ),
        "restore Environment card",
      );
    }
  };
  const details = async () => {
    await environment();
    await evaluate(
      "(() => { const b=document.querySelector('.gyro-env-panel-location'); if(b.getAttribute('aria-expanded')==='false') b.click(); })()",
    );
  };
  const tool = async (label) => {
    await details();
    await click(label);
  };
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: `${origin}/remote-access-preview.html` });
  await until(
    () => evaluate("document.body.innerText.includes('Shared projects')"),
    "settings fixture",
  );
  assert.equal(
    await evaluate("window.gyroRemoteFixture.syncedProjects.length"),
    0,
    "startup does not clear shares before local sessions load",
  );
  await evaluate("window.gyroHydrateLocalFixture()");
  await until(
    () => evaluate("window.gyroRemoteFixture.syncedProjects.length > 0"),
    "local projects sync after hydration",
  );
  await shot("settings-dark.png");
  await evaluate(
    "document.querySelector('[role=switch][aria-label=\"Allow remote access\"]').click()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('[role=switch]').getAttribute('aria-checked') === 'true'",
      ),
    "host toggle follows backend",
  );
  await click("Pair a device");
  await until(
    () =>
      evaluate(
        "document.querySelector('#gyro-copy-invitation')?.textContent.includes('EXPLICIT-BROWSER-FIXTURE')",
      ),
    "generated invitation",
  );
  await evaluate("window.gyroRemoteFixture.addPending('Second fixture Mac')");
  await until(
    () =>
      evaluate(
        "!document.querySelector('#gyro-copy-invitation') && document.body.innerText.includes('Second fixture Mac wants to connect')",
      ),
    "used invitation closes before expiry",
  );
  await click("Approve");
  await until(
    () =>
      evaluate(
        "!document.body.innerText.includes('Second fixture Mac wants to connect')",
      ),
    "pairing approval closes sheet",
  );
  await click("Pair a device");
  await until(
    () => evaluate("Boolean(document.querySelector('#gyro-copy-invitation'))"),
    "second invitation",
  );
  await click("Cancel");
  await until(
    () => evaluate("!document.querySelector('#gyro-copy-invitation')"),
    "cancel invitation",
  );
  await until(
    () => evaluate("document.body.innerText.includes('Open projects')"),
    "automatic remote discovery",
  );
  await click("Open projects");
  await until(
    () =>
      evaluate("document.body.innerText.includes('Connected · Experimental')"),
    "remote host connection",
  );
  await until(
    () => evaluate("document.body.innerText.includes('Existing remote chat')"),
    "host session listing",
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.includes('Existing remote chat')).click()",
  );
  await until(
    () =>
      evaluate(
        "document.body.innerText.includes('explicit browser fixture of a remote coding session')",
      ),
    "existing remote history",
  );
  await click("Take control");
  await until(
    () => evaluate('!document.body.innerText.includes("You\'re watching.")'),
    "control lease",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-env-panel-branch')?.textContent.trim() === 'main'",
      ),
    "host branch metadata",
  );
  assert.equal(
    await evaluate(
      "Boolean([...document.querySelectorAll('.gyro-sidebar button')].find(b=>b.textContent.includes('Existing local chat')))",
    ),
    true,
    "local chats remain beside remote chats",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.gyro-sidebar-project-toggle').length",
    ),
    2,
    "same-path local and remote folders remain separate",
  );
  await evaluate(
    "[...document.querySelectorAll('.gyro-sidebar button')].find(b=>b.textContent.includes('Existing local chat')).click()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-main')?.innerText.includes('Existing local history')",
      ),
    "local chat routes locally despite identical remote ID",
  );
  await evaluate(
    "(() => {const f=document.querySelector('textarea[aria-label=\"Local draft\"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(f,'Keep this local draft'); f.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await evaluate(
    "[...document.querySelectorAll('.gyro-sidebar button')].find(b=>b.textContent.includes('Existing remote chat')).click()",
  );
  await until(
    () => evaluate("Boolean(document.querySelector('.gyro-remote-chat'))"),
    "return to remote chat",
  );
  await click("Take control");
  await until(
    () => evaluate('!document.body.innerText.includes("You\'re watching.")'),
    "control after local navigation",
  );
  assert.equal(
    await evaluate(
      "Boolean(document.querySelector('.gyro-main textarea[aria-label=\"Local draft\"]'))",
    ),
    false,
    "inactive local DOM cannot change remote shell styling",
  );
  assert.equal(
    await evaluate("Boolean(document.querySelector('#gyro-machine'))"),
    false,
    "no global Machine picker",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-sidebar-project-remote')?.textContent.trim()",
    ),
    "Remote",
    "project has quiet remote marker",
  );
  assert.equal(
    await evaluate(
      "(() => { const b=[...document.querySelectorAll('.gyro-sidebar-project-toggle')].find(b=>b.querySelector('.gyro-sidebar-project-remote')); const name=b.querySelector('span').getBoundingClientRect(); const marker=b.querySelector('.gyro-sidebar-project-remote').getBoundingClientRect(); return Math.abs(name.y-marker.y)<2; })()",
    ),
    true,
    "remote marker stays on the project name row",
  );
  assert.equal(
    await evaluate("document.querySelector('.gyro-env-panel-remote')?.hidden"),
    true,
    "healthy chat hides host tools",
  );
  await shot("session-dark.png");
  await evaluate("document.documentElement.dataset.theme='light'");
  await pause(150);
  await shot("session-light.png");
  await evaluate("document.documentElement.dataset.theme='dark'");
  await details();
  await evaluate("document.querySelector('.gyro-env-panel-location').focus()");
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-env-panel-remote').hidden && document.activeElement.matches('.gyro-env-panel-location')",
    ),
    true,
    "Escape closes details and restores focus",
  );
  const fields = await evaluate(
    "[...document.querySelectorAll('textarea')].map(e=>({className:e.className,placeholder:e.placeholder,disabled:e.disabled}))",
  );
  await writeFile(
    join(artifacts, "composer-fields.json"),
    JSON.stringify(fields, null, 2),
  );
  await evaluate(
    "(() => { const field=document.querySelector('.gyro-remote-workspace textarea'); if(!field) throw Error('Composer missing'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Implement the fixture change'); field.dispatchEvent(new Event('input',{bubbles:true})); })()",
  );
  await pause(100);
  await writeFile(
    join(artifacts, "buttons.json"),
    JSON.stringify(
      await evaluate(
        "[...document.querySelectorAll('button')].map(e=>({label:e.getAttribute('aria-label'),title:e.title,text:e.textContent.trim(),disabled:e.disabled}))",
      ),
      null,
      2,
    ),
  );
  const submitButton = await evaluate(
    "(() => { const button=[...document.querySelectorAll('button')].find(b=>!b.disabled && /^(Send|Send message|Send prompt)$/.test(b.getAttribute('aria-label')||b.title||b.textContent.trim())); if(button){button.click();return true;} return false; })()",
  );
  assert.equal(submitButton, true, "composer can submit on the remote host");
  await until(
    () =>
      evaluate(
        "document.body.innerText.includes('Fixture response: the request ran')",
      ),
    "remote response",
  );
  await evaluate("window.gyroRemoteFixture.addApproval('pnpm typecheck')");
  await until(
    () => evaluate("document.body.innerText.includes('pnpm typecheck')"),
    "approval waiting",
  );
  await shot("approval-dark.png");
  await click("Reject");
  await until(
    () => evaluate("!document.body.innerText.includes('pnpm typecheck')"),
    "approval decision updates the UI",
  );
  await tool("Files");
  await until(
    () => evaluate("document.body.innerText.includes('src/main.ts')"),
    "remote files",
  );
  await evaluate(
    "[...document.querySelectorAll('.gyro-remote-file-list button')].find(b=>b.textContent.trim()==='src/main.ts').click()",
  );
  await until(
    () => evaluate("Boolean(document.querySelector('.monaco-editor'))"),
    "production Monaco editor",
  );
  await shot("files-dark.png");
  await evaluate("window.gyroRemoteFixture.mutateFile()");
  await click("Save on host");
  await until(
    () =>
      evaluate(
        "document.body.innerText.includes('File changed since it was read')",
      ),
    "stale file save rejected",
  );
  await click("Reload from host");
  await until(
    () =>
      evaluate(
        "/Changed\\s+on\\s+host/.test(document.querySelector('.monaco-editor')?.innerText ?? '')",
      ),
    "file conflict recovery",
  );
  // Let Monaco's debounced diagnostics finish before disposing the editor.
  await pause(1500);
  await tool("Source Control");
  await until(
    () =>
      evaluate("document.body.innerText.includes('src/main.ts · Unstaged')"),
    "Git changes",
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('src/main.ts · Unstaged')).click()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-remote-output')?.textContent.includes('diff --git')",
      ),
    "remote diff",
  );
  await shot("git-dark.png");
  await tool("Terminal");
  await click("New host terminal");
  await until(
    () => evaluate("Boolean(document.querySelector('.xterm'))"),
    "production terminal component",
  );
  await shot("terminal-dark.png");
  await evaluate("window.gyroRemoteFixture.setOnline(false)");
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('.gyro-remote-chat.is-readonly'))",
      ),
    "offline state",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-remote-terminal-body').hasAttribute('inert')",
    ),
    true,
    "offline terminal rejects input",
  );
  await environment();
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-env-panel-status')?.textContent === 'Unavailable'",
      ),
    "offline card status",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('button')].filter(b=>b.checkVisibility() && b.textContent.trim()==='Reconnect').length",
    ),
    1,
    "one Reconnect action",
  );
  await shot("offline-dark.png");
  await evaluate("window.gyroRemoteFixture.setOnline(true)");
  await click("Reconnect");
  await until(
    () => evaluate("!document.querySelector('.gyro-remote-chat.is-readonly')"),
    "reconnection",
  );
  await details();
  await click("This Mac");
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-main')?.innerText.includes('Existing local history')",
      ),
    "return to preserved local chat",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('textarea[aria-label=\"Local draft\"]')?.value",
    ),
    "Keep this local draft",
    "local draft survives remote browsing",
  );
  assert.equal(
    await evaluate(
      "Boolean(document.querySelector('.gyro-sidebar-project-remote'))",
    ),
    true,
    "remote folders remain available while browsing local chats",
  );
  await evaluate(
    "[...document.querySelectorAll('.gyro-sidebar button')].find(b=>b.textContent.includes('Existing remote chat')).click()",
  );
  await until(
    () => evaluate("Boolean(document.querySelector('.gyro-remote-chat'))"),
    "reopen remote chat from shared sidebar",
  );
  await evaluate(
    "(() => { const fixture = window.gyroRemoteFixture; for(let i=0;i<7;i++) fixture.sessions.push({...fixture.sessions[0],id:'extra-'+i,title:'More remote chat '+i}); })()",
  );
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('button[aria-label^=\"Show more chats in remote-project, remote\"]'))",
      ),
    "remote project uses normal collapsed chat count",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.gyro-sidebar-project-group:has(.gyro-sidebar-project-remote) .gyro-session-row').length",
    ),
    5,
    "initial remote project list stays compact",
  );
  await evaluate(
    "document.querySelector('button[aria-label^=\"Show more chats in remote-project, remote\"]').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.gyro-sidebar-project-group:has(.gyro-sidebar-project-remote) .gyro-session-row').length",
    ),
    8,
    "more reveals all remote chats",
  );
  await evaluate(
    "document.querySelector('button[aria-label^=\"Show fewer chats in remote-project, remote\"]').click()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelectorAll('.gyro-sidebar-project-group:has(.gyro-sidebar-project-remote) .gyro-session-row').length===5",
      ),
    "less restores compact project list",
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate("document.documentElement.dataset.theme='light'");
  await evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  await pause(150);
  await shot("workspace-light-900.png");
  assert.deepEqual(errors, [], "no browser exceptions");
  await writeFile(
    join(artifacts, "result.json"),
    JSON.stringify(
      {
        ok: true,
        evidence: "explicit browser fixture using production components",
        checks: [
          "settings",
          "host-toggle",
          "invitation-cancel",
          "invitation-consumed",
          "automatic-project-discovery",
          "local-and-remote-ID-collision",
          "local-draft-preserved",
          "host-selection",
          "existing-session",
          "controller",
          "submit",
          "files-editor",
          "stale-file-save",
          "reload-file-conflict",
          "git-diff",
          "terminal",
          "disconnect",
          "reconnect",
          "machine-switch",
          "light-narrow",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`Remote access browser checks passed. Artifacts: ${artifacts}`);
} catch (error) {
  console.error(error);
  if (socket?.readyState === WebSocket.OPEN) {
    const id = 999999;
    socket.send(
      JSON.stringify({
        id,
        method: "Page.captureScreenshot",
        params: { format: "png" },
      }),
    );
    await pause(100);
  }
  process.exitCode = 1;
} finally {
  socket?.close();
  browser.kill("SIGTERM");
  if (browser.exitCode === null)
    await new Promise((resolve) => browser.once("exit", resolve));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
