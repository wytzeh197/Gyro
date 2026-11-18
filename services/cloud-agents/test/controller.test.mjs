import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../src/controller.mjs";

function fixture() {
  const values = new Map(),
    calls = [];
  let active = false,
    probe = { status: "running", cursor: 0, events: [] },
    failSettlement = false;
  const run = {
    id: "run",
    user_id: "owner",
    status: "queued",
    segment: 1,
    deadline_at: new Date(100000).toISOString(),
  };
  const storage = {
    get: async (k) => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
    setAlarm: async (t) => values.set("alarm", t),
    deleteAlarm: async () => values.delete("alarm"),
  };
  const db = {
    async call(action, uid, id, data) {
      calls.push([action, data]);
      if (action === "control") return { enabled: true };
      if (action === "settle" && failSettlement) throw Error("offline");
      if (action === "activate") return { ...run, status: "running" };
      if (action === "resume") return { ...run, segment: 2 };
      return { ...run, status: data.status };
    },
  };
  const runtime = {
    running: () => active,
    async start() {
      active = true;
    },
    async probe() {
      return probe;
    },
    async quiesce() {
      calls.push(["quiesce"]);
    },
    async snapshot() {
      calls.push(["snapshot"]);
      return { id: "snapshot" };
    },
    async destroy() {
      calls.push(["destroy"]);
      active = false;
    },
    async publish() {
      calls.push(["publish"]);
    },
  };
  const env = { GYRO_CLOUD_ENABLED: "1", CLOUD_AGENTS_ENABLED: "1" };
  const controller = new Controller(storage, db, runtime, env, () => 1000);
  return {
    values,
    calls,
    run,
    storage,
    db,
    runtime,
    env,
    controller,
    probe(v) {
      probe = v;
    },
    failSettlement(v) {
      failSettlement = v;
    },
  };
}
async function running(f) {
  await f.controller.initialize("owner", f.run, { data: "cipher", iv: "iv" });
  await f.controller.tick();
}
test("task lifecycle launches once, publishes once, stops compute and erases credentials", async () => {
  const f = fixture();
  await running(f);
  f.probe({
    status: "ready_to_push",
    cursor: 1,
    events: [{ id: 1, text: "done" }],
  });
  await f.controller.tick();
  f.probe({ status: "done", cursor: 1, events: [] });
  await f.controller.tick();
  assert.equal(f.values.get("run").run.status, "done");
  assert.equal(f.runtime.running(), false);
  assert.equal(f.values.get("run").encrypted, undefined);
  assert.equal(f.calls.filter((c) => c[0] === "publish").length, 1);
});
test("pause checkpoints and stops the container, resume creates a fresh capped segment", async () => {
  const f = fixture();
  await running(f);
  await f.controller.command("owner", "pause");
  assert.equal(f.values.get("run").phase, "paused");
  assert.equal(f.runtime.running(), false);
  assert.equal(f.values.get("run").encrypted, undefined);
  await f.controller.resume("owner", { data: "new", iv: "iv" });
  await f.controller.resume("owner", { data: "retry", iv: "iv" });
  assert.equal(f.calls.filter((c) => c[0] === "resume").length, 1);
  await f.controller.tick();
  assert.equal(f.runtime.running(), true);
});
test("an outsider cannot stop, resume or read logs", async () => {
  const f = fixture();
  await running(f);
  await assert.rejects(f.controller.command("other", "stop"));
  await assert.rejects(f.controller.logs("other", 0));
  await assert.rejects(f.controller.resume("other", {}));
  assert.equal(f.runtime.running(), true);
});
test("kill switch and unavailable control stop active compute without snapshotting", async () => {
  for (const mode of ["flag", "control", "offline"]) {
    const f = fixture();
    await running(f);
    if (mode === "flag") f.env.CLOUD_AGENTS_ENABLED = "0";
    else
      f.db.call = async (action, uid, id, data) => {
        if (action === "control") {
          if (mode === "offline") throw Error();
          return { enabled: false };
        }
        return { ...f.run, status: data.status };
      };
    await f.controller.tick();
    assert.equal(f.runtime.running(), false);
    assert.equal(f.values.get("run").run.status, "blocked");
  }
});
test("cap and idle states enforce different resume behavior", async () => {
  const f = fixture();
  await running(f);
  f.probe({ status: "waiting", cursor: 0, events: [] });
  await f.controller.tick();
  assert.equal(f.values.get("run").phase, "paused");
  const g = fixture();
  g.run.deadline_at = new Date(100).toISOString();
  await running(g);
  await g.controller.tick();
  assert.equal(g.values.get("run").run.status, "blocked");
  await assert.rejects(g.controller.resume("owner", {}));
});
test("database outage after destruction retries settlement without restarting or charging twice", async () => {
  const f = fixture();
  await running(f);
  f.failSettlement(true);
  await assert.rejects(f.controller.command("owner", "stop"));
  assert.equal(f.runtime.running(), false);
  assert.equal(f.values.get("run").encrypted, undefined);
  f.failSettlement(false);
  const restarted = new Controller(
    f.storage,
    f.db,
    f.runtime,
    f.env,
    () => 9000,
  );
  await restarted.tick();
  assert.equal(f.values.get("run").run.status, "cancelled");
  assert.equal(f.calls.filter((c) => c[0] === "destroy").length, 1);
  assert.deepEqual(
    f.calls.filter((c) => c[0] === "settle").map((c) => c[1].ended_at),
    [new Date(1000).toISOString(), new Date(1000).toISOString()],
  );
});
test("interrupted start never replays the coding task", async () => {
  const f = fixture();
  await running(f);
  const state = f.values.get("run");
  state.phase = "starting";
  f.values.set("run", state);
  f.runtime.start = async () => assert.fail("must not replay");
  await f.controller.tick();
  assert.equal(f.values.get("run").run.status, "failed");
});
test("orphan reservation is released without needing credentials or starting compute", async () => {
  const f = fixture();
  f.runtime.start = async () => assert.fail("must not start");
  await f.controller.reconcile(f.run);
  assert.equal(f.values.get("run").run.status, "failed");
  assert.equal(
    f.calls.find((c) => c[0] === "settle")[1].reason,
    "initialization_interrupted",
  );
});
test("log retention stays within the Durable Object per-value size limit", async () => {
  const f = fixture();
  await running(f);
  f.probe({
    status: "running",
    cursor: 512,
    events: Array.from({ length: 512 }, (_, i) => ({
      id: i + 1,
      text: "界".repeat(4096),
    })),
  });
  await f.controller.tick();
  assert.ok(Buffer.byteLength(JSON.stringify(f.values.get("logs"))) <= 96000);
  assert.equal((await f.controller.logs("owner", 0)).truncated, true);
});
