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
let captureFailure;
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
  captureFailure = async () => {
    await shot("failure.png");
    await writeFile(
      join(artifacts, "failure.json"),
      JSON.stringify(
        {
          errors,
          text: await evaluate("document.body.innerText"),
          html: await evaluate(
            "document.querySelector('.gyro-main')?.innerHTML",
          ),
        },
        null,
        2,
      ),
    );
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
  await click("SSH");
  await until(
    () => evaluate("document.body.innerText.includes('No saved SSH hosts')"),
    "SSH empty hosts",
  );
  await click("Connect");
  await until(
    () =>
      evaluate(
        "document.body.innerText.includes('Choose an SSH host or enter an address')",
      ),
    "SSH missing host validation",
  );
  await evaluate(
    `(() => { const select = document.querySelector('.gyro-remote-ssh-form select'); select.value = 'fixture-offline'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`,
  );
  await click("Connect");
  await until(
    () =>
      evaluate("document.body.innerText.includes('SSH connection refused')"),
    "SSH connection error",
  );
  await evaluate(
    `(() => { const select = document.querySelector('.gyro-remote-ssh-form select'); select.value = 'fixture-ssh-host'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`,
  );
  await click("Connect");
  await until(
    () => evaluate("document.body.innerText.includes('Connected to SSH Mac')"),
    "SSH connected status",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[role=switch][aria-label=\"Allow remote access\"]').getAttribute('aria-checked')",
    ),
    "false",
    "outgoing SSH does not require local hosting",
  );
  await click("Back to Workspace");
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('.gyro-sidebar-project-remote'))",
      ),
    "SSH projects discovered while hosting is off",
  );
  await click("Settings");
  await until(
    () =>
      evaluate(
        "[...document.querySelectorAll('button')].some(b => b.textContent.trim()==='SSH' && b.checkVisibility())",
      ),
    "settings method switch ready",
  );
  await click("SSH");
  await until(
    () => evaluate("document.body.innerText.includes('Saved SSH hosts')"),
    "return to SSH settings",
  );
  await shot("ssh-settings-dark.png");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await shot("ssh-settings-compact.png");
  assert.equal(
    await evaluate("document.documentElement.scrollWidth > innerWidth"),
    false,
    "SSH settings do not overflow compact viewport",
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click("Enter an address manually");
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('input[placeholder=\"mac-mini.local\"]'))",
      ),
    "manual SSH inputs",
  );
  await click("Choose from SSH config instead");
  await evaluate(
    "document.querySelector('.gyro-remote-ssh-menu summary').click()",
  );
  await click("Disconnect");
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-remote-ssh-host')?.innerText.includes('Not connected')",
      ),
    "SSH disconnect status",
  );
  await evaluate(
    "document.querySelector('.gyro-remote-ssh-menu summary').click()",
  );
  await click("Connect");
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-remote-ssh-host')?.innerText.includes('Connected') && !document.querySelector('.gyro-remote-ssh-host')?.innerText.includes('Connecting')",
      ),
    "SSH saved host reconnect",
  );
  await evaluate(
    "document.querySelector('.gyro-remote-ssh-menu summary').click()",
  );
  await click("Remove host");
  await until(
    () => evaluate("document.body.innerText.includes('No saved SSH hosts')"),
    "SSH remove host",
  );
  await click("Gyro pairing");
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
      evaluate(
        "document.querySelector('.gyro-chat-start h1')?.textContent.includes('remote-project')",
      ),
    "standard remote new-session surface",
  );
  assert.equal(
    await evaluate(
      "Boolean(document.querySelector('.gyro-sidebar-project-children > button.is-empty'))",
    ),
    false,
    "remote folders do not have a separate New chat row",
  );
  await evaluate("window.gyroRemoteFixture.startHostRun()");
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
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-remote-chat')?.innerText.includes('Started on the Mac Mini.')",
      ),
    "catch up to text produced before opening the chat",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-remote-chat')?.innerText.includes('pnpm typecheck')",
      ),
    "catch up to commands on the host",
  );
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('.gyro-sidebar-project-group:has(.gyro-sidebar-project-remote) [aria-label=\"Chat working\"]'))",
      ),
    "host run appears as working in the sidebar",
  );
  assert.equal(
    await evaluate(
      "window.gyroRemoteFixture.requests.some(r=>r.operation.op==='claim')",
    ),
    false,
    "watching a running chat does not acquire control",
  );
  await evaluate(
    "window.gyroRemoteFixture.streamText('Live text from the host.')",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-remote-chat')?.innerText.includes('Live text from the host.')",
      ),
    "text keeps streaming without refreshing",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-composer-context-meter [role=\"progressbar\"]')?.getAttribute('aria-label')?.includes('62%')",
      ),
    "host plan usage reaches the normal meter",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-composer-context-meter')?.textContent.includes('Waiting for provider measurement')",
    ),
    false,
    "live host context measurement is available",
  );
  await shot("live-host-chat.png");
  await evaluate(
    "document.querySelector('.gyro-composer-context-meter [role=\"progressbar\"]').focus()",
  );
  await pause(150);
  await shot("remote-usage-tooltip.png");
  await evaluate(
    "(() => { const f=window.gyroRemoteFixture; f.sessions.push({...f.sessions[0],id:'background-chat',title:'Another active remote chat'}); f.startHostRun('background-chat'); })()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelectorAll('.gyro-sidebar-project-group:has(.gyro-sidebar-project-remote) [aria-label=\"Chat working\"]').length===2",
      ),
    "every remote chat reports its host running state",
  );
  await evaluate(
    "[...document.querySelectorAll('.gyro-sidebar button')].find(b=>b.textContent.includes('Another active remote chat')).click()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-remote-chat')?.innerText.includes('Started on the Mac Mini.')",
      ),
    "a second running chat catches up independently",
  );
  await evaluate(
    "window.gyroRemoteFixture.streamText('Only the second chat.', 'background-chat')",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-remote-chat')?.innerText.includes('Only the second chat.')",
      ),
    "second chat streams live",
  );
  await evaluate(
    "window.gyroRemoteFixture.streamText('Work continued while this chat was away.')",
  );
  await evaluate(
    "[...document.querySelectorAll('.gyro-sidebar button')].find(b=>b.textContent.includes('Existing remote chat')).click()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-remote-chat')?.innerText.includes('Live text from the host.')",
      ),
    "switch back to the first active chat",
  );
  await until(
    () => evaluate(
      "[...document.querySelectorAll('.gyro-run-segment-toggle')].some(b=>b.textContent.includes('Ran 1 command'))",
    ),
    "durable tool progress returns in the work timeline",
  );
  await evaluate(
    "[...document.querySelectorAll('.gyro-run-segment-toggle')].find(b=>b.textContent.includes('Ran 1 command')).click()",
  );
  await until(
    () => evaluate(
      "document.querySelector('.gyro-remote-chat')?.innerText.includes('git status --short')",
    ),
    "returning to a chat reloads durable tool progress despite an unchanged host revision",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-remote-chat')?.innerText.includes('explicit browser fixture of a remote coding session')",
    ),
    true,
    "returning to a chat restores persisted messages as well as live text",
  );
  await until(
    () => evaluate(
      "document.querySelector('.gyro-remote-chat')?.innerText.includes('Work continued while this chat was away.')",
    ),
    "catch-up restores progress produced while another chat was selected",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-remote-chat')?.textContent.includes('pnpm typecheck')",
    ),
    true,
    "live tool progress remains alongside restored durable activity",
  );
  await until(
    () => evaluate(
      "window.gyroRemoteFixture.requests.filter(r=>r.operation.op==='history' && r.operation.sessionId==='existing-chat' && r.operation.revision).length >= 2",
    ),
    "subsequent refreshes still use conditional history reads",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-remote-chat')?.innerText.includes('Only the second chat.')",
    ),
    false,
    "host chat streams never bleed into each other",
  );

  assert.equal(
    await evaluate(
      "/Connecting to|is unavailable|Keep Gyro open|No projects on/.test(document.querySelector('.gyro-sidebar')?.innerText ?? '')",
    ),
    false,
    "background peer connection notices do not appear in the sidebar",
  );
  assert.equal(
    await evaluate("document.body.innerText.includes('Take control')"),
    false,
    "remote chats act without manual control",
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
  assert.equal(
    await evaluate("document.body.innerText.includes('Take control')"),
    false,
    "returning to a chat needs no control action",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-remote-chat')?.innerText.includes('Live text from the host.')",
      ),
    "reopening a running chat restores its current text",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-remote-chat')?.innerText.match(/Started on the Mac Mini\./g)?.length",
    ),
    1,
    "catch-up does not duplicate text after switching",
  );
  await evaluate(
    "document.querySelector('button[aria-label=\"Stop response\"]').click()",
  );
  await until(
    () =>
      evaluate(
        "window.gyroRemoteFixture.requests.some(r=>r.operation.op==='stop')",
      ),
    "Stop works immediately on a host-started run",
  );
  await until(
    () =>
      evaluate(
        "!document.querySelector('button[aria-label=\"Stop response\"]')",
      ),
    "stop settles the shared run",
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
      "document.querySelector('.gyro-sidebar-project-remote')?.getAttribute('aria-label')?.startsWith('Remote on ')",
    ),
    true,
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
  // Real composer controls must use only the selected host's catalog.
  await evaluate(`document.querySelector('.gyro-remote-chat button[aria-label^="Model:"]').click()`);
  await until(() => evaluate("document.querySelectorAll('.gyro-model-rail-model').length === 2"), "host model list");
  assert.equal(await evaluate("document.querySelectorAll('.gyro-model-rail-providers .gyro-model-rail-tile').length"), 1,
    "local-only providers never leak into the remote model menu");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.gyro-model-rail-model-name')].map(b => b.textContent)"),
    ["Host GPT 6.1", "Host GPT 6"], "remote picker uses host names, not raw IDs");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.gyro-model-rail-context')].map(b => b.textContent)"),
    ["300K", "500K"], "context sizes come from the host metadata");
  await evaluate("[...document.querySelectorAll('.gyro-model-rail-model')].find(b => b.querySelector('.gyro-model-rail-model-name').textContent === 'Host GPT 6').click()");
  await until(() => evaluate("window.gyroRemoteFixture.sessions.find(s => s.id === 'existing-chat').modelId === 'gpt-6'"),
    "model switch persists on the host before Send");
  await until(() => evaluate("!!document.querySelector('.gyro-remote-chat button[aria-label=\"Model: Host GPT 6\"]')"),
    "selected chip uses the host model name");
  await until(() => evaluate("!!document.querySelector('.gyro-remote-chat button[aria-label=\"Reasoning effort: Max\"]')"),
    "reasoning chip uses the host default");
  await evaluate("document.querySelector('.gyro-remote-chat button[aria-label^=\"Reasoning effort:\"]').click()");
  assert.equal(await evaluate("document.querySelector('input[aria-label=\"Reasoning effort\"]').max"), "1",
    "only the two host-supported reasoning levels are selectable");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
  await until(() => evaluate("window.gyroRemoteFixture.sessions.find(s => s.id === 'existing-chat').reasoningEffort === 'high'"),
    "keyboard effort choice persists on the host");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await evaluate(`(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZqkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'remote-parity.png', { type: 'image/png' }));
    document.querySelector('.gyro-remote-workspace textarea').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await until(() => evaluate("document.querySelector('.gyro-composer-attachment img')?.getAttribute('alt') === 'remote-parity.png'"),
    "pasted image reaches the remote composer");
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
  const submitted = await evaluate("window.gyroRemoteFixture.requests.findLast(r => r.operation.op === 'submit').operation");
  assert.equal(submitted.model.modelId, "gpt-6", "Send uses the selected host model");
  assert.equal(submitted.attachments.length, 1, "Send includes the pasted image");
  assert.equal(submitted.attachments[0].path.startsWith("/fixture/host-attachments/"), true,
    "client paths are replaced by host attachment paths");
  await until(() => evaluate("Boolean(document.querySelector('.gyro-transcript-attachments img')?.complete && document.querySelector('.gyro-transcript-attachments img')?.naturalWidth)"),
    "sent image preview loads from the host");
  await shot("remote-model-image-chat.png");
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
  // Hold the production reload request while a real keyboard edit reaches
  // Monaco. The delayed snapshot must not replace the newer editor buffer.
  await evaluate("window.gyroRemoteFixture.pauseFileReads()");
  await click("Reload from host");
  await until(() => evaluate("window.gyroRemoteFixture.pendingFileReadCount() === 1"), "held remote file reload");
  await evaluate("document.querySelector('.monaco-editor textarea.inputarea').focus()");
  await call("Input.insertText", { text: "// typed during delayed reload\n" });
  const typedDuringReload = "/typed\\s+during\\s+delayed\\s+reload/.test(document.querySelector('.monaco-editor')?.innerText ?? '')";
  await until(() => evaluate(typedDuringReload), "Monaco typing during host reload");
  await evaluate("window.gyroRemoteFixture.resumeFileReads()");
  await until(() => evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Save on host' && !b.disabled)"), "reload response settled");
  assert.equal(await evaluate(typedDuringReload), true, "A delayed reload preserves newer Monaco edits");
  await shot("files-reload-race.png");
  await click("Save on host");
  await until(() => evaluate("window.gyroRemoteFixture.requests.some(r=>r.operation.op==='writeFile' && r.operation.content.includes('typed during delayed reload'))"), "preserved edit saved to host fixture");
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
  const terminalPaste = "p".repeat(60 * 1024 - 1) + "😀" + "q".repeat(14 * 1024);
  await evaluate("window.__gyroPasteStart = window.gyroRemoteFixture.requests.length; document.querySelector('.xterm-helper-textarea').focus()");
  await call("Input.insertText", { text: terminalPaste });
  const pasteInputs = "window.gyroRemoteFixture.requests.slice(window.__gyroPasteStart).filter(r=>r.operation.op==='terminal' && r.operation.action==='input').map(r=>r.operation.input)";
  await until(() => evaluate(`(${pasteInputs}).join('').length === ${terminalPaste.length}`), "large Unicode paste delivered through the production terminal");
  const terminalPasteFrames = await evaluate(pasteInputs);
  assert.equal(terminalPasteFrames.join(""), terminalPaste);
  assert.equal(terminalPasteFrames.length, 2);
  assert.ok(terminalPasteFrames.every((text) => new TextEncoder().encode(text).length <= 60 * 1024));
  console.log("Remote terminal: large Unicode keyboard paste preserved in two bounded input frames.");
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
  await until(
    () => evaluate("!document.querySelector('.gyro-sidebar-project-remote')"),
    "offline host folders and cached chats disappear from the sidebar",
  );
  assert.equal(
    await evaluate("document.querySelector('.gyro-sidebar')?.innerText.includes('Existing local chat')"),
    true,
    "host sleep preserves local sidebar chats",
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
  await until(
    () => evaluate("Boolean(document.querySelector('.gyro-sidebar-project-remote'))"),
    "remote folders return after the host reconnects",
  );
  await evaluate("window.gyroRemoteFixture.setOnline(false)");
  await until(
    () => evaluate("!document.querySelector('.gyro-sidebar-project-remote')"),
    "background host sleep also removes cached chats while browsing locally",
  );
  assert.equal(
    await evaluate(`document.querySelector('textarea[aria-label="Local draft"]')?.value`),
    "Keep this local draft",
    "background host sleep preserves the local draft",
  );
  await evaluate("window.gyroRemoteFixture.setOnline(true)");
  await until(
    () => evaluate("Boolean(document.querySelector('.gyro-sidebar-project-remote'))"),
    "background discovery restores remote folders without manual reconnect",
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
    await evaluate("window.gyroRemoteFixture.sessions.length"),
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
  await click("New session");
  await click("New Chat");
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('.gyro-remote-chat .gyro-chat-start h1'))",
      ),
    "global New session opens the normal remote start screen",
  );
  assert.equal(
    await evaluate(
      "Boolean(document.querySelector('.gyro-chat-start .gyro-brand-logo img[alt=\"Gyro\"]'))",
    ),
    true,
    "new remote sessions reuse the Gyro logo",
  );
  assert.equal(
    await evaluate("Boolean(document.querySelector('.gyro-remote-composer'))"),
    false,
    "old remote-only composer is removed",
  );
  await shot("new-session-remote-dark.png");
  await evaluate(
    "document.querySelector('button[aria-label^=\"Project:\"]').click()",
  );
  await until(
    () => evaluate("Boolean(document.querySelector('.gyro-project-picker'))"),
    "standard project picker opens",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-project-picker')?.innerText.includes('Remote')",
    ),
    true,
    "remote projects are marked in the picker",
  );
  await evaluate(
    "[...document.querySelectorAll('.gyro-project-picker button')].find(b=>b.textContent.includes('No folder')).click()",
  );
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('.gyro-chat-start')) && !document.querySelector('.gyro-remote-workspace')",
      ),
    "No folder returns to a normal local new session",
  );
  await evaluate(
    "(() => { const f=document.querySelector('.gyro-chat-start textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(f,'Create through the normal remote folder picker'); f.dispatchEvent(new Event('input',{bubbles:true})); })()",
  );
  await pause(100);
  await evaluate(
    "document.querySelector('button[aria-label^=\"Project:\"]').click()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-project-picker')?.innerText.includes('Remote')",
      ),
    "local new-session picker includes remote folders",
  );
  await shot("project-picker-remote.png");
  await evaluate(
    "[...document.querySelectorAll('.gyro-project-picker [role=menuitem]')].find(b=>b.textContent.includes('Remote')).focus()",
  );
  assert.equal(
    await evaluate("document.activeElement.matches(':focus-visible')"),
    true,
    "remote folder has visible keyboard focus",
  );
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
  await until(
    () => evaluate("!document.querySelector('.gyro-project-picker')"),
    "Escape closes the remote folder picker",
  );
  assert.equal(
    await evaluate(
      "document.activeElement.getAttribute('aria-label')?.startsWith('Project:')",
    ),
    true,
    "project picker restores focus to its trigger",
  );
  await evaluate(
    "document.querySelector('button[aria-label^=\"Project:\"]').click()",
  );
  await evaluate(
    "[...document.querySelectorAll('.gyro-project-picker button')].find(b=>b.textContent.includes('remote-project') && b.textContent.includes('Remote')).click()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-remote-chat textarea')?.value === 'Create through the normal remote folder picker'",
      ),
    "draft follows selection to the remote host",
  );
  await evaluate(
    "document.querySelector('button[aria-label=\"Send message\"]').click()",
  );
  await until(
    () =>
      evaluate(
        "window.gyroRemoteFixture.requests.some(r=>r.operation.op==='submit' && r.operation.message==='Create through the normal remote folder picker')",
      ),
    "normal Send creates and submits on the host",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-remote-chat')?.innerText.includes('Fixture response: the request ran')",
      ),
    "new remote session receives its reply",
  );
  assert.equal(
    await evaluate(
      "document.body.innerText.includes('This action is unavailable remotely')",
    ),
    false,
    "usage refresh does not produce an unsupported-action error",
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

  // Exercise completion and multiple durable refreshes in a long remote chat.
  await evaluate(`(() => {
    const f = window.gyroRemoteFixture, id = 'scroll-chat';
    f.sessions.push({...f.sessions[0], id, title:'Scroll regression', updatedAt:new Date().toISOString()});
    f.histories.set(id, Array.from({length:18}, (_,i)=>({
      id:'scroll-history-'+i, sessionId:id, kind:'assistant-message',
      createdAt:'2026-11-13T09:00:00Z', message:'Earlier host output '+i+'\\n\\nA paragraph that stays in place while the host runs commands.', payload:{}
    })));
    f.startHostRun(id);
  })()`);
  await until(
    () => evaluate("[...document.querySelectorAll('.gyro-sidebar button')].some(b=>b.textContent.includes('Scroll regression'))"),
    "scroll regression chat discovered",
  );
  await evaluate("[...document.querySelectorAll('.gyro-sidebar button')].find(b=>b.textContent.includes('Scroll regression')).click()");
  await until(
    () => evaluate("document.querySelector('.gyro-remote-chat')?.innerText.includes('Started on the Mac Mini.')"),
    "scroll regression chat catches up",
  );
  await evaluate("window.gyroRemoteFixture.finishHostCommand('scroll-chat')");
  await until(
    () => evaluate("[...document.querySelectorAll('.gyro-remote-chat .gyro-run-segment-toggle')].length===2"),
    "completed command has a summary",
  );
  await pause(400);
  const following = await evaluate(`new Promise(resolve => {
    const t=document.querySelector('.gyro-remote-chat .gyro-chat-transcript');
    const row=[...t.querySelectorAll('.gyro-run-segment-toggle')].at(-1);
    row.click();
    setTimeout(()=>{
      const start=performance.now(), top=t.scrollTop, samples=[];
      const tick=()=>{
        samples.push({top:t.scrollTop, gap:t.scrollHeight-t.clientHeight-t.scrollTop});
        if(performance.now()-start<3200)requestAnimationFrame(tick);
        else resolve({top, samples, sameRow:row.isConnected, expanded:row.getAttribute('aria-expanded'),
          commands:[...t.querySelectorAll('.gyro-run-segment-toggle')].reduce((n,b)=>n+Number(b.textContent.match(/Ran (\\d+) command/)?.[1]??0),0)});
      };
      requestAnimationFrame(tick);
    },200);
  })`);
  assert.ok(following.sameRow && following.expanded === "true",
    "saved host history preserves the expanded command row");
  assert.equal(following.commands, 2, "live and saved copies count each command once");
  assert.ok(following.samples.every(s=>Math.abs(s.top-following.top)<=1 && Math.abs(s.gap)<=1),
    "following stays at the bottom without bouncing across host refreshes");

  const reading = await evaluate(`new Promise(resolve => {
    const t=document.querySelector('.gyro-remote-chat .gyro-chat-transcript');
    t.dispatchEvent(new WheelEvent('wheel',{deltaY:-160,bubbles:true}));
    t.scrollTop-=160;
    t.dispatchEvent(new Event('scroll',{bubbles:true}));
    const top=t.scrollTop, start=performance.now(), samples=[];
    window.gyroRemoteFixture.startHostCommand('scroll-chat','reader-command');
    setTimeout(()=>window.gyroRemoteFixture.finishHostCommand('scroll-chat','reader-command'),300);
    const tick=()=>{
      samples.push(t.scrollTop);
      if(performance.now()-start<3500)requestAnimationFrame(tick);
      else resolve({top,samples});
    };
    requestAnimationFrame(tick);
  })`);
  assert.ok(reading.samples.every(top=>Math.abs(top-reading.top)<=1),
    "reading earlier output stays still through command completion and history refresh");
  console.log("Remote scroll: stable command identity, no duplicate rows, bottom following and manual reading passed.");
  assert.deepEqual(errors, [], "no browser exceptions");
  await writeFile(
    join(artifacts, "result.json"),
    JSON.stringify(
      {
        ok: true,
        evidence: "explicit browser fixture using production components",
        checks: [
          "host-model-catalog",
          "host-model-persistence",
          "image-paste",
          "image-upload-on-send",
          "host-image-preview",
          "settings",
          "host-toggle",
          "invitation-cancel",
          "invitation-consumed",
          "automatic-project-discovery",
          "local-and-remote-ID-collision",
          "local-draft-preserved",
          "host-selection",
          "existing-session",
          "automatic-device-control",
          "host-started-live-text-and-commands",
          "remote-command-scroll-stability",
          "catch-up-after-switching",
          "durable-progress-restored-with-history-revisions",
          "host-context-and-plan-usage",
          "standard-new-session-remote-folder-picker",
          "submit",
          "files-editor",
          "stale-file-save",
        "reload-file-conflict",
        "slow-reload-preserves-typing",
          "git-diff",
        "terminal",
        "large-unicode-terminal-paste",
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
  await captureFailure?.();
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
