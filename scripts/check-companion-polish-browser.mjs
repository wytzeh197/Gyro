// Render production components with isolated sample data. This is browser
// fixture evidence, not native WebView, PTY or provider acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1420";
const output = resolve(
  process.env.GYRO_CAPTURE_OUTPUT ||
    "docs/design/soft-separation-2026-10-30/actual",
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
const profile = await mkdtemp(join(tmpdir(), "gyro-companion-polish-"));
const port = Number(process.env.GYRO_CAPTURE_PORT || 9496);
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
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
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
  async function load(
    tool,
    {
      theme = "dark",
      split = false,
      width = 1440,
      height = 1024,
      state = "populated",
    } = {},
  ) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const query = new URLSearchParams({
      tool,
      theme,
      split: split ? "1" : "0",
      state,
    });
    const url = `${origin}/companion-polish-fixture.html?${query}`;
    await call("Page.navigate", { url });
    await until(
      () =>
        evaluate(
          `location.href === ${JSON.stringify(url)} && Boolean(document.querySelector('.gyro-chat-workspace'))`,
        ),
      `render ${tool}`,
    );
    await evaluate("document.fonts.ready.then(() => true)");
    await pause(500);
    return { tool, theme, split, width, height, state };
  }
  async function inspect(name, spec) {
    const metrics = await evaluate(`(() => {
      const rect = n => {if(!n) return null; const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      const slot = document.querySelector('.gyro-chat-grid-slot.is-occupied.is-current-pane') ?? document.querySelector('.gyro-chat-grid-slot.is-occupied');
      const host = slot?.querySelector(':scope > .gyro-chat-companion-host');
      const pane = host?.querySelector('.gyro-chat-companion-host-pane.is-active');
      const header = pane?.querySelector('.gyro-chat-companion-tabs');
      const surface = slot?.querySelector(':scope > .gyro-chat-surface');
      const chatHeader = surface?.querySelector('.gyro-chat-thread-topbar');
      const grid = document.querySelector('.gyro-chat-grid');
      const p = document.querySelector('.gyro-chat-transcript .gyro-response-body p');
      const composer = document.querySelector('.gyro-chat-grid .gyro-composer-shell');
      const bubble = document.querySelector('.gyro-chat-grid .gyro-user-message-bubble');
      return {
        pageOverflow: document.documentElement.scrollWidth-innerWidth,
        chat:rect(chatHeader), header:rect(header), grid:rect(grid), host:rect(host),
        slot:rect(slot), surface:rect(surface),
        hostHidden:host?.hidden, overlay:host?.classList.contains('is-overlay'),
        expanded:host?.classList.contains('is-expanded'), surfaceInert:surface?.inert,
        activePanes:host?.querySelectorAll('.gyro-chat-companion-host-pane.is-active:not([hidden])').length,
        hostsPerSlot:[...document.querySelectorAll('.gyro-chat-grid-slot.is-occupied')].every(n=>n.querySelectorAll(':scope > .gyro-chat-companion-host').length===1),
        hiddenPanes:[...document.querySelectorAll('.gyro-chat-companion-host-pane:not(.is-active)')].every(n=>n.hidden&&n.inert),
        font:p ? {size:getComputedStyle(p).fontSize,line:getComputedStyle(p).lineHeight} : null,
        corners:{composer:composer ? getComputedStyle(composer).borderTopLeftRadius : null,bubble:bubble ? getComputedStyle(bubble).borderTopLeftRadius : null},
        mainShowButtons:[...document.querySelectorAll('.gyro-chat-grid-slot.is-current-pane [aria-label="Show companion"]')].filter(n=>n.getClientRects().length).length,
        controls:header ? [...header.querySelectorAll('.gyro-chat-companion-window-actions button')].map(n=>({label:n.getAttribute('aria-label'),rect:rect(n)})) : [],
      };
    })()`);
    const shot = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const path = join(output, `${name}.png`);
    await writeFile(path, Buffer.from(shot.data, "base64"));
    manifest.push({ name, ...spec, path, metrics });
    assert.ok(
      metrics.pageOverflow <= 1,
      `${name}: document overflow ${metrics.pageOverflow}`,
    );
    assert.equal(
      metrics.hiddenPanes,
      true,
      `${name}: inactive tools must remain inert`,
    );
    assert.equal(
      metrics.hostsPerSlot,
      true,
      `${name}: every chat frames its own panel`,
    );
    assert.equal(
      metrics.hostHidden,
      spec.tool === "closed",
      `${name}: requested panel visibility`,
    );
    if (metrics.header && !metrics.hostHidden) {
      assert.ok(
        Math.abs(metrics.header.height - metrics.chat.height) <= 1,
        `${name}: companion header height ${metrics.header.height} (chat ${metrics.chat?.height})`,
      );
      assert.ok(
        Math.abs(metrics.header.y - metrics.chat.y) <= 1,
        `${name}: header top ${metrics.header.y} != chat ${metrics.chat.y}`,
      );
      assert.equal(metrics.activePanes, 1, `${name}: one active outer panel`);
      assert.equal(metrics.mainShowButtons, 0, `${name}: no duplicate opener`);
      if (!metrics.overlay && !metrics.expanded) {
        assert.ok(
          metrics.host.x >= metrics.surface.right - 1 &&
            metrics.host.right <= metrics.slot.right + 1,
          `${name}: panel sits beside its chat inside the pane frame`,
        );
        assert.equal(metrics.surfaceInert, false, `${name}: docked chat stays usable`);
      }
      for (const control of metrics.controls)
        assert.ok(
          control.rect.right <= metrics.host.right + 1,
          `${name}: clipped ${control.label}`,
        );
    }
    if (metrics.font) {
      assert.equal(metrics.font.size, "14px", `${name}: answer size`);
      assert.ok(
        Math.abs(parseFloat(metrics.font.line) - 23.1) < 0.2,
        `${name}: answer leading`,
      );
    }
    assert.equal(metrics.corners.composer, "14px", `${name}: composer corner`);
    assert.equal(metrics.corners.bubble, "12px", `${name}: message corner`);
    console.log(`PASS ${name}`);
  }
  await call("Page.enable");
  await call("Runtime.enable");
  for (const theme of ["dark", "light"]) {
    for (const tool of [
      "review",
      "browser",
      "canvas",
      "files",
      "terminal",
      "agents",
      "side-chat",
      "plan",
      "closed",
    ]) {
      const spec = await load(tool, { theme });
      await inspect(`${tool}-${theme}`, spec);
    }
    for (const tool of ["review", "closed"]) {
      const spec = await load(tool, { theme, split: true });
      await inspect(`split-${tool}-${theme}`, spec);
    }
  }
  const narrow = await load("review", {
    split: true,
    width: 1024,
    height: 760,
  });
  await inspect("split-review-narrow", narrow);
  assert.equal(
    await evaluate("document.querySelector('.gyro-chat-grid-slot.is-current-pane > .gyro-chat-surface').inert"),
    true,
    "covered narrow chats are inert",
  );
  await click("Hide companion");
  assert.equal(
    await evaluate("document.querySelector('.gyro-chat-grid-slot.is-current-pane > .gyro-chat-surface').inert"),
    false,
    "hide releases keyboard focus",
  );
  assert.equal(
    await evaluate("document.activeElement?.getAttribute('aria-label')"),
    "Show companion",
    "hide restores opener focus",
  );
  await click("Show companion");
  await click("Add companion tab");
  await click(
    "Files",
    "document.querySelector('.gyro-chat-companion-host-pane.is-active')",
  );
  await click(
    "Review",
    "document.querySelector('.gyro-chat-companion-host-pane.is-active')",
  );
  await click("Hide companion");
  await click("Show companion");
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-chat-companion-host-pane.is-active [role=tab][aria-selected=true]')?.textContent.trim()",
    ),
    "Review",
    "reopen last viewed, not last opened",
  );
  await inspect("reopened-review-narrow", narrow);
  // Equal split panes dock their panel once 320px of conversation fits beside it.
  const sideChat = await load("side-chat", { split: true, width: 1680 });
  await evaluate(`(() => {
    window.savedDraftInput = document.querySelector('.gyro-chat-companion-host-pane.is-active .gyro-side-chat-composer textarea');
    window.savedDraftInput.focus();
  })()`);
  await call("Input.insertText", {
    text: "Keep this draft while changing chats",
  });
  await evaluate(
    `document.querySelectorAll('.gyro-chat-grid-slot.is-occupied')[1].querySelector('.gyro-composer-shell textarea').focus()`,
  );
  await pause(300);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.gyro-chat-grid-slot.is-occupied')[1].querySelector(':scope > .gyro-chat-companion-host').hidden",
    ),
    true,
    "second chat keeps its own closed panel",
  );
  await evaluate(
    `document.querySelectorAll('.gyro-chat-grid-slot.is-occupied')[0].querySelector('.gyro-composer-shell textarea').focus()`,
  );
  await pause(300);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.gyro-chat-grid-slot.is-occupied')[0].querySelector('.gyro-chat-companion-host-pane.is-active .gyro-side-chat-composer textarea') === window.savedDraftInput && window.savedDraftInput.value === 'Keep this draft while changing chats'",
    ),
    true,
    "switching focused chats preserves the mounted tool and its draft",
  );
  await click("Expand panel over chat");
  assert.equal(
    await evaluate(
      "document.querySelector('.gyro-chat-grid-slot.is-current-pane > .gyro-chat-companion-host').classList.contains('is-expanded') && document.querySelector('.gyro-chat-grid-slot.is-current-pane > .gyro-chat-surface').inert",
    ),
    true,
    "expanded panel covers and disables chat input",
  );
  await click("Restore compact panel");
  assert.equal(
    await evaluate("document.querySelector('.gyro-chat-grid-slot.is-current-pane > .gyro-chat-surface').inert"),
    false,
    "restore releases chat input",
  );
  await inspect("split-side-chat-restored", sideChat);
  assert.equal(
    errors.length,
    0,
    `Browser console/runtime errors: ${JSON.stringify(errors)}`,
  );
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(
      {
        evidence:
          "Production React UI with fixture data; no native or live-provider acceptance",
        result: "passed",
        errors,
        captures: manifest,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS ${manifest.length} rendered states and panel transitions. ${output}`,
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
  await new Promise((done) =>
    browser.exitCode !== null ? done() : browser.once("exit", done),
  );
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
