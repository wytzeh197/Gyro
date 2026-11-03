import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.env.GYRO_VERIFY_WORKSPACE;
const { runWorkspaceSearchRoots: run } = await import(
  pathToFileURL(resolve(workspace, "apps/desktop/src/workspace-search-run.ts"))
);
const tick = () => new Promise(setImmediate);
const deferred = () => Promise.withResolvers();

test(
  "fast roots publish early but final results use workspace order and one global cap",
  { timeout: 2_000 },
  async () => {
    const a = deferred(),
      b = deferred(),
      c = deferred();
    const pending = { a, b, c },
      published = [];
    const running = run(
      ["a", "b", "c"],
      (root) => pending[root].promise,
      (rows) => published.push(rows),
      () => true,
      4,
    );
    try {
      c.resolve(["c1", "c2"]);
      await tick();
      assert.deepEqual(published, [["c1", "c2"]]);
      b.resolve(["b1", "b2"]);
      await tick();
      assert.deepEqual(published.at(-1), ["b1", "b2", "c1", "c2"]);
      a.resolve(["a1", "a2"]);
      await running;
      assert.deepEqual(published.at(-1), ["a1", "a2", "b1", "b2"]);
    } finally {
      a.resolve([]);
      b.resolve([]);
      c.resolve([]);
      await running;
    }
  },
);
test(
  "a root failure waits for successful roots and identifies every failing path",
  { timeout: 2_000 },
  async () => {
    const good = deferred(),
      published = [];
    let finished = false;
    const outcome = run(
      ["bad-a", "good", "bad-b"],
      (root) =>
        root === "good" ? good.promise : Promise.reject(new Error("denied")),
      (rows) => published.push(rows),
      () => true,
      5,
    )
      .then(
        () => null,
        (error) => error,
      )
      .then((value) => {
        finished = true;
        return value;
      });
    try {
      await tick();
      assert.equal(finished, false);
      good.resolve(["kept"]);
      const error = await outcome;
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.message, /bad-a/);
      assert.match(error.message, /bad-b/);
      assert.deepEqual(published.at(-1), ["kept"]);
    } finally {
      good.resolve([]);
      await outcome;
    }
  },
);
test("superseded successful queries cannot publish stale results", async () => {
  const pending = deferred(),
    published = [];
  let current = true;
  const running = run(
    ["root"],
    () => pending.promise,
    (rows) => published.push(rows),
    () => current,
    10,
  );
  current = false;
  pending.resolve(["obsolete"]);
  await running;
  assert.deepEqual(published, []);
});
test("superseded failed queries cannot replace a newer query with an error", async () => {
  const pending = deferred();
  let current = true;
  const running = run(
    ["root"],
    () => pending.promise,
    () => assert.fail("stale publish"),
    () => current,
    10,
  );
  current = false;
  pending.reject(new Error("obsolete failure"));
  await running;
});
test("already obsolete and empty searches start no work", async () => {
  const unexpected = () => assert.fail("unexpected work");
  await run(["root"], unexpected, unexpected, () => false, 10);
  await run([], unexpected, unexpected, () => true, 10);
});
test("zero cap and input arrays are preserved", async () => {
  const roots = ["a", "b"],
    rows = ["x", "y"],
    published = [];
  await run(
    roots,
    async () => rows,
    (value) => published.push(value),
    () => true,
    0,
  );
  assert.ok(published.length > 0);
  assert.ok(published.every((value) => value.length === 0));
  assert.deepEqual(roots, ["a", "b"]);
  assert.deepEqual(rows, ["x", "y"]);
});
test("early evidence is recovered accurately at the final checkpoint", async () => {
  const summary = JSON.parse(
    await readFile(resolve(workspace, "evidence-summary.json"), "utf8"),
  );
  assert.deepEqual(summary, {
    captureId: "gyro-search-recovery-20261031-a",
    workspaceOrder: ["alpha", "beta", "gamma"],
    completionOrder: ["gamma", "beta", "alpha"],
    globalCap: 4,
    anchor: {
      eventId: "capture-a-047",
      path: "beta/src/search-result-047.ts",
      line: 148,
      symbol: "retainedNeedle47",
    },
    recordCount: 96,
  });
});
