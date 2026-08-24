#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(
  repoRoot,
  "artifacts/screenshots/gyro-quality-after",
);
const appOrigin = "http://127.0.0.1:1420";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const debugPort = 9344;

const shots = [
  {
    name: "01-chat-start-dark",
    url: `${appOrigin}/capture.html?scene=chat`,
    width: 1440,
    height: 900,
    theme: "dark",
  },
  {
    name: "05-chat-start-light",
    url: `${appOrigin}/capture.html?scene=chat`,
    width: 1440,
    height: 900,
    theme: "light",
  },
  {
    name: "06-settings-dark",
    url: `${appOrigin}/capture.html?scene=chat`,
    width: 1440,
    height: 900,
    theme: "dark",
    click: "Settings",
  },
];

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

async function waitFor(check, { timeoutMs = 45000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // keep polling
    }
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

class Devtools {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static connect(url) {
    return new Promise((resolvePromise, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolvePromise(new Devtools(ws)));
      ws.addEventListener("error", () =>
        reject(new Error("devtools websocket failed")),
      );
    });
  }

  send(method, params, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
    });
  }

  close() {
    this.ws.close();
  }
}

mkdirSync(outputRoot, { recursive: true });
const profile = mkdtempSync(resolve(tmpdir(), "gyro-quality-"));
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let devtools;
try {
  const version = await waitFor(
    () => fetchJson(`http://127.0.0.1:${debugPort}/json/version`),
    { label: "Chrome debug port" },
  );
  devtools = await Devtools.connect(version.webSocketDebuggerUrl);

  for (const shot of shots) {
    const { targetId } = await devtools.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await devtools.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const call = (method, params) => devtools.send(method, params, sessionId);
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      width: shot.width,
      height: shot.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", { url: `${appOrigin}/capture.html` });
    await new Promise((done) => setTimeout(done, 400));
    await call("Runtime.evaluate", {
      expression: `localStorage.setItem('gyro.theme', ${JSON.stringify(shot.theme ?? "dark")});`,
    });
    await call("Page.navigate", { url: shot.url });
    await waitFor(
      async () => {
        const { result } = await call("Runtime.evaluate", {
          expression:
            "Boolean(document.querySelector('.gyro-app-shell')) && !document.querySelector('.gyro-early-shell')",
          returnByValue: true,
        });
        return result.value === true;
      },
      { label: `${shot.name} app shell`, timeoutMs: 60000 },
    );
    await new Promise((done) => setTimeout(done, 800));
    if (shot.click) {
      await call("Runtime.evaluate", {
        expression: `(() => {
          const wanted = ${JSON.stringify(shot.click)};
          const nodes = [...document.querySelectorAll('button, [role="button"]')];
          const match = nodes.find((node) => (node.textContent || '').trim() === wanted);
          match?.click();
          return match ? 'clicked' : 'missing';
        })()`,
      });
      await new Promise((done) => setTimeout(done, 700));
    }
    const png = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    writeFileSync(
      resolve(outputRoot, `${shot.name}.png`),
      Buffer.from(png.data, "base64"),
    );
    console.log(`wrote ${shot.name}.png`);
    await devtools.send("Target.closeTarget", { targetId });
  }
} finally {
  devtools?.close();
  browser.kill();
  try {
    rmSync(profile, { force: true, recursive: true });
  } catch {
    // ignore
  }
}
