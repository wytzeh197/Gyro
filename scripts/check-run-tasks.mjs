import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireUi = createRequire(new URL("../packages/ui/package.json", import.meta.url));
const requireDesktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { build } = createRequire(requireDesktop.resolve("vite"))("esbuild");

const compiled = await build({
  stdin: {
    contents: `
      export {
        groupedRunTasks,
        matchingRunPackage,
        runToolchainSummary,
        taskRowTitle,
        taskShowsCommandLine,
      } from "./packages/ui/src/workspace-sidebar.tsx";
      export {
        mergeDiscoveredTaskRuns,
        rememberTaskRun,
        sanitizeTaskRunRecords,
      } from "./packages/ui/src/task-run-records.ts";
    `,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom", "lucide-react"],
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(
  requireUi,
  module,
  module.exports,
);
const {
  groupedRunTasks,
  matchingRunPackage,
  mergeDiscoveredTaskRuns,
  rememberTaskRun,
  runToolchainSummary,
  sanitizeTaskRunRecords,
  taskRowTitle,
  taskShowsCommandLine,
} = module.exports;

function task(overrides) {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    command: overrides.command ?? "pnpm",
    args: overrides.args ?? ["run", overrides.id.replace(/^package:/, "")],
    group: overrides.group ?? "test",
    status: overrides.status ?? "idle",
    source: overrides.source ?? "suggested",
    toolchain: overrides.toolchain ?? "node",
    role: overrides.role ?? "primary",
    packagePath: overrides.packagePath,
    lastRunAt: overrides.lastRunAt,
    durationMs: overrides.durationMs,
  };
}

const catalog = [
  task({ id: "package:test", args: ["run", "test"], group: "test" }),
  task({
    id: "package:test:reliability",
    args: ["run", "test:reliability"],
    group: "test",
    role: "variant",
  }),
  task({
    id: "package:release:check",
    args: ["run", "release:check"],
    group: "check",
    role: "variant",
  }),
  task({ id: "package:check", args: ["run", "check"], group: "check" }),
  task({ id: "package:build", args: ["run", "build"], group: "build" }),
  task({
    id: "package:packages/ui:test",
    args: ["--filter", "@gyro/ui", "test"],
    label: "pnpm --filter @gyro/ui test",
    group: "test",
    packagePath: "packages/ui",
  }),
  task({
    id: "package:packages/ui:test:browser",
    args: ["--filter", "@gyro/ui", "test:browser"],
    group: "test",
    role: "variant",
    packagePath: "packages/ui",
  }),
  task({
    id: "cargo:test",
    command: "cargo",
    args: ["test", "--workspace"],
    label: "cargo test --workspace",
    group: "test",
    toolchain: "cargo",
  }),
  task({
    id: "custom:smoke",
    command: "pnpm",
    args: ["run", "smoke"],
    label: "Smoke",
    group: "test",
    source: "custom",
    toolchain: "custom",
  }),
];

const repo = groupedRunTasks(catalog, "");
assert.deepEqual(
  repo.map((group) => group.id),
  ["saved", "test", "build", "check"],
);
const tests = repo.find((group) => group.id === "test");
assert.deepEqual(
  tests.tasks.map((entry) => entry.task.id),
  ["package:test", "cargo:test"],
);
assert.deepEqual(
  tests.tasks[0].variants.map((variant) => variant.id),
  ["package:test:reliability"],
);
const checks = repo.find((group) => group.id === "check");
assert.deepEqual(
  checks.tasks.map((entry) => entry.task.id),
  ["package:check", "package:release:check"],
);

const scoped = groupedRunTasks(catalog, "", "packages/ui");
const scopedTests = scoped.find((group) => group.id === "test");
assert.deepEqual(
  scopedTests.tasks.map((entry) => entry.task.id),
  ["package:test", "package:packages/ui:test", "cargo:test"],
);
assert.deepEqual(scopedTests.tasks[1].variants, []);
assert.equal(
  scoped.find((group) => group.id === "build"),
  undefined,
);
assert.ok(scoped.some((group) => group.id === "saved"));

const filtered = groupedRunTasks(catalog, "reliability");
assert.deepEqual(
  filtered.flatMap((group) => group.tasks.map((entry) => entry.task.id)),
  ["package:test:reliability"],
);

assert.equal(taskRowTitle(catalog[0]), "test");
assert.equal(taskShowsCommandLine(catalog[0]), false);
assert.equal(taskRowTitle(catalog[5]), "test");
assert.equal(taskShowsCommandLine(catalog[5]), true);
assert.equal(
  runToolchainSummary(catalog),
  "pnpm workspace · Cargo workspace",
);
assert.equal(
  matchingRunPackage(
    catalog,
    "/repo/packages/ui/src/workspace-sidebar.tsx",
    "/repo",
  ),
  "packages/ui",
);
assert.equal(
  matchingRunPackage(catalog, "/repo/README.md", "/repo"),
  undefined,
);

const remembered = rememberTaskRun(
  {},
  "/repo",
  "package:test",
  {
    status: "failed",
    lastRunAt: "2026-11-07T12:00:00.000Z",
    commandLine: "pnpm run test",
    durationMs: 1500,
  },
);
const merged = mergeDiscoveredTaskRuns(
  [],
  [task({ id: "package:test", args: ["run", "test"], status: "idle" })],
  remembered["/repo"],
);
assert.equal(merged.tasks[0].status, "failed");
assert.equal(merged.tasks[0].durationMs, 1500);

const changed = mergeDiscoveredTaskRuns(
  [],
  [task({ id: "package:test", args: ["run", "test", "--changed"], status: "idle" })],
  remembered["/repo"],
);
assert.equal(changed.tasks[0].status, "idle");
assert.equal(changed.records["package:test"], undefined);

const otherWorkspace = rememberTaskRun(remembered, "/other", "package:test", {
  status: "done",
  lastRunAt: "2026-11-07T12:05:00.000Z",
  commandLine: "pnpm run test",
});
assert.equal(otherWorkspace["/repo"]["package:test"].status, "failed");
assert.equal(otherWorkspace["/other"]["package:test"].status, "done");

const sanitized = sanitizeTaskRunRecords({
  "/repo": {
    "package:test": {
      status: "running",
      lastRunAt: "2026-11-07T12:00:00.000Z",
      commandLine: "pnpm run test",
    },
    "package:check": {
      status: "done",
      lastRunAt: "2026-11-07T12:01:00.000Z",
      commandLine: "pnpm run check",
      durationMs: 10.2,
    },
  },
});
assert.equal(sanitized["/repo"]["package:test"], undefined);
assert.equal(sanitized["/repo"]["package:check"].durationMs, 10);
