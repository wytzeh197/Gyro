import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1420";
const output = "artifacts/usage-settings-review";
const profile = await mkdtemp(join(tmpdir(), "gyro-usage-settings-"));
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ||
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await delay(100);
  }
  throw Error("Timed out waiting for usage settings");
}
let ws;
const exceptions = [];
try {
  await mkdir(output, { recursive: true });
  const port = await until(
    async () =>
      (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
        "\n",
      )[0],
  );
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  ws = new WebSocket(
    targets.find((target) => target.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const result = JSON.parse(event.data);
    if (result.method === "Runtime.exceptionThrown")
      exceptions.push(result.params.exceptionDetails);
    const callback = pending.get(result.id);
    if (callback) {
      pending.delete(result.id);
      result.error
        ? callback.reject(result.error)
        : callback.resolve(result.result);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
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
  await call("Page.enable");
  await call("Runtime.enable");
  const navigate = async (
    scene = "reported",
    theme = "light",
    width = 1280,
  ) => {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", {
      url: `${origin}/settings-preview.html?section=usage-limits&connected=openai,anthropic&usage=${scene}&theme=${theme}`,
    });
    await until(() =>
      evaluate('!!document.querySelector(".gyro-usage-subnav")'),
    );
    await delay(200);
  };
  const click = async (selector) => {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).click()`,
    );
    await delay(50);
  };
  const tab = (name) =>
    `.gyro-usage-subnav [role="tab"]:nth-child(${name === "Usage" ? 1 : 2})`;
  const text = () =>
    evaluate('document.querySelector(".gyro-usage-settings").innerText');
  const snapshot = async (name) => {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(
      join(output, name + ".png"),
      Buffer.from(shot.data, "base64"),
    );
  };
  const change = async (label, value) => {
    await evaluate(
      `(() => { const select = document.querySelector('select[aria-label="${label}"]'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event("change", { bubbles: true })); })()`,
    );
    await delay(50);
  };
  await navigate();
  assert.deepEqual(
    await evaluate(
      'Array.from(document.querySelectorAll(".gyro-usage-subnav [role=tab]")).map(x=>x.textContent)',
    ),
    ["Usage", "Tokens"],
  );
  assert.match(await text(), /65%/);
  assert.doesNotMatch(await text(), /Daily budget|Recorded tokens/);
  await snapshot("usage-light");
  await click('[role="switch"][aria-label="Pause provider runs"]');
  assert.equal(
    await evaluate(
      `document.querySelector('[role="switch"][aria-label="Pause provider runs"]').getAttribute("aria-checked")`,
    ),
    "true",
  );
  await click('[role="switch"][aria-label="Daily pace warning"]');
  assert.equal(
    await evaluate(
      `document.querySelector('[role="switch"][aria-label="Daily pace warning"]').getAttribute("aria-checked")`,
    ),
    "false",
  );
  await click(tab("Tokens"));
  assert.match(await text(), /1M/);
  assert.doesNotMatch(
    await text(),
    /Provider-reported allowances|Pause provider runs/,
  );
  await change("Daily token budget", "500000");
  assert.equal(
    await evaluate(
      `document.querySelector('select[aria-label="Daily token budget"]').value`,
    ),
    "500000",
  );
  await snapshot("tokens-light");
  await change("Usage provider", "anthropic");
  assert.match(await text(), /2M/);
  assert.equal(
    await evaluate(
      `document.querySelector('select[aria-label="Daily token budget"]').value`,
    ),
    "0",
  );
  await change("Usage provider", "openai");
  assert.equal(
    await evaluate(
      `document.querySelector('select[aria-label="Daily token budget"]').value`,
    ),
    "500000",
  );

  // Arrow keys move focus and selection; Home/End select the endpoints.
  await evaluate(
    'document.querySelector(".gyro-usage-subnav [aria-selected=true]").focus()',
  );
  for (const [key, selected] of [
    ["ArrowLeft", "Usage"],
    ["End", "Tokens"],
    ["Home", "Usage"],
    ["ArrowLeft", "Tokens"],
  ]) {
    await call("Input.dispatchKeyEvent", { type: "keyDown", key });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key });
    assert.equal(
      await evaluate("document.activeElement.textContent"),
      selected,
    );
    assert.equal(
      await evaluate('document.activeElement.getAttribute("aria-selected")'),
      "true",
    );
  }
  // The production settings search reveals targets inside the hidden panel.
  await click(tab("Usage"));
  await evaluate(
    `(() => { const input = document.querySelector('input[aria-label="Search settings"]'); input.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; setter.call(input, "Token budget"); input.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
  await until(() =>
    evaluate(
      'Array.from(document.querySelectorAll("button")).some(x => x.textContent.includes("Token budget") && !x.closest("[hidden]"))',
    ),
  );
  await evaluate(
    'Array.from(document.querySelectorAll("button")).find(x=>x.textContent.includes("Token budget") && !x.closest("[hidden]")).click()',
  );
  await until(() =>
    evaluate(
      'document.querySelector(".gyro-usage-subnav [aria-selected=true]")?.textContent === "Tokens"',
    ),
  );
  assert.match(await text(), /daily budget/);

  for (const scene of [
    "loading",
    "error",
    "stale",
    "empty",
    "estimated",
    "missing",
    "unavailable",
  ]) {
    await navigate(scene);
    if (scene === "loading") {
      assert.match(await text(), /Loading provider allowance/);
      assert.equal(
        await evaluate(
          `document.querySelector('button[aria-label="Refresh provider usage"]').disabled`,
        ),
        true,
      );
    }
    if (scene === "error" || scene === "stale") {
      assert.match(await text(), /Could not refresh/);
      await click('button[aria-label="Refresh provider usage"]');
      assert.match(await text(), /65%/);
      assert.doesNotMatch(await text(), /Could not refresh/);
    }
    await click(tab("Tokens"));
    if (scene === "empty")
      assert.match(await text(), /No usage in this period/);
    if (scene === "estimated")
      assert.match(await text(), /includes estimates.*incomplete coverage/s);
    if (scene === "missing")
      assert.match(await text(), /Token counts unavailable/);
    if (scene === "unavailable")
      assert.match(await text(), /Token data unavailable/);
  }
  for (const [theme, width] of [
    ["dark", 1280],
    ["light", 860],
    ["dark", 640],
  ]) {
    await navigate("reported", theme, width);
    for (const page of ["Usage", "Tokens"]) {
      await click(tab(page));
      const overflow = await evaluate(
        'Array.from(document.querySelectorAll(".gyro-usage-settings, .gyro-usage-settings [role=tabpanel]:not([hidden])")).some(x=>x.scrollWidth>x.clientWidth+1)',
      );
      assert.equal(overflow, false, `${page} overflows at ${width}px ${theme}`);
      await snapshot(`${page.toLowerCase()}-${theme}-${width}`);
    }
  }
  assert.deepEqual(exceptions, []);
  console.log(
    "Usage settings passed: tabs, keyboard, search reveal, provider selection, budgets, warnings, pause, refresh, seven data states, light/dark and 640–1280px layouts.",
  );
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  await new Promise((resolve) => {
    if (browser.exitCode !== null) resolve();
    else browser.once("exit", resolve);
  });
  // Chromium helpers may finish writing their private profile after the parent exits.
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
