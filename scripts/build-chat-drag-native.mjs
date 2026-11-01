// Compile/package an isolated native .app. This script never launches the app
// or synthesizes mouse input; the visible fixture is operated through CUA.
import { spawn } from "node:child_process";
import {
  copyFile,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeDebugExecutable } from "./build-native-debug-executable.mjs";

if (process.platform !== "darwin")
  throw Error("The native drag fixture requires macOS WebKit.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = process.env.GYRO_NATIVE_CHAT_DRAG_ARTIFACTS
  ? resolve(process.env.GYRO_NATIVE_CHAT_DRAG_ARTIFACTS)
  : await mkdtemp(join(tmpdir(), "gyro-chat-drag-native-"));
await mkdir(artifacts, { recursive: true });
const outputDir = await realpath(artifacts);
const temporaryRoot = await realpath(tmpdir());
if (
  outputDir === temporaryRoot ||
  outputDir === "/private/tmp" ||
  (!outputDir.startsWith(`${temporaryRoot}/`) &&
    !outputDir.startsWith("/private/tmp/"))
)
  throw Error(
    "Native fixture artifacts must be inside a disposable temporary directory.",
  );

const frontendDir = join(outputDir, "frontend");
const dataDir = await mkdtemp(join(outputDir, "data-"));
const appPath = join(outputDir, "Gyro chat drag native.app");
const macosDir = join(appPath, "Contents/MacOS");
const resourcesDir = join(appPath, "Contents/Resources");
await mkdir(macosDir, { recursive: true });
await mkdir(resourcesDir, { recursive: true });

const run = (program, args, env = process.env, timeout = 600000) =>
  new Promise((resolveExit, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: "inherit", env });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Error(`${program} exceeded the native fixture build timeout.`));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit(code ?? (signal ? 1 : 0));
    });
  });

const buildEnv = {
  ...process.env,
  GYRO_NATIVE_CHAT_DRAG_FRONTEND_DIR: frontendDir,
  TAURI_CONFIG: JSON.stringify({ build: { frontendDist: frontendDir } }),
};
const frontend = await run(
  "pnpm",
  [
    "--filter",
    "@gyro-dev/desktop",
    "exec",
    "vite",
    "build",
    "--mode",
    "native-chat-drag-smoke",
    "--emptyOutDir",
    "--logLevel",
    "warn",
  ],
  buildEnv,
);
if (frontend) throw Error(`Native drag frontend build failed (${frontend}).`);

const binary = await buildNativeDebugExecutable({
  root,
  bin: "gyro-chat-drag-smoke",
  features: ["native-chat-drag-smoke"],
  env: buildEnv,
});
const bundledBinary = join(macosDir, "gyro-chat-drag-smoke");
await copyFile(binary, bundledBinary);
await chmod(bundledBinary, 0o755);
await writeFile(join(resourcesDir, "fixture-data-dir"), `${dataDir}\n`);
await writeFile(
  join(appPath, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>gyro-chat-drag-smoke</string>
<key>CFBundleIdentifier</key><string>dev.gyro.chat-drag-smoke</string>
<key>CFBundleName</key><string>Gyro chat drag native</string>
<key>CFBundleDisplayName</key><string>Gyro chat drag native</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`,
);
const signed = await run("codesign", [
  "--force",
  "--deep",
  "--sign",
  "-",
  appPath,
]);
if (signed) throw Error(`Native drag fixture signing failed (${signed}).`);

const manifest = {
  appPath,
  reportPath: join(dataDir, "state.json"),
  dataDir,
  frontendDir,
  binary,
  nativeBuild: "debug-embedded-tauri",
  nativeDebugAssertions: true,
};
const manifestPath = join(outputDir, "manifest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Native drag fixture packaged. Open through CUA to test macOS mouse gestures.\n${JSON.stringify({ ...manifest, manifestPath }, null, 2)}`,
);
