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
  process.env.GYRO_CAPTURE_OUTPUT || "docs/screenshots/2026-11-10-v012-reviews",
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
const profile = await mkdtemp(join(tmpdir(), "gyro-code-reviews-"));
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
      )
        .json()
        .then((pages) =>
          pages.some((page) => page.type === "page") ? pages : undefined,
        ),
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
      url: `${origin}/v012-review-fixture.html?${query}`,
    });
    await until(
      () => evaluate(`Boolean(document.querySelector('.gyro-second-opinion'))`),
      "review panel",
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
  async function setupReview(query = "", width = 900) {
    await load(query, width);
    await click("Second opinion");
    await until(
      async () => (await text()).includes("Choose a reviewer…"),
      "reviewers",
    );
    assert.equal(
      await evaluate(
        "[...document.querySelectorAll('select')].find(el=>el.value==='uncommitted')?.closest('details').open",
      ),
      false,
      "scope options start collapsed",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.gyro-review-history').closest('details').open",
      ),
      false,
      "history starts collapsed",
    );
    await screenshot(
      "review-first-look" + (width < 500 ? "-light-narrow" : "-dark"),
    );
    await setField("Reviewer", "api-fixture");
    await setField("Model", "review-model");
    await click("Preview review");
    await until(
      async () => (await text()).includes("82 bytes"),
      "captured input",
    );
    assert.equal(
      await evaluate("window.reviewFixture.calls.includes('start')"),
      false,
      "preview never starts a provider review",
    );
    assert.equal(
      await evaluate(
        "[...document.querySelectorAll('.gyro-review-primary')].filter(el=>el.getClientRects().length).length",
      ),
      1,
      "one primary action in preview",
    );
    assert.equal(
      await evaluate("Boolean(document.querySelector('fieldset'))"),
      false,
      "preview replaces the setup form",
    );
  }
  await setupReview();
  assert.equal(
    await evaluate("document.activeElement.textContent"),
    "Ready to review",
    "keyboard focus moves to the preview",
  );
  await click("Change setup");
  assert.equal(
    await evaluate("document.activeElement.value"),
    "api-fixture",
    "returning restores reviewer focus and choice",
  );
  assert.equal(
    await evaluate("document.querySelector('input[list]').value"),
    "review-model",
    "returning preserves the model choice",
  );
  await screenshot("review-reviewer-selected-dark");
  await click("Preview review");
  await until(
    async () => (await text()).includes("Ready to review"),
    "preview again",
  );
  await screenshot("review-setup-dark");
  await click("Start review · review-model");
  await until(
    async () => (await text()).includes("A return value breaks"),
    "review result",
  );
  await click("P1 · Return the expected value");
  await until(
    () => evaluate("Boolean(document.querySelector('.gyro-plain-diff'))"),
    "captured diff",
  );
  assert.ok(
    await evaluate(
      "document.querySelector('.gyro-plain-diff-hunks').getBoundingClientRect().height > 60",
    ),
    "captured diff lines are visible",
  );
  await screenshot("review-result-dark");
  await evaluate("document.querySelector('input[type=checkbox]').click()");
  await click("Add 1 selected fixes to composer");
  assert.ok((await text()).includes("Address the selected fixture finding"));
  await click("Send 1 selected findings for fixes");
  await until(
    async () => (await text()).includes("implementing-turn-fixture"),
    "durable fix turn link",
  );
  await screenshot("review-fix-queue-dark");
  await click("Cancel fix request");
  await until(
    async () => (await text()).includes("cancelled"),
    "cancel queued fix",
  );
  await click("Dismiss finding");
  await until(
    async () => (await text()).includes("dismissed"),
    "persisted dismissal",
  );
  await click("Delete review…");
  await click("Delete review");
  await until(
    async () => (await text()).includes("Preview review"),
    "deleted review",
  );
  await setupReview("theme=light&density=compact&scale=large&width=320", 360);
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-second-opinion').scrollWidth>document.querySelector('.gyro-second-opinion').clientWidth+1",
    ),
    false,
    "narrow setup fits",
  );
  await screenshot("review-setup-light-narrow");
  await click("Start review · review-model");
  await until(
    async () => (await text()).includes("A return value breaks"),
    "narrow result",
  );
  await screenshot("review-result-light-narrow");
  await setupReview("state=incomplete");
  await click("Start review · review-model");
  await until(
    async () => (await text()).includes("Incomplete review."),
    "incomplete remains visible",
  );
  assert.ok((await text()).includes("1 of 2 files supplied"));
  await screenshot("review-incomplete");
  await setupReview("state=zero");
  await click("Start review · review-model");
  await until(
    async () => (await text()).includes("No findings reported"),
    "bounded zero-findings result",
  );
  await screenshot("review-zero-findings");
  await setupReview("state=stale");
  await click("Start review · review-model");
  await until(
    async () => (await text()).includes("source changed"),
    "stale source",
  );
  await evaluate("document.querySelector('input[type=checkbox]').click()");
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('selected fixes')).disabled",
    ),
    true,
    "stale fix needs revision choice",
  );
  await screenshot("review-stale");
  await setupReview("state=busy");
  await click("Start review · review-model");
  await until(
    async () => (await text()).includes("Stop review"),
    "running review",
  );
  await click("Stop review");
  await until(
    async () => (await text()).includes("cancelled"),
    "cancelled review",
  );
  await load("state=error");
  await click("Second opinion");
  await until(
    async () => (await text()).includes("Fixture: project unavailable"),
    "source error",
  );
  assert.ok(
    !(await text()).includes("Loading reviewers…"),
    "load failure does not appear to keep loading",
  );
  assert.ok((await text()).includes("Try again"), "load failure offers retry");
  await screenshot("review-unavailable");
  await load("entry=workspace");
  await until(
    async () => (await text()).includes("Choose a reviewer…"),
    "Workspace entry opens second opinion setup",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('select')].some(select=>select.value==='uncommitted')",
    ),
    true,
  );
  await screenshot("review-workspace-entry");
  await load("entry=turn");
  await until(
    async () => (await text()).includes("This task’s changes"),
    "turn entry summary",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('select')].some(select=>select.value==='turn')",
    ),
    true,
    "turn entry preserves scope",
  );
  await evaluate(
    "[...document.querySelectorAll('summary')].find(item=>item.textContent==='Options').click()",
  );
  assert.ok(
    (await text()).includes("source-turn-fixture"),
    "original source turn remains inspectable",
  );
  await screenshot("review-turn-entry");
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
    `PASS review capture, setup, findings/diff, draft, dismissal, deletion, incomplete/stale/zero/unavailable and ${manifest.length} captures. ${output}\n`,
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
