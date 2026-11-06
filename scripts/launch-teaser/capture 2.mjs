#!/usr/bin/env node

/**
 * Rasterize launch-teaser compositor plates with a local Chromium.
 *
 * Usage: node scripts/launch-teaser/capture.mjs <output-dir>
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const compositor = "scripts/launch-teaser/index.html";
const debugPort = 9334;
const width = 1920;
const height = 1080;
const scenes = [
  "logo",
  "chat",
  "cli",
  "workspace",
  "together",
  "agents",
  "end",
];

const browserCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function fail(message) {
  console.error(`Launch teaser capture failed: ${message}`);
  process.exit(1);
}

function resolveBrowser() {
  const override = process.env.GYRO_CAPTURE_BROWSER;
  if (override) {
    if (!existsSync(override)) {
      fail(`GYRO_CAPTURE_BROWSER points at ${override}, which does not exist`);
    }
    return override;
  }
  const found = browserCandidates.find((path) => existsSync(path));
  if (!found) {
    fail(
      `no Chromium found. Install Chrome or Brave, or set GYRO_CAPTURE_BROWSER. Looked in:\n  ${browserCandidates.join("\n  ")}`,
    );
  }
  return found;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

async function waitFor(
  check,
  { timeoutMs = 20_000, label = "condition" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // keep polling until the deadline
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((done) => setTimeout(done, 200));
  }
}

class Devtools {
  #socket;
  #nextId = 0;
  #pending = new Map();

  static async connect(url) {
    const client = new Devtools();
    client.#socket = new WebSocket(url);
    client.#socket.addEventListener("message", (message) => {
      const frame = JSON.parse(message.data);
      const entry = client.#pending.get(frame.id);
      if (!entry) return;
      client.#pending.delete(frame.id);
      if (frame.error) entry.reject(new Error(frame.error.message));
      else entry.resolve(frame.result);
    });
    await new Promise((done, error) => {
      client.#socket.addEventListener("open", done, { once: true });
      client.#socket.addEventListener("error", error, { once: true });
    });
    return client;
  }

  send(method, params = {}, sessionId) {
    this.#nextId += 1;
    const id = this.#nextId;
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    this.#socket.send(JSON.stringify(frame));
    return new Promise((resolve, reject) =>
      this.#pending.set(id, { resolve, reject }),
    );
  }

  close() {
    this.#socket.close();
  }
}

function startStaticServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = resolve(repoRoot, relative || compositor);
    if (!file.startsWith(repoRoot) || !existsSync(file)) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": mime[extname(file)] ?? "application/octet-stream",
    });
    response.end(readFileSync(file));
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({ server, port: address.port });
    });
  });
}

async function main() {
  const outputDir = resolve(process.argv[2] ?? "");
  if (!outputDir) fail("pass an output directory");
  mkdirSync(outputDir, { recursive: true });

  const required = [
    resolve(repoRoot, compositor),
    resolve(repoRoot, "packages/ui/src/assets/gyro-logo-transparent.png"),
    resolve(repoRoot, "docs/screenshots/readme/chat-workflow.webp"),
    resolve(repoRoot, "docs/screenshots/readme/cli-workbench.webp"),
    resolve(repoRoot, "docs/screenshots/readme/workspace-review.webp"),
    resolve(repoRoot, "site/assets/screenshots/hero-2400.webp"),
    resolve(repoRoot, "site/assets/fonts/inter-latin.woff2"),
    resolve(repoRoot, "site/assets/fonts/inter-tight-latin.woff2"),
  ];
  for (const asset of required) {
    if (!existsSync(asset)) fail(`missing ${asset}`);
  }

  const { server, port } = await startStaticServer();
  const origin = `http://127.0.0.1:${port}`;
  const profile = mkdtempSync(resolve(tmpdir(), "gyro-teaser-"));
  const browserBinary = resolveBrowser();
  console.log(`Driving ${browserBinary}`);
  const browser = spawn(
    browserBinary,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
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
      { label: "Chromium to expose its debugging endpoint" },
    );
    devtools = await Devtools.connect(version.webSocketDebuggerUrl);

    for (const scene of scenes) {
      const { targetId } = await devtools.send("Target.createTarget", {
        url: "about:blank",
      });
      const { sessionId } = await devtools.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const call = (method, params) =>
        devtools.send(method, params, sessionId);

      await call("Page.enable");
      await call("Runtime.enable");
      await call("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await call("Page.navigate", {
        url: `${origin}/${compositor}?scene=${scene}`,
      });
      await waitFor(
        async () => {
          const { result } = await call("Runtime.evaluate", {
            expression: `document.body?.dataset.ready === "1"`,
            returnByValue: true,
          });
          return result.value === true;
        },
        { label: `${scene} fonts and images` },
      );
      await new Promise((done) => setTimeout(done, 250));

      const shot = await call("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      const file = resolve(outputDir, `${scene}.png`);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(`wrote ${file}`);
      await devtools.send("Target.closeTarget", { targetId });
    }
  } finally {
    devtools?.close();
    browser.kill("SIGKILL");
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error.stack || String(error)));
