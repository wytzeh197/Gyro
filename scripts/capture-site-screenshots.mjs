#!/usr/bin/env node

/**
 * Captures the marketing screenshots under `site/assets/screenshots/` from the
 * real Gyro UI.
 *
 * The desktop UI is rendered in headless Chrome against `capture.html`, which
 * installs a fake Tauri IPC layer (see `apps/desktop/src/capture-fixtures.ts`)
 * so the app shows populated demo content. Nothing here reads a real session,
 * repository, or provider account, so the output is safe to publish and
 * reproducible for every release.
 *
 * Usage:
 *   pnpm --filter @gyro-dev/desktop dev     # in another shell
 *   node scripts/capture-site-screenshots.mjs
 *
 * Options:
 *   --scene <name>   capture a single scene
 *   --keep-png       also write the intermediate PNGs next to the WebP output
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(repoRoot, "site/assets/screenshots");
const stagingRoot = resolve(repoRoot, "docs/screenshots/site-v4");
const appOrigin = "http://127.0.0.1:1420";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const debugPort = 9333;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const keepPng = process.argv.includes("--keep-png");

/**
 * Each scene renders one app surface at its master size, then downscales into
 * the responsive variants the site references. `steps` are run in the page
 * after load to drive the UI into the state we want to photograph.
 */
const scenes = [
  {
    /*
     * One 5:4 hero for every viewport. The app is laid out at 1200x960 CSS
     * pixels because that density is what reads well in the frame; the 2x
     * device scale gives us a 2400px master, so the desktop stage still has a
     * retina-sharp source to pick from.
     */
    name: "hero",
    urlScene: "chat",
    width: 1200,
    height: 960,
    steps: ["selectSession"],
    outputs: [
      { file: "hero-2400.webp", width: 2400, height: 1920 },
      { file: "hero-1200.webp", width: 1200, height: 960 },
      { file: "hero-600.webp", width: 600, height: 480 },
    ],
  },
];

/**
 * Clicks the first control whose visible text, aria-label, or title matches.
 * Icon-only buttons in the activity bar have no text, so the label fallbacks
 * matter. Shortest match wins, which keeps a leaf button from losing to its
 * container.
 */
const clickByText = (text) => `
  (() => {
    const wanted = ${JSON.stringify(text)};
    const nodes = [...document.querySelectorAll('button, [role="button"], [role="tab"], a, li')];
    const label = (node) =>
      (node.textContent || '').trim() ||
      node.getAttribute('aria-label') ||
      node.getAttribute('title') ||
      '';
    const match = nodes
      .filter((node) => label(node).startsWith(wanted))
      .sort((a, b) => label(a).length - label(b).length)[0];
    if (!match) return 'missing:' + wanted;
    match.click();
    return 'clicked:' + wanted;
  })()
`;

const steps = {
  selectSession: `
    (() => {
      const nodes = [...document.querySelectorAll('button, [role="button"], li, a')];
      const match = nodes.find((node) =>
        (node.textContent || '').includes('Bound the sync'));
      if (!match) return 'missing:session';
      match.click();
      return 'clicked:session';
    })()
  `,
  openPane: clickByText("Claude Code"),
  openWorkspace: clickByText("Workspace"),
  openSourceControl: clickByText("Source Control"),
  closeCompanion: clickByText("Close AI companion"),
  openDiffTab: clickByText("Diff"),
  openChangedFile: `
    (() => {
      const nodes = [...document.querySelectorAll('button, [role="button"], li')];
      const match = nodes.find((node) =>
        (node.textContent || '').includes('sync.js'));
      if (!match) return 'missing:changed-file';
      match.click();
      return 'clicked:changed-file';
    })()
  `,
};

