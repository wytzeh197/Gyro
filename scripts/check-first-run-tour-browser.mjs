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
  '[data-tour="settings.providers"]',
  '[data-tour="sidebar.ide"]',
  '[data-tour="panel.tabs"], [data-tour="panel.launcher"]',
];
const names = ["project", "composer", "models", "workspace", "panel"];
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
  async function waitStep(index, total = 5) {
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
      return { viewport:{width:innerWidth,height:innerHeight}, bodyZoom:getComputedStyle(document.body).zoom,
        anchor:rect(anchor), card:rect(card), spotlight:spot?.hidden ? null : rect(spot), layer:rect(layer),
        hasAnchor:layer?.dataset.hasAnchor, placement:card?.dataset.placement,
        pageOverflow:document.documentElement.scrollWidth-innerWidth,
        modal:card?.getAttribute('aria-modal'), focusInside:card?.contains(document.activeElement),
        anchorInFocusedPane:Boolean(anchor?.closest('.gyro-chat-grid-slot.is-current-pane')), visibleAnchorCount:candidates.length,
        destination:document.documentElement.dataset.tourFixtureDestination, section:document.documentElement.dataset.tourFixtureSection,
        title:document.querySelector('.gyro-tour-title')?.textContent,
        colors:{background:style.backgroundColor,border:style.borderColor,count:getComputedStyle(document.querySelector('.gyro-tour-step-count')).color,primary:getComputedStyle(document.querySelector('.gyro-tour-primary')).backgroundColor},
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
    const rgb = metrics.colors.primary
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number);
    assert.ok(rgb[2] > rgb[0] + 20, `${name}: primary button retains blue`);
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
  await call("Page.enable");
  await call("Runtime.enable");
  for (const theme of ["dark", "light"])
    for (const zoom of ["1", "1.1"]) {
      const spec = await load({ theme, zoom });
      for (let index = 0; index < 4; index++) {
        await waitStep(index, 4);
        const metric = await inspect(
          `home-${theme}-zoom-${zoom}-${names[index]}`,
          index,
          spec,
        );
        assert.equal(
          metric.destination,
          index === 2 ? "settings" : "workspace",
          `${names[index]} navigates to its actual destination`,
        );
        if (index === 2) assert.equal(metric.section, "providers");
        if (index === 0) await focusContainment();
        await click(index === 3 ? "Finish" : "Next");
      }
      await until(
        () => evaluate("!document.querySelector('.gyro-tour-card')"),
        "tour completion",
      );
      assert.equal(
        await evaluate(
          "JSON.parse(document.documentElement.dataset.tourFixtureRecord).status",
        ),
        "complete",
      );
      checks.push(
        `${theme} zoom${zoom}: all four home anchors, bounds, style and completion`,
      );
    }

  for (const theme of ["dark", "light"]) {
    const thread = await load({
      theme,
      zoom: "1.1",
      panel: "files",
      scene: "thread",
    });
    for (let index = 1; index < 5; index++) {
      await waitStep(index - 1, 4);
      await inspect(`thread-${theme}-zoom-1.1-${names[index]}`, index, thread);
      await click(index === 4 ? "Finish" : "Next");
    }
  }
  checks.push(
    "Active chat shows input, Settings, workspace and companion steps in both themes at zoom1.1",
  );

  const split = await load({ split: true, panel: "none", scene: "home" });
  await waitStep(0, 4);
  const focused = await inspect("split-focused-project", 0, split);
  assert.equal(
    focused.visibleAnchorCount,
    2,
    "split fixture exposes two real Project controls",
  );
  assert.equal(
    focused.anchorInFocusedPane,
    true,
    "spotlight follows focused split chat",
  );
  await click("Next");
  await waitStep(1, 4);
  await inspect("split-focused-composer", 1, split);
  await key("Escape");
  checks.push(
    "Focused split chat wins over the first matching Project/input anchor",
  );

  // Large appearance changes real component tokens, independently of body zoom.
  const large = await load({ size: "large", zoom: "1.1" });
  for (let index = 0; index < 4; index++) {
    await waitStep(index, 4);
    await inspect(`large-zoom-1.1-${names[index]}`, index, large);
    await click(index === 3 ? "Finish" : "Next");
  }
  checks.push(
    "Large appearance plus body zoom1.1 preserves anchor/card geometry",
  );

  const narrow = await load({
    width: 900,
    height: 700,
    panel: "none",
    scene: "home",
  });
  await waitStep(0, 4);
  await inspect("narrow-project", 0, narrow);
  await click("Next");
  await waitStep(1, 4);
  await click("Next");
  await waitStep(2, 4);
  await inspect("narrow-models", 2, narrow);
  await click("Back");
  await waitStep(1, 4);
  assert.equal(
    await evaluate("document.documentElement.dataset.tourFixtureDestination"),
    "workspace",
  );
  await click("Next");
  await waitStep(2, 4);
  await key("Escape");
  await until(
    () =>
      evaluate(
        "!document.querySelector('.gyro-tour-card') && document.documentElement.dataset.tourFixtureDestination === 'workspace'",
      ),
    "Escape returns from Settings",
  );
  assert.equal(
    await evaluate(
      "JSON.parse(document.documentElement.dataset.tourFixtureRecord).status",
    ),
    "dismissed",
  );
  checks.push(
    "Back and Escape return from real Settings; dismissal is recorded",
  );

  await load({ panel: "none", missing: "panel", scene: "home" });
  await waitStep(0, 4);
  await key("Escape");
  await until(
    () => evaluate("!document.querySelector('.gyro-tour-card')"),
    "Escape dismisses first step",
  );
  assert.equal(
    await evaluate("document.activeElement?.getAttribute('data-tour')"),
    "composer.project",
    "dismissal restores original control focus",
  );
  checks.push(
    "Unavailable initial panel yields four steps; Escape restores focus",
  );

  const missing = await load();
  await waitStep(0, 4);
  await evaluate(
    "document.querySelector('[data-tour=\"composer.project\"]').remove()",
  );
  await until(
    () =>
      evaluate(
        "document.querySelector('.gyro-tour')?.dataset.hasAnchor === 'false'",
      ),
    "removed anchor clears spotlight",
  );
  await inspect("target-removed", 0, missing, { anchorExpected: false });
  await key("Escape");
  checks.push(
    "Target removal clears the old cutout and leaves a dismissible neutral card",
  );

  const disconnected = await load({
    provider: "none",
    panel: "none",
    scene: "home",
    theme: "light",
  });
  await waitStep(0, 4);
  await click("Next");
  await waitStep(1, 4);
  await click("Next");
  await waitStep(2, 4);
  await inspect("light-disconnected-models", 2, disconnected);
  assert.match(
    await evaluate("document.querySelector('.gyro-tour-body').textContent"),
    /connect/i,
  );
  await click("Skip tour");
  await until(
    () => evaluate("!document.querySelector('.gyro-tour-card')"),
    "Skip tour dismisses",
  );
  checks.push(
    "Disconnected provider copy and Skip tour use actual Settings with no provider calls",
  );

  assert.deepEqual(errors, [], "no browser exceptions or console errors");
  // Only remove obsolete files from this script's preliminary capture names.
  // Preserve other design evidence that may share the output directory.
  const obsoleteNames = ["failure.png", "large-zoom-1.1-panel.png"];
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
