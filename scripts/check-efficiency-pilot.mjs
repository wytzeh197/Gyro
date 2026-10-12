import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { report } from "./efficiency-report.mjs";
const spec = JSON.parse(
  await readFile("docs/performance/efficiency-pilot.json", "utf8"),
);
assert.equal(spec.tasks.length, 40);
assert.equal(spec.trials, 3);
const categories = new Map();
const root = await mkdtemp(join(tmpdir(), "gyro-pilot-fixtures-"));
try {
  for (const task of spec.tasks) {
    categories.set(task.category, (categories.get(task.category) ?? 0) + 1);
    const canonical = Object.fromEntries(
      Object.entries(task.files).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
    assert.equal(
      task.repositorySnapshot,
      "sha256:" +
        createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
    );
    const workspace = join(root, task.id);
    await mkdir(workspace, { recursive: true });
    for (const [path, text] of Object.entries(task.files)) {
      const target = join(workspace, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, text);
    }
    const verifier = join(root, task.id + ".mjs");
    await writeFile(verifier, task.verifier);
    const verify = () =>
      spawnSync(process.execPath, ["--test", verifier], {
        env: { ...process.env, GYRO_VERIFY_WORKSPACE: workspace },
        timeout: 10000,
        encoding: "utf8",
      });
    assert.notEqual(
      verify().status,
      0,
      `${task.id} baseline must fail independent verification`,
    );
    for (const [path, text] of Object.entries(task.referenceSolution))
      await writeFile(join(workspace, path), text);
    const solved = verify();
    assert.equal(
      solved.status,
      0,
      `${task.id} reference must pass: ${solved.stdout} ${solved.stderr}`,
    );
  }
  assert.equal(categories.size, 5);
  for (const n of categories.values()) assert.equal(n, 8);
  const base = {
    task: "a",
    provider: "api",
    model: "m",
    effort: "medium",
    trial: 1,
    sessionCondition: "fresh-session",
    outcome: "done",
    verified: true,
    elapsedMs: 100,
    tokens: { measured: true },
    estimatedCost: { currency: "USD", micros: 100 },
  };
  let r = report(
    [
      { ...base, variant: "baseline" },
      {
        ...base,
        variant: "combined",
        estimatedCost: { currency: "USD", micros: 70 },
      },
    ],
    1,
  );
  assert.equal(
    r.groups.find((g) => g.variant === "combined").gate,
    "pilot-qualified",
  );
  r = report(
    [
      { ...base, variant: "baseline" },
      { ...base, variant: "combined", verified: false },
    ],
    1,
  );
  assert.equal(
    r.groups.find((g) => g.variant === "combined").gate,
    "correctness-regression",
  );
  r = report(
    [
      { ...base, variant: "baseline" },
      { ...base, variant: "combined", outcome: "budget-stop", verified: false },
    ],
    1,
  );
  assert.equal(
    r.groups.find((g) => g.variant === "combined").gate,
    "incomplete",
  );
  r = report(
    [
      { ...base, variant: "baseline" },
      { ...base, variant: "combined", estimatedCost: null },
    ],
    1,
  );
  assert.equal(
    r.groups.find((g) => g.variant === "combined").gate,
    "unknown-cost",
  );
  r = report(
    [
      { ...base, variant: "baseline" },
      { ...base, variant: "baseline" },
      {
        ...base,
        variant: "combined",
        estimatedCost: { currency: "USD", micros: 70 },
      },
    ],
    1,
  );
  assert.equal(
    r.groups.find((g) => g.variant === "combined").gate,
    "incomplete",
  );
  console.log(
    "40 independent pilot verifiers and report gates passed; no provider calls",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
