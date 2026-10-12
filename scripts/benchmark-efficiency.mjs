// Explicit generation entry; never starts a paid run without a bounded spec.
import { readFile, mkdtemp, writeFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    spec: { type: "string" },
    "skip-build": { type: "boolean", default: false },
  },
});
if (!values.spec) {
  console.log(
    "Usage: node scripts/benchmark-efficiency.mjs --spec BOUNDED_SPEC_JSON [--skip-build]\nCopy docs/performance/efficiency-pilot.json, select providers, and set finite executionBudget. This runs real provider generations.",
  );
  process.exit(0);
}
const spec = JSON.parse(await readFile(values.spec, "utf8"));
if (
  spec.schema !== "gyro.efficiency-benchmark.v2" ||
  !spec.providers?.length ||
  !Number.isSafeInteger(spec.executionBudget?.maxCalls) ||
  spec.executionBudget.maxCalls <= 0 ||
  !Number.isSafeInteger(spec.executionBudget?.maxObservedTokens) ||
  spec.executionBudget.maxObservedTokens <= 0
)
  throw Error(
    "Provide selected providers and explicit finite execution limits",
  );
const root = await realpath(
  await mkdtemp(join(tmpdir(), "gyro-efficiency-benchmark-")),
);
const specPath = join(root, "spec.json");
await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n", {
  mode: 0o600,
});
const run = (command, args, env = process.env) =>
  new Promise((ok, fail) => {
    const child = spawn(command, args, {
      cwd: resolve("."),
      env,
      stdio: "inherit",
    });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? ok() : fail(Error(`${command} exited ${code}`)),
    );
  });
if (!values["skip-build"])
  await run("cargo", [
    "build",
    "-p",
    "gyro-desktop",
    "--bin",
    "gyro-desktop",
    "--offline",
  ]);
console.log(`Pilot evidence: ${root}`);
await run(resolve("target/debug/gyro-desktop"), [], {
  ...process.env,
  GYRO_TEST_DATA_DIR: root,
  GYRO_TIMING_DIAGNOSTICS: "1",
  GYRO_PERFORMANCE_BENCHMARK: specPath,
});
await run(process.execPath, [
  "scripts/efficiency-report.mjs",
  join(root, "efficiency-results.json"),
  join(root, "report"),
]);
