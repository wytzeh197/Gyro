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
  process.env.GYRO_CAPTURE_OUTPUT ||
    "docs/screenshots/2026-11-10-v012-workflows",
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
const profile = await mkdtemp(join(tmpdir(), "gyro-workflows-"));
const port = Number(process.env.GYRO_CAPTURE_PORT || 9498);
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
        `(() => { const root = ${scope}; const b = [...root.querySelectorAll('button')].find(b => b.getClientRects().length && [b.getAttribute('aria-label'),b.getAttribute('title'),b.textContent.trim(),b.querySelector('strong')?.textContent.trim(),b.matches('.gyro-companion-launcher button') ? b.querySelector('span')?.textContent.trim() : null].includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`,
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
      url: `${origin}/v012-workflow-fixture.html?${query}`,
    });
    await until(
      () =>
        evaluate(
          `Boolean(document.querySelector('.gyro-workflows-destination'))`,
        ),
      "workflow destination",
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
  async function setField(label, value) {
    await evaluate(
      `(()=>{const l=[...document.querySelectorAll('label')].find(l=>l.childNodes[0]?.textContent.trim()===${JSON.stringify(label)});const input=l?.querySelector('input,select,textarea');if(!input)throw Error('missing field');const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));return true;})()`,
    );
    await pause(200);
  }
  async function field(label, value) {
    await evaluate(
      `(()=>{const l=[...document.querySelectorAll('label')].find(l=>[...l.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim()===${JSON.stringify(label)});const input=l?.querySelector('input,select,textarea');if(!input)throw Error('missing field '+${JSON.stringify(label)});const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`,
    );
    await pause(200);
  }
  async function checkbox(label) {
    assert.equal(
      await evaluate(
        `(()=>{const l=[...document.querySelectorAll('label')].find(l=>l.innerText.trim()===${JSON.stringify(label)});const input=l?.querySelector('input[type=checkbox]');if(!input)throw Error('missing checkbox '+${JSON.stringify(label)});input.click();return true})()`,
      ),
      true,
    );
    await pause(200);
  }
  async function setup() {
    await click("Run workflow…");
    await until(
      async () => (await text()).includes("Provider for reader"),
      "role setup",
    );
    assert.equal(
      await evaluate(
        `![...document.querySelectorAll('button')].some(b=>b.textContent==='Start workflow')`,
      ),
      true,
    );
    await click("Check setup");
    await until(
      async () => (await text()).includes("Choose every required"),
      "missing bindings",
    );
    await field("File path (required)", "src/value.rs");
    await field("Provider for reader", "cli-fixture");
    await field("Model for reader", "cli-model");
    await field("Provider for reviewer", "api-fixture");
    await field("Model for reviewer", "review-model");
    await field("focused-tests", "focused-test");
    await click("Check setup");
    await until(
      async () => (await text()).includes("Configuration checked."),
      "checked",
    );
  }
  await load("state=empty");
  await screenshot("workflow-empty-dark");
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  assert.equal(
    await evaluate("document.activeElement.textContent.trim()"),
    "Workflows",
    "keyboard enters navigation in order",
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.activeElement).outlineStyle !== 'none'",
    ),
    true,
    "keyboard focus is visible",
  );
  await screenshot("workflow-keyboard-focus");
  await click("New workflow");
  await click("Save workflow");
  assert.equal(
    await evaluate("document.activeElement.getAttribute('aria-invalid')"),
    "true",
    "invalid save focuses the missing name",
  );
  assert.equal(
    await evaluate(
      "window.workflowFixture.calls.filter(c=>c.action==='save').length",
    ),
    0,
    "incomplete workflow is not saved",
  );
  await field("Name", "Inspect a change");
  assert.equal(
    await evaluate(
      `document.querySelector('input[value="inspect-a-change"]')!==null`,
    ),
    true,
    "generated stable id",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('.gyro-workflow-advanced')].every(el=>!el.open)",
    ),
    true,
    "advanced settings start collapsed",
  );
  assert.equal(
    await evaluate(
      "Math.round(document.querySelector('.gyro-workflow-editor-footer').getBoundingClientRect().bottom) === innerHeight",
    ),
    true,
    "save bar sits at the viewport edge",
  );
  await screenshot("workflow-editor-dark");
  await click("Discard changes");
  await click("Investigate a bug");
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-workflow-step-fields textarea').value.includes('{{input.problem}}')",
    ),
    true,
    "starter references its declared input",
  );
  assert.equal(
    await evaluate("document.querySelector('input[value=problem]') !== null"),
    true,
    "starter supplies a required input",
  );
  await field("Name", "Investigate my bug");
  await screenshot("workflow-starter-editor-dark");
  await click("Save workflow");
  await until(
    async () => !(await text()).includes("Saving does not start a run"),
    "starter saved",
  );
  assert.equal(
    await evaluate(
      "window.workflowFixture.calls.filter(c=>['launch','schedule'].includes(c.action)).length",
    ),
    0,
    "saving a starter never launches or schedules",
  );
  await click("Edit workflow");
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-workflow-step-fields textarea').value.includes('{{input.problem}}')",
    ),
    true,
    "saved instructions round trip",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('input[value=investigate-my-bug]') !== null",
    ),
    true,
    "renamed starter receives its own identifier",
  );
  await load("state=empty&theme=light", 900);
  await screenshot("workflow-empty-light");
  await load("state=empty&theme=light", 430);
  assert.equal(
    await evaluate("document.documentElement.scrollWidth <= innerWidth"),
    true,
    "narrow library fits viewport",
  );
  await screenshot("workflow-empty-light-narrow");
  await click("New workflow");
  await field("Name", "My task");
  await click("Save workflow");
  assert.equal(
    await evaluate("document.activeElement.tagName"),
    "TEXTAREA",
    "invalid save focuses missing instructions",
  );
  await field("Instructions", "Read the project and explain its structure.");
  await screenshot("workflow-editor-light-narrow");
  await click("Save workflow");
  await until(
    async () => !(await text()).includes("Saving does not start a run"),
    "blank workflow saved",
  );
  assert.equal(
    await evaluate(
      "window.workflowFixture.calls.filter(c=>c.action==='save').length",
    ),
    1,
    "only the complete workflow is saved",
  );
  await load();
  await until(
    async () => (await text()).includes("Disabled: Unsupported"),
    "future definition preserved",
  );
  await screenshot("workflow-library-dark");
  await setup();
  await screenshot("workflow-setup-dark");
  assert.equal(
    await evaluate(
      `window.workflowFixture.calls.filter(c=>['launch','schedule'].includes(c.action)).length`,
    ),
    0,
    "checking never launches",
  );
  await click("Start workflow");
  await until(async () => (await text()).includes("Queued"), "queued launch");
  await screenshot("workflow-queued-dark");
  await click("Cancel launch");
  await until(
    async () => (await text()).includes("Needs attention"),
    "cancel queued launch",
  );
  await click("Schedules");
  await until(
    async () => (await text()).includes("Existing prompt schedules"),
    "legacy schedule preserved",
  );
  await screenshot("workflow-schedules-dark");
  await load("theme=light&density=compact", 700);
  await setup();
  await evaluate(
    "[...document.querySelectorAll('summary')].find(item=>item.textContent==='Schedule (optional)').click()",
  );
  await field("Run timing", "hourly");
  await click("Check setup");
  await click("Create schedule");
  await until(
    async () =>
      (await text()).includes("Pinned version") &&
      (await text()).includes("Existing prompt schedules"),
    "created schedule remains alongside legacy schedules",
  );
  await screenshot("workflow-schedule-created-light-compact");
  await load("state=stale&theme=light", 650);
  await click("Run workflow…");
  await until(
    async () => (await text()).includes("Adopt this recipe version"),
    "stale binding",
  );
  await screenshot("workflow-stale-light");
  assert.equal(
    await evaluate(
      `![...document.querySelectorAll('button')].some(b=>b.textContent==='Start workflow')`,
    ),
    true,
    "stale cannot launch",
  );
  await click("Adopt this recipe version");
  await load("state=conflict");
  await click("Edit workflow");
  await field("Description (optional)", "Edited locally");
  await click("Save workflow");
  await until(
    async () => (await text()).includes("changed on disk"),
    "save conflict",
  );
  assert.ok((await text()).includes("Edit workflow"));
  await screenshot("workflow-save-conflict");
  await load("state=unproven", 430);
  await click("Create from a chat");
  await until(
    async () => (await text()).includes("Inspect the scoped arithmetic"),
    "source selection",
  );
  await click("Preview selected task");
  await until(
    async () => (await text()).includes("unproven draft"),
    "unproven capture",
  );
  await field("Provider", "api-fixture");
  await field("Model", "review-model");
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='Create draft · uses selected provider').disabled`,
    ),
    true,
    "unproven acknowledgement required",
  );
  await screenshot("workflow-extraction-narrow");
  await checkbox("Extract an unproven draft from this source");
  await click("Inspect exact input");
  await until(
    async () => (await text()).includes("Frozen source evidence"),
    "exact input",
  );
  await click("Create draft · uses selected provider");
  await until(
    async () => (await text()).includes("Edit workflow draft"),
    "extracted draft",
  );
  await click("Edit workflow draft");
  await screenshot("workflow-extracted-editor-narrow");
  assert.equal(
    await evaluate(
      `window.workflowFixture.calls.filter(c=>c.action==='launch').length`,
    ),
    0,
    "extraction does not launch",
  );
  await load("state=extract-running");
  await click("Create from a chat");
  await until(
    async () => (await text()).includes("Inspect the scoped arithmetic"),
    "source task ready",
  );
  await click("Preview selected task");
  await field("Provider", "api-fixture");
  await field("Model", "review-model");
  await click("Create draft · uses selected provider");
  await until(
    async () => (await text()).includes("Stop extraction"),
    "extraction running",
  );
  await click("Stop extraction");
  await until(
    async () => (await text()).includes("cancelled"),
    "extraction cancelled",
  );
  await screenshot("workflow-extraction-cancelled");
  await click("Delete private draft");
  await until(
    async () => (await text()).includes("New workflow"),
    "private draft deleted",
  );
  await load("state=waiting");
  await click("Runs");
  await click("Inspect changes");
  await until(
    async () => (await text()).includes("Approval attempt stopped"),
    "waiting detail",
  );
  await screenshot("workflow-waiting-dark");
  await click("Inspect retry");
  await until(
    async () => (await text()).includes("Queue explicit continuation"),
    "retry preview",
  );
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='Queue explicit continuation').disabled`,
    ),
    true,
    "retry requires inspection",
  );
  await screenshot("workflow-retry-inspection-dark");
  await click("Cancel retry");
  await click("Stop run");
  await until(
    async () => (await text()).toLowerCase().includes("cancelled"),
    "cancel run",
  );
  await load("state=attention&theme=light", 650);
  await click("Runs");
  await click("Inspect changes");
  await until(
    async () => (await text()).includes("2 open findings"),
    "attention detail",
  );
  await screenshot("workflow-attention-light");
  await click("Delete run record…");
  await click("Delete run record");
  await until(
    async () => (await text()).includes("No workflow runs yet"),
    "deleted private run record",
  );
  await load("state=error");
  await until(
    async () => (await text()).includes("Fixture: source project unavailable"),
    "unavailable",
  );
  await screenshot("workflow-unavailable");
  assert.equal(
    await evaluate("document.documentElement.scrollWidth <= innerWidth"),
    true,
    "no document horizontal overflow",
  );
  assert.equal(errors.length, 0, "no browser exceptions");
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(
      {
        status: "passed",
        evidence:
          "synthetic production components; no native/provider execution",
        captures: manifest,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `PASS workflow library, editor, setup, queue, extraction, retry, cancellation, schedules, conflicts, attention and ${manifest.length} captures. ${output}\n`,
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
