import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Production sidebar in an isolated fixture browser; no real provider calls.
const profile = await mkdtemp(join(tmpdir(), "gyro-sidebar-ui-"));
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ??
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=BraveRewards,BraveVPN",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await pause(100);
  }
  throw Error("Timed out: " + label);
}
let ws;
try {
  const port = await until(
    async () =>
      Number(
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
          "\n",
        )[0],
      ),
    "browser start",
  );
  const page = await until(
    async () =>
      (
        await (await fetch("http://127.0.0.1:" + port + "/json/list")).json()
      ).find((item) => item.type === "page"),
    "page",
  );
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    message.error
      ? callback.reject(message.error)
      : callback.resolve(message.result);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
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
  const click = async (selector) => {
    const point = await evaluate(
      "(()=>{const e=document.querySelector(" +
        JSON.stringify(selector) +
        ");if(!e)throw Error('missing');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()",
    );
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    });
  };
  const key = async (key, code, windowsVirtualKeyCode) => {
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode,
      ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode,
    });
  };

  const output =
    process.env.GYRO_CAPTURE_OUTPUT ??
    "docs/screenshots/2026-11-11-sidebar-implementation";
  const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1420";
  await mkdir(output, { recursive: true });
  const shot = async (name) => {
    await call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 700,
      y: 500,
    });
    await pause(250);
    const { data } = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, name + ".png"), Buffer.from(data, "base64"));
    const sidebar = await evaluate(
      "(()=>{const r=document.querySelector('.gyro-sidebar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:2}})()",
    );
    const detail = await call("Page.captureScreenshot", {
      format: "png",
      clip: sidebar,
    });
    await writeFile(
      join(output, name + "-detail.png"),
      Buffer.from(detail.data, "base64"),
    );
  };
  const load = async (query, width = 1440) => {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", {
      url: origin + "/capture.html?tour=skip&" + query,
    });
    await until(
      () =>
        evaluate(
          "!!document.querySelector('.gyro-sidebar-quick-actions') && !document.querySelector('.gyro-early-shell')",
        ),
      "mount",
    );
    await pause(1200);
  };
  for (const theme of ["light", "dark"]) {
    await load(`scene=chat&theme=${theme}&reset=1`);
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.gyro-sidebar-quick-actions > button').length",
      ),
      2,
    );
    const geometry = await evaluate(
      `(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();const toggle=r('.gyro-sidebar-toggle-button'), mode=r('.gyro-titlebar-switch'), actions=r('.gyro-sidebar-quick-actions'), list=r('.gyro-sidebar-project-chat-list');return {gap:mode.left-toggle.right, actions:actions.height, overlap:actions.bottom>list.top+1, row:r('.gyro-sidebar-thread-main').height, overflow:[...document.querySelectorAll('.gyro-sidebar-quick-actions,.gyro-sidebar-project-chat-list')].some(e=>e.scrollWidth>e.clientWidth+1)};})()`,
    );
    assert.ok(geometry.gap >= 0 && geometry.gap <= 8, JSON.stringify(geometry));
    assert.ok(
      !geometry.overlap && !geometry.overflow,
      JSON.stringify(geometry),
    );
    assert.ok(geometry.row >= 32, JSON.stringify(geometry));
    await click(".gyro-sidebar-thread-main");
    await until(
      () => evaluate("!!document.querySelector('.gyro-session-row.is-active')"),
      "selected session",
    );
    await evaluate("document.activeElement?.blur()");
    assert.equal(
      await evaluate(
        "!!document.querySelector('.gyro-sidebar-project-memory')",
      ),
      false,
    );
    await shot(`sidebar-${theme}`);
    await click(".gyro-sidebar-project-pin");
    await until(
      () =>
        evaluate(
          "document.querySelector('.gyro-sidebar-project-pin').getAttribute('aria-pressed')==='true'",
        ),
      "project pinned",
    );
    await until(
      () =>
        evaluate(
          "Object.values(JSON.parse(localStorage.getItem('gyro.workbench-state')).preferences.projectDetails??{}).some(p=>p.pinned)",
        ),
      "pin persisted",
    );
    await click(".gyro-sidebar-project-toggle");
    await until(
      () =>
        evaluate("!document.querySelector('.gyro-sidebar-project-children')"),
      "collapse",
    );
    await load(`scene=chat&theme=${theme}`);
    assert.equal(
      await evaluate(
        "document.querySelector('.gyro-sidebar-project-toggle').getAttribute('aria-expanded')",
      ),
      "false",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.gyro-sidebar-project-pin').getAttribute('aria-pressed')",
      ),
      "true",
    );
    await click(".gyro-sidebar-project-toggle");
    await click(".gyro-sidebar-new-session > button");
    assert.ok(
      await evaluate("!!document.querySelector('[aria-label=\"New Chat\"]')"),
    );
    await click('[aria-label="New Chat"]');
    await until(
      () =>
        evaluate("!!document.querySelector('.gyro-composer-input textarea')"),
      "new chat",
    );
    await click('.gyro-sidebar-quick-actions [aria-label="Search"]');
    await until(
      () => evaluate("!!document.querySelector('.gyro-command-palette')"),
      "search",
    );
    await key("Escape", "Escape", 27);
    await click('[aria-label="Hide sidebar"]');
    await until(
      () =>
        evaluate(
          "!!document.querySelector('.gyro-app-shell.is-sidebar-hidden')",
        ),
      "hide sidebar",
    );
    await click('[aria-label="Show sidebar"]');
    await until(
      () =>
        evaluate(
          "!document.querySelector('.gyro-app-shell.is-sidebar-hidden')",
        ),
      "restore sidebar",
    );
    await click('.gyro-sidebar-quick-actions [aria-label="Workflows"]');
    await until(
      () =>
        evaluate(
          "document.querySelector('.gyro-sidebar-quick-actions [aria-label=\"Workflows\"]').getAttribute('aria-current')==='page'",
        ),
      "workflows",
    );
    console.log(
      theme +
        ": geometry, pin persistence, collapse persistence, new chat, search, workflows, hide/restore passed",
    );
  }
  for (const theme of ["light", "dark"]) {
    await load(`scene=chat&theme=${theme}&edge=sidebar-many&reset=1`);
    const rows = () =>
      evaluate(
        "document.querySelectorAll('.gyro-sidebar-project-children > .gyro-session-row').length",
      );
    const more =
      '.gyro-sidebar-project-children [aria-label="Show more chats in aurora"]';
    const less =
      '.gyro-sidebar-project-children [aria-label="Show fewer chats in aurora"]';
    const checkEnd = async () => {
      const line = await evaluate(
        `(()=>{const rows=[...document.querySelectorAll('.gyro-sidebar-project-children > .gyro-session-row')],last=rows.at(-1),stem=last.querySelector('.gyro-sidebar-tree-branch'),r=last.getBoundingClientRect(),s=stem.getBoundingClientRect(),css=getComputedStyle(stem);return {bottom:s.bottom,mid:r.top+r.height/2,radius:parseFloat(css.borderBottomLeftRadius),border:css.borderBottomWidth};})()`,
      );
      assert.ok(
        Math.abs(line.bottom - line.mid) <= 1 &&
          line.radius > 0 &&
          line.border === "1px",
        JSON.stringify(line),
      );
    };
    assert.equal(await rows(), 5);
    assert.ok(
      await evaluate(`!!document.querySelector(${JSON.stringify(more)})`),
    );
    await checkEnd();
    await shot(`sidebar-more-${theme}`);
    await click(more);
    await until(
      async () => (await rows()) === 20,
      "More reveals the next batch",
    );
    assert.ok(
      await evaluate(`!!document.querySelector(${JSON.stringify(less)})`),
    );
    await checkEnd();
    await shot(`sidebar-expanded-${theme}`);
    await click(more);
    await until(async () => (await rows()) === 24, "More reaches final chat");
    assert.equal(
      await evaluate(`!!document.querySelector(${JSON.stringify(more)})`),
      false,
    );
    await checkEnd();
    await click(less);
    await until(
      async () => (await rows()) === 5,
      "Less restores the initial preview",
    );
    assert.equal(
      await evaluate(`!!document.querySelector(${JSON.stringify(less)})`),
      false,
    );
    await checkEnd();
    console.log(
      theme + ": More 5→20→24, Less 24→5 and curved final connector passed",
    );
  }
  await load(
    "scene=chat&theme=light&size=large&density=comfortable&reset=1",
    1024,
  );
  await shot("sidebar-large");
  assert.ok(
    await evaluate(
      "[...document.querySelectorAll('.gyro-sidebar-quick-actions,.gyro-sidebar-project-chat-list')].every(e=>e.scrollWidth<=e.clientWidth+1)",
    ),
  );
  await click('[data-sidebar-mode="workspace"]');
  await until(
    () => evaluate("!!document.querySelector('.gyro-sidebar-explorer-tree')"),
    "workspace switch",
  );
  assert.ok(
    await evaluate(
      "(()=>{const t=document.querySelector('.gyro-sidebar-toggle-button').getBoundingClientRect(), s=document.querySelector('.gyro-titlebar-switch').getBoundingClientRect();return s.left-t.right>=0 && s.left-t.right<=8;})()",
    ),
  );
  await pause(600); // Let the wider Workspace rail finish its layout transition.
  await click('[data-sidebar-mode="sessions"]');
  await until(
    () => evaluate("!!document.querySelector('.gyro-sidebar-quick-actions')"),
    "sessions switch",
  );
  await call("Page.navigate", {
    url: origin + "/v012-feature-fixture.html?shell=1&theme=light",
  });
  await until(
    () => evaluate("!!document.querySelector('.gyro-sidebar-project-toggle')"),
    "project fixture entry",
  );
  assert.equal(
    await evaluate("!!document.querySelector('.gyro-sidebar-project-memory')"),
    false,
  );
  await evaluate(
    "document.querySelector('.gyro-sidebar-project-toggle').focus()",
  );
  await key("ArrowRight", "ArrowRight", 39);
  await until(
    () => evaluate("!!document.querySelector('.gyro-project-hover-card')"),
    "project details",
  );
  await click(".gyro-project-card-edit");
  await click(".gyro-project-settings-views button:last-child");
  await until(
    () =>
      evaluate(
        "!!document.querySelector('.gyro-project-edit-dialog[open] .gyro-memory-list')",
      ),
    "memory in project settings",
  );
  const { data } = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(output, "sidebar-memory-light.png"),
    Buffer.from(data, "base64"),
  );
  await key("Escape", "Escape", 27);
  await until(
    () =>
      evaluate(
        "document.activeElement?.classList.contains('gyro-sidebar-project-toggle')",
      ),
    "project restores focus",
  );
  console.log(
    "Large interface geometry, surface switching and project-settings memory/focus passed. Browser fixture only; no native picker or provider calls.",
  );
} finally {
  ws?.close();
  browser.kill("SIGTERM");
}
