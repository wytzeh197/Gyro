#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(
  repoRoot,
  "artifacts/screenshots/gyro-quality-after",
);
const appOrigin = "http://127.0.0.1:1420";
const playwrightCache = resolve(homedir(), "Library/Caches/ms-playwright");
const cachedHeadlessShells = existsSync(playwrightCache)
  ? readdirSync(playwrightCache)
      .filter((entry) => entry.startsWith("chromium_headless_shell-"))
      .sort((left, right) =>
        right.localeCompare(left, undefined, { numeric: true }),
      )
      .map((entry) =>
        resolve(
          playwrightCache,
          entry,
          "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        ),
      )
  : [];
const chrome = [
  process.env.GYRO_CAPTURE_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ...cachedHeadlessShells,
].find((candidate) => candidate && existsSync(candidate));
const debugPort = 9344;

const states = [
  { name: "welcome", scene: "welcome", clicks: [] },
  {
    name: "active-chat",
    scene: "active-chat",
    clicks: ["Bound the sync"],
  },
  {
    name: "workspace-source-control",
    scene: "workspace-source-control",
    clicks: ["Workspace", "Source Control"],
  },
  {
    name: "selected-diff",
    scene: "selected-diff",
    clicks: ["Workspace", "Source Control", "sync.js"],
  },
  {
    name: "appearance",
    scene: "appearance",
    clicks: ["Settings", "Appearance"],
  },
];

const viewports = [
  { name: "reference", width: 1600, height: 975 },
  { name: "desktop", width: 1440, height: 900 },
  { name: "compact", width: 1024, height: 700 },
];

const captureFilter = process.env.GYRO_CAPTURE_FILTER;
const shots = states
  .flatMap((state) =>
    viewports.flatMap((viewport) =>
      ["light", "dark"].map((theme) => ({
        ...state,
        ...viewport,
        name: `${state.name}-${viewport.name}-${theme}`,
        theme,
        url: `${appOrigin}/capture.html?scene=${state.scene}&theme=${theme}`,
      })),
    ),
  )
  .filter((shot) => !captureFilter || shot.name.includes(captureFilter));

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
if (!chrome) {
  throw new Error(
    "No capture browser found. Set GYRO_CAPTURE_BROWSER or install a Playwright Chromium browser.",
  );
}
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
      expression: `localStorage.clear(); localStorage.setItem('gyro.theme', ${JSON.stringify(shot.theme ?? "dark")});`,
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
    for (const click of shot.clicks) {
      const result = await call("Runtime.evaluate", {
        expression: `(() => {
          const wanted = ${JSON.stringify(click)};
          const nodes = [...document.querySelectorAll('button, [role="button"], [role="tab"], a')];
          const labels = (node) => [
            (node.textContent || '').trim(),
            node.getAttribute('aria-label') || '',
            node.getAttribute('title') || '',
          ].filter(Boolean);
          const match = nodes
            .filter((node) => labels(node).some((label) => label.startsWith(wanted)))
            .sort((a, b) => Math.min(...labels(a).map((label) => label.length)) - Math.min(...labels(b).map((label) => label.length)))[0];
          match?.click();
          return match ? 'clicked:' + labels(match)[0] : 'missing:' + wanted;
        })()`,
        returnByValue: true,
      });
      if (!String(result.result.value).startsWith("clicked:")) {
        throw new Error(`${shot.name} ${result.result.value}`);
      }
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
