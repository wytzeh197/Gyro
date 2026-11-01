// Run from the repo root with the desktop Vite server already running.
// Uses production hooks/components in a temporary DOM mount; no provider/IPC calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1420";
const reportPath = process.env.GYRO_QA_REPORT;
const motion = process.env.GYRO_QA_MOTION || "reduce";
const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const fixtureSource = await (
  await fetch(`${origin}/src/sizing-motion-fixture.tsx`)
).text();
const modulePath = (name) => {
  const path = fixtureSource.match(
    new RegExp(`from "([^"]*/${name.replaceAll(".", "\\.")}[^\"]*)"`),
  )?.[1];
  assert.ok(path, `Vite exposes ${name}`);
  return path;
};
const reactPath = modulePath("react.js");
const domPath = modulePath("react-dom_client.js");
const uiPath = modulePath("index.ts").replace(/index\.ts(?:\?.*)?$/, "");
const surfaceSource = await (
  await fetch(origin + uiPath + "surfaces.tsx")
).text();
const dialogPath = surfaceSource.match(
  /from "([^"]*\/use-dialog-dismiss\.ts[^\"]*)"/,
)?.[1];
const dialogSource = await (await fetch(origin + dialogPath)).text();
const menuPath = dialogSource.match(
  /from "([^"]*\/menu-dismiss\.ts[^\"]*)"/,
)?.[1];
assert.ok(
  menuPath && dialogPath,
  "Use the production module versions, including Vite HMR timestamps",
);
const profile = await mkdtemp(join(tmpdir(), "gyro-interaction-polish-"));
const browser = spawn(
  process.env.GYRO_CAPTURE_BROWSER ||
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=9483",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let ws;
const checks = [];
async function until(check, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await pause();
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const pages = await until(
    async () => (await fetch("http://127.0.0.1:9483/json/list")).json(),
    "browser",
  );
  ws = new WebSocket(
    pages.find((page) => page.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const response = JSON.parse(String(data));
    if (response.method === "Runtime.exceptionThrown")
      console.error(JSON.stringify(response.params.exceptionDetails));
    const handler = pending.get(response.id);
    if (handler) {
      pending.delete(response.id);
      response.error
        ? handler.reject(response.error)
        : handler.resolve(response.result);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const request = ++id;
      pending.set(request, { resolve, reject });
      ws.send(JSON.stringify({ id: request, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const click = async (selector) => {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).focus(); document.querySelector(${JSON.stringify(selector)}).click()`,
    );
    await pause();
  };
  const key = async (key, modifiers = 0) => {
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: key,
      modifiers,
      windowsVirtualKeyCode: key === "Tab" ? 9 : key === "Escape" ? 27 : 0,
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: key,
      modifiers,
    });
    await pause(key === "Escape" && motion !== "reduce" ? 300 : 80);
  };
  const verify = async (name, expression) => {
    checks.push({ name, pass: Boolean(await evaluate(expression)) });
  };
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.navigate", { url: `${origin}/sizing-motion.html` });
  await until(
    () => evaluate('Boolean(document.querySelector(".gyro-motion-fixture"))'),
    "fixture",
  );
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: motion }],
  });
  await evaluate(`(async () => {
    const React = (await import(${JSON.stringify(reactPath)})).default;
    const { createRoot } = (await import(${JSON.stringify(domPath)})).default;
    const { useOutsidePointerDismiss } = await import(${JSON.stringify(menuPath)});
    const { useDialogDismiss } = await import(${JSON.stringify(dialogPath)});
    const { ProjectRemoveConfirmOverlay } = await import(${JSON.stringify(uiPath + "surfaces.tsx")});
    const { BranchNameDialog } = await import('/src/branch-name-dialog.tsx');
    const h = React.createElement;
    function NestedDialog({ onClose }) {
      const { ref } = useDialogDismiss(onClose);
      const [open, setOpen] = React.useState(false);
      const menuRef = useOutsidePointerDismiss(open, () => setOpen(false));
      return h('div', { ref, id: 'nested-dialog', role: 'dialog', 'aria-modal': true },
        h('div', { ref: menuRef },
          h('button', { id: 'nested-trigger', 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(true) }, 'Menu'),
          open && h('button', { id: 'nested-item', role: 'menuitem' }, 'Menu action')),
        h('input', { id: 'nested-input', onKeyDown: (event) => { if (event.key === 'Escape') event.preventDefault(); } }),
        h('button', { onClick: onClose }, 'Close'));
    }
    function Fixture() {
      const [menu, setMenu] = React.useState(null);
      const [dialog, setDialog] = React.useState(false);
      const [native, setNative] = React.useState(false);
      const [nested, setNested] = React.useState(false);
      const ref = useOutsidePointerDismiss(Boolean(menu), () => setMenu(null));
      return h('div', { id: 'interaction-test' },
        h('button', { id: 'outside-before' }, 'Before'),
        h('div', { ref },
          ...['first', 'second'].map((id) => h('button', { key: id, id: id + '-trigger', 'aria-haspopup': 'menu', 'aria-expanded': menu === id, onClick: () => setMenu(id) }, id)),
          menu && h('div', { id: 'test-menu', role: 'menu' },
            h('button', { id: 'menu-first', role: 'menuitem' }, 'First'),
            h('button', { disabled: true, role: 'menuitem' }, 'Disabled'),
            h('button', { hidden: true, role: 'menuitem' }, 'Hidden'),
            h('input', { id: 'menu-search', 'aria-label': 'Search menu' }),
            h('div', { contentEditable: true, suppressContentEditableWarning: true }, h('span', { id: 'editable-child', tabIndex: 0 }, 'Editable')),
            h('button', { id: 'menu-last', role: 'menuitem' }, 'Last'))),
        h('button', { id: 'outside-after' }, 'After'),
        h('button', { id: 'dialog-trigger', onClick: () => setDialog(true) }, 'Remove project'),
        h('button', { id: 'native-trigger', onClick: () => setNative(true) }, 'New branch'),
        h('button', { id: 'nested-dialog-trigger', onClick: () => setNested(true) }, 'Nested controls'),
        dialog && h(ProjectRemoveConfirmOverlay, { projectLabel: 'Fixture', onKeep: () => setDialog(false), onRemove: () => setDialog(false) }),
        native && h(BranchNameDialog, { initialValue: 'fixture', onFinish: () => setNative(false) }),
        nested && h(NestedDialog, { onClose: () => setNested(false) }));
    }
    const mount = document.createElement('div');
    document.body.append(mount);
    createRoot(mount).render(h(Fixture));
  })()`);
  await until(
    () => evaluate('Boolean(document.querySelector("#second-trigger"))'),
    "test mount",
  );
  await click("#second-trigger");
  await key("ArrowDown");
  await verify(
    "ArrowDown enters first menu item",
    'document.activeElement.id === "menu-first"',
  );
  await key("ArrowDown");
  await verify(
    "Arrow navigation skips hidden and disabled items",
    'document.activeElement.id === "menu-last"',
  );
  await key("Escape");
  await verify(
    "Escape returns focus to the trigger that opened the menu",
    'document.activeElement.id === "second-trigger" && !document.querySelector("#test-menu")',
  );
  await click("#first-trigger");
  await click("#second-trigger");
  await key("Escape");
  await verify(
    "Escape follows a switched menu trigger",
    'document.activeElement.id === "second-trigger" && !document.querySelector("#test-menu")',
  );
  await click("#second-trigger");
  await evaluate("document.activeElement.blur()");
  await key("Escape");
  await verify(
    "Escape dismisses a menu when the webview did not retain trigger focus",
    'document.activeElement.id === "second-trigger" && !document.querySelector("#test-menu")',
  );
  await click("#second-trigger");
  await evaluate('document.querySelector("#menu-first").focus()');
  await key("ArrowDown", 4);
  await verify(
    "Command arrow shortcuts retain focus",
    'document.activeElement.id === "menu-first"',
  );
  await evaluate('document.querySelector("#menu-search").focus()');
  await key("Home");
  await verify(
    "Search inputs retain text navigation",
    'document.activeElement.id === "menu-search"',
  );
  await evaluate('document.querySelector("#editable-child").focus()');
  await key("Home");
  await verify(
    "Editable descendants retain text navigation",
    'document.activeElement.id === "editable-child"',
  );
  await evaluate('document.querySelector("#menu-last").focus()');
  await key("Tab");
  await verify(
    "Tab leaves the menu and dismisses it",
    'document.activeElement.id === "outside-after" && !document.querySelector("#test-menu")',
  );
  await key("ArrowUp");
  await verify(
    "Arrow keys outside the menu do not steal focus",
    'document.activeElement.id === "outside-after"',
  );
  await click("#second-trigger");
  await key("Tab", 8);
  await verify(
    "Shift Tab leaves the wrapper without trapping focus",
    'document.activeElement.id === "first-trigger"',
  );
  await key("Tab", 8);
  await verify(
    "Moving focus before the menu dismisses it",
    'document.activeElement.id === "outside-before" && !document.querySelector("#test-menu")',
  );
  await click("#dialog-trigger");
  await verify(
    "Confirmation autofocus stays on its safe action",
    'document.activeElement.classList.contains("gyro-project-remove-keep")',
  );
  await key("Tab", 8);
  await verify(
    "Shift Tab wraps inside confirmation",
    'document.activeElement.classList.contains("gyro-project-remove-confirm")',
  );
  await key("Tab");
  await verify(
    "Tab wraps inside confirmation",
    'document.activeElement.classList.contains("gyro-project-remove-keep")',
  );
  await key("Escape");
  await verify(
    "Escape dismisses project confirmation and restores focus",
    '!document.querySelector(".gyro-project-remove-overlay") && document.activeElement.id === "dialog-trigger"',
  );
  await evaluate(
    'document.querySelector(".gyro-project-remove-keep")?.click()',
  );
  await pause();
  await click("#native-trigger");
  await verify(
    "Native dialog keeps initial input focus",
    'document.activeElement.id === "gyro-branch-name"',
  );
  await key("Escape");
  await verify(
    "Native dialog Escape and focus restoration remain intact",
    '!document.querySelector(".gyro-branch-name-dialog") && document.activeElement.id === "native-trigger"',
  );
  await click("#nested-dialog-trigger");
  await click("#nested-trigger");
  await key("ArrowDown");
  await key("Escape");
  await verify(
    "Escape closes a nested menu before its dialog",
    'Boolean(document.querySelector("#nested-dialog")) && !document.querySelector("#nested-item") && document.activeElement.id === "nested-trigger"',
  );
  await evaluate('document.querySelector("#nested-input").focus()');
  await key("Escape");
  await verify(
    "Controls can consume Escape without dismissing a dialog",
    'Boolean(document.querySelector("#nested-dialog")) && document.activeElement.id === "nested-input"',
  );
  await evaluate('document.querySelector("#nested-trigger").focus()');
  await key("Escape");
  await verify(
    "Escape dismisses a dialog after its nested menu closes",
    '!document.querySelector("#nested-dialog") && document.activeElement.id === "nested-dialog-trigger"',
  );
  const report = {
    result: checks.every((check) => check.pass) ? "PASS" : "FAIL",
    motion,
    checks,
  };
  if (reportPath)
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== "PASS") process.exitCode = 1;
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  await new Promise((resolve) =>
    browser.exitCode !== null ? resolve() : browser.once("exit", resolve),
  );
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
