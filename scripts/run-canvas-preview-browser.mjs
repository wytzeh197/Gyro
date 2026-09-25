// Self-contained runner for check-canvas-preview-browser.mjs: serve the Vite
// dev app that hosts canvas-fixture.html, pick a Chromium-family browser, run
// the check against both, and tear the server down. The check itself stays a
// pure "drive this origin with this browser" script.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.env.GYRO_TEST_ORIGIN || "http://127.0.0.1:1420";

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
    return (await fetch(`${origin}/canvas-fixture.html`)).ok;
  } catch {
    return false;
  }
};

let devServer;
if (!(await reachable())) {
  console.log(`Starting the desktop dev server for ${origin}...`);
  devServer = spawn("pnpm", ["--filter", "@gyro-dev/desktop", "dev"], {
    cwd: repoRoot,
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
    devServer.kill("SIGTERM");
    console.error(
      `The dev server never served ${origin}/canvas-fixture.html; start 'pnpm desktop:dev' or set GYRO_TEST_ORIGIN.`,
    );
    process.exit(1);
  }
}

const check = spawn(
  process.execPath,
  ["scripts/check-canvas-preview-browser.mjs"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      GYRO_TEST_ORIGIN: origin,
      GYRO_CAPTURE_BROWSER: browserPath,
    },
  },
);
const exitCode = await new Promise((resolve) => check.once("exit", resolve));
devServer?.kill("SIGTERM");
process.exit(exitCode ?? 1);
