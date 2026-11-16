// Prepare reviewable, non-executable pilot templates. Never builds or calls a model.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { spec as frozenSpec } from "./efficiency-repo-pilot.mjs";
import { sha256 } from "./efficiency-run-manifest.mjs";

export function prefixPilotPlans() {
  const template = (tasks, trials, conditions) => ({
    ...structuredClone(frozenSpec),
    providers: [],
    prices: [],
    tasks: structuredClone(tasks),
    trials,
    variants: ["baseline", "stable-api-prefix"],
    cacheConditions: conditions,
    executionBudget: {
      maxObservedTokens: 0,
      maxCalls: 0,
      maxCostMicros: null,
      currency: "USD",
      maxTokensPerTurn: 20_000,
    },
  });
  const smokeTask = frozenSpec.tasks.find(
    (task) => task.id === "gyro-retry-terminal-guards",
  );
  if (!smokeTask) throw Error("Frozen retry task is missing");
  return {
    smoke: template([smokeTask], 1, ["fresh-session"]),
    paired: template(frozenSpec.tasks, 3, ["fresh-session", "resumed-session"]),
  };
}

export function describePlan(spec) {
  const multiplier = spec.variants.length * spec.trials;
  const turns = spec.tasks.reduce((sum, task) => sum + task.turns.length, 0);
  return {
    variants: spec.variants,
    trials: spec.trials,
    sessionConditions: spec.cacheConditions,
    tasks: spec.tasks.map((task) => ({
      id: task.id,
      snapshot: task.repositorySnapshot,
    })),
    taskRunsPerProvider:
      spec.tasks.length * spec.cacheConditions.length * multiplier,
    userPromptsPerProvider:
      spec.cacheConditions.reduce(
        (sum, condition) =>
          sum +
          turns +
          (condition === "resumed-session" ? spec.tasks.length : 0),
        0,
      ) * multiplier,
    specSha256: sha256(JSON.stringify(spec)),
  };
}

export async function prepare(output) {
  const directory = output
    ? resolve(output)
    : await mkdtemp(join(tmpdir(), "gyro-prefix-pilot-"));
  if (output) await mkdir(directory); // Refuse an existing directory instead of overwriting a spec.
  const plans = prefixPilotPlans();
  const manifest = {
    schema: "gyro.efficiency-prefix-preparation.v1",
    status: "awaiting-provider-and-budget",
    generationCalls: 0,
    plans: Object.fromEntries(
      Object.entries(plans).map(([name, spec]) => [name, describePlan(spec)]),
    ),
    requirements: [
      "Select one supported owned API provider/model and explicit reasoning effort; stable-api-prefix does not apply to native CLI, Ollama, or JSON compatibility mode.",
      "Supply verified immutable prices and finite call/token/currency limits for each run.",
      "Run the smoke pair first to check integration and receipts. It cannot qualify a policy or prove the retention path was exercised.",
      "Task/prompt counts exclude tool-loop generations and retries; they are not spending limits.",
      "Fresh/resumed conditions do not control provider cache state. Keep model, effort, permissions and prices identical across variants.",
      "Observed spending limits may overshoot in flight. Use a provider-side cap if a hard currency ceiling is required.",
      "No live run or default promotion occurs during preparation.",
    ],
  };
  for (const [name, spec] of Object.entries(plans)) {
    await writeFile(
      join(directory, `${name}.json`),
      JSON.stringify(spec, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  }
  await writeFile(
    join(directory, "preparation.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return { directory, manifest };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({ options: { output: { type: "string" } } });
  const { directory, manifest } = await prepare(values.output);
  console.log(JSON.stringify({ directory, ...manifest }, null, 2));
}
