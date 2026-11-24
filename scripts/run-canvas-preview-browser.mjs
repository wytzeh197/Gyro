// Self-contained runner for check-canvas-preview-browser.mjs: serve the Vite
// dev app that hosts canvas-fixture.html, pick a Chromium-family browser, run
// the check against both, and tear the server down. The check itself stays a
// pure "drive this origin with this browser" script.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function isolatedOrigin() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return `http://127.0.0.1:${port}`;
}
const origin = process.env.GYRO_TEST_ORIGIN || await isolatedOrigin();
const browserChecks = [
  ["--first-run-tour", "first-run-tour-fixture.html", "scripts/check-first-run-tour-browser.mjs"],
  ["--environment", "first-run-tour-fixture.html", "scripts/check-chat-environment-overlay.mjs"],
  ["--remote-access", "remote-access-preview.html", "scripts/check-remote-access-browser.mjs"],
  ["--usage-settings", "settings-preview.html", "scripts/check-usage-settings-browser.mjs"],
  ["--theme-parity", "capture.html", "scripts/check-theme-parity-browser.mjs"],
  ["--activity-composer", "goal-composer-fixture.html", "scripts/check-activity-composer-browser.mjs"],
  ["--workflows", "v012-workflow-fixture.html", "scripts/check-workflows-browser.mjs"],
  ["--settings-redesign", "settings-preview.html", "scripts/check-settings-redesign.mjs"],
  ["--companion-redesign", "companion-polish-fixture.html", "scripts/check-companion-redesign.mjs"],
  ["--command-failure", "command-failure-fixture.html", "scripts/check-command-failure-browser.mjs"],
  ["--primitives", "primitives-gallery.html", "scripts/check-primitives-browser.mjs"],
];
const selectedCheck = browserChecks.find(([flag]) => process.argv.includes(flag));
const [, fixture, guard] = selectedCheck ?? [
  "", "canvas-fixture.html", "scripts/check-canvas-preview-browser.mjs",
];

const browserPath = [
  process.env.GYRO_CAPTURE_BROWSER,
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
].find((candidate) => candidate && existsSync(candidate));
if (!browserPath) {
  console.error(
    "No Chromium-family browser found for the Canvas browser check. Set GYRO_CAPTURE_BROWSER to a Chromium-based browser binary.",
  );
  process.exit(1);
}
console.log(`Canvas browser: ${browserPath}`);

const reachable = async () => {
  try {
    return (await fetch(`${origin}/${fixture}`)).ok;
  } catch {
    return false;
  }
};

let devServer;
function stopDevServer() {
  if (!devServer) return;
  try {
    // pnpm starts Vite as a child. Stop our entire group, never a reused server.
    if (process.platform !== "win32") process.kill(-devServer.pid, "SIGTERM");
    else devServer.kill("SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
if (!(await reachable())) {
  console.log(`Starting the desktop dev server for ${origin}...`);
  devServer = spawn("pnpm", [
    "--filter", "@gyro-dev/desktop", "exec", "vite",
    "--host", "127.0.0.1", "--port", new URL(origin).port || "1420", "--strictPort",
  ], {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "inherit"],
  });
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline && devServer.exitCode === null) {
    if (await reachable()) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) {
    stopDevServer();
    console.error(
      `The dev server never served ${origin}/${fixture}; start 'pnpm desktop:dev' or set GYRO_TEST_ORIGIN.`,
    );
    process.exit(1);
  }
}

const check = spawn(process.execPath, [guard], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    GYRO_TEST_ORIGIN: origin,
    GYRO_CAPTURE_BROWSER: browserPath,
  },
});
const exitCode = await new Promise((resolve) => check.once("exit", resolve));
stopDevServer();
process.exit(exitCode ?? 1);
