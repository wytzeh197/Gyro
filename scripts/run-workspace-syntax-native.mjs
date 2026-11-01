// Build and run an isolated debug Tauri/WebKit harness with embedded assets.
// This does not launch the main app, install a bundle, or use the user's state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin")
  throw Error("This acceptance check requires native macOS WebKit.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts =
  process.env.GYRO_TEST_ARTIFACTS ??
  "/private/tmp/gyro-workspace-syntax-native";
await mkdir(artifacts, { recursive: true });
const run = (program, args, env = process.env, timeout = 180000) =>
  new Promise((resolveExit, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: "inherit", env });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Error(`${program} exceeded its acceptance timeout.`));
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
if (process.env.GYRO_NATIVE_SYNTAX_SKIP_BUILD !== "1") {
  const built = await run("pnpm", [
    "--filter",
    "@gyro-dev/desktop",
    "exec",
    "vite",
    "build",
    "--mode",
    "native-syntax-smoke",
    "--logLevel",
    "warn",
  ]);
  if (built) throw Error(`Native syntax frontend build failed (${built}).`);
  const native = await run(
    "cargo",
    [
      "build",
      "--offline",
      "-p",
      "gyro-desktop",
      "--bin",
      "gyro-workspace-syntax-smoke",
      "--features",
      "native-syntax-smoke",
    ],
    process.env,
    600000,
  );
  if (native)
    throw Error(`Native syntax debug binary build failed (${native}).`);
}
const binary = join(root, "target/debug/gyro-workspace-syntax-smoke");
const reports = [];
for (const blockedWasm of [false, true]) {
  const dataDir = await mkdtemp(join(tmpdir(), "gyro-native-syntax-"));
  try {
    const env = { ...process.env, GYRO_TEST_DATA_DIR: dataDir };
    delete env.GYRO_TEST_PERSIST_UI;
    delete env.GYRO_SYNTAX_SMOKE_BLOCK_WASM;
    if (blockedWasm) env.GYRO_SYNTAX_SMOKE_BLOCK_WASM = "1";
    const exitCode = await run(binary, [], env, 75000);
    const name = blockedWasm ? "blocked-wasm.json" : "syntax.json";
    const raw = await readFile(join(dataDir, name), "utf8");
    await writeFile(join(artifacts, name), raw);
    const report = JSON.parse(raw);
    assert.equal(
      report.passed,
      true,
      `${name}: ${report.error ?? "native probe failed"}`,
    );
    assert.equal(report.blockedWasm, blockedWasm);
    assert.equal(report.nativeBuild, "debug-embedded-tauri");
    assert.equal(
      report.nativeCsp.includes("'wasm-unsafe-eval'"),
      !blockedWasm,
      "native asset protocol receives the selected CSP",
    );
    assert.equal(exitCode, 0, `${name}: native process exits successfully`);
    assert.ok(
      report.href.startsWith("tauri://localhost/"),
      "embedded Tauri origin, without loopback server",
    );
    assert.ok(report.userAgent.includes("AppleWebKit"), "native WebKit engine");
    assert.ok(
      report.checks.length >= (blockedWasm ? 10 : 35),
      "the real acceptance assertions ran",
    );
    reports.push({
      mode: blockedWasm ? "blocked-wasm" : "production-csp",
      checks: report.checks.length,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
console.log(
  `Native Workspace syntax checks passed (${JSON.stringify(reports)}). Debug Tauri executable with App-origin embedded assets; reports: ${artifacts}`,
);
