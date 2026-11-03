import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin")
  throw new Error("This script builds a macOS app.");

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = join(root, "apps/desktop");
const buildDir = mkdtempSync(join(tmpdir(), "gyro-cloud-staging-"));
const targetDir = resolve(process.env.CARGO_TARGET_DIR || join(root, "target"));
const productName = "Gyro Cloud Staging";
const identifier = "dev.gyro.desktop.cloudstaging";
const pins = {
  GYRO_CLOUD_V2_STAGING_API_ORIGIN: "https://staging-api.usegyro.io",
  GYRO_CLOUD_V2_STAGING_AUTH_PROJECT: "hqyahsvqjizmsfxclxzd",
  GYRO_CLOUD_V2_STAGING_AUTH_PUBLISHABLE_KEY:
    "sb_publishable_NKcgdQHudtPow-IGRu-1jw_QRrIoANs",
  GYRO_CLOUD_V2_STAGING_SHARE_ORIGIN: "https://staging-reports.usegyro.io",
};

const env = {};
for (const name of [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "CARGO_NET_OFFLINE",
]) {
  if (process.env[name]) env[name] = process.env[name];
}
Object.assign(env, pins, { CI: "1", CARGO_TARGET_DIR: targetDir });
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + " failed");
}

const frontend = join(buildDir, "frontend");
const base = JSON.parse(
  readFileSync(join(desktop, "src-tauri/tauri.conf.json"), "utf8"),
);
const config = join(buildDir, "tauri-staging.json");
writeFileSync(
  config,
  JSON.stringify({
    productName,
    identifier,
    app: {
      windows: base.app.windows.map((window) => ({
        ...window,
        title: productName,
      })),
      security: {
        assetProtocol: {
          scope: [
            "$DATA/Gyro Cloud Staging/sessions/attachments/**",
            "$DATA/Gyro Cloud Staging/browser-captures/**",
          ],
        },
      },
    },
    build: { devUrl: null, beforeBuildCommand: null, frontendDist: frontend },
    bundle: { createUpdaterArtifacts: false },
    plugins: { updater: { endpoints: [] } },
  }),
);

run(process.execPath, [join(root, "packages/codemode/build.mjs")]);
run(
  join(desktop, "node_modules/.bin/vite"),
  ["build", "--outDir", frontend],
  desktop,
);
run(
  join(desktop, "node_modules/.bin/tauri"),
  [
    "build",
    "--debug",
    "--features",
    "tauri/custom-protocol",
    "--bundles",
    "app",
    "--no-sign",
    "--ci",
    "--config",
    config,
  ],
  desktop,
);

const built = join(targetDir, "debug/bundle/macos", productName + ".app");
const bundle = join(buildDir, productName + ".app");
run("/usr/bin/ditto", [built, bundle]);
const contents = join(bundle, "Contents");
const plist = join(contents, "Info.plist");
const launcher = "gyro-staging-launcher";
run("/usr/bin/clang", [
  "-Wall",
  "-Wextra",
  "-Werror",
  join(root, "scripts/cloud-staging-launcher.c"),
  "-o",
  join(contents, "MacOS", launcher),
]);
run("/usr/bin/plutil", [
  "-replace",
  "CFBundleExecutable",
  "-string",
  launcher,
  plist,
]);
run("/usr/bin/plutil", ["-lint", plist]);

const native = readFileSync(join(contents, "MacOS/gyro-desktop"));
const entry = readFileSync(join(frontend, "index.html"), "utf8").match(
  /src="(\/assets\/index-[^"]+\.js)"/,
)?.[1];
if (
  !entry ||
  !native.includes(entry) ||
  native.includes("http://127.0.0.1:1420")
) {
  throw new Error("Expected embedded frontend and no development server.");
}
if (Object.values(pins).some((value) => !native.includes(value))) {
  throw new Error("Compiled staging pins are incomplete.");
}
run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
console.log(bundle);
