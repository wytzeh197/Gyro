// Explicit, billable integration benchmark. No provider calls without --spec.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    spec: { type: "string" },
    resume: { type: "string" },
    "skip-build": { type: "boolean", default: false },
  },
});
if (!values.spec) {
  console.log(
    "Usage: node scripts/benchmark-providers.mjs --spec docs/performance/benchmark-spec.json [--resume TEMP_ROOT] [--skip-build]\nUses configured CLI sign-ins for real, billable provider calls. Never changes the normal Gyro store.",
  );
  process.exit(0);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(await readFile(resolve(values.spec), "utf8"));
if (
  !Array.isArray(spec.providers) ||
  spec.providers.length < 1 ||
  spec.providers.length > 3 ||
  !Number.isInteger(spec.trials) ||
  spec.trials < 1 ||
  spec.trials > 5 ||
  !Number.isInteger(spec.timeoutSeconds) ||
  spec.timeoutSeconds < 10 ||
  spec.timeoutSeconds > 300
) {
  throw new Error("Invalid bounded benchmark spec");
}
const root = await realpath(
  values.resume ?? (await mkdtemp(join(tmpdir(), "gyro-benchmark-"))),
);
const temp = await realpath(tmpdir());
if (!root.startsWith(temp + "/") && !root.startsWith("/private/tmp/"))
  throw new Error("Use a disposable temporary directory");
const specPath = join(root, "spec.json");
await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n", {
  mode: 0o600,
});
const run = (command, args, env = process.env) =>
  new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd: repo, env, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code, signal) =>
      code === 0 ? ok() : fail(new Error(`${command}: ${signal ?? code}`)),
    );
  });
if (!values["skip-build"]) await run("cargo", ["build", "-p", "gyro-desktop"]);
console.log(`Benchmark data and checkpoints: ${root}`);
await run(join(repo, "target/debug/gyro-desktop"), [], {
  ...process.env,
  GYRO_TEST_DATA_DIR: root,
  GYRO_TIMING_DIAGNOSTICS: "1",
  GYRO_PERFORMANCE_BENCHMARK: specPath,
});
console.log(
  `Finished. Summarize with: node scripts/summarize-provider-benchmark.mjs ${root} OUTPUT_DIRECTORY`,
);
