// Prepare offline qualification inputs. Generation always needs a funded, bounded copy.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { holdoutTasks } from "./efficiency-holdout.mjs";
import {
  describePlan,
  prefixPilotPlans,
} from "./prepare-efficiency-prefix-pilot.mjs";
import { report } from "./efficiency-report.mjs";
import { sha256 } from "./efficiency-run-manifest.mjs";

const routes = [
  { id: "deepseek", model: "deepseek-v4-pro", effort: "high" },
  { id: "openai", model: "gpt-6.1-sol", effort: "medium", cli: "codex" },
  {
    id: "anthropic",
    model: "claude-sonnet-5-5",
    effort: "medium",
    cli: "claude",
  },
];
const modelFacingTasks = (tasks) =>
  tasks.map(({ referenceSolution: _referenceSolution, ...task }) => task);

function cliVersion(program) {
  try {
    return execFileSync(program, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

export function harnessPlans() {
  const prefix = prefixPilotPlans();
  const heldOut = modelFacingTasks(holdoutTasks());
  const plans = {
    "api-prefix-smoke": prefix.smoke,
    "api-prefix-paired": prefix.paired,
  };
  for (const { cli, ...provider } of routes) {
    const version = cli ? { nativeCliVersion: cliVersion(cli) } : {};
    const common = {
      ...prefix.paired,
      ...version,
      providers: [provider],
      tasks: modelFacingTasks(prefix.paired.tasks),
    };
    if (cli) {
      plans[provider.id + "-smoke"] = {
        ...common,
        tasks: common.tasks.slice(0, 1),
        trials: 1,
        cacheConditions: ["resumed-session"],
        variants: ["baseline", "checkpoint-recovery"],
      };
    }
    plans[provider.id + "-development"] = {
      ...common,
      trials: 1,
      variants: ["baseline", "tool-recovery-feedback", "checkpoint-recovery"],
    };
    plans[provider.id + "-holdout"] = {
      ...common,
      heldOut: true,
      tasks: heldOut,
      trials: 1,
      variants: ["baseline", "harness-candidate"],
      candidatePolicies: {
        toolRecoveryFeedback: true,
        checkpointRecovery: true,
        stableApiPrefix: !cli,
      },
    };
  }
  for (const plan of Object.values(prefix)) {
    plan.providers = [routes[0]];
    plan.tasks = modelFacingTasks(plan.tasks);
  }
  return plans;
}

async function prepare(output) {
  const directory = output
    ? resolve(output)
    : await mkdtemp(join(tmpdir(), "gyro-harness-"));
  if (output) await mkdir(directory);
  const plans = harnessPlans();
  for (const [name, spec] of Object.entries(plans)) {
    await writeFile(
      join(directory, name + ".json"),
      JSON.stringify(spec, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  }
  const manifest = {
    generationCalls: 0,
    plans: Object.fromEntries(
      Object.entries(plans).map(([name, spec]) => [name, describePlan(spec)]),
    ),
  };
  await writeFile(
    join(directory, "preparation.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return { directory, ...manifest };
}

async function coordinatedGate(runDirectories) {
  const fingerprint = sha256(JSON.stringify(modelFacingTasks(holdoutTasks())));
  const pairs = await Promise.all(
    runDirectories.map(async (directory) => {
      const [spec, evidence, manifest] = await Promise.all(
        ["spec.json", "efficiency-results.json", "run-manifest.json"].map(
          async (file) =>
            JSON.parse(await readFile(join(directory, file), "utf8")),
        ),
      );
      if (
        manifest.buildCoverage !== "built-from-captured-inputs" ||
        manifest.specSha256 !== sha256(JSON.stringify(spec))
      ) {
        throw Error("Run manifest did not verify the build and spec");
      }
      const result = report(evidence.records, spec);
      if (
        result.holdoutFingerprint !== fingerprint ||
        result.expectedPairs !== 48
      ) {
        throw Error("Run does not match the frozen held-out cohort");
      }
      const group = result.groups.find(
        (entry) => entry.variant === "harness-candidate",
      );
      const route = routes.find(
        ({ id, model, effort }) =>
          id === group?.provider &&
          model === group.model &&
          effort === group.effort,
      );
      if (!route || Boolean(route.cli) !== Boolean(group.nativeCliVersion)) {
        throw Error("Run does not match a planned route, model and effort");
      }
      return {
        group,
        sourceSnapshot: manifest.sourceSnapshot,
        runtime: manifest.runtime,
        policies: spec.candidatePolicies,
      };
    }),
  );
  if (
    new Set(pairs.map(({ group }) => group.provider)).size !== routes.length ||
    new Set(pairs.map(({ sourceSnapshot }) => sourceSnapshot)).size !== 1 ||
    new Set(pairs.map(({ runtime }) => JSON.stringify(runtime))).size !== 1
  ) {
    throw Error(
      "Qualification requires all three routes on the same source and runtime",
    );
  }
  return {
    qualified: pairs.every(({ group }) => group.gate === "holdout-qualified"),
    routes: pairs.map(({ group, policies }) => ({
      provider: group.provider,
      policies,
      gate: group.gate,
      costReduction: group.costReduction,
      quality: group.holdoutQuality,
      medianMs: group.medianMs,
      baselineMedianMs: group.baselineMedianMs,
      p95Slowdown: group.p95Slowdown,
    })),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      result: { type: "string", multiple: true },
    },
  });
  if (values.result) {
    const gate = await coordinatedGate(values.result);
    console.log(JSON.stringify(gate, null, 2));
    if (!gate.qualified) process.exitCode = 1;
  } else {
    const prepared = await prepare(values.output);
    console.log(
      JSON.stringify(
        { directory: prepared.directory, generationCalls: 0 },
        null,
        2,
      ),
    );
  }
}
