// Production React dialog, mocked transport. Real execution is covered by Rust.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkGeometryAndCompletion } from "./fixtures/gyro-check/geometry-acceptance.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = await mkdtemp(join(tmpdir(), "gyro-check-browser-"));
const profile = join(artifacts, "profile");
const free = createServer();
await new Promise((resolve) => free.listen(0, "127.0.0.1", resolve));
const port = free.address().port;
await new Promise((resolve) => free.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(
  process.execPath,
  [
    resolve(root, "apps/desktop/node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { cwd: resolve(root, "apps/desktop"), stdio: "ignore" },
);
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ||
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let ws;
let checks = 0;
const until = async (predicate) => {
  const end = Date.now() + 30_000;
  let last;
  while (Date.now() < end) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (e) {
      last = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${last?.message || "condition not met"}`);
};
try {
  await until(
    async () => (await fetch(`${origin}/local-check-fixture.html`)).ok,
  );
  const debugPort = await until(async () =>
    Number(
      (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
        "\n",
      )[0],
    ),
  );
  const pages = await until(async () =>
    (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(),
  );
  ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const result = JSON.parse(String(event.data));
    const p = pending.get(result.id);
    if (p) {
      pending.delete(result.id);
      result.error
        ? p.reject(new Error(result.error.message))
        : p.resolve(result.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const click = (label) =>
    evaluate(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) throw Error('Button unavailable: '+${JSON.stringify(label)}); b.click(); })()`,
    );
  const statuses = () =>
    evaluate(
      "window.__gyroCheckFixture.reports[0]?.results.map(r => r.status)",
    );
  const checkStatuses = async (expected) => {
    await until(
      async () => JSON.stringify(await statuses()) === JSON.stringify(expected),
    );
    assert.deepEqual(await statuses(), expected);
    checks++;
  };
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `${origin}/local-check-fixture.html` });
  await until(() => evaluate("!!document.querySelector('main')"));
  await click("Open Check");
  await until(() => evaluate("!!document.querySelector('[role=dialog]')"));
  assert.equal(
    await evaluate("document.querySelectorAll('.gyro-check-criterion').length"),
    0,
  );
  await click("Add requirement");
  assert.equal(
    await evaluate("document.querySelectorAll('.gyro-check-criterion').length"),
    1,
  );
  await click("Remove requirement");
  assert.equal(
    await evaluate("document.querySelectorAll('.gyro-check-criterion').length"),
    0,
  );
  checks += 3;
  await evaluate(
    "document.querySelector('details').open = true; document.querySelectorAll('details')[1].open = true",
  );
  await click("Load working");
  await click("Review check plan");
  await until(() =>
    evaluate(
      "!!document.querySelector('[aria-label=\"Review exact check action\"]')",
    ),
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('button')].find(b => b.textContent === 'Approve and run').disabled",
    ),
    true,
  );
  checks++;
  assert.equal(await evaluate("window.__gyroCheckFixture.executed"), 0);
  checks++;
  await click("Deny");
  await checkStatuses(["not-checked", "not-checked"]);
  assert.equal(await evaluate("window.__gyroCheckFixture.executed"), 0);
  checks++;
  await click("Review check plan");
  await until(() =>
    evaluate("!!document.querySelector('input[type=checkbox]')"),
  );
  await click("Cancel check");
  await until(() => evaluate("window.__gyroCheckFixture.reports.length === 2"));
  assert.equal(await evaluate("window.__gyroCheckFixture.executed"), 0);
  checks++;
  const newCheck = async () => {
    if (
      await evaluate(
        "[...document.querySelectorAll('button')].some(b => b.textContent === 'New check')",
      )
    )
      await click("New check");
  };
  const approve = async (variant) => {
    await newCheck();
    await click(`Load ${variant}`);
    await click("Review check plan");
    await until(() =>
      evaluate("!!document.querySelector('input[type=checkbox]')"),
    );
    await evaluate("document.querySelector('input[type=checkbox]').click()");
    await click("Approve and run");
  };
  await approve("working");
  await checkStatuses(["passed", "passed"]);
  assert.equal(await evaluate("window.__gyroCheckFixture.executed"), 1);
  checks++;
  await click("Check again");
  assert.equal(await evaluate("window.__gyroCheckFixture.executed"), 1);
  assert.equal(
    await evaluate("document.querySelectorAll('.gyro-check-criterion').length"),
    2,
  );
  await click("Review check plan");
  await until(() =>
    evaluate("!!document.querySelector('input[type=checkbox]')"),
  );
  assert.equal(
    await evaluate("document.querySelector('input[type=checkbox]').checked"),
    false,
  );
  await click("Deny");
  checks += 3;
  await approve("broken");
  await checkStatuses(["passed", "failed"]);
  await evaluate(
    "document.querySelector('.gyro-check-reports').scrollIntoView()",
  );
  const shot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(artifacts, "broken-report.png"),
    Buffer.from(shot.data, "base64"),
  );
  await approve("unavailable");
  await checkStatuses(["not-checked", "not-checked"]);
  await evaluate("window.__gyroCheckFixture.markStale()");
  await until(() => evaluate("!!document.querySelector('.gyro-check-stale')"));
  checks++;
  await newCheck();
  await click("Load working");
  await evaluate(
    "(() => { const t = document.querySelector('[role=dialog] textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'node fixture slow'); t.dispatchEvent(new Event('input', { bubbles: true })); })()",
  );
  await click("Review check plan");
  await until(() =>
    evaluate("!!document.querySelector('input[type=checkbox]')"),
  );
  await evaluate("document.querySelector('input[type=checkbox]').click()");
  await click("Approve and run");
  await until(() =>
    evaluate(
      "[...document.querySelectorAll('button')].some(b => b.textContent === 'Stop running check')",
    ),
  );
  const executionBeforeHide = await evaluate(
    "window.__gyroCheckFixture.executed",
  );
  await click("Close and keep running");
  await until(() => evaluate("!document.querySelector('[role=dialog]')"));
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-check-strip').dataset.running",
    ),
    "true",
  );
  assert.equal(
    await evaluate(
      "!!document.querySelector('[data-other-chat] .gyro-check-strip')",
    ),
    false,
  );
  await evaluate(
    "document.querySelector('[aria-label=\"Chat message\"]').focus()",
  );
  assert.equal(
    await evaluate("document.activeElement.getAttribute('aria-label')"),
    "Chat message",
  );
  await click("Details");
  await until(() => evaluate("!!document.querySelector('[role=dialog]')"));
  assert.equal(
    await evaluate("window.__gyroCheckFixture.executed"),
    executionBeforeHide,
  );
  checks += 4;
  const countBeforeStop = await evaluate(
    "window.__gyroCheckFixture.reports.length",
  );
  await click("Stop running check");
  await until(() =>
    evaluate(
      `window.__gyroCheckFixture.reports.length === ${countBeforeStop + 1}`,
    ),
  );
  await checkStatuses(["not-checked", "not-checked"]);
  const count = await evaluate("window.__gyroCheckFixture.reports.length");
  await click("Delete report");
  await until(() =>
    evaluate(`window.__gyroCheckFixture.reports.length === ${count - 1}`),
  );
  checks++;
  await approve("broken-form");
  await checkStatuses(["not-checked", "passed"]);
  assert.equal(
    await evaluate(
      "window.__gyroCheckFixture.reports[0].plan.draft.criteria[0].scope",
    ),
    "browser",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-check-report').textContent.includes('Required evidence: Browser interaction')",
    ),
    true,
  );
  checks++;
  const beforeBrowserPlan = await evaluate(
    "window.__gyroCheckFixture.executed",
  );
  await newCheck();
  await click("Load browser form check");
  await click("Review check plan");
  await until(() =>
    evaluate("!!document.querySelector('input[type=checkbox]')"),
  );
  const browserPlan = await evaluate("window.__gyroCheckFixture.pending.draft");
  assert.deepEqual(browserPlan.browser.viewport, { width: 1280, height: 800 });
  checks++;
  assert.ok(
    await evaluate(
      "document.querySelector('[aria-label=\"Review exact check action\"]').textContent.includes('Reviewed viewport: 1280 × 800 CSS pixels.')",
    ),
  );
  checks++;
  assert.equal(browserPlan.command, "");
  assert.equal(
    await evaluate("document.querySelector('[role=dialog]').scrollTop"),
    0,
  );
  assert.equal(browserPlan.browser.readySelector, "form");
  assert.equal(browserPlan.browser.steps.length, 6);
  assert.ok(browserPlan.criteria.every((c) => c.scope === "browser"));
  checks++;
  assert.equal(
    await evaluate("window.__gyroCheckFixture.executed"),
    beforeBrowserPlan,
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent==='Approve and run').disabled",
    ),
    true,
  );
  checks++;
  assert.equal(
    await evaluate(
      "document.querySelector('[aria-label=\"Review exact check action\"]').textContent.includes('Downloads and new windows are denied')",
    ),
    true,
  );
  checks++;
  const browserReview = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(artifacts, "browser-action-review.png"),
    Buffer.from(browserReview.data, "base64"),
  );
  await click("Deny");
  await checkStatuses(["not-checked", "not-checked"]);
  assert.equal(
    await evaluate("window.__gyroCheckFixture.executed"),
    beforeBrowserPlan,
  );
  checks++;
  await newCheck();
  await click("Load working");
  await evaluate(
    "(() => { const t = document.querySelector('[role=dialog] textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'node fixture slow'); t.dispatchEvent(new Event('input', { bubbles: true })); })()",
  );
  await click("Review check plan");
  await until(() =>
    evaluate("!!document.querySelector('input[type=checkbox]')"),
  );
  await evaluate("document.querySelector('input[type=checkbox]').click()");
  await click("Approve and run");
  await until(() =>
    evaluate(
      "document.querySelector('.gyro-check-strip')?.dataset.running === 'true'",
    ),
  );
  await click("Close");
  await until(() => evaluate("!document.querySelector('[role=dialog]')"));
  await evaluate("window.__gyroCheckFixture.completeRunning()");
  await until(() =>
    evaluate(
      "document.querySelector('.gyro-check-strip')?.dataset.running === 'false'",
    ),
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-check-strip').textContent.includes('2 passed')",
    ),
    true,
  );
  const finalExecutions = await evaluate("window.__gyroCheckFixture.executed");
  await click("Details");
  await until(() => evaluate("!!document.querySelector('[role=dialog]')"));
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-check-result-heading').textContent.includes('2 stale')",
    ),
    true,
  );
  assert.equal(
    await evaluate("window.__gyroCheckFixture.executed"),
    finalExecutions,
  );
  checks += 3;
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(
    await evaluate(
      "document.querySelector('[role=dialog]').scrollWidth <= document.querySelector('[role=dialog]').clientWidth",
    ),
    true,
  );
  checks++;
  await evaluate(
    "document.documentElement.dataset.theme = 'dark'; document.querySelector('[role=dialog]').scrollTop = 0",
  );
  const dark = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(artifacts, "mobile-dark.png"),
    Buffer.from(dark.data, "base64"),
  );
  const calls = await evaluate("window.__gyroCheckFixture.calls");
  // Keep the full suite as the default. The focused UI run is useful in
  // checkouts without the separately maintained historical geometry mockup.
  const geometry = process.argv.includes("--ui-only")
    ? { checks: 0, skipped: "Historical geometry mockup: explicit --ui-only scope" }
    : await checkGeometryAndCompletion({ send, evaluate, root, artifacts });
  checks += geometry.checks;
  await writeFile(
    join(artifacts, "result.json"),
    JSON.stringify(
      {
        evidence: "Browser UI fixture; mocked transport; no native execution",
        checks,
        calls,
        geometry,
      },
      null,
      2,
    ),
  );
  console.log(
    `${checks} local Check browser assertions passed. Artifacts: ${artifacts}`,
  );
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  vite.kill("SIGTERM");
  await new Promise((resolve) => browser.once("exit", resolve));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
