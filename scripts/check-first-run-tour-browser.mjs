// Real React/CSS fixture checks. This proves Chromium rendering and interaction,
// not native WebView geometry, saved app state, or live-provider behavior.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1420";
const output = resolve(
  process.env.GYRO_CAPTURE_OUTPUT || "docs/design/tour-polish-2026-10-31",
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
const profile = await mkdtemp(join(tmpdir(), "gyro-tour-polish-"));
const port = Number(process.env.GYRO_CAPTURE_PORT || 9497);
const browser = spawn(
  executable,
  [
    "--headless=new",
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
  const deadline = Date.now() + 20000;
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
const selectors = [
  '[data-tour="composer.project"]',
  '[data-tour="composer.input"]',
  '[data-tour="composer.model"]',
];
const names = ["project", "composer", "model"];
const captures = [];
const checks = [];
const errors = [];
let ws;
let call;
try {
  const pages = await until(
    async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json(),
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
  call = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve: resolveCall, reject });
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
  async function key(keyName, modifiers = 0) {
    const code = keyName === "Tab" ? 9 : 27;
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: keyName,
      code: keyName,
      windowsVirtualKeyCode: code,
      modifiers,
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: keyName,
      code: keyName,
      windowsVirtualKeyCode: code,
      modifiers,
    });
    await pause(80);
  }
  async function click(label) {
    const found = await evaluate(
      `(() => { const b = [...document.querySelectorAll('.gyro-tour-card button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`,
    );
    assert.equal(found, true, `tour button ${label}`);
  }
  async function waitStep(index, total = 3) {
    await until(
      () =>
        evaluate(
          `(() => { const c = document.querySelector('.gyro-tour-card'); const s = document.querySelector('.gyro-tour-step-count'); return c?.dataset.positioned === 'true' && s?.textContent.trim() === 'Step ${index + 1} of ${total}'; })()`,
        ),
      `step ${index + 1}/${total}`,
    );
    await pause(280);
  }
  async function load({
    theme = "dark",
    zoom = "1",
    size = "default",
    provider = "connected",
    panel = "none",
    scene = "home",
    split = false,
    missing,
    record,
    firstTask = false,
    width = 1440,
    height = 1024,
  } = {}) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const params = new URLSearchParams({
      theme,
      zoom,
      size,
      provider,
      panel,
      scene,
    });
    if (split) params.set("split", "1");
    if (missing) params.set("missing", missing);
    if (firstTask) params.set("firstTask", "1");
    if (record) params.set("record", record);
    const url = `${origin}/first-run-tour-fixture.html?${params}`;
    await call("Page.navigate", { url });
    await until(
      () =>
        evaluate(
          `location.href === ${JSON.stringify(url)} && document.documentElement.dataset.firstRunTourFixture === 'true' && Boolean(document.querySelector('[data-tour="composer.input"]'))`,
        ),
      "fixture ready",
    );
    await evaluate(
      `(document.querySelector('.gyro-chat-grid-slot.is-current-pane [data-tour="composer.project"]') ?? document.querySelector('[data-tour="composer.project"]') ?? document.querySelector('[data-tour="composer.input"]')).focus(); document.fonts.ready.then(() => true)`,
    );
    return { theme, zoom, size, provider, panel, scene, split, width, height };
  }
  async function inspect(name, index, spec, { anchorExpected = true } = {}) {
    const metrics = await evaluate(`(() => {
      const rect = n => { if (!n) return null; const r=n.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
      const layer=document.querySelector('.gyro-tour');
      const card=document.querySelector('.gyro-tour-card');
      const spot=document.querySelector('.gyro-tour-spotlight');
      const candidates=[...document.querySelectorAll(${JSON.stringify(selectors[index])})].filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden' && !n.closest('[aria-hidden="true"], [inert], [hidden]'));
      const anchor=candidates.find(n=>n.closest('.gyro-chat-grid-slot.is-current-pane')) ?? candidates[0];
      const style=getComputedStyle(card);
      const probe=document.createElement('span'); probe.style.backgroundColor='var(--gyro-ink-bg)'; card.append(probe);
      const expectedPrimary=getComputedStyle(probe).backgroundColor; probe.remove();
      return { viewport:{width:innerWidth,height:innerHeight}, bodyZoom:getComputedStyle(document.body).zoom,
        anchor:rect(anchor), card:rect(card), spotlight:spot?.hidden ? null : rect(spot), layer:rect(layer),
        hasAnchor:layer?.dataset.hasAnchor, placement:card?.dataset.placement,
        pageOverflow:document.documentElement.scrollWidth-innerWidth,
        modal:card?.getAttribute('aria-modal'), focusInside:card?.contains(document.activeElement),
        anchorInFocusedPane:Boolean(anchor?.closest('.gyro-chat-grid-slot.is-current-pane')), visibleAnchorCount:candidates.length,
        destination:document.documentElement.dataset.tourFixtureDestination, section:document.documentElement.dataset.tourFixtureSection,
        title:document.querySelector('.gyro-tour-title')?.textContent,
        colors:{expectedPrimary,background:style.backgroundColor,border:style.borderColor,count:getComputedStyle(document.querySelector('.gyro-tour-step-count')).color,primary:getComputedStyle(document.querySelector('.gyro-tour-primary')).backgroundColor},
        contentOverflow:card.scrollWidth-card.clientWidth,
      };
    })()`);
    const shot = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const path = join(output, `${name}.png`);
    await writeFile(path, Buffer.from(shot.data, "base64"));
    captures.push({ name, step: names[index], ...spec, path, metrics });
    const c = metrics.card;
    assert.ok(
      c.left >= 10 &&
        c.top >= 10 &&
        c.right <= metrics.viewport.width - 10 &&
        c.bottom <= metrics.viewport.height - 10,
      `${name}: card must remain fully in the viewport`,
    );
    assert.ok(
      metrics.pageOverflow <= 1 && metrics.contentOverflow <= 1,
      `${name}: no horizontal overflow`,
    );
    assert.equal(metrics.modal, "true", `${name}: modal dialog semantics`);
    if (anchorExpected) {
      assert.ok(
        metrics.anchor && metrics.spotlight,
        `${name}: real target and spotlight present`,
      );
      assert.equal(metrics.hasAnchor, "true");
      const a = metrics.anchor,
        s = metrics.spotlight;
      const expected = {
        left: Math.max(0, a.left - 6),
        top: Math.max(0, a.top - 6),
        right: Math.min(metrics.viewport.width, a.right + 6),
        bottom: Math.min(metrics.viewport.height, a.bottom + 6),
      };
      for (const edge of ["left", "top", "right", "bottom"])
        assert.ok(
          Math.abs(s[edge] - expected[edge]) <= 1.5,
          `${name}: spotlight ${edge}=${s[edge]}, expected ${expected[edge]} (physical CSS pixels)`,
        );
      const room = {
        top: a.top - 26,
        bottom: metrics.viewport.height - a.bottom - 26,
        left: a.left - 26,
        right: metrics.viewport.width - a.right - 26,
      };
      const fits =
        room.top >= c.height ||
        room.bottom >= c.height ||
        room.left >= c.width ||
        room.right >= c.width;
      if (fits)
        assert.ok(
          c.bottom <= a.top - 12 ||
            c.top >= a.bottom + 12 ||
            c.right <= a.left - 12 ||
            c.left >= a.right + 12,
          `${name}: card sits beside the target`,
        );
    } else {
      assert.equal(metrics.spotlight, null, `${name}: no stale spotlight`);
      assert.equal(metrics.hasAnchor, "false");
    }
    for (const token of ["background", "border", "count"]) {
      const rgb = metrics.colors[token]
        .match(/[\d.]+/g)
        ?.slice(0, 3)
        .map(Number);
      assert.ok(
        rgb && Math.max(...rgb) - Math.min(...rgb) < 22,
        `${name}: neutral ${token} (${metrics.colors[token]})`,
      );
    }
    assert.equal(metrics.colors.primary, metrics.colors.expectedPrimary,
      `${name}: primary button uses Gyro's current ink action token`);
    return metrics;
  }
  async function focusContainment() {
    await evaluate("document.querySelector('.gyro-tour-card button').focus()");
    await key("Tab", 8);
    assert.equal(
      await evaluate(
        "document.activeElement === [...document.querySelectorAll('.gyro-tour-card button')].at(-1)",
      ),
      true,
      "Shift+Tab wraps to last tour control",
    );
    await key("Tab");
    assert.equal(
      await evaluate(
        "document.activeElement === document.querySelector('.gyro-tour-card button')",
      ),
      true,
      "Tab wraps to first tour control",
    );
    checks.push("Tab and Shift+Tab stay in the tour");
  }
  async function mouseClick(selector) {
    const point = await evaluate(`(() => { const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(n => n.getClientRects().length); const n = nodes.find(n => n.closest('.gyro-chat-grid-slot.is-current-pane')) ?? nodes[0]; if (!n) return null; const r=n.getBoundingClientRect(); const z=Number(getComputedStyle(document.body).zoom)||1; return {x:(r.left+r.width/2)*z, y:(r.top+r.height/2)*z}; })()`);
    assert.ok(point, `mouse target ${selector}`);
    await mouseAt(point.x, point.y);
  }
  async function mouseAt(x, y) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    await pause(120);
  }
  const tourOpen = () => evaluate("Boolean(document.querySelector('.gyro-tour-card'))");
  const recordStatus = () =>
    evaluate("JSON.parse(document.documentElement.dataset.tourFixtureRecord || 'null')?.status ?? null");
  const primaryLabel = () =>
    evaluate("document.querySelector('.gyro-tour-primary')?.textContent.trim()");

  await call("Page.enable");
  await call("Runtime.enable");
  for (const theme of ["dark", "light"])
    for (const zoom of ["1", "1.1"]) {
      const spec = await load({ theme, zoom });
      for (let index = 0; index < 3; index++) {
        await waitStep(index);
        const metric = await inspect(
          `home-${theme}-zoom-${zoom}-${names[index]}`,
          index,
          spec,
        );
        assert.equal(metric.destination, "workspace", "the tour never leaves the workspace");
        if (index === 0) await focusContainment();
        await click(index === 2 ? "Finish" : "Next");
      }
      await until(async () => !(await tourOpen()), "tour completion");
      assert.equal(await recordStatus(), "complete");
      checks.push(
        `${theme} zoom${zoom}: three composer anchors, bounds, style and completion`,
      );
    }

  for (const theme of ["dark", "light"]) {
    const thread = await load({ theme, zoom: "1.1", panel: "files", scene: "thread" });
    // A thread's composer has no project chip, so the tour starts at the input.
    for (let index = 1; index < 3; index++) {
      await waitStep(index - 1, 2);
      await inspect(`thread-${theme}-zoom-1.1-${names[index]}`, index, thread);
      await click(index === 2 ? "Finish" : "Next");
    }
    await until(async () => !(await tourOpen()), "thread tour completion");
  }
  checks.push("Active chat with an open companion skips Project and shows input and model in both themes at zoom1.1");

  const split = await load({ split: true, panel: "none", scene: "home" });
  // Compact split composers may omit Project; the first step is whichever
  // anchor is available.
  const splitTotal = await until(
    () => evaluate("document.querySelector('.gyro-tour-step-count')?.textContent.trim().match(/of (\\d+)/)?.[1]"),
    "split tour",
  );
  await waitStep(0, Number(splitTotal));
  const focused = await inspect("split-focused-composer", 3 - Number(splitTotal), split);
  assert.equal(focused.visibleAnchorCount, 2, "split fixture exposes two real inputs");
  assert.equal(focused.anchorInFocusedPane, true, "spotlight follows focused split chat");
  await key("Escape");
  checks.push("Focused split chat wins over the first matching anchor");

  const large = await load({ size: "large", zoom: "1.1" });
  for (let index = 0; index < 3; index++) {
    await waitStep(index);
    await inspect(`large-zoom-1.1-${names[index]}`, index, large);
    await click(index === 2 ? "Finish" : "Next");
  }
  checks.push("Large appearance plus body zoom1.1 preserves anchor/card geometry");

  const narrow = await load({ width: 900, height: 700, panel: "none", scene: "home" });
  await waitStep(0);
  await inspect("narrow-project", 0, narrow);
  await click("Next");
  await waitStep(1);
  await click("Next");
  await waitStep(2);
  await inspect("narrow-model", 2, narrow);
  await click("Back");
  await waitStep(1);
  await key("Escape");
  await until(async () => !(await tourOpen()), "Escape dismisses");
  assert.equal(await recordStatus(), "dismissed");
  checks.push("Back moves within the composer; Escape dismissal is recorded");

  // The highlighted control is usable; everything around it stays inert.
  await load({ panel: "none", scene: "home" });
  await waitStep(0);
  await click("Next");
  await waitStep(1);
  await mouseAt(4, 4);
  assert.equal(await tourOpen(), true, "a click outside the cut-out is blocked");
  await mouseClick('[data-tour="composer.input"]');
  await until(async () => !(await tourOpen()), "using the highlighted input ends the tour");
  assert.equal(
    await evaluate("Boolean(document.activeElement?.closest('[data-tour=\"composer.input\"]')) || document.activeElement?.dataset.tour === 'composer.input'"),
    true,
    "the click reaches the highlighted input",
  );
  assert.equal(await recordStatus(), "complete");
  checks.push("Highlighted control receives the click and ends the tour; the rest of the app is blocked");

  // A draft in progress holds the tour back until the composer is idle.
  await load({ panel: "none", scene: "home" });
  await evaluate("(document.querySelector('[data-tour=\"composer.input\"] textarea, textarea[data-tour=\"composer.input\"], [data-tour=\"composer.input\"] [contenteditable]') ?? document.querySelector('[data-tour=\"composer.input\"]')).focus()");
  await call("Input.insertText", { text: "fix the flaky test" });
  await pause(2600);
  assert.equal(await tourOpen(), false, "tour waits while a draft is being written");
  checks.push("Tour does not open over a draft in progress");

  await load({ record: "v1" });
  await pause(2600);
  assert.equal(await tourOpen(), false, "a version 1 record still suppresses the tour");
  checks.push("Version 1 tour record migrates without replaying the tour");

  await load({ panel: "none", missing: "model", scene: "home" });
  await waitStep(0, 2);
  await click("Next");
  await waitStep(1, 2);
  assert.equal(await primaryLabel(), "Finish");
  await click("Finish");
  checks.push("Missing model anchor yields two steps ending in Finish");

  const missing = await load();
  await waitStep(0);
  await evaluate("document.querySelector('[data-tour=\"composer.project\"]').remove()");
  await until(
    () => evaluate("document.querySelector('.gyro-tour')?.dataset.hasAnchor === 'false'"),
    "removed anchor clears spotlight",
  );
  await inspect("target-removed", 0, missing, { anchorExpected: false });
  await key("Escape");
  checks.push("Target removal clears the old cutout and leaves a dismissible neutral card");

  for (const theme of ["dark", "light"]) {
    const disconnected = await load({ provider: "none", panel: "none", scene: "home", theme, firstTask: true });
    await waitStep(0);
    await click("Next");
    await waitStep(1);
    await click("Next");
    await waitStep(2);
    await inspect(`disconnected-${theme}-model`, 2, disconnected);
    assert.match(await evaluate("document.querySelector('.gyro-tour-title').textContent"), /connect/i);
    assert.equal(await primaryLabel(), "Connect an account", "no first task without a provider");
    await click("Connect an account");
    await until(async () => !(await tourOpen()), "connect exits tour");
    assert.equal(await evaluate("document.documentElement.dataset.tourFixtureDestination"), "settings");
    assert.equal(await evaluate("document.documentElement.dataset.tourFixtureSection"), "providers");
    assert.equal(await recordStatus(), "complete");
  }
  checks.push("Disconnected users end on Connect an account, which opens Accounts and stays there");

  for (const theme of ["dark", "light"]) {
    const spec = await load({ theme, firstTask: true, width: 900, height: 700 });
    for (let index = 0; index < 2; index++) {
      await waitStep(index);
      await click("Next");
    }
    await waitStep(2);
    await inspect(`first-task-${theme}`, 2, spec);
    assert.equal(await evaluate("document.querySelectorAll('.gyro-tour-primary').length"), 1);
    assert.equal(await primaryLabel(), "Try a first task");
    await click("Try a first task");
    await until(async () => !(await tourOpen()), "first task exits tour");
    const prompt = await evaluate("document.documentElement.dataset.firstTaskPrompt");
    assert.match(prompt, /Wait for my approval before editing/);
    assert.match(prompt, /failed or unrun checks/);
    assert.equal(await evaluate("document.querySelector('[data-tour=\"composer.input\"]').textContent || document.querySelector('[data-tour=\"composer.input\"]').value"), prompt);
  }
  checks.push("Connected users end on one first-task primary that prepares an editable prompt in both themes");

  assert.deepEqual(errors, [], "no browser exceptions or console errors");
  // Only remove obsolete files from this script's preliminary capture names.
  // Preserve other design evidence that may share the output directory.
  const obsoleteNames = ["failure.png", "large-zoom-1.1-panel.png", "narrow-models.png", "light-disconnected-models.png"];
  for (const prefix of ["home-dark-zoom-1", "home-dark-zoom-1.1", "home-light-zoom-1", "home-light-zoom-1.1", "thread-dark-zoom-1.1", "thread-light-zoom-1.1", "large-zoom-1.1"])
    for (const old of ["models", "workspace", "panel"]) obsoleteNames.push(`${prefix}-${old}.png`);
  for (const theme of ["dark", "light"]) {
    for (const zoom of ["1", "1.1"]) {
      for (const name of names)
        obsoleteNames.push(`${theme}-zoom-${zoom}-${name}.png`);
    }
  }
  for (const file of obsoleteNames) {
    await rm(join(output, file), { force: true });
  }
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify({ result: "passed", checks, captures, errors }, null, 2),
  );
  console.log(
    `Tour browser checks passed: ${checks.length} groups, ${captures.length} screenshots. ${output}`,
  );
} catch (error) {
  if (call) {
    try {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        join(output, "failure.png"),
        Buffer.from(shot.data, "base64"),
      );
    } catch {}
  }
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(
      {
        result: "failed",
        error: String(error?.stack || error),
        checks,
        captures,
        errors,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  browser.kill("SIGTERM");
  await pause(250);
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
