// Self-contained native smoke runner for the packaged debug app. Build first:
//   pnpm --filter @gyro-dev/desktop tauri build --debug --bundles app --no-sign --ci
// Then this serves the loopback browser fixture, launches the debug app once
// for the browser smoke (GYRO_BROWSER_SMOKE_URL) and once for the LSP smoke
// (GYRO_LSP_SMOKE=1), and fails unless both harnesses write an ok report.
// Both harnesses are #[cfg(debug_assertions)]-only in lib.rs, so the report
// files double as proof that the env-gated paths still exist and run.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appBundle = resolve(repoRoot, "target/debug/bundle/macos/Gyro.app");

// The bundle's executable carries the product binary's name (gyro-desktop),
// which is not the bundle's (Gyro.app), so it is resolved from the bundle
// instead of assumed: the plist's CFBundleExecutable first, then the first
// entry in Contents/MacOS.
function resolveAppBinary() {
  if (process.env.GYRO_NATIVE_SMOKE_APP) {
    return process.env.GYRO_NATIVE_SMOKE_APP;
  }
  const macOSDir = resolve(appBundle, "Contents/MacOS");
  const plistPath = resolve(appBundle, "Contents/Info.plist");
  if (existsSync(plistPath)) {
    const plist = readFileSync(plistPath, "utf8");
    const name = plist.match(
      /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/,
    )?.[1];
    if (name) return resolve(macOSDir, name);
  }
  if (existsSync(macOSDir)) {
    const [entry] = readdirSync(macOSDir);
    if (entry) return resolve(macOSDir, entry);
  }
  return resolve(macOSDir, "gyro-desktop");
}
const appPath = resolveAppBinary();
const skipBrowser = process.env.GYRO_NATIVE_SMOKE_SKIP_BROWSER === "1";
const skipLsp = process.env.GYRO_NATIVE_SMOKE_SKIP_LSP === "1";

if (!existsSync(appPath)) {
  console.error(
    `No app binary at ${appPath}. Build the debug bundle first: pnpm --filter @gyro-dev/desktop tauri build --debug --bundles app --no-sign --ci`,
  );
  process.exit(1);
}

const fixture = await readFile(
  resolve(repoRoot, "scripts/fixtures/browser-observation.html"),
);
const server = createServer((request, response) => {
  if (request.url?.split("?")[0] !== "/browser-observation.html") {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(fixture);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const fixtureUrl = `http://127.0.0.1:${server.address().port}/browser-observation.html`;
const dataDir = await mkdtemp(join(tmpdir(), "gyro-native-smoke-"));

async function runSmoke({ name, report, timeoutMs, env }) {
  console.log(`\n== ${name} smoke ==`);
  const { code, signal } = await new Promise((resolve) => {
    const child = spawn(appPath, [], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const timer = setTimeout(() => {
      console.error(`${name} smoke exceeded ${timeoutMs / 1000}s; terminating`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  const reportPath = join(dataDir, report);
  if (!existsSync(reportPath)) {
    console.error(
      `${name} smoke wrote no ${report} (exit ${code}, signal ${signal}); a release build compiles the GYRO_* harnesses out`,
    );
    return false;
  }
  const result = JSON.parse(await readFile(reportPath, "utf8"));
  if (!result.ok) {
    console.error(
      `${name} smoke failed: ${JSON.stringify(result.error ?? result)}`,
    );
    return false;
  }
  for (const step of result.steps ?? []) console.log(`  - ${step}`);
  console.log(`${name} smoke passed (${(result.steps ?? []).length} steps)`);
  return true;
}

let ok = true;
try {
  if (!skipBrowser) {
    ok =
      (await runSmoke({
        name: "Browser",
        report: "browser-smoke.json",
        timeoutMs: 300000,
        env: {
          GYRO_BROWSER_SMOKE_URL: fixtureUrl,
          GYRO_TEST_DATA_DIR: dataDir,
        },
      })) && ok;
  }
  if (!skipLsp) {
    ok =
      (await runSmoke({
        name: "LSP",
        report: "lsp-smoke.json",
        timeoutMs: 900000,
        env: {
          GYRO_LSP_SMOKE: "1",
          GYRO_LSP_SMOKE_ROOT: repoRoot,
          GYRO_TEST_DATA_DIR: dataDir,
        },
      })) && ok;
  }
} finally {
  server.close();
  await rm(dataDir, { recursive: true, force: true });
}
if (!ok) process.exit(1);
console.log(
  "\nNative smoke passed: browser fixture and language server both reported ok.",
);
