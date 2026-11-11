// Render production components with isolated sample data. This is browser
// fixture evidence, not native WebView, PTY or provider acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1432";
const output = resolve(
  process.env.GYRO_CAPTURE_OUTPUT || "docs/screenshots/2026-11-10-v012-memory",
);
const executable = [
  process.env.GYRO_CAPTURE_BROWSER,
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((path) => path && existsSync(path));
assert.ok(
  executable,
  "Set GYRO_CAPTURE_BROWSER to an installed Chromium executable.",
);
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "gyro-project-memory-"));
const port = Number(process.env.GYRO_CAPTURE_PORT || 9497);
const browser = spawn(
  executable,
  [
    "--headless=new",
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "--force-color-profile=srgb",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const pause = (ms = 100) => new Promise((done) => setTimeout(done, ms));
async function until(check, label) {
  const deadline = Date.now() + 30000;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await pause();
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ""}`);
}
let ws;
const errors = [];
const manifest = [];
try {
  const pages = await until(
    async () =>
      (
        await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1500),
        })
      ).json(),
    "capture browser",
  );
  ws = new WebSocket(
    pages.find((page) => page.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((done, fail) => {
    ws.onopen = done;
    ws.onerror = fail;
  });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails);
    if (
      message.method === "Runtime.consoleAPICalled" &&
      message.params.type === "error"
    )
      errors.push(message.params.args);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error
      ? request.reject(message.error)
      : request.resolve(message.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timed out: ${method}`));
      }, 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  async function evaluate(expression) {
    const response = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails)
      throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  async function click(label, scope = "document") {
    assert.equal(
      await evaluate(
        `(() => { const root = ${scope}; const b = [...root.querySelectorAll('button')].find(b => b.getClientRects().length && [b.getAttribute('aria-label'),b.getAttribute('title'),b.textContent.trim(),b.matches('.gyro-companion-launcher button') ? b.querySelector('span')?.textContent.trim() : null].includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`,
      ),
      true,
      `button exists: ${label}`,
    );
    await pause(300);
  }

  await call("Page.enable");
  await call("Runtime.enable");
  async function load(query = "", width = 900, height = 800) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", {
      url: `${origin}/v012-feature-fixture.html?${query}`,
    });
    await until(
      () =>
        evaluate(
          query.includes("shell=1")
            ? "Boolean(document.querySelector('.gyro-sidebar'))"
            : `Boolean(document.querySelector('.gyro-memory-panel') && !document.querySelector('.gyro-memory-list[aria-busy="true"]'))`,
        ),
      "memory panel",
    );
    await pause(600);
  }
  async function screenshot(name) {
    const shot = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(
      join(output, `${name}.png`),
      Buffer.from(shot.data, "base64"),
    );
    manifest.push(name);
  }
  const text = () => evaluate("document.body.innerText");
  const setText = async (value) =>
    evaluate(
      `(()=>{const input=document.querySelector('.gyro-memory-editor textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
    );
  await load();
  assert.ok((await text()).includes("Use the shared provider runtime"));
  await screenshot("memory-dark");
  await click("Add note");
  await setText("Prefer the shared runtime for all provider execution.");
  await evaluate(
    "document.querySelector('.gyro-memory-editor textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  assert.ok(
    await evaluate("Boolean(document.querySelector('.gyro-memory-editor'))"),
    "Escape retains unsaved draft",
  );
  await click("Save memory");
  await until(
    async () => (await text()).includes("Memory saved"),
    "confirmed save",
  );
  assert.ok((await text()).includes("Prefer the shared runtime"));
  await evaluate(
    "[...document.querySelectorAll('.gyro-memory-list li button')].find(button=>button.textContent.includes('Prefer the shared runtime')).click()",
  );
  await pause(150);
  await click("Forget");
  await click("Forget memory");
  await until(
    async () => (await text()).includes("Memory forgotten"),
    "confirmed forget",
  );
  assert.ok(!(await text()).includes("Prefer the shared runtime"));
  await evaluate(
    "document.querySelector('.gyro-memory-list li button').click()",
  );
  await pause(150);
  await click("Edit memory");
  await setText("Keep my draft while the file changes.");
  await click("Simulate external edit");
  await click("Save memory");
  await until(
    () => evaluate("Boolean(document.querySelector('[role=alert]'))"),
    "conflict",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-memory-editor textarea').value",
    ),
    "Keep my draft while the file changes.",
  );
  await screenshot("memory-conflict");
  await click("Discard edits");
  assert.ok(
    await evaluate("Boolean(document.querySelector('.gyro-memory-history'))"),
    "memory history section",
  );
  assert.ok(
    (await text()).includes("Prepared for this turn") ||
      /\d+ entr(y|ies) ·/.test(await text()),
  );
  await screenshot("memory-receipts");
  await load("theme=light&width=320&density=compact&scale=large", 480, 800);
  assert.ok(
    await evaluate(
      "(()=>{const panel=document.querySelector('.gyro-memory-panel');return panel.scrollWidth<=panel.clientWidth+1;})()",
    ),
    "no horizontal overflow at compact width and large scale",
  );
  await screenshot("memory-light-compact-large");
  await load("state=suggestions");
  await click("Suggestions (2)");
  await click("Review suggestion");
  await setText(
    "Use the shared runtime for the corrected durable fixture decision.",
  );
  await click("Save memory");
  await until(
    async () => (await text()).includes("Memory saved"),
    "accepted suggestion",
  );
  await click("Suggestions (1)");
  await click("Dismiss");
  await until(
    async () => (await text()).includes("No suggestions yet"),
    "dismissed suggestion",
  );
  await click("Saved notes");
  assert.ok((await text()).includes("corrected durable fixture decision"));
  await screenshot("memory-suggestions-accepted");
  await load("state=empty");
  assert.ok((await text()).includes("No project memory yet"));
  await screenshot("memory-empty");
  await load("state=error");
  assert.ok((await text()).includes("project memory is unavailable"));
  assert.ok(
    !(await text()).includes("No project memory yet"),
    "failed load is not presented as empty memory",
  );
  await screenshot("memory-error");
  await load("chat=1&theme=light", 1440, 900);
  assert.ok(
    await evaluate("Boolean(document.querySelector('.gyro-chat-companion'))"),
    "production companion shell",
  );
  await screenshot("memory-companion-light");
  await load("chat=1&tiled=1", 680, 900);
  await screenshot("memory-companion-narrow");
  await load("shell=1&chat=1&theme=light", 1440, 900);
  assert.equal(
    await evaluate("Boolean(document.querySelector('.gyro-memory-panel'))"),
    false,
    "memory starts closed in the shell fixture",
  );
  assert.equal(
    await evaluate(
      `Boolean(document.querySelector('.gyro-sidebar-action[aria-label$="project memory"]'))`,
    ),
    false,
    "project memory is absent from the sidebar chat list",
  );
  const projectBounds = await evaluate(
    "(()=>{const r=document.querySelector('.gyro-sidebar-project-toggle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()",
  );
  await call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...projectBounds,
  });
  await until(
    () =>
      evaluate("Boolean(document.querySelector('.gyro-project-hover-card'))"),
    "hover reveals project details",
  );
  await click(
    "Edit project",
    "document.querySelector('.gyro-project-hover-card')",
  );
  await click(
    "Project memory",
    "document.querySelector('.gyro-project-edit-dialog')",
  );
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('.gyro-project-edit-dialog .gyro-memory-panel .gyro-memory-list') && !document.querySelector('.gyro-memory-list[aria-busy=\"true\"]'))",
      ),
    "project memory loads inside project settings",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-project-edit-dialog form').hidden",
    ),
    true,
  );
  await click(
    "Add note",
    "document.querySelector('.gyro-project-edit-dialog')",
  );
  await setText("Memory edited from project settings.");
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
    await evaluate("document.querySelector('.gyro-project-edit-dialog').open"),
    true,
    "Escape preserves the memory draft inside the dialog",
  );
  await click("Save memory");
  await until(
    async () => (await text()).includes("Memory saved"),
    "save memory in project settings",
  );
  assert.equal(
    await evaluate("document.querySelector('.gyro-project-edit-dialog').open"),
    true,
    "memory actions keep project settings open",
  );
  await click("General", "document.querySelector('.gyro-project-edit-dialog')");
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-project-edit-dialog form').hidden",
    ),
    false,
  );
  await click(
    "Project memory",
    "document.querySelector('.gyro-project-edit-dialog')",
  );
  assert.ok(
    await evaluate(
      'Boolean(document.querySelector(\'.gyro-sidebar-quick-actions button[aria-label="Workflows"][title="Workflows"]\'))',
    ),
    "compact sidebar workflow action has an accessible label and tooltip",
  );
  await screenshot("memory-project-settings-light");
  assert.equal(
    await evaluate(
      "(()=>{const d=document.querySelector('.gyro-project-edit-dialog');return d.scrollWidth<=d.clientWidth+1;})()",
    ),
    true,
    "project settings memory fits the dialog",
  );
  await click("Close edit project");
  assert.equal(
    await evaluate(
      "document.activeElement.matches('.gyro-sidebar-project-toggle')",
    ),
    true,
    "closing restores project folder focus",
  );
  await load("shell=1&chat=1&root=single", 900, 800);
  await evaluate(
    "document.querySelector('.gyro-sidebar-project-toggle').focus()",
  );
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  });
  await until(
    () =>
      evaluate("Boolean(document.querySelector('.gyro-project-hover-card'))"),
    "keyboard reveals project details",
  );
  await click(
    "Edit project",
    "document.querySelector('.gyro-project-hover-card')",
  );
  await screenshot("project-settings-general-dark");
  await click(
    "Project memory",
    "document.querySelector('.gyro-project-edit-dialog')",
  );
  await until(
    () =>
      evaluate(
        "Boolean(document.querySelector('.gyro-memory-list') && !document.querySelector('.gyro-memory-list[aria-busy=\"true\"]'))",
      ),
    "dark project settings memory loads",
  );
  assert.equal(
    await evaluate("Boolean(document.querySelector('.gyro-memory-project'))"),
    true,
    "single-folder projects use the same folder surface as General",
  );
  const longNote =
    "Keep project conventions close to the code they describe. " +
    "When a module moves, update its source checks and documentation together. " +
    "Verify the actual files before relying on a saved note, preserve unrelated edits, " +
    "and keep the full decision available when its compact preview is opened.";
  for (let index = 1; index <= 3; index++) {
    await click("Add note");
    await setText(`Example decision ${index}. ${longNote}`);
    await click("Save memory");
    await until(
      () => evaluate("!document.querySelector('.gyro-memory-editor')"),
      "long note saved",
    );
  }
  await evaluate(
    "document.querySelector('.gyro-project-settings-memory').scrollTop = 0",
  );
  const layout = await evaluate(`(() => {
    const dialog = document.querySelector('.gyro-project-edit-dialog');
    const body = document.querySelector('.gyro-project-settings-memory');
    const preview = [...document.querySelectorAll('.gyro-memory-note-preview')].at(-1);
    return {height: dialog.getBoundingClientRect().height,
      scrollable: body.scrollHeight > body.clientHeight,
      clamped: preview.scrollHeight > preview.clientHeight,
      title: document.querySelector('#gyro-project-edit-title').textContent};
  })()`);
  assert.ok(layout.height <= 640, "long notes keep the dialog bounded");
  assert.ok(
    layout.scrollable && layout.clamped,
    "long notes have compact previews in a scrollable body",
  );
  assert.equal(
    layout.title,
    "Edit project",
    "both tabs keep the same dialog title",
  );
  await screenshot("memory-project-settings-dark");
  await evaluate(
    "[...document.querySelectorAll('.gyro-memory-list li > button')].at(-1).click()",
  );
  assert.ok(
    (await text()).includes(longNote),
    "opening a compact preview reveals the complete note",
  );
  await click("All entries");
  await evaluate(
    "document.querySelector('.gyro-project-settings-memory').scrollTop = 0",
  );
  const headerTop = await evaluate(
    "document.querySelector('.gyro-project-edit-dialog > header').getBoundingClientRect().top",
  );
  await evaluate(
    "document.querySelector('.gyro-project-settings-memory').scrollTop = 10000",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-project-edit-dialog > header').getBoundingClientRect().top",
    ),
    headerTop,
    "scrolling notes keeps the title and close action fixed",
  );
  await evaluate(
    "document.querySelector('.gyro-project-settings-memory').scrollTop = 0",
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 480,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await pause(300);
  assert.equal(
    await evaluate(
      "(()=>{const d=document.querySelector('.gyro-project-edit-dialog');return d.scrollWidth<=d.clientWidth+1;})()",
    ),
    true,
    "narrow project settings has no horizontal overflow",
  );
  await screenshot("memory-project-settings-narrow");
  assert.deepEqual(errors, [], "no browser exceptions or console errors");
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(
      {
        evidence:
          "Production React components with synthetic fixture data; no native or live-provider acceptance",
        result: "passed",
        captures: manifest,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS memory save, forget, conflict, receipts, compact layout and ${manifest.length} captures. ${output}`,
  );
} catch (error) {
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(
      { result: "blocked", error: String(error), errors, captures: manifest },
      null,
      2,
    ),
  );
  throw error;
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  await Promise.race([
    new Promise((done) =>
      browser.exitCode !== null ? done() : browser.once("exit", done),
    ),
    pause(1500),
  ]);
  if (browser.exitCode === null) browser.kill("SIGKILL");
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
