import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "gyro-summary-check-"));
const output = join(root, "output");
const save = (path, value) => writeFile(path, JSON.stringify(value));
try {
  await mkdir(join(root, "sessions"));
  await mkdir(join(root, "logs/timings"), { recursive: true });
  const records = [];
  for (const [trial, wallMs, correct] of [
    [1, 100, true],
    [2, 200, false],
  ]) {
    const sessionId = randomUUID(),
      turnId = randomUUID();
    records.push({
      provider: "openai",
      model: "fixture",
      effort: "medium",
      task: "readme",
      resumedRequested: true,
      resumedActual: false,
      retryCount: 0,
      trial,
      wallMs,
      correct,
      responsePresent: true,
      outcome: "completed",
      sessionId,
      turnId,
    });
    const events = [
      {
        turnId,
        payload: {
          kind: "provider-response",
          resumed: true,
          retryCount: trial === 1 ? 2 : 0,
        },
        message: "PRIVATE_OUTPUT_MUST_NOT_EXPORT",
      },
      {
        turnId,
        payload: {
          kind: "provider-status",
          status: "done",
          resumed: false,
          retryCount: 0,
        },
      },
      ...(correct
        ? []
        : [
            {
              turnId,
              payload: {
                kind: "mutation-approval",
                status: "pending",
                proposalId: randomUUID(),
              },
            },
          ]),
    ];
    await writeFile(
      join(root, "sessions", `${sessionId}.jsonl`),
      events.map((e) => JSON.stringify(e)).join("\n"),
    );
    const marks = [
      ["workspace-start", 1],
      ["workspace-ready", 3],
      ["process-start", 4],
      ["process-spawned", 5],
      ["protocol-ready", 10],
      ["prompt-sent", 11],
      ["tool-start", 12, 0],
      ["tool-start", 14, 1],
      ["first-activity", 15],
      ["first-token", 16],
      ["broker-tool-start", 16, 2],
      ["broker-tool-end", 17, 2],
      ["tool-end", 18, 0],
      ["tool-end", 20, 1],
      ["provider-complete", 90],
      ["complete", 99],
    ];
    await save(join(root, "logs/timings", `backend-${trial}.json`), {
      turnId,
      sessionId,
      outcome: "completed",
      providerRequests: {
        requests: 3,
        retries: 1,
        unmeasuredContent: true,
        tokens: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          measured: false,
        },
      },
      points: marks.map(([stage, elapsedMs, toolIndex]) => ({
        stage,
        elapsedMs,
        toolIndex,
        attempt: 1,
      })),
    });
  }
  for (const trial of [1, 2]) {
    const workspace = join(
      root,
      "workspaces",
      `openai-follow-up-fresh-${trial}`,
    );
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "README.md"), "# Original fixture\n");
    const git = (...args) =>
      execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
    git("init", "-q");
    git("add", "README.md");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "baseline",
    );
    await writeFile(
      join(workspace, "README.md"),
      `${trial === 1 ? "# Original fixture" : "# Changed fixture"}\nMascot: heron.\n`,
    );
    const sessionId = randomUUID();
    await writeFile(join(root, "sessions", `${sessionId}.jsonl`), "");
    records.push({
      provider: "openai",
      task: "follow-up",
      resumedRequested: false,
      trial,
      sessionId,
      wallMs: 100,
      correct: false,
      responsePresent: true,
      outcome: "completed",
    });
  }
  await save(join(root, "benchmark-openai.json"), { records });
  await save(join(root, "benchmark-anthropic.json"), {
    records: [
      {
        provider: "anthropic",
        task: "readme",
        resumedRequested: false,
        trial: 1,
        outcome: "failed",
        failureDetail:
          "401 authentication_failed PRIVATE_ERROR_MUST_NOT_EXPORT",
      },
    ],
  });
  await save(join(root, "benchmark-xai.json"), {
    records: [
      {
        provider: "xai",
        task: "readme",
        resumedRequested: false,
        trial: 1,
        outcome: "failed",
        failureDetail: "40 calls: safety limit",
      },
    ],
  });
  for (const provider of ["ollama", "openrouter"]) {
    await save(join(root, `benchmark-${provider}.json`), {
      records: [{ provider, task: "readme", trial: 1, outcome: "unavailable" }],
    });
  }
  await save(join(root, "spec.json"), {
    providers: [{ id: "ollama" }, { id: "openrouter" }],
    trials: 5,
  });
  execFileSync(process.execPath, [
    fileURLToPath(
      new URL("./summarize-provider-benchmark.mjs", import.meta.url),
    ),
    root,
    output,
  ]);
  const text = await readFile(join(output, "measurements.json"), "utf8"),
    result = JSON.parse(text);
  const group = result.groups.find(
    (g) =>
      g.provider === "openai" && g.task === "readme" && g.session === "resumed",
  );
  assert.equal(group.medianMs, 150);
  assert.equal(group.p95Ms, 200);
  assert.equal(group.slowestMs, 200);
  assert.equal(group.correctTiming.medianMs, 100);
  assert.equal(group.incorrect, 1);
  assert.equal(
    group.actualResumes,
    2,
    "response metadata outranks default status fields",
  );
  assert.equal(group.retries, 3);
  assert.equal(result.excludedRateGuardRecords, 1);
  assert.equal(result.expectedSlots, 60);
  await save(join(root, "spec.json"), {
    providers: [{ id: "ollama" }, { id: "openrouter" }],
    trials: 5,
    tasks: ["no-tool"],
  });
  execFileSync(process.execPath, [
    fileURLToPath(
      new URL("./summarize-provider-benchmark.mjs", import.meta.url),
    ),
    root,
    output,
  ]);
  const subset = JSON.parse(await readFile(join(output, "measurements.json"), "utf8"));
  assert.equal(subset.expectedSlots, 20);
  assert.ok(subset.groups.length > 0);
  assert.ok(subset.groups.every((group) => group.task === "no-tool"));
  assert.ok((await readFile(join(output, "results-table.md"), "utf8")).includes("no-tool"));
  assert.ok(result.records.some((r) => r.provider === "ollama"));
  assert.ok(result.records.some((r) => r.provider === "openrouter"));
  const observed = result.records.find((r) => r.provider === "openai").timing;
  assert.equal(observed.firstTokenMs, 16);
  assert.equal(observed.requestCount, 3);
  assert.equal(observed.observedUsage.totalTokens, 120);
  assert.equal(observed.unmeasuredContent, true);
  assert.equal(
    observed.toolCount,
    2,
    "broker hooks do not double-count protocol tools",
  );
  assert.equal(observed.brokerToolCount, 1);
  assert.deepEqual(observed.toolDurationsMs, [6, 6]);
  assert.deepEqual(observed.brokerToolDurationsMs, [1]);
  assert.equal(
    result.records.find((r) => r.provider === "anthropic").outcome,
    "unavailable",
  );
  assert.equal(
    result.records.find((r) => r.provider === "openai").timing.toolBusyMs,
    8,
    "overlapping tools are merged, not summed",
  );
  assert.equal(
    result.records.find((r) => r.provider === "openai" && r.trial === 2)
      .correctnessFailure,
    "pending-workspace-proposal",
  );
  assert.ok(!text.includes("PRIVATE_"));
  const followUps = result.records.filter((r) => r.task === "follow-up");
  assert.equal(followUps[0].correct, true, "prompt punctuation is accepted");
  assert.equal(followUps[0].correctAsInitiallyRecorded, false);
  assert.equal(
    followUps[1].correct,
    false,
    "changes to original content are rejected",
  );
  const originalSpec = {
    providers: [{ id: "ollama", model: "fixture", effort: "" }],
    trials: 1,
    timeoutSeconds: 30,
  };
  const resumeRoot = join(root, "resume");
  await mkdir(resumeRoot);
  const previousPath = join(resumeRoot, "spec.json");
  await save(previousPath, originalSpec);
  const originalBytes = await readFile(previousPath, "utf8");
  const changedSpec = join(root, "changed-spec.json");
  await save(changedSpec, { ...originalSpec, tasks: ["no-tool"] });
  const runner = fileURLToPath(
    new URL("./benchmark-providers.mjs", import.meta.url),
  );
  const mismatched = spawnSync(
    process.execPath,
    [runner, "--spec", changedSpec, "--resume", resumeRoot, "--skip-build"],
    { encoding: "utf8" },
  );
  assert.notEqual(mismatched.status, 0);
  assert.ok(mismatched.stderr.includes("original benchmark spec"));
  assert.equal(
    await readFile(previousPath, "utf8"),
    originalBytes,
    "resume must not overwrite the original cohort evidence",
  );
  await rm(previousPath);
  await symlink(changedSpec, previousPath);
  const linked = spawnSync(
    process.execPath,
    [runner, "--spec", changedSpec, "--resume", resumeRoot, "--skip-build"],
    { encoding: "utf8" },
  );
  assert.notEqual(linked.status, 0);
  assert.ok(linked.stderr.includes("regular file"));
  console.log(
    "Benchmark summary: medians, overlap, resume metadata, pending proposals, exclusions, and content boundaries passed.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
