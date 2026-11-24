import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// Design-system primitives gallery: layout, popups, focus and dismissal in an isolated headless browser.
const origin = process.env.GYRO_TEST_ORIGIN ?? "http://127.0.0.1:1438";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
const fixture = new URL("/primitives-gallery.html", origin);
const response = await fetch(fixture, { signal: AbortSignal.timeout(5_000) });
assert.equal(
  response.status,
  200,
  "Start the desktop Vite preview before running this check",
);
const executable = [
  process.env.GYRO_CAPTURE_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
].find((path) => path && existsSync(path));
assert.ok(
  executable,
  "Set GYRO_CAPTURE_BROWSER to an installed Chromium browser",
);
const profile = await mkdtemp(join(tmpdir(), "gyro-primitives-"));
const output = resolve("artifacts/screenshots/primitives");
await mkdir(output, { recursive: true });
const browser = spawn(
  executable,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--user-data-dir=" + profile,
    "about:blank",
  ],
  { stdio: "ignore" },
);
let launchError;
browser.once("error", (error) => {
  launchError = error;
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    if (browser.exitCode !== null)
      throw Error("Browser exited with " + browser.exitCode);
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw Error("Timed out: " + label);
}
let socket;
const results = [];
const pageErrors = [];
try {
  const port = await until(async () => {
    const path = join(profile, "DevToolsActivePort");
    return (
      existsSync(path) && Number((await readFile(path, "utf8")).split("\n")[0])
    );
  }, "browser startup");
  const pages = await (
    await fetch("http://127.0.0.1:" + port + "/json/list")
  ).json();
  socket = new WebSocket(
    pages.find((page) => page.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown")
      pageErrors.push(message.params.exceptionDetails);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    message.error
      ? call.reject(Error(message.error.message))
      : call.resolve(message.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(method));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
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
  const key = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ["keyDown", "keyUp"])
      await call("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode,
        ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}),
      });
  };
  await call("Page.enable");
  await call("Runtime.enable");
  const waitFor = (expression, label) =>
    until(() => evaluate(expression), label);
  const count = (selector) =>
    evaluate(
      "document.querySelectorAll(" + JSON.stringify(selector) + ").length",
    );
  const click = (selector) =>
    evaluate(
      "document.querySelector(" + JSON.stringify(selector) + ").click()",
    );
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await call("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await call("Page.navigate", { url: fixture + "?theme=" + theme });
      await waitFor('!!document.querySelector("#buttons")', "gallery");
      await evaluate("document.fonts.ready.then(() => true)");
      assert.equal(
        await evaluate("document.documentElement.dataset.theme"),
        theme,
      );
      // Every section renders and nothing overflows the viewport.
      for (const id of [
        "buttons",
        "feedback",
        "controls",
        "popups",
        "dialogs",
        "structure",
      ])
        assert.equal(await count("#" + id), 1, "section " + id);
      assert.ok(
        (await count(".gyro-btn--default.gyro-btn--md")) >= 1,
        "default buttons render",
      );
      assert.equal(
        await evaluate("document.documentElement.scrollWidth > innerWidth"),
        false,
        "no page overflow",
      );
      // Every filled button label must be readable against its own background.
      const contrast = await evaluate(`(() => {
        // Computed colors may be color(srgb ...) from color-mix, so normalise through a canvas.
        const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
        const parse = value => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "#000";
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        return ["default", "secondary", "prominent", "destructive"].map(variant => {
          const el = document.querySelector("#buttons .gyro-btn--" + variant + ":not(:disabled)");
          if (!el) return { variant, ratio: 0 };
          const style = getComputedStyle(el);
          const a = lum(parse(style.color)), b = lum(parse(style.backgroundColor));
          return { variant, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
        });
      })()`);
      for (const { variant, ratio } of contrast)
        assert.ok(
          ratio >= 3,
          "button label contrast for " + variant + " is " + ratio.toFixed(2),
        );
      // Controls carry no shadow: flat by decision.
      assert.equal(
        await evaluate(
          'getComputedStyle(document.querySelector(".gyro-btn--default")).boxShadow',
        ),
        "none",
      );
      // Focus ring on keyboard focus.
      await evaluate('document.querySelector("#buttons .gyro-btn").focus()');
      await key("Tab", "Tab", 9);
      await key("Tab", "Tab", 9);
      const focus = await evaluate(
        "({style:getComputedStyle(document.activeElement).outlineStyle,width:getComputedStyle(document.activeElement).outlineWidth})",
      );
      assert.notEqual(focus.style, "none", "visible focus outline");
      assert.ok(parseFloat(focus.width) >= 1);
      // Menu opens, then Escape dismisses it.
      await evaluate(
        'document.querySelector("#g-menu-trigger").scrollIntoView()',
      );
      await click("#g-menu-trigger");
      await waitFor('!!document.querySelector("[role=menu]")', "menu open");
      assert.ok((await count("[role=menuitem]")) >= 2, "menu items");
      await key("Escape", "Escape", 27);
      await waitFor('!document.querySelector("[role=menu]")', "menu closed");
      // Select opens a listbox and Escape closes it.
      await evaluate(
        'document.querySelector("#g-select-trigger").scrollIntoView(); document.querySelector("#g-select-trigger").focus()',
      );
      await key("ArrowDown", "ArrowDown", 40);
      await waitFor(
        '!!document.querySelector("[role=listbox]")',
        "select open",
      );
      await key("Escape", "Escape", 27);
      // Base UI keeps the select list mounted inside a hidden positioner once closed.
      await waitFor(
        '[...document.querySelectorAll("[role=listbox]")].every(l => l.getBoundingClientRect().width === 0)',
        "select closed",
      );
      assert.equal(
        await evaluate(
          'document.querySelector("#g-select-trigger").getAttribute("aria-expanded")',
        ),
        "false",
      );
      // Dialog is modal, labelled, and dismissed by Escape.
      await click("#g-dialog-trigger");
      await waitFor('!!document.querySelector("[role=dialog]")', "dialog open");
      assert.equal(
        await evaluate(
          '!!document.querySelector("[role=dialog]").getAttribute("aria-labelledby")',
        ),
        true,
        "dialog labelled",
      );
      await pause(260);
      if (width === 1280) {
        const shot = await call("Page.captureScreenshot", { format: "png" });
        await writeFile(
          join(output, theme + "-dialog.png"),
          Buffer.from(shot.data, "base64"),
        );
      }
      await key("Escape", "Escape", 27);
      await waitFor(
        '!document.querySelector("[role=dialog]")',
        "dialog closed",
      );
      // Alert dialog uses the alertdialog role.
      await click("#g-alert-trigger");
      await waitFor(
        '!!document.querySelector("[role=alertdialog]")',
        "alert dialog open",
      );
      await key("Escape", "Escape", 27);
      await waitFor(
        '!document.querySelector("[role=alertdialog]")',
        "alert dialog closed",
      );
      // Toast appears.
      await click("#g-toast");
      await waitFor(
        'document.body.textContent.includes("Settings updated.")',
        "toast",
      );
      await pause(250);
      await call("Page.navigate", { url: fixture + "?theme=" + theme });
      await waitFor('!!document.querySelector("#buttons")', "gallery reload");
      await evaluate("document.fonts.ready.then(() => true)");
      const shot = await call("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      await writeFile(
        join(output, theme + "-" + width + ".png"),
        Buffer.from(shot.data, "base64"),
      );
      results.push({ theme, width, passed: true });
    }
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(
    results.length +
      " primitives browser cases passed; layout, flat controls, focus, menu, select, dialogs and toast checked.",
  );
} finally {
  socket?.close();
  browser.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => browser.once("exit", resolve)),
    pause(2_000),
  ]);
  if (browser.exitCode !== null || browser.signalCode !== null)
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
}
