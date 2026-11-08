// Explicit, billable integration benchmark. No provider calls without --spec.
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  realpath,
  lstat,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  benchmarkStoreDirectory,
  isolatedBenchmarkLayout,
  readBenchmarkLayout,
} from "./provider-benchmark-layout.mjs";

const { values } = parseArgs({
  options: {
    spec: { type: "string" },
    resume: { type: "string" },
    "skip-build": { type: "boolean", default: false },
  },
});
if (!values.spec) {
  console.log(
    "Usage: node scripts/benchmark-providers.mjs --spec docs/performance/benchmark-spec.json [--resume TEMP_ROOT] [--skip-build]\nUses CLI sign-ins, API preset credentials, or local Ollama for real provider calls that may be billable. Never changes the normal Gyro store.",
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
  spec.timeoutSeconds > 300 ||
  (spec.reviewFixtureEdits !== undefined && typeof spec.reviewFixtureEdits !== "boolean") ||
  (spec.requireFileEditApproval !== undefined && typeof spec.requireFileEditApproval !== "boolean") ||
  (spec.requireFileEditApproval === true && spec.reviewFixtureEdits !== true) ||
  (spec.tasks !== undefined &&
    (!Array.isArray(spec.tasks) ||
      spec.tasks.length < 1 ||
      spec.tasks.length > 4 ||
      new Set(spec.tasks).size !== spec.tasks.length ||
      spec.tasks.some(
        (task) => !["readme", "code", "follow-up", "no-tool"].includes(task),
      )))
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
if (values.resume) {
  const metadata = await lstat(specPath);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("Resume spec must be a regular file");
  const previous = JSON.parse(await readFile(specPath, "utf8"));
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  const normalize = (value) =>
    canonical({
      ...value,
      tasks: value.tasks ?? ["readme", "code", "follow-up"],
      reviewFixtureEdits: value.reviewFixtureEdits ?? false,
      requireFileEditApproval: value.requireFileEditApproval ?? false,
    });
  if (JSON.stringify(normalize(previous)) !== JSON.stringify(normalize(spec))) {
    throw new Error(
      "Resume requires the original benchmark spec; changing cohorts would mix incomparable results",
    );
  }
} else {
  await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
const run = (command, args, env = process.env) =>
  new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd: repo, env, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code, signal) =>
      code === 0 ? ok() : fail(new Error(`${command}: ${signal ?? code}`)),
    );
  });
// Preserve the original layout when resuming old evidence. New runs separate
// the app store from fixture repositories so command confinement can run tests.
const layout = values.resume
  ? await readBenchmarkLayout(root)
  : isolatedBenchmarkLayout;
const dataDirectory = benchmarkStoreDirectory(root, layout);
if (spec.reviewFixtureEdits && !layout) {
  throw new Error("Fixture review requires the isolated data/workspaces layout; start a fresh run");
}
if (layout) {
  if (!values.resume) {
    await writeFile(
      join(root, "layout.json"),
      JSON.stringify(layout, null, 2) + "\n",
      {
        mode: 0o600,
        flag: "wx",
      },
    );
  }
  await mkdir(dataDirectory, { mode: 0o700, recursive: true });
}
if (!values["skip-build"]) await run("cargo", ["build", "-p", "gyro-desktop"]);
console.log(`Benchmark data and checkpoints: ${root}`);
await run(join(repo, "target/debug/gyro-desktop"), [], {
  ...process.env,
  GYRO_TEST_DATA_DIR: dataDirectory,
  // An empty value explicitly selects the legacy layout on a legacy resume.
  GYRO_BENCHMARK_ROOT: layout ? root : "",
  GYRO_TIMING_DIAGNOSTICS: "1",
  GYRO_PERFORMANCE_BENCHMARK: specPath,
});
console.log(
  `Finished. Summarize with: node scripts/summarize-provider-benchmark.mjs ${root} OUTPUT_DIRECTORY`,
);
