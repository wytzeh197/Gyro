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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(repoRoot, "site/assets/screenshots");
const stagingRoot = resolve(repoRoot, "docs/screenshots/site-v4");
const appOrigin = "http://127.0.0.1:1420";
const debugPort = 9333;

/*
 * Any Chromium will do — the capture only ever speaks the DevTools protocol, so
 * the engine matters and the badge on it does not. Chrome is tried first
 * because it is what CI installs; the rest are here so a contributor who keeps
 * a different Chromium on their Mac is not blocked. GYRO_CAPTURE_BROWSER wins
 * over all of them for anything installed somewhere unusual.
 */
const browserCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

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
      `no Chromium found. Install Google Chrome, or set GYRO_CAPTURE_BROWSER to a Chromium binary. Looked in:\n  ${browserCandidates.join("\n  ")}`,
    );
  }
  return found;
}

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
/*
 * The hero is one 16:10 frame. The earlier 5:4 crop left a column of empty
 * thread under the last message: a taller frame does not add app, it adds
 * background. 1200x750 CSS pixels at a 2x device scale gives the 2400px master
 * the desktop stage picks from.
 *
 * `steps` matter as much as the size. A freshly opened session shows a
 * collapsed run and no side panel, which photographs as an app that has not
 * done anything — the exact impression the hero should not leave. Expanding the
 * run puts the search, the command, and the three edited files on screen, and
 * opening the environment panel fills the right edge with the state Gyro keeps
 * beside the conversation.
 */
const heroSteps = ["selectSession", "expandRun", "openEnvironment"];

const scenes = [
  {
    name: "hero",
    urlScene: "chat",
    theme: "dark",
    width: 1200,
    height: 750,
    steps: heroSteps,
    outputs: [
      { file: "hero-2400.webp", width: 2400, height: 1500 },
      { file: "hero-1200.webp", width: 1200, height: 750 },
      { file: "hero-600.webp", width: 600, height: 375 },
    ],
  },
  {
    /* The same frame in the light theme, for visitors who flip the toggle. */
    name: "hero-light",
    urlScene: "chat",
    theme: "light",
    width: 1200,
    height: 750,
    steps: heroSteps,
    outputs: [
      { file: "hero-light-2400.webp", width: 2400, height: 1500 },
      { file: "hero-light-1200.webp", width: 1200, height: 750 },
      { file: "hero-light-600.webp", width: 600, height: 375 },
    ],
  },
];

// Manual-only visual regression scenes. They are deliberately excluded from
// the normal marketing capture, but `--scene <name>` gives release validation
// a clean-profile way to inspect states that should never become site assets.
const testScenes = [
  {
    name: "ollama-empty",
    urlScene: "ollama-empty",
    theme: "dark",
    width: 1200,
    height: 750,
    steps: [],
    outputs: [],
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
  /*
   * The run summary collapses to a single "Worked for" line. Expanded, it is
   * the transcript: what was searched, what was run, and which files changed.
   */
  expandRun: `
    (() => {
      const toggle = document.querySelector('.gyro-run-header-toggle');
      if (!toggle) return 'missing:run-header';
      if (toggle.getAttribute('aria-expanded') === 'true') return 'already:run';
      toggle.click();
      return 'clicked:run';
    })()
  `,
  openEnvironment: `
    (() => {
      const button = [...document.querySelectorAll('button')].find(
        (node) => node.getAttribute('aria-label') === 'Open right side panel');
      if (!button) return 'missing:environment';
      button.click();
      return 'clicked:environment';
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
  const selected = only
    ? [...scenes, ...testScenes].filter((scene) => scene.name === only)
    : scenes;
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
      const theme = scene.theme ?? "dark";
      await call("Runtime.evaluate", {
        expression: `localStorage.setItem('gyro.theme', ${JSON.stringify(theme)});
          localStorage.setItem('gyro.workbench-state', JSON.stringify(${JSON.stringify(
            {
              preferences: { theme, density: "compact" },
              lastSessionsLayout: "thread",
              isToolPanelOpen: false,
              ...(scene.workbench ?? {}),
            },
          )}));`,
      });
      await call("Page.navigate", {
        url: `${appOrigin}/capture.html?scene=${scene.urlScene}&theme=${theme}`,
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