function fail(message) {
  console.error(`Screenshot capture failed: ${message}`);
  process.exit(1);
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
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

/** Minimal Chrome DevTools Protocol client over the browser WebSocket. */
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

function encodeWebp(sourcePng, target, width, height) {
  const result = spawnSync(
    "cwebp",
    [
      "-quiet",
      "-q",
      "88",
      "-resize",
      String(width),
      String(height),
      sourcePng,
      "-o",
      target,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(`cwebp failed for ${target}: ${result.stderr || result.stdout}`);
  }
}

async function main() {
  const only = argument("--scene");
  const selected = only ? scenes.filter((s) => s.name === only) : scenes;
  if (!selected.length) fail(`unknown scene ${only}`);

  try {
    await fetchJson(`${appOrigin}/@vite/client`).catch(() => null);
    const probe = await fetch(`${appOrigin}/capture.html`);
    if (!probe.ok) throw new Error(String(probe.status));
  } catch {
    fail(
      `the desktop dev server is not answering on ${appOrigin}.\n` +
        "Start it first: pnpm --filter @gyro-dev/desktop dev",
    );
  }

  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });

  // A fresh profile per run keeps localStorage clean and avoids colliding with
  // a Chrome instance that has not fully exited yet.
  const profile = mkdtempSync(resolve(tmpdir(), "gyro-capture-"));
  const browser = spawn(
    chrome,
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
      { label: "Chrome to expose its debugging endpoint" },
    );
    devtools = await Devtools.connect(version.webSocketDebuggerUrl);

    for (const scene of selected) {
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
        width: scene.width,
        height: scene.height,
        deviceScaleFactor: 2,
        mobile: false,
      });

      // Seed the theme before the app boots, then load the harness.
      await call("Page.navigate", { url: `${appOrigin}/capture.html` });
      await new Promise((done) => setTimeout(done, 1500));
      await call("Runtime.evaluate", {
        expression: `localStorage.setItem('gyro.theme','dark');
          localStorage.setItem('gyro.workbench-state', JSON.stringify(${JSON.stringify(
            {
              preferences: { theme: "dark", density: "compact" },
              lastSessionsLayout: "thread",
              isToolPanelOpen: false,
              ...(scene.workbench ?? {}),
            },
          )}));`,
      });
      await call("Page.navigate", {
        url: `${appOrigin}/capture.html?scene=${scene.urlScene}`,
      });

      await waitFor(
        async () => {
          const { result } = await call("Runtime.evaluate", {
            expression: `document.querySelector('#root')?.childElementCount > 0`,
            returnByValue: true,
          });
          return result.value === true;
        },
        { label: `${scene.name} to mount` },
      );
      await new Promise((done) => setTimeout(done, 1200));

      for (const step of scene.steps) {
        const { result } = await call("Runtime.evaluate", {
          expression: steps[step],
          returnByValue: true,
        });
        console.log(`  ${scene.name}: ${step} -> ${result.value}`);
        await new Promise((done) => setTimeout(done, 900));
      }

      await new Promise((done) => setTimeout(done, 1200));

      const { result: missing } = await call("Runtime.evaluate", {
        expression: "window.__captureMissing ? window.__captureMissing() : []",
        returnByValue: true,
      });
      if (missing.value?.length) {
        console.log(
          `  ${scene.name}: unstubbed -> ${missing.value.join(", ")}`,
        );
      }
      const { result: crash } = await call("Runtime.evaluate", {
        expression: `(document.body.textContent || '').includes('rendering error')`,
        returnByValue: true,
      });
      if (crash.value === true) {
        const { result: detail } = await call("Runtime.evaluate", {
          expression: "(document.body.textContent || '').slice(0, 400)",
          returnByValue: true,
        });
        fail(`${scene.name} rendered the app error boundary: ${detail.value}`);
      }

      const shot = await call("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      const png = resolve(stagingRoot, `${scene.name}.png`);
      writeFileSync(png, Buffer.from(shot.data, "base64"));

      for (const output of scene.outputs) {
        const target = resolve(outputRoot, output.file);
        encodeWebp(png, target, output.width, output.height);
        console.log(
          `  wrote ${output.file} (${output.width}x${output.height})`,
        );
      }
      if (!keepPng) rmSync(png, { force: true });

      await devtools.send("Target.closeTarget", { targetId });
    }
  } finally {
    devtools?.close();
    browser.kill();
    try {
      // Best effort: Chrome may still be flushing the profile as it exits, and
      // this is a temp directory the OS reclaims anyway.
      rmSync(profile, { force: true, recursive: true });
    } catch {
      // ignore
    }
  }

  console.log("Screenshot capture complete.");
}

await main();
