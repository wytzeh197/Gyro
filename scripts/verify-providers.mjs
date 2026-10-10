// Readiness for every shipped provider; --live adds bounded real CLI prompts.
// Uses a disposable Gyro store and workspaces, never the user's Gyro config.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { providerCatalog } from "../packages/ui/src/provider-catalog.ts";

const { values } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    output: { type: "string" },
    providers: { type: "string" },
    "ollama-model": { type: "string" },
  },
});
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selected = values.providers?.split(",");
if (
  selected?.some(
    (id) => !providerCatalog.some((provider) => provider.id === id),
  )
)
  throw new Error("Unknown provider in --providers");
const catalog = providerCatalog.filter(
  (provider) => !selected || selected.includes(provider.id),
);
const binary = join(repo, "target/debug/gyro");
const root = await mkdtemp(join(tmpdir(), "gyro-provider-verification-"));
const env = { ...process.env, GYRO_TEST_DATA_DIR: root };
const profiles = {
  openai: "codex",
  anthropic: "claude-code",
  kimi: "kimi-code",
  xai: "grok-build",
  gemini: "gemini-cli",
  cursor: "cursor",
  opencode: "opencode",
  ollama: "ollama",
};
async function run(args, timeout = 150_000, cwd = root) {
  const started = Date.now();
  return new Promise((ok, fail) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        result = { stdout };
      }
      ok({ code, signal, durationMs: Date.now() - started, result, stderr });
    });
  });
}
for (const provider of catalog) {
  const enabled = await run(
    ["config", "enable-provider", provider.id, "--json"],
    15_000,
  );
  if (enabled.code !== 0)
    throw new Error(`Cannot enable ${provider.id} in disposable config`);
}
const configPath = join(root, "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
for (const provider of config.modelProviders) {
  const catalog = providerCatalog.find((item) => item.id === provider.id);
  provider.defaultModelId =
    (provider.id === "ollama"
      ? values["ollama-model"]
      : catalog.defaultModelId) || null;
  provider.modelIds = catalog.models.map((item) => item.id);
}
await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
const health = await run(["setup", "--json"]);
if (!Array.isArray(health.result.checks))
  throw new Error(`Setup did not return checks: ${health.stderr}`);
const report = {
  schema: "gyro.provider-verification.v1",
  checkedAt: new Date().toISOString(),
  temporaryRoot: root,
  live: values.live,
  scope:
    "Shipped providers; readiness is distinct from generation. CLI live probes do not validate desktop rendering or every listed model.",
  providers: [],
};
async function save() {
  await writeFile(
    values.output ? resolve(values.output) : join(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
}
for (const provider of catalog) {
  const check = health.result.checks.find(
    (item) => item.id === `provider:${provider.id}`,
  );
  if (!check) throw new Error(`Setup omitted ${provider.id}`);
  const record = {
    id: provider.id,
    name: provider.displayName,
    executionKind: provider.capabilities.executionKind,
    model:
      (provider.id === "ollama"
        ? values["ollama-model"]
        : provider.defaultModelId) || "",
    readiness: check.status,
    summary:
      provider.id === "anthropic" && check.status === "ready"
        ? "Claude CLI reports a stored login; generation must verify account access."
        : check.message,
    live: { status: "not-run" },
  };
  report.providers.push(record);
  console.log(`${provider.id}: ${check.status} — ${record.summary}`);
  await save();
  if (!values.live || check.status !== "ready") continue;
  const profile = profiles[provider.id];
  if (!profile) {
    record.live = {
      status: "not-supported-by-cli",
      reason: "Use the desktop OpenAI-compatible runner for generation.",
    };
    await save();
    continue;
  }
  if (provider.id === "ollama" && !record.model) {
    record.live = {
      status: "model-required",
      reason: "Pass --ollama-model with an installed model ID.",
    };
    await save();
    continue;
  }
  const workspace = join(root, "workspaces", provider.id);
  await mkdir(workspace, { recursive: true });
  const args = [
    "run",
    "--profile",
    profile,
    "--workspace",
    workspace,
    "--no-open",
    "--approve",
    "--json",
    "--timeout-seconds",
    provider.id === "ollama" ? "120" : "60",
  ];
  if (record.model) args.push("--model", record.model);
  const result = await run(
    [
      ...args,
      "Reply exactly GYRO_OK. Do not use tools, access files, or change anything.",
    ],
    provider.id === "ollama" ? 135_000 : 75_000,
    workspace,
  );
  record.live = {
    status:
      result.code !== 0
        ? "failed"
        : result.result?.run?.response?.trim() === "GYRO_OK"
          ? "passed"
          : "incorrect-response",
    ...result,
  };
  console.log(
    `${provider.id}: live ${record.live.status} (${result.durationMs}ms)`,
  );
  await save();
}
console.log(
  `Evidence: ${values.output ? resolve(values.output) : join(root, "report.json")}`,
);
// A blocked or untested provider must never produce an all-green result.
if (
  report.providers.some(
    (provider) =>
      provider.readiness !== "ready" ||
      (values.live && provider.live.status !== "passed"),
  )
)
  process.exitCode = 1;
